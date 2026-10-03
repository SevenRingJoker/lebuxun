// 统一 AI 调度 IPC：把供应商/模型清单、路由聊天、上下文工程暴露给渲染进程。
// 渲染端不再直接调用 ollama:*，而是走本层，从而获得自动路由与回退能力。
import { ipcMain, BrowserWindow, app } from 'electron'
import { relative, sep, join } from 'node:path'
import {
  getAllProviders,
  getEnabledProviders,
  getCachedModels,
  setProviderEnabled,
  refreshModels,
  getProvider,
  isBuiltinProvider,
  getCustomProviders,
  addCustomProvider,
  removeCustomProvider
} from '../ai/providerRegistry'
import { getKeyMasked, setKey, hasKey, isEncryptionAvailable } from '../ai/keyStore'
import { getUsageStats, resetUsageStats } from '../ai/usageStats'
import { scheduleChatStream, scheduleChatWithTools, scheduleTaskResume } from '../ai/scheduler'
import type { ToolsEvents } from '../ai/scheduler'
import { listTraces, loadTrace } from '../ai/agentTrace'
import {
  loadTaskSnapshot,
  listTaskSnapshots,
  deleteTaskSnapshot
} from '../ai/taskStore'
import { classifyRecoverable, type ParsedTaskSnapshot } from '../ai/taskSnapshot'
import { TaskControlGate } from '../ai/taskControl'
import {
  createCheckpoint,
  restoreCheckpoint,
  resolveHead,
  cleanupTaskCreatedFiles
} from './git'
import { ensureIndex, ensureIndexWorker, getCachedIndex, isScanning } from '../ai/indexer'
import { parseMentions, buildContext, searchIndex } from '../ai/retrieval'
import { hybridSearch } from '../ai/embeddings'
import { loadNotes, saveNotes } from '../ai/agentNotes'
import type { AgentNote } from '../ai/agentNotes'
import { collectTools } from './mcpToolBridge'
import {
  listSessions,
  loadSession,
  saveSession,
  deleteSession,
  toMarkdown,
  type StoredMessage
} from '../ai/chatHistory'
// 2.3 图片附件：保存/读取 IPC 与删会话时联动清理
import { saveAttachment, readAttachment, deleteAttachments } from '../ai/attachments'
import {
  getPermissionMode,
  setPermissionMode,
  PermissionGate,
  type PermissionMode,
  type PermissionRequest,
  type UserPermissionResponse
} from '../ai/permissions'
// s50 直接编排：看板卡片 → runSubagents + 全局写锁
import { runSubagents } from '../ai/subagents'
import { getGlobalFileLockTable } from '../ai/fileLock'
import type { ModelEntry, SchedulerChatParams } from '../ai/types'
// ㊝ 放弃任务时丢弃未决暂存（变更从未落盘，与任务同生命周期）
import { clearStaging } from './staging'

// 待决审批请求表：id → 释放函数。前端应答 ai:permissionResponse 后放行对应工具
const pendingPermissions = new Map<string, (r: UserPermissionResponse) => void>()
let permissionSeq = 0
/**
 * ㊜ 1b 当前运行任务句柄：同时持有 abort（放弃）与 gate（软暂停/继续）。
 * 取代 1a 裸 currentChatAbort：暂停门需要 Promise 级协调，单个任务同时只允许一个。
 */
let currentRun: RunHandle | null = null
/** 审批等待超时：5 分钟无应答自动拒绝，避免 Agent 无限挂起 */
const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000

/**
 * 运行任务句柄：
 * - finished/markFinished：让放弃通道能等待循环真正退出后再回滚/删快照；
 * - gate 与 abortController 成对使用（放弃时 gate.abort 释放挂起，abort 驱动收尾）。
 */
interface RunHandle {
  workspace: string | null
  abortController: AbortController
  gate: TaskControlGate
  finished: Promise<void>
  markFinished: () => void
}

/** 创建运行句柄：markFinished 在 Promise 构造器内同步赋值，保证 finally 可直接调用 */
function createRunHandle(workspace: string | null): RunHandle {
  let markFinished: () => void = () => {}
  const finished = new Promise<void>((resolve) => {
    markFinished = resolve
  })
  return {
    workspace,
    abortController: new AbortController(),
    gate: new TaskControlGate(),
    finished,
    markFinished
  }
}

