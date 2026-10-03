// 子代理（Subagent）编排：主 Agent 作为协调者，把复杂任务拆成子任务，
// 派发给多个拥有独立上下文（各自的消息历史互不污染）和独立工具集（可按任务裁剪）
// 的子代理执行。主 Agent 不亲自实现，只负责分派、收集、汇总。
//
// 编排能力（P1⑪ 增强）：
// - DAG 依赖编排：SubTaskSpec.dependsOn 声明前驱下标，Kahn 拓扑分层，
//   无依赖并行、有依赖等前驱；循环依赖/越界/自依赖在派发前拒绝
// - 独立超时：每个子代理 timeoutMs（默认 5 分钟），超时只中止该任务并标注
// - 取消传播：主任务 AbortSignal 中止时，运行中子代理逐轮检查级联退出
// - 并发限流：mapWithConcurrency 信号量，maxConcurrency 可配（默认 MAX_SUBTASKS）
// - Token 预算：整批累计 token（真实 usage 缺失时按字符÷4 估算）超预算停止派发新任务
// - 结果合并：状态徽标（✅/⏱/⛔/⏭）+ 跨任务写入路径冲突标注
//
// 约束：
// - 单次最多派发 MAX_SUBTASKS 个子任务（防止本地模型显存/并发爆炸）
// - 子代理不持有 dispatch_subagents/todo_write（不能再嵌套派发，主 Agent 才是协调者）
// - 每个子代理最多 MAX_SUB_ROUNDS 轮工具循环，超出后强制收尾返回已有结果
import type { AiMessage, AiProvider } from './types'
import path from 'path'
import type { McpToolEntry } from '../handlers/mcpToolBridge'
import { callMcpTool } from '../handlers/mcpToolBridge'
import { buildAgentPrompt, type PromptContext } from './promptBuilder'
import { listSkills, loadSkill, renderSkillList } from './skills'
import { coerceToolArgs, dedupeBatchCalls, parseToolCallsFromContent } from './toolCall'
import type { ToolsEvents } from './scheduler'
import type { PermissionGate } from './permissions'
import { appendAudit } from '../handlers/security'
import { estimateTokens, trackChatUsage } from './usageStats'
import {
  budgetExceeded,
  buildDagLayers,
  extractWrittenPaths,
  findConflicts,
  mapWithConcurrency,
  raceWithControl,
  validateSubTasks,
  type ToolLogEntry
} from './subagentDag'
// s50 角色预设 + 文件写锁
import {
  buildAcceptanceMergePrompt,
  buildConflictVerdictPrompt,
  isAgentRoleId,
  resolveRoleTools,
  roleSystemPrompt,
  SUMMARIZER_PROMPT,
  type AgentRoleId
} from './agentRoles'
import { classifyMutationTool } from './changeStage'
import { getGlobalFileLockTable, type FileLockTable } from './fileLock'

/** 单次最多派发子任务数（硬上限，防本地模型显存/并发爆炸） */
export const MAX_SUBTASKS = 4
/** 每个子代理的最大工具轮数 */
const MAX_SUB_ROUNDS = 8
/** 单个子代理默认超时：5 分钟（spec.timeoutMs 可覆盖） */
export const DEFAULT_SUB_TIMEOUT_MS = 5 * 60 * 1000
/** 整批子代理默认 Token 预算：超出后停止派发新任务（运行中的跑完当前轮收尾） */
export const DEFAULT_TOKEN_BUDGET = 200_000
/** 协调类工具不下放给子代理（不能再嵌套派发，主 Agent 才是协调者） */
const BANNED_TOOLS = new Set(['dispatch_subagents', 'todo_write'])

/** 派发任务描述（模型入参） */
export interface SubTaskSpec {
  /** 子任务目标与约束的完整描述 */
  description: string
  /** 允许使用的工具名白名单（不传则继承除协调工具外的全部工具） */
  tools?: string[]
  /**
   * s50 预设角色（frontend/backend/test）：指定后工具集取角色白名单与可用工具交集，
   * 系统提示追加角色边界；与 tools 同时给出时以角色白名单为准再叠加 tools 交集。
   */
  role?: AgentRoleId
  /** 依赖的前驱任务下标（0 起）：前驱全部完成后本任务才会被调度 */
  dependsOn?: number[]
  /** 单任务超时毫秒数（默认 DEFAULT_SUB_TIMEOUT_MS） */
  timeoutMs?: number
}

