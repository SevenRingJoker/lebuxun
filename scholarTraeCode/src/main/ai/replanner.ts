// 动态重规划（Self-Reflection）纯函数层。
//
// 问题背景：原主循环只有 stallCount≥5 的「停滞重启」——注入一句提示词让模型重试，
// 连续命令失败 / 反复撞 bash 门控 / 验证锁拦截时，模型容易在同一条死路上空转。
// 本模块维护「连续失败信号」状态机，达到阈值后打包已执行命令+失败诊断+文件清单+原 TODO，
// 请求一次轻量 LLM Self-Reflection，产出「仅缺失文件与未完成命令」的小粒度修复计划，
// 由调度器覆盖 TodoStore 后继续主循环。
//
// 防抖：重规划上限 MAX_REPLANS 次（无论成功与否），超限回退现有 stall/熔断机制。
// 纯函数 + 注入 provider，全部可单测。

import type { AiProvider, AiMessage } from './types'
import type { TodoItem } from './todoManager'
import { NODE_GATE_PROFILE, type ProjectProfile } from '../../shared/projectProfiles'

// ============ 阈值常量 ============
/** 连续失败信号达到该值触发重规划 */
export const FAILURE_THRESHOLD = 2
/** 单次任务重规划次数上限（防抖） */
export const MAX_REPLANS = 2
/** 打包信号明细保留条数（防 prompt 膨胀） */
const MAX_SIGNALS = 8
/** 单条信号明细字符上限 */
const DETAIL_LIMIT = 600
/** 文件清单最多列出条数 */
const MAX_FILE_LIST = 40

// ============ 失败信号状态机 ============

/** 失败信号类型 */
export type ReplanTrigger = 'commandFailure' | 'preflightBlock' | 'validationBlock'

/** 一条失败信号 */
export interface ReplanSignal {
  trigger: ReplanTrigger
  /** 失败命令 / 拦截理由 / 验证缺失摘要（已截断） */
  detail: string
  /** 记录时间（毫秒） */
  at: number
}

/** 重规划状态：由调度器在主循环外创建一次 */
export interface ReplanState {
  /** 连续失败信号计数（任意成功进展即清零） */
  consecutiveFailures: number
  /** 已触发重规划次数 */
  replanCount: number
  /** 最近失败信号（新的在后，供 Self-Reflection 打包） */
  signals: ReplanSignal[]
}

export function createReplanState(): ReplanState {
  return { consecutiveFailures: 0, replanCount: 0, signals: [] }
}

/** 记录一次失败信号：计数+1，信号入列（截断明细、限制条数） */
export function noteFailure(state: ReplanState, trigger: ReplanTrigger, detail: string): void {
  state.consecutiveFailures++
  const clean = (detail || '').trim().replace(/\s+/g, ' ')
  state.signals.push({
    trigger,
    detail: clean.length > DETAIL_LIMIT ? clean.slice(0, DETAIL_LIMIT) + '…' : clean,
    at: Date.now()
  })
  if (state.signals.length > MAX_SIGNALS) {
    state.signals = state.signals.slice(-MAX_SIGNALS)
  }
}

/** 任意实质进展成功时调用：连续失败计数与待打包信号清零 */
export function noteSuccess(state: ReplanState): void {
  state.consecutiveFailures = 0
  state.signals = []
}

/** 是否应触发重规划：失败计数达阈值且未超次数上限 */
export function shouldReplan(state: ReplanState): boolean {
  return state.consecutiveFailures >= FAILURE_THRESHOLD && state.replanCount < MAX_REPLANS
}

/**
 * 重规划尝试结束后（无论 LLM 成功/失败/解析失败）调用：
 * 次数+1、失败计数清零，防止立即重复触发；失败的尝试也消耗配额，由 stall 机制兜底。
 */
export function markReplanned(state: ReplanState): void {
  state.replanCount++
  state.consecutiveFailures = 0
  state.signals = []
}