/** 2.2 纯流式聊天（无 RunHandle）的中止器：stopChat 时真中断底层 HTTP 请求 */
let chatStreamAbort: AbortController | null = null
/** 2.2 内联 AI（Tab 补全 / Cmd+K）流的中止器：stopInline 时真中断 */
let inlineStreamAbort: AbortController | null = null

/**
 * 组装任务过程事件桥：chatWithTools 与 resumeTask 共用同一套事件协议，
 * 抽成工厂避免两处漂移。权限审批挂起逻辑也在此统一。
 */
function makeTaskEvents(
  win: BrowserWindow | null,
  send: (channel: string, payload?: unknown) => void
): ToolsEvents {
  return {
    onToolCall: (name, args) => send('ai:toolCall', { name, args }),
    onToolResult: (name, result) => send('ai:toolResult', { name, result }),
    onFallback: (from, to, reason) => send('ai:chatFallback', { from, to, reason }),
    onModelCall: (model, phase) => send('ai:modelCall', { model, phase }),
    onTodo: (todos) => send('ai:todoUpdate', todos),
    onSubagent: (current, total, phase, detail) =>
      send('ai:subagentUpdate', { current, total, phase, detail }),
    onPermissionRequest: (req: PermissionRequest) =>
      new Promise<UserPermissionResponse>((resolveResponse) => {
        if (!win || win.isDestroyed()) {
          resolveResponse({ decision: 'deny', reason: '窗口已关闭' })
          return
        }
        const id = `perm-${++permissionSeq}`
        const timer = setTimeout(() => {
          if (pendingPermissions.delete(id)) {
            resolveResponse({ decision: 'deny', reason: '审批超时（5 分钟未响应），已自动拒绝' })
          }
        }, PERMISSION_TIMEOUT_MS)
        pendingPermissions.set(id, (r) => {
          clearTimeout(timer)
          resolveResponse(r)
        })
        send('ai:permissionRequest', { id, ...req })
      }),
    onPlanDrift: (report) => send('ai:planDrift', report),
    // ㊜ 1b 运行门事件：started/pausing/paused/running，前端维护 live 任务态
    onTaskControl: (payload) => send('ai:taskControl', payload),
    // ㊝ bash 接受门：仅推弹层；应答走 staging:bashAcceptResponse，
    // 由 resolveBashAccept 落盘并释放 scheduler 正在 await 的 promise
    onBashAcceptRequest: (payload) => send('ai:bashAcceptRequest', payload),
    onStagingChanged: () => send('ai:stagingChanged'),
    // s48 时间线广播桥：原样转发调度层录制的步骤（渲染端时间线面板数据源）
    onTimeline: (payload) => send('ai:timelineUpdate', payload)
  }
}

