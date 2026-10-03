// AI 聊天状态：消息列表、流式状态、模型选择。
// 聊天走统一调度层（ai:chatStream / ai:chatWithTools）：
// - model='auto' 时由分类器+路由自动选模型，失败/超时自动回退
// - 发送前通过上下文工程注入工作区相关代码片段 + 当前文件内容
import { defineStore } from 'pinia'
import { ref, computed, onMounted, watch } from 'vue'
import { useWorkspaceStore } from './workspace'
import { useGitStore } from './git'
import { detectProfileFromArtifacts, buildForcedResetPrompt } from '@shared/projectProfiles'
import type { UiModelEntry, UiProviderEntry, UiChatParams, UiTodoItem, UiSubagentUpdate, UiPermissionMode, UiPermissionRequest, UiPermissionResponse, UiSessionMeta, UiSessionMessage, UiDriftReport, UiRecoverableTask, UiTaskControl, UiAttachment } from '../api'

/** 空会话欢迎语（仅展示，不入库；判断依据用同一常量） */
const WELCOME =
  '你好！我是 ScholarTreaCode 的 AI 助手。\n默认「自动」模式会按任务类型智能路由模型，响应过慢或失败时自动回退到备选模型。\n也可手动指定模型，或在消息前加 @reason（深度推理）/ @fast（快速补全）显式指定任务类型。'

/** 工具事件元数据：随 role:'tool' 消息建立，由流式事件回填 */
export interface ToolEventData {
  /** 2.2 新增 cancelled：用户停止时在途工具被中止（杀进程/发 MCP cancelled） */
  status: 'running' | 'ok' | 'fail' | 'cancelled'
  /** 参数摘要（summarizeTool 产出） */
  argsBrief: string
  /** 调用发起时间戳，用于计算耗时 */
  startedAt: number
  /** 耗时毫秒（结果到达时回填） */
  durationMs?: number
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  // 展示态字段
  toolName?: string
  /** 2.3 图片附件引用（仅 user 消息；可与文本同时存在，也可仅有图片） */
  attachments?: UiAttachment[]
  /** 结构化工具事件（role:'tool' 且由流式工具事件驱动时存在） */
  toolEvent?: ToolEventData
  isStreaming?: boolean
  // 回退提示等轻量通知（居中弱化展示，不进入发送历史）
  isNotice?: boolean
  // 毫秒时间戳（持久化会话用；欢迎语等 UI 占位消息可缺省）
  ts?: number
}

// 模型选择分组（按供应商聚合，供下拉框 optgroup 使用）
export interface ModelGroup {
  providerId: string
  label: string
  models: UiModelEntry[]
}

