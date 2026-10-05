// 调度器：分类 → 路由 → 按候选顺序尝试，失败/超时自动回退到下一个模型。
// 对外暴露 chatStream（流式）/ chatWithTools（非流式，含 MCP 工具循环）。
import type {
  AiMessage,
  AiStreamCallbacks,
  SchedulerChatParams,
  TaskType
} from './types'
import { classify } from './router'
import { getCachedModels, getProvider } from './providerRegistry'
import { collectTools, callMcpTool, listMcpServers, type McpToolEntry } from '../handlers/mcpToolBridge'
import { buildAgentPrompt, buildAgentsMd, buildRulesMd, renderNotes, type PromptContext } from './promptBuilder'
import { dirname, relative, sep, extname, resolve, isAbsolute, join } from 'node:path'
import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
// s42 改动影响提醒 + s43 spec 锚点拦截（规则在纯函数层，本文件只做挂接）
import { buildEditImpact, formatEditImpact, symbolPattern } from './symbolNav'
import { loadAnchors, matchProtectedPath, removedProtectedSymbols, formatAnchorBlock, type AnchorsFile } from './anchors'
import { runContentSearch } from '../search/searchEngine'
import { loadNotes, updateAfterTask } from './agentNotes'
import { compactIfNeeded, type Summarizer } from './contextCompactor'
import { resolveCapabilities } from './modelCapabilities'
import { estimateTokensText, computeHistoryBudget } from './tokenBudget'
import { coerceToolArgs, dedupeBatchCalls, parseToolCallsFromContent } from './toolCall'
// 三模型分时复用架构
import {
  switchModel,
  safeSwitch,
  currentRole,
  currentChoice,
  type ModelRole
} from './modelRegistry'
import {
  parseTaskDag,
  createDagState,
  readyNodes,
  checkOrderViolation,
  markDone,
  markFailed,
  type TaskDag
} from './taskDag'
import { resolveVfsPath, roleEnvironmentHint, isThreeModelMode } from './virtualFs'
import {
  createObserverState,
  noteReadFailure,
  noteReadSuccess,
  canTrigger,
  buildObserverPrompt,
  parseObserverVerdict,
  serializeObserverState,
  type ObserverState
} from './observer'
import { packForSwitch, unpackAfterSwitch, type RoleSwitchBundle } from './taskSnapshot'
import {
  checkDependencyClosure,
  buildCoderRepairPrompt,
  parseCoderPatches,
  validatePatches
} from './semanticValidator'
import { inferPort, probeDevServer, buildRuntimeDiagnosis } from './runtimeValidator'
import { TodoStore, type TodoItem, type TodoWriteArgs } from './todoManager'
import { detectPlanDrift, formatDriftReport, type DriftReport } from './planDrift'
import { listSkills, loadSkill, renderSkillList, recommendSkills } from './skills'
import { runSubagents, type SubTaskSpec } from './subagents'
import { getEnvironmentReport, formatEnvironmentReport } from './environmentProbe'
import {
  detectProfileFromText,
  formatProfileDiscipline,
  manifestContentOk,
  templateIdForProfile,
  NODE_GATE_PROFILE,
  type ProjectProfile
} from '../../shared/projectProfiles'
import { getTemplate } from './validationTemplates'
import { FAST_FAIL_BREAKER_TAG } from '../terminal/commandError'
import { validateDagStatic } from './dagValidator'
import { gateBashCommand, gateBashMessage, type BashGateContext } from './bashGate'
import { runInteractiveInPty } from '../handlers/ptyManager'
import {
  checkForbiddenFile,
  checkForbiddenCommand,
  checkCommandThrottle
} from './toolGuards'
import {
  createReplanState,
  noteFailure,
  noteSuccess,
  shouldReplan,
  markReplanned,
  requestReplan,
  sanitizeReplanSteps,
  summarizeSignals,
  MAX_REPLANS,
  type ReplanStep
} from './replanner'
import { PermissionGate, type PermissionRequest, type UserPermissionResponse } from './permissions'
import { appendAudit, isInside } from '../handlers/security'
// ㊝ 变更事务暂存：IO/落盘在 handlers/staging，归类与覆盖判断在纯函数 changeStage
import {
  isStageEnabled,
  commitStaged,
  overlayToolResult,
  getStageSummary,
  getStageNotice,
  beginBashAccept,
  takeStageSnapshot,
  restoreStageSnapshot,
  clearStaging,
  readStageDisk,
  readEffectiveView
} from '../handlers/staging'
import {
  classifyMutationTool,
  STAGE_READ_NAMES,
  STAGE_GREP_NAMES,
  STAGE_GLOB_NAMES,
  type StageSummary
} from './changeStage'
import { trackChatUsage } from './usageStats'
import {
  runRule,
  runValidation,
  vueScaffoldManifest,
  parseManifest,
  resolveTemplateReference,
  AVAILABLE_TEMPLATE_IDS,
  type ArtifactManifest,
  type ValidationContext
} from './validation'
import { TraceRecorder, saveTrace, rotateTraces, type AgentTrace } from './agentTrace'
import {
  buildTaskSnapshot,
  type TaskStatus,
  type SnapshotCheckpoint,
  type ParsedTaskSnapshot
} from './taskSnapshot'
import { saveTaskSnapshot, pruneInterruptedSince } from './taskStore'
// s48 执行时间线：工具调用记录/配对/广播
import {
  argsBriefOf,
  createTimeline,
  serializeTimeline,
  tlFinish,
  tlStart,
  type TimelineState
} from './timeline'
// s50 全局文件写锁
import { getGlobalFileLockTable } from './fileLock'
import type { TaskControlGate } from './taskControl'
// ㊜ 1c：可暂停整体超时 + 超时原因（abort reason 区分超时/用户中止）
import { PausableTimeout, TimeoutBudgetError } from './pausableTimeout'
import { getLogger } from './logger'

/** 流式请求的首 token 超时：本地大模型冷启动加载可能很慢，只守护「多久内开始出字」 */
const DEFAULT_TIMEOUT = 30_000
/** 工具调用模式整体超时系数：允许多轮工具循环（多文件脚手架 + 依赖安装需要足够轮次） */
const MAX_TOOL_ROUNDS = 20

/**
 * 首 token 超时守护：ms 内未收到任何输出（chunk/done）则视为模型无响应，
 * reject 让上层回退到下一个候选。一旦开始出字就不再限时（长回复不被误杀）。
 * 超时后标记 settled，僵尸流的后续 token 全部丢弃，避免与回退模型输出交叉污染。
 */
function withFirstTokenTimeout(
  run: (cb: AiStreamCallbacks) => Promise<{ ok: boolean; error?: string }>,
  callbacks: AiStreamCallbacks,
  ms: number
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve, reject) => {
    let settled = false
    let gotToken = false
    const timer = setTimeout(() => {
      if (!gotToken && !settled) {
        settled = true
        reject(new Error(`模型 ${ms / 1000}s 内未开始响应`))
      }
    }, ms)

    const wrapped: AiStreamCallbacks = {
      onChunk: (delta) => {
        if (settled) return // 超时后的僵尸流：丢弃
        gotToken = true
        callbacks.onChunk(delta)
      },
      onDone: (info) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        callbacks.onDone(info)
        resolve({ ok: true })
      },
      onError: (err) => {
        // 错误不直通 UI：记录后让调度器决定是否回退，全败时统一上报
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ ok: false, error: err })
      },
      onFallback: callbacks.onFallback,
      onUsage: (u) => callbacks.onUsage?.(u)
    }

    run(wrapped).then(
      (r) => {
        clearTimeout(timer)
        if (!settled) {
          settled = true
          resolve(r)
        }
      },
      (e) => {
        clearTimeout(timer)
        if (!settled) {
          settled = true
          reject(e instanceof Error ? e : new Error(String(e)))
        }
      }
    )
  })
}

/**
 * 网络/服务不可达错误识别（纯函数）：fetch failed / ECONNREFUSED / ETIMEDOUT 等属于
 * 传输层故障，与具体模型无关——同一个 Ollama 端口挂了，换一个模型名再请求必然再次失败，
 * 只会造成「A 无响应，已切换到 A」式无效回退与上下文断裂。
 * 注意：首 token 超时（"模型 Ns 内未开始响应"，可能只是冷启动加载）不含这些特征，仍允许回退。
 */
export function isNetworkUnreachableError(message: unknown): boolean {
  const text = String(message ?? '').toLowerCase()
  return (
    text.includes('fetch failed') ||
    text.includes('failed to fetch') ||
    text.includes('network request failed') ||
    text.includes('econnrefused') ||
    text.includes('econnreset') ||
    text.includes('econnaborted') ||
    text.includes('enotfound') ||
    text.includes('eai_again') ||
    text.includes('etimedout') ||
    text.includes('ehostunreach') ||
    text.includes('enetunreach') ||
    text.includes('err_network') ||
    text.includes('err_internet_disconnected') ||
    /connect\s+timeout|connection\s+timed\s*out|timeout\s*\(\s*(?:1006|\d{4,5})\s*\)/.test(text)
  )
}

/** 网络不可达时给用户/模型的明确终止提示（不做模型切换） */
const NETWORK_UNREACHABLE_HINT =
  '网络请求失败，无法连接模型服务（fetch failed / 连接被拒绝 / 超时）。' +
  '请检查 Ollama 服务是否正常运行（默认地址 http://127.0.0.1:11434，可在设置中确认端点与模型），服务恢复后再重试；本次不会自动切换模型。'

/**
 * 阶段二 · TaskType → ModelRole 映射（决策层职责）。
 * classify() 推断的粗粒度任务类型，映射到三模型分时复用的具体角色：
 * - reasoning → planner（深度推理 / 规划，需要大模型 + 长上下文）
 * - completion → coder（代码补全 / 终端命令，偏好代码专精模型）
 * - tool → executor（工具循环，要求稳定 + 平衡）
 * - chat → executor（普通对话，最轻量稳定模型即可）
 */
function taskTypeToModelRole(taskType: TaskType): ModelRole {
  switch (taskType) {
    case 'reasoning':
      return 'planner'
    case 'completion':
      return 'coder'
    case 'tool':
    case 'chat':
    default:
      return 'executor'
  }
}

/**
 * 任务物理中断错误：planDrift 确认关键产物缺失（hasBlock）后，工具循环不再
 * 自动重规划/续跑/切换候选模型，直接抛错到包装层终止整个任务，等待用户显式重试。
 */
export class TaskBlockedError extends Error {
  constructor(public readonly drift: DriftReport, message: string) {
    super(message)
    this.name = 'TaskBlockedError'
  }
}

/** 解析候选模型列表（已删除）：阶段二之后由 ModelRegistry.safeSwitch 内部按角色自适应选择 */
/* resolveCandidates / nextCandidateAfterNetworkError 已删除：阶段二统一路由，候选回退循环由 safeSwitch 内部 executor 兜底接管 */

/**
 * 阶段二 · 流式聊天：统一路由走 AdaptiveScheduler + ModelRegistry。
 * 1. classify 推断 TaskType → 映射到 ModelRole
 * 2. safeSwitch(role) 切换驻留模型（内部自适应选择 + executor 兜底）
 * 3. 直接调用 OllamaProvider.chatStream，不再做候选回退循环
 * 网络不可达等错误由底层直接抛出；safeSwitch 已在角色维度兜底。
 */
export async function scheduleChatStream(
  params: SchedulerChatParams,
  callbacks: AiStreamCallbacks,
  /** 取消信号：用户停止时真中断底层 HTTP 请求（2.2） */
  signal?: AbortSignal
): Promise<void> {
  const { task: taskType, strippedMessages } = classify(params.messages, {
    currentFile: params.currentFile,
    hint: params.taskType
  })
  const role = taskTypeToModelRole(taskType)

  // 阶段二：safeSwitch 内部完成自适应模型选择 + executor 兜底；
  // 降级时触发 onFallback，提示前端当前用 executor 顶替原角色。
  const sw = await safeSwitch(role, {
    signal,
    onSwitch: (from, to, degraded) => {
      if (degraded) {
        callbacks.onFallback?.(
          from ?? role,
          to,
          `角色 ${role} 无可用模型，已降级到 ${to} 兜底`
        )
      }
    }
  })
  if (!sw.ok) {
    callbacks.onError(`没有可用的模型，请确认 Ollama 已运行且已安装模型：${sw.error}`)
    return
  }

  const modelName = sw.choice.profile.name
  const provider = getProvider('ollama')
  if (!provider) {
    callbacks.onError('Ollama 供应商未就绪')
    return
  }

  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT
  // 用量记账：onUsage 真实统计优先；provider 未上报时按字符数估算兜底
  let usageReported = false
  let outText = ''
  const tracking: AiStreamCallbacks = {
    onChunk: (d) => {
      outText += d
      callbacks.onChunk(d)
    },
    onDone: callbacks.onDone,
    onError: callbacks.onError,
    onFallback: callbacks.onFallback,
    onUsage: (u) => {
      usageReported = true
      trackChatUsage(`ollama:${modelName}`, u, '', '')
    }
  }

  try {
    const result = await withFirstTokenTimeout(
      (cb) => provider.chatStream({ messages: strippedMessages, signal }, cb),
      tracking,
      timeoutMs
    )
    if (result.ok) {
      if (!usageReported) {
        const inText = strippedMessages.map((m) => m.content).join('\n')
        trackChatUsage(`ollama:${modelName}`, undefined, inText, outText)
      }
      return
    }
    // 网络不可达：直接终止并提示检查服务（safeSwitch 已在角色层面兜底，无需再切模型）
    if (isNetworkUnreachableError(result.error || '')) {
      callbacks.onError(`${NETWORK_UNREACHABLE_HINT}（最后错误：${result.error}）`)
      return
    }
    callbacks.onError(`模型调用失败：${result.error || '未知错误'}`)
  } catch (err: any) {
    const lastError = err?.message || String(err)
    provider.abort?.()
    if (isNetworkUnreachableError(lastError)) {
      callbacks.onError(`${NETWORK_UNREACHABLE_HINT}（最后错误：${lastError}）`)
      return
    }
    callbacks.onError(`模型调用异常：${lastError}`)
  }
}

/** 工具流过程事件：透传给渲染进程展示「正在调用工具 → 结果」 */
export interface ToolsEvents {
  onToolCall?: (name: string, args: unknown) => void
  onToolResult?: (name: string, result: string) => void
  onFallback?: (from: string, to: string, reason: string) => void
  onModelCall?: (model: string, phase: string) => void
  /** TODO 子任务清单变化（todo_write 工具触发，前端实时渲染进度） */
  onTodo?: (todos: TodoItem[]) => void
  /** 子代理编排进度：current/total + phase(start/round/done) + 描述 */
  onSubagent?: (current: number, total: number, phase: string, detail: string) => void
  /** 工具权限审批：ask 模式/危险操作时挂起工具执行，等待前端审批条应答 */
  onPermissionRequest?: (req: PermissionRequest) => Promise<UserPermissionResponse>
  /** 动态重规划触发：第 N 次重规划 + 新修复步骤 + 触发原因 */
  onReplan?: (replanCount: number, steps: string[], reason: string) => void
  /** 任务收尾：计划-执行偏差检测报告（未完成步骤/产物缺失/计划外文件） */
  onPlanDrift?: (report: DriftReport) => void
  /**
   * ㊜ 运行门控制事件：
   * - started：任务启动（携带 taskId 与任务前检查点，前端建立 live 任务态）；
   * - pausing/paused/running：软暂停相位流转（暂停请求 → 已挂起 → 继续）。
   */
  onTaskControl?: (payload: TaskControlPayload) => void
  /**
   * ㊝ bash 批量接受门：审阅模式下暂存非空时，bash 前请用户先接受全部变更落盘。
   * 仅负责把门事件推给前端；真正的等待由 beginBashAccept 返回的 promise 驱动，
   * 前端通过 staging:bashAcceptResponse → resolveBashAccept 应答。
   */
  onBashAcceptRequest?: (payload: { id: string; summary: StageSummary }) => void
  /** ㊝ 暂存区发生变化（入暂存/接受/拒绝后），前端面板据此刷新 */
  onStagingChanged?: () => void
  /**
   * s48 执行时间线广播：每次工具调用开始/结果回填后推送全量步骤（含 taskId，
   * 供渲染端「从此步重跑」定位；步骤含 AI 理由/diff 摘要/耗时/状态）。
   */
  onTimeline?: (payload: { taskId: string; steps: import('./timeline').TimelineStep[] }) => void
}

/** onTaskControl 事件载荷 */
export interface TaskControlPayload {
  taskId: string
  phase: 'started' | 'pausing' | 'paused' | 'running'
  preTaskCheckpoint?: SnapshotCheckpoint | null
}

/**
 * ㊜ 任务控制选项（由调用方组装后透传进 runWithTools）：
 * - workspace：快照落盘根目录（<workspace>/.trae/tasks/）；
 * - sessionId：关联会话 id（排查用，可空）；
 * - preTaskCheckpoint：任务启动前自动建立的检查点（放弃/回滚用，可空）。
 */
export interface TaskControlOptions {
  workspace: string
  sessionId: string | null
  preTaskCheckpoint: SnapshotCheckpoint | null
}

/** 检测是否为项目创建请求（触发规划阶段）。倒序找最后一条 user 消息，防止历史尾部混入占位气泡导致漏检 */
export function isProjectCreation(messages: AiMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') continue
    return /(创建|新建|建|生成|初始化).*(项目|工程|vue|react|app|application|express|koa|next|nuxt|脚手架|scaffold)/i.test(messages[i].content)
  }
  return false
}

/** 历史失败运行残留的测试性垃圾文件白名单（精确文件名，只删 txt，避免误删合法代码） */
const LEFTOVER_JUNK_FILES = ['example.txt', 'test.txt', 'temp.txt', 'tmp.txt', 'demo.txt', 'sample.txt']

/**
 * 项目创建任务启动前清理历史残留：扫描工作区根目录与一级子目录（覆盖 vue2-project/ 这类目标子目录），
 * 删除白名单内的垃圾文件。node_modules 与点开头目录跳过。删除失败/目录不可读均不阻断主流程。
 */
function cleanupLeftoverJunk(workspace: string): void {
  const tryRemove = (dir: string): void => {
    for (const name of LEFTOVER_JUNK_FILES) {
      const p = join(dir, name)
      if (existsSync(p)) {
        try {
          unlinkSync(p)
          console.log(`[TraeCode] 清理历史残留文件：${p}`)
        } catch {
          // 文件被占用或无权限：跳过，不阻断任务启动
        }
      }
    }
  }
  try {
    tryRemove(workspace)
    for (const entry of readdirSync(workspace, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
        tryRemove(join(workspace, entry.name))
      }
    }
  } catch {
    // 工作区目录不可读时跳过清理
  }
}

/**
 * 规划阶段：用 reasoning 模型分析用户请求，生成详细的文件创建计划。
 * 计划包含每个文件的路径和完整内容，供 coder 模型在工具循环中逐个 write。
 */
async function generatePlan(
  strippedMessages: AiMessage[],
  workspace: string | null | undefined,
  events?: ToolsEvents,
  /** 环境探测摘要：注入规划提示词，让 AI 感知本机可用运行时 */
  environmentReport?: string,
  /** 触发式推荐技能名：命中 frontmatter triggers 的技能，要求规划时先加载 */
  recommendedSkills?: string[],
  /** 取消信号：用户停止时真中断规划请求（2.2） */
  signal?: AbortSignal
): Promise<string | null> {
  // 阶段二：切到 Planner 角色（决策层统一入口，safeSwitch 内部 executor 兜底）
  const sw = await safeSwitch('planner', { signal })
  if (!sw.ok) return null
  const plannerName = sw.choice.profile.name
  const provider = getProvider('ollama')
  if (!provider) return null

  const lastUser = strippedMessages[strippedMessages.length - 1]
  const envBlock = environmentReport
    ? `\n${environmentReport}\n（规划时若需使用未安装的运行时，请引导用户安装或改用已安装的运行时）`
    : ''
  // 技能推荐块：明确要求执行阶段先 use_skill 加载，照规范实施而非自由发挥
  const skillBlock = recommendedSkills && recommendedSkills.length > 0
    ? `\n匹配的内置/工作区技能（执行阶段第一步先调用 use_skill 加载，严格按技能中的规范与命令实施，不要凭空发挥）：${recommendedSkills.join('、')}`
    : ''
  const planPrompt = `用户请求：${lastUser?.content ?? ''}
工作区：${workspace ?? '未指定'}${envBlock}${skillBlock}

请为这个项目制定详细的文件创建计划。对每个文件，给出：
1. 文件路径（相对于工作区根目录）
2. 文件完整内容（必须是可用的代码，不能省略）

要求：
- 必须在计划第一行单独输出目标子目录：targetDir: <项目子目录名>（如 vue2-project），随后所有文件路径都必须位于该子目录下（如 vue2-project/package.json）；仅当工作区本身就是空项目目录时才允许输出 targetDir: .
- 禁止依赖全局脚手架命令（vue create / create-react-app / npm init 等），所有文件必须用 write 工具直接写入完整内容
- 严禁使用 npm init（含 -y/--yes）生成 package.json——必须直接 write 完整内容（含 name/scripts/dependencies）
- Vue2 项目必须使用 Vue 2 API：new Vue()、new VueRouter()、new Vuex.Store()，禁止使用 Vue 3 的 createApp/createRouter
- 必须包含：package.json、babel.config.js、vue.config.js、index.html、src/main.js、src/App.vue、src/router/index.js、src/store/index.js、src/components/HelloWorld.vue、README.md
- package.json dependencies：vue@2.6.14, vue-router@3.5.1, vuex@3.6.2；devDependencies：@vue/cli-service, @vue/cli-plugin-babel, @vue/cli-plugin-router, @vue/cli-plugin-vuex
- vue.config.js 配置 devServer.port 和路径别名
- 项目必须能通过 npm install && npm run serve 正常运行

请按以下格式输出每个文件：
=== 文件: 相对路径 ===
完整文件内容
=== 结束 ===

最后，在所有文件输出完毕后，请额外输出一个「产物清单声明」（用于收尾验证锁）。

**方式一（推荐）：引用内置模板**——只需指定 template id，系统会自动套用该生态的关键产物校验规则：
\`\`\`manifest
{ "template": "<模板id>" }
\`\`\`
可用模板 id：${AVAILABLE_TEMPLATE_IDS.join(' / ')}
（vue-scaffold=Vue2 脚手架五件套、node-service=Node 服务、python-project=Python 项目、go-project=Go 项目、rust-project=Rust 项目、docker-service=Docker 服务）

**方式二：内联完整 JSON**——自定义全部规则：
\`\`\`manifest
{ "id": "<项目标识>", "rules": [ { "id": "<规则id>", "description": "<缺失时的提示文案>", "kind": "fileExists" | "commandExecuted", "path": "<相对路径，fileExists 用>", "command": "<命令文本，commandExecuted 用>" } ] }
\`\`\`
方式一也可追加自定义 rules：{ "template": "go-project", "rules": [ { "id": "custom", "description": "...", "kind": "fileExists", "path": "..." } ] }。
manifest 的 rules 应覆盖本任务全部关键产物（如 package.json / src/main.js / src/App.vue 走 fileExists，npm install / npm run serve 走 commandExecuted）。无 path/command 的规则字段可省略。`
  events?.onToolCall?.('plan', { prompt: 'reasoning model 规划中' })
  events?.onModelCall?.(plannerName, '规划')
  try {
    const res = await provider.chat({
      messages: [{ role: 'user', content: planPrompt }],
      signal
    })
    trackChatUsage(`ollama:${plannerName}`, res.usage, planPrompt, res.content || '')
    events?.onToolResult?.('plan', res.content || '')
    return res.ok ? res.content || null : null
  } catch {
    return null
  }
}