/**
 * 把当前待打包信号渲染为一行触发原因摘要（供 trace / 事件 / 注入消息使用）。
 * 注意：须在 markReplanned 清信号之前调用。
 */
export function summarizeSignals(state: ReplanState): string {
  if (state.signals.length === 0) return `连续 ${state.consecutiveFailures} 次受阻`
  const body = state.signals
    .map((s) => `[${TRIGGER_LABEL[s.trigger]}] ${s.detail}`)
    .join('；')
  const text = `连续 ${state.consecutiveFailures} 次受阻：${body}`
  return text.length > DETAIL_LIMIT ? text.slice(0, DETAIL_LIMIT) + '…' : text
}

// ============ Self-Reflection 提示词与响应解析 ============

/** 重规划产出的一个修复步骤 */
export interface ReplanStep {
  /** 步骤描述（必填，写入 TodoStore） */
  content: string
  /** 步骤类型：file=写文件 / command=执行命令（供调度器分类，缺省通用） */
  kind?: 'file' | 'command'
  /** 目标路径或命令文本（可选） */
  target?: string
}

/** buildReplanPrompt 的输入 */
export interface ReplanPromptInput {
  /** 用户原始请求 */
  userRequest: string
  /** 失败状态（含信号明细） */
  state: ReplanState
  /** 当前已创建文件集合 */
  createdFiles: Set<string>
  /** 原 TODO 清单 */
  todos: TodoItem[]
  /**
   * 中途偏差拦截确认缺失的关键产物明细（DriftItem.detail，形如「package.json（…）」）。
   * 非空时注入「停止修补残缺文件、先补齐基础文件」的最高优先级指令。
   */
  missingArtifacts?: string[]
  /** 当前项目画像（强制接管话术中安装/运行命令按画像生成；缺省 node 生态） */
  profile?: ProjectProfile
}

const TRIGGER_LABEL: Record<ReplanTrigger, string> = {
  commandFailure: '命令执行失败',
  preflightBlock: '命令被门控拦截',
  validationBlock: '验证锁拦截'
}

/**
 * 构造 Self-Reflection 重规划提示词（纯函数）。
 * 要求模型只输出「缺失文件 + 未完成命令」的最小步骤，每步可由 write/bash 独立完成。
 */
