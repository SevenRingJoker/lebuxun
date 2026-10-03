// Anthropic Provider：对接 Claude 系列模型（https://api.anthropic.com）。
// 与 OpenAI 兼容层的差异：鉴权用 x-api-key + anthropic-version 头；
// system 消息需合并进顶层 system 字段；SSE 事件流为 content_block_delta / message_delta。
// 暂只支持对话/流式（chat 不带 tools），tool 模式标注为后续增强。
import type { AiProvider, AiMessage, AiStreamCallbacks, ModelEntry } from '../types'
import { isAbortError } from '../types'
import { resolveCapabilities } from '../modelCapabilities'
import { getKey } from '../keyStore'
// 2.3 多模态：parts 消息转 Anthropic image blocks
import { toAnthropicContent } from '../messageParts'

const BASE_URL = 'https://api.anthropic.com'
const PROVIDER_ID = 'anthropic'
/** Anthropic API 版本头（官方稳定版） */
const API_VERSION = '2023-06-01'
/** 默认 max_tokens：Anthropic 必填，取一个够用的生成上限 */
const DEFAULT_MAX_TOKENS = 8192

export class AnthropicProvider implements AiProvider {
  readonly id = PROVIDER_ID
  readonly displayName = 'Anthropic（Claude）'

  private abortRef: (() => void) | null = null