/** runSubagents 入参 */
export interface RunSubagentsParams {
  provider: AiProvider
  modelName: string
  tasks: SubTaskSpec[]
  /** 主 Agent 的全量工具池（子代理从中挑选/裁剪） */
  parentTools: McpToolEntry[]
  workspace?: string | null
  agentsMd?: string | null
  /** 合并后的三级规则文本（主 Agent 发现后传入） */
  rulesText?: string | null
  notesText?: string
  currentFile?: string | null
  events?: ToolsEvents
  /** 主 Agent 的权限关卡（子代理工具调用必须同样过闸，防止越权） */
  gate?: PermissionGate
  /** 最大并行子代理数（默认 MAX_SUBTASKS；不会超过硬上限） */
  maxConcurrency?: number
  /** 整批 Token 预算（默认 DEFAULT_TOKEN_BUDGET；<=0 表示不设限） */
  tokenBudget?: number
  /** 主任务取消信号：触发后停止派发新任务，运行中子代理逐轮级联退出 */
  signal?: AbortSignal
  /**
   * s50 写锁表：全部子代理写前取锁；缺省用进程全局单例。
   */
  lockTable?: FileLockTable
  /**
   * s50 汇总 Agent：执行结束后调用模型裁决冲突（无冲突则做验收合并），
   * 裁决文本追加到汇总报告。主信号中止时不额外调用。
   */
  withSummary?: boolean
}

/** 单个子任务的执行结局 */
interface SubOutcome {
  status: 'ok' | 'timeout' | 'aborted' | 'skipped'
  /** 交付文本（或失败/跳过原因说明） */
  text: string
  /** 本子任务消耗的 token（真实 usage 优先，缺失时估算） */
  tokensUsed: number
  /** 本子任务写入/移动过的文件路径 */
  writtenPaths: string[]
}

/**
 * 编排执行多个子代理（DAG 分层 + 并发限流 + 独立超时 + 取消传播 + Token 预算），
 * 返回汇总后的工具结果文本（回填给主 Agent）。任一子代理失败不影响其他子代理。
 */
