// 2.2 Provider 真 abort 单测：Ollama fetch 直连 / 非流式 chat signal / 内部 abort 方法
// 全部 mock fetch，不触网；OllamaProvider 跳过 ensure（healthy 置真）。
//
// 阶段一重构后：OllamaProvider 不再持有 currentModelName 等状态字段，
// 当前驻留模型由 modelRegistry 单源维护。测试通过 _setCurrentForTest 注入 Registry 状态。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { isAbortError } from '../types'
import { OllamaProvider } from './ollamaProvider'
import { makeOpenAiCompatibleProvider } from './openaiCompatibleProvider'
import { AnthropicProvider } from './anthropicProvider'
import { _setCurrentForTest, _resetRegistryForTest } from '../modelRegistry'
import type { ModelChoice } from '../adaptiveScheduler'

vi.mock('../keyStore', () => ({ getKey: () => 'test-key' }))

const enc = new TextEncoder()

/** 测试专用：构造一个最小的 ModelChoice 注入 Registry（OllamaProvider 通过 getActiveModel 拉取） */
function makeTestChoice(name: string, numCtx = 8192): ModelChoice {
  return {
    profile: {
      name,
      family: 'qwen',
      paramSize: 8,
      fileSizeGB: 5,
      isCoder: false,
      isMoE: false,
      raw: {}
    } as ModelChoice['profile'],
    numCtx,
    reason: 'test'
  }
}

/** 永不 resolve、仅在 signal abort 时 reject 的 fetch（模拟长请求被真中断） */
function hangingFetch() {
  return vi.fn((_url: string, init: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      const sig = init.signal as AbortSignal
      sig.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'))
      })
    })
  })
}

/** 一次性返回 NDJSON 流体的 fetch（Ollama 流式协议） */
function ndjsonStreamFetch(lines: object[]) {
  const text = lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
  return vi.fn(async () => {
    return {
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({}),
      body: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(text))
          c.close()
        }
      })
    } as unknown as Response
  })
}

/** 一次性返回 JSON 的 fetch（非流式） */
function jsonFetch(payload: unknown) {
  return vi.fn(async () => {
    return {
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => payload
    } as unknown as Response
  })
}

describe('isAbortError', () => {
  it('识别 AbortError name', () => {
    expect(isAbortError(new DOMException('x', 'AbortError'))).toBe(true)
  })
  it('识别 message 含 abort', () => {
    expect(isAbortError(new Error('This operation was aborted'))).toBe(true)
    expect(isAbortError(new Error('已中止'))).toBe(true)
  })
  it('普通错误不误判', () => {
    expect(isAbortError(new Error('HTTP 500'))).toBe(false)
    expect(isAbortError('string error')).toBe(false)
  })
})

