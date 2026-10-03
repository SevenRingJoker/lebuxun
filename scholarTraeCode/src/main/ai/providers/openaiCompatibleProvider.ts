// OpenAI 兼容 Provider 工厂：一套实现覆盖 OpenAI / DeepSeek / llama.cpp / 任意兼容端点。
// 不引入 openai SDK（主进程 CJS 打包对 ESM SDK 互操作有坑，且少一个依赖），
// 用原生 fetch + 手写 SSE 流解析（Node 18+/Electron 22+ 自带全局 fetch）。
// 流式请求带 stream_options.include_usage，末 chunk 的 token 统计经 onUsage 回调上报；
// API Key 从 keyStore 读取（主进程内部流转，不落渲染进程）。
import type { AiProvider, AiMessage, AiStreamCallbacks, ModelEntry } from '../types'
import { isAbortError } from '../types'
import { resolveCapabilities } from '../modelCapabilities'
import { getKey } from '../keyStore'
import { parseSseData } from '../sseParse'
// 2.3 多模态：parts 消息转 OpenAI content 块
import { toOpenAiMessages } from '../messageParts'

/** 工厂配置：一个端点配置对应一个 provider 实例 */
export interface OpenAiCompatibleConfig {
  /** 供应商唯一 id（同时是 keyStore 的 Key 索引） */
  id: string
  /** 展示名（设置页/模型下拉分组标题） */
  displayName: string
  /** 形如 https://api.deepseek.com/v1（不含尾斜杠） */
  baseUrl: string
}

export function makeOpenAiCompatibleProvider(cfg: OpenAiCompatibleConfig): AiProvider {
  /** 当前在途请求的中止器（abort() / 外部 signal 两用） */
  let abortRef: (() => void) | null = null

  /** 合并外部 signal 与内部 abort：任一触发即断开底层 fetch */
  function mergeSignal(external?: AbortSignal): AbortSignal {
    if (!external) {
      const ctrl = new AbortController()
      abortRef = () => ctrl.abort()
      return ctrl.signal
    }
    const ctrl = new AbortController()
    abortRef = () => ctrl.abort()
    return AbortSignal.any([ctrl.signal, external])
  }

  /** 请求头：有 Key 加 Bearer，无 Key（llama.cpp 本地）仅 JSON 头 */
  function headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    const key = getKey(cfg.id)
    if (key) h.Authorization = `Bearer ${key}`
    return h
  }

  /** 统一错误文案：HTTP 状态码 + 截断的响应体，便于在 UI 里直接定位问题 */
  async function httpError(res: Response): Promise<string> {
    const text = await res.text().catch(() => '')
    return `HTTP ${res.status} ${text.slice(0, 200)}`.trim()
  }

  async function health(): Promise<{ ok: boolean; version?: string; error?: string }> {
    try {
      const res = await fetch(`${cfg.baseUrl}/models`, { headers: headers() })
      if (!res.ok) return { ok: false, error: await httpError(res) }
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) }
    }
  }

  async function listModels(): Promise<ModelEntry[]> {
    try {
      const res = await fetch(`${cfg.baseUrl}/models`, { headers: headers() })
      if (!res.ok) return []
      const data: any = await res.json()
      const list: any[] = Array.isArray(data?.data) ? data.data : []
      return list
        .map((m) => String(m?.id ?? ''))
        .filter((name) => name)
        .map((name) => ({
          id: `${cfg.id}:${name}`,
          providerId: cfg.id,
          name,
          displayName: name,
          capabilities: resolveCapabilities(name),
          available: true
        }))
    } catch {
      return []
    }
  }

  /** 非流式聊天：透传 tools（OpenAI function calling 格式），返回文本/toolCalls/usage */
  async function chat(params: {
    model: string
    messages: AiMessage[]
    tools?: unknown[]
    signal?: AbortSignal
  }): Promise<{
    ok: boolean
    content?: string
    toolCalls?: unknown[]
    usage?: { tokensIn?: number; tokensOut?: number }
    error?: string
  }> {
    const signal = mergeSignal(params.signal)
    try {
      // 2.3 parts 消息转 OpenAI 线协议（无 parts 原样透传）
      const wireMessages = await toOpenAiMessages(params.messages)
      const body: Record<string, unknown> = { model: params.model, messages: wireMessages }
      if (params.tools && params.tools.length > 0) {
        body.tools = params.tools
        body.tool_choice = 'auto'
      }
      const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: headers(),
        signal,
        body: JSON.stringify(body)
      })
      if (!res.ok) return { ok: false, error: await httpError(res) }
      const data: any = await res.json()
      const msg = data?.choices?.[0]?.message
      const out: {
        ok: boolean
        content: string
        toolCalls?: unknown[]
        usage?: { tokensIn?: number; tokensOut?: number }
      } = { ok: true, content: typeof msg?.content === 'string' ? msg.content : '' }
      if (Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0) out.toolCalls = msg.tool_calls
      const usage = data?.usage
      if (usage && typeof usage === 'object') {
        const tokensIn = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined
        const tokensOut =
          typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined
        if (tokensIn !== undefined || tokensOut !== undefined) out.usage = { tokensIn, tokensOut }
      }
      return out
    } catch (err: any) {
      // 用户主动中止：不触发回退
      if (signal.aborted || isAbortError(err)) return { ok: false, error: '已中止' }
      return { ok: false, error: err?.message || String(err) }
    } finally {
      abortRef = null
    }
  }

  /** 流式聊天：fetch + ReadableStream 逐行解析 SSE，增量经 onChunk 推送 */
  async function chatStream(
    params: { model: string; messages: AiMessage[]; signal?: AbortSignal },
    callbacks: AiStreamCallbacks
  ): Promise<{ ok: boolean; error?: string }> {
    const signal = mergeSignal(params.signal)
    try {
      // 2.3 parts 消息转 OpenAI 线协议
      const wireMessages = await toOpenAiMessages(params.messages)
      const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: headers(),
        signal,
        body: JSON.stringify({
          model: params.model,
          messages: wireMessages,
          stream: true,
          // 末 chunk 携带 usage（OpenAI 约定；DeepSeek/新版 llama.cpp 兼容）
          stream_options: { include_usage: true }
        })
      })
      if (!res.ok || !res.body) {
        const msg = res.ok ? '响应无 body' : await httpError(res)
        callbacks.onError(msg)
        return { ok: false, error: msg }
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      // 逐块读取 → 按行切分（半截行留在缓冲）→ 逐行解析 SSE
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const parsed = parseSseData(line)
          if (!parsed) continue
          if (parsed.content) callbacks.onChunk(parsed.content)
          if (parsed.usage) callbacks.onUsage?.(parsed.usage)
        }
      }
      callbacks.onDone({ model: `${cfg.id}:${params.model}` })
      return { ok: true }
    } catch (err: any) {
      // 用户主动中止：UI 已取消，不再向上抛错触发回退提示
      if (signal.aborted || isAbortError(err)) return { ok: false, error: '已中止' }
      const msg = err?.message || String(err)
      callbacks.onError(msg)
      return { ok: false, error: msg }
    } finally {
      abortRef = null
    }
  }

  return {
    id: cfg.id,
    displayName: cfg.displayName,
    health,
    listModels,
    chat,
    chatStream,
    abort: () => abortRef?.()
  }
}