export function buildReplanPrompt(input: ReplanPromptInput): string {
  const { userRequest, state, createdFiles, todos, missingArtifacts } = input
  // 项目画像：强制接管话术的依赖安装/运行命令与全局安装禁令按画像生成（缺省 node 生态）
  const profile = input.profile ?? NODE_GATE_PROFILE
  const initText = profile.initCommands.join(' 或 ') || '依赖安装命令'
  const runText = profile.runCommands.join(' / ') || '运行验证命令'
  const forbidText =
    profile.forbidGlobalInstall.length > 0
      ? `（如 ${profile.forbidGlobalInstall.join('、')}）`
      : ''

  const signalLines = state.signals.map(
    (s, i) => `${i + 1}. [${TRIGGER_LABEL[s.trigger]}] ${s.detail}`
  )
  const fileList = Array.from(createdFiles)
  const fileSection =
    fileList.length === 0
      ? '尚未创建任何文件'
      : `已创建 ${fileList.length} 个文件：\n${fileList.slice(-MAX_FILE_LIST).join('\n')}`
  const todoSection =
    todos.length === 0
      ? '（无 TODO 清单）'
      : todos.map((t) => `${t.status === 'completed' ? '[x]' : '[ ]'} #${t.id} ${t.content}`).join('\n')

  // 关键基础文件缺失（中途偏差拦截）：强制接管口吻——旧计划作废 + 固定流程，禁止一切多余操作
  const missingList = (missingArtifacts ?? []).map((m) => `- ${m}`).join('\n')
  const missingSection = missingList
    ? `【强制接管 · 旧计划已作废（最高优先级）】
系统检测到严重的关键产物缺失，你此前的执行计划与已产出文件全部视为不可信的污染状态，立即作废。
以下基础文件缺失：
${missingList}

你必须严格按照以下固定顺序执行，不允许做任何多余操作：
阶段1 生成文件：对上述每一个缺失文件调用 write_file 完整生成（一次写入完整、标准、可运行的内容，不得有重复声明）。
  · 第一步只能是 write_file；绝对禁止 read_text_file / read_file 读取旧文件，禁止 edit_file / str_replace 修补任何已存在的残缺文件——旧文件已污染，直接整体覆盖最安全。
阶段2 安装依赖：全部缺失文件补齐后，执行且只执行一次 ${initText}，确认成功。
阶段3 运行验证：安装成功后才允许 ${runText} 等运行命令，然后再次请求验证。
阶段 1、2 未完成前，禁止任何运行/启动类命令、后台任务与搜索读取动作。
绝对禁止在阶段 1、2 中使用任何全局安装命令${forbidText}——依赖必须装入项目本地环境。

`
    : ''

  return `你正在执行一次 Self-Reflection 动态重规划。执行链连续受阻，请先分析根因，再给出更小粒度的修复计划。

【用户原始请求】
${userRequest}

【连续受阻信号】
${signalLines.join('\n')}

${missingSection}${fileSection}

【原 TODO 清单】
${todoSection}

请严格按以下要求输出：
1. ${missingList
      ? `只允许两类步骤，且顺序固定：①write_file 生成上方【强制接管】缺失清单中的文件（必须排在最前面，每文件一步，整体写入完整内容）；②依赖安装命令 ${initText}（必须排在所有文件步骤之后）。禁止 read_text_file / edit_file 步骤，禁止任何运行/构建/启动命令，禁止清单外的多余文件与操作。`
      : '只保留「尚未创建的关键文件」与「尚未成功执行的命令」，已完成的步骤一律不要重复。'}
2. 每个步骤必须能由 write 或 bash 工具独立完成；文件步骤要在 content 中写清关键内容要点（依赖版本、API 风格等）。
3. ${missingList
      ? '文件步骤的 kind 必须为 file、target 必须是缺失清单中的相对路径；安装步骤 kind 为 command、target 为精确安装命令。'
      : '修复已存在文件（报错文件）时必须用 edit 精准替换：步骤 content 中写明目标文件、出错行号/符号与修复要点（如「edit src/main.js：删除第 5 行重复的 const app 声明」），严禁用 write 整文件重写覆盖已有内容；修复依据取自上方「连续受阻信号」中的真实报错。'}
4. 严禁列入交互式脚手架（vue create/create-react-app/npm create 等）、sudo、或任何需要人工键盘输入的命令。
5. 步骤粒度要小：一个文件一条、一条命令一条，按执行先后排序；若某依赖命令反复失败，换用镜像源或等价替代方案。
6. 输出且只输出以下代码块（不要额外解释）：

\`\`\`replan
{ "steps": [ { "content": "<步骤描述>", "kind": "file|command", "target": "<相对路径或命令文本>" } ] }
\`\`\``
}

/**
 * 解析重规划响应：
 * 优先提取 ```replan 代码块；其次尝试裸 JSON；再兜底截取首个 { 到末个 } 的子串。
 * 校验：steps 必须为数组，每项 content 为非空字符串（非法项过滤）；无有效步骤返回 null。
 */
export function parseReplanResponse(text: string): ReplanStep[] | null {
  const raw = text || ''
  let jsonText: string | null = null

  const block = raw.match(/```replan\s*([\s\S]*?)```/i)
  if (block) {
    jsonText = block[1].trim()
  } else {
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start !== -1 && end > start) jsonText = raw.slice(start, end + 1)
  }
  if (!jsonText) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return null
  }
  const stepsAny = (parsed as { steps?: unknown })?.steps
  if (!Array.isArray(stepsAny)) return null

  const steps: ReplanStep[] = []
  for (const s of stepsAny) {
    if (!s || typeof s !== 'object') continue
    const content = (s as { content?: unknown }).content
    if (typeof content !== 'string' || !content.trim()) continue
    const kindRaw = (s as { kind?: unknown }).kind
    const targetRaw = (s as { target?: unknown }).target
    const step: ReplanStep = { content: content.trim() }
    if (kindRaw === 'file' || kindRaw === 'command') step.kind = kindRaw
    if (typeof targetRaw === 'string' && targetRaw.trim()) step.target = targetRaw.trim()
    steps.push(step)
  }
  return steps.length > 0 ? steps : null
}