describe('OllamaProvider abort（s28）', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', hangingFetch())
    _resetRegistryForTest()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    _resetRegistryForTest()
  })

  function makeProvider(): OllamaProvider {
    const p = new OllamaProvider()
    // 跳过 ensure()（避免启动内嵌 Ollama）；fetch 已 mock，无需健康探测
    ;(p as any).healthy = true
    // 阶段一重构：OllamaProvider 不再持有模型状态，改为注入 Registry 状态
    _setCurrentForTest(makeTestChoice('test-model', 8192), 'executor')
    return p
  }

  it('外部 signal abort → chat 返回「已中止」，fetch 收到可中断 signal', async () => {
    const p = makeProvider()
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    const ctrl = new AbortController()
    const pending = p.chat({ messages: [{ role: 'user', content: 'hi' }], signal: ctrl.signal })
    // 等 fetch 被调用后再 abort
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    ctrl.abort()
    const res = await pending
    expect(res.ok).toBe(false)
    expect(res.error).toBe('已中止')
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.signal).toBeTruthy()
    expect((init.signal as AbortSignal).aborted).toBe(true)
  })

  it('provider.abort() → 在途 chat 返回「已中止」', async () => {
    const p = makeProvider()
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    const pending = p.chat({ messages: [{ role: 'user', content: 'hi' }] })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    p.abort()
    const res = await pending
    expect(res.ok).toBe(false)
    expect(res.error).toBe('已中止')
  })

  it('chatStream 中途 abort → 返回「已中止」且不回调 onError', async () => {
    const p = makeProvider()
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    const onError = vi.fn()
    const onDone = vi.fn()
    const pending = p.chatStream(
      { messages: [{ role: 'user', content: 'hi' }] },
      { onChunk: () => {}, onDone, onError }
    )
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    p.abort()
    const res = await pending
    expect(res.ok).toBe(false)
    expect(res.error).toBe('已中止')
    expect(onError).not.toHaveBeenCalled()
    expect(onDone).not.toHaveBeenCalled()
  })

  it('chatStream 正常解析 NDJSON：chunk/usage/onDone', async () => {
    vi.stubGlobal(
      'fetch',
      ndjsonStreamFetch([
        { message: { content: '你' }, done: false },
        { message: { content: '好' }, done: false },
        { message: { content: '' }, done: true, prompt_eval_count: 3, eval_count: 7 }
      ])
    )
    const p = makeProvider()
    const chunks: string[] = []
    let usage: any
    let doneInfo: any
    const res = await p.chatStream(
      { messages: [{ role: 'user', content: 'hi' }] },
      {
        onChunk: (d) => chunks.push(d),
        onDone: (i) => (doneInfo = i),
        onError: () => {},
        onUsage: (u) => (usage = u)
      }
    )
    expect(res.ok).toBe(true)
    expect(chunks.join('')).toBe('你好')
    expect(usage).toEqual({ tokensIn: 3, tokensOut: 7 })
    // onDone 的 model 现在来自 Registry 的 active.modelName（test-model），而非 params.model
    expect(doneInfo.model).toBe('ollama:test-model')
  })

  it('chat 正常返回 content/toolCalls/usage', async () => {
    vi.stubGlobal(
      'fetch',
      jsonFetch({
        message: { content: 'ok', tool_calls: [{ function: { name: 'bash' } }] },
        prompt_eval_count: 5,
        eval_count: 9
      })
    )
    const p = makeProvider()
    const res = await p.chat({ messages: [{ role: 'user', content: 'hi' }] })
    expect(res.ok).toBe(true)
    expect(res.content).toBe('ok')
    expect(res.toolCalls).toHaveLength(1)
    expect(res.usage).toEqual({ tokensIn: 5, tokensOut: 9 })
  })

  // ============== 阶段一新增：无驻留模型错误路径 + 拉模式验证 ==============

  it('未调用 switchModel 时 chat 返回「模型未驻留」错误（拉模式）', async () => {
    // 重置 Registry，模拟完全无驻留
    _resetRegistryForTest()
    const p = new OllamaProvider()
    ;(p as any).healthy = true
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>

    const res = await p.chat({ messages: [{ role: 'user', content: 'hi' }] })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('模型未驻留')
    expect(res.error).toContain('switchModel')
    // 未发起任何 HTTP 请求（提前返回）
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('未调用 switchModel 时 chatStream 返回「模型未驻留」错误并触发 onError', async () => {
    _resetRegistryForTest()
    const p = new OllamaProvider()
    ;(p as any).healthy = true
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    const onError = vi.fn()
    const onDone = vi.fn()

    const res = await p.chatStream(
      { messages: [{ role: 'user', content: 'hi' }] },
      { onChunk: () => {}, onDone, onError }
    )
    expect(res.ok).toBe(false)
    expect(res.error).toContain('模型未驻留')
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('模型未驻留'))
    expect(onDone).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('wire payload 中的 model 字段来自 Registry，不是 \'auto\'', async () => {
    let capturedBody: any = null
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body ?? '{}'))
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({ message: { content: 'ok' } })
      } as unknown as Response
    }))
    _setCurrentForTest(makeTestChoice('real-qwen3-8b', 4096), 'executor')
    const p = new OllamaProvider()
    ;(p as any).healthy = true

    await p.chat({ messages: [{ role: 'user', content: 'hi' }] })
    expect(capturedBody).not.toBeNull()
    expect(capturedBody.model).toBe('real-qwen3-8b')
    expect(capturedBody.model).not.toBe('auto')
    expect(capturedBody.options?.num_ctx).toBe(4096)
  })
})

describe('OpenAI 兼容 Provider 非流式 signal（s28）', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const provider = makeOpenAiCompatibleProvider({
    id: 'deepseek',
    displayName: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1'
  })

  it('chat 传入 signal：abort 后返回「已中止」且 fetch 收到 signal', async () => {
    vi.stubGlobal('fetch', hangingFetch())
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    const ctrl = new AbortController()
    const pending = provider.chat({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'hi' }],
      signal: ctrl.signal
    })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    ctrl.abort()
    const res = await pending
    expect(res.ok).toBe(false)
    expect(res.error).toBe('已中止')
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect((init.signal as AbortSignal).aborted).toBe(true)
  })

  it('chat 无 signal 时 provider.abort() 也能中断', async () => {
    vi.stubGlobal('fetch', hangingFetch())
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    const pending = provider.chat({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'hi' }]
    })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    provider.abort!()
    const res = await pending
    expect(res.ok).toBe(false)
    expect(res.error).toBe('已中止')
  })
})

describe('Anthropic Provider 非流式 signal（s28）', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('chat 传入 signal：abort 后返回「已中止」', async () => {
    vi.stubGlobal('fetch', hangingFetch())
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    const p = new AnthropicProvider()
    const ctrl = new AbortController()
    const pending = p.chat({
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: 'hi' }],
      signal: ctrl.signal
    })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    ctrl.abort()
    const res = await pending
    expect(res.ok).toBe(false)
    expect(res.error).toBe('已中止')
  })
})