/** 构造窗口事件发送器（窗口销毁时空转） */
function makeSend(win: BrowserWindow | null): (channel: string, payload?: unknown) => void {
  return (channel, payload) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

export function registerAiSchedulingHandlers(): void {
  // 工具权限模式查询/设置（只读/询问/自动，持久化到 userData/ai-permissions.json）
  ipcMain.handle('ai:getPermissionMode', async (): Promise<PermissionMode> => getPermissionMode())
  ipcMain.handle('ai:setPermissionMode', async (_e, mode: PermissionMode) => {
    setPermissionMode(mode)
    return true
  })

  // 前端对权限审批请求的应答
  ipcMain.handle(
    'ai:permissionResponse',
    async (_e, id: string, response: UserPermissionResponse) => {
      const resolve = pendingPermissions.get(id)
      if (resolve) {
        pendingPermissions.delete(id)
        resolve(response)
      }
      return true
    }
  )
  // 列出全部供应商及其健康状态
  ipcMain.handle('ai:listProviders', async () => {
    const providers = getAllProviders()
    const result = []
    for (const p of providers) {
      const h = await p.health()
      result.push({
        id: p.id,
        name: p.displayName,
        enabled: getEnabledProviders().some((ep) => ep.id === p.id),
        ok: h.ok,
        version: h.version,
        error: h.error
      })
    }
    return result
  })

  // 列出全部可用模型（含能力标签与可用性）
  ipcMain.handle('ai:listModels', async (): Promise<ModelEntry[]> => {
    let models = getCachedModels()
    if (models.length === 0) models = await refreshModels()
    return models
  })

  // 手动刷新模型清单
  ipcMain.handle('ai:refreshModels', async (): Promise<ModelEntry[]> => {
    return refreshModels()
  })

  // 启用/禁用供应商（切换后立即刷新模型缓存，前端下拉随即反映新状态）
  ipcMain.handle('ai:setProviderEnabled', async (_e, providerId: string, enabled: boolean) => {
    setProviderEnabled(providerId, enabled)
    await refreshModels()
    return true
  })

  // ====================== 模型管理（设置页） ======================

  /** 预设供应商的固定 baseUrl（展示用；自定义端点的 baseUrl 从配置读取） */
  const PRESET_BASE_URL: Record<string, string> = {
    openai: 'https://api.openai.com/v1',
    deepseek: 'https://api.deepseek.com/v1',
    llamacpp: 'http://127.0.0.1:8080/v1',
    anthropic: 'https://api.anthropic.com'
  }
  /** 必须配置 API Key 才能用的供应商（ollama/llamacpp/自定义本地端点可免 Key） */
  const KEY_REQUIRED = new Set(['openai', 'deepseek', 'anthropic'])

  // 供应商设置视图：启停状态 + baseUrl + Key 掩码（Key 明文绝不回传渲染进程）
  ipcMain.handle('ai:getProviderSettings', async () => {
    const enabledIds = new Set(getEnabledProviders().map((p) => p.id))
    const customMap = new Map(getCustomProviders().map((c) => [c.id, c]))
    return getAllProviders().map((p) => ({
      id: p.id,
      name: p.displayName,
      enabled: enabledIds.has(p.id),
      builtin: isBuiltinProvider(p.id),
      baseUrl: customMap.get(p.id)?.baseUrl ?? PRESET_BASE_URL[p.id] ?? null,
      needsKey: KEY_REQUIRED.has(p.id),
      hasKey: hasKey(p.id),
      keyMasked: getKeyMasked(p.id),
      encryptionAvailable: isEncryptionAvailable()
    }))
  })

  // 保存供应商 Key（空串 = 清除）；保存后自动刷新模型清单让新模型出现在下拉
  ipcMain.handle('ai:setProviderKey', async (_e, providerId: string, key: string) => {
    if (!getProvider(providerId)) return { ok: false, error: '未知供应商' }
    setKey(providerId, key)
    await refreshModels()
    return { ok: true }
  })

  // 新增自定义 OpenAI 兼容端点
  ipcMain.handle('ai:addCustomProvider', async (_e, def: { name: string; baseUrl: string }) => {
    if (!def?.baseUrl?.trim()) return { ok: false, error: 'baseUrl 不能为空' }
    const entry = addCustomProvider(def)
    await refreshModels()
    return { ok: true, provider: entry }
  })

  // 删除自定义端点（内置预设拒绝）
  ipcMain.handle('ai:removeCustomProvider', async (_e, providerId: string) => {
    const ok = removeCustomProvider(providerId)
    return ok ? { ok: true } : { ok: false, error: '内置供应商不可删除或不存在' }
  })

  // 连通性测试：直接调 provider.health()，返回错误文案供 UI 展示
  ipcMain.handle('ai:testProvider', async (_e, providerId: string) => {
    const provider = getProvider(providerId)
    if (!provider) return { ok: false, error: '未知供应商' }
    return provider.health()
  })

  // 用量统计查询/清零
  ipcMain.handle('ai:getUsageStats', async () => getUsageStats())
  ipcMain.handle('ai:resetUsageStats', async () => {
    resetUsageStats()
    return true
  })

  // 流式聊天（带自动路由 + 回退）
  ipcMain.handle(
    'ai:chatStream',
    async (event, params: SchedulerChatParams) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const send = (channel: string, payload?: any) => {
        if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
      }
      // 2.2 每次启动新生成 abort controller，stopChat 时真中断底层 HTTP 请求
      chatStreamAbort = new AbortController()
      try {
        await scheduleChatStream(
          params,
          {
            onChunk: (delta) => send('ai:chatChunk', delta),
            onDone: (info) => send('ai:chatDone', info),
            onError: (err) => send('ai:chatError', err),
            onFallback: (from, to, reason) =>
              send('ai:chatFallback', { from, to, reason })
          },
          chatStreamAbort.signal
        )
      } finally {
        chatStreamAbort = null
      }
      return { ok: true }
    }
  )

  // 带工具的非流式聊天（带路由 + 回退）：过程事件推送给渲染进程
  // 每次运行一个 RunHandle：gate 支撑软暂停，abort 支撑放弃，二者经 finished 串联
  ipcMain.handle('ai:chatWithTools', async (event, params: SchedulerChatParams) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const run = createRunHandle(params.workspace ?? null)
    currentRun = run
    try {
      // ㊜ 任务前检查点：git 仓库时先固化当前状态（非仓库/无变更静默跳过），
      // hash 记入任务快照，放弃或失败时可一键回滚
      let preTaskCheckpoint: { hash: string; label: string } | null = null
      if (params.workspace) {
        const lastUser =
          [...params.messages].reverse().find((m) => m.role === 'user')?.content ?? ''
        const label = `任务前：${lastUser.slice(0, 40)}`
        try {
          const cp = await createCheckpoint(params.workspace, label)
          if (cp.ok && cp.data?.created && cp.data.hash) {
            preTaskCheckpoint = { hash: cp.data.hash, label }
          } else {
            // 工作区干净 → 没有变更可提交，但 HEAD 本身就是合法回滚目标：
            // 任务接下来会新建文件，放弃时 reset 到 HEAD + 清理新建文件即可完全还原
            const head = await resolveHead(params.workspace)
            if (head) preTaskCheckpoint = { hash: head, label }
          }
        } catch {
          // git 不可用/非仓库：不阻断任务
        }
      }
      const taskControl = params.workspace
        ? { workspace: params.workspace, sessionId: null, preTaskCheckpoint }
        : undefined
      return await scheduleChatWithTools(
        params,
        makeTaskEvents(win, makeSend(win)),
        run.abortController.signal,
        join(app.getPath('userData'), 'traces'),
        taskControl,
        run.gate
      )
    } finally {
      // 先标记完成（放弃通道在 await finished），再只清自己这个句柄
      run.markFinished()
      if (currentRun === run) currentRun = null
    }
  })

  // 停止当前 AI 任务：触发主循环逐轮退出 + 子代理级联中止 + provider 尽力止损。
  // 无 RunHandle 时（纯流式 chatStream）仍需 abort provider 收尾。
  ipcMain.handle('ai:stopChat', async () => {
    const run = currentRun
    if (!run) {
      chatStreamAbort?.abort()
      for (const p of getAllProviders()) p.abort?.()
      return { ok: true, stopped: false }
    }
    run.abortController.abort()
    // gate 若在挂起也要释放，否则循环收不到 abort 后的检查点
    run.gate.abort()
    for (const p of getAllProviders()) p.abort?.()
    return { ok: true, stopped: true }
  })

  // ---------- ㊜ 1b 运行门：暂停 / 继续 / 放弃 ----------

  // 请求软暂停：仅登记相位，不掐断调用；前端按返回相位展示「暂停中/已暂停」
  ipcMain.handle('ai:pauseTask', async () => {
    const run = currentRun
    if (!run) return { ok: false, phase: 'idle' as const }
    run.gate.requestPause()
    return { ok: true, phase: run.gate.getPhase() }
  })

  // 进程内继续：释放挂起（也可取消尚未到安全点的暂停请求）
  ipcMain.handle('ai:resumePausedTask', async () => {
    const run = currentRun
    if (!run) return { ok: false, phase: 'idle' as const }
    run.gate.resume()
    return { ok: true, phase: run.gate.getPhase() }
  })

  /**
   * 放弃任务（运行中/暂停中）：
   * 1. abort + gate.abort 驱动循环退出，provider 尽力止损；
   * 2. await finished 等循环真正落 aborted 快照；
   * 3. rollback 先回滚任务前检查点（失败则保留快照并报错），再删快照；
   * currentRun 缺失（重启后场景）时退化为对盘上快照的放弃。
   */
  ipcMain.handle(
    'ai:abortRunningTask',
    async (_e, workspace: string | null, taskId: string, rollback: boolean) => {
      const run = currentRun
      if (run) {
        run.abortController.abort()
        run.gate.abort()
        for (const p of getAllProviders()) p.abort?.()
        await run.finished
      }
      return await applyAbandon(workspace, taskId, rollback)
    }
  )

  /**
   * s49 单卡片回滚：中止当前运行 → 恢复任务前检查点并清理任务新建产物，
   * 但保留快照（卡片退回待办，后续可重新分派；区别于放弃的删快照）。
   */
  ipcMain.handle(
    'ai:rollbackCard',
    async (_e, workspace: string, taskId: string) => {
      if (!workspace) return { ok: false, error: '无工作区' }
      const run = currentRun
      if (run && run.workspace === workspace) {
        run.abortController.abort()
        run.gate.abort()
        for (const p of getAllProviders()) p.abort?.()
        await run.finished
      }
      const snapshot = loadTaskSnapshot(workspace, taskId)
      if (!snapshot) return { ok: false, error: '任务快照不存在或已损坏' }
      const hash = snapshot.preTaskCheckpoint?.hash
      if (!hash) return { ok: false, error: '该任务没有可回滚的任务前检查点' }
      const r = await restoreCheckpoint(workspace, hash)
      if (!r.ok) return { ok: false, error: r.error || '回滚失败' }
      await cleanupTaskCreatedFiles(workspace, [...(snapshot.ctx.createdFiles as Set<string>)])
      await clearStaging(workspace).catch(() => undefined)
      return { ok: true }
    }
  )

  /**
   * 放弃落盘收尾：可选回滚 + 删快照。
   * 抽成一处，运行中放弃与重启后放弃（abandonTask）共用，规则不漂移。
   */
  async function applyAbandon(
    workspace: string | null,
    taskId: string,
    rollback: boolean
  ): Promise<{ ok: boolean; error?: string }> {
    if (!workspace) return { ok: false, error: '无工作区' }
    const snapshot = loadTaskSnapshot(workspace, taskId)
    if (!snapshot) return { ok: false, error: '任务快照不存在或已损坏' }
    if (rollback) {
      const hash = snapshot.preTaskCheckpoint?.hash
      if (!hash) return { ok: false, error: '该任务没有可回滚的任务前检查点' }
      const r = await restoreCheckpoint(workspace, hash)
      if (!r.ok) return { ok: false, error: r.error || '回滚失败' }
      // reset --hard 不删未跟踪文件：按快照登记名单清理任务新建产物（含空目录）
      await cleanupTaskCreatedFiles(
        workspace,
        [...(snapshot.ctx.createdFiles as Set<string>)]
      )
    }
    // ㊝ 未接受的暂存变更从未落盘，放弃即清空（失败不阻断放弃主流程）
    await clearStaging(workspace).catch(() => undefined)
    deleteTaskSnapshot(workspace, taskId)
    return { ok: true }
  }

  // ---------- ㊜ 断点续跑：恢复列表 / 继续 / 放弃 ----------

  /** 快照 → 恢复条摘要（明细不落 UI，只取展示字段） */
  function toRecoverableSummary(s: ParsedTaskSnapshot) {
    return {
      taskId: s.taskId,
      // classify 后只剩 interrupted（running 残留）与 paused（软暂停）两态
      status: s.status as 'interrupted' | 'paused',
      userRequest: s.userRequest,
      startRound: s.startRound,
      createdCount: s.ctx.createdFiles.size,
      updatedAt: s.updatedAt,
      modelId: s.modelId,
      preTaskCheckpoint: s.preTaskCheckpoint
    }
  }

  // 列出可恢复任务：running 残留按崩溃中断处理、paused 保留；completed/aborted 不返回
  ipcMain.handle('ai:listRecoverableTasks', async (_e, workspace: string) => {
    if (!workspace) return []
    return classifyRecoverable(listTaskSnapshots(workspace)).map(toRecoverableSummary)
  })

  // 继续任务：装载快照后沿用原模型续跑，过程事件与新任务走同一套通道
  ipcMain.handle('ai:resumeTask', async (event, workspace: string, taskId: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const snapshot = loadTaskSnapshot(workspace, taskId)
    if (!snapshot) return { ok: false, error: '任务快照不存在或已损坏' }
    if (snapshot.workspace !== workspace) return { ok: false, error: '任务与当前工作区不匹配' }
    const run = createRunHandle(workspace)
    currentRun = run
    try {
      return await scheduleTaskResume(
        snapshot,
        makeTaskEvents(win, makeSend(win)),
        run.abortController.signal,
        join(app.getPath('userData'), 'traces'),
        run.gate
      )
    } finally {
      run.markFinished()
      if (currentRun === run) currentRun = null
    }
  })

  // s48 「从此步重跑」：载入任务快照，覆盖恢复轮次为失败步骤所属轮后续跑。
  // 与 resumeTask 同款 RunHandle（可暂停/放弃）；结果仍走任务事件通道。
  ipcMain.handle(
    'ai:rerunFromStep',
    async (event, workspace: string, taskId: string, round: number) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const snapshot = loadTaskSnapshot(workspace, taskId)
      if (!snapshot) return { ok: false, error: '任务快照不存在或已损坏' }
      if (snapshot.workspace !== workspace) return { ok: false, error: '任务与当前工作区不匹配' }
      const run = createRunHandle(workspace)
      currentRun = run
      try {
        return await scheduleTaskResume(
          snapshot,
          makeTaskEvents(win, makeSend(win)),
          run.abortController.signal,
          join(app.getPath('userData'), 'traces'),
          run.gate,
          round
        )
      } finally {
        run.markFinished()
        if (currentRun === run) currentRun = null
      }
    }
  )

  // s50 编排器按看板卡片分派：卡片（sid/title/role）→ 角色 Agent 并行执行，
  // 写前取全局锁；结束后汇总 Agent 裁决/合并。直接由看板「派发」动作触发。
  ipcMain.handle(
    'ai:dispatchFromCards',
    async (
      event,
      workspace: string,
      cards: Array<{ sid: string; title: string; role?: string }>
    ) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!workspace) return { ok: false, error: '无工作区' }
      if (!Array.isArray(cards) || cards.length === 0) return { ok: false, error: '没有可派发的卡片' }
      // 模型解析：缓存可用清单 → 刷新 → 取首个可用
      let models = getCachedModels().filter((m) => m.available)
      if (models.length === 0) {
        models = (await refreshModels()).filter((m) => m.available)
      }
      const model = models[0]
      if (!model) return { ok: false, error: '没有可用的模型' }
      const provider = getProvider(model.providerId)
      if (!provider) return { ok: false, error: '模型供应商不可用' }

      const runEvents = makeTaskEvents(win, makeSend(win))
      // 子代理权限闸：审批请求复用既有审批条通道
      const permGate = new PermissionGate(workspace, (req) => runEvents.onPermissionRequest!(req))
      const parentTools = await collectTools()
      const run = createRunHandle(workspace)
      currentRun = run
      try {
        const report = await runSubagents({
          provider,
          modelName: model.name,
          tasks: cards.slice(0, 4).map((c) => ({
            description: c.title,
            role: c.role as import('../ai/agentRoles').AgentRoleId | undefined,
            timeoutMs: 180_000
          })),
          parentTools,
          workspace,
          events: runEvents,
          gate: permGate,
          signal: run.abortController.signal,
          lockTable: getGlobalFileLockTable(),
          withSummary: true
        })
        return { ok: true, report }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      } finally {
        run.markFinished()
        if (currentRun === run) currentRun = null
      }
    }
  )

  // 放弃未运行的快照任务（重启后场景）：强确认由前端保证；规则复用 applyAbandon
  ipcMain.handle(
    'ai:abandonTask',
    async (_e, workspace: string, taskId: string, rollback: boolean) => {
      return await applyAbandon(workspace, taskId, rollback)
    }
  )

  // ====================== 内联 AI（Tab 补全 / Cmd+K 改写） ======================
  // 与 ai:chatStream 隔离的事件通道：所有事件 payload 携带 requestId，
  // 渲染端按 requestId 过滤，避免与聊天面板的流式订阅互相污染。
  // 用途：Cmd+K 选中改写（InlineEditWidget）+ Ghost Text 内联补全（InlineCompletionsProvider）。
  ipcMain.handle(
    'ai:inlineStream',
    async (event, params: SchedulerChatParams & { requestId: string }) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const { requestId, ...chatParams } = params
      const send = (channel: string, payload?: Record<string, unknown>) => {
        if (win && !win.isDestroyed()) win.webContents.send(channel, { requestId, ...(payload ?? {}) })
      }
      // 2.2 内联流独立中止器：stopInline 真中断底层 HTTP 请求
      inlineStreamAbort = new AbortController()
      try {
        await scheduleChatStream(
          chatParams,
          {
            onChunk: (delta) => send('ai:inlineChunk', { delta }),
            onDone: (info) => send('ai:inlineDone', info),
            onError: (err) => send('ai:inlineError', { err }),
            onFallback: (from, to, reason) => send('ai:inlineFallback', { from, to, reason })
          },
          inlineStreamAbort.signal
        )
      } finally {
        inlineStreamAbort = null
      }
      return { ok: true }
    }
  )

  // 停止内联 AI 请求：先断底层请求，再尽力 abort 所有 provider 收尾
  // 注意：与 ai:stopChat 共用 provider.abort，若同时有聊天任务在跑，两者会一并被中止
  ipcMain.handle('ai:stopInline', async () => {
    inlineStreamAbort?.abort()
    for (const p of getAllProviders()) p.abort?.()
    return { ok: true }
  })

  // ---------- 代码库持久化索引与检索 ----------

  // 模型可见工具清单（内置 + 已连接 MCP），用于设置页展示与工具注册链路验证
  ipcMain.handle('ai:listTools', async () => {
    const tools = await collectTools()
    return tools.map((t) => ({
      server: t.server,
      name: t.tool.name,
      description: t.tool.description || ''
    }))
  })

  // 索引状态：已索引文件数 / 最近更新时间 / 是否正在后台构建
  ipcMain.handle('ai:indexStatus', async (_e, root: string) => {
    if (!root) return { files: 0, updatedAt: null, scanning: false }
    const cached = getCachedIndex(root)
    return {
      files: cached ? Object.keys(cached.files).length : 0,
      updatedAt: cached?.updatedAt || null,
      scanning: isScanning(root)
    }
  })

  // 增量构建索引（force=true 跳过节流与 mtime 比对强制重建）
  // s51：预热场景走 worker 版，避免大项目索引阻塞主进程
  ipcMain.handle('ai:ensureIndex', async (_e, root: string, force = false) => {
    if (!root) return { ok: false, error: '无工作区' }
    const { delta } = await ensureIndexWorker(root, { force })
    return { ok: true, ...delta }
  })

  // 轻量同步检索（@ 引用候选浮层使用；纯 BM25，不触发向量请求）
  ipcMain.handle(
    'ai:searchIndex',
    async (_e, params: { root: string; query: string; limit?: number }) => {
      if (!params?.root || !params.query.trim()) return []
      const { index } = await ensureIndex(params.root)
      return searchIndex(index, params.query, { limit: params.limit ?? 20 }).map((h) => ({
        relPath: h.relPath,
        score: h.score,
        symbol: h.symbol,
        symbolLine: h.symbolLine
      }))
    }
  )

  // 获取与问题相关的上下文片段：增量索引 → @mention 解析 → BM25/语义混合检索 → 预算拼装
  ipcMain.handle(
    'ai:getContext',
    async (
      _e,
      params: { root: string; query: string; currentFile?: string | null; maxChars?: number }
    ) => {
      if (!params?.root) return ''
      const { index } = await ensureIndex(params.root)
      const mentions = parseMentions(params.query, index)
      const currentRel =
        params.currentFile
          ? relative(params.root, params.currentFile).split(sep).join('/')
          : null
      // 语义混合检索（无 embedding 模型时内部自动回退纯 BM25）
      const hits = await hybridSearch(params.root, index, mentions.cleanQuery || params.query, {
        currentRel
      })
      const { text } = await buildContext(
        index,
        params.query,
        params.currentFile ?? null,
        params.root,
        params.maxChars ?? 6000,
        mentions,
        hits
      )
      return text
    }
  )

  // 读取工作区持久化笔记（跨会话知识记忆）
  ipcMain.handle('ai:loadNotes', async (_e, workspace: string) => {
    return loadNotes(workspace)
  })

  // 保存工作区笔记（覆盖写入）
  ipcMain.handle('ai:saveNotes', async (_e, workspace: string, note: AgentNote) => {
    await saveNotes(workspace, note)
    return true
  })

  // ---------- 聊天会话持久化（按工作区隔离，存 userData/chat-history/<wsKey>/） ----------

  // 会话列表（updatedAt 降序；索引与分文件不一致时自愈）
  ipcMain.handle('ai:listSessions', async (_e, workspace: string | null) => {
    return listSessions(app.getPath('userData'), workspace || null)
  })

  // 加载单个完整会话
  ipcMain.handle('ai:loadSession', async (_e, workspace: string | null, id: string) => {
    return loadSession(app.getPath('userData'), workspace || null, id)
  })

  // 保存会话（upsert；空消息返回 null）
  ipcMain.handle(
    'ai:saveSession',
    async (
      _e,
      workspace: string | null,
      data: { id?: string; title?: string; createdAt?: number; messages: StoredMessage[] }
    ) => {
      const id = await saveSession(app.getPath('userData'), workspace || null, data)
      return { ok: id !== null, id }
    }
  )

  // 删除会话：先联动删除其引用的图片附件（尽力而为），再删会话文件
  ipcMain.handle('ai:deleteSession', async (_e, workspace: string | null, id: string) => {
    const wsPath = workspace || null
    try {
      const session = await loadSession(app.getPath('userData'), wsPath, id)
      if (session) {
        const paths = session.messages.flatMap((m) =>
          (m.attachments ?? []).map((a) => a.path)
        )
        await deleteAttachments(paths, wsPath ?? undefined)
      }
    } catch {
      // 附件清理失败不阻断会话删除
    }
    await deleteSession(app.getPath('userData'), wsPath, id)
    return { ok: true }
  })

  // 2.3 保存图片附件：base64 → <workspace>/.trae/attachments/，返回绝对路径
  ipcMain.handle(
    'ai:saveAttachment',
    async (
      _e,
      input: { workspace: string; mimeType: string; data: string }
    ): Promise<{ ok: boolean; path?: string; error?: string }> => {
      try {
        const saved = await saveAttachment(input.workspace, input.mimeType, input.data)
        return { ok: true, path: saved.path }
      } catch (err: any) {
        return { ok: false, error: err?.message || String(err) }
      }
    }
  )

  // 2.3 读取附件为 data URL（历史会话渲染用；附件缺失返回 ok:false，前端显示占位）
  ipcMain.handle(
    'ai:readAttachment',
    async (_e, path: string, workspace?: string) => readAttachment(path, workspace)
  )

  // 会话导出 Markdown（渲染进程拿字符串后走 fs:saveDialog + fs:writeFile）
  ipcMain.handle(
    'ai:sessionToMarkdown',
    async (_e, workspace: string | null, id: string): Promise<string> => {
      const session = await loadSession(app.getPath('userData'), workspace || null, id)
      if (!session) throw new Error('会话不存在或已损坏')
      return toMarkdown(session)
    }
  )

  // ---------- Agent 执行轨迹（录制回放，存 userData/traces/*.json） ----------
  ipcMain.handle('trace:list', () => listTraces(join(app.getPath('userData'), 'traces')))
  ipcMain.handle('trace:load', (_e, file: string) => loadTrace(join(app.getPath('userData'), 'traces'), file))
}
