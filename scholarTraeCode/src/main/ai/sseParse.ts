// OpenAI 兼容 SSE 行解析（纯函数，无 IO 无依赖）：从 provider 抽出便于单测覆盖。
// 处理 `data: {...}` / `data: [DONE]`；空行、event:、注释、半截 JSON 一律忽略（返回 null）。

/** 单条 SSE data 行的解析结果 */
export interface SseParseResult {
  /** 增量文本（无则空串） */
  content: string
  /** 增量 tool_calls 分片（OpenAI function calling 流式格式） */
  toolCalls: unknown[]
  /** token 统计（末 chunk 携带；缺省 undefined） */
  usage?: { tokensIn?: number; tokensOut?: number }
  /** 是否终止标记 [DONE] */
  done: boolean
}

/**
 * 解析一行 SSE data。
 * - `data: [DONE]` → done:true
 * - 正常 chunk → 抽取 choices[0].delta.content / delta.tool_calls / usage
 * - 其他（空行/event:/注释/非法 JSON/纯 keep-alive chunk）→ null 忽略
 */
export function parseSseData(line: string): SseParseResult | null {
  const t = line.trim()
  if (!t.startsWith('data:')) return null
  const payload = t.slice(5).trim()
  if (payload === '[DONE]') return { content: '', toolCalls: [], done: true }
  let obj: any
  try {
    obj = JSON.parse(payload)
  } catch {
    return null // 半截 JSON（跨网络分片）由上层行缓冲拼好后再试
  }
  const out: SseParseResult = { content: '', toolCalls: [], done: false }
  const delta = obj?.choices?.[0]?.delta
  if (delta) {
    if (typeof delta.content === 'string' && delta.content) out.content = delta.content
    if (Array.isArray(delta.tool_calls)) out.toolCalls = delta.tool_calls
  }
  const usage = obj?.usage
  if (usage && typeof usage === 'object') {
    const tokensIn = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined
    const tokensOut =
      typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined
    if (tokensIn !== undefined || tokensOut !== undefined) {
      out.usage = { tokensIn, tokensOut }
    }
  }
  // 无任何有效载荷的空 delta（部分服务端心跳）按忽略处理
  if (!out.content && out.toolCalls.length === 0 && !out.usage) return null
  return out
}
