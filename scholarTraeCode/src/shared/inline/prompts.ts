// 内联 AI 纯函数层：构建改写/补全的提示词，解析模型响应。
// 零 DOM/Electron 依赖，可在 vitest node 环境直接单测。
// 供渲染端 monacoInline（幽灵文本补全）与 InlineEditWidget（Cmd+K 改写）复用。

/** 内联 AI 消息结构（与主进程 AiMessage 兼容；本地定义避免跨 shared/main 边界依赖） */
export interface InlineMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  name?: string
}

/** 单边上下文最大字符数（避免挤占模型窗口；前文给更多以保留语义） */
const MAX_PREFIX = 1800
const MAX_SUFFIX = 900
/** 选中文本最大字符数（超过则截断，提示用户精简） */
const MAX_SELECTION = 6000
/** FIM（fill-in-middle）补全最大字符数（响应侧） */
const MAX_COMPLETION = 600

/**
 * 构建 Cmd+K 选中改写的消息序列。
 * 系统提示约束模型：仅输出改写后的代码，禁止解释/Markdown 围栏。
 * 用户消息：[可选前文] + <selection>选中代码</selection> + [可选后文] + 指令。
 * @param selection 选中文本
 * @param instruction 用户改写指令（如「加注释」「改为 Promise」）
 * @param language 代码语言（用于提示词约束，如 'typescript'）
 * @param beforeContext 选中区域前的上下文（可选，给模型补全语义）
 * @param afterContext 选中区域后的上下文（可选）
 */
export function buildRewritePrompt(
  selection: string,
  instruction: string,
  language: string,
  beforeContext?: string,
  afterContext?: string
): InlineMessage[] {
  const trimmedSel = selection.length > MAX_SELECTION
    ? selection.slice(0, MAX_SELECTION) + '\n/* …截断… */'
    : selection
  const sys =
    `你是代码改写助手。只输出改写后的 ${language || ''} 代码原文，` +
    '禁止解释、禁止 Markdown 围栏（```）、禁止前后缀任何说明文字。' +
    '严格遵循用户指令改写选中代码，保留其在外部上下文中的可集成性。'
  const parts: string[] = []
  if (beforeContext) parts.push(`[前文上下文]\n${trimContext(beforeContext, MAX_PREFIX)}`)
  if (afterContext) parts.push(`[后文上下文]\n${trimContext(afterContext, MAX_PREFIX)}`)
  parts.push(`[需改写的选中代码 (${language || 'plain'})]\n${trimmedSel}`)
  parts.push(`[改写指令]\n${instruction.trim()}`)
  return [
    { role: 'system', content: sys },
    { role: 'user', content: parts.join('\n\n') }
  ]
}

/**
 * 构建 FIM（fill-in-middle）补全消息序列。
 * 系统约束：仅输出在 prefix 之后、suffix 之前应插入的代码片段，禁止解释/围栏。
 * @param prefix 光标前内容（截断到 MAX_PREFIX）
 * @param suffix 光标后内容（截断到 MAX_SUFFIX）
 * @param language 代码语言
 */
export function buildFimPrompt(
  prefix: string,
  suffix: string,
  language: string
): InlineMessage[] {
  const sys =
    `你是 ${language || 'plain'} 代码补全助手。只输出应插入到光标位置的代码片段，` +
    '禁止解释、禁止 Markdown 围栏、禁止复述已有代码。' +
    '依据前文与后文语义，给出最可能且最简的续写（通常 1-5 行）。'
  const user =
    `[前文]\n${trimContext(prefix, MAX_PREFIX)}\n\n` +
    `[后文]\n${trimContext(suffix, MAX_SUFFIX)}\n\n` +
    '请输出此处应插入的代码：'
  return [
    { role: 'system', content: sys },
    { role: 'user', content: user }
  ]
}

/**
 * 从模型响应中提取改写后的代码。
 * 容错策略：
 * 1. 若存在 ``` 代码块，取首个块内容（去掉语言标注行）
 * 2. 否则取原文 trim
 * 3. 去除常见尾部多余换行
 */
export function extractRewrittenCode(raw: string): string {
  if (!raw) return ''
  const fence = raw.match(/```(?:[^\n]*)?\n([\s\S]*?)```/)
  if (fence && fence[1] !== undefined) {
    return fence[1].replace(/\s+$/, '')
  }
  // 模型偶尔会把整段围在单边 ```：剥离首尾围栏标记
  const stripped = raw.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '')
  return stripped.replace(/\s+$/, '')
}

/**
 * 从模型响应中提取补全文本。
 * 与 extractRewrittenCode 类似，但额外限制最大长度（防止幻觉型长输出污染编辑器），
 * 且尝试在合理边界截断（保留完整行，避免半截语句）。
 */
export function extractCompletion(raw: string): string {
  let text = extractRewrittenCode(raw)
  if (!text) return ''
  if (text.length > MAX_COMPLETION) {
    // 在最大长度内找最后一个换行，截到行尾（含换行），避免半行
    const slice = text.slice(0, MAX_COMPLETION)
    const lastNl = slice.lastIndexOf('\n')
    text = lastNl > 0 ? slice.slice(0, lastNl + 1) : slice
  }
  return text
}

/** 截断上下文到 maxChars，超过则头部保留并附截断标记 */
function trimContext(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars) + '\n/* …截断… */'
}

export const INLINE_LIMITS = {
  MAX_PREFIX,
  MAX_SUFFIX,
  MAX_SELECTION,
  MAX_COMPLETION
}
