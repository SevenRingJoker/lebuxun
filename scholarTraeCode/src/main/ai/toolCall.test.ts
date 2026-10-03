// toolCall 工具函数单元测试：coerceToolArgs / dedupeBatchCalls / parseToolCallsFromContent
import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { coerceToolArgs, dedupeBatchCalls, parseToolCallsFromContent, type ToolEntry } from './toolCall'

// 测试用工具列表
const TOOLS: ToolEntry[] = [
  { server: 'builtin', tool: { name: 'write' } },
  { server: 'builtin', tool: { name: 'read' } },
  { server: 'builtin', tool: { name: 'bash' } },
  { server: 'runtime', tool: { name: 'todo_write' } }
]

// ==================== coerceToolArgs ====================
describe('coerceToolArgs', () => {
  it('相对路径拼接到工作区根目录', () => {
    const args = { path: 'src/main.js' }
    const result = coerceToolArgs(args, '/workspace')
    expect(result.path).toBe(join('/workspace', 'src/main.js'))
  })

  it('绝对路径不修改', () => {
    const args = { path: '/abs/path/file.js' }
    const result = coerceToolArgs(args, '/workspace')
    expect(result.path).toBe('/abs/path/file.js')
  })

  it('Windows 绝对路径不修改', () => {
    const args = { path: 'D:\\proj\\a.js' }
    const result = coerceToolArgs(args, 'D:\\workspace')
    expect(result.path).toBe('D:\\proj\\a.js')
  })

  it('无工作区时不修改', () => {
    const args = { path: 'a.js' }
    expect(coerceToolArgs(args, null)).toEqual(args)
    expect(coerceToolArgs(args, undefined)).toEqual(args)
  })

  it('非对象参数原样返回', () => {
    expect(coerceToolArgs('string', '/ws')).toBe('string')
    expect(coerceToolArgs(null, '/ws')).toBeNull()
  })

  it('同时处理多个路径字段', () => {
    const args = { path: 'a.js', source: 'b.js', destination: 'c.js', other: 'd.js' }
    const result = coerceToolArgs(args, '/ws')
    expect(result.path).toBe(join('/ws', 'a.js'))
    expect(result.source).toBe(join('/ws', 'b.js'))
    expect(result.destination).toBe(join('/ws', 'c.js'))
    expect(result.other).toBe('d.js') // 非路径字段不处理
  })
})

// ==================== dedupeBatchCalls ====================
describe('dedupeBatchCalls', () => {
  const makeCall = (name: string, path: string) => ({
    function: { name, arguments: { path } }
  })

  it('同 name+path 重复时只保留最后一个', () => {
    const calls = [
      makeCall('write', '/a.js'),
      makeCall('write', '/b.js'),
      makeCall('write', '/a.js')
    ]
    const result = dedupeBatchCalls(calls)
    expect(result).toHaveLength(2)
    expect(result[0].function.arguments).toEqual({ path: '/b.js' })
    expect(result[1].function.arguments).toEqual({ path: '/a.js' })
  })

  it('不同 path 不视为重复', () => {
    const calls = [makeCall('write', '/a.js'), makeCall('write', '/b.js')]
    expect(dedupeBatchCalls(calls)).toHaveLength(2)
  })

  it('不同 name 相同 path 不视为重复', () => {
    const calls = [
      { function: { name: 'read', arguments: { path: '/a.js' } } },
      { function: { name: 'write', arguments: { path: '/a.js' } } }
    ]
    expect(dedupeBatchCalls(calls)).toHaveLength(2)
  })

  it('空数组返回空数组', () => {
    expect(dedupeBatchCalls([])).toEqual([])
  })

  it('无 path 字段时按 name 去重', () => {
    const calls = [
      { function: { name: 'bash', arguments: { command: 'ls' } } },
      { function: { name: 'bash', arguments: { command: 'pwd' } } }
    ]
    // 两者 path 都为空字符串，key 都是 bash|
    const result = dedupeBatchCalls(calls)
    expect(result).toHaveLength(1)
  })
})

// ==================== parseToolCallsFromContent ====================
describe('parseToolCallsFromContent', () => {
  it('解析 markdown 代码块中的 JSON 工具调用', () => {
    const content = '```json\n{"name":"write","arguments":{"path":"/a.js","content":"x"}}\n```'
    const calls = parseToolCallsFromContent(content, TOOLS)
    expect(calls).toHaveLength(1)
    expect(calls[0].function.name).toBe('write')
  })

  it('解析纯文本中的 JSON 工具调用', () => {
    const content = '{"name":"read","arguments":{"path":"/a.js"}}'
    const calls = parseToolCallsFromContent(content, TOOLS)
    expect(calls).toHaveLength(1)
    expect(calls[0].function.name).toBe('read')
  })

  it('未注册的工具名被忽略', () => {
    const content = '{"name":"unknown_tool","arguments":{}}'
    expect(parseToolCallsFromContent(content, TOOLS)).toHaveLength(0)
  })

  it('空内容返回空数组', () => {
    expect(parseToolCallsFromContent('', TOOLS)).toEqual([])
  })

  it('非法 JSON 不抛出，返回空', () => {
    const content = '这不是 JSON {invalid'
    expect(parseToolCallsFromContent(content, TOOLS)).toEqual([])
  })

  it('支持 args 字段（兼容不同模型输出）', () => {
    const content = '{"name":"bash","args":{"command":"ls"}}'
    const calls = parseToolCallsFromContent(content, TOOLS)
    expect(calls).toHaveLength(1)
    expect(calls[0].function.arguments).toEqual({ command: 'ls' })
  })

  it('多个工具调用全部解析', () => {
    const content =
      '{"name":"write","arguments":{"path":"/a.js"}}\n{"name":"read","arguments":{"path":"/b.js"}}'
    const calls = parseToolCallsFromContent(content, TOOLS)
    expect(calls).toHaveLength(2)
    expect(calls.map((c) => c.function.name)).toEqual(['write', 'read'])
  })

  it('重复的相同调用只保留一个', () => {
    const content =
      '{"name":"write","arguments":{"path":"/a.js"}}\n{"name":"write","arguments":{"path":"/a.js"}}'
    const calls = parseToolCallsFromContent(content, TOOLS)
    expect(calls).toHaveLength(1)
  })
})