/**
 * 三模型模式：生成 DAG 执行计划（Planner 角色，14B）。
 * 提示词要求输出 ```dag 代码块，包含 nodes/edges/complexity 字段。
 * 失败时返回 null，调用方回退到现有 plan 文本模式。
 */
async function generateDagPlan(
  strippedMessages: AiMessage[],
  workspace: string | null | undefined,
  events?: ToolsEvents,
  environmentReport?: string,
  recommendedSkills?: string[],
  signal?: AbortSignal,
  projectProfile?: ProjectProfile | null
): Promise<{ ok: true; dag: TaskDag; targetDir: string | null } | { ok: false }> {
  const lastUser = strippedMessages[strippedMessages.length - 1]
  const envBlock = environmentReport ? `\n${environmentReport}` : ''
  const skillBlock = recommendedSkills?.length
    ? `\n匹配的技能（先 use_skill 加载）：${recommendedSkills.join('、')}`
    : ''

  const dagPrompt = `用户请求：${lastUser?.content ?? ''}
工作区：${workspace ?? '未指定'}${envBlock}${skillBlock}

请为这个项目制定 DAG 执行计划。输出格式：
\`\`\`dag
{
  "version": 1,
  "targetDir": "<项目子目录名，如 vue2-project>",
  "nodes": [
    {
      "id": "n1",
      "action": "write_file",
      "args": { "path": "<相对路径>", "content": "<完整内容>" },
      "dependencies": [],
      "complexity": "low"
    },
    {
      "id": "n2",
      "action": "run_command",
      "args": { "command": "npm install", "cwd": "<targetDir>" },
      "dependencies": ["n1"],
      "complexity": "low"
    }
  ]
}
\`\`\`

要求：
- 文件创建节点（write_file）complexity 按代码量标记：>200 行或复杂组件 → "high"（路由 Coder），否则 "low"（Executor 直接执行）
- 依赖关系必须准确：npm install 依赖 package.json 创建节点；npm run serve 依赖 npm install 节点
- 禁止全局安装命令（npm install -g 等）；禁止 npm init；必须用 write_file 直接写 package.json
- Vue2 项目必须用 Vue 2 API（new Vue()），禁止 createApp`

  // 切到 Planner
  const sw = await safeSwitch('planner', { signal })
  if (!sw.ok) {
    events?.onFallback?.('planner', 'executor', sw.error)
    return { ok: false }
  }
  // 自适应模式：直接用选择结果的模型名，构造 providerId 前缀
  const plannerModelName = sw.choice.profile.name
  events?.onModelCall?.(plannerModelName, '规划')

  const providerId = 'ollama'
  const modelName = plannerModelName
  const provider = getProvider(providerId)
  if (!provider) return { ok: false }

  try {
    const res = await provider.chat({
      messages: [{ role: 'user', content: dagPrompt }],
      signal
    })
    trackChatUsage(`${providerId}:${modelName}`, res.usage, dagPrompt, res.content || '')
    if (!res.ok || !res.content) return { ok: false }
    const parsed = parseTaskDag(res.content)
    if (!parsed.ok) {
      events?.onFallback?.('dag-parse', 'plan-text', parsed.error)
      return { ok: false }
    }
    // DAG 静态审查：拦截非标准节点和越序命令
    const dagValidation = validateDagStatic(parsed.dag, projectProfile ?? null, parsed.dag.targetDir ?? null)
    if (!dagValidation.ok) {
      console.warn('[TraeCode] DAG 静态审查未通过:', dagValidation.error)
      events?.onFallback?.('dag', 'plan-text', `DAG 审查失败：${dagValidation.error}`)
      return { ok: false }
    }
    if (dagValidation.warnings.length > 0) {
      console.warn('[TraeCode] DAG 静态审查警告:', dagValidation.warnings)
    }
    return { ok: true, dag: parsed.dag, targetDir: parsed.dag.targetDir ?? null }
  } catch {
    return { ok: false }
  }
}

/**
 * 从 plan 文本中提取 manifest 代码块（二期 generatePlan 注入）。
 * 匹配第一个 ```manifest ... ``` 代码块，JSON.parse 后交 parseManifest 校验结构。
 * 容错：无段 / JSON 损坏 / 字段缺失 → 返回 null（不阻断主流程，回退到 vueScaffold / null）。
 */
export function extractManifestFromPlan(plan: string): ArtifactManifest | null {
  const m = plan.match(/```manifest\s*([\s\S]*?)```/i)
  if (!m || !m[1]) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(m[1].trim())
  } catch {
    return null
  }
  // 双形态解析：1) template 引用 → 从模板库取深拷贝（可追加自定义 rules）；2) 内联完整 manifest JSON
  if (parsed && typeof parsed === 'object') {
    const byTemplate = resolveTemplateReference(parsed as Record<string, unknown>)
    if (byTemplate) return byTemplate
  }
  return parseManifest(parsed)
}

// ==================== 执行阶段硬门控 / targetDir 限定 / 文件动作防抖 ====================

/**
 * 从 plan 文本提取目标子目录（targetDir）。
 * 1) 显式标记：`targetDir: vue2-project`（generatePlan 提示词要求首行输出）；
 * 2) 兜底推断：`=== 文件: xxx ===` 路径若全部共享同一顶层目录则采纳。
 * 返回 null 表示项目建在工作区根（不做子目录限定）。
 * 安全：拒绝绝对路径与 .. 上跳。
 */
export function extractTargetDirFromPlan(plan: string | null | undefined): string | null {
  if (!plan) return null
  let dir = ''
  // 捕获组用 [^\s] 而非 \w：targetDir 可能是中文目录名（如 D:\编译测试项目\xxx 场景）
  const m = plan.match(/^\s*targetDir[:：]\s*([^\s]+?)\s*$/im)
  if (m?.[1]) {
    dir = m[1].trim()
  } else {
    const paths = [...plan.matchAll(/===\s*文件[:：]\s*([^\s=]+?)\s*===/g)].map((x) =>
      x[1].replace(/\\/g, '/').replace(/^\.?\//, '')
    )
    const withSub = paths.filter((p) => p.includes('/'))
    if (withSub.length > 0 && withSub.length === paths.length) {
      const tops = new Set(withSub.map((p) => p.split('/')[0]))
      if (tops.size === 1) dir = [...tops][0]
    }
  }
  if (!dir || dir === '.' || dir === './') return null
  if (/^([a-zA-Z]:[\\/]|\/)/.test(dir) || dir.includes('..')) return null
  return dir.replace(/[\\/]+$/, '') || null
}

/** 执行阶段：files（文件生成）→ install（依赖安装）→ run（运行验证） */
export type ExecStage = 'files' | 'install' | 'run'

/**
 * 计算当前执行阶段（零 IO 纯函数；磁盘探测以 onDisk 谓词显式注入）。
 * files 就绪判据：active manifest 的全部 fileExists 规则满足（createdFiles 或 onDisk）；
 * 无 manifest 时回退「画像 dependencyManifest 存在」。install→run：已成功执行画像 init 命令。
 */
export function computeExecStage(opts: {
  isProjectCreation: boolean
  createdFiles: Set<string>
  ranInit: boolean
  manifest: ArtifactManifest | null
  profile: ProjectProfile
  onDisk?: (relPath: string) => boolean
}): ExecStage {
  if (!opts.isProjectCreation) return 'run'
  const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase()
  const satisfied = (rel: string): boolean => {
    const n = norm(rel)
    const created = Array.from(opts.createdFiles).some((p) => {
      const np = norm(p)
      return np === n || np.endsWith('/' + n)
    })
    return created || (opts.onDisk?.(rel) ?? false)
  }
  const fileRules = (opts.manifest?.rules ?? []).filter(
    (r) => r.kind === 'fileExists' && typeof (r as any).path === 'string'
  )
  let filesReady: boolean
  if (fileRules.length > 0) {
    filesReady = fileRules.every((r) => satisfied((r as any).path as string))
  } else if (opts.profile.dependencyManifest) {
    filesReady = satisfied(opts.profile.dependencyManifest)
  } else {
    filesReady = true
  }
  if (!filesReady) return 'files'
  if (!opts.ranInit) return 'install'
  return 'run'
}

/**
 * 执行阶段硬门控：STAGE_FILES 阶段禁止一切依赖安装命令（画像 initPattern）。
 * 返回拦截文案；放行返回 null。
 */
export function checkExecStageGate(
  cmd: string,
  stage: ExecStage,
  profile: ProjectProfile
): string | null {
  if (stage !== 'files' || !profile.initPattern) return null
  const command = (cmd || '').trim()
  if (!profile.initPattern.test(command)) return null
  return (
    '【阶段错误】当前处于文件生成阶段，必须首先使用 write_file 完成依赖清单（如 ' +
    `${profile.dependencyManifest}）和所有源码文件的创建，然后再请求安装依赖。`
  )
}

/**
 * 运行命令源码前置校验（顺序锁的源码维度）：
 * 画像声明 sourceDir 时，运行/验证命令要求源码目录已有产物——否则 dev server 必然秒退
 * （典型：package.json 与 node_modules 就绪但 src/ 为空，npm run dev 通过依赖检查后直接崩溃）。
 * 零 IO 纯函数：磁盘探测由调用方以 onDiskNonEmpty 注入（与 computeExecStage 的 onDisk 同款）。
 * 返回拦截文案；放行返回 null。
 */
export function checkRunSourceGate(
  cmd: string,
  profile: ProjectProfile,
  createdFiles: Set<string>,
  onDiskNonEmpty?: (relDir: string) => boolean
): string | null {
  if (!profile.sourceDir) return null
  const command = (cmd || '').trim()
  if (!command) return null
  if (!profile.runPattern?.test(command) && !profile.primaryRunPattern?.test(command)) return null
  const srcSeg = profile.sourceDir.replace(/^\/+|\/+$/g, '').toLowerCase()
  const inCreated = Array.from(createdFiles).some((f) => {
    const n = f.replace(/\\/g, '/').toLowerCase()
    return n.startsWith(srcSeg + '/') || n.includes('/' + srcSeg + '/')
  })
  if (inCreated || onDiskNonEmpty?.(profile.sourceDir)) return null
  return (
    `【前置校验失败】源码目录 ${profile.sourceDir} 为空，此时执行 ` +
    `${command.split(/\s*[;&|]/)[0].trim()} 必然秒退。` +
    `请先使用 write_file 创建 ${profile.sourceDir} 下的源码文件（入口文件与组件），再运行。`
  )
}

/** 参与防抖统计的文件读写工具名 */
const FILE_ACTION_TOOLS = new Set([
  'read',
  'read_file',
  'read_text_file',
  'write',
  'write_file',
  'edit',
  'edit_file'
])
/** 参与「不存在」黑名单的读取类工具名（read 系 + 列目录） */
export const READ_LIKE_TOOLS = new Set(['read', 'read_file', 'read_text_file', 'list_directory'])
/** 读取结果中「目标不存在」的判定（仅在结果以错误前缀开头时参与判定，避免误伤正文） */
const READ_NOT_FOUND_RE = /不存在|enoent|no such file|not found|找不到|无法找到/i

/** 提取读取类工具的目标路径（归一化小写正斜杠）；无路径参数返回 null */
function readTargetOf(args: unknown): string | null {
  const a = (args ?? {}) as Record<string, unknown>
  const p = a.path ?? a.filePath ?? a.file_path ?? a.directory
  return typeof p === 'string' && p ? p.replace(/\\/g, '/').toLowerCase() : null
}
/** 防抖窗口大小（最近 N 次文件动作）与同文件触发阈值 */
export const FILE_ACTION_WINDOW = 6
export const FILE_ACTION_THRESHOLD = 3

/** 提取文件动作的路径（归一化小写正斜杠）；非文件读写工具返回 null */
export function fileActionPath(name: string, args: unknown): string | null {
  if (!FILE_ACTION_TOOLS.has(name)) return null
  const a = (args ?? {}) as Record<string, unknown>
  const p = a.path ?? a.filePath ?? a.file_path
  return typeof p === 'string' && p ? p.replace(/\\/g, '/').toLowerCase() : null
}

/**
 * 文件动作防抖窗口：推入一次动作，返回新窗口与是否触发强制重启。
 * 触发条件：窗口内同一路径出现 ≥ FILE_ACTION_THRESHOLD 次（读/写/修补混排死循环）。
 */
export function trackFileAction(
  window: string[],
  path: string
): { window: string[]; triggered: boolean } {
  const next = [...window, path].slice(-FILE_ACTION_WINDOW)
  const hits = next.filter((p) => p === path).length
  return { window: next, triggered: hits >= FILE_ACTION_THRESHOLD }
}

/**
 * targetDir 越界判定：路径（相对工作区或绝对）是否落在 targetRoot 之外。
 * 归一化小写正斜杠 + 尾部斜杠去除；targetRoot 本身与其子路径视为在内。
 * 兄弟目录前缀陷阱（vue2-project 与 vue2-project2）通过 '/' 边界排除。
 */
export function isOutsideTargetDir(workspace: string, targetDir: string, p: string): boolean {
  const normT = (s: string) => s.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')
  const abs = isAbsolute(p) ? p : resolve(workspace, p)
  const nA = normT(abs)
  const nT = normT(resolve(workspace, targetDir))
  return nA !== nT && !nA.startsWith(nT + '/')
}

/**
 * 非流式聊天（带工具调用循环）：同样支持路由 + 回退。
 * 返回最终文本内容；过程通过 events 推送。
 * 重构为分层 Agent：S1-S11 动态 Prompt + 上下文压缩 + 持久化笔记 + 内置/MCP 统一工具。
 */
export async function scheduleChatWithTools(
  params: SchedulerChatParams,
  events?: ToolsEvents,
  /** 主任务取消信号：用户点击「停止」时触发，主循环与子代理级联退出 */
  signal?: AbortSignal,
  /** Agent 执行轨迹落盘目录（userData/traces）；不传则不录制 */
  traceDir?: string,
  /** ㊜ 任务控制选项：传入后任务态按轮快照到 <ws>/.trae/tasks/；不传则不持久化 */
  taskControl?: TaskControlOptions,
  /** ㊜ 1b 运行门：支持运行中软暂停/继续/放弃；不传则任务不可暂停 */
  gate?: TaskControlGate
): Promise<{ ok: boolean; content?: string; error?: string; model?: string; blocked?: boolean }> {
  // 工具模式下仍走分类器：模糊指令 → reasoning（解释型模型先分析意图），
  // 终端/代码操作 → completion（代码专精模型）；仅当无法归类时才按 tool 处理
  const classified = classify(params.messages, {
    currentFile: params.currentFile,
    hint: params.taskType
  })
  const taskType: TaskType = classified.task === 'chat' ? 'tool' : classified.task
  const { strippedMessages } = classified
  const role = taskTypeToModelRole(taskType)

  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT
  const tools = await collectTools()
  let lastError = ''

  // 项目层上下文：AGENTS.md + 三级规则 + 持久化笔记（由调度器一次性加载，避免每轮重复读盘）
  const agentsMd = await buildAgentsMd(params.workspace)
  // 三级规则（用户级 → 项目级 → 目录级）合并；currentFile 所在目录作为目录级规则上溯起点
  const rulesText = await buildRulesMd(params.workspace, {
    currentDir: params.currentFile ? dirname(params.currentFile) : null
  })
  let notesText = ''
  if (params.workspace) {
    try {
      const notes = await loadNotes(params.workspace)
      notesText = renderNotes(notes)
    } catch {
      // 笔记加载失败不阻断主流程
    }
  }

  // 环境探测：规划前自动探测本机可用运行时（有缓存则直接复用），
  // 注入到 generatePlan 规划提示词与 runWithTools 系统提示词 S1 层，
  // 让 AI 感知环境，避免在未安装 Python 的机器上盲执行 pip install。
  let environmentReport = ''
  try {
    const envReport = await getEnvironmentReport()
    environmentReport = formatEnvironmentReport(envReport)
  } catch {
    // 探测失败不阻断主流程，environmentReport 留空，S1 层只输出平台基线
  }

  // 技能发现与触发式推荐：合并内置脚手架技能（node/python/go/docker）与工作区自定义，
  // 按用户请求文本匹配 frontmatter triggers；推荐名注入 generatePlan，
  // 让 AI 规划前先 use_skill 加载对应规范而非自由发挥。
  const skillMetas = await listSkills(params.workspace)
  const lastUserText = [...strippedMessages].reverse().find((m) => m.role === 'user')?.content ?? ''
  const recommendedSkillNames = Array.from(recommendSkills(skillMetas, lastUserText))

  // 规划阶段：项目创建请求先用 reasoning 模型生成详细计划
  let plan: string | null = null
  if (tools.length > 0 && isProjectCreation(strippedMessages)) {
    // 启动前清理历史失败运行残留的测试性垃圾文件（example.txt / test.txt 等）
    if (params.workspace) cleanupLeftoverJunk(params.workspace)
    plan = await generatePlan(strippedMessages, params.workspace, events, environmentReport, recommendedSkillNames, signal)
    // 二期：解析 plan 文本末尾的 manifest 代码块，成功则写入会话单例（影响收尾校验）
    if (plan) {
      const manifest = extractManifestFromPlan(plan)
      if (manifest) setValidationManifest(manifest)
    }
  }

  // 阶段二：切换到目标角色（自适应选择 + executor 兜底）
  const sw = await safeSwitch(role, {
    signal,
    onSwitch: (from, to, degraded) => {
      if (degraded) {
        events?.onFallback?.(
          from ?? role,
          to,
          `角色 ${role} 无可用模型，已降级到 ${to} 兜底`
        )
      }
    }
  })
  if (!sw.ok) {
    return { ok: false, error: `没有可用的模型：${sw.error}` }
  }
  const modelName = sw.choice.profile.name
  const provider = getProvider('ollama')
  if (!provider) {
    return { ok: false, error: 'Ollama 供应商未就绪' }
  }
  const modelId = `ollama:${modelName}`

  // 记录本包装器启动时刻：整体成功后用于清理回退过程中残留的中断快照
  const wrapperStart = Date.now()

  // ㊜ 1c 每次尝试一个独立 abort：外部 signal（停止/放弃）与整体超时都汇总到这里，
  // 再透传给底层循环——超时不再只 reject 包装器，底层必须同步退出。
  const attemptAbort = new AbortController()
  const abortFromExternal = () => attemptAbort.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) abortFromExternal()
    signal.addEventListener('abort', abortFromExternal)
  }
  // 先持有底层引用：catch 后必须 await 它真正退出
  let runPromise: Promise<string> | null = null
  try {
    runPromise = runWithTools(
      provider,
      modelName,
      strippedMessages,
      tools,
      events,
      params.workspace,
      plan,
      agentsMd,
      rulesText,
      notesText,
      params.currentFile ?? null,
      attemptAbort.signal,
      traceDir,
      environmentReport,
      taskControl,
      undefined,
      gate
    )
    const content = await withToolsTimeout(
      runPromise,
      timeoutMs * (MAX_TOOL_ROUNDS + 1),
      gate
    )
    // 任务成功：清掉本次包装器期间失败候选留下的中断快照，
    // 避免恢复条出现「实际已被后续模型完成」的脏任务
    if (taskControl) pruneInterruptedSince(taskControl.workspace, wrapperStart)
    return { ok: true, content, model: modelId }
  } catch (err: any) {
    lastError = err?.message || String(err)
    // 物理阻断（关键产物缺失）：任务已被强制终止，不 abort、不切换候选模型，
    // 直接把 blocked 结果交回前端（偏差卡片 + 重试按钮），杜绝换个模型继续盲改
    if (err instanceof TaskBlockedError) {
      return { ok: false, blocked: true, content: err.message, model: modelId }
    }
    // 网络层故障：直接终止（safeSwitch 已在角色层面兜底，无需切换模型）
    if (isNetworkUnreachableError(lastError)) {
      attemptAbort.abort(new TimeoutBudgetError())
      provider.abort?.()
      if (runPromise) {
        try {
          await runPromise
        } catch {
          // 底层结局不影响错误返回
        }
      }
      return { ok: false, error: `${NETWORK_UNREACHABLE_HINT}（最后错误：${lastError}）` }
    }
    // 超时/出错都通知底层：循环在途时让它在最近安全点退出；
    // 以超时为 abort 原因 → 循环落 interrupted 快照（恢复条可续跑）
    attemptAbort.abort(new TimeoutBudgetError())
    provider.abort?.()
    if (runPromise) {
      try {
        await runPromise
      } catch {
        // 底层以 abort/error 收尾，其结局不影响错误返回
      }
    }
    return { ok: false, error: `模型调用失败：${lastError}` }
  } finally {
    signal?.removeEventListener('abort', abortFromExternal)
  }
}

/**
 * ㊜ 断点续跑入口：从任务快照恢复未完成任务。
 * 与 scheduleChatWithTools 的关键差异：
 * - 跳过分类与规划（plan/manifest/用户请求均已在快照内）；
 * - 阶段二之后不再依赖 snapshot.modelId 恢复原模型，统一走 safeSwitch(executor)
 *   让治理层选择当前最优驻留模型；返回真实驻留的模型 id 供前端展示。
 */
