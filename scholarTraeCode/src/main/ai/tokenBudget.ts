// Token 预算纯函数层（零 IO / 零 electron）：
// CJK 感知 token 估算、消息计数、按模型窗口的历史预算、
// 压缩分段、关键事实提取与保留度评分、工具输出节选。
import type { AiMessage } from './types'

/** CJK 统一表意文字/假名/韩文音节：每字约 1 token */
const CJK_RE = /[一-鿿぀-ゟ゠-ヿ가-힯]/

/**
 * 文本 → token 保守估算：
 * CJK 字符每字 1 token；其余字符（英文/代码/空白/标点）按 4 字符/token 折算。
 * 向上取整；空串 0。
 */
export function estimateTokensText(text: string): number {
  if (!text) return 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (CJK_RE.test(ch)) cjk++
    else other++
  }
  return cjk + Math.ceil(other / 4)
}

/**
 * 消息列表 token 合计：每条 content + toolCalls（JSON 序列化长度估算）。
 * toolCalls 是压缩必须计入的隐形开销（assistant 发起调用时随消息回传）。
 */
export function countMessagesTokens(messages: AiMessage[]): number {
  let total = 0
  for (const m of messages) {
    total += estimateTokensText(m.content ?? '')
    if (m.toolCalls && m.toolCalls.length > 0) {
      try {
        total += estimateTokensText(JSON.stringify(m.toolCalls))
      } catch {
        // 循环引用等极端情况：退化为粗略计数
        total += m.toolCalls.length * 16
      }
    }
  }
  return total
}

export interface BudgetOptions {
  /** 目标占用窗口比例（剩余留给框架开销与输出） */
  ratio?: number
  /** 预留给模型回复的输出 token */
  outputReserve?: number
  /** 历史预算下限：系统提示超大时也至少保留的对话空间 */
  floor?: number
}

/**
 * 计算对话历史可用 token 预算：
 * max(floor, round(contextWindow * ratio) - systemTokens - outputReserve)
 */
export function computeHistoryBudget(
  contextWindow: number,
  systemTokens: number,
  opts: BudgetOptions = {}
): number {
  const ratio = opts.ratio ?? 0.75
  const outputReserve = opts.outputReserve ?? 1024
  const floor = opts.floor ?? 2048
  const budgeted = Math.round(contextWindow * ratio) - systemTokens - outputReserve
  return Math.max(floor, budgeted)
}

export interface CompactionPlan {
  /** 全部 system 消息（S1-S11 分层提示词，原样保留） */
  systems: AiMessage[]
  /** 首条非 system 消息（任务起点锚点） */
  first: AiMessage
  /** 待摘要的中间历史 */
  middle: AiMessage[]
  /** 最近若干条（含工具调用记录，保证当前进度连续） */
  recent: AiMessage[]
}

/**
 * 压缩分段：system 全保留；首条非 system 锚定；最近 keepRecent 条原样；中间交摘要器。
 * 对话条数不足 keepRecent+1 时返回 null（不值得压缩）。
 */
export function planCompaction(messages: AiMessage[], keepRecent = 4): CompactionPlan | null {
  const systems = messages.filter((m) => m.role === 'system')
  const convo = messages.filter((m) => m.role !== 'system')
  if (convo.length <= keepRecent + 1) return null

  const first = convo[0]
  const recent = convo.slice(-keepRecent)
  const middle = convo.slice(1, convo.length - keepRecent)
  if (middle.length === 0) return null
  return { systems, first, middle, recent }
}

/** 从历史文本中提取的关键事实：后续用于摘要保留度校验 */
export interface KeyFacts {
  /** 文件/目录路径 */
  paths: string[]
  /** shell 命令行 */
  commands: string[]
}

