// SSE 行解析纯函数单测：覆盖增量文本 / [DONE] / usage / 非法行忽略 / tool_calls 分片
import { describe, it, expect } from 'vitest'
import { parseSseData } from './sseParse'

describe('parseSseData（OpenAI 兼容 SSE 行解析）', () => {
  it('解析增量文本 chunk', () => {
    const r = parseSseData('data: {"choices":[{"delta":{"content":"你好"}}]}')
    expect(r).not.toBeNull()
    expect(r!.content).toBe('你好')
    expect(r!.done).toBe(false)
    expect(r!.toolCalls).toHaveLength(0)
    expect(r!.usage).toBeUndefined()
  })

  it('解析终止标记 [DONE]', () => {
    const r = parseSseData('data: [DONE]')
    expect(r?.done).toBe(true)
    expect(r?.content).toBe('')
  })

  it('解析末 chunk 的 usage 统计', () => {
    const r = parseSseData(
      'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":22}}'
    )
    expect(r?.usage?.tokensIn).toBe(11)
    expect(r?.usage?.tokensOut).toBe(22)
  })

  it('usage 字段类型异常时不产生 usage', () => {
    const r = parseSseData('data: {"choices":[],"usage":"bad"}')
    expect(r).toBeNull()
  })

  it('忽略空行/注释/event 行/非 data 行', () => {
    expect(parseSseData('')).toBeNull()
    expect(parseSseData('   ')).toBeNull()
    expect(parseSseData(': keep-alive')).toBeNull()
    expect(parseSseData('event: ping')).toBeNull()
  })

  it('忽略半截与非法 JSON', () => {
    expect(parseSseData('data: {"choices":[{"delta":{"con')).toBeNull()
    expect(parseSseData('data: not-json')).toBeNull()
  })

  it('忽略纯心跳空 delta', () => {
    expect(parseSseData('data: {"choices":[{"delta":{}}]}')).toBeNull()
  })

  it('解析 tool_calls 分片', () => {
    const r = parseSseData(
      'data: {"choices":[{"delta":{"tool_calls":[{"id":"call_1","type":"function","function":{"name":"write","arguments":"{}"}}]}}]}'
    )
    expect(r?.toolCalls).toHaveLength(1)
    const tc: any = r!.toolCalls[0]
    expect(tc.function.name).toBe('write')
  })
})