export async function scheduleTaskResume(
  snapshot: ParsedTaskSnapshot,
  events?: ToolsEvents,
  signal?: AbortSignal,
  traceDir?: string,
  /** ㊜ 1b 运行门：从恢复条继续的任务同样可暂停/放弃 */
  gate?: TaskControlGate,
  /**
   * s48 「从此步重跑」：显式指定回到的轮次（0 起）。
   * 缺省沿用快照 startRound；传入时与快照可续跑轮次取 min 钳制。
   */
  fromRound?: number
): Promise<{ ok: boolean; content?: string; error?: string; model?: string; blocked?: boolean }> {
  // 阶段二：续跑同样走统一角色调度（工具循环 → executor）
  const sw = await safeSwitch('executor', { signal })
  if (!sw.ok) {
    return { ok: false, error: `续跑模型不可用：${sw.error}` }
  }
  const modelName = sw.choice.profile.name
  const provider = getProvider('ollama')
  if (!provider) {
    return { ok: false, error: 'Ollama 供应商未就绪' }
  }
  const modelId = `ollama:${modelName}`

  const tools = await collectTools()
  const taskControl: TaskControlOptions = {
    workspace: snapshot.workspace,
    sessionId: snapshot.sessionId,
    preTaskCheckpoint: snapshot.preTaskCheckpoint
  }
  // ㊜ 1c 独立 attempt abort：外部 signal 与整体超时汇总后透传给底层
  const attemptAbort = new AbortController()
  const abortFromExternal = () => attemptAbort.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) abortFromExternal()
    signal.addEventListener('abort', abortFromExternal)
  }
  let runPromise: Promise<string> | null = null
  // s48 从此步重跑：覆盖恢复轮次（钳制在 [0, 快照 startRound]，不能跳到尚未执行的轮之后）
  const resumeSnapshot: ParsedTaskSnapshot =
    typeof fromRound === 'number' && Number.isFinite(fromRound)
      ? { ...snapshot, startRound: Math.max(0, Math.min(Math.floor(fromRound), snapshot.startRound)) }
      : snapshot
  try {
    runPromise = runWithTools(
      provider,
      modelName,
      [],
      tools,
      events,
      snapshot.workspace,
      snapshot.ctx.plan ?? null,
      snapshot.ctx.agentsMd ?? null,
      snapshot.ctx.rulesText ?? null,
      snapshot.ctx.notesText ?? '',
      snapshot.ctx.currentFile ?? null,
      attemptAbort.signal,
      traceDir,
      snapshot.ctx.environmentReport ?? '',
      taskControl,
      resumeSnapshot,
      gate
    )
    const content = await withToolsTimeout(
      runPromise,
      DEFAULT_TIMEOUT * (MAX_TOOL_ROUNDS + 1),
      gate
    )
    return { ok: true, content, model: modelId }
  } catch (err: any) {
    // 物理阻断：续跑同样在关键产物缺失时直接终止，交前端偏差卡片 + 重试
    if (err instanceof TaskBlockedError) {
      return { ok: false, blocked: true, content: err.message, model: modelId }
    }
    // 通知底层在安全点退出，等它收尾后再返回错误
    attemptAbort.abort(new TimeoutBudgetError())
    provider.abort?.()
    if (runPromise) {
      try {
        await runPromise
      } catch {
        // 底层结局吞掉，错误以本轮 catch 的 err 为准
      }
    }
    return { ok: false, error: err?.message || String(err) }
  } finally {
    signal?.removeEventListener('abort', abortFromExternal)
  }
}

/**
 * 工具流整体超时（竞态）：总耗时 = 单轮超时 × (最大轮数 + 1)。
 * 1c：超时器绑定 gate——paused 期间冻结预算，resume 后剩余预算继续；
 * 超时 reject 后由调用方 abort 底层循环（见候选循环），本函数不碰 abort。
 */
function withToolsTimeout<T>(promise: Promise<T>, ms: number, gate?: TaskControlGate): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const pt = new PausableTimeout(ms)
    const unbind = gate ? pt.bindGate(gate) : null
    pt.start(() => reject(new TimeoutBudgetError()))
    const settle = () => {
      pt.cancel()
      unbind?.()
    }
    promise.then(
      (v) => {
        settle()
        resolve(v)
      },
      (e) => {
        settle()
        reject(e)
      }
    )
  })
}

/**
 * Agent 循环：每轮重建 S1-S11 分层系统提示词 → 压缩历史 → 调用模型 → 执行工具 → 回填结果。
 * 对话历史累积在 convo（前端锚点 system + 原始 messages + 工具循环增量），
 * 每轮用 compactIfNeeded 压缩中间段，避免挤爆上下文窗口。
 * 工具调用兼容内置（read/write/edit/bash/grep/glob）与 MCP（write_file/run_terminal_command 等）。
 */

/**
 * s50 变更工具的锁目标：write/edit/delete 等变更类工具且路径落在工作区内 → 绝对路径；
 * 只读工具、缺路径或越界路径返回 null（无需取锁）。
 */
function mutationLockTarget(workspace: string | null, name: string, args: unknown): string | null {
  if (!workspace) return null
  const analyzed = classifyMutationTool(name, (args ?? {}) as Record<string, unknown>)
  if (!analyzed?.ok) return null
  const target = isAbsolute(analyzed.call.path) ? analyzed.call.path : resolve(workspace, analyzed.call.path)
  const root = resolve(workspace)
  return target === root || target.startsWith(root + sep) ? target : null
}