export async function runSubagents(params: RunSubagentsParams): Promise<string> {
  const { provider, modelName, tasks } = params
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return '错误：dispatch_subagents 需要 tasks 数组（每项含 description）'
  }
  const picked = tasks.slice(0, MAX_SUBTASKS)

  // 依赖合法性前置校验：非法声明直接回报错误文本，一个都不派发
  const check = validateSubTasks(picked)
  if (!check.ok) {
    return `错误：dispatch_subagents 依赖声明非法：${check.error}。请修正 dependsOn 后重新派发。`
  }

  const layers = buildDagLayers(picked.length, picked.map((t) => t.dependsOn))
  const concurrency = Math.max(1, Math.min(params.maxConcurrency ?? MAX_SUBTASKS, MAX_SUBTASKS))
  const budget = params.tokenBudget ?? DEFAULT_TOKEN_BUDGET
  const signal = params.signal

  const skills = params.workspace ? await listSkills(params.workspace) : []
  const outcomes: (SubOutcome | undefined)[] = new Array(picked.length).fill(undefined)
  let usedTokens = 0
  let doneCount = 0

  const hasDeps = picked.some((t) => (t.dependsOn?.length ?? 0) > 0)
  params.events?.onSubagent?.(
    0,
    picked.length,
    'start',
    `派发 ${picked.length} 个子任务（并发≤${concurrency}${hasDeps ? '，含依赖编排' : ''}）`
  )

  // 逐层执行：层间按依赖串行，层内信号量限流并行
  for (const layer of layers) {
    // 主任务已取消：本层及后续不再派发
    if (signal?.aborted) {
      for (const idx of layer) {
        outcomes[idx] = { status: 'aborted', text: '主任务已被用户中止，未派发', tokensUsed: 0, writtenPaths: [] }
      }
      continue
    }
    // Token 预算耗尽：本层及后续不再派发
    if (budgetExceeded(usedTokens, budget)) {
      for (const idx of layer) {
        outcomes[idx] = {
          status: 'skipped',
          text: `Token 预算已耗尽（已用≈${usedTokens} / 上限 ${budget}），未派发`,
          tokensUsed: 0,
          writtenPaths: []
        }
      }
      continue
    }

    await mapWithConcurrency(layer, concurrency, async (idx) => {
      const spec = picked[idx]
      // 前驱失败级联：任一前驱未完成（超时/取消/跳过）则本任务跳过
      const badDep = (spec.dependsOn ?? []).find((d) => outcomes[d] && outcomes[d]!.status !== 'ok')
      if (badDep !== undefined) {
        outcomes[idx] = {
          status: 'skipped',
          text: `前驱子任务${badDep + 1} 未成功完成，本子任务跳过`,
          tokensUsed: 0,
          writtenPaths: []
        }
        params.events?.onSubagent?.(doneCount, picked.length, 'skip', `子任务${idx + 1} 因前驱失败跳过`)
        return
      }

      params.events?.onSubagent?.(doneCount, picked.length, 'start', `子任务${idx + 1} 开始执行`)
      const runPromise = runOne({
        index: idx,
        total: picked.length,
        task: spec,
        provider,
        modelName,
        parentTools: params.parentTools,
        workspace: params.workspace,
        agentsMd: params.agentsMd,
        rulesText: params.rulesText,
        notesText: params.notesText,
        currentFile: params.currentFile,
        skills,
        events: params.events,
        gate: params.gate,
        signal,
        // s50 锁表与持有者名（子任务间、与主任务互不相同）
        lockTable: params.lockTable ?? getGlobalFileLockTable(),
        owner: `sub-${idx + 1}`
      }).catch((e) => ({
        text: `子任务${idx + 1}异常退出：${e?.message || String(e)}`,
        tokensUsed: 0,
        writtenPaths: [] as string[]
      }))

      const raced = await raceWithControl(runPromise, {
        timeoutMs: spec.timeoutMs && spec.timeoutMs > 0 ? spec.timeoutMs : DEFAULT_SUB_TIMEOUT_MS,
        signal
      })

      if (raced.status === 'timeout') {
        // 尽力止损：中止 provider 当前请求，避免超时任务继续占用推理资源
        provider.abort?.()
        outcomes[idx] = {
          status: 'timeout',
          text: `子任务超时（>${Math.round((spec.timeoutMs ?? DEFAULT_SUB_TIMEOUT_MS) / 1000)}s），已中止`,
          tokensUsed: 0,
          writtenPaths: []
        }
      } else if (raced.status === 'aborted') {
        outcomes[idx] = { status: 'aborted', text: '主任务已被用户中止', tokensUsed: 0, writtenPaths: [] }
      } else {
        // runOne 内部逐轮检查 signal 后可能正常收尾：此时若中止信号已到达，仍标注为已取消
        const value = raced.value!
        outcomes[idx] = signal?.aborted
          ? { status: 'aborted', text: value.text, tokensUsed: value.tokensUsed, writtenPaths: value.writtenPaths }
          : { status: 'ok', ...value }
        usedTokens += value.tokensUsed
      }
      doneCount++
      const phaseLabel = outcomes[idx]!.status === 'ok' ? 'done' : outcomes[idx]!.status
      params.events?.onSubagent?.(doneCount, picked.length, phaseLabel, `子任务${idx + 1} 结束`)
    })
  }

  params.events?.onSubagent?.(picked.length, picked.length, 'done', '全部子任务执行结束')
  const report = mergeReports(picked, outcomes)

  // s50 汇总 Agent：有冲突 → 冲突裁决；无冲突 → 验收合并。主信号中止则跳过额外调用。
  if (params.withSummary && !signal?.aborted) {
    const conflicts = findConflicts(outcomes.map((o) => o?.writtenPaths ?? []))
    const reports = picked.map((t, i) => ({
      task: `子任务${i + 1}`,
      role: t.role ?? null,
      report: outcomes[i]?.text?.slice(0, 1200) ?? ''
    }))
    const prompt = conflicts.length
      ? buildConflictVerdictPrompt(
          conflicts.map((c) => ({ path: c.path, tasks: c.tasks.map((x) => `子任务${x + 1}`) })),
          reports
        )
      : buildAcceptanceMergePrompt(reports)
    const verdictText = await runSummarizer(provider, modelName, prompt, signal)
    return `${report}\n\n===== 汇总 Agent 裁决 =====\n${verdictText}`
  }
  return report
}