/** 路径：盘符/./ ../ / \\ 开头，或以单词字符开头、带 1-8 位扩展名的标识符串 */
const PATH_RE = /(?:[a-zA-Z]:[\\/][^\s'"`，。；）)]*|\.{1,2}[\\/][^\s'"`，。；）)]*|\/[\w.@/-][\w.@/-]*|[\w@][\w.@/-]*\.[a-zA-Z]{1,8})(?=[\s'"`，。；：）)]|$)/g
/** 命令行：npm/git/npx/node 开头（参数限代码字符，遇中文即止），或行首 $ > 之后的内容 */
const CMD_RE = /(?:(?:npm|pnpm|yarn|npx|node|git|cd|mkdir|rm|cp|mv|python3?|pip3?)\s+[\w.@/:-][\w.@/:\- ]*|^\s*[$>]\s+(.+?)$)/gm

function uniqPush(list: string[], value: string, limit: number): void {
  const v = value.trim().replace(/[.;，。]+$/, '')
  if (v && !list.includes(v) && list.length < limit) list.push(v)
}

/** 从原文提取关键事实（路径/命令，去重限 20 条） */
export function extractKeyFacts(text: string): KeyFacts {
  const paths: string[] = []
  const commands: string[] = []
  if (!text) return { paths, commands }

  for (const m of text.matchAll(PATH_RE)) {
    uniqPush(paths, m[0], 20)
  }
  for (const m of text.matchAll(CMD_RE)) {
    // $ / > 引导的取捕获组，其余取整串
    uniqPush(commands, (m[1] ?? m[0]).trim(), 20)
  }
  return { paths, commands }
}

function pathHit(fact: string, summary: string): boolean {
  if (summary.includes(fact)) return true
  // 路径允许 basename 命中（摘要可能省略目录前缀）
  const base = fact.split(/[\\/]/).pop() ?? fact
  return base.length >= 3 && summary.includes(base)
}

/**
 * 摘要保留度评分（0~1）：路径与命令在摘要中被覆盖的比例。
 * 原文无关键事实时返回 1（无事实可丢，不触发重试）。
 */
export function retentionScore(facts: KeyFacts, summary: string): number {
  const all = [...facts.paths, ...facts.commands]
  if (all.length === 0) return 1
  const hit = all.filter((f) => (f.includes('/') || f.includes('\\')) ? pathHit(f, summary) : summary.includes(f)).length
  return hit / all.length
}

/** 结论关键词：含这些词的行在节选时优先保留 */
const CONCLUSION_WORDS = ['错误', '失败', '成功', '完成', 'error', 'failed', 'success', 'done', '✓', '✗', '⚠', '通过', '拒绝', '已创建', '已删除']

/**
 * 工具输出节选（token 预算内）：
 * 1. 优先提取 ``` 代码围栏块（合计不超过预算 70%）；
 * 2. 余量放非代码文本：结论行优先，其后首尾原文；
 * 3. 超预算插截断标记。短文本原样返回。
 */
export function truncateToolOutput(content: string, maxTokens: number): string {
  if (!content) return ''
  if (estimateTokensText(content) <= maxTokens) return content

  const codeBudget = Math.floor(maxTokens * 0.7)
  const fenceRe = /```[\s\S]*?```/g
  const codeBlocks: string[] = []
  let codeTokens = 0
  let m: RegExpExecArray | null
  while ((m = fenceRe.exec(content)) !== null) {
    const t = estimateTokensText(m[0])
    if (codeTokens + t <= codeBudget) {
      codeBlocks.push(m[0])
      codeTokens += t
    }
  }

  // 非代码文本：去掉围栏块后按行筛选（重置 lastIndex，replace 从头匹配）
  fenceRe.lastIndex = 0
  const stripped = content.replace(fenceRe, ' ')
  const lines = stripped.split('\n')
  const keptHead: string[] = []
  const keptConclusion: string[] = []
  let textBudget = maxTokens - codeTokens
  for (const line of lines) {
    const t = estimateTokensText(line) + 1
    const isConclusion = CONCLUSION_WORDS.some((w) => line.toLowerCase().includes(w.toLowerCase()))
    if (isConclusion && textBudget - t >= 0) {
      keptConclusion.push(line)
      textBudget -= t
    }
  }
  // 结论行之后用首段原文补足上下文
  for (const line of lines) {
    if (textBudget <= 0) break
    if (keptConclusion.includes(line)) continue
    const t = estimateTokensText(line) + 1
    if (t <= textBudget) {
      keptHead.push(line)
      textBudget -= t
    }
  }

  const dropped = estimateTokensText(content) - maxTokens
  const parts: string[] = []
  if (codeBlocks.length) parts.push(codeBlocks.join('\n\n'))
  if (keptConclusion.length) parts.push(keptConclusion.join('\n'))
  if (keptHead.length) parts.push(keptHead.join('\n'))
  return parts.join('\n\n') + `\n…[中间约 ${Math.max(0, dropped)} token 已截断]…`
}

/**
 * 把中间历史组装为摘要请求文本：
 * - tool 消息走 truncateToolOutput（代码块优先）；
 * - 普通消息优先保留含路径/命令/结论词的行；
 * - 每条带 [role(name)] 标签，单条不超过 perMsgTokens。
 */
export function buildHistoryText(middle: AiMessage[], perMsgTokens = 600): string {
  return middle
    .map((msg) => {
      const tag = msg.name ? `${msg.role}(${msg.name})` : msg.role
      let body = msg.content ?? ''
      if (msg.role === 'tool') {
        body = truncateToolOutput(body, perMsgTokens)
      } else if (estimateTokensText(body) > perMsgTokens) {
        const lines = body.split('\n')
        const picked: string[] = []
        let budget = perMsgTokens
        for (const line of lines) {
          const t = estimateTokensText(line) + 1
          if (t > budget) break
          // 模块级 g 正则 test 前重置，避免 lastIndex 残留漏匹配
          PATH_RE.lastIndex = 0
          const valuable =
            CONCLUSION_WORDS.some((w) => line.toLowerCase().includes(w.toLowerCase())) ||
            PATH_RE.test(line) ||
            /\b(npm|git|npx|node)\b/.test(line)
          if (valuable || picked.length < 6) {
            picked.push(line)
            budget -= t
          }
        }
        body = picked.join('\n') + `\n…[单条历史截断，原 ${estimateTokensText(msg.content ?? '')} token]…`
      }
      return `[${tag}]\n${body}`
    })
    .join('\n\n')
}