  /** 请求头：必须带 x-api-key + anthropic-version */
  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': getKey(PROVIDER_ID) ?? '',
      'anthropic-version': API_VERSION
    }
  }

  private async httpError(res: Response): Promise<string> {
    const text = await res.text().catch(() => '')
    return `HTTP ${res.status} ${text.slice(0, 200)}`.trim()
  }

  /**
   * 消息转换：抽出 system 合并为顶层字段，其余映射为 user/assistant（tool 角色降级为 user 文本）。
   * user 含 parts 时 content 转 Anthropic text/image blocks（2.3）。
   */
  private async convertMessages(
    messages: AiMessage[]
  ): Promise<{ system?: string; messages: unknown[] }> {
    const systemParts: string[] = []
    const converted: { role: string; content: string | unknown[] }[] = []
    for (const m of messages) {
      if (m.role === 'system') {
        systemParts.push(m.content)
      } else if (m.role === 'user') {
        // 2.3 无 parts 返回纯字符串；有 parts 返回 block 数组
        converted.push({ role: 'user', content: await toAnthropicContent(m) })
      } else {
        // assistant / tool 都并入 assistant 侧（tool 结果以文本形式回填）
        converted.push({ role: 'assistant', content: m.content })
      }
    }
    return {
      system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
      messages: converted
    }
  }

  async health(): Promise<{ ok: boolean; version?: string; error?: string }> {
    try {
      if (!getKey(PROVIDER_ID)) return { ok: false, error: '未配置 API Key' }
      const res = await fetch(`${BASE_URL}/v1/models`, { headers: this.headers() })
      if (!res.ok) return { ok: false, error: await this.httpError(res) }
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) }
    }
  }

  async listModels(): Promise<ModelEntry[]> {
    try {
      if (!getKey(PROVIDER_ID)) return []
      const res = await fetch(`${BASE_URL}/v1/models`, { headers: this.headers() })
      if (!res.ok) return []
      const data: any = await res.json()
      const list: any[] = Array.isArray(data?.data) ? data.data : []
      return list
        .map((m) => String(m?.id ?? ''))
        .filter((name) => name)
        .map((name) => ({
          id: `${PROVIDER_ID}:${name}`,
          providerId: PROVIDER_ID,
          name,
          displayName: name,
          capabilities: resolveCapabilities(name),
          available: true
        }))
    } catch {
      return []
    }
  }

  /** 合并外部 signal 与内部 abort */
  private mergeSignal(external?: AbortSignal): AbortSignal {
    if (!external) {
      const ctrl = new AbortController()
      this.abortRef = () => ctrl.abort()
      return ctrl.signal
    }
    const ctrl = new AbortController()
    this.abortRef = () => ctrl.abort()
    return AbortSignal.any([ctrl.signal, external])
  }

  /** 非流式对话（不带 tools；tool 模式后续增强） */
  async chat(params: {
    model: string
    messages: AiMessage[]
    tools?: unknown[]
    signal?: AbortSignal
  }): Promise<{
    ok: boolean
    content?: string
    usage?: { tokensIn?: number; tokensOut?: number }
    error?: string
  }> {
    const signal = this.mergeSignal(params.signal)
    try {
      const { system, messages } = await this.convertMessages(params.messages)
      const res = await fetch(`${BASE_URL}/v1/messages`, {
        method: 'POST',
        headers: this.headers(),
        signal,
        body: JSON.stringify({
          model: params.model,
          max_tokens: DEFAULT_MAX_TOKENS,
          system,
          messages
        })
      })
      if (!res.ok) return { ok: false, error: await this.httpError(res) }
      const data: any = await res.json()
      // content 为 block 数组，拼接所有 text 块
      const blocks: any[] = Array.isArray(data?.content) ? data.content : []
      const content = blocks
        .filter((b) => b?.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('')
      const usage = data?.usage
      return {
        ok: true,
        content,
        usage:
          usage && typeof usage === 'object'
            ? { tokensIn: usage.input_tokens, tokensOut: usage.output_tokens }
            : undefined
      }
    } catch (err: any) {
      // 用户主动中止：不触发回退
      if (signal.aborted || isAbortError(err)) return { ok: false, error: '已中止' }
      return { ok: false, error: err?.message || String(err) }
    } finally {
      this.abortRef = null
    }
  }

  /** 流式对话：SSE 事件 content_block_delta → onChunk；message_start/message_delta → onUsage */
  async chatStream(
    params: { model: string; messages: AiMessage[]; signal?: AbortSignal },
    callbacks: AiStreamCallbacks
  ): Promise<{ ok: boolean; error?: string }> {
    const signal = this.mergeSignal(params.signal)
    try {
      const { system, messages } = await this.convertMessages(params.messages)
      const res = await fetch(`${BASE_URL}/v1/messages`, {
        method: 'POST',
        headers: this.headers(),
        signal,
        body: JSON.stringify({
          model: params.model,
          max_tokens: DEFAULT_MAX_TOKENS,
          system,
          messages,
          stream: true
        })
      })
      if (!res.ok || !res.body) {
        const msg = res.ok ? '响应无 body' : await this.httpError(res)
        callbacks.onError(msg)
        return { ok: false, error: msg }
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let tokensIn: number | undefined
      let tokensOut: number | undefined
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const t = line.trim()
          if (!t.startsWith('data:')) continue
          let obj: any
          try {
            obj = JSON.parse(t.slice(5).trim())
          } catch {
            continue // 半截 JSON 留待行缓冲拼好
          }
          // 文本增量
          if (obj?.type === 'content_block_delta' && obj.delta?.type === 'text_delta') {
            const text = obj.delta.text
            if (typeof text === 'string' && text) callbacks.onChunk(text)
          }
          // usage：message_start 带 input_tokens，message_delta 带 output_tokens
          if (obj?.type === 'message_start' && typeof obj.message?.usage?.input_tokens === 'number') {
            tokensIn = obj.message.usage.input_tokens
          }
          if (obj?.type === 'message_delta' && typeof obj.usage?.output_tokens === 'number') {
            tokensOut = obj.usage.output_tokens
          }
        }
      }
      if (tokensIn !== undefined || tokensOut !== undefined) {
        callbacks.onUsage?.({ tokensIn, tokensOut })
      }
      callbacks.onDone({ model: `${PROVIDER_ID}:${params.model}` })
      return { ok: true }
    } catch (err: any) {
      if (signal.aborted || isAbortError(err)) return { ok: false, error: '已中止' }
      const msg = err?.message || String(err)
      callbacks.onError(msg)
      return { ok: false, error: msg }
    } finally {
      this.abortRef = null
    }
  }

  abort(): void {
    this.abortRef?.()
  }
}
