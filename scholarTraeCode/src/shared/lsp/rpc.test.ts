// rpc.ts 单测：请求-响应关联、错误拒绝、通知订阅、服务端请求应答、dispose
import { describe, it, expect, vi } from 'vitest'
import { createJsonRpc, RpcResponseError, type RpcTransport } from './rpc'

/** 内存传输桩：记录发送内容，允许测试主动推入消息 */
function makeTransport(): RpcTransport & {
  sent: string[]
  receive: (msg: unknown) => void
} {
  const sent: string[] = []
  let handler: ((data: string) => void) | null = null
  return {
    sent,
    send(data: string) {
      sent.push(data)
    },
    onMessage(cb) {
      handler = cb
    },
    receive(msg: unknown) {
      handler?.(typeof msg === 'string' ? msg : JSON.stringify(msg))
    }
  }
}

describe('createJsonRpc — request', () => {
  it('request 发送带 id 的消息，收到同 id 响应后 resolve', async () => {
    const t = makeTransport()
    const rpc = createJsonRpc(t)
    const p = rpc.request<{ value: number }>('test/method', { a: 1 })

    // 已发送一帧带 id=1 的请求
    expect(t.sent).toHaveLength(1)
    const sentMsg = JSON.parse(t.sent[0])
    expect(sentMsg.id).toBe(1)
    expect(sentMsg.method).toBe('test/method')
    expect(sentMsg.params).toEqual({ a: 1 })

    // 模拟服务端响应
    t.receive({ jsonrpc: '2.0', id: 1, result: { value: 42 } })
    await expect(p).resolves.toEqual({ value: 42 })
  })

  it('id 自增（多个并发请求不串）', async () => {
    const t = makeTransport()
    const rpc = createJsonRpc(t)
    const p1 = rpc.request('m1')
    const p2 = rpc.request('m2')
    expect(JSON.parse(t.sent[0]).id).toBe(1)
    expect(JSON.parse(t.sent[1]).id).toBe(2)

    // 乱序响应
    t.receive({ jsonrpc: '2.0', id: 2, result: 'second' })
    t.receive({ jsonrpc: '2.0', id: 1, result: 'first' })
    await expect(p1).resolves.toBe('first')
    await expect(p2).resolves.toBe('second')
  })

  it('error 响应 reject 为 RpcResponseError（携带 code）', async () => {
    const t = makeTransport()
    const rpc = createJsonRpc(t)
    const p = rpc.request('fail')
    t.receive({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: '方法不存在' } })
    await expect(p).rejects.toBeInstanceOf(RpcResponseError)
    await expect(p).rejects.toMatchObject({ code: -32601, message: '方法不存在' })
  })

  it('发送时抛错则请求 reject', async () => {
    const rpc = createJsonRpc({
      send: () => {
        throw new Error('管道已关闭')
      },
      onMessage: () => {}
    })
    await expect(rpc.request('m')).rejects.toThrow('管道已关闭')
  })
})

describe('createJsonRpc — notify', () => {
  it('notify 发送无 id 帧', () => {
    const t = makeTransport()
    const rpc = createJsonRpc(t)
    rpc.notify('textDocument/didOpen', { uri: 'x' })
    const msg = JSON.parse(t.sent[0])
    expect(msg.id).toBeUndefined()
    expect(msg.method).toBe('textDocument/didOpen')
    expect(msg.params).toEqual({ uri: 'x' })
  })
})

describe('createJsonRpc — 通知订阅', () => {
  it('onNotification 收到对应方法的服务端通知', () => {
    const t = makeTransport()
    const rpc = createJsonRpc(t)
    const handler = vi.fn()
    rpc.onNotification('textDocument/publishDiagnostics', handler)
    t.receive({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: { uri: 'file:///x', diagnostics: [] }
    })
    expect(handler).toHaveBeenCalledWith({ uri: 'file:///x', diagnostics: [] })
  })

  it('未订阅的通知被忽略', () => {
    const t = makeTransport()
    const rpc = createJsonRpc(t)
    // 不应抛错
    t.receive({ jsonrpc: '2.0', method: 'unknown/event', params: {} })
  })

  it('支持同一通知多个处理器', () => {
    const t = makeTransport()
    const rpc = createJsonRpc(t)
    const h1 = vi.fn()
    const h2 = vi.fn()
    rpc.onNotification('evt', h1)
    rpc.onNotification('evt', h2)
    t.receive({ jsonrpc: '2.0', method: 'evt', params: 1 })
    expect(h1).toHaveBeenCalledWith(1)
    expect(h2).toHaveBeenCalledWith(1)
  })
})

describe('createJsonRpc — 服务端请求', () => {
  it('onRequest handler 返回值作为 result 应答', async () => {
    const t = makeTransport()
    const rpc = createJsonRpc(t)
    rpc.onRequest('window/workDoneProgress/cancel', () => 'ok')
    t.receive({ jsonrpc: '2.0', id: 99, method: 'window/workDoneProgress/cancel', params: {} })
    // 等待微任务（handler 经 Promise.resolve 调度）
    await Promise.resolve()
    await Promise.resolve()
    const reply = JSON.parse(t.sent[0])
    expect(reply.id).toBe(99)
    expect(reply.result).toBe('ok')
  })

  it('handler 抛错时应答 error 帧', async () => {
    const t = makeTransport()
    const rpc = createJsonRpc(t)
    rpc.onRequest('m', () => {
      throw new Error('不支持')
    })
    t.receive({ jsonrpc: '2.0', id: 5, method: 'm', params: null })
    await Promise.resolve()
    await Promise.resolve()
    const reply = JSON.parse(t.sent[0])
    expect(reply.id).toBe(5)
    expect(reply.error.code).toBe(-32603)
    expect(reply.error.message).toBe('不支持')
  })

  it('未注册的服务端请求被忽略（不应答）', () => {
    const t = makeTransport()
    createJsonRpc(t)
    t.receive({ jsonrpc: '2.0', id: 1, method: 'unknown', params: null })
    expect(t.sent).toHaveLength(0)
  })
})

describe('createJsonRpc — 容错与 dispose', () => {
  it('非 JSON 帧被忽略', () => {
    const t = makeTransport()
    createJsonRpc(t)
    expect(() => t.receive('not json')).not.toThrow()
  })

  it('dispose 拒绝全部等待中的请求', async () => {
    const t = makeTransport()
    const rpc = createJsonRpc(t)
    const p1 = rpc.request('m1')
    const p2 = rpc.request('m2')
    rpc.dispose('连接断开')
    await expect(p1).rejects.toThrow('连接断开')
    await expect(p2).rejects.toThrow('连接断开')
  })
})