async function runWithTools(
  provider: NonNullable<ReturnType<typeof getProvider>>,
  modelName: string,
  messages: AiMessage[],
  tools: { server: string; tool: any }[],
  events?: ToolsEvents,
  workspace?: string | null,
  plan?: string | null,
  agentsMd: string | null = null,
  rulesText: string | null = null,
  notesText: string = '',
  currentFile: string | null = null,
  /** 主任务取消信号：逐轮检查，触发后退出主循环（子代理经 dispatch 透传级联中止） */
  signal?: AbortSignal,
  /** Agent 执行轨迹落盘目录；不传则不录制 */
  traceDir?: string,
  /** 环境探测摘要（formatEnvironmentReport 产出）：注入系统提示词 S1 层 */
  environmentReport: string = '',
  /** ㊜ 任务控制选项：传入后任务态按轮原子快照 */
  taskControl?: TaskControlOptions,
  /** ㊜ 断点恢复快照：传入时跳过初始建清单，从快照轮次与状态继续 */
  restore?: ParsedTaskSnapshot,
  /** ㊜ 1b 运行门：软暂停在安全点挂起本循环；不传则不可暂停 */
  gate?: TaskControlGate
): Promise<string> {
  // ===== 三模型模式检测 =====
  // 显存 14.4GB 约束下，PLANNER(14B)/EXECUTOR(8B)/CODER 分时复用。
  // 检测方式：Ollama 可用模型清单中同时存在三个角色模型。
  const cachedModels = getCachedModels()
  const threeModelMode = isThreeModelMode(
    cachedModels.filter((m) => m.available).map((m) => m.id)
  )
  if (threeModelMode) {
    // 三模型模式：先切到 Planner 生成 DAG，再切回 Executor 执行
    const userText = [...messages].reverse().find((m) => m.role === 'user')?.content ?? ''
    const profile = detectProfileFromText(userText)
    const dagResult = await generateDagPlan(messages, workspace, events, environmentReport, undefined, signal, profile)
    if (dagResult.ok) {
      // DAG 驱动模式：用 DAG 替代现有 plan 文本，进入 DAG 执行循环
      return runWithDag(
        provider, modelName, messages, tools, events, workspace, dagResult.dag,
        dagResult.targetDir, agentsMd, rulesText, notesText, currentFile, signal,
        traceDir, environmentReport, taskControl, gate
      )
    }
    // DAG 生成失败：降级到现有 plan 文本模式（generatePlan 已在下方调用）
    events?.onFallback?.('dag', 'plan-text', 'DAG 生成失败，回退到文本计划')
  }

  // ===== 运行时协调工具（todo_write / dispatch_subagents / list_skills / use_skill）=====
  // 这些工具带本次运行的闭包状态（TODO 清单、技能目录），不经过 MCP 层。
  const todoStore = new TodoStore()
  // 内置脚手架技能不依赖工作区（无工作区也返回内置四个）；工作区同名技能覆盖内置
  const skills = await listSkills(workspace)
  // 本轮请求的推荐技能集合：renderSkillList 加 ⭐，引导 Agent 先加载匹配技能
  const recommendedSet = recommendSkills(
    skills,
    [...messages].reverse().find((m) => m.role === 'user')?.content ?? ''
  )
  const runtimeTools: McpToolEntry[] = [
    {
      server: 'runtime',
      tool: {
        name: 'todo_write',
        description:
          '任务规划与状态跟踪。action：add（新增，可用 todos 数组批量建立清单，每项含 content/priority/status）、' +
          'update（更新，需 id 和 status：pending/in_progress/completed）、list（查看）、clear（清空）。复杂任务开始前必须先建立清单。',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['add', 'update', 'list', 'clear'] },
            todos: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  content: { type: 'string' },
                  priority: { type: 'string', enum: ['high', 'medium', 'low'] },
                  status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] }
                }
              }
            },
            content: { type: 'string', description: '单条新增的任务内容' },
            priority: { type: 'string', enum: ['high', 'medium', 'low'] },
            id: { type: 'number', description: 'update 时指定任务 id' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] }
          }
        }
      }
    },
    {
      server: 'runtime',
      tool: {
        name: 'dispatch_subagents',
        description:
          '把子任务派发给多个子代理执行（各自独立上下文与工具集），等待全部结束后返回汇总结果。' +
          '参数 tasks 为数组，每项：description（子任务目标与约束）、tools（可选工具名白名单）、' +
          'role（可选预设角色 frontend/backend/test：前端/后端/测试，各有独立工具白名单与职责边界）、' +
          'dependsOn（可选，依赖的前驱任务下标数组，0 起；无依赖的子任务自动并行，有依赖的等前驱完成）、' +
          'timeoutMs（可选，单任务超时毫秒数，默认 300000）。单次最多 4 个。',
        inputSchema: {
          type: 'object',
          properties: {
            tasks: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  description: { type: 'string' },
                  tools: { type: 'array', items: { type: 'string' } },
                  role: { type: 'string', enum: ['frontend', 'backend', 'test'] },
                  dependsOn: { type: 'array', items: { type: 'number' } },
                  timeoutMs: { type: 'number' }
                },
                required: ['description']
              }
            }
          },
          required: ['tasks']
        }
      }
    },
    {
      server: 'runtime',
      tool: {
        name: 'list_skills',
        description: '列出工作区可用的技能包（名字 + 一句话描述）。需要某技能详细内容时再调用 use_skill。',
        inputSchema: { type: 'object', properties: {} }
      }
    },
    {
      server: 'runtime',
      tool: {
        name: 'use_skill',
        description: '按名称加载技能包全文（领域知识渐进加载，避免凭空猜测 API/规范）。参数：name。',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name']
        }
      }
    }
  ]
  // 全量工具池 = 运行时协调工具 + 内置/MCP 工具
  const allTools: McpToolEntry[] = [...runtimeTools, ...tools]
  const runtimeNames = new Set(runtimeTools.map((t) => t.tool.name))
  // 权限关卡：所有文件/命令类工具执行前统一过闸（运行时协调工具不经过此关）。
  // 无前端审批回调时按拒绝处理，避免无 UI 场景下静默执行。
  // askUser 同时供交互式命令审批使用（复用现有审批条通道，不新造弹窗）。
  const askUser = (req: PermissionRequest): Promise<UserPermissionResponse> =>
    events?.onPermissionRequest?.(req) ??
    Promise.resolve({ decision: 'deny' as const, reason: '无审批通道' })
  const permissionGate = new PermissionGate(workspace, askUser)
  // 协调工具执行器（闭包持有本次运行状态）
  const runners: Record<string, (args: any) => Promise<string>> = {
    todo_write: async (args: TodoWriteArgs) => {
      const result = todoStore.handle(args)
      ctx.todosText = todoStore.render()
      events?.onTodo?.(todoStore.items)
      return result
    },
    list_skills: async () =>
      renderSkillList(skills, recommendedSet) || '暂无可用技能包（可在工作区 .trae/skills/ 目录放置 .md 技能文件）',
    use_skill: async (args) => {
      const name = String(args?.name || '')
      if (!skills.some((s) => s.name === name)) {
        return `错误：未知技能 ${name}，先调用 list_skills 查看可用技能`
      }
      return loadSkill(workspace, name)
    },
    dispatch_subagents: async (args) => {
      const subTasks = Array.isArray(args?.tasks) ? (args.tasks as SubTaskSpec[]) : []
      return runSubagents({
        provider,
        modelName,
        tasks: subTasks,
        parentTools: tools,
        workspace,
        agentsMd,
        rulesText,
        notesText,
        currentFile,
        events,
        // 子代理的工具调用必须经过同一个权限关卡，防止子任务成为越权通道
        gate: permissionGate,
        // 主任务取消信号级联透传：用户停止时运行中子代理逐轮退出
        signal,
        // s50 全部子代理共用全局写锁表；执行后由汇总 Agent 裁决冲突/合并验收
        lockTable: getGlobalFileLockTable(),
        withSummary: true
      })
    }
  }

  const ollamaTools = allTools.map((t) => ({
    type: 'function',
    function: {
      name: t.tool.name,
      description: t.tool.description || '',
      parameters: t.tool.inputSchema ?? { type: 'object', properties: {} }
    }
  }))

  // Agent 上下文：每轮重建系统提示词时传入，反映最新进度
  const ctx: PromptContext = {
    workspace,
    currentFile,
    plan,
    isProjectCreation: !!plan || isProjectCreation(messages),
    createdFiles: new Set<string>(),
    ranNpmInstall: false,
    ranServe: false,
    ranMkdir: false,
    round: 0,
    stallRestarts: 0,
    agentsMd,
    rulesText,
    notesText,
    mcpServers: listMcpServers(),
    skillsText: renderSkillList(skills, recommendedSet),
    todosText: '',
    tools: allTools.map((t) => ({ name: t.tool.name, description: t.tool.description })),
    // 二期：从会话单例取 generatePlan 注入的 manifest（前端 setCurrent 也可覆盖，下次任务生效）
    artifactManifest: currentTaskManifest,
    // 环境探测摘要：注入 S1 运行环境层，让 AI 感知本机可用运行时
    environmentReport
  }
  // 暴露当前 ctx 引用给 IPC getCurrent（createdFiles 共享同一 Set，实时反映进度）
  currentTaskCtx = ctx

  // s43 任务开始装载 spec 锚点：注入提示词层（S5 spec 锚点）+ 运行期拦截缓存。
  // 坏文件/缺文件一律降级空锚点，不阻断任务启动。
  let anchorsCache: AnchorsFile = {}
  if (workspace) {
    try {
      anchorsCache = await loadAnchors(workspace)
      const block = formatAnchorBlock(anchorsCache)
      if (block) ctx.anchorsText = block
    } catch {
      anchorsCache = {}
    }
  }
  ctx.anchorViolations = []

  // s42 影响分析的引用计数回调：全仓词边界搜索（rg 不可用时按 0 处理，不误报）
  const countSymbolRefs = async (symbol: string): Promise<number> => {
    if (!workspace) return 0
    try {
      const search = await runContentSearch(workspace, {
        query: symbolPattern(symbol),
        caseSensitive: true,
        wholeWord: false,
        regexMode: true,
        includes: [],
        excludes: []
      })
      let n = 0
      for (const g of search.groups) n += g.matches.length
      return n
    } catch {
      return 0
    }
  }
  // 影响分析仅对源码扩展名生效（json/md 等不做符号对比）
  const IMPACT_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.py'])

  // 项目创建场景：自动建立 Todo 清单，让模型和前端都能可视化任务进度，
  // 避免跳过规划阶段直接乱写文件。清单与 S7 执行协议保持一致。
  // restore 恢复模式跳过——清单由快照 hydrate 还原，重复建立会撞 id 且丢失真实进度。
  if (ctx.isProjectCreation && !restore) {
    const autoTodos: TodoWriteArgs = {
      action: 'add',
      todos: [
        { content: '创建项目文件夹（如 vue2-project/）', priority: 'high', status: 'pending' },
        { content: '创建 package.json（声明 vue@2.6.14、vue-router@3.5.1、vuex@3.6.2 等依赖）', priority: 'high', status: 'pending' },
        { content: '创建 babel.config.js、vue.config.js、public/index.html', priority: 'high', status: 'pending' },
        { content: '创建 src/main.js（Vue 2 API：new Vue）、src/App.vue', priority: 'high', status: 'pending' },
        { content: '创建 src/router/index.js（new VueRouter）、src/store/index.js（new Vuex.Store）', priority: 'high', status: 'pending' },
        { content: '创建 src/components/HelloWorld.vue、README.md', priority: 'medium', status: 'pending' },
        { content: 'bash 执行 npm install 安装依赖', priority: 'high', status: 'pending' },
        { content: 'bash 执行 npm run serve 验证项目可运行', priority: 'high', status: 'pending' }
      ]
    }
    todoStore.handle(autoTodos)
    ctx.todosText = todoStore.render()
    // 推送到前端显示
    events?.onTodo?.(todoStore.items)
  }

  // 对话历史：前端锚点 system + 原始 messages 全部保留，工具循环的增量也追加到此。
  // restore 恢复模式：convo 完整内容以快照为准（含此前注入的验证/重规划消息）。
  let convo = restore ? [...restore.convo] : [...messages]
  // 小模型摘要器：达到上下文阈值时用同一模型压缩历史，保留 system+首条user+最近4轮
  const summarize: Summarizer = async (text) => {
    try {
      const res = await provider.chat({
        messages: [{
          role: 'user',
          content: `请用一段纯中文摘要以下对话的关键信息和已完成的工作，保留文件路径、命令和结果要点：\n\n${text}`
        }],
        signal
      })
      trackChatUsage(`${provider.id}:${modelName}`, res.usage, text, res.content || '')
      return res.ok ? (res.content ?? null) : null
    } catch {
      return null
    }
  }
  let lastContent = ''
  // 跨轮去重表：同一工具+参数成功过则拦截，避免 7B 模型空转耗尽轮次
  const executed = new Map<string, string>()
  // 读取黑名单：read/list_directory 已确认「不存在」的路径（归一化小写正斜杠）。
  // 命中黑名单的读取在执行前直接拦截，强制模型改用 write_file 创建；write 成功后移除。
  const failedReadPaths = new Set<string>()
  let stallCount = 0
  let stallRestarts = 0
  // 连续"全轮 dedup 无进展"计数：达到阈值时触发验证锁或直接收尾
  let dedupStallCount = 0

  // 动态重规划状态：连续命令失败/门控拦截/验证 block ≥2 时触发 Self-Reflection，
  // 上限 2 次（replanner.ts），超限回退下方 stall/停滞重启机制。
  const replanState = createReplanState()
  // 同文件连续 edit 修补防抖：对同一 path 连续成功 edit 计数（read/grep 等只读动作不打断），
  // 第 3 次直接拦截并强制中断批次 → 重规划；转向写其他文件或执行命令时清零。
  let editStreak: { path: string; count: number } | null = null
  // 本轮工具批次是否被「中途偏差/防抖」强制中断：中断后跳过批次内剩余调用，轮末立即重规划
  let batchInterrupted = false
  // 物理阻断漂移报告：planDrift hasBlock 一旦确认即彻底终止工具循环（不再自动重规划/续跑/换模型）
  let blockedDrift: DriftReport | null = null
  // 中断时确认缺失的关键产物明细（透传给重规划提示词与 sanitize 门控）
  let pendingMissingArtifacts: string[] = []
  // 强制恢复铁律：用户在物理阻断后点「重试任务」（消息带 FORCED-RECOVERY 标记）。
  // write-only→install→done 分阶段白名单，旧文件视为污染状态，首阶段只准 write_file。
  // 仅项目创建任务启用（三阶段是脚手架地基问题）；其他任务标记命中时直接视为铁律解除。
  const recoveryTagged = hasForcedRecoveryTag(restore ? restore.convo : messages)
  let recoveryPhase: RecoveryPhase | null = recoveryTagged
    ? (ctx.isProjectCreation ? 'write-only' : 'done')
    : null
  // 原始用户请求：Self-Reflection 重规划打包用。
  // 恢复模式不能取 messages（为空），直接用快照记录的请求摘要。
  const userRequestText = restore
    ? restore.userRequest
    : [...messages].reverse().find((m) => m.role === 'user')?.content ?? ''

  // 项目画像绑定：按用户请求文本识别生态（vue/react/python/go/rust/docker…），
  // 门控顺序锁、重规划话术、S8 执行纪律共用同一画像数据源（替代 if (isVue) 式硬编码）。
  ctx.projectProfile = detectProfileFromText(userRequestText)
  ctx.projectProfileText = formatProfileDiscipline(ctx.projectProfile) || undefined

  // targetDir 工作区限定：plan 显式输出 targetDir 或全部文件路径共享同一顶层子目录时，
  // 项目根目录被限定到该子目录——防止 AI 在工作区根与子目录间反复横跳造成路径污染。
  if (ctx.isProjectCreation && !ctx.targetDir) {
    const td = extractTargetDirFromPlan(ctx.plan ?? null)
    if (td) ctx.targetDir = td
  }
  // 文件动作防抖窗口（同文件 read/write/edit 混排死循环检测）：最近 6 次动作中同路径 ≥3 次触发强制重启
  let fileActionWindow: string[] = []
  // 同命令防抖：60 秒窗口内同命令执行 2 次后，第 3 次直接拦截（防止 npm run dev 秒退死循环）
  const commandHistory = new Map<string, number[]>()

  // Agent 执行轨迹录制：traceDir 传入时记录每轮模型/工具调用与耗时，结束后落盘
  const log = getLogger('scheduler')
  // 恢复模式沿用原 taskId（同任务续跑，快照文件路径不变）；否则新生成
  const taskId = restore
    ? restore.taskId
    : `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const startedAt = restore ? restore.startedAt : Date.now()
  const tracer = traceDir
    ? new TraceRecorder(taskId, modelName, workspace, currentFile, ctx.isProjectCreation)
    : null
  log.info(`Agent 任务启动 taskId=${taskId} model=${modelName} workspace=${workspace ?? '(none)'}`)
  // ㊜ 1b 任务启动事件：前端据此建立 live 任务态（携带检查点供放弃时回滚勾选）
  events?.onTaskControl?.({
    taskId,
    phase: 'started',
    preTaskCheckpoint: taskControl?.preTaskCheckpoint ?? null
  })

  // ===== ㊜ 断点恢复：把快照状态灌回闭包活对象 =====
  if (restore) {
    // ctx 就地覆盖而非替换引用：currentTaskCtx 已指向旧 ctx（L698），换引用会让 IPC getCurrent 失联
    Object.assign(ctx, restore.ctx)
    todoStore.hydrate(restore.todoSeq, restore.todos)
    ctx.todosText = todoStore.render()
    for (const [k, v] of restore.executed) executed.set(k, v)
    stallCount = restore.counters.stallCount
    stallRestarts = restore.counters.stallRestarts
    dedupStallCount = restore.counters.dedupStallCount
    Object.assign(replanState, restore.replan)
    // ㊝ 快照里的未决暂存写回 holder（pending.json 与快照取并集，快照优先）
    if (restore.stagedChanges) {
      await restoreStageSnapshot(restore.workspace, restore.stagedChanges)
      events?.onStagingChanged?.()
    }
    // 子代理中途崩溃不做续跑：原 dispatch_subagents 结果已丢，注入工具错误让模型按需重新派发
    const lastMsg = convo[convo.length - 1]
    if (lastMsg?.role === 'assistant' && /dispatch_subagents/.test(JSON.stringify(lastMsg))) {
      convo.push({
        role: 'tool',
        name: 'dispatch_subagents',
        content: '错误：子代理执行因进程中断未完成，派发结果丢失。请检查已完成部分后按需重新派发。'
      } as AiMessage)
    }
    // 恢复后先推一次清单与进度，让前端立刻重建 TODO 面板
    events?.onTodo?.(todoStore.items)
  }

  /**
   * 当前轮次（与 for 循环内 round 同步）：persist 在循环外定义、
   * 引用不到 for 块内的 round，故用外层变量桥接。
   */
  let currentRound = restore ? restore.startRound : 0

  // ===== s48 执行时间线：包装事件桥，录制每个工具调用的开始/结果 =====
  // 必须在所有事件引用点（runners/askUser 闭包在调用时读 events 绑定）之前重绑；
  // AI 自述理由从 convo 最近一条 assistant 消息提取（此包装与 convo 同闭包）。
  const timeline: TimelineState = createTimeline()
  const innerEvents = events
  const emitTimeline = (): void => {
    innerEvents?.onTimeline?.({ taskId, steps: serializeTimeline(timeline) })
  }
  events = {
    ...innerEvents,
    onToolCall: (name, args) => {
      // AI 自述理由取最近一条 assistant 文本；纯工具调用文本为空时回退为调用简述
      const assistantText = [...convo].reverse().find((m) => m.role === 'assistant')?.content
      const reason = (typeof assistantText === 'string' ? assistantText : '') || argsBriefOf(name, args)
      tlStart(timeline, { round: currentRound, name, args, reason })
      innerEvents?.onToolCall?.(name, args)
      emitTimeline()
    },
    onToolResult: (name, result) => {
      tlFinish(timeline, name, result)
      innerEvents?.onToolResult?.(name, result)
      emitTimeline()
    }
  }

  /**
   * 持久化任务快照：收集当前闭包活对象 → 纯函数序列化 → 原子写盘。
   * IO/序列化失败仅告警，绝不能让持久化问题中断任务本身。
   */
  const persist = (status: TaskStatus): void => {
    if (!taskControl) return
    // ㊝ takeStageSnapshot 是异步 IO，persist 本身保持 fire-and-forget（调用方不 await），
    // 用 IIFE 收集暂存后再同步组装落盘；任何失败仅告警，绝不中断任务。
    void (async (): Promise<void> => {
      const stagedChanges = await takeStageSnapshot(taskControl.workspace)
      const snapshot = buildTaskSnapshot(
        {
          taskId,
          workspace: taskControl.workspace,
          modelId: `${provider.id}:${modelName}`,
          sessionId: taskControl.sessionId,
          startRound: currentRound + 1,
          convo,
          ctx,
          todoSeq: todoStore.getSeq(),
          todos: todoStore.items,
          replan: replanState,
          executed,
          counters: { stallCount, stallRestarts, dedupStallCount },
          preTaskCheckpoint: taskControl.preTaskCheckpoint,
          stagedChanges,
          startedAt
        },
        { status, updatedAt: Date.now() }
      )
      saveTaskSnapshot(taskControl.workspace, snapshot)
    })().catch((e) => {
      log.warn(`任务快照写入失败 taskId=${taskId}: ${e instanceof Error ? e.message : String(e)}`)
    })
  }

  // ㊜ 1b 运行门相位变化 → 落盘 paused 快照 + 推 UI 事件。
  // 挂起发生在 parkIfPausing 内部（同步切 paused），此时快照必须立刻落盘，
  // 否则挂起期间崩溃会丢"已暂停"语义。
  // 1c 起改用 addChangeListener（超时器也同时订阅门相位）。
  if (gate) {
    gate.addChangeListener((phase) => {
      if (phase === 'paused') {
        persist('paused')
        events?.onTaskControl?.({ taskId, phase: 'paused' })
      } else if (phase === 'running') {
        events?.onTaskControl?.({ taskId, phase: 'running' })
      }
    })
  }

  /**
   * ㊜ 1c abort 统一收尾（轮首 / 批次结束共用）：
   * 按 signal.reason 区分「整体超时」→ interrupted 快照（恢复条可续跑）
   * 与「用户主动停止」→ aborted；返回对应提示文案。
   */
  const finishByAbort = (): string => {
    const byTimeout = (signal as { reason?: { name?: string } } | undefined)?.reason?.name === 'TimeoutError'
    tracer?.finish('aborted', lastContent)
    if (tracer && traceDir) saveTrace(traceDir, tracer.snapshot())
    persist(byTimeout ? 'interrupted' : 'aborted')
    const note = byTimeout ? '（任务执行超时）' : '（任务已被用户中止）'
    return (lastContent.trim() ? lastContent.trim() + '\n\n' : '') + note
  }

  /**
   * 物理阻断收尾：planDrift hasBlock 后直接终止整个工具循环——
   * 不再自动重规划、不再让模型「再试一轮」、不切换候选模型。
   * 落 interrupted 快照（恢复条可见），返回醒目阻断文案，前端只留「重试任务 / 查看偏差报告」。
   */
  const finishBlocked = (drift: DriftReport): never => {
    tracer?.finish('aborted', lastContent)
    if (tracer && traceDir) saveTrace(traceDir, tracer.snapshot())
    persist('interrupted')
    const head =
      '⛔ 任务已被系统强制中断：检测到关键产物缺失，继续执行只会在错误的地基上打补丁。\n' +
      '请点击「重试任务」按固定流程补齐（write_file 生成缺失基础文件 → npm install → 运行验证），或查看偏差报告。\n' +
      formatDriftReport(drift)
    // 抛 TaskBlockedError：外层候选循环据此返回 blocked:true（不换模型、不当成功、不推 ✅）。
    // 完整文案随 error.message 回到前端写入气泡。
    throw new TaskBlockedError(
      drift,
      (lastContent.trim() ? lastContent.trim() + '\n\n' : '') + head
    )
  }

  try {
  // 恢复模式从快照轮次继续；否则从 0 开始
  const restoreStart = restore ? restore.startRound : 0
  for (let round = restoreStart; round < MAX_TOOL_ROUNDS; round++) {
    currentRound = round
    // ㊜ 1b 轮首安全点：暂停请求已到时挂起，直到继续/放弃；1c 起传入 signal，abort 可抢先
    await gate?.parkIfPausing(signal)
    // 取消传播检查点：用户停止/整体超时后，主循环在模型调用前退出
    if (signal?.aborted) {
      return finishByAbort()
    }
    tracer?.beginRound(round)
    // 每轮重建系统提示词：S1-S11 分层按当前进度动态组装
    ctx.round = round
    ctx.stallRestarts = stallRestarts
    // 顺序锁：把第一个未完成任务注入 S11，强制模型按清单顺序执行
    const cur = ctx.isProjectCreation ? todoStore.nextIncomplete() : null
    ctx.currentTodo = cur ? `#${cur.id} ${cur.content}` : null
    // ㊝ 审阅开启时每轮注入行为须知（关闭/无工作区置 null，S 层自动跳过）
    ctx.stageNoticeText = workspace && (await isStageEnabled(workspace)) ? getStageNotice() : null
    const agentSystem: AiMessage = { role: 'system', content: buildAgentPrompt(ctx) }
    // 上下文压缩（token 驱动）：按当前模型窗口动态算历史预算——
    // 窗口×75% − 本轮 S1-S11 系统提示 token − 输出预留 1024，下限 2048
    const historyBudget = computeHistoryBudget(
      resolveCapabilities(modelName).contextWindow,
      estimateTokensText(agentSystem.content)
    )
    const compacted = await compactIfNeeded(convo, summarize, { historyBudgetTokens: historyBudget })
    const current: AiMessage[] = [agentSystem, ...compacted]

    events?.onModelCall?.(modelName, round === 0 ? '执行' : `第${round + 1}轮`)
    const res = await provider.chat({
      messages: current,
      tools: ollamaTools.length > 0 ? ollamaTools : undefined,
      signal
    })
    // 用户停止/整体超时：provider 返回「已中止」，按中止路径收尾（不抛错、不走回退）
    if (!res.ok && (signal?.aborted || res.error === '已中止')) {
      return finishByAbort()
    }
    if (!res.ok) throw new Error(res.error || '模型调用失败')
    trackChatUsage(
      `${provider.id}:${modelName}`,
      res.usage,
      current.map((m) => m.content).join('\n'),
      res.content || ''
    )
    // 记录本轮模型调用：耗时 + token 用量 + 系统提示词长度
    tracer?.recordModelCall(round, agentSystem.content.length, res.usage as any)
    log.debug(`第${round + 1}轮模型调用完成 toolCalls=${(res.toolCalls?.length ?? 0)}`)
    lastContent = res.content || ''

    // 结构化 tool_calls 优先；为空时兜底解析 content 中的 JSON 工具调用。
    // 部分模型（如 qwen2.5-coder）会把 {"name":..., "arguments":...} 当普通文本输出，
    // 甚至一条消息里按行输出多个调用（NDJSON）。
    let toolCalls = (res.toolCalls as any[]) ?? []
    if (toolCalls.length === 0) {
      const parsed = parseToolCallsFromContent(lastContent, allTools)
      if (parsed.length > 0) {
        toolCalls = parsed
        lastContent = '' // JSON 不是给用户看的答案，清掉避免误显示
      }
    }
    // 同批次去重：模型常在一条消息里输出同一文件的多个微调版本，按 name+path 只保留最后一个
    toolCalls = dedupeBatchCalls(toolCalls)
    if (toolCalls.length === 0) {
      if (!ctx.isProjectCreation) {
        // 通用任务：调用过工具后输出纯文本视为正常收尾；
        // 首轮就光说不做则推进一次，连续两轮仍不调用则按纯问答交付
        if (executed.size > 0) break
        stallCount++
        convo.push({ role: 'assistant', content: lastContent } as AiMessage)
        if (stallCount >= 2) break
        convo.push({
          role: 'user',
          content:
            '请立即调用工具完成任务（read/write/edit/bash/grep/glob/todo_write/dispatch_subagents 等）；' +
            '若该任务无需工具即可回答，请直接给出完整答案，不要只描述计划。'
        } as AiMessage)
        continue
      }
      // 项目创建类任务：模型输出纯文本但未调用工具，先过验证锁再决定是否允许收尾。
      // 验证锁（硬约束）：关键产物缺失时禁止输出"任务完成"，强制注入继续消息。
      const validationMsg = validateTaskCompletion(ctx)
      if (validationMsg) {
        // 信号：验证锁拦截（连续 ≥2 次将触发 Self-Reflection 重规划）
        noteFailure(replanState, 'validationBlock', validationMsg)
        stallCount++
        convo.push({ role: 'assistant', content: lastContent } as AiMessage)
        convo.push({ role: 'user', content: validationMsg } as AiMessage)
        // 连续 5 轮验证未通过或耗尽轮次：尝试停滞重启，仍不行则放弃
        if (stallCount >= 5 || round + 1 >= MAX_TOOL_ROUNDS) {
          if (stallRestarts < 3 && round + 1 < MAX_TOOL_ROUNDS) {
            stallRestarts++
            stallCount = 0
            const fileList = ctx.createdFiles.size > 0
              ? `已创建文件（${ctx.createdFiles.size}个）：${Array.from(ctx.createdFiles).join('、')}`
              : '尚未创建任何文件'
            convo.push({
              role: 'user',
              content:
                `⚠ 停滞重启（第${stallRestarts}次）。${fileList}。\n` +
                validationMsg + '\n' +
                '请立即调用工具完成上述缺失步骤，禁止输出纯文字描述！'
            } as AiMessage)
            continue
          }
          lastContent += '\n\n⚠️ 任务未完成：验证锁未通过，关键文件缺失或 npm 验证未执行。'
          break
        }
        continue
      }
      // 验证通过（package.json + main.js + App.vue 存在 + npm install + npm run serve 均已执行），允许正常收尾
      noteSuccess(replanState)
      stallCount++
      if (stallCount >= 2) break
      convo.push({ role: 'assistant', content: lastContent } as AiMessage)
      convo.push({
        role: 'user',
        content: '验证已通过：所有关键文件已创建，npm install 与 npm run serve 均已执行。请用纯文本总结项目创建和验证结果。'
      } as AiMessage)
      continue
    }
    stallCount = 0
    // 本轮 dedup 命中次数：若全部工具调用都被拦截，说明模型在空转
    let dedupHits = 0
    // 每轮重置批次中断标记（上一轮的中断已在轮末完成重规划/指令注入）
    batchInterrupted = false

    // 中途偏差检测：项目创建场景且已有产物时，用当前 manifest（缺省回退 vue 脚手架）跑漂移检测，
    // 仅关注 block（关键产物缺失）。任务初期文件未齐是正常状态，本函数只在「越序动作点」被调用，
    // 不会在正常创建文件阶段误触发。
    const detectMidRunBlock = (): DriftReport | null => {
      if (!ctx.isProjectCreation || ctx.createdFiles.size === 0) return null
      const manifest = ctx.artifactManifest ?? vueScaffoldManifest
      const drift = detectPlanDrift({
        todos: todoStore.items,
        createdFiles: ctx.createdFiles,
        manifest,
        plan: ctx.plan ?? null
      })
      return drift.hasBlock ? drift : null
    }
    // 物理阻断：注入系统指令 + 推送偏差卡片事件 + 记验证失败信号，并置 blockedDrift。
    // 批次循环结束后直接 finishBlocked 终止整个任务——不再自动重规划或「再自修一轮」。
    // 返回 true 表示已阻断（调用方应 break 批次循环）。
    const interruptBatchForDrift = (): boolean => {
      const drift = detectMidRunBlock()
      if (!drift) return false
      pendingMissingArtifacts = drift.items
        .filter((i) => i.kind === 'missingArtifact')
        .map((i) => i.detail)
      const interruptMsg =
        '⛔ 检测到关键产物缺失，模型执行已偏离计划。已强制中断当前任务，请检查偏差报告并重试。\n' +
        '立即停止修补残缺文件与盲目重试：第一步先用 write_file 完整生成缺失的基础文件（package.json、babel.config.js 等），' +
        '第二步执行 npm install 安装依赖并确认成功，第三步才允许运行/验证。\n' +
        formatDriftReport(drift)
      noteFailure(replanState, 'validationBlock', `关键产物缺失：${pendingMissingArtifacts.join('；')}`)
      convo.push({ role: 'user', content: interruptMsg } as AiMessage)
      events?.onPlanDrift?.({ ...drift, interrupted: true })
      batchInterrupted = true
      blockedDrift = drift
      return true
    }

    // 强制恢复铁律阶段推进（每轮批次开始前按真实产物状态判定）：
    // - write-only：manifest 已无缺失产物 → 进入 install；
    // - install：已成功执行 npm install → done（解除铁律，交验证锁收尾）。
    if (recoveryPhase === 'write-only' && ctx.createdFiles.size > 0 && !detectMidRunBlock()) {
      recoveryPhase = 'install'
      convo.push({
        role: 'user',
        content:
          '✅ 恢复铁律第 1 阶段完成：缺失基础文件已补齐。现在进入第 2 阶段：' +
          '只允许调用 run_terminal_command 执行 npm install（禁止任何运行/构建命令），安装成功后再进入验证阶段。'
      } as AiMessage)
    } else if (recoveryPhase === 'install' && ctx.ranNpmInstall) {
      recoveryPhase = 'done'
      convo.push({
        role: 'user',
        content:
          '✅ 恢复铁律第 2 阶段完成：依赖安装成功。现在进入第 3 阶段运行/验证（npm run serve/build），验证通过后总结交付。'
      } as AiMessage)
    }

    convo.push({ role: 'assistant', content: lastContent } as AiMessage)
    for (const tc of toolCalls) {
      // ㊜ 1b 批次内安全点：相邻工具调用之间可挂起（批次内已开始的工具不打断）；
      // 1c 起传入 signal，超时/停止在暂停请求之后到达时也能阻止挂起
      await gate?.parkIfPausing(signal)
      // 取消传播检查点：中止信号到达后不再发起新的副作用工具调用
      if (signal?.aborted) break
      const name = tc.function?.name
      const rawArgs = tc.function?.arguments
      // 安全解析：模型偶发输出非法 JSON 时不中断整个循环
      let parsedArgs: any
      try {
        parsedArgs = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs
      } catch {
        parsedArgs = {}
      }
      const args = coerceToolArgs(parsedArgs, workspace)
      // 命令文本（npm install/serve 追踪与 bash 门控使用；成功与否在执行后判定）
      const cmd = typeof args?.command === 'string' ? args.command : ''

      // 文件动作防抖：同文件 read/write/edit 混排死循环（写→读→查目录→写→读）检测。
      // 窗口内同路径 ≥3 次 → 清空工具执行历史 + 强制重启重规划，防止 AI 在污染状态上打补丁。
      {
        const faPath = fileActionPath(name ?? '', args)
        if (faPath) {
          const tracked = trackFileAction(fileActionWindow, faPath)
          fileActionWindow = tracked.window
          if (tracked.triggered) {
            const block =
              `错误：检测到对 ${faPath} 的无效重复操作（最近 ${tracked.window.length} 次文件动作中 ${tracked.window.filter((p) => p === faPath).length} 次指向它），` +
              '判定为「写 → 读 → 查目录 → 写」死循环，已强制中断。'
            noteFailure(replanState, 'preflightBlock', block)
            events?.onToolCall?.(name, args)
            convo.push({ role: 'tool', content: block, name } as AiMessage)
            events?.onToolResult?.(name, block)
            // 清空工具执行历史（dedup/writePath 记录），重规划后在干净画布上重新执行
            executed.clear()
            fileActionWindow = []
            convo.push({
              role: 'user',
              content:
                `⛔ 检测到对 ${faPath} 的无效重复操作。任务已强制重启。` +
                '请检查当前工作区文件列表，清理冲突文件（根目录与子目录重复问题），重新制定明确的单步计划。'
            } as AiMessage)
            batchInterrupted = true
            break
          }
        }
      }

      // ===== 工具守卫：禁止文件 / 禁止命令 / 同命令防抖 =====
      const toolPath = String(args?.path ?? '').replace(/\\/g, '/').toLowerCase()
      const toolCmd = String(args?.command ?? '')

      const fileBlock = checkForbiddenFile(name, toolPath)
      if (fileBlock) {
        noteFailure(replanState, 'preflightBlock', fileBlock)
        convo.push({ role: 'tool', content: fileBlock, name } as AiMessage)
        events?.onToolResult?.(name, fileBlock)
        continue
      }

      const cmdBlock = checkForbiddenCommand(toolCmd)
      if (cmdBlock) {
        noteFailure(replanState, 'preflightBlock', cmdBlock)
        convo.push({ role: 'tool', content: cmdBlock, name } as AiMessage)
        events?.onToolResult?.(name, cmdBlock)
        continue
      }

      if (name === 'start_background_task' || name === 'run_terminal_command') {
        const throttleBlock = checkCommandThrottle(toolCmd, commandHistory)
        if (throttleBlock) {
          noteFailure(replanState, 'preflightBlock', throttleBlock)
          convo.push({ role: 'tool', content: throttleBlock, name } as AiMessage)
          events?.onToolResult?.(name, throttleBlock)
          batchInterrupted = true
          break
        }
      }
      // ===== 工具守卫结束 =====

      // targetDir 工作区限定：plan 指定子目录后，文件变更禁止落在父目录（根目录与子目录混写污染源）。
      // 读操作不限（排查需要）；create_directory 创建目标目录本身豁免。
      if (ctx.targetDir && workspace) {
        const td = ctx.targetDir
        const outside = (p: string) => isOutsideTargetDir(workspace, td, p)
        let violated: string | null = null
        const mut = classifyMutationTool(name ?? '', (args ?? {}) as Record<string, unknown>)
        if (mut?.ok) {
          if (outside(mut.call.path)) violated = mut.call.path
          const oldPath = (mut.call as { oldPath?: string }).oldPath
          if (!violated && oldPath && outside(oldPath)) violated = oldPath
        } else if (!mut && (name === 'create_directory') && typeof args?.path === 'string') {
          if (outside(args.path)) violated = args.path
        }
        if (violated) {
          const block =
            `错误：当前项目根目录已被限定为 ${ctx.targetDir}，禁止在父目录写文件（${violated}）。` +
            `请将路径改为 ${ctx.targetDir}/<文件> 后重试；安装/运行命令请携带 cwd: "${ctx.targetDir}"。`
          noteFailure(replanState, 'preflightBlock', block)
          events?.onToolCall?.(name, args)
          convo.push({ role: 'tool', content: block, name } as AiMessage)
          events?.onToolResult?.(name, block)
          continue
        }
      }

      // 追踪文件写入（兼容内置 write 与 MCP write_file）
      if ((name === 'write' || name === 'write_file') && args?.path) {
        ctx.createdFiles.add(args.path)
      }

      // 运行时协调工具（todo/skill/dispatch）为状态型/内省型调用，不做跨轮去重
      if (runtimeNames.has(name)) {
        events?.onToolCall?.(name, args)
        const runtimeResult = await runners[name]?.(args) ?? `错误：运行时工具 ${name} 不可用`
        convo.push({ role: 'tool', content: runtimeResult, name } as AiMessage)
        events?.onToolResult?.(name, runtimeResult)
        continue
      }

      const dedupKey = `${name} ${JSON.stringify(args ?? {})}`
      // 同一调用已成功过：不重复执行，直接回填首次结果并提醒推进下一步
      const prior = executed.get(dedupKey)
      if (prior !== undefined) {
        // dedup 拦截：不推送 UI 事件（避免前端显示假"写入文件 ✓"），只回填 convo 让模型知道
        const reminder = `${prior}\n（提示：该操作此前已成功执行，请勿重复调用；请继续完成剩余的未做步骤。）`
        convo.push({ role: 'tool', content: reminder, name } as AiMessage)
        dedupHits++
        continue
      }

      // 同一路径重复写入拦截：模型常因上一轮失败后 panic，陷入"反复重写同一文件"的死循环。
      // 按 name+path（忽略内容差异）判定：已成功写过的文件再写时，回填提醒并强制推进下一步。
      const writePath = (name === 'write' || name === 'write_file') && typeof args?.path === 'string'
        ? `${name}@path:${args.path}`
        : null
      if (writePath && executed.has(writePath)) {
        // dedup 拦截：不推送 UI 事件（避免前端显示假"写入文件 ✓"），只回填 convo
        const reminder = `文件 ${args.path} 此前已成功写入，无需重写。` +
          `当前已创建 ${ctx.createdFiles.size} 个文件：${Array.from(ctx.createdFiles).slice(-5).join('、') || '无'}。` +
          '请立即推进未完成的步骤（创建剩余文件 / npm install / npm run serve），禁止再写入此文件。'
        convo.push({ role: 'tool', content: reminder, name } as AiMessage)
        dedupHits++
        continue
      }

      // 同文件连续修补防抖：同一文件已成功 edit 2 次、第 3 次还要修改时直接拦截，
      // 判定为「盲目打补丁」死循环（典型：main.js 重复声明改了又改，但 package.json 根本不存在）。
      const editPath =
        EDIT_TOOL_NAMES.has(name) && typeof args?.path === 'string' ? args.path : null
      if (editPath && editStreak && editStreak.path === editPath && editStreak.count >= 2) {
        const block =
          `错误：检测到对同一文件 ${editPath} 的连续重复修补（已成功修改 ${editStreak.count} 次，本次为第 ${editStreak.count + 1} 次），` +
          '判定为盲目打补丁，已强制中断当前循环。请停止重复修改：先核对缺失的基础文件与真实报错，' +
          '缺失基础文件用 write 完整生成；确属语法错误只用一次 edit 精准修复。'
        noteFailure(replanState, 'preflightBlock', block)
        events?.onToolCall?.(name, args)
        convo.push({ role: 'tool', content: block, name } as AiMessage)
        events?.onToolResult?.(name, block)
        // 若同时存在关键产物缺失 → 按偏差中断（含三阶段重规划指令）；否则注入通用强制重规划指令
        if (!interruptBatchForDrift()) {
          batchInterrupted = true
          convo.push({
            role: 'user',
            content:
              '⛔ 已强制中断：你在连续重复修改同一个文件，属于无效打补丁。请停止该文件的重复编辑，' +
              '根据真实报错重新规划步骤后再行动；缺失基础文件时先用 write_file 完整生成，再安装依赖、最后运行验证。'
          } as AiMessage)
        }
        break
      }

      // 强制恢复铁律白名单：重试任务后的每一个工具调用必须落在当前阶段允许的动作内。
      // 违规请求绝不发往 MCP 工具层——直接物理中断（合成 block 偏差卡片），防止模型又去
      // read/edit 污染文件或越阶段跑命令，在错误状态下继续消耗 token。
      if (recoveryPhase && recoveryPhase !== 'done') {
        const guardDenied = checkRecoveryGuard(recoveryPhase, name, cmd, ctx.projectProfile)
        if (guardDenied) {
          noteFailure(replanState, 'preflightBlock', `${name} ${cmd}\n${guardDenied}`)
          events?.onToolCall?.(name, args)
          convo.push({ role: 'tool', content: guardDenied, name } as AiMessage)
          events?.onToolResult?.(name, guardDenied)
          const drift: DriftReport = {
            items: [{
              kind: 'missingArtifact',
              severity: 'block',
              detail: `恢复铁律违规（${recoveryPhase === 'write-only' ? '第1阶段·只准 write_file' : '第2阶段·只准安装依赖'}）：${name}${cmd ? ` ${cmd.split(/\s*[;&|]/)[0].trim()}` : ''} 已被物理拦截`
            }],
            hasBlock: true,
            hasWarn: false
          }
          convo.push({
            role: 'user',
            content:
              '⛔ 你违反了强制恢复流程，任务已被系统再次物理中断。严格顺序只有：' +
              '1) write_file 补齐全部缺失基础文件 → 2) npm install → 3) 运行验证。' +
              '第 1 步绝不允许 read_text_file / edit_file。请点「重试任务」重新开始恢复流程。'
          } as AiMessage)
          events?.onPlanDrift?.({ ...drift, interrupted: true })
          blockedDrift = drift
          break
        }
      }

      // 读取黑名单硬拦：目标路径此前已确认「不存在」，禁止重复读取/列目录。
      // AI 常陷入「read 不存在文件 → 报错 → 再读」死循环（fileActionWindow 防抖需同路径
      // 3 次才触发，太慢）；命中即拦，唯一出路是 write_file 创建（写成功时黑名单自动移除）。
      if (READ_LIKE_TOOLS.has(name ?? '')) {
        const target = readTargetOf(args)
        if (target && failedReadPaths.has(target)) {
          const block =
            `错误：【系统拦截】路径 ${target} 此前已确认不存在，禁止重复读取或列出该路径。` +
            '你必须立即调用 write_file 创建它（write 会自动创建父目录）；' +
            '如需确认项目结构，改用 glob 搜索或读取其父目录。'
          noteFailure(replanState, 'preflightBlock', `${name} ${target}\n读取黑名单拦截`)
          events?.onToolCall?.(name, args)
          convo.push({ role: 'tool', content: block, name } as AiMessage)
          events?.onToolResult?.(name, block)
          continue
        }
      }

      // bash 执行前门控：破坏命令 deny / 交互式命令 interactive / 项目创建顺序锁
      const isBashTool = name === 'bash' || name === 'run_terminal_command'

      // 执行阶段硬门控（STAGE_FILES → STAGE_INSTALL → STAGE_RUN）：
      // 文件未齐（模板 fileExists 规则未全满足）时禁止一切画像安装命令——
      // 斩断「先装包后写码」的顺序错误源头。恢复铁律期间跳过（铁律自身已有更严白名单）。
      if (isBashTool && ctx.isProjectCreation && (!recoveryPhase || recoveryPhase === 'done')) {
        const profile = ctx.projectProfile ?? NODE_GATE_PROFILE
        const tplId = templateIdForProfile(profile.id)
        const stageManifest = ctx.artifactManifest ?? (tplId ? getTemplate(tplId) : null)
        const stage = computeExecStage({
          isProjectCreation: ctx.isProjectCreation,
          createdFiles: ctx.createdFiles,
          ranInit: ctx.ranNpmInstall,
          manifest: stageManifest,
          profile,
          onDisk: workspace
            ? (rel) =>
                safeExists(join(workspace, rel)) ||
                (ctx.targetDir ? safeExists(join(workspace, ctx.targetDir, rel)) : false)
            : undefined
        })
        const stageDeny = checkExecStageGate(cmd, stage, profile)
        // 顺序锁源码维度：运行/验证命令要求源码目录已有产物（createdFiles 登记或磁盘非空
        // 双通道——续跑/换候选模型后登记丢失时由磁盘探测兜底）。否则 package.json +
        // node_modules 就绪但 src/ 为空时 dev server 必然秒退（此前门控对此放行）。
        const srcDeny =
          stageDeny ??
          checkRunSourceGate(cmd, profile, ctx.createdFiles, (relDir) =>
            workspace
              ? dirNonEmpty(join(workspace, relDir)) ||
                (ctx.targetDir ? dirNonEmpty(join(workspace, ctx.targetDir, relDir)) : false)
              : false
          )
        if (srcDeny) {
          // 软拦截：文件未齐是 files 阶段正常态，不触发 drift 硬阻断——记失败信号
          // （连续 2 次触发 Self-Reflection 重规划），让模型回去继续写文件。
          noteFailure(replanState, 'preflightBlock', `${cmd}\n${srcDeny}`)
          events?.onToolCall?.(name, args)
          convo.push({ role: 'tool', content: srcDeny, name } as AiMessage)
          events?.onToolResult?.(name, srcDeny)
          continue
        }
      }

      // targetDir cwd 自动注入：项目已限定子目录时，安装/运行命令缺省在该目录执行，
      // 防止 AI 在工作区根与子目录间反复横跳（npm install 装错目录）。
      if (isBashTool && ctx.targetDir && !args?.cwd) {
        const profile = ctx.projectProfile ?? NODE_GATE_PROFILE
        if (profile.initPattern?.test(cmd) || profile.runPattern?.test(cmd) || profile.primaryRunPattern?.test(cmd)) {
          args.cwd = ctx.targetDir
        }
      }

      // 显式 interactive:true：模型已声明该命令需真终端，跳过 interactive 拦截（deny 仍拦），
      // 放行给 terminalServer 工具自身走 PTY 分支
      const explicitPty = isBashTool && args?.interactive === true
      // NPM 命令按真实磁盘状态过锁（package.json / node_modules 探测，任何场景生效）；
      // 其余命令零 IO，直接用 ctx（缺省回退 createdFiles 口径）
      const gateCtx: BashGateContext =
        isBashTool && /\bnpm\b/.test(cmd) ? probeNpmGateContext(ctx, args?.cwd) : ctx
      const verdict = isBashTool ? gateBashCommand(cmd, gateCtx) : null
      if (verdict?.kind === 'deny') {
        // 信号：命令被门控拒绝（破坏命令/顺序锁 → 重规划换方案）
        noteFailure(replanState, 'preflightBlock', `${cmd}\n${verdict.message}`)
        events?.onToolCall?.(name, args)
        convo.push({ role: 'tool', content: verdict.message, name } as AiMessage)
        events?.onToolResult?.(name, verdict.message)
        // 越序被拦且关键产物确实缺失（如 package.json 不存在就 npm install/run）：
        // 立即中断批次内后续调用（典型：拦截后模型继续 read/edit 打补丁），轮末直接重规划
        if (interruptBatchForDrift()) break
        continue
      }
      if (verdict?.kind === 'interactive' && !explicitPty) {
        // 交互式命令：复用权限审批条；批准后直接在真 PTY 中启动（不经过 callMcpTool）
        events?.onToolCall?.(name, args)
        const resp = await askUser({
          tool: name,
          target: cmd,
          reason: verdict.message
        })
        if (resp.decision === 'deny') {
          const denied =
            `错误：用户拒绝在终端运行该命令（${resp.reason || '已拒绝'}）。请更换方案，` +
            '例如用 write 工具写入文件，或改用非交互命令。'
          noteFailure(replanState, 'preflightBlock', `${cmd}\n用户拒绝`)
          convo.push({ role: 'tool', content: denied, name } as AiMessage)
          events?.onToolResult?.(name, denied)
          continue
        }
        let launched: string
        try {
          const { terminalId } = runInteractiveInPty(cmd, workspace ?? undefined)
          launched =
            `交互式命令已在内置终端 #${terminalId} 启动，用户可在终端面板继续键盘输入。` +
            '不要等待该命令结束，也不要重复调用；可继续后续非依赖步骤，或询问用户下一步。'
        } catch (e: any) {
          launched = `错误：终端启动失败：${e?.message || String(e)}`
        }
        convo.push({ role: 'tool', content: launched, name } as AiMessage)
        events?.onToolResult?.(name, launched)
        continue
      }

      // ㊝ 变更事务暂存（审阅模式，开关默认关；未开启时 reviewOn=false，行为零变化）：
      // - bash 前暂存非空：先批量接受门，用户接受（全部落盘）才放行命令；
      // - 结构化变更工具（write/edit/delete/move/copy 及 MCP 同名工具）：直接入暂存，
      //   不调底层、不走①权限闸（不落盘即安全；仅保留工作区边界硬检查）。
      const reviewOn: boolean = workspace ? await isStageEnabled(workspace) : false
      if (reviewOn && (name === 'bash' || name === 'run_terminal_command')) {
        const summary = await getStageSummary(workspace!)
        if (summary.total > 0) {
          // 等待表建在 staging 模块：前端「接受」走 staging:bashAcceptResponse，
          // 由 resolveBashAccept 内部完成全部落盘后才释放 promise。
          const bashGate = beginBashAccept(workspace!)
          // 事件只负责把弹层推到前端；await 的是 pendingBash 的 promise，
          // 由 staging:bashAcceptResponse → resolveBashAccept 释放（含落盘+冲突检测）
          events?.onBashAcceptRequest?.({ id: bashGate.id, summary })
          const accepted = await bashGate.promise
          if (!accepted) {
            const blocked =
              '错误：用户尚未接受待审阅变更，命令未执行。请结束文件编辑，' +
              '用户接受变更、文件落盘后再请求执行命令。'
            convo.push({ role: 'tool', content: blocked, name } as AiMessage)
            events?.onToolResult?.(name, blocked)
            continue
          }
          events?.onStagingChanged?.()
        }
      }
      if (reviewOn) {
        const classified = classifyMutationTool(name, args ?? {})
        if (classified) {
          if (!classified.ok) {
            const bad = `错误：${classified.error}`
            events?.onToolCall?.(name, args)
            convo.push({ role: 'tool', content: bad, name } as AiMessage)
            events?.onToolResult?.(name, bad)
            continue
          }
          // 边界硬检查：暂存也不允许越过工作区（敏感文件不拦——接受动作在用户）
          if (!isInside(workspace!, classified.call.path)) {
            const oob = `错误：路径超出工作区边界，操作已拒绝：${classified.call.path}`
            events?.onToolCall?.(name, args)
            convo.push({ role: 'tool', content: oob, name } as AiMessage)
            events?.onToolResult?.(name, oob)
            continue
          }
          // s43 暂存路径锚点拦截：禁改路径 / 删除受保护符号（旧内容取暂存覆盖后的有效视图）
          {
            const rel = relative(workspace!, classified.call.path).split(sep).join('/')
            const hitPath = matchProtectedPath(anchorsCache, rel)
            if (hitPath) {
              const blocked = `错误：路径命中 spec 锚点禁改清单（${hitPath}），操作已阻断：${classified.call.path}。确需调整请先向用户说明原因。`
              ctx.anchorViolations?.push(`${rel}（命中禁改 ${hitPath}）`)
              events?.onToolCall?.(name, args)
              convo.push({ role: 'tool', content: blocked, name } as AiMessage)
              events?.onToolResult?.(name, blocked)
              continue
            }
            const stagedCall = classified.call
            if (stagedCall.op === 'write' || stagedCall.op === 'edit') {
              const oldView = await readEffectiveView(workspace!, stagedCall.path)
              const oldContent = oldView.content ?? ''
              const newContent = stagedCall.op === 'write'
                ? stagedCall.content
                : oldContent.replace(stagedCall.oldString, stagedCall.newString)
              const removed = removedProtectedSymbols(anchorsCache, rel, oldContent, newContent)
              if (removed.length > 0) {
                const blocked = `错误：本次改动会删除受保护符号：${removed.join('、')}（${rel}），操作已阻断。确需删除请先向用户说明原因。`
                ctx.anchorViolations?.push(`${rel} 删除受保护符号 ${removed.join('、')}`)
                events?.onToolCall?.(name, args)
                convo.push({ role: 'tool', content: blocked, name } as AiMessage)
                events?.onToolResult?.(name, blocked)
                continue
              }
            }
          }
          events?.onToolCall?.(name, args)
          // s50 审阅落盘同样取写锁，与并行 Agent 串行化同路径写入
          const stageLockTarget = mutationLockTarget(workspace ?? null, name, args)
          const r = stageLockTarget
            ? await getGlobalFileLockTable().withLock(stageLockTarget, taskId, () =>
                commitStaged(workspace!, classified.call)
              )
            : await commitStaged(workspace!, classified.call)
          convo.push({ role: 'tool', content: r.result, name } as AiMessage)
          events?.onToolResult?.(name, r.result)
          events?.onStagingChanged?.()
          continue
        }
      }

      // 统一权限关卡：只读/询问/自动三模式 + 危险命令 + 敏感文件 + 工作区边界。
      // ask 时挂起等待前端审批条应答；deny 时工具不执行，以错误形式回填让 Agent 改道。
      const gateResult = await permissionGate.check(name, args ?? {}, (entry) =>
        appendAudit(workspace, entry)
      )
      if (!gateResult.allowed) {
        const denied = `错误：操作未被允许：${gateResult.reason}。请更换方案（例如改在工作区内操作、改用只读方式，或先请用户调整权限模式）。`
        convo.push({ role: 'tool', content: denied, name } as AiMessage)
        events?.onToolResult?.(name, denied)
        continue
      }

      // s43 非暂存路径锚点拦截 + s42 改动前内容抓取（影响提醒用）：
      // 仅对工作区内 write/edit 生效；classifyMutationTool 返回 null 的工具名不拦截。
      let preEdit: { relPath: string; oldContent: string; newContent: string } | null = null
      if (workspace) {
        const analyzed = classifyMutationTool(name, args ?? {})
        if (analyzed?.ok && isInside(workspace, analyzed.call.path)) {
          const call = analyzed.call
          const rel = relative(workspace, call.path).split(sep).join('/')
          const hitPath = matchProtectedPath(anchorsCache, rel)
          if (hitPath) {
            const blocked = `错误：路径命中 spec 锚点禁改清单（${hitPath}），操作已阻断：${call.path}。确需调整请先向用户说明原因。`
            ctx.anchorViolations?.push(`${rel}（命中禁改 ${hitPath}）`)
            convo.push({ role: 'tool', content: blocked, name } as AiMessage)
            events?.onToolResult?.(name, blocked)
            continue
          }
          if (call.op === 'write' || call.op === 'edit') {
            const oldContent = readStageDisk(call.path).content ?? ''
            const newContent = call.op === 'write'
              ? call.content
              : oldContent.replace(call.oldString, call.newString)
            const removed = removedProtectedSymbols(anchorsCache, rel, oldContent, newContent)
            if (removed.length > 0) {
              const blocked = `错误：本次改动会删除受保护符号：${removed.join('、')}（${rel}），操作已阻断。确需删除请先向用户说明原因。`
              ctx.anchorViolations?.push(`${rel} 删除受保护符号 ${removed.join('、')}`)
              convo.push({ role: 'tool', content: blocked, name } as AiMessage)
              events?.onToolResult?.(name, blocked)
              continue
            }
            preEdit = { relPath: rel, oldContent, newContent }
          }
        }
      }

      events?.onToolCall?.(name, args)
      const found = allTools.find((t) => t.tool.name === name)
      const toolStart = Date.now()
      // s50 冲突文件写前取锁：与全部子代理共用全局锁表，owner 为本任务 id
      const lockTarget = mutationLockTarget(workspace ?? null, name, args)
      const invokeTool = async (): Promise<string> =>
        found
          ? callMcpTool(found.server, name, args, workspace, signal)
          : `错误：未找到工具 ${name}`
      let result = lockTarget
        ? await getGlobalFileLockTable().withLock(lockTarget, taskId, invokeTool)
        : await invokeTool()
      // 2.2 工具在途被用户中止：回填取消结果（前端卡片立即转「已取消」）并立即收尾，
      // 不再进入后处理/后续工具调用/下一轮模型请求
      if (signal?.aborted) {
        const cancelled = '⚠ 已被用户中止'
        convo.push({ role: 'tool', content: cancelled, name } as AiMessage)
        events?.onToolResult?.(name, cancelled)
        return finishByAbort()
      }
      // ㊝ 只读工具的暂存覆盖：read 命中暂存直接替换；glob 剔除删除并入新增；grep 追加暂存匹配
      if (reviewOn && (STAGE_READ_NAMES.has(name) || STAGE_GREP_NAMES.has(name) || STAGE_GLOB_NAMES.has(name))) {
        result = await overlayToolResult(workspace!, name, args ?? {}, result)
      }
      // 秒退熔断器：命令 <1000ms 非零崩溃（terminalServer 打 [FAST_FAIL_BREAKER] 标记）→
      // 立即中止当前批次剩余工具调用，强制模型停下来 read_file/list_directory 定位修复，
      // 禁止带着「命令可能已成功」的幻觉继续跑后续命令。轮末由重规划接管。
      if ((isBashTool || name === 'start_background_task') && result.includes(FAST_FAIL_BREAKER_TAG)) {
        noteFailure(replanState, 'commandFailure', `${cmd || name}\n秒退熔断：${result.slice(-300)}`)
        convo.push({ role: 'tool', content: result, name } as AiMessage)
        events?.onToolResult?.(name, result)
        convo.push({
          role: 'user',
          content:
            '⛔ 秒退熔断：命令在 1 秒内崩溃退出，当前批次已强制中断。严格执行上方工具结果中的【致命错误】指令：' +
            '先 read_file / list_directory 定位并修复源码（通常是文件缺失或语法错误），修复完成前禁止执行任何后续命令。'
        } as AiMessage)
        batchInterrupted = true
        break
      }
      // 记录工具调用轨迹（名称/参数/结果/耗时）
      tracer?.recordToolCall(round, name, args, result, Date.now() - toolStart)
      // 统一失败口径（含 ELIFECYCLE 与非零退出码「退出码 N」）：npm 标志位与失败信号共用同一判定，
      // 防止「命令秒退但输出无 npm error 字样」时 ranNpmInstall/ranServe 被误置位、验证锁放行
      const toolFailureRe = /npm error|npm ERR|ELIFECYCLE|错误|failed|不是内部或外部命令|退出码\s*[1-9]/i
      const failedResult = toolFailureRe.test(result)
      // 依赖安装实际执行后：仅成功才置标记（preflight 拦截/命令失败均不置位，避免污染顺序门控）。
      // 匹配器按当前项目画像取 initPattern（python→pip install -r、go→go mod tidy），缺省 npm 系。
      const initRe = ctx.projectProfile?.initPattern ?? /\bnpm\s+(install|i)\b/
      if ((name === 'bash' || name === 'run_terminal_command') &&
          initRe.test(cmd) && !/\s-g\b/.test(cmd)) {
        if (!failedResult) {
          ctx.ranNpmInstall = true
        }
      }
      // 追踪 npm run serve 执行（失败则不标记）
      if ((name === 'bash' || name === 'run_terminal_command') && cmd.includes('npm run serve')) {
        if (!failedResult) {
          ctx.ranServe = true
        }
      }
      // 追踪 mkdir 成功执行（用于目录类 Todo 完成判定）
      if ((name === 'bash' || name === 'run_terminal_command') &&
          /\b(mkdir|md)\b/i.test(cmd) &&
          !failedResult) {
        ctx.ranMkdir = true
      }
      executed.set(dedupKey, result)
      // 写入成功后登记 path 级去重键，拦截后续同路径重写
      if (writePath && !result.startsWith('错误') && !result.startsWith('Error')) {
        executed.set(writePath, result)
        // 文件已创建：从读取黑名单移除（此前「不存在」的判定已失效，允许后续读取）
        const written = readTargetOf(args)
        if (written) failedReadPaths.delete(written)
      }
      // 重规划信号追踪：bash/run_terminal_command 用强失败标志（非零退出码、npm ERR!、
      // ELIFECYCLE 等，避开「0 failed」这类成功文本）；其余工具以「错误」前缀判定；
      // 实质成功即重置连续失败计数。
      const startsWithError = /^错误|^Error/.test(result)
      // 读取类工具失败且目标「不存在」→ 加入读取黑名单：后续对同路径的 read/list_directory
      // 在执行前直接拦截（见批次循环前置门），强制模型转向 write_file 创建。
      if (READ_LIKE_TOOLS.has(name ?? '') && startsWithError && READ_NOT_FOUND_RE.test(result)) {
        const target = readTargetOf(args)
        if (target) failedReadPaths.add(target)
      }
      if (name === 'bash' || name === 'run_terminal_command') {
        // bash 工具首行为「退出码 N」——此前 N≠0 不在强失败正则内，秒退失败对闭环不可见
        const exitLine = result.match(/^退出码\s+(\d+)/m)
        const nonZeroExit = exitLine ? Number(exitLine[1]) !== 0 : false
        const strongFail =
          nonZeroExit ||
          /npm ERR!|ELIFECYCLE|不是内部或外部命令|command not found|permission denied|exited with code [1-9]|exit code [1-9]|build failed|compilation failed/i.test(result)
        if (startsWithError || strongFail) {
          noteFailure(replanState, 'commandFailure', `${cmd || name}\n${result.slice(-400)}`)
          // 命令失败（含秒退）且关键产物缺失：立即中断批次，不等同批后续 read/edit 继续盲目打补丁。
          // 先把真实结果（含秒退反思与 stderr）回填 convo，再让轮末重规划携带根因。
          if (interruptBatchForDrift()) {
            convo.push({ role: 'tool', content: result, name } as AiMessage)
            events?.onToolResult?.(name, result)
            break
          }
        } else {
          noteSuccess(replanState)
        }
      } else if (startsWithError) {
        // 写入/编辑等工具被语法预检或其他校验拒绝：同样计入失败信号（累积 2 次触发 Self-Reflection）
        noteFailure(
          replanState,
          'commandFailure',
          `${name} ${(JSON.stringify(args ?? {}) || '').slice(0, 150)}\n${result.slice(-400)}`
        )
      } else {
        noteSuccess(replanState)
      }
      // 同文件连续修补计数：仅成功的 edit 累计；转向 write 其他文件或 bash 命令时清零；
      // read/grep/glob/todo 等只读与协调动作不打断连续计数
      if (editPath && !startsWithError && !failedResult) {
        if (editStreak && editStreak.path === editPath) editStreak.count += 1
        else editStreak = { path: editPath, count: 1 }
      } else if (name === 'write' || name === 'write_file' || isBashTool) {
        editStreak = null
      }
      // 工具结果后处理：幂等性修正（mkdir 已存在→Success）+ 文件树状态注入 + 自动 Todo 更新
      let finalResult = postProcessToolResult(name, args, result, ctx)
      // bash 失败分析：识别常见错误模式，附加修复建议
      if (name === 'bash' || name === 'run_terminal_command') {
        const analysis = analyzeBashFailure(finalResult, cmd, executed)
        if (analysis) {
          finalResult = `${finalResult}\n\n${analysis}`
        }
      }
      // 项目创建场景：根据工具调用自动更新 Todo 状态（顺序锁），跳序操作的警告回填给模型
      if (ctx.isProjectCreation && !finalResult.startsWith('错误') && !finalResult.startsWith('Error')) {
        const orderWarning = autoUpdateTodos(todoStore, name, args, finalResult, ctx)
        events?.onTodo?.(todoStore.items)
        ctx.todosText = todoStore.render()
        if (orderWarning) finalResult += `\n\n${orderWarning}`
      }
      // s42 改动影响提醒：符号被删但工作区内仍有引用时追加警告（仅源码文件、非暂存落盘路径）
      if (preEdit && workspace && !finalResult.startsWith('错误') && !finalResult.startsWith('Error')) {
        if (IMPACT_EXT.has(extname(preEdit.relPath).toLowerCase()) && preEdit.oldContent) {
          try {
            const impacts = await buildEditImpact(preEdit.oldContent, preEdit.newContent, preEdit.relPath, countSymbolRefs)
            const impactText = formatEditImpact(impacts)
            if (impactText) finalResult += impactText
          } catch {
            // 影响分析失败不阻断主流程
          }
        }
      }
      // s43 set_anchors 成功后重载锚点缓存与提示词层（本任务内即时生效）
      if (name === 'set_anchors' && workspace && !finalResult.startsWith('错误') && !finalResult.startsWith('Error')) {
        try {
          anchorsCache = await loadAnchors(workspace)
          ctx.anchorsText = formatAnchorBlock(anchorsCache) || null
        } catch {
          // 重载失败沿用旧缓存
        }
      }
      convo.push({ role: 'tool', content: finalResult, name } as AiMessage)
      events?.onToolResult?.(name, finalResult)
    }
    // ===== 物理阻断（最高优先级，先于一切自动恢复）=====
    // planDrift hasBlock（关键产物缺失）或恢复铁律违规：本轮剩余工具队列已在批次内 break 丢弃，
    // 直接终止整个工具循环——不再 Self-Reflection 重规划、不再注入指令「再自修一轮」、不切换候选模型。
    if (blockedDrift) {
      return finishBlocked(blockedDrift)
    }
    // ===== 动态重规划（Self-Reflection）=====
    // 触发条件：①连续失败信号达阈值；②本轮被中途偏差/防抖强制中断（batchInterrupted，立即重规划）。
    // 打包失败信号+文件清单+原 TODO 请求轻量 LLM，产出的小粒度修复计划覆盖 TodoStore，continue 进入新一轮。
    if ((shouldReplan(replanState) || batchInterrupted) && replanState.replanCount < MAX_REPLANS) {
      const reason = summarizeSignals(replanState)
      events?.onModelCall?.(modelName, 'Self-Reflection 重规划')
      const replanResult = await requestReplan({
        provider,
        modelName,
        userRequest: userRequestText,
        state: replanState,
        createdFiles: ctx.createdFiles,
        todos: todoStore.items,
        missingArtifacts: pendingMissingArtifacts,
        profile: ctx.projectProfile
      })
      // 重规划结果门控过滤：LLM 输出不可信（真实 E2E 复现小模型仍给 vue create），
      // 命令类步骤逐条过 bashGate（npm 命令带磁盘探测上下文，硬锁同样生效），交互/破坏/顺序锁步骤丢弃；
      // 基础文件缺失模式额外丢弃 edit 修补残缺文件的步骤；全被过滤则放弃本次重规划。
      let usableSteps: ReplanStep[] | null = null
      let droppedDescriptions: string[] = []
      if (replanResult) {
        const sanitized = sanitizeReplanSteps(
          replanResult.steps,
          (command) =>
            gateBashMessage(
              command,
              /\bnpm\b/.test(command) ? probeNpmGateContext(ctx, null) : ctx
            ),
          { missingArtifacts: pendingMissingArtifacts, existingFiles: ctx.createdFiles }
        )
        if (sanitized.kept.length > 0) {
          usableSteps = sanitized.kept
          droppedDescriptions = sanitized.dropped.map((s) => s.target || s.content)
        }
      }
      if (usableSteps) {
        // 覆盖 TODO：仅门控通过的小粒度清单替换原计划
        todoStore.handle({ action: 'clear' })
        todoStore.handle({
          action: 'add',
          todos: usableSteps.map((s) => ({ content: s.content, priority: 'high' as const }))
        })
        ctx.todosText = todoStore.render()
        events?.onTodo?.(todoStore.items)
        const stepContents = usableSteps.map((s) => s.content)
        const droppedBlock =
          droppedDescriptions.length > 0
            ? `\n以下步骤因会触发交互/破坏/顺序锁/无效打补丁已被门控丢弃，严禁执行：${droppedDescriptions.join('；')}`
            : ''
        convo.push({
          role: 'user',
          content:
            `🔄 Self-Reflection 动态重规划（第${replanState.replanCount + 1}次）。${reason}\n` +
            '原方案连续受阻，已用更小粒度修复计划替换 TODO：\n' +
            stepContents.map((c, i) => `${i + 1}. ${c}`).join('\n') +
            droppedBlock +
            '\n请严格按新 TODO 顺序执行：文件用 write 直接写入完整内容、命令用 bash 执行，禁止重试已失败的命令与交互式脚手架，不要再输出纯文字描述。'
        } as AiMessage)
        tracer?.recordReplan(round, reason, stepContents, replanResult!.durationMs)
        events?.onReplan?.(replanState.replanCount + 1, stepContents, reason)
      }
      // 无论成功与否消耗一次配额并清零失败计数，防止立即重试；LLM 失败/步骤全被过滤时回退下方 stall/熔断
      markReplanned(replanState)
      const wasInterrupted = batchInterrupted
      batchInterrupted = false
      pendingMissingArtifacts = []
      // 有可用步骤 → 按新计划执行；强制中断但重规划无步骤 → 中断指令已注入 convo，
      // 让模型按「三阶段」指令自行修复一轮（不再跑下方 dedup/收尾逻辑）
      if (usableSteps || wasInterrupted) continue
    } else if (batchInterrupted) {
      // 重规划配额已耗尽：不调用 LLM，凭已注入的中断指令再给一轮自行修复机会；仍失败由 MAX_TOOL_ROUNDS 兜底
      batchInterrupted = false
      pendingMissingArtifacts = []
      continue
    }
    // ===== 全轮 dedup 无进展检测 =====
    // 本轮所有工具调用都被 dedup 拦截（dedupHits === toolCalls.length）说明模型没有做任何新工作，
    // 视同停滞：项目创建场景下直接检查验证锁并注入强制推进消息
    if (dedupHits > 0 && dedupHits === toolCalls.length) {
      dedupStallCount++
      if (ctx.isProjectCreation) {
        const validationMsg = validateTaskCompletion(ctx)
        if (validationMsg) {
          // 信号：重复空转 + 验证未过（与上方验证锁信号同源）
          noteFailure(replanState, 'validationBlock', `重复调用空转：${validationMsg}`)
          // 注入强制推进消息，让模型知道它在空转且关键步骤缺失
          convo.push({
            role: 'user',
            content: `⚠ 你已连续 ${dedupStallCount} 轮只重复调用已执行过的工具，没有任何新进展。${validationMsg}\n` +
              '请立即调用工具完成上述缺失步骤，禁止再重复已完成的操作！'
          } as AiMessage)
          // 连续 3 轮全 dedup 且验证未通过：放弃，避免空耗
          if (dedupStallCount >= 3) {
            lastContent += '\n\n⚠️ 任务未完成：模型陷入重复循环，验证锁未通过。'
            break
          }
          continue
        }
      } else {
        // 非项目创建任务：连续 2 轮全 dedup 即收尾
        if (dedupStallCount >= 2) break
      }
    } else if (dedupHits < toolCalls.length) {
      // 有实际新工作：重置计数器
      dedupStallCount = 0
    }
    // 本轮收尾快照：崩溃后最多损失当前这一轮（continue 提前进入下一轮的分支，
    // 其注入消息会在下一次轮末快照中一并落盘）
    persist('running')
  }
  // ㊜ 1c 批次中 break（工具批次内收到超时/停止）：与轮首一致走 abort 收尾，
  // 不能落到正常完成路径——否则会误写 completed 快照、成功笔记并掩盖中止。
  if (signal?.aborted) {
    return finishByAbort()
  }
  // 未执行 npm install 或 npm run serve 验证时附加警告
  if (ctx.createdFiles.size > 0 && !ctx.ranNpmInstall && !lastContent.includes('任务未完成')) {
    lastContent += '\n\n⚠️ 项目未验证：未执行 npm install，无法确认项目可运行。'
  } else if (ctx.ranNpmInstall && !ctx.ranServe && !lastContent.includes('任务未完成')) {
    lastContent += '\n\n⚠️ 依赖已安装但未验证运行：未执行 npm run serve，无法确认项目可启动。'
  }
  // 计划-执行偏差检测：比对 Todo 步骤 / manifest 产物 / 实际创建文件，
  // 覆盖验证锁照看不到的放弃/break 路径与范围蔓延（如实报告，不再拦截）
  const drift = detectPlanDrift({
    todos: todoStore.items,
    createdFiles: ctx.createdFiles,
    manifest: ctx.artifactManifest ?? null,
    plan: ctx.plan ?? null
  })
  const driftText = formatDriftReport(drift)
  if (driftText) {
    lastContent += driftText
    events?.onPlanDrift?.(drift)
  }
  // s43 锚点违规汇总：与偏差检测合并呈现（被阻断的改动留痕，供用户判断是否需调整锚点清单）
  if (ctx.anchorViolations && ctx.anchorViolations.length > 0) {
    lastContent +=
      `\n\n⚠️ 【锚点违规】本任务共阻断 ${ctx.anchorViolations.length} 次违反 spec 锚点的改动：\n` +
      ctx.anchorViolations.map((v) => `- ${v}`).join('\n')
  }
  // 持久化笔记：记录本次任务的结果，供下次会话参考
  if (workspace) {
    // 恢复模式 messages 为空，用已恢复的原始请求 userRequestText
    const lastUser = userRequestText
    const status = lastContent.includes('任务未完成')
      ? '停滞'
      : (lastContent.includes('项目未验证') || lastContent.includes('未验证运行'))
        ? '部分完成'
        : '成功'
    try {
      const structure = ctx.createdFiles.size > 0
        ? Array.from(ctx.createdFiles).join('、')
        : undefined
      await updateAfterTask(workspace, lastUser, status, structure)
    } catch {
      // 笔记写入失败不影响主流程
    }
  }
  // 正常完成：落盘轨迹并记录日志
  const status: AgentTrace['status'] = lastContent.includes('任务未完成') ? 'aborted' : 'completed'
  tracer?.finish(status, lastContent)
  if (tracer && traceDir) {
    saveTrace(traceDir, tracer.snapshot())
    rotateTraces(traceDir, 7)
  }
  log.info(`Agent 任务结束 taskId=${taskId} status=${status} rounds=${tracer?.snapshot().rounds.length ?? 0}`)
  // 正常收尾（含「任务未完成」但运行已交付的情形）：completed 不进恢复条，
  // 用户可在会话中直接说「继续」，或经偏差卡片的一键生成补齐
  persist('completed')
  return lastContent
  } catch (err) {
    // 物理阻断：finishBlocked 已完成 aborted 轨迹与 interrupted 快照，直接透传，
    // 不再记 error 轨迹、不二次落盘
    if (err instanceof TaskBlockedError) throw err
    // 异常退出：记录错误轨迹后重新抛出（由上层回退逻辑处理）
    const msg = err instanceof Error ? err.message : String(err)
    log.error(`Agent 任务异常 taskId=${taskId} error=${msg}`)
    tracer?.finish('error', lastContent, msg)
    if (tracer && traceDir) saveTrace(traceDir, tracer.snapshot())
    // 中断快照：若上层回退候选全部失败，重启后可由此恢复；回退最终成功时由包装器清理
    persist('interrupted')
    throw err
  }
}