export const useChatStore = defineStore('chat', () => {
  const ws = useWorkspaceStore()
  const git = useGitStore()

  const messages = ref<ChatMessage[]>([
    {
      role: 'assistant',
      content: WELCOME
    }
  ])
  const sending = ref(false)
  // 进度条状态：模型执行/命令执行的实时反馈
  const progress = ref<{ model: string; phase: string; round: number; maxRounds: number; tool: string } | null>(null)
  // 思考中的动作提示（如「正在调用工具：write_file」），工具循环期间不再干等
  const thinkingHint = ref('')
  // Agent 自主维护的 TODO 子任务清单（todo_write 工具实时推送）
  const todos = ref<UiTodoItem[]>([])
  // 子代理并行编排状态（dispatch_subagents 工具推送）
  const subagent = ref<UiSubagentUpdate | null>(null)
  // 当前实时偏差报告（㉜，事件到达即置；不随会话持久化，null 时走历史文本）
  const liveDrift = ref<UiDriftReport | null>(null)
  /**
   * 🛑 物理阻断态：后端工具循环被 planDrift.hasBlock / 恢复铁律违规强制终止时置 true。
   * 阻断期间输入框与发送按钮禁用（只能「重试任务」/「查看偏差报告」），
   * 绝不允许模型在受阻状态下继续消耗 token、修改文件。新任务开始时复位。
   */
  const taskBlocked = ref(false)
  // ㊜ 当前工作区可恢复的未完成任务（崩溃/重启/中止残留；工作区切换后重新加载）
  const recoverableTasks = ref<UiRecoverableTask[]>([])
  /**
   * ㊜ 1b live 任务相位：idle（无工具任务/纯流式）/ running / pausing（暂停请求已发）/ paused（已挂起）。
   * pausing 与 paused 必须分开——前者当前调用仍在执行，后者循环已真正挂起。
   */
  const taskPhase = ref<UiTaskControl['phase'] | 'idle'>('idle')
  // 当前 live 任务 id（started 事件落；放弃通道按它定位快照）
  const activeTaskId = ref<string | null>(null)
  // 当前 live 任务的任务前检查点（放弃确认面板的回滚勾选依据）
  const activeCheckpoint = ref<UiRecoverableTask['preTaskCheckpoint']>(null)
  // 当前待决的工具权限审批请求（后端串行推送，同时只有一条）
  const permission = ref<UiPermissionRequest | null>(null)
  // 工具权限模式：readonly 只读 / ask 询问（默认）/ auto 自动
  const permissionMode = ref<UiPermissionMode>('ask')

  // ---------- 会话持久化 ----------
  // 当前工作区的会话列表与当前会话（null = 尚未命名的空会话，不入库直到首条消息）
  const sessions = ref<UiSessionMeta[]>([])
  const currentSessionId = ref<string | null>(null)
  const currentTitle = ref('')
  const currentCreatedAt = ref<number | undefined>(undefined)
  // 历史弹窗开关（头部按钮与弹窗共用）
  const showHistory = ref(false)
  // 保存串行链：防止完成边界/切工作区并发写导致顺序错乱
  let persistChain: Promise<void> = Promise.resolve()

  // AI 任务前自动创建 Git 检查点（默认开启，localStorage 持久化）
  const autoCheckpoint = ref(true)
  try {
    autoCheckpoint.value = localStorage.getItem('scholar:autoCheckpoint') !== '0'
  } catch {
    /* 存储不可用时保持默认 */
  }
  function toggleAutoCheckpoint(v: boolean): void {
    autoCheckpoint.value = v
    try {
      localStorage.setItem('scholar:autoCheckpoint', v ? '1' : '0')
    } catch {
      /* 忽略存储异常 */
    }
  }
  // AI 通过工具写入文件后，防抖刷新工作区文件树
  let wsRefreshTimer: ReturnType<typeof setTimeout> | null = null
  // 会改动文件系统的工具名单（内置工具 + filesystem MCP server + 终端命令）
  const FS_MUTATING_TOOLS = new Set([
    'create_directory',
    'write_file',
    'edit_file',
    'move_file',
    'run_terminal_command',
    'write',
    'edit',
    'bash'
  ])
  function scheduleWorkspaceRefresh(toolName: string): void {
    if (!ws.rootPath || !FS_MUTATING_TOOLS.has(toolName)) return
    if (wsRefreshTimer) clearTimeout(wsRefreshTimer)
    wsRefreshTimer = setTimeout(() => {
      wsRefreshTimer = null
      void ws.loadTree()
    }, 500)
  }

  /**
   * 把流式占位气泡（思考中）移到消息列表末尾。
   * 工具循环期间工具调用/结果行不断追加，占位气泡若停在原位，
   * 「思考中」提示就会悬在历史输出上方；移到末尾让它始终跟随最新进展。
   */
  function movePlaceholderToEnd(): void {
    const idx = messages.value.findIndex(
      (m) => m.role === 'assistant' && m.isStreaming && !m.content
    )
    if (idx === -1 || idx === messages.value.length - 1) return
    const [placeholder] = messages.value.splice(idx, 1)
    messages.value.push(placeholder)
  }
  // 'auto' = 智能路由；否则为显式模型 id（provider:model）
  const model = ref('auto')
  const availableModels = ref<UiModelEntry[]>([])
  const providers = ref<UiProviderEntry[]>([])

  // 按供应商分组（过滤不可用模型不可见但保留展示，标注后缀）
  const modelGroups = computed<ModelGroup[]>(() => {
    const byProvider = new Map<string, UiModelEntry[]>()
    for (const m of availableModels.value) {
      const list = byProvider.get(m.providerId) || []
      list.push(m)
      byProvider.set(m.providerId, list)
    }
    return [...byProvider.entries()].map(([providerId, models]) => ({
      providerId,
      label: providers.value.find((p) => p.id === providerId)?.name || providerId,
      models
    }))
  })

  // 追加消息
  function push(msg: ChatMessage): void {
    messages.value.push(msg)
  }

  // 更新最后一条 assistant 消息（流式）
  function updateLastAssistant(content: string): void {
    const last = messages.value[messages.value.length - 1]
    if (last && last.role === 'assistant') {
      last.content = content
    } else {
      messages.value.push({ role: 'assistant', content, isStreaming: true })
    }
  }

  // 结束最后一条 assistant 的流式标记
  function finishStream(): void {
    const last = messages.value[messages.value.length - 1]
    if (last && last.role === 'assistant') {
      last.isStreaming = false
    }
  }

  // 追加 tool 调用记录
  function addToolCall(name: string, result: string): void {
    messages.value.push({ role: 'tool', content: result, toolName: name })
  }

  // 工具调用简短中文摘要（用于进度提示，替代原始 JSON 输出）
  function summarizeTool(name: string, args: Record<string, unknown>): string {
    const path = typeof args.path === 'string' ? args.path : ''
    const basename = path ? path.split(/[\\/]/).pop() || path : ''
    const cmd = typeof args.command === 'string' ? args.command : ''
    switch (name) {
      case 'create_directory': return `创建目录 ${basename}`
      case 'write_file': return `写入文件 ${basename}`
      case 'edit_file': return `编辑文件 ${basename}`
      case 'move_file': return `移动文件 ${basename}`
      case 'delete_file': return `删除文件 ${basename}`
      // MCP filesystem 新版工具名（与内置工具别名对齐）
      case 'read_file':
      case 'read_text_file':
      case 'read_media_file': return `读取文件 ${basename}`
      case 'read_multiple_files': return '读取多个文件'
      case 'list_directory': return `列出目录 ${basename}`
      case 'list_directory_with_sizes': return `统计目录大小 ${basename}`
      case 'directory_tree': return `查看目录树 ${basename}`
      case 'search_files': return `搜索文件 ${typeof args.pattern === 'string' ? args.pattern : ''}`
      case 'get_file_info': return `查看文件信息 ${basename}`
      case 'list_allowed_directories': return '查看允许访问的目录'
      case 'run_terminal_command': return `执行命令 ${cmd}`
      // 后台任务工具
      case 'start_background_task': return `启动后台任务 ${cmd}`
      case 'list_background_tasks': return '查看后台任务'
      case 'stop_background_task': return '停止后台任务'
      // 内置工具（read/write/edit/bash/grep/glob）
      case 'read': return `读取文件 ${basename}`
      case 'write': return `写入文件 ${basename}`
      case 'edit': return `编辑文件 ${basename}`
      case 'bash': return `执行命令 ${cmd}`
      case 'grep': return `搜索内容 ${typeof args.pattern === 'string' ? args.pattern : ''}`
      case 'glob': return `搜索文件 ${typeof args.pattern === 'string' ? args.pattern : ''}`
      // 运行时协调工具（任务规划 / 子代理编排 / 技能加载）
      case 'todo_write': {
        const action = typeof args.action === 'string' ? args.action : 'list'
        const actionText = action === 'add'
          ? '建立子任务清单'
          : action === 'update'
            ? `更新任务 #${String(args.id ?? '')} 状态`
            : action === 'clear'
              ? '清空任务清单'
              : '查看任务清单'
        return actionText
      }
      case 'dispatch_subagents': {
        const n = Array.isArray(args.tasks) ? args.tasks.length : 0
        return `派发 ${n} 个子代理并行执行`
      }
      case 'list_skills': return '查看可用技能包'
      case 'use_skill': return `加载技能 ${typeof args.name === 'string' ? args.name : ''}`
      case 'plan': return '规划项目结构'
      default: return name
    }
  }

  // 清空上下文（兼容旧调用，语义等同新建空会话）
  function clear(): void {
    void newSession()
  }

  // ---------- 会话持久化动作 ----------

  function lastSessionKey(): string {
    return 'scholar:lastSession:' + (ws.rootPath || 'no-workspace')
  }
  function rememberLastSession(id: string): void {
    try {
      localStorage.setItem(lastSessionKey(), id)
    } catch {
      /* 存储不可用忽略 */
    }
  }
  function forgetLastSession(): void {
    try {
      localStorage.removeItem(lastSessionKey())
    } catch {
      /* 同上 */
    }
  }

  // 切换会话/任务轮次时重置的瞬态状态（不入库）
  function resetTransient(): void {
    todos.value = []
    subagent.value = null
    permission.value = null
    progress.value = null
    thinkingHint.value = ''
    // 实时偏差报告只对当前会话有效，新建/切换会话时清空
    liveDrift.value = null
  }

  // 提取可落盘消息：去通知/流式占位/欢迎语/空内容（允许仅有图片的消息）
  function persistableMessages(): UiSessionMessage[] {
    const now = Date.now()
    return messages.value
      .filter((m) => !m.isNotice && !m.isStreaming)
      .filter((m) => !(m.role === 'assistant' && m.content === WELCOME))
      .filter((m) => m.content.length > 0 || (m.attachments?.length ?? 0) > 0)
      .map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.toolName ? { toolName: m.toolName } : {}),
        // 2.3 附件引用随消息落盘（只存路径，不存图片数据）
        // 注意：store 内是 Vue reactive 代理，IPC 结构化克隆无法克隆 Proxy，必须展开为普通对象
        ...(m.attachments?.length
          ? { attachments: m.attachments.map((a) => ({ path: a.path, mimeType: a.mimeType })) }
          : {}),
        ts: m.ts ?? now
      }))
  }

  // 落盘当前会话（串行排队；返回的 Promise 可在切工作区前 await）
  function persistCurrent(): Promise<void> {
    persistChain = persistChain.then(async () => {
      if (sending.value) return // 发送中只在完成边界落盘，避免存到半截占位
      const msgs = persistableMessages()
      if (msgs.length === 0) return
      const res = await window.api.ai.saveSession(ws.rootPath || null, {
        id: currentSessionId.value ?? undefined,
        // 已命名会话带上标题，避免重命名被自动标题覆盖
        title: currentSessionId.value ? currentTitle.value || undefined : undefined,
        createdAt: currentCreatedAt.value,
        messages: msgs
      })
      if (!res.ok || !res.id) return
      const isNew = !currentSessionId.value
      currentSessionId.value = res.id
      await refreshSessions()
      if (isNew) rememberLastSession(res.id)
    }).catch(() => {
      // 落盘失败不影响聊天
    })
    return persistChain
  }

  // 刷新当前工作区的会话列表，并同步当前会话的标题/创建时间
  async function refreshSessions(): Promise<void> {
    try {
      sessions.value = await window.api.ai.listSessions(ws.rootPath || null)
      if (currentSessionId.value) {
        const meta = sessions.value.find((s) => s.id === currentSessionId.value)
        if (meta) {
          currentTitle.value = meta.title
          currentCreatedAt.value = meta.createdAt
        }
      }
    } catch {
      // 主进程未就绪时静默
    }
  }

  // 新建空会话（发送中禁用，防止流式事件写错会话）
  async function newSession(): Promise<void> {
    if (sending.value) return
    await persistChain
    currentSessionId.value = null
    currentTitle.value = ''
    currentCreatedAt.value = undefined
    messages.value = [{ role: 'assistant', content: WELCOME }]
    resetTransient()
    forgetLastSession()
  }

  // 切换到指定会话
  async function switchSession(id: string): Promise<void> {
    if (sending.value || id === currentSessionId.value) return
    await persistCurrent()
    const data = await window.api.ai.loadSession(ws.rootPath || null, id)
    if (!data) {
      // 会话已删除/损坏：刷新列表，若是当前会话则回到空态
      await refreshSessions()
      if (currentSessionId.value === id) await newSession()
      return
    }
    currentSessionId.value = data.id
    currentTitle.value = data.title
    currentCreatedAt.value = data.createdAt
    messages.value = data.messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.toolName ? { toolName: m.toolName } : {}),
      // 2.3 附件引用（图片缺失时由组件渲染占位）
      ...(m.attachments?.length ? { attachments: m.attachments } : {}),
      ts: m.ts
    }))
    resetTransient()
    rememberLastSession(id)
  }

  // 重命名会话（当前会话直接改内存并落盘；其他会话远程取出改名回存）
  async function renameSession(id: string, title: string): Promise<void> {
    const next = title.trim()
    if (!next) return
    if (id === currentSessionId.value) {
      currentTitle.value = next
      await persistCurrent()
      return
    }
    const data = await window.api.ai.loadSession(ws.rootPath || null, id)
    if (!data) return
    await window.api.ai.saveSession(ws.rootPath || null, {
      id: data.id,
      title: next,
      createdAt: data.createdAt,
      messages: data.messages
    })
    await refreshSessions()
  }

  // 删除会话；删的是当前会话则回到空态
  async function deleteSession(id: string): Promise<void> {
    await window.api.ai.deleteSession(ws.rootPath || null, id)
    if (currentSessionId.value === id) await newSession()
    await refreshSessions()
  }

  // 导出 Markdown：主进程生成文本 → 系统另存为 → 写文件
  async function exportSession(id: string): Promise<{ ok: boolean; canceled?: boolean; error?: string }> {
    try {
      const md = await window.api.ai.sessionToMarkdown(ws.rootPath || null, id)
      const meta = sessions.value.find((s) => s.id === id)
      const safeName = (meta?.title || '会话').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)
      const dlg = await window.api.fs.saveDialog(`${safeName}.md`)
      if (dlg.canceled || !dlg.ok || !dlg.path) return { ok: false, canceled: true }
      await window.api.fs.writeFile(dlg.path, md)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : '导出失败' }
    }
  }

  // ㊜ 加载当前工作区可恢复任务（坏快照在主进程侧已跳过）
  async function loadRecoverableTasks(): Promise<void> {
    if (!ws.rootPath) {
      recoverableTasks.value = []
      return
    }
    try {
      recoverableTasks.value = await window.api.ai.listRecoverableTasks(ws.rootPath)
    } catch {
      recoverableTasks.value = []
    }
  }

  // 工作区变化时：落盘旧分区 → 加载新分区列表 → 恢复上次会话（无则空态）
  async function initForWorkspace(): Promise<void> {
    await persistCurrent()
    await refreshSessions()
    let lastId: string | null = null
    try {
      lastId = localStorage.getItem(lastSessionKey())
    } catch {
      lastId = null
    }
    if (lastId && sessions.value.some((s) => s.id === lastId)) {
      await switchSession(lastId)
    } else {
      await newSession()
    }
  }

  // 工作区联动：等工作区恢复完成再初始化，避免 null→saved 抖动触发两次；
  // token 守卫确保恢复期间又切换工作区时只有最新一次 init 生效
  let initToken = 0
  watch(
    () => ws.rootPath,
    async () => {
      const my = ++initToken
      await ws.restoreReady.catch(() => false)
      if (my !== initToken) return
      await initForWorkspace()
      if (my !== initToken) return
      // 会话恢复后再刷恢复条（openFolder/closeProject 都经 rootPath 变化，无需另接）
      await loadRecoverableTasks()
    },
    { immediate: true }
  )

  // 加载供应商与模型清单（调度层聚合所有启用供应商）
  async function loadModels(): Promise<void> {
    try {
      availableModels.value = await window.api.ai.listModels()
    } catch {
      // 主进程未就绪时静默，下次发送前会再刷新
    }
    try {
      providers.value = await window.api.ai.listProviders()
    } catch {
      // 同上
    }
  }

  // 组装发送历史：剔除通知/工具消息/空流式占位气泡，转成纯 {role, content}
  // 注意：发送时会先 push 一个空的 assistant 占位（isStreaming），若混入历史尾部，
  // 主进程 isProjectCreation 等"最后一条必须是 user"的检测会全部失效，必须过滤
  // 构造发给调度层的消息历史：user 的图片附件转 parts（image 片段带盘上路径）
  function history(): UiChatParams['messages'] {
    return messages.value
      .filter((m) => !m.isNotice && m.role !== 'tool' && m.role !== 'system')
      .filter((m) => !(m.role === 'assistant' && m.isStreaming && !m.content))
      .map((m) => {
        const out: UiChatParams['messages'][number] = { role: m.role, content: m.content }
        if (m.role === 'user' && m.attachments?.length) {
          out.parts = [
            ...(m.content ? [{ type: 'text' as const, text: m.content }] : []),
            ...m.attachments.map((a) => ({
              type: 'image' as const,
              mimeType: a.mimeType,
              path: a.path
            }))
          ]
        }
        return out
      })
  }

  // 上下文工程：当前文件内容 + 工作区相关片段，拼成 system 锚点注入
  async function contextAnchor(query: string): Promise<{ role: 'system'; content: string } | null> {
    const parts: string[] = []
    // 1) 当前打开文件的内容（截断 4000 字符，避免挤占窗口）
    if (ws.currentFile && ws.currentContent) {
      const head = ws.currentContent.slice(0, 4000)
      parts.push(`// 当前打开文件：${ws.currentFile}\n${head}`)
    }
    // 2) 工作区相关片段（依赖邻接 + 关键词打分选取）
    if (ws.rootPath) {
      try {
        const text = await window.api.ai.getContext({
          root: ws.rootPath,
          query,
          currentFile: ws.currentFile,
          maxChars: 6000
        })
        if (text) parts.push(text)
      } catch {
        // 上下文构建失败不阻塞聊天
      }
    }
    if (parts.length === 0) return null
    return {
      role: 'system',
      content:
        '以下是当前项目的相关代码上下文（仅供理解需求时参考，不必复述）：\n\n' + parts.join('\n\n')
    }
  }

  // 发送聊天（纯对话：自动路由 + 流式回退）；attachments 为 2.3 图片附件
  async function send(text: string, attachments?: UiAttachment[]): Promise<void> {
    const att = attachments && attachments.length > 0 ? attachments : undefined
    if ((!text.trim() && !att) || sending.value) return
    const now = Date.now()
    push({ role: 'user', content: text, ...(att ? { attachments: att } : {}), ts: now })
    sending.value = true
    thinkingHint.value = ''
    // 新一轮任务开始：清空上一轮实时偏差报告与物理阻断态
    liveDrift.value = null
    taskBlocked.value = false
    messages.value.push({ role: 'assistant', content: '', isStreaming: true, ts: now })
    // 上下文锚点在 push 用户消息后构建，query 取本轮问题
    const anchor = await contextAnchor(text)
    const base = history()
    const payload = anchor ? [anchor, ...base] : base
    try {
      await window.api.ai.chatStream({
        model: model.value,
        messages: payload,
        currentFile: ws.currentFile,
        workspace: ws.rootPath
      })
    } finally {
      sending.value = false
      await persistCurrent()
    }
  }

  // 发送聊天（工具调用模式：MCP 工具循环 + 路由回退）；attachments 为 2.3 图片附件
  async function sendWithTools(text: string, attachments?: UiAttachment[]): Promise<void> {
    const att = attachments && attachments.length > 0 ? attachments : undefined
    if ((!text.trim() && !att) || sending.value) return
    const now = Date.now()
    push({ role: 'user', content: text, ...(att ? { attachments: att } : {}), ts: now })
    sending.value = true
    thinkingHint.value = ''
    progress.value = null
    // 新一轮任务：清空上一轮的 TODO 清单、子代理状态与实时偏差报告
    todos.value = []
    subagent.value = null
    permission.value = null
    liveDrift.value = null
    taskBlocked.value = false
    messages.value.push({ role: 'assistant', content: '', isStreaming: true, ts: now })
    const anchor = await contextAnchor(text)
    const base = history()
    // 工作区锚点：工具操作必须使用工作区下的绝对路径，
    // 否则模型会用相对路径把文件建到 MCP 服务器默认目录（应用自身目录）
    const wsAnchor = ws.rootPath
      ? [{
          role: 'system' as const,
          content: `当前工作区根目录：${ws.rootPath}。所有文件/目录的创建、读写操作必须使用该目录下的绝对路径（例如 ${ws.rootPath}\\demo\\a.txt），禁止只给相对路径。`
        }]
      : []
    const payload = anchor ? [...wsAnchor, anchor, ...base] : [...wsAnchor, ...base]
    try {
      // AI 动手前自动建检查点（仅在 Git 仓库且开关开启时；内部静默处理无变更/失败）
      if (autoCheckpoint.value && ws.rootPath) {
        await git.createCheckpoint('AI 任务前自动检查点', true)
      }
      const res = await window.api.ai.chatWithTools({
        model: model.value,
        messages: payload,
        currentFile: ws.currentFile,
        workspace: ws.rootPath
      })
      // 非流式：把最终内容写入占位气泡（blocked 时 content 是物理中断总结，同样展示）
      if (res.content && (res.ok || res.blocked)) {
        updateLastAssistant(res.content)
      }
      // 🛑 物理阻断：后端已清空工具队列并落盘 interrupted，文案/系统消息/偏差卡片均已就位，
      // 这里只置阻断态（输入区锁定），不再追加「任务失败」之类的混淆提示。
      if (res.blocked) {
        taskBlocked.value = true
      } else if (res.ok) {
        // 工具模式完成提示：检测停滞/未验证状态
        const stalled = res.content?.includes('任务未完成')
        const unverified = res.content?.includes('项目未验证')
        const serveNotRun = res.content?.includes('未验证运行')
        messages.value.push({
          role: 'system',
          content: stalled
            ? '⚠️ 任务未完成（AI 停滞，可能只创建了部分文件）'
            : unverified
              ? '⚠️ 文件已创建但未验证（未执行 npm install）'
              : serveNotRun
                ? '⚠️ 依赖已安装但未验证运行（未执行 npm run serve）'
                : '✅ 任务完成' + (res.error ? `（${res.error}）` : '')
        })
      } else {
        messages.value.push({
          role: 'system',
          content: '❌ 任务失败：' + (res.error || '未知错误')
        })
      }
    } finally {
      finishStream()
      sending.value = false
      progress.value = null
      resetTaskControl()
      await persistCurrent()
      // 任务结束刷新 Git 改动数（非仓库/无 git 时内部静默降级）
      void git.refresh()
    }
  }

  // ㊜ 继续未完成任务：流式收尾镜像 sendWithTools（占位气泡→invoke→最终内容/错误），
  // 不新增 user 消息——恢复本身是原任务的延续，而非新一轮对话
  async function resumeTask(taskId: string): Promise<void> {
    if (sending.value || !ws.rootPath) return
    const task = recoverableTasks.value.find((t) => t.taskId === taskId)
    if (!task) return
    const now = Date.now()
    sending.value = true
    thinkingHint.value = ''
    progress.value = null
    taskBlocked.value = false
    messages.value.push({ role: 'assistant', content: '', isStreaming: true, ts: now })
    try {
      const res = await window.api.ai.resumeTask(ws.rootPath, taskId)
      if (res.content && (res.ok || res.blocked)) {
        updateLastAssistant(res.content)
      }
      if (res.blocked) {
        // 续跑再次被物理阻断：锁定输入区，等用户点「重试任务」
        taskBlocked.value = true
      } else {
        messages.value.push({
          role: 'system',
          content: res.ok ? '✅ 任务已继续完成' : '❌ 续跑失败：' + (res.error || '未知错误')
        })
      }
    } finally {
      finishStream()
      sending.value = false
      progress.value = null
      resetTaskControl()
      await persistCurrent()
      // 成功后快照已被主进程删除/更新，重新拉取恢复条与 Git 状态
      await loadRecoverableTasks()
      void git.refresh()
    }
  }

  // ㊜ 放弃任务：rollback 由恢复条确认弹层决定（强确认 UI 在组件侧）
  async function abandonTask(taskId: string, rollback: boolean): Promise<void> {
    if (!ws.rootPath) return
    const res = await window.api.ai.abandonTask(ws.rootPath, taskId, rollback)
    if (!res.ok) {
      messages.value.push({ role: 'system', content: '❌ ' + (res.error || '放弃失败') })
    }
    await loadRecoverableTasks()
    void git.refresh()
  }

  // ㉜ 缺失产物一键生成：固定指令模板走普通发送，保留用户可在发送前改文本的余地
  async function generateMissing(detail: string): Promise<void> {
    const text = `请补齐缺失产物：${detail}。完成后执行相应验证。`
    await send(text)
  }

  /**
   * 🛑 阻断态唯一放行的出口：携带 FORCED-RECOVERY 标签重开工具循环。
   * 后端识别该标签后进入三阶段白名单（write-only → install → done），
   * 第一步只允许 write_file 整体覆盖偏差报告中的缺失文件，禁止 read/edit 旧文件。
   *
   * 通用化：按缺失产物反推项目画像（requirements.txt→python、go.mod→go…），
   * 重置话术的依赖安装/运行命令与全局安装禁令按画像生成，不再写死 npm。
   * 重试前显式重置该任务的临时上下文（TODO/子代理/审批/偏差报告），确保 AI 在干净画布上重新开始。
   */
  async function retryBlockedTask(): Promise<void> {
    if (sending.value) return
    const missingPaths = (liveDrift.value?.items ?? [])
      .filter((it) => it.kind === 'missingArtifact')
      .map((it) => it.detail)
    const missingDetails = missingPaths.map((d) => `- ${d}`).join('\n')
    // 按缺失产物反推项目画像，生成该生态专属的系统强制重置话术
    const profile = detectProfileFromArtifacts(missingPaths)
    const text = buildForcedResetPrompt(profile, missingDetails)
    // 重试前显式清理任务级临时上下文（sendWithTools 内会再清一次，双保险）
    todos.value = []
    subagent.value = null
    permission.value = null
    liveDrift.value = null
    taskBlocked.value = false
    await sendWithTools(text)
  }

  /** 解除阻断锁定（用户已知晓偏差、想手动继续对话时使用） */
  function dismissBlocked(): void {
    taskBlocked.value = false
  }

  // 应答工具权限审批：允许一次 / 本次会话始终允许 / 拒绝
  async function respondPermission(decision: UiPermissionResponse['decision'], reason?: string): Promise<void> {
    const req = permission.value
    if (!req) return
    permission.value = null
    try {
      await window.api.ai.respondPermission(req.id, { decision, reason })
    } catch {
      // 主进程异常时审批条已关闭，后端超时机制会兜底拒绝
    }
  }

  // 切换权限模式并持久化到主进程
  async function setPermissionMode(mode: UiPermissionMode): Promise<void> {
    permissionMode.value = mode
    try {
      await window.api.ai.setPermissionMode(mode)
    } catch {
      // 持久化失败不影响本次界面状态
    }
  }

  onMounted(() => {
    loadModels()
    // 读取已持久化的权限模式
    window.api.ai.getPermissionMode().then((m) => {
      permissionMode.value = m
    }).catch(() => {})

    // 订阅调度层推送：流式 token / 完成 / 错误 / 回退 / 工具过程
    window.api.ai.onChatChunk((chunk) => {
      const last = messages.value[messages.value.length - 1]
      if (last && last.role === 'assistant' && last.isStreaming) {
        last.content += chunk
      } else {
        messages.value.push({ role: 'assistant', content: chunk, isStreaming: true })
      }
    })
    window.api.ai.onChatDone(() => {
      thinkingHint.value = ''
      finishStream()
      // 流式完成边界落盘（与 send() finally 互为保险，重复 upsert 无害）
      void persistCurrent()
    })
    window.api.ai.onChatError((err) => {
      thinkingHint.value = ''
      finishStream()
      // 空占位气泡直接移除，避免留下空白消息
      const last = messages.value[messages.value.length - 1]
      if (last && last.role === 'assistant' && !last.content) messages.value.pop()
      push({ role: 'assistant', content: `AI 错误：${err}`, isNotice: true })
      // 出错也要保住本轮 user 消息
      void persistCurrent()
    })
    window.api.ai.onChatFallback(({ from, to, reason }) => {
      push({
        role: 'assistant',
        content: `⇄ ${from} 无响应，已回退到 ${to}（${reason}）`,
        isNotice: true
      })
    })
    let lastToolArgs: Record<string, unknown> = {}
    window.api.ai.onToolCall((p) => {
      lastToolArgs = p.args || {}
      const brief = summarizeTool(p.name, lastToolArgs)
      thinkingHint.value = brief
      if (progress.value) progress.value.tool = p.name
      // 结构化工具卡片：todo_write 由专用 TODO 面板展示，不推卡片
      if (p.name !== 'todo_write') {
        messages.value.push({
          role: 'tool',
          content: '',
          toolName: p.name,
          toolEvent: { status: 'running', argsBrief: brief, startedAt: Date.now() },
          ts: Date.now()
        })
      }
      movePlaceholderToEnd()
    })
    window.api.ai.onToolResult((p) => {
      const brief = summarizeTool(p.name, lastToolArgs)
      const ok = !p.result.includes('error') && !p.result.includes('错误') && !p.result.includes('failed')
      // 2.2 用户停止产生的取消结果优先识别为「已取消」（不计入失败，也不计入成功）
      const cancelled = p.result.includes('已被用户中止') || p.result.includes('（任务已被用户中止）')
      thinkingHint.value = cancelled ? `${brief} 已取消` : `${brief} ${ok ? '✓' : '✗'}`
      // 从尾向前找最近的同名 running 工具卡片，回填结果/状态/耗时
      for (let i = messages.value.length - 1; i >= 0; i--) {
        const m = messages.value[i]
        if (m.role === 'tool' && m.toolName === p.name && m.toolEvent?.status === 'running') {
          m.content = p.result
          m.toolEvent.status = cancelled ? 'cancelled' : ok ? 'ok' : 'fail'
          m.toolEvent.durationMs = Date.now() - m.toolEvent.startedAt
          break
        }
      }
      if (progress.value) progress.value.tool = ''
      movePlaceholderToEnd()
      scheduleWorkspaceRefresh(p.name)
    })
    window.api.ai.onModelCall(({ model, phase }) => {
      // 更新进度条状态，不推送系统消息
      const roundMatch = phase.match(/第(\d+)轮/)
      const round = roundMatch ? parseInt(roundMatch[1]) : 0
      progress.value = { model, phase, round, maxRounds: 20, tool: '' }
    })
    // Agent TODO 清单实时同步（todo_write 工具驱动的自主任务规划）
    window.api.ai.onTodoUpdate((items) => {
      todos.value = items
    })
    // 子代理并行编排进度
    window.api.ai.onSubagentUpdate((p) => {
      subagent.value = p
    })
    // 工具权限审批请求：弹出审批条挂起等待用户选择
    window.api.ai.onPermissionRequest((req) => {
      permission.value = req
    })
    // 偏差报告：
    // - 收尾报告（interrupted 缺省）：仅置 liveDrift，卡片在最后一条 assistant 消息后展示；
    // - 中途强制中断（interrupted=true）：模型工具循环已被立即打断，除卡片外还要在对话流
    //   插入系统指令，明确告知「已强制中断」，避免界面上方仍显示模型继续输出的幻觉式进展。
    window.api.ai.onPlanDrift((report) => {
      liveDrift.value = report
      if (report.interrupted && sending.value) {
        // 🛑 物理阻断：后端工具循环已在批次内被打断（不再执行任何工具、不再自动重规划），
        // 立即锁定输入区并在对话流插入中断指令，避免界面呈现模型仍在工作的幻觉。
        taskBlocked.value = true
        messages.value.push({
          role: 'system',
          content:
            '⛔ 检测到关键产物缺失（或违反强制恢复顺序），任务已被系统物理中断——后续工具调用已全部丢弃，不会再修改任何文件。请查看下方偏差报告，点击「重试任务」按固定顺序恢复：① write_file 补齐缺失基础文件（禁止 read/edit）② npm install ③ 运行验证。'
        })
      }
    })
    // ㊜ 1b 运行门相位：started 建立 live 任务态；paused/running 直接同步
    window.api.ai.onTaskControl((payload) => {
      if (payload.phase === 'started') {
        activeTaskId.value = payload.taskId
        activeCheckpoint.value = payload.preTaskCheckpoint ?? null
        taskPhase.value = 'running'
      } else {
        taskPhase.value = payload.phase
      }
    })
  })

  // 停止当前 AI 任务：通知主进程触发中止信号（主循环逐轮退出 + 子代理级联中止）。
  // sending 复位由进行中的 send/sendWithTools 的 finally 完成，这里只发信号。
  async function stopSending(): Promise<void> {
    if (!sending.value) return
    try {
      await window.api.ai.stopChat()
    } catch {
      // 停止失败不阻断 UI（任务会自然结束）
    }
  }

  // ㊜ 1b 请求软暂停：乐观置 pausing（后端只在真正挂起时才推 paused），
  // 当前模型/工具调用不被打断，循环到安全点才挂起
  async function pauseRunning(): Promise<void> {
    if (!sending.value || taskPhase.value !== 'running') return
    taskPhase.value = 'pausing'
    try {
      const r = await window.api.ai.pauseTask()
      if (r.ok && r.phase === 'pausing') return
      // 后端相位已推进（如瞬间到 paused）由事件同步；失败则回退显示
      if (!r.ok) taskPhase.value = 'running'
    } catch {
      taskPhase.value = 'running'
    }
  }

  // ㊜ 1b 进程内继续：释放挂起；相位以事件为准，失败时恢复 paused 显示
  async function resumeRunning(): Promise<void> {
    if (!sending.value) return
    try {
      const r = await window.api.ai.resumePausedTask()
      if (!r.ok) taskPhase.value = 'paused'
    } catch {
      taskPhase.value = 'paused'
    }
  }

  // ㊜ 1b 放弃 live 任务：主进程 abort 并等循环退出，rollback 时回滚任务前检查点再删快照
  async function abortRunning(rollback: boolean): Promise<void> {
    const id = activeTaskId.value
    if (!id) return
    try {
      const res = await window.api.ai.abortRunningTask(ws.rootPath, id, rollback)
      if (!res.ok) {
        messages.value.push({ role: 'system', content: '❌ ' + (res.error || '放弃失败') })
      }
    } finally {
      await loadRecoverableTasks()
      void git.refresh()
    }
  }

  /** live 任务态复位：sendWithTools / resumeTask 收尾边界统一调用 */
  function resetTaskControl(): void {
    taskPhase.value = 'idle'
    activeTaskId.value = null
    activeCheckpoint.value = null
  }

  return {
    messages,
    sending,
    thinkingHint,
    progress,
    todos,
    subagent,
    liveDrift,
    taskBlocked,
    retryBlockedTask,
    dismissBlocked,
    recoverableTasks,
    loadRecoverableTasks,
    resumeTask,
    abandonTask,
    generateMissing,
    permission,
    permissionMode,
    autoCheckpoint,
    toggleAutoCheckpoint,
    respondPermission,
    setPermissionMode,
    stopSending,
    // ㊜ 1b 运行门
    taskPhase,
    activeTaskId,
    activeCheckpoint,
    pauseRunning,
    resumeRunning,
    abortRunning,
    // 会话持久化
    sessions,
    currentSessionId,
    currentTitle,
    showHistory,
    refreshSessions,
    newSession,
    switchSession,
    renameSession,
    deleteSession,
    exportSession,
    persistCurrent,
    model,
    availableModels,
    providers,
    modelGroups,
    push,
    updateLastAssistant,
    finishStream,
    addToolCall,
    clear,
    loadModels,
    send,
    sendWithTools
  }
})
