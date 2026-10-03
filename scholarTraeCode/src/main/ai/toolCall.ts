// 工具调用解析共享工具：主 Agent 循环与子代理循环（subagents.ts）共用。
// 包含路径纠偏、同批次去重、从模型纯文本中兜底解析 JSON 工具调用三个能力。
import { isAbsolute, join } from 'node:path'

/** 统一的工具条目结构（与 mcpToolBridge.McpToolEntry 结构兼容） */
export interface ToolEntry {
  server: string
  tool: {
    name: string
    description?: string
    inputSchema?: unknown
  }
}

/**
 * 工具参数路径纠偏：模型给出相对路径时拼接到工作区根目录，
 * 防止文件被建到 MCP 服务器默认允许目录（应用自身目录）等非预期位置。
 */
export function coerceToolArgs(args: any, workspace?: string | null): any {
  if (!workspace || !args || typeof args !== 'object') return args
  const out: Record<string, unknown> = { ...args }
  for (const key of ['path', 'filePath', 'source', 'destination']) {
    const v = out[key]
    if (typeof v === 'string' && v && !isAbsolute(v)) {
      out[key] = join(workspace, v)
    }
  }
  return out
}

/**
 * 同批次工具调用去重：按「工具名 + 目标路径(path)」分组，仅保留最后一次出现。
 * 针对本地小模型在一条消息里重复输出同一文件多个微调版本的行为，减少无效写入与轮次消耗。
 */
export function dedupeBatchCalls(
  calls: { function: { name: string; arguments: unknown } }[]
): { function: { name: string; arguments: unknown } }[] {
  const keyOf = (c: { function: { name: string; arguments: unknown } }): string => {
    const args = c.function.arguments as any
    const p = args && typeof args === 'object' ? (args.path ?? args.filePath ?? '') : ''
    return `${c.function.name}|${p}`
  }
  const lastIndex = new Map<string, number>()
  calls.forEach((c, i) => lastIndex.set(keyOf(c), i))
  return calls.filter((c, i) => lastIndex.get(keyOf(c)) === i)
}

/**
 * 从文本 content 中兜底解析工具调用（可能多个）。
 * 策略：平衡括号扫描所有顶层 {...} 块 + markdown 代码块整体，逐块 JSON.parse；
 * name 必须命中已知工具列表，避免把普通 JSON 回答误判为工具调用。
 */
export function parseToolCallsFromContent(
  content: string,
  tools: ToolEntry[]
): { function: { name: string; arguments: unknown } }[] {
  if (!content) return []
  const calls: { function: { name: string; arguments: unknown } }[] = []
  const seen = new Set<string>()

  const tryPush = (text: string): void => {
    try {
      const obj = JSON.parse(text)
      const name = obj?.name ?? obj?.tool
      const args = obj?.arguments ?? obj?.args ?? obj?.parameters
      if (typeof name === 'string' && tools.some((t) => t.tool.name === name)) {
        const key = name + JSON.stringify(args ?? {})
        if (!seen.has(key)) {
          seen.add(key)
          calls.push({ function: { name, arguments: args ?? {} } })
        }
      }
    } catch {
      // 不是合法 JSON，跳过
    }
  }

  // 1) markdown 代码块整体
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) tryPush(fenced[1].trim())

  // 2) 平衡括号扫描：收集所有顶层 {...} 块（覆盖 NDJSON 多行输出、嵌套 arguments）
  let depth = 0
  let start = -1
  let inStr = false
  let escaped = false
  for (let i = 0; i < content.length; i++) {
    const ch = content[i]
    if (inStr) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') {
      inStr = true
    } else if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0 && start >= 0) {
        tryPush(content.slice(start, i + 1))
        start = -1
      }
    }
  }
  return calls
}