/**
 * bash 工具执行前门控（项目创建场景）：
 * 1. 硬拦截交互式全局脚手架命令（vue create / create-react-app / npm init vue@ 等），
 *    这类命令会卡在 preset 交互选择且违背"用 write 直接建文件"的协议；
 * 2. 顺序检查：npm install 前必须已有 package.json；npm run serve 前必须已 npm install。
 * @returns 拦截原因（不执行命令）；放行返回 null
 */
// bash 执行前门控：委托 bashGate.ts 数据驱动纯函数层（交互式特征+破坏命令黑名单+依赖图谱+顺序锁）。
// 此处保留为薄壳，兼容现有调用点与测试。
export function preflightBash(cmd: string, ctx: PromptContext): string | null {
  // 同步薄壳：deny/interactive 统一折叠为消息文本（主循环内部直接用 verdict）
  return gateBashMessage(cmd, ctx)
}

/**
 * edit 类工具名集合（与 changeStage.EDIT_NAMES 对齐；后者未导出，此处按同口径维护）。
 * 用于「同文件连续修补防抖」：连续 3 次 edit 同一文件即判定盲目打补丁并强制中断。
 */
const EDIT_TOOL_NAMES = new Set(['edit', 'edit_file', 'str_replace', 'string_replace'])

// ============ 强制恢复（FORCED-RECOVERY）铁律 ============
// 物理阻断后用户点「重试任务」：前端发送带该标记的固定指令，工具循环进入分阶段白名单，
// 旧文件一律视为污染状态——第一步只能整体 write，禁止 read/edit，防止模型又去读残缺文件打补丁。
/** 强制恢复指令标记（发送方在 renderer/stores/chat.ts 同口径维护） */
export const FORCED_RECOVERY_TAG = '【FORCED-RECOVERY】'
const FORCED_RECOVERY_RE = /【\s*FORCED-RECOVERY\s*】/