/** 门控过滤结果 */
export interface SanitizeResult {
  /** 通过门控、可写入 TODO 的步骤 */
  kept: ReplanStep[]
  /** 被门控拦截（交互脚手架/破坏命令/依赖顺序）而丢弃的步骤 */
  dropped: ReplanStep[]
}

/** sanitizeReplanSteps 的可选上下文 */
export interface SanitizeOptions {
  /**
   * 中途偏差拦截确认缺失的关键产物明细（DriftItem.detail）。
   * 非空时进入「基础文件补齐模式」：用 edit/str_replace 修补「已存在但不在缺失清单」文件的
   * file 步骤一律丢弃——地基文件缺失阶段修补上层残缺文件属于无效打补丁。
   */
  missingArtifacts?: string[]
  /** 当前已创建文件集合（用于判定 file 步骤的 target 是否为已存在文件） */
  existingFiles?: Set<string>
}

/** 路径归一（仅分隔符+小写，与 validation/planDrift 后缀匹配同款口径） */
function normTarget(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}

/** target 路径是否命中缺失产物清单（明细形如「path（说明）」，取括号前路径做后缀匹配） */
function targetsMissingArtifact(target: string, missingArtifacts: string[]): boolean {
  const t = normTarget(target)
  return missingArtifacts.some((m) => {
    const p = m.replace(/（[^）]*）\s*$/, '').trim()
    return !!p && t.endsWith(normTarget(p))
  })
}

/** 步骤文本是否为「读取旧文件」动作（强制接管模式下一律禁止） */
function isReadAction(step: ReplanStep): boolean {
  const text = `${step.content || ''} ${step.target || ''}`
  return /read_text_file|read_file|\b读取\b|先读\s*取?|查看文件内容/.test(text)
}

/** 命令是否为依赖安装（强制接管第 2 阶段唯一允许的命令；全局安装除外） */
function isInstallCommand(command: string): boolean {
  return /\b(npm|cnpm|yarn|pnpm)\s+(install|i|add)\b/.test(command) &&
    !/\s-(?:g|-global)\b/.test(command)
}

/**
 * 重规划步骤门控过滤：LLM 输出不可信——即使提示词明令禁止，小模型仍可能给出
 * vue create / sudo 等命令（真实 E2E 在 qwen2.5-coder:7b 上已复现）。
 * 对命令类步骤（kind='command'）逐条过 gateFn：返回拦截理由则丢弃；
 * 文件类与无类型步骤保留（写入类动作不会挂起终端）。
 * 基础文件缺失模式（options.missingArtifacts 非空）下执行强制接管白名单：
 *  - 读取动作（read_text_file/读取旧文件）一律丢弃；
 *  - file 步骤只有「目标命中缺失清单」才保留（清单外新建/修补残缺文件都属多余操作）；
 *  - command 步骤只保留依赖安装，且安装之后不得再出现任何步骤（file 必须全部在前）；
 *  - 无 kind 步骤文本含读取/编辑/命令特征时丢弃，纯文件生成描述保留。
 * 全部被过滤时 kept 为空，调用方应放弃本次重规划，回退 stall 机制。
 */
