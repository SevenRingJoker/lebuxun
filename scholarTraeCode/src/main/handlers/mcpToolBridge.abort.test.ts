// s29 callMcpTool 的 signal 透传：
// - 内置工具分支：signal 传给 callBuiltinTool（bash 等据此杀进程树）
// - MCP 分支：signal 传给 client.callTool 第三参（SDK 1.30 abort 时自动发 notifications/cancelled）
// - 已中止 signal：MCP 分支短路，不发起新调用
// - 在途 abort 导致的 SDK reject 归一为「已被用户中止」（不视为工具错误）
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  callBuiltinTool: vi.fn(),
  isBuiltinTool: vi.fn(),
  clients: new Map<string, { callTool: ReturnType<typeof vi.fn> }>()
}))

vi.mock('../ai/builtinTools', () => ({
  collectBuiltinTools: () => [],
  isBuiltinTool: (n: string) => mocks.isBuiltinTool(n),
  callBuiltinTool: (n: string, a: Record<string, unknown>, w?: string | null, s?: AbortSignal) =>
    mocks.callBuiltinTool(n, a, w, s)
}))
vi.mock('./mcp', () => ({ getMcpClients: () => mocks.clients }))
vi.mock('../ai/contentGuard', () => ({ guardToolResult: (s: string) => s }))

import { callMcpTool } from './mcpToolBridge'

describe('s29 callMcpTool signal 透传', () => {
  beforeEach(() => {
    mocks.callBuiltinTool.mockReset()
    mocks.isBuiltinTool.mockReset()
    mocks.clients.clear()
  })

  it('内置工具分支：signal 原样透传给 callBuiltinTool', async () => {
    mocks.isBuiltinTool.mockReturnValue(true)
    mocks.callBuiltinTool.mockResolvedValue('builtin-result')
    const ctrl = new AbortController()
    const r = await callMcpTool('ignored', 'bash', { command: 'echo hi' }, '/ws', ctrl.signal)
    expect(r).toBe('builtin-result')
    expect(mocks.callBuiltinTool).toHaveBeenCalledWith('bash', { command: 'echo hi' }, '/ws', ctrl.signal)
  })

  it('MCP 分支：signal 作为第三参传给 client.callTool', async () => {
    mocks.isBuiltinTool.mockReturnValue(false)
    const callTool = vi.fn(async () => ({ content: 'mcp-ok' }))
    mocks.clients.set('srv', { callTool })
    const ctrl = new AbortController()
    const r = await callMcpTool('srv', 'some_tool', { x: 1 }, null, ctrl.signal)
    expect(r).toBe('mcp-ok')
    expect(callTool).toHaveBeenCalledWith({ name: 'some_tool', arguments: { x: 1 } }, undefined, { signal: ctrl.signal })
  })

  it('已中止的 signal：MCP 分支短路返回取消，不发起调用', async () => {
    mocks.isBuiltinTool.mockReturnValue(false)
    const callTool = vi.fn(async () => ({ content: 'mcp-ok' }))
    mocks.clients.set('srv', { callTool })
    const ctrl = new AbortController()
    ctrl.abort()
    const r = await callMcpTool('srv', 'some_tool', {}, null, ctrl.signal)
    expect(r).toContain('已被用户中止')
    expect(callTool).not.toHaveBeenCalled()
  })

  it('在途 abort 导致 SDK reject：归一为「已被用户中止」', async () => {
    mocks.isBuiltinTool.mockReturnValue(false)
    const ctrl = new AbortController()
    const callTool = vi.fn(
      () =>
        new Promise((_, reject) => {
          ctrl.signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }))
          )
        })
    )
    mocks.clients.set('srv', { callTool })
    const p = callMcpTool('srv', 'slow_tool', {}, null, ctrl.signal)
    setTimeout(() => ctrl.abort(), 50)
    const r = await p
    expect(r).toContain('已被用户中止')
  })
})