/** 恢复阶段：write-only=只准写缺失基础文件 → install=只准安装依赖 → done=铁律解除 */
export type RecoveryPhase = 'write-only' | 'install' | 'done'

/** 只读/修补类工具名（恢复铁律第一阶段全部禁止） */
const READ_TOOL_NAMES = new Set(['read', 'read_file', 'read_text_file', 'view_file', 'cat'])
const WRITE_TOOL_NAMES = new Set(['write', 'write_file', 'create_file'])
/** 依赖安装命令（恢复第二阶段唯一允许的命令类动作） */
const INSTALL_COMMAND_RE = /\b(npm|cnpm|yarn|pnpm)\s+(install|i|add)\b/

/**
 * 恢复铁律白名单校验（纯函数）：返回非空字符串=拒绝原因（调用方不得把请求发往工具层）。
 * - write-only：仅 write 类与运行时协调工具（调用前已分流）放行；read/edit/bash/grep 等全拒；
 * - install：write 放行，命令仅允许当前项目画像的依赖安装命令（缺省 npm/yarn/pnpm install，-g 除外）；
 * - done：铁律解除，一律放行。
 */
export function checkRecoveryGuard(
  phase: RecoveryPhase,
  toolName: string,
  command: string,
  profile?: import('../../shared/projectProfiles').ProjectProfile
): string | null {
  if (phase === 'done') return null
  if (phase === 'write-only') {
    if (WRITE_TOOL_NAMES.has(toolName)) return null
    if (READ_TOOL_NAMES.has(toolName)) {
      return '错误：恢复铁律第 1 阶段禁止读取旧文件——旧文件已视为污染状态，读取只会诱导你继续打补丁。请直接用 write_file 整体生成缺失的基础文件。'
    }
    if (EDIT_TOOL_NAMES.has(toolName)) {
      return '错误：恢复铁律第 1 阶段禁止 edit/str_replace 修补旧文件。缺失或残缺的基础文件必须用 write_file 一次性写入完整合法内容（整体覆盖）。'
    }
    return '错误：恢复铁律第 1 阶段只允许调用 write_file 补齐缺失的基础文件，禁止读取、编辑、搜索或执行任何命令；全部基础文件补齐后才会进入安装阶段。'
  }
  // install 阶段
  if (WRITE_TOOL_NAMES.has(toolName)) return null
  if (toolName === 'bash' || toolName === 'run_terminal_command') {
    // 画像驱动：安装命令匹配当前生态（python→pip install -r；go→go mod tidy；缺省 npm 系）
    const isInstall = profile?.initPattern
      ? profile.initPattern.test(command)
      : INSTALL_COMMAND_RE.test(command)
    if (isInstall && !/\s-(?:g|-global)\b/.test(command)) return null
    const allowText = profile?.initCommands.join(' / ') || 'npm install / yarn install / pnpm install'
    return `错误：恢复铁律第 2 阶段只允许执行依赖安装命令（${allowText}）。安装成功前禁止运行/构建/启动类命令，也禁止其他操作；安装完成后才进入验证阶段。`
  }
  if (toolName === 'start_background_task') {
    return '错误：依赖尚未确认安装成功，禁止启动后台任务。请先用 run_terminal_command 执行依赖安装命令。'
  }
  return '错误：恢复铁律第 2 阶段只允许 write_file 补修与依赖安装命令，禁止读取/编辑/搜索等其他操作。'
}

/** 消息集中是否含强制恢复标记（任一 user 消息命中即进入铁律模式） */
export function hasForcedRecoveryTag(messages: AiMessage[]): boolean {
  return messages.some(
    (m) => m.role === 'user' && typeof m.content === 'string' && FORCED_RECOVERY_RE.test(m.content)
  )
}

/** 安全 existsSync（路径异常时按不存在处理，绝不因探测阻断主流程） */
function safeExists(p: string): boolean {
  try {
    return existsSync(p)
  } catch {
    return false
  }
}

/** 目录存在且含至少一个条目（源码目录非空探测用；异常/文件路径按空处理） */
function dirNonEmpty(p: string): boolean {
  try {
    return existsSync(p) && readdirSync(p).length > 0
  } catch {
    return false
  }
}

/**
 * NPM 门控磁盘探测：bashGate 是零 IO 纯函数，由调度器在此把真实磁盘状态显式传入，
 * 让 package.json / node_modules 顺序硬锁在「任何场景」生效（而非仅项目创建 + createdFiles）。
 * 探测目录：工作区根 + 命令 cwd（绝对路径或相对工作区的子路径）。
 */
export function probeNpmGateContext(ctx: PromptContext, cwdArg: unknown): BashGateContext {
  const dirs: string[] = []
  if (ctx.workspace) dirs.push(ctx.workspace)
  if (ctx.workspace && typeof cwdArg === 'string' && cwdArg.trim()) {
    dirs.push(isAbsolute(cwdArg) ? cwdArg : resolve(ctx.workspace, cwdArg))
  }
  // createdFiles 中的 package.json 只有落在「探测目录根部」时才采信：
  // 模型把 package.json 写到工作区外（MCP 默认目录/其他盘）或深层子目录，
  // 不能为当前目录的 npm install 背书（实测漏洞：错误路径写入后顺序锁被误判放行）。
  const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase()
  const pkgCreated = Array.from(ctx.createdFiles).some((p) => {
    const n = norm(p)
    if (!n.endsWith('/package.json') && n !== 'package.json') return false
    if (!ctx.workspace) return false
    const abs = isAbsolute(p) ? p : resolve(ctx.workspace, p)
    return dirs.some((d) => norm(abs) === norm(join(d, 'package.json')))
  })
  const pkgOnDisk = dirs.some((d) => safeExists(join(d, 'package.json')))
  const nodeModulesOnDisk = dirs.some((d) => safeExists(join(d, 'node_modules')))
  // 内容级校验：npm init -y 生成的空壳 package.json（无 dependencies）不能为 npm install 背书。
  // 仅磁盘文件可读时判定；读不到（未落盘/仅 createdFiles 登记）保持 undefined 不拦。
  let pkgHasContent: boolean | undefined
  const pkgPath = dirs.map((d) => join(d, 'package.json')).find((p) => safeExists(p))
  if (pkgPath) {
    try {
      pkgHasContent = manifestContentOk(NODE_GATE_PROFILE, readFileSync(pkgPath, 'utf8'))
    } catch {
      pkgHasContent = undefined
    }
  }
  return {
    isProjectCreation: ctx.isProjectCreation,
    createdFiles: ctx.createdFiles,
    ranNpmInstall: ctx.ranNpmInstall,
    ranServe: ctx.ranServe,
    // 已创建（必须在探测目录内；含即将落盘的暂存场景）或磁盘真实存在
    packageJsonExists: pkgCreated || pkgOnDisk,
    nodeModulesExists: nodeModulesOnDisk,
    packageJsonHasContent: pkgHasContent
  }
}

/**
 * bash 命令失败分析：识别常见错误模式，返回修复建议。
 * 防止模型失败后盲目重试或 panic 切换做无关操作（如反复写 README）。
 *
 * @param result bash 执行结果
 * @param cmd 执行的命令
 * @param executed 已执行工具记录（用于检测连续失败次数）
 * @returns 修复建议文本；无需干预时返回 null
 */