export function sanitizeReplanSteps(
  steps: ReplanStep[],
  gateFn: (command: string) => string | null,
  options?: SanitizeOptions
): SanitizeResult {
  const missing = options?.missingArtifacts ?? []
  const missingMode = missing.length > 0
  const kept: ReplanStep[] = []
  const dropped: ReplanStep[] = []
  // missingMode 顺序锁：安装命令一旦出现，其后的任何步骤都丢弃（文件必须在命令前补齐）
  let installPassed = false
  for (const step of steps) {
    if (step.kind === 'command') {
      // target 是精确命令文本；缺省时用 content 兜底（gate 按子串特征匹配）
      const command = step.target || step.content
      if (missingMode) {
        // 强制接管：只保留唯一一个依赖安装命令（且过 gateFn 顺序锁），其余命令（含 serve/dev/build）全丢弃
        if (installPassed || !isInstallCommand(command) || gateFn(command)) {
          dropped.push(step)
          continue
        }
        installPassed = true
        kept.push(step)
        continue
      }
      if (gateFn(command)) {
        dropped.push(step)
        continue
      }
    } else if (step.kind === 'file') {
      if (missingMode) {
        // 安装命令之后的文件步骤必然乱序，丢弃
        if (installPassed) {
          dropped.push(step)
          continue
        }
        // 强制接管：读取动作直接丢弃；file 目标必须命中缺失清单，
        // 命中即视为整体重写（即使文件已存在残缺版也允许 write 覆盖）；未命中=多余操作，丢弃
        if (isReadAction(step)) {
          dropped.push(step)
          continue
        }
        const targetIsMissing = step.target ? targetsMissingArtifact(step.target, missing) : false
        if (!targetIsMissing) {
          dropped.push(step)
          continue
        }
        // 命中缺失清单也不允许 edit 修补：旧文件已污染，只能整体 write_file 覆盖
        const fileText = `${step.content || ''} ${step.target || ''}`
        if (/\b(edit|edit_file|str_replace|string_replace)\b|精准替换|修补/.test(fileText)) {
          dropped.push(step)
          continue
        }
      }
    } else if (missingMode) {
      // 无 kind 步骤：含读取/编辑/命令/运行特征的不可信描述丢弃，纯文件生成描述保留
      const text = `${step.content || ''} ${step.target || ''}`
      if (installPassed ||
        isReadAction(step) ||
        /edit|str_replace|修补|npm|yarn|pnpm|\brun\b|serve|dev|build|install|启动|运行/.test(text)) {
        dropped.push(step)
        continue
      }
    }
    kept.push(step)
  }
  return { kept, dropped }
}

/** requestReplan 的输入 */
export interface RequestReplanParams {
  provider: AiProvider
  modelName: string
  userRequest: string
  state: ReplanState
  createdFiles: Set<string>
  todos: TodoItem[]
  /** 中途偏差拦截确认缺失的关键产物明细（透传给 buildReplanPrompt） */
  missingArtifacts?: string[]
  /** 当前项目画像（透传给 buildReplanPrompt；缺省 node 生态） */
  profile?: ProjectProfile
}

/** requestReplan 的成功结果 */
export interface RequestReplanResult {
  steps: ReplanStep[]
  /** LLM 调用耗时（毫秒，供 trace） */
  durationMs: number
}

/**
 * 执行一次 Self-Reflection 重规划请求。
 * 模型调用失败 / 返回 ok:false / 响应无法解析为有效步骤时返回 null（调用方照常消耗一次配额）。
 */
export async function requestReplan(params: RequestReplanParams): Promise<RequestReplanResult | null> {
  const prompt = buildReplanPrompt({
    userRequest: params.userRequest,
    state: params.state,
    createdFiles: params.createdFiles,
    todos: params.todos,
    missingArtifacts: params.missingArtifacts,
    profile: params.profile
  })
  const messages: AiMessage[] = [{ role: 'user', content: prompt }]
  const start = Date.now()
  let res
  try {
    res = await params.provider.chat({ messages })
  } catch {
    return null
  }
  const durationMs = Date.now() - start
  if (!res.ok || !res.content) return null
  const steps = parseReplanResponse(res.content)
  return steps ? { steps, durationMs } : null
}
