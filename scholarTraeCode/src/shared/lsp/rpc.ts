// JSON-RPC 2.0 关联器：在注入的传输层（Electron IPC 桥 / 测试桩）之上，
// 提供 request（id 关联 Promise）、notify、服务端请求应答、通知订阅。
// 零 DOM/Electron 依赖：传输层通过 RpcTransport 接口注入。
import type { RpcError } from './types'

/** 传输层：发送一帧字符串消息；注册收消息回调 */
export interface RpcTransport {
  send(data: string): void
  onMessage(cb: (data: string) => void): void
}

type Pending = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

/** JSON-RPC 客户端句柄 */
export interface JsonRpc {
  /** 发请求并等待对应 id 的响应 */
  request<T = unknown>(method: string, params?: unknown): Promise<T>
  /** 发通知（无 id，不等待响应） */
  notify(method: string, params?: unknown): void
  /** 订阅服务端通知 */
  onNotification(method: string, handler: (params: unknown) => void): void
  /** 应答服务端请求：handler 返回值作为 result，抛错作为 error */
  onRequest(method: string, handler: (params: unknown) => unknown | Promise<unknown>): void
  /** 释放全部等待中的请求（断开时调用） */
  dispose(reason?: string): void
}

/** 创建 JSON-RPC 关联器 */
export function createJsonRpc(transport: RpcTransport): JsonRpc {
  let nextId = 1
  const pending = new Map<number, Pending>()
  const notificationHandlers = new Map<string, Set<(params: unknown) => void>>()
  const requestHandlers = new Map<string, (params: unknown) => unknown | Promise<unknown>>()

  // 收到一帧 JSON-RPC 消息：按 id/method 分流
  function handleRaw(raw: string): void {
    let msg: {
      id?: number
      method?: string
      params?: unknown
      result?: unknown
      error?: RpcError
    }
    try {
      msg = JSON.parse(raw)
    } catch {
      // 非 JSON 帧（不应出现），忽略
      return
    }

    // 响应帧：id 命中等待中的请求
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && !msg.method) {
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      if (msg.error) {
        p.reject(new RpcResponseError(msg.error))
      } else {
        p.resolve(msg.result)
      }
      return
    }

    // 请求帧（服务端 → 客户端）
    if (msg.id !== undefined && msg.method) {
      const handler = requestHandlers.get(msg.method)
      if (!handler) return
      // 同层 try/catch：同步抛错与异步 reject 都在此捕获，两微任务内发出应答
      Promise.resolve().then(async () => {
        try {
          const value = await handler(msg.params)
          transport.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: value ?? null }))
        } catch (err: unknown) {
          transport.send(
            JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              error: { code: -32603, message: err instanceof Error ? err.message : String(err) }
            })
          )
        }
      })
      return
    }

    // 通知帧
    if (msg.method) {
      const handlers = notificationHandlers.get(msg.method)
      if (handlers) for (const h of handlers) h(msg.params)
    }
  }

  transport.onMessage(handleRaw)

  return {
    request<T>(method: string, params?: unknown): Promise<T> {
      const id = nextId++
      const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? null })
      return new Promise<T>((resolve, reject) => {
        pending.set(id, {
          resolve: resolve as (v: unknown) => void,
          reject
        })
        try {
          transport.send(payload)
        } catch (e) {
          pending.delete(id)
          reject(e instanceof Error ? e : new Error(String(e)))
        }
      })
    },

    notify(method: string, params?: unknown): void {
      transport.send(JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {} }))
    },

    onNotification(method, handler) {
      let set = notificationHandlers.get(method)
      if (!set) {
        set = new Set()
        notificationHandlers.set(method, set)
      }
      set.add(handler)
    },

    onRequest(method, handler) {
      requestHandlers.set(method, handler)
    },

    dispose(reason = 'JSON-RPC 连接已关闭') {
      for (const [id, p] of pending) {
        pending.delete(id)
        p.reject(new Error(reason))
      }
    }
  }
}

/** JSON-RPC 错误响应异常（携带 code/data 供调用方判别） */
export class RpcResponseError extends Error {
  readonly code: number
  readonly data?: unknown

  constructor(error: RpcError) {
    super(error.message)
    this.name = 'RpcResponseError'
    this.code = error.code
    this.data = error.data
  }
}
