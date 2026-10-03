// AI 调试内置工具单测：注册表可见性 + 无会话时的错误提示
import { describe, it, expect } from 'vitest'
import { DEBUG_TOOLS } from './builtinToolsDebug'
import { collectBuiltinTools, isBuiltinTool, callBuiltinTool } from './builtinTools'

describe('DEBUG_TOOLS 注册', () => {
  it('三个调试工具均已注册进总表', () => {
    const names = collectBuiltinTools().map((t) => t.name)
    expect(names).toContain('debug_get_context')
    expect(names).toContain('debug_apply_breakpoint')
    expect(names).toContain('debug_evaluate')
    expect(isBuiltinTool('debug_get_context')).toBe(true)
    expect(isBuiltinTool('debug_apply_breakpoint')).toBe(true)
    expect(isBuiltinTool('debug_evaluate')).toBe(true)
    expect(DEBUG_TOOLS).toHaveLength(3)
  })

  it('无活跃会话：debug_get_context 返回提示', async () => {
    const out = await callBuiltinTool('debug_get_context', {})
    expect(out).toContain('无活跃调试会话')
  })

  it('无活跃会话：debug_apply_breakpoint 报错', async () => {
    const out = await callBuiltinTool('debug_apply_breakpoint', { path: '/w/a.py', lines: [3] })
    expect(out).toContain('无活跃调试会话')
  })

  it('参数校验：缺 path / 空 lines / 缺 expression', async () => {
    expect(await callBuiltinTool('debug_apply_breakpoint', { lines: [1] })).toContain('缺少 path')
    expect(await callBuiltinTool('debug_apply_breakpoint', { path: '/a.py', lines: [] })).toContain('lines 为空')
    expect(await callBuiltinTool('debug_evaluate', {})).toContain('缺少 expression')
  })

  it('非 DAP 会话：debug_evaluate 提示仅支持 Python/Go', async () => {
    const out = await callBuiltinTool('debug_evaluate', { expression: 'x + 1' })
    expect(out).toContain('仅支持 Python/Go')
  })
})
