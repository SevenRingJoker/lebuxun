// dapCore 纯函数层单测：帧编解码、半包/粘包、请求匹配、断点规范化、响应解析兜底
import { describe, it, expect } from 'vitest'
import {
  encodeDapMessage,
  createDapDecoder,
  feedDapChunk,
  isRequest,
  isResponse,
  isEvent,
  createSeqAllocator,
  matchResponse,
  normalizeBreakpoint,
  groupBreakpointsByFile,
  buildLaunchArgs,
  buildAttachArgs,
  parseStackFrames,
  parseScopes,
  parseVariables
} from './dapCore'
import type { DapMessage, PendingRequest } from './dapCore'

describe('encodeDapMessage', () => {
  it('编码请求帧包含正确 Content-Length', () => {
    const msg: DapMessage = { seq: 1, type: 'request', command: 'initialize', arguments: {} }
    const buf = encodeDapMessage(msg)
    const str = buf.toString('utf8')
    const body = JSON.stringify(msg)
    expect(str).toBe(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`)
  })

  it('编码含中文的帧，Content-Length 按 UTF-8 字节计', () => {
    const msg: DapMessage = { seq: 2, type: 'request', command: 'evaluate', arguments: { expression: '你好' } }
    const buf = encodeDapMessage(msg)
    const str = buf.toString('utf8')
    const body = JSON.stringify(msg)
    expect(str).toBe(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`)
  })
})

describe('feedDapChunk', () => {
  it('完整单帧解码', () => {
    const msg: DapMessage = { seq: 1, type: 'response', request_seq: 1, success: true, command: 'initialize', body: { supportsConfigurationDoneRequest: true } }
    const buf = encodeDapMessage(msg)
    const state = createDapDecoder()
    const { messages } = feedDapChunk(state, buf.toString('utf8'))
    expect(messages).toHaveLength(1)
    expect(messages[0]).toEqual(msg)
  })

  it('半包头部：先给头部前段，再给剩余', () => {
    const msg: DapMessage = { seq: 1, type: 'event', event: 'initialized' }
    const buf = encodeDapMessage(msg)
    const full = buf.toString('utf8')
    const state = createDapDecoder()
    const mid = full.indexOf('\r\n\r\n') + 2 // 拆在 \r\n 中间
    const r1 = feedDapChunk(state, full.slice(0, mid))
    expect(r1.messages).toHaveLength(0)
    const r2 = feedDapChunk(r1.state, full.slice(mid))
    expect(r2.messages).toHaveLength(1)
  })

  it('半包 JSON：头部完整、身体未收齐', () => {
    const msg: DapMessage = { seq: 1, type: 'event', event: 'stopped', body: { reason: 'breakpoint' } }
    const buf = encodeDapMessage(msg)
    const full = buf.toString('utf8')
    const splitAt = full.indexOf('\r\n\r\n') + 4 + 3 // 身体给 3 字节
    const state = createDapDecoder()
    const r1 = feedDapChunk(state, full.slice(0, splitAt))
    expect(r1.messages).toHaveLength(0)
    const r2 = feedDapChunk(r1.state, full.slice(splitAt))
    expect(r2.messages).toHaveLength(1)
  })

  it('多帧粘连一次解码', () => {
    const m1: DapMessage = { seq: 1, type: 'event', event: 'output', body: { output: 'a' } }
    const m2: DapMessage = { seq: 2, type: 'event', event: 'output', body: { output: 'b' } }
    const data = Buffer.concat([encodeDapMessage(m1), encodeDapMessage(m2)]).toString('utf8')
    const state = createDapDecoder()
    const { messages } = feedDapChunk(state, data)
    expect(messages).toHaveLength(2)
    expect((messages[1] as any).seq).toBe(2)
  })

  it('空块不报错', () => {
    const state = createDapDecoder()
    const r = feedDapChunk(state, '')
    expect(r.messages).toHaveLength(0)
    expect(r.state.buffer).toBe('')
  })

  it('非法头部丢弃后继续找合法帧', () => {
    const msg: DapMessage = { seq: 1, type: 'event', event: 'initialized' }
    const buf = encodeDapMessage(msg)
    const garbage = 'Garbage-Header: 999\r\n\r\n' + buf.toString('utf8')
    const state = createDapDecoder()
    const { messages } = feedDapChunk(state, garbage)
    expect(messages).toHaveLength(1)
    expect((messages[0] as any).event).toBe('initialized')
  })
})