export function analyzeBashFailure(
  result: string,
  cmd: string,
  executed: Map<string, string>
): string | null {
  // 交互式脚手架卡死：输出 preset/覆盖确认等箭头键选择提示
  if (/\?\s*please pick|\(use arrow keys\)|\?\s*overwrite|\?\s*target directory/i.test(result)) {
    return `⚠️ 检测到交互式命令正在等待键盘选择（preset/覆盖确认），Agent 无法响应，该命令永远不会完成。
请立即放弃此命令，改用 write 工具逐个创建项目文件（package.json、src/main.js 等），禁止再使用 vue create 等脚手架。`
  }

  // 命令不存在（Windows 'xxx 不是内部或外部命令' / Unix 'command not found'）
  const cmdNotFoundMatch = result.match(/'([^']+)'\s*不是内部或外部命令|(\S+)\s*:\s*command not found/i)
  if (cmdNotFoundMatch) {
    const missingCmd = cmdNotFoundMatch[1] || cmdNotFoundMatch[2]
    // vue/create-react-app 等脚手架缺失：不要尝试 npx 或全局安装，直接回到 write 建文件
    if (/^(vue|create-react-app|ng|svelte-scaffold)$/i.test(missingCmd)) {
      return `⚠️ 脚手架命令 "${missingCmd}" 不存在。禁止安装或用 npx 调用它——项目脚手架命令是交互式的且不可控。
请直接用 write 工具逐个写入项目文件（package.json、babel.config.js、src/main.js、src/App.vue 等），然后 npm install、npm run serve。`
    }
    return `⚠️ 命令 "${missingCmd}" 不存在（未全局安装或不在 PATH）。

建议：
1. 优先使用 npx 代替全局命令：npx ${missingCmd} ${cmd.replace(missingCmd, '').trim()}
2. 如需全局安装，执行：npm install -g ${missingCmd}
3. 本项目所有文件应通过 write 工具直接创建，无需依赖全局脚手架`
  }

  // JSON 解析失败：npm 秒退（1 秒内退出码非零）最常见根因——package.json 格式非法
  if (/is not valid JSON|Unexpected token[\s\S]{0,24}in JSON|Expected double-quoted property name|JSON\.parse/i.test(result)) {
    return `⚠️ 检测到 JSON 解析错误——大概率是 package.json 格式非法（缺逗号/多余逗号/引号不配对），导致命令秒退。
请立即：
1. 用 read 工具查看 package.json 全文定位语法错误；
2. 用 edit 工具精准修复该处（不要整文件重写）；
3. 修复后重新执行 npm install 验证。禁止不修复直接重跑同一命令。`
  }

  // npm 生命周期崩溃（ELIFECYCLE）：命令以非零退出码结束，真实报错在上方输出中
  if (/ELIFECYCLE/i.test(result)) {
    return `⚠️ npm 生命周期命令非零退出（ELIFECYCLE）。真实报错在本条命令输出的上方（stderr 栈）。
请先阅读上方完整报错：若是编译/语法错误，用 edit 工具精准修复对应文件后重跑；不要盲目重跑同一命令或跳过验证。`
  }

  // npm 权限/网络错误
  if (result.includes('npm ERR') || result.includes('npm error')) {
    return `⚠️ npm 执行失败。常见原因：
- 网络问题：切换 npm 镜像源（npm config set registry https://registry.npmmirror.com）
- 权限不足：检查目录写入权限
- 依赖冲突：删除 node_modules 和 package-lock.json 后重试
禁止跳过 npm install 直接写文件，必须先解决依赖安装问题`
  }

  // 目录不存在导致命令失败
  if (result.includes('The system cannot find the path') || result.includes('No such file or directory')) {
    return `⚠️ 目录不存在。请先调用 mkdir 或 create_directory 创建目录后再执行命令。禁止直接用 write 写入不存在的路径。`
  }

  return null
}

/**
 * 工具结果后处理：幂等性修正 + 文件树状态注入。
 * - mkdir/create_directory 目录已存在时改写为 Success，避免模型因"报错"反复重试
 * - write/create_directory 成功后追加当前已创建文件列表，让模型感知世界状态
 */
export function postProcessToolResult(
  name: string,
  args: Record<string, any>,
  result: string,
  ctx: PromptContext
): string {
  let final = result

  // 幂等性：mkdir / create_directory 目录已存在 → Success（而非 Error）
  const isMkdir =
    (name === 'bash' || name === 'run_terminal_command') &&
    typeof args.command === 'string' &&
    /\b(mkdir|md|new-item)\b/i.test(args.command)
  const isCreateDir = name === 'create_directory'
  if ((isMkdir || isCreateDir) && !final.startsWith('错误') && !final.startsWith('Error')) {
    // 已存在的标志：Windows "子目录或文件 X 已存在" / Unix "File exists" / MCP "already exists"
    if (/已存在|exists|already/i.test(final)) {
      final = `成功：目录已存在，无需重复创建。\n（原始输出：${final.slice(0, 150)}）`
    }
  }

  // 文件树状态注入：write / create_directory 成功后，告诉模型当前已创建的文件
  const isWrite = name === 'write' || name === 'write_file'
  if ((isWrite || isCreateDir) && !final.startsWith('错误') && !final.startsWith('Error')) {
    const files = Array.from(ctx.createdFiles)
    if (files.length > 0) {
      const tree = files.length <= 15
        ? files.join('\n')
        : files.slice(-15).join('\n') + `\n...（共 ${files.length} 个，仅显示最近 15 个）`
      final += `\n\n[当前文件树] 已创建 ${files.length} 个文件/目录：\n${tree}`
    }
  }

  return final
}

/** 路径归一化：小写 + 反斜杠转正斜杠，便于跨平台匹配 */
function normPath(p: string): string {
  return p.toLowerCase().replace(/\\/g, '/')
}

/**
 * 适配 PromptContext → ValidationContext（与 validateTaskCompletion 适配器一致）。
 * 把三个布尔标志位反向翻译为 executedCommands Map，供 runRule 判定 commandExecuted 规则。
 */
function adaptValidationCtx(ctx: PromptContext): ValidationContext {
  const executedCommands = new Map<string, string>()
  if (ctx.ranNpmInstall) executedCommands.set('npm install', '')
  if (ctx.ranServe) executedCommands.set('npm run serve', '')
  if (ctx.ranMkdir) executedCommands.set('mkdir', '')
  return {
    createdFiles: ctx.createdFiles,
    executedCommands,
    workspace: ctx.workspace ?? undefined
  }
}

/**
 * 从 Todo 文本中提取该任务所需文件的路径标识。
 * - 有注入 manifest（ctx.artifactManifest）：从 fileExists 规则提取 path，与 Todo 文本子串匹配
 * - 缺省（无注入）：回退旧硬编码 10 项（保兼容，项目创建无注入时行为等价）
 * 批量任务（如"创建 babel.config.js、vue.config.js、index.html"）会返回多个标识，
 * 必须全部出现在已创建文件中，任务才算完成。
 */
function fileHintsOf(todoContent: string, ctx?: PromptContext): string[] {
  const c = todoContent.toLowerCase()
  // 有注入 manifest：从 fileExists 规则提取 path，与 Todo 文本子串匹配
  if (ctx?.artifactManifest) {
    const hints: string[] = []
    for (const r of ctx.artifactManifest.rules) {
      if (r.kind === 'fileExists' && r.path) {
        // path 末段作为子串匹配键（如 src/main.js → main.js）
        const seg = r.path.split('/').pop()!.toLowerCase()
        if (c.includes(seg)) hints.push(r.path)
      }
    }
    return hints
  }
  // 缺省 manifest：回退旧硬编码 10 项
  const hints: string[] = []
  if (c.includes('package.json')) hints.push('package.json')
  if (c.includes('babel.config')) hints.push('babel.config.js')
  if (c.includes('vue.config')) hints.push('vue.config.js')
  if (c.includes('index.html')) hints.push('index.html')
  if (c.includes('main.js')) hints.push('main.js')
  if (c.includes('app.vue')) hints.push('app.vue')
  if (c.includes('router')) hints.push('router')
  if (c.includes('store')) hints.push('store')
  if (c.includes('helloworld')) hints.push('helloworld.vue')
  if (c.includes('readme')) hints.push('readme.md')
  return hints
}

/**
 * 判断单个 Todo 的完成条件是否已满足。
 * - 命令类 todo（npm install / serve / mkdir）：走布尔标志位（与 commandExecuted 规则语义一致）
 * - 有注入 manifest：对匹配的 fileExists 规则调 runRule 判定（全部通过才算完成）
 * - 缺省 manifest：回退旧硬编码 fileHintsOf + created 子串匹配（保兼容）
 */
export function isTodoSatisfied(
  todo: { content: string },
  ctx: PromptContext
): boolean {
  const c = todo.content
  // npm install / npm run serve 步骤：看执行标志位
  if (c.includes('npm install')) return ctx.ranNpmInstall
  if (c.includes('npm run serve') || c.includes('npm run dev')) return ctx.ranServe
  // 目录类任务：bash mkdir 成功，或 write 自动创建了父目录（已有任意文件）即视为存在
  if (/文件夹|目录/.test(c)) return !!ctx.ranMkdir || ctx.createdFiles.size > 0
  // 有注入 manifest：对匹配的 fileExists 规则调 runRule 判定（全部通过才算完成）
  if (ctx.artifactManifest) {
    const vctx = adaptValidationCtx(ctx)
    const matched = ctx.artifactManifest.rules.filter(
      (r) =>
        r.kind === 'fileExists' &&
        r.path &&
        c.toLowerCase().includes(r.path.split('/').pop()!.toLowerCase())
    )
    if (matched.length === 0) return false
    return matched.every((r) => runRule(r, vctx).passed)
  }
  // 缺省 manifest：文本中提到的每个文件都必须已创建
  const hints = fileHintsOf(c)
  if (hints.length === 0) return false
  const created = Array.from(ctx.createdFiles).map(normPath)
  return hints.every((h) => created.some((p) => p.includes(h)))
}

/**
 * 项目创建场景：根据工具调用自动更新 Todo 状态（带顺序锁）。
 * 规则：
 * 1. 只允许"第一个未完成项"被标记完成；其完成条件必须全部满足（批量任务要文件齐全）；
 *    满足后链式检查下一项（一次操作可能解锁多项）。
 * 2. 本次操作若属于更靠后的任务（跳序执行），不更新状态并返回警告文本，
 *    强制模型回到前置任务。
 * @returns 需要追加给模型的顺序违规警告；无警告返回 null
 */
export function autoUpdateTodos(
  todoStore: TodoStore,
  name: string,
  args: Record<string, any>,
  result: string,
  ctx: PromptContext
): string | null {
  const todos = todoStore.items
  if (todos.length === 0) return null

  // 1) 链式推进：从第一个未完成项开始，只要完成条件满足就连续标记
  let guard = 0
  let next = todoStore.nextIncomplete()
  while (next && guard < todos.length + 1) {
    guard++
    if (isTodoSatisfied(next, ctx)) {
      todoStore.handle({ action: 'update', id: next.id, status: 'completed' })
      next = todoStore.nextIncomplete()
    } else {
      break
    }
  }
  ctx.todosText = todoStore.render()
  const head = todoStore.nextIncomplete()
  if (!head) return null // 全部完成

  // 2) 判断本次操作归属的任务是否跳序（在当前任务之后）
  let targetId: number | null = null
  if ((name === 'write' || name === 'write_file') && typeof args.path === 'string') {
    const p = normPath(args.path)
    const target = todos.find((t) =>
      t.status !== 'completed' && fileHintsOf(t.content, ctx).some((h) => p.includes(h))
    )
    targetId = target ? target.id : null
  } else if ((name === 'bash' || name === 'run_terminal_command') && typeof args.command === 'string') {
    const cmd = args.command
    const ok = !result.startsWith('错误') && !result.startsWith('Error')
    const keyword = cmd.includes('npm run serve') || cmd.includes('npm run dev')
      ? 'npm run serve'
      : cmd.includes('npm install')
        ? 'npm install'
        : /\b(mkdir|md)\b/i.test(cmd) && ok
          ? '文件夹'
          : null
    if (keyword) {
      const target = todos.find((t) => t.status !== 'completed' && t.content.includes(keyword))
      targetId = target ? target.id : null
    }
  }

  if (targetId !== null && targetId !== head.id) {
    return `⚠ 顺序锁：当前必须先完成 #${head.id}（${head.content}），` +
      `你刚才的操作属于 #${targetId}。前置任务未完成时后续操作不会被登记，` +
      '请立即回到 #' + head.id + '，严格按清单顺序执行。'
  }
  return null
}

/**
 * 项目创建验证锁（硬约束）：检查关键产物是否齐全、npm 验证是否执行。
 * 全部通过时返回 null（允许收尾），否则返回强制继续的消息。
 *
 * 验证项（缺一不可）：
 * 1. package.json 存在
 * 2. src/main.js 存在
 * 3. src/App.vue 存在
 * 4. npm install 已执行成功
 * 5. npm run serve 已执行
 *
 * P1⑯ 重构为薄壳：把硬编码 5 项委托给 validation.ts 的 vueScaffoldManifest 预置规则，
 * 行为与旧实现逐字等价（消息模板、缺失项顺序、尾巴「当前已创建 N 个文件」全部对齐）。
 * 通用化能力：未来任何任务只要构造 ArtifactManifest 赋给 ctx，收尾就会自动走 runValidation。
 */
// ============ 当前会话验证状态（模块级单例）============
// 供 IPC getCurrent/setCurrent 读写：前端 ValidationPanel 展示与编辑当前 manifest 与 ctx 快照。
// currentTaskCtx 在 runWithTools 入口存入（PromptContext 引用，createdFiles 共享同一 Set，实时反映进度）。
let currentTaskManifest: ArtifactManifest | null = null
let currentTaskCtx: PromptContext | null = null

/**
 * 路径归一化：剥掉绝对路径前缀，只保留项目内的相对路径（与 validateTaskCompletion 同源）。
 * 覆盖三种形态：绝对路径、带 targetDir 前缀路径、已是相对路径。
 */
function normalizeCreatedFilesForValidation(
  files: Set<string>,
  targetDir?: string | null
): Set<string> {
  const normalizePath = (p: string): string => {
    let n = p.replace(/\\/g, '/')
    if (targetDir) {
      const td = targetDir.replace(/\\/g, '/')
      const idx = n.toLowerCase().indexOf('/' + td.toLowerCase() + '/')
      if (idx >= 0) n = n.slice(idx + td.length + 2)
    }
    // 兜底：从最后一个常见的项目目录标记开始截取
    const m = n.match(/\/(package\.json|src\/|public\/|babel\.config\.js|vue\.config\.js|index\.html|README\.md)/i)
    if (m && m.index !== undefined) n = n.slice(m.index + 1)
    return n
  }
  return new Set(Array.from(files).map(normalizePath))
}

/**
 * 取当前会话的 manifest + 适配后的 ValidationContext 快照。
 * 任务未运行时 ctx 为 null；运行中返回的 ctx.createdFiles 与 scheduler 内部共享同一 Set，实时反映进度。
 */
export function getValidationState(): {
  manifest: ArtifactManifest | null
  ctx: ValidationContext | null
} {
  const ctx = currentTaskCtx
  if (!ctx) return { manifest: currentTaskManifest, ctx: null }
  // 适配器：与 validateProjectCreation 一致，把三个布尔标志位反向翻译为 executedCommands Map
  const executedCommands = new Map<string, string>()
  if (ctx.ranNpmInstall) executedCommands.set('npm install', '')
  if (ctx.ranServe) executedCommands.set('npm run serve', '')
  if (ctx.ranMkdir) executedCommands.set('mkdir', '')
  // 路径归一化：与 validateTaskCompletion 同源，前端面板与验证层看到的路径一致
  const createdFiles = normalizeCreatedFilesForValidation(ctx.createdFiles, ctx.targetDir)
  return {
    manifest: currentTaskManifest,
    ctx: {
      createdFiles,
      executedCommands,
      workspace: ctx.workspace ?? undefined
    }
  }
}

/** 前端编辑后写回 manifest（影响下一次收尾校验；generatePlan 解析出的 manifest 也会写入此单例） */
export function setValidationManifest(m: ArtifactManifest | null): void {
  currentTaskManifest = m
}

export function validateTaskCompletion(ctx: PromptContext): string | null {
  const manifest = ctx.artifactManifest ?? (ctx.isProjectCreation ? vueScaffoldManifest : null)
  if (!manifest) return null

  // ✅ 路径归一化：剥掉绝对路径前缀，只保留项目内的相对路径
  // 覆盖三种形态：绝对路径、带 targetDir 前缀路径、已是相对路径
  const targetDir = ctx.targetDir
  const normalizePath = (p: string): string => {
    let n = p.replace(/\\/g, '/')
    if (targetDir) {
      const td = targetDir.replace(/\\/g, '/')
      const idx = n.toLowerCase().indexOf('/' + td.toLowerCase() + '/')
      if (idx >= 0) n = n.slice(idx + td.length + 2)
    }
    // 兜底：从最后一个常见的项目目录标记开始截取
    const m = n.match(/\/(package\.json|src\/|public\/|babel\.config\.js|vue\.config\.js|index\.html|README\.md)/i)
    if (m && m.index !== undefined) n = n.slice(m.index + 1)
    return n
  }

  const normalizedCreated = new Set(Array.from(ctx.createdFiles).map(normalizePath))

  const executedCommands = new Map<string, string>()
  if (ctx.ranNpmInstall) executedCommands.set('npm install', '')
  if (ctx.ranServe) executedCommands.set('npm run serve', '')
  if (ctx.ranMkdir) executedCommands.set('mkdir', '')

  const vctx: ValidationContext = {
    createdFiles: normalizedCreated,
    executedCommands,
    workspace: ctx.workspace ?? undefined
  }
  const summary = runValidation(manifest, vctx)
  return summary.message
}

/**
 * 兼容别名（一期 6 例单测与历史调用点仍用此名）。
 * 行为等价：内部转发 validateTaskCompletion，ctx.artifactManifest 缺省时回退 vueScaffold。
 */
export function validateProjectCreation(ctx: PromptContext): string | null {
  return validateTaskCompletion(ctx)
}

// ==================== 三模型 DAG 驱动执行 ====================

/**
 * DAG 驱动执行循环（三模型模式）。
 * Planner 已生成 DAG，Executor(8B) 按 ready 节点顺序执行，复杂节点路由 Coder。
 */
