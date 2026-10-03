// MCP 工具桥接：把已连接 MCP 工具与内置工具统一收集并转换为模型可消费的 schema，
// 并提供统一的工具调用入口。由调度器（ai/scheduler.ts）的工具循环使用。
//
// 分流策略：调用时内置工具优先匹配（read/write/edit/bash/grep/glob），
// 未命中再走 MCP 服务器。即使 MCP filesystem 未连接，AI 也能完成核心文件操作。
import { getMcpClients } from './mcp'
import { collectBuiltinTools, isBuiltinTool, callBuiltinTool } from '../ai/builtinTools'
import { guardToolResult } from '../ai/contentGuard'

export interface McpToolEntry {
  server: string
  tool: {
    name: string
    description?: string
    inputSchema?: any
  }
}

/** 内置工具的虚拟 server 名（与真实 MCP server 区分） */
const BUILTIN_SERVER = 'builtin'

/**
 * 列出当前已连接的 MCP 服务器名（供分层 Prompt 的 S2 层展示协调层状态）。
 * MCP 在本框架中是底层协调层，而非用户界面——Agent 自主决定调用哪个工具。
 */
export function listMcpServers(): string[] {
  return Array.from(getMcpClients().keys())
}

/**
 * 收集所有可用工具：内置工具 + 已连接 MCP 服务器的工具。
 * 内置工具始终可用（与 MCP 连接状态解耦）。
 */
export async function collectTools(): Promise<McpToolEntry[]> {
  const all: McpToolEntry[] = []
  // 1) 内置工具（read/write/edit/bash/grep/glob）
  for (const bt of collectBuiltinTools()) {
    all.push({
      server: BUILTIN_SERVER,
      tool: {
        name: bt.name,
        description: bt.description,
        inputSchema: bt.inputSchema
      }
    })
  }
  // 2) MCP 工具（filesystem 的 read_file 等、terminal 的 run_terminal_command）
  const clients = getMcpClients()
  for (const [server, client] of clients) {
    try {
      const res = await client.listTools()
      for (const t of (res.tools as any[]) ?? []) {
        all.push({ server, tool: t })
      }
    } catch (err) {
      console.error(`[mcpToolBridge] listTools 失败 (${server}):`, err)
    }
  }
  return all
}

/**
 * 调用指定工具，返回字符串结果。
 * 内置工具优先匹配（无视 server 参数），未命中再走 MCP 服务器。
 *
 * 所有工具结果（内置 + MCP）在返回前统一过 contentGuard 出口清洗：
 * 密钥脱敏 + 疑似注入指令标注（㉙ 不可信内容防护）。
 *
 * @param server  工具所属 server（内置工具时被忽略）
 * @param name    工具名
 * @param args    工具参数
 * @param workspace 工作区根（内置 bash/grep/glob 的默认路径）
 * @param signal  用户停止信号（2.2）：内置工具杀进程树，MCP 由 SDK 发 notifications/cancelled
 */
export async function callMcpTool(
  server: string,
  name: string,
  args: Record<string, unknown>,
  workspace?: string | null,
  signal?: AbortSignal
): Promise<string> {
  // 内置工具优先：与 MCP 解耦，直接走本地实现
  if (isBuiltinTool(name)) {
    return guardToolResult(await callBuiltinTool(name, args, workspace, signal))
  }
  const client = getMcpClients().get(server)
  if (!client) return `错误：未找到 MCP 服务器 ${server}`
  // 已中止则不发起新调用（避免停止后仍起副作用）
  if (signal?.aborted) return '⚠ 已被用户中止'
  try {
    // write_file 容错：模型常跳过创建父目录直接写文件导致 ENOENT，
    // 这里先确保父目录存在（create_directory 幂等），提升脚手架类任务成功率
    if (name === 'write_file' && typeof args.path === 'string') {
      const normalized = args.path.replace(/\\/g, '/')
      const parent = normalized.slice(0, normalized.lastIndexOf('/'))
      if (parent) {
        await client
          .callTool({ name: 'create_directory', arguments: { path: parent } })
          .catch(() => {})
      }
    }
    // SDK 1.30：signal 中止时自动向 server 发送 notifications/cancelled（terminal 内置服务同步级联）
    const res = await client.callTool({ name, arguments: args }, undefined, { signal })
    // 提取文本：MCP text content 数组 → 拼接 text（模型可读）；字符串原样；其余 JSON 序列化兜底
    const contentAny = res.content as unknown
    let raw: string
    if (typeof contentAny === 'string') {
      raw = contentAny
    } else if (Array.isArray(contentAny)) {
      const texts = contentAny
        .map((c) => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string'
          ? (c as { text: string }).text
          : ''))
        .filter(Boolean)
      raw = texts.length > 0 ? texts.join('\n') : JSON.stringify(contentAny)
    } else {
      raw = JSON.stringify(contentAny)
    }
    // 关键修复：MCP isError 标志此前被直接丢弃——run_terminal_command 非零退出（isError:true）
    // 对调度器不可见，ranNpmInstall/ranServe 误置位、验证锁被假象放行。统一加「错误：」前缀，
    // 让调度器的 startsWithError 判定与 npm 标志位口径同时生效。
    if ((res as { isError?: boolean }).isError === true) {
      raw = `错误：工具报告执行失败（非零退出码或运行异常）\n${raw}`
    }
    return guardToolResult(raw)
  } catch (err: any) {
    // 中止导致的 reject 归一为取消语义（不视为工具错误）
    if (signal?.aborted) return '⚠ 已被用户中止'
    return `错误：${err?.message || String(err)}`
  }
}