describe('消息类型判别', () => {
  it('isRequest', () => {
    expect(isRequest({ seq: 1, type: 'request', command: 'x' })).toBe(true)
    expect(isRequest({ seq: 1, type: 'response', request_seq: 1, success: true, command: 'x' })).toBe(false)
    expect(isRequest({ seq: 1, type: 'event', event: 'x' })).toBe(false)
  })
  it('isResponse', () => {
    expect(isResponse({ seq: 1, type: 'response', request_seq: 1, success: true, command: 'x' })).toBe(true)
    expect(isResponse({ seq: 1, type: 'request', command: 'x' })).toBe(false)
  })
  it('isEvent', () => {
    expect(isEvent({ seq: 1, type: 'event', event: 'x' })).toBe(true)
    expect(isEvent({ seq: 1, type: 'request', command: 'x' })).toBe(false)
  })
})

describe('createSeqAllocator', () => {
  it('从初始值顺序递增', () => {
    const next = createSeqAllocator(1)
    expect(next()).toBe(1)
    expect(next()).toBe(2)
    expect(next()).toBe(3)
  })
  it('支持自定义起始值', () => {
    const next = createSeqAllocator(100)
    expect(next()).toBe(100)
    expect(next()).toBe(101)
  })
})

describe('matchResponse', () => {
  it('匹配到对应 request_seq 并移除', () => {
    const p1: PendingRequest = { seq: 1, command: 'init', resolve: () => {}, reject: () => {} }
    const p2: PendingRequest = { seq: 2, command: 'launch', resolve: () => {}, reject: () => {} }
    const { matched, remaining } = matchResponse([p1, p2], { seq: 10, type: 'response', request_seq: 2, success: true, command: 'launch' })
    expect(matched?.seq).toBe(2)
    expect(remaining).toHaveLength(1)
    expect(remaining[0].seq).toBe(1)
  })
  it('非响应消息不消耗 pending', () => {
    const p1: PendingRequest = { seq: 1, command: 'init', resolve: () => {}, reject: () => {} }
    const r = matchResponse([p1], { seq: 5, type: 'event', event: 'stopped' })
    expect(r.matched).toBeNull()
    expect(r.remaining).toHaveLength(1)
  })
  it('request_seq 不存在时返回 null', () => {
    const p1: PendingRequest = { seq: 1, command: 'init', resolve: () => {}, reject: () => {} }
    const r = matchResponse([p1], { seq: 10, type: 'response', request_seq: 99, success: true, command: 'x' })
    expect(r.matched).toBeNull()
  })
})

describe('normalizeBreakpoint', () => {
  it('保持绝对路径', () => {
    expect(normalizeBreakpoint('/src/app.ts', 10)).toEqual({ file: '/src/app.ts', line: 10 })
  })
  it('Windows 盘符路径视为绝对', () => {
    expect(normalizeBreakpoint('C:\\project\\a.ts', 5)).toEqual({ file: 'C:\\project\\a.ts', line: 5 })
  })
  it('相对路径拼接 root', () => {
    expect(normalizeBreakpoint('a.ts', 3, '/home/proj')).toEqual({ file: '/home/proj/a.ts', line: 3 })
  })
  it('行号小于 1 时置为 1', () => {
    expect(normalizeBreakpoint('a.ts', 0)).toEqual({ file: 'a.ts', line: 1 })
    expect(normalizeBreakpoint('a.ts', -3)).toEqual({ file: 'a.ts', line: 1 })
  })
  it('去首尾空格', () => {
    expect(normalizeBreakpoint('  a.ts  ', 2)).toEqual({ file: 'a.ts', line: 2 })
  })
})

