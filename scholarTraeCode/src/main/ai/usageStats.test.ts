// 用量统计单测：价格折算、模型/日双维聚合、估算标记、持久化往返、清零
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUsageStore, estimateTokens } from './usageStats'

describe('estimateTokens（字符÷4 估算）', () => {
  it('按 4 字符/token 向上取整', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
  })
})

describe('createUsageStore — 内存模式（filePath=null）', () => {
  it('按价格表折算成本：deepseek-chat 100万入+100万出 = 0.27+1.10', () => {
    const s = createUsageStore(null)
    s.record('deepseek:deepseek-chat', { tokensIn: 1_000_000, tokensOut: 1_000_000 })
    const st = s.getStats()
    expect(st.byModel['deepseek:deepseek-chat'].cost).toBeCloseTo(0.27 + 1.1, 6)
    expect(st.totalCost).toBeCloseTo(1.37, 6)
    expect(st.totalCalls).toBe(1)
  })

  it('未收录价格的模型成本记 0 但仍计 token', () => {
    const s = createUsageStore(null)
    s.record('ollama:qwen2.5:7b', { tokensIn: 500, tokensOut: 800 })
    const mu = s.getStats().byModel['ollama:qwen2.5:7b']
    expect(mu.cost).toBe(0)
    expect(mu.tokensIn).toBe(500)
    expect(mu.tokensOut).toBe(800)
  })

  it('多次调用聚合到同一模型并累计估算次数', () => {
    const s = createUsageStore(null)
    s.record('openai:gpt-4o-mini', { tokensIn: 100, tokensOut: 50 })
    s.record('openai:gpt-4o-mini', { tokensIn: 200, tokensOut: 100, estimated: true })
    const mu = s.getStats().byModel['openai:gpt-4o-mini']
    expect(mu.calls).toBe(2)
    expect(mu.tokensIn).toBe(300)
    expect(mu.tokensOut).toBe(150)
    expect(mu.estimatedCalls).toBe(1)
  })

  it('按日聚合：byDay 当日累计 calls/token/cost', () => {
    const s = createUsageStore(null)
    s.record('deepseek:deepseek-chat', { tokensIn: 1000, tokensOut: 1000 })
    s.record('openai:gpt-4o', { tokensIn: 1000, tokensOut: 1000 })
    const days = Object.values(s.getStats().byDay)
    expect(days).toHaveLength(1)
    expect(days[0].calls).toBe(2)
    expect(days[0].tokensIn).toBe(2000)
    expect(days[0].cost).toBeGreaterThan(0)
  })

  it('reset 清空全部统计', () => {
    const s = createUsageStore(null)
    s.record('openai:gpt-4o', { tokensIn: 10, tokensOut: 10 })
    s.reset()
    const st = s.getStats()
    expect(st.totalCalls).toBe(0)
    expect(Object.keys(st.byModel)).toHaveLength(0)
  })
})

describe('createUsageStore — 文件持久化', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'usage-'))
    file = join(dir, 'ai-usage.json')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('记录后重建实例能读回（持久化往返）', () => {
    const s1 = createUsageStore(file)
    s1.record('deepseek:deepseek-reasoner', { tokensIn: 1_000_000, tokensOut: 500_000 })
    const s2 = createUsageStore(file)
    const mu = s2.getStats().byModel['deepseek:deepseek-reasoner']
    expect(mu.calls).toBe(1)
    expect(mu.cost).toBeCloseTo(0.55 + 2.19 / 2, 6)
  })

  it('损坏的存储文件按空统计处理，不抛错', () => {
    writeFileSync(file, '{broken json', 'utf-8')
    const s = createUsageStore(file)
    expect(s.getStats().totalCalls).toBe(0)
    s.record('openai:gpt-4o', { tokensIn: 1, tokensOut: 1 })
    expect(s.getStats().totalCalls).toBe(1)
  })
})