async function runWithDag(
  provider: NonNullable<ReturnType<typeof getProvider>>,
  modelName: string,
  messages: AiMessage[],
  tools: { server: string; tool: any }[],
  events?: ToolsEvents,
  workspace?: string | null,
  dag?: TaskDag,
  targetDir?: string | null,
  agentsMd: string | null = null,
  rulesText: string | null = null,
  notesText: string = '',
  currentFile: string | null = null,
  signal?: AbortSignal,
  traceDir?: string,
  environmentReport: string = '',
  taskControl?: TaskControlOptions,
  gate?: TaskControlGate
): Promise<string> {
  if (!dag) return '错误：DAG 为空'

  // 创建 DAG 运行态
  const dagState = createDagState(dag)
  const skills = await listSkills(workspace)
  const recommendedSet = recommendSkills(
    skills,
    [...messages].reverse().find((m) => m.role === 'user')?.content ?? ''
  )

  // 运行时协调工具（与 runWithTools 相同）
  const todoStore = new TodoStore()
  const runtimeTools: McpToolEntry[] = [
    {
      server: 'runtime',
      tool: {
        name: 'todo_write',
        description: '任务规划与状态跟踪。',
        inputSchema: { type: 'object', properties: { action: { type: 'string' } } }
      }
    },
    {
      server: 'runtime',
      tool: {
        name: 'list_skills',
        description: '列出可用技能包。',
        inputSchema: { type: 'object', properties: {} }
      }
    },
    {
      server: 'runtime',
      tool: {
        name: 'use_skill',
        description: '加载技能包全文。',
        inputSchema: { type: 'object', properties: { name: { type: 'string' } } }
      }
    }
  ]
  const allTools: McpToolEntry[] = [...runtimeTools, ...tools]
  const runtimeNames = new Set(runtimeTools.map((t) => t.tool.name))

  // 权限关卡
  const askUser = (req: PermissionRequest): Promise<UserPermissionResponse> =>
    events?.onPermissionRequest?.(req) ?? Promise.resolve({ decision: 'deny' as const, reason: '无审批通道' })
  const permissionGate = new PermissionGate(workspace, askUser)

  const runners: Record<string, (args: any) => Promise<string>> = {
    todo_write: async (args: TodoWriteArgs) => {
      const result = todoStore.handle(args)
      ctx.todosText = todoStore.render()
      events?.onTodo?.(todoStore.items)
      return result
    },
    list_skills: async () =>
      renderSkillList(skills, recommendedSet) || '暂无可用技能包',
    use_skill: async (args) => {
      const name = String(args?.name || '')
      if (!skills.some((s) => s.name === name)) return `错误：未知技能 ${name}`
      return loadSkill(workspace, name)
    }
  }

  // 观察者状态：读取黑名单连击计数 + 干预防抖
  const observerState = createObserverState()

  // Agent 上下文
  const ctx: PromptContext = {
    workspace,
    currentFile,
    plan: JSON.stringify(dag), // DAG JSON 作为 plan
    isProjectCreation: true,
    createdFiles: new Set<string>(),
    ranNpmInstall: false,
    ranServe: false,
    ranMkdir: false,
    round: 0,
    stallRestarts: 0,
    agentsMd,
    rulesText,
    notesText,
    mcpServers: listMcpServers(),
    skillsText: renderSkillList(skills, recommendedSet),
    todosText: '',
    tools: allTools.map((t) => ({ name: t.tool.name, description: t.tool.description })),
    artifactManifest: currentTaskManifest,
    environmentReport,
    targetDir: targetDir ?? null,
    dagState: dagState,
    observerState: serializeObserverState(observerState)
  }
  currentTaskCtx = ctx

  // 对话历史
  let convo: AiMessage[] = [...messages]
  const executed = new Map<string, string>()
  const failedReadPaths = new Set<string>()
  const replanState = createReplanState()
  let batchInterrupted = false
  let blockedDrift: DriftReport | null = null
  let lastContent = ''
  // L4 运行时验证输入：最近一次 serve/dev/start 启动命令与输出（ranServe 置位时同步记录）
  let lastServeCmd = ''
  let lastServeOutput = ''
  // 同命令防抖：60 秒内同命令执行 2 次后第 3 次拦截
  const commandHistory = new Map<string, number[]>()

  const taskId = `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const startedAt = Date.now()
  const log = getLogger('scheduler')
  log.info(`DAG 任务启动 taskId=${taskId} targetDir=${targetDir ?? '(root)'}`)

  events?.onTaskControl?.({ taskId, phase: 'started', preTaskCheckpoint: taskControl?.preTaskCheckpoint ?? null })

  // 切到 Executor
  const sw = await safeSwitch('executor', { signal })
  if (!sw.ok) {
    return `错误：无法加载 Executor 模型：${sw.error}`
  }
  events?.onModelCall?.(sw.choice.profile.name, 'DAG 执行')

  const ollamaTools = allTools.map((t) => ({
    type: 'function',
    function: {
      name: t.tool.name,
      description: t.tool.description || '',
      parameters: t.tool.inputSchema ?? { type: 'object', properties: {} }
    }
  }))

  const persist = (status: TaskStatus): void => {
    if (!taskControl) return
    void (async (): Promise<void> => {
      const snapshot = buildTaskSnapshot(
        {
          taskId,
          workspace: taskControl.workspace,
          modelId: `${provider.id}:${modelName}`,
          sessionId: taskControl.sessionId,
          startRound: 0,
          convo,
          ctx,
          todoSeq: todoStore.getSeq(),
          todos: todoStore.items,
          replan: replanState,
          executed,
          counters: { stallCount: 0, stallRestarts: 0, dedupStallCount: 0 },
          preTaskCheckpoint: taskControl.preTaskCheckpoint,
          stagedChanges: null,
          startedAt
        },
        { status, updatedAt: Date.now() }
      )
      saveTaskSnapshot(taskControl.workspace, snapshot)
    })().catch(() => {})
  }

  const finishByAbort = (): string => {
    persist('aborted')
    return (lastContent.trim() ? lastContent.trim() + '\n\n' : '') + '（任务已被用户中止）'
  }

  const finishBlocked = (drift: DriftReport): never => {
    persist('interrupted')
    const head =
      '⛔ 任务已被系统强制中断：检测到关键产物缺失。\n' +
      '请点击「重试任务」按固定流程补齐。\n' +
      formatDriftReport(drift)
    throw new TaskBlockedError(drift, (lastContent.trim() ? lastContent.trim() + '\n\n' : '') + head)
  }

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      await gate?.parkIfPausing(signal)
      if (signal?.aborted) return finishByAbort()

      // 当前 ready 节点
      const ready = readyNodes(dagState)
      if (ready.length === 0) {
        // 所有节点完成或失败
        const failed = Object.entries(dagState.status).filter(([, s]) => s === 'failed')
        if (failed.length > 0) {
          const drift: DriftReport = {
            items: failed.map(([id, s]) => ({
              kind: 'missingArtifact',
              severity: 'block',
              detail: `节点 ${id} 执行失败：${dagState.results[id] ?? '未知错误'}`
            })),
            hasBlock: true,
            hasWarn: false
          }
          finishBlocked(drift)
        }
        break // 全部完成
      }

      // 每轮重建系统提示词
      ctx.round = round
      ctx.stallRestarts = 0
      ctx.currentTodo = ready.map((n) => `#${n.id} ${n.action}`).join('；')
      ctx.roleHint = roleEnvironmentHint('executor', targetDir ?? null)

      const agentSystem: AiMessage = { role: 'system', content: buildAgentPrompt(ctx) }
      const compacted = await compactIfNeeded(convo, async (text) => {
        try {
          const res = await provider.chat({
            messages: [{ role: 'user', content: `请用一段纯中文摘要以下对话的关键信息：\n\n${text}` }],
            signal
          })
          return res.ok ? (res.content ?? null) : null
        } catch {
          return null
        }
      }, { historyBudgetTokens: 4096 })

      const current: AiMessage[] = [agentSystem, ...compacted]
      events?.onModelCall?.(modelName, round === 0 ? '执行' : `第${round + 1}轮`)

      const res = await provider.chat({
        messages: current,
        tools: ollamaTools.length > 0 ? ollamaTools : undefined,
        signal
      })

      if (!res.ok && (signal?.aborted || res.error === '已中止')) return finishByAbort()
      if (!res.ok) throw new Error(res.error || '模型调用失败')

      lastContent = res.content || ''
      let toolCalls = (res.toolCalls as any[]) ?? []
      if (toolCalls.length === 0) {
        const parsed = parseToolCallsFromContent(lastContent, allTools)
        if (parsed.length > 0) {
          toolCalls = parsed
          lastContent = ''
        }
      }
      toolCalls = dedupeBatchCalls(toolCalls)

      if (toolCalls.length === 0) {
        // 无工具调用：检查是否全部完成
        if (ready.length === 0) break
        convo.push({ role: 'assistant', content: lastContent } as AiMessage)
        convo.push({
          role: 'user',
          content: `当前就绪节点：${ready.map((n) => `${n.id}(${n.action})`).join('、')}。请继续执行。`
        } as AiMessage)
        continue
      }

      convo.push({ role: 'assistant', content: lastContent } as AiMessage)

      // 执行工具调用
      for (const tc of toolCalls) {
        await gate?.parkIfPausing(signal)
        if (signal?.aborted) break

        const name = tc.function?.name
        const rawArgs = tc.function?.arguments
        let parsedArgs: any
        try {
          parsedArgs = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs
        } catch {
          parsedArgs = {}
        }
        let args = coerceToolArgs(parsedArgs, workspace)
        const cmd = typeof args?.command === 'string' ? args.command : ''

        // 运行时协调工具
        if (runtimeNames.has(name)) {
          events?.onToolCall?.(name, args)
          const runtimeResult = await runners[name]?.(args) ?? `错误：运行时工具 ${name} 不可用`
          convo.push({ role: 'tool', content: runtimeResult, name } as AiMessage)
          events?.onToolResult?.(name, runtimeResult)
          continue
        }

        // 路径劫持
        if (args?.path && typeof args.path === 'string') {
          const vfs = resolveVfsPath(args.path, workspace ?? '', targetDir)
          if (!vfs.ok) {
            const block = `错误：【路径劫持】${vfs.error}`
            convo.push({ role: 'tool', content: block, name } as AiMessage)
            events?.onToolResult?.(name, block)
            continue
          }
          args.path = vfs.absPath
        }

        // 越序拦截
        const violation = checkOrderViolation(dagState, name ?? '', args)
        if (violation) {
          noteFailure(replanState, 'preflightBlock', violation)
          events?.onToolCall?.(name, args)
          convo.push({ role: 'tool', content: violation, name } as AiMessage)
          events?.onToolResult?.(name, violation)
          continue
        }

        // 读取黑名单
        if (READ_LIKE_TOOLS.has(name ?? '')) {
          const target = readTargetOf(args)
          if (target && failedReadPaths.has(target)) {
            const block = `错误：【系统拦截】路径 ${target} 此前已确认不存在，禁止重复读取。`
            noteFailure(replanState, 'preflightBlock', block)
            events?.onToolCall?.(name, args)
            convo.push({ role: 'tool', content: block, name } as AiMessage)
            events?.onToolResult?.(name, block)

            // 观察者干预：连续触发读取黑名单达阈值时，切到 14B 诊断
            if (noteReadFailure(observerState, target)) {
              log.warn(`[Observer] 读取黑名单连击触发，切换 14B 诊断：${target}`)
              const intervention = await runObserverIntervention(
                target,
                convo,
                ctx,
                observerState,
                provider,
                signal
              )
              if (intervention) {
                convo.push({ role: 'user', content: intervention } as AiMessage)
                log.info(`[Observer] 干预指令已注入 convo`)
              } else {
                // 观察者干预失败（模型切换/诊断解析失败）也计入重规划信号
                noteFailure(replanState, 'commandFailure', `观察者干预失败：${target}`)
              }
            }
            continue
          }
        }

        // 权限关卡
        const gateResult = await permissionGate.check(name, args ?? {}, () => Promise.resolve())
        if (!gateResult.allowed) {
          const denied = `错误：操作未被允许：${gateResult.reason}。`
          convo.push({ role: 'tool', content: denied, name } as AiMessage)
          events?.onToolResult?.(name, denied)
          continue
        }

        // 同命令防抖：60 秒内同命令执行 2 次后第 3 次拦截（防止 npm run dev 秒退死循环）
        if ((name === 'start_background_task' || name === 'run_terminal_command' || name === 'bash') && cmd) {
          const now = Date.now()
          const history = commandHistory.get(cmd) ?? []
          const recent = history.filter((t) => now - t < 60_000)
          if (recent.length >= 2) {
            const block =
              `错误：【防抖拦截】命令 "${cmd}" 在 60 秒内已被执行 ${recent.length} 次且均秒退。` +
              '判定为死循环，禁止重复执行。' +
              '请先用 read_file 或 list_directory 定位缺失的依赖/配置，修复后再尝试。'
            noteFailure(replanState, 'preflightBlock', block)
            events?.onToolCall?.(name, args)
            convo.push({ role: 'tool', content: block, name } as AiMessage)
            events?.onToolResult?.(name, block)
            batchInterrupted = true
            break
          }
          recent.push(now)
          commandHistory.set(cmd, recent)
        }

        // 复杂度路由：write/edit 节点标记 complexity=high 时切换到 Coder 生成内容
        const matchedReadyNode = ready.find((n) => n.action === name)
        if (
          matchedReadyNode &&
          matchedReadyNode.complexity === 'high' &&
          (name === 'write' || name === 'write_file' || name === 'edit')
        ) {
          const coderResult = await runCoderForNode(matchedReadyNode, args, ctx, targetDir ?? null, provider, signal)
          if (coderResult) {
            // Coder 产出内容：write 覆盖 args.content，edit 覆盖 args.new_string
            args = { ...args, ...coderResult }
            log.info(`[Coder] 节点 ${matchedReadyNode.id} 已切换 Coder 生成`)
          } else {
            log.warn(`[Coder] 节点 ${matchedReadyNode.id} Coder 生成失败，回退 Executor`)
          }
        }

        // 执行工具
        events?.onToolCall?.(name, args)
        const found = allTools.find((t) => t.tool.name === name)
        const result = found
          ? await callMcpTool(found.server, name, args, workspace, signal)
          : `错误：未找到工具 ${name}`

        // 标记 DAG 节点状态
        const matchedNode = ready.find((n) => n.action === name)
        if (matchedNode) {
          if (result.startsWith('错误') || result.startsWith('Error')) {
            markFailed(dagState, matchedNode.id, result)
          } else {
            markDone(dagState, matchedNode.id, result)
          }
        }

        convo.push({ role: 'tool', content: result, name } as AiMessage)
        events?.onToolResult?.(name, result)

        // 追踪 createdFiles
        if ((name === 'write' || name === 'write_file') && args?.path) {
          ctx.createdFiles.add(String(args.path))
        }
        if (name === 'start_background_task' || name === 'bash' || name === 'run_terminal_command') {
          if (/\bnpm\s+(install|i|ci)\b/.test(cmd)) ctx.ranNpmInstall = true
          if (/\bnpm\s+run\s+(serve|dev|start)\b/.test(cmd)) {
            ctx.ranServe = true
            // 记录最近一次启动命令与输出，供 L4 运行时验证推断端口/打包诊断
            lastServeCmd = cmd
            lastServeOutput = result
          }
        }

        // FAST_FAIL_BREAKER：命令 <1000ms 非零崩溃 → 立即中止当前批次，强制模型停下来修复
        if ((name === 'bash' || name === 'run_terminal_command' || name === 'start_background_task')
            && result.includes(FAST_FAIL_BREAKER_TAG)) {
          noteFailure(replanState, 'commandFailure', `${cmd || name}\n秒退熔断`)
          convo.push({ role: 'tool', content: result, name } as AiMessage)
          events?.onToolResult?.(name, result)
          convo.push({
            role: 'user',
            content:
              '⛔ 秒退熔断：命令在 1 秒内崩溃退出，当前批次已强制中断。严格执行上方工具结果中的【致命错误】指令：' +
              '先 read_file / list_directory 定位并修复源码（通常是文件缺失或语法错误），修复完成前禁止执行任何后续命令。'
          } as AiMessage)
          batchInterrupted = true
          break
        }
      }

      if (batchInterrupted) break
    }

    // 收尾：验证锁
    const validationMsg = validateTaskCompletion(ctx)
    if (validationMsg) {
      noteFailure(replanState, 'validationBlock', validationMsg)
      const drift: DriftReport = {
        items: [{ kind: 'missingArtifact', severity: 'block', detail: validationMsg }],
        hasBlock: true,
        hasWarn: false
      }
      finishBlocked(drift)
    }

    // L3 语义验证：依赖闭环检查（失败时 Coder 生成修复补丁走 staging）
    const l3Result = await runSemanticValidation(ctx, workspace ?? '', targetDir ?? null, provider, signal)
    if (l3Result) {
      noteFailure(replanState, 'validationBlock', l3Result)
      const drift: DriftReport = {
        items: [{ kind: 'missingArtifact', severity: 'block', detail: l3Result }],
        hasBlock: true,
        hasWarn: false
      }
      finishBlocked(drift)
    }

    // L4 运行时验证：dev server 探测（失败时 14B 观察者在用户通道诊断）
    if (ctx.ranServe && lastServeCmd) {
      const l4Result = await runRuntimeValidation(
        lastServeCmd,
        lastServeOutput,
        ctx,
        workspace ?? '',
        targetDir ?? null,
        provider,
        signal
      )
      if (l4Result) {
        noteFailure(replanState, 'validationBlock', l4Result)
        const drift: DriftReport = {
          items: [{ kind: 'missingArtifact', severity: 'block', detail: l4Result }],
          hasBlock: true,
          hasWarn: false
        }
        finishBlocked(drift)
      }
    }

    persist('completed')
    return lastContent.trim() || '任务完成'
  } catch (err) {
    if (err instanceof TaskBlockedError) throw err
    persist('aborted')
    throw err
  }
}

/**
 * 安全切换包装：永不抛异常，失败返回 null；成功返回 SwitchResult。
 * 所有 L2/L3/L4/Coder 路径通过本函数调用，保证「可捕获、可显示、可降级」。
 */
async function safeSwitchOrNull(
  role: 'planner' | 'executor' | 'coder' | 'observer',
  opts?: { signal?: AbortSignal }
): Promise<Extract<Awaited<ReturnType<typeof safeSwitch>>, { ok: true }> | null> {
  try {
    const r = await safeSwitch(role, opts)
    if (r.ok) return r
    // 失败已通过 safeSwitch 内部 executor 兜底降级；此处仅日志
    console.warn(`[TraeCode] safeSwitch(${role}) 失败:`, r.error)
    return null
  } catch (err) {
    console.warn(`[TraeCode] safeSwitch(${role}) 异常:`, err instanceof Error ? err.message : err)
    return null
  }
}

/**
 * 观察者干预：读取黑名单连击触发后，切换到 Planner(14B) 进行诊断。
 * 返回注入 convo 的指令文本；诊断失败返回 null。
 */
async function runObserverIntervention(
  failedPath: string,
  convo: AiMessage[],
  ctx: PromptContext,
  observerState: ReturnType<typeof createObserverState>,
  provider: NonNullable<ReturnType<typeof getProvider>>,
  signal?: AbortSignal
): Promise<string | null> {
  // 打包失败轨迹（最近 6 条消息）
  const trace = convo
    .slice(-6)
    .map((m) => `[${m.role}] ${typeof m.content === 'string' ? m.content.slice(0, 200) : ''}`)
    .join('\n')
  const ctxSummary = [
    `已创建文件：${Array.from(ctx.createdFiles).slice(-5).join('、') || '(无)'}`,
    `目标目录：${ctx.targetDir ?? '(根目录)'}`,
    `观察者已触发：${observerState.triggerCount} 次`
  ].join('\n')

  // 切换到 Planner
  const sw = await safeSwitchOrNull('planner', { signal })
  if (!sw) return null
  const plannerModel = sw.choice.profile.name

  const prompt = buildObserverPrompt(failedPath, trace, ctxSummary)
  const res = await provider.chat({
    messages: [
      { role: 'system', content: '你是任务诊断专家，只输出 JSON 格式的诊断结论。' },
      { role: 'user', content: prompt }
    ],
    signal
  })

  // 切回 Executor(8B)（失败不阻塞主流程）
  await safeSwitchOrNull('executor', { signal })

  if (!res.ok) return null
  const verdict = parseObserverVerdict(res.content ?? '')
  if (!verdict.ok) return null

  if (verdict.verdict.kind === 'strategy') {
    return `【观察者干预】${verdict.verdict.instruction}`
  }
  // codefix：注入修复指令（含目标文件清单）
  const files = verdict.verdict.targetFiles.join('、')
  return `【观察者干预】${verdict.verdict.instruction}\n需要修复的文件：${files}`
}

/**
 * L3 语义验证：依赖闭环检查。
 * 读取 targetDir 下 package.json 与已创建源码文件，提取 import/require 包名求差集。
 * 有缺失时切换 Coder 生成修复补丁（完整文件内容），预检后走 staging 审阅通道落盘。
 * @returns null = 通过/不适用；非 null = 阻断消息（finishBlocked 收尾）
 */
async function runSemanticValidation(
  ctx: PromptContext,
  workspace: string,
  targetDir: string | null,
  provider: NonNullable<ReturnType<typeof getProvider>>,
  signal?: AbortSignal
): Promise<string | null> {
  if (!workspace) return null

  // 1. 读取 package.json（不存在则跳过 L3）
  const pkgVfs = resolveVfsPath('package.json', workspace, targetDir)
  if (!pkgVfs.ok || !existsSync(pkgVfs.absPath)) return null
  let pkgContent: string
  try {
    pkgContent = readFileSync(pkgVfs.absPath, 'utf-8')
  } catch {
    return null
  }

  // 2. 收集已创建源码文件内容（限 30 个，防上下文爆炸）
  const SOURCE_EXTS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.vue'])
  const files = new Map<string, string>()
  for (const created of ctx.createdFiles) {
    if (files.size >= 30) break
    const ext = created.toLowerCase().match(/(\.[a-z0-9]+)$/)?.[1] ?? ''
    if (!SOURCE_EXTS.has(ext)) continue
    const vfs = resolveVfsPath(created, workspace, null) // createdFiles 已是绝对/工作区相对路径
    const abs = vfs.ok ? vfs.absPath : created
    try {
      if (existsSync(abs)) {
        const rel = targetDir && abs.includes(targetDir.replace(/\//g, sep))
          ? abs.slice(abs.indexOf(targetDir.replace(/\//g, sep)) + targetDir.length + 1)
          : abs
        files.set(rel, readFileSync(abs, 'utf-8'))
      }
    } catch { /* 单文件读取失败跳过 */ }
  }
  if (files.size === 0) return null

  // 3. 依赖闭环差集
  const issues = checkDependencyClosure(files, pkgContent)
  if (issues.length === 0) return null

  // 4. 切换 Coder 生成修复补丁
  const sw = await safeSwitchOrNull('coder', { signal })
  if (!sw) return `L3 语义验证发现 ${issues.length} 个未声明依赖（${issues.map((i) => i.package).join('、')}），但 Coder 模型加载失败`
  const coderModel = sw.choice.profile.name

  const prompt = buildCoderRepairPrompt(issues, files)
  const res = await provider.chat({
    messages: [
      { role: 'system', content: roleEnvironmentHint('coder', targetDir) },
      { role: 'user', content: prompt }
    ],
    signal
  })
  // 切回 Executor（收尾前恢复驻留角色；失败不阻塞）
  await safeSwitchOrNull('executor', { signal })

  if (!res.ok) return `L3 语义验证：Coder 调用失败（${res.error}）。缺失依赖：${issues.map((i) => i.package).join('、')}`

  // 5. 解析补丁 + 预检
  const parsed = parseCoderPatches(res.content ?? '')
  if (!parsed.ok) return `L3 语义验证：Coder 补丁解析失败（${parsed.error}）。缺失依赖：${issues.map((i) => i.package).join('、')}`

  const check = await validatePatches(parsed.patches, { workspace, targetDir })
  if (!check.ok) return `L3 语义验证：补丁预检未通过（${check.error}）`

  // 6. 走 staging 审阅通道落盘
  for (const patch of parsed.patches) {
    const vfs = resolveVfsPath(patch.file, workspace, targetDir)
    if (!vfs.ok) return `L3 语义验证：补丁路径越界（${patch.file}）`
    const r = await commitStaged(workspace, { op: 'write', path: vfs.absPath, content: patch.content })
    if (!r.ok) return `L3 语义验证：补丁落盘失败（${patch.file}）：${r.result}`
  }
  return null
}

/**
 * L4 运行时验证：npm run serve 后探测 dev server 是否真正可访问。
 * 流程：推断端口（vue.config.js devServer.port / vite 5173 / 缺省 8080）→ probeDevServer 轮询 →
 *       失败时切 Planner(14B) 打包诊断文本，verdict 作为阻断原因由调用方 finishBlocked。
 * @returns null = 探测通过；非 null = 阻断消息
 */
async function runRuntimeValidation(
  serveCmd: string,
  serveOutput: string,
  ctx: PromptContext,
  workspace: string,
  targetDir: string | null,
  provider: NonNullable<ReturnType<typeof getProvider>>,
  signal?: AbortSignal
): Promise<string | null> {
  if (!workspace) return null

  // 1. 读取 vue.config.js 推断端口
  let vueConfigContent: string | null = null
  const vueCfgVfs = resolveVfsPath('vue.config.js', workspace, targetDir)
  if (vueCfgVfs.ok && existsSync(vueCfgVfs.absPath)) {
    try {
      vueConfigContent = readFileSync(vueCfgVfs.absPath, 'utf-8')
    } catch { /* 读取失败按 null 处理 */ }
  }
  const port = inferPort(serveCmd, vueConfigContent)

  // 2. 探测 dev server
  const probe = await probeDevServer({ port, signal })
  if (probe.ok) return null

  // 3. 探测失败：切 Planner(14B) 在用户通道诊断
  const sw = await safeSwitchOrNull('planner', { signal })
  if (!sw) {
    return `L4 运行时验证失败：dev server 在 ${port} 端口不可访问（${probe.error ?? '未知错误'}），且 Planner 模型加载失败`
  }
  const plannerModel = sw.choice.profile.name

  const diagnosis = buildRuntimeDiagnosis(
    probe,
    serveCmd,
    serveOutput,
    Array.from(ctx.createdFiles)
  )
  const res = await provider.chat({
    messages: [
      { role: 'system', content: '你是任务诊断专家，只输出 JSON 格式的诊断结论。' },
      { role: 'user', content: diagnosis }
    ],
    signal
  })

  // 切回 Executor（保持驻留角色一致；失败不阻塞）
  await safeSwitchOrNull('executor', { signal })

  if (!res.ok) {
    return `L4 运行时验证失败：dev server 在 ${port} 端口不可访问（${probe.error ?? '未知错误'}）。Planner 诊断调用失败：${res.error}`
  }
  const verdict = parseObserverVerdict(res.content ?? '')
  if (!verdict.ok) {
    return `L4 运行时验证失败：dev server 在 ${port} 端口不可访问（${probe.error ?? '未知错误'}）。Planner 诊断解析失败：${verdict.error}`
  }
  if (verdict.verdict.kind === 'strategy') {
    return `L4 运行时验证失败（${port} 端口不可访问）：${verdict.verdict.instruction}`
  }
  const files = verdict.verdict.targetFiles.join('、')
  return `L4 运行时验证失败（${port} 端口不可访问）：${verdict.verdict.instruction}\n需修复文件：${files}`
}

/**
 * 复杂度路由：对标记 complexity='high' 的 write/edit 节点切换 Coder 生成内容。
 * 返回需要合并到 args 的字段（如 content 或 new_string），生成失败返回 null。
 */
async function runCoderForNode(
  node: import('./taskDag').DagNode,
  args: Record<string, unknown>,
  ctx: PromptContext,
  targetDir: string | null,
  provider: NonNullable<ReturnType<typeof getProvider>>,
  signal?: AbortSignal
): Promise<Record<string, unknown> | null> {
  const path = String(args.path ?? '')
  if (!path) return null

  const sw = await safeSwitchOrNull('coder', { signal })
  if (!sw) return null
  const coderModel = sw.choice.profile.name

  let prompt = ''
  if (node.action === 'edit') {
    const oldStr = String(args.old_string ?? '')
    prompt = [
      `【复杂编辑】请修改文件 ${path}：`,
      '',
      'old_string：',
      '```',
      oldStr || '(未指定)',
      '```',
      '',
      '要求：输出修改后的完整文件内容（不使用 diff）。',
      '格式：只返回文件正文，不要包裹代码块。'
    ].join('\n')
  } else {
    prompt = [
      `【复杂写入】请生成文件 ${path} 的完整内容。`,
      '',
      '节点描述：',
      JSON.stringify(node.args, null, 2),
      '',
      '要求：输出完整文件内容，不要包裹代码块。'
    ].join('\n')
  }

  const res = await provider.chat({
    messages: [
      { role: 'system', content: roleEnvironmentHint('coder', targetDir) },
      { role: 'user', content: prompt }
    ],
    signal
  })

  // 切回 Executor
  await safeSwitchOrNull('executor', { signal })

  if (!res.ok || !res.content) return null

  const content = res.content.trim()
  if (!content) return null

  if (node.action === 'edit') {
    return { new_string: content }
  }
  return { content }
}