describe('groupBreakpointsByFile', () => {
  it('按文件分组并排序行号', () => {
    const bps = [
      normalizeBreakpoint('a.ts', 5),
      normalizeBreakpoint('b.ts', 1),
      normalizeBreakpoint('a.ts', 3)
    ]
    const map = groupBreakpointsByFile(bps)
    expect(map.get('a.ts')).toEqual([3, 5])
    expect(map.get('b.ts')).toEqual([1])
  })
})

describe('buildLaunchArgs', () => {
  it('含 entry 与默认值', () => {
    const args = buildLaunchArgs({ entry: '/proj/index.js' })
    expect(args).toMatchObject({ type: 'node', request: 'launch', name: 'Launch', program: '/proj/index.js', stopOnEntry: false, args: [] })
  })
  it('含可选字段', () => {
    const args = buildLaunchArgs({ entry: '/proj/index.js', args: ['--port', '3000'], cwd: '/proj', env: { NODE_ENV: 'dev' } })
    expect(args).toMatchObject({ args: ['--port', '3000'], cwd: '/proj', env: { NODE_ENV: 'dev' } })
  })
})

describe('buildAttachArgs', () => {
  it('默认 host', () => {
    const args = buildAttachArgs({ port: 9229 })
    expect(args).toMatchObject({ type: 'node', request: 'attach', name: 'Attach', port: 9229, host: '127.0.0.1' })
  })
  it('自定义 host', () => {
    const args = buildAttachArgs({ port: 9229, host: '0.0.0.0' })
    expect(args.host).toBe('0.0.0.0')
  })
})

describe('parseStackFrames', () => {
  it('正常解析', () => {
    const frames = parseStackFrames({
      stackFrames: [
        { id: 1, name: 'main', source: { path: '/a.ts' }, line: 10, column: 2 },
        { id: 2, name: 'foo', source: { path: '/b.ts' }, line: 20, column: 5 }
      ]
    })
    expect(frames).toHaveLength(2)
    expect(frames[0]).toEqual({ id: 1, name: 'main', file: '/a.ts', line: 10, column: 2 })
  })
  it('source 缺失时用 name 兜底 file', () => {
    const frames = parseStackFrames({ stackFrames: [{ id: 3, name: 'anon', line: 1, column: 0 }] })
    expect(frames[0].file).toBe('')
  })
  it('空输入返回空数组', () => {
    expect(parseStackFrames(null)).toEqual([])
    expect(parseStackFrames(undefined)).toEqual([])
    expect(parseStackFrames({})).toEqual([])
  })
  it('id 非法时过滤', () => {
    const frames = parseStackFrames({ stackFrames: [{ id: 'bad', name: 'x', line: 1, column: 0 }] })
    expect(frames).toHaveLength(0)
  })
})

describe('parseScopes', () => {
  it('正常解析', () => {
    const scopes = parseScopes({ scopes: [{ name: 'Local', variablesReference: 1000, expensive: false }] })
    expect(scopes).toHaveLength(1)
    expect(scopes[0]).toEqual({ name: 'Local', variablesReference: 1000, expensive: false })
  })
  it('空输入返回空数组', () => {
    expect(parseScopes(null)).toEqual([])
    expect(parseScopes({})).toEqual([])
  })
})

describe('parseVariables', () => {
  it('正常解析', () => {
    const vars = parseVariables({ variables: [{ name: 'x', value: '42', type: 'number', variablesReference: 0 }] })
    expect(vars).toHaveLength(1)
    expect(vars[0]).toEqual({ name: 'x', value: '42', type: 'number', variablesReference: 0 })
  })
  it('空输入返回空数组', () => {
    expect(parseVariables(null)).toEqual([])
    expect(parseVariables({})).toEqual([])
  })
})