/**
 * 调用汇总 Agent（无工具，限时 60s；失败不阻塞主报告，回填错误说明）。
 */
async function runSummarizer(
  provider: AiProvider,
  modelName: string,
  userPrompt: string,
  signal?: AbortSignal
): Promise<string> {
  const timeout = AbortSignal.timeout(60_000)
  const onAbort = (): void => { timeout.dispatchEvent(new Event('abort')) }
  signal?.addEventListener('abort', onAbort)
  try {
    const res = await provider.chat({
      model: modelName,
      messages: [
        { role: 'system', content: SUMMARIZER_PROMPT },
        { role: 'user', content: userPrompt }
      ],
      signal: timeout
    })
    if (!res.ok || !res.content?.trim()) {
      return `（汇总 Agent 未给出结论：${res.error || '空响应'}）`
    }
    return res.content.trim()
  } catch (e) {
    return `（汇总 Agent 调用失败：${e instanceof Error ? e.message : String(e)}）`
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

/** 汇总报告：状态徽标 + 每任务交付文本 + 跨任务写入冲突清单 */
function mergeReports(tasks: SubTaskSpec[], outcomes: (SubOutcome | undefined)[]): string {
  const STATUS_LABEL: Record<SubOutcome['status'], string> = {
    ok: '✅ 完成',
    timeout: '⏱ 超时',
    aborted: '⛔ 已取消',
    skipped: '⏭ 跳过'
  }
  const sections = tasks.map((task, i) => {
    const o = outcomes[i]
    const label = o ? STATUS_LABEL[o.status] : '⛔ 已取消'
    const meta = o && o.tokensUsed > 0 ? `，tokens≈${o.tokensUsed}` : ''
    const body = o?.text || '（无产出）'
    return `===== 子任务${i + 1}：${task.description.slice(0, 80)}（${label}${meta}）=====\n${body}`
  })

  // 跨任务写入冲突：多个子任务写了同一路径，提醒主 Agent 核对裁决
  const conflicts = findConflicts(outcomes.map((o) => o?.writtenPaths ?? []))
  if (conflicts.length > 0) {
    const lines = conflicts
      .map((c) => `  - ${c.path} ← ${c.tasks.map((t) => `子任务${t + 1}`).join('、')}`)
      .join('\n')
    sections.push(`⚠ 产物冲突（同一路径被多个子任务写入，请核对后裁决以哪个为准）：\n${lines}`)
  }
  return sections.join('\n\n')
}

/** 单个子代理的执行上下文（从派发参数中剥离 tasks，替换为单个 task） */
interface RunOneParams extends Omit<RunSubagentsParams, 'tasks' | 'maxConcurrency' | 'tokenBudget' | 'withSummary'> {
  index: number
  total: number
  task: SubTaskSpec
  skills: Awaited<ReturnType<typeof listSkills>>
  /** s50 锁持有者名 */
  owner: string
  /** s50 写锁表（runSubagents 保证非空） */
  lockTable: FileLockTable
}

/** 单个子代理的产出（成功路径） */
interface RunOneResult {
  text: string
  tokensUsed: number
  writtenPaths: string[]
}

/** 运行单个子代理：独立消息历史 + 裁剪后的工具集 + 有界循环 + 逐轮取消检查 */
async function runOne(p: RunOneParams): Promise<RunOneResult> {
  const { index, total, task, provider, modelName, parentTools, workspace, events } = p

  // s50 角色白名单：指定 role 时先取角色允许的工具；显式 tools 再叠加交集
  const roleAllow = isAgentRoleId(task.role)
    ? new Set(resolveRoleTools(task.role, parentTools.map((t) => t.tool.name)))
    : null
  // 按白名单裁剪工具；技能工具始终可用
  const allow = Array.isArray(task.tools) && task.tools.length > 0 ? new Set(task.tools) : null
  const tools: McpToolEntry[] = parentTools.filter(
    (t) =>
      !BANNED_TOOLS.has(t.tool.name) &&
      (!roleAllow || roleAllow.has(t.tool.name)) &&
      (!allow || allow.has(t.tool.name))
  )
  const skillNames = new Set(p.skills.map((s) => s.name))
  const ollamaTools = tools.map((t) => ({
    type: 'function',
    function: {
      name: t.tool.name,
      description: t.tool.description || '',
      parameters: t.tool.inputSchema ?? { type: 'object', properties: {} }
    }
  }))

  // 子代理独立上下文：精简系统提示（复用 S1-S11 分层 + 子代理指令）
  const ctx: PromptContext = {
    workspace,
    currentFile: p.currentFile,
    isProjectCreation: false,
    createdFiles: new Set<string>(),
    ranNpmInstall: false,
    ranServe: false,
    round: 0,
    stallRestarts: 0,
    agentsMd: p.agentsMd,
    rulesText: p.rulesText,
    notesText: p.notesText,
    skillsText: renderSkillList(p.skills),
    directive:
      (isAgentRoleId(task.role) ? `${roleSystemPrompt(task.role)}\n` : '') +
      `你是被主 Agent 派发的子代理（第 ${index + 1}/${total} 个），只负责完成下面分配的子任务。` +
      '不要重复描述任务背景，直接调用工具执行；完成后用纯文本输出结果与关键产物路径。' +
      '禁止派发新子任务，禁止做与本子任务无关的事。',
    tools: tools.map((t) => ({ name: t.tool.name, description: t.tool.description }))
  }

  // 独立消息历史：与其他子代理及主 Agent 完全隔离
  const convo: AiMessage[] = [
    { role: 'system', content: buildAgentPrompt(ctx) },
    { role: 'user', content: task.description }
  ]
  const executed = new Map<string, string>()
  // 工具执行记录：供跨任务写入冲突检测提取路径
  const toolLog: ToolLogEntry[] = []
  let tokensUsed = 0
  let lastContent = ''
  let noToolRounds = 0
  let aborted = false

  /**
   * s50 写锁目标：变更类工具（write/edit/delete…）且路径落在工作区内 → 绝对路径；
   * 非变更工具/越界路径返回 null（不需要锁）。
   */
  const lockPathOf = (toolName: string, callArgs: unknown): string | null => {
    if (!workspace) return null
    const analyzed = classifyMutationTool(toolName, (callArgs ?? {}) as Record<string, unknown>)
    if (!analyzed?.ok) return null
    const target = path.isAbsolute(analyzed.call.path)
      ? analyzed.call.path
      : path.resolve(workspace, analyzed.call.path)
    const root = path.resolve(workspace)
    return target === root || target.startsWith(root + path.sep) ? target : null
  }

  /** 实际执行一次工具调用（权限关卡 + MCP/内置桥），供锁包装复用 */
  const executeCall = async (toolName: string, callArgs: unknown): Promise<string> => {
    if (p.gate) {
      const gateResult = await p.gate.check(
        toolName,
        (callArgs ?? {}) as Record<string, unknown>,
        (entry) => appendAudit(workspace, entry)
      )
      if (!gateResult.allowed) {
        return `错误：子代理操作未被允许：${gateResult.reason}`
      }
    }
    const found = tools.find((t) => t.tool.name === toolName)
    return found
      ? await callMcpTool(found.server, toolName, (callArgs ?? {}) as Record<string, unknown>, workspace, p.signal)
      : `错误：未找到工具 ${toolName}`
  }

  for (let round = 0; round < MAX_SUB_ROUNDS; round++) {
    // 取消传播：主任务中止时本子代理逐轮退出（provider 请求间的检查点）
    if (p.signal?.aborted) {
      aborted = true
      break
    }
    ctx.round = round
    convo[0] = { role: 'system', content: buildAgentPrompt(ctx) }
    events?.onSubagent?.(index + 1, total, 'round', `第 ${round + 1}/${MAX_SUB_ROUNDS} 轮`)

    const res = await provider.chat({
      model: modelName,
      messages: convo,
      tools: ollamaTools.length > 0 ? ollamaTools : undefined,
      signal: p.signal
    })
    if (!res.ok) return { text: `子代理模型调用失败：${res.error || '未知错误'}`, tokensUsed, writtenPaths: [] }
    trackChatUsage(
      `${provider.id}:${modelName}`,
      res.usage,
      convo.map((m) => m.content).join('\n'),
      res.content || ''
    )
    // Token 计量：真实 usage 优先；缺失时按字符÷4 保守估算
    const roundIn = convo.map((m) => m.content).join('\n')
    tokensUsed +=
      (res.usage?.tokensIn ?? estimateTokens(roundIn)) +
      (res.usage?.tokensOut ?? estimateTokens(res.content || ''))
    lastContent = res.content || ''

    let toolCalls = (res.toolCalls as any[]) ?? []
    if (toolCalls.length === 0) {
      const parsed = parseToolCallsFromContent(lastContent, tools)
      if (parsed.length > 0) {
        toolCalls = parsed
        lastContent = ''
      }
    }
    toolCalls = dedupeBatchCalls(toolCalls)
    if (toolCalls.length === 0) {
      // 连续两轮无工具调用视为子任务完成（纯文本即交付物）
      if (++noToolRounds >= 2) break
      convo.push({ role: 'assistant', content: lastContent })
      convo.push({
        role: 'user',
        content: '必须继续调用工具完成子任务；若确实已完成，请输出最终结果摘要。'
      })
      continue
    }
    noToolRounds = 0
    convo.push({ role: 'assistant', content: lastContent })

    for (const tc of toolCalls) {
      // 工具级取消检查：中止信号到达时不再发起新的副作用操作
      if (p.signal?.aborted) {
        aborted = true
        break
      }
      const name = tc.function?.name as string
      const rawArgs = tc.function?.arguments
      const args = coerceToolArgs(
        typeof rawArgs === 'string' ? safeJsonParse(rawArgs) : rawArgs,
        workspace
      )
      const dedupKey = `${name} ${JSON.stringify(args ?? {})}`
      if (executed.has(dedupKey)) {
        convo.push({
          role: 'tool',
          name,
          content: executed.get(dedupKey)! + '\n（该操作已执行过，请勿重复）'
        })
        continue
      }
      toolLog.push({ name, args: args ?? {} })
      // 技能工具：子代理内部直接处理（渐进加载）
      let result: string
      if (name === 'list_skills') {
        result = renderSkillList(p.skills) || '暂无可用技能包'
      } else if (name === 'use_skill') {
        const skillName = String(args?.name || '')
        if (!skillNames.has(skillName)) {
          result = `错误：未知技能 ${skillName}，先用 list_skills 查看`
        } else {
          result = await loadSkill(workspace, skillName)
        }
      } else {
        // s50 冲突文件写前取锁：同路径写入在锁表排队，并行子代理互不覆盖
        const mutPath = lockPathOf(name, args)
        result = mutPath
          ? await p.lockTable.withLock(mutPath, p.owner, () => executeCall(name, args))
          : await executeCall(name, args)
      }
      executed.set(dedupKey, result)
      convo.push({ role: 'tool', name, content: result })
    }
    if (aborted) break
  }

  const tail = aborted ? '（主任务已中止，以下为中止前产出）' : ''
  return {
    text:
      (lastContent.trim() || `子代理在 ${MAX_SUB_ROUNDS} 轮内未给出文本结论（工具调用已执行 ${executed.size} 次）`) + tail,
    tokensUsed,
    writtenPaths: extractWrittenPaths(toolLog)
  }
}

/** 安全 JSON.parse：模型偶发输出非法 JSON 时不中断循环 */
function safeJsonParse(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}
