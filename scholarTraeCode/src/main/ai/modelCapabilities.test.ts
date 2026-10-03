// modelCapabilities 视觉能力单测（2.3 s31/s33）：
// 锁定 vision 标注：预设矩阵云端模型 + 本地模型名字启发，
// 前端据此门控附件入口（非 vision 模型不静默发图）。
import { describe, it, expect } from 'vitest'
import { resolveCapabilities, inferCapabilities } from './modelCapabilities'

describe('预设矩阵 vision 标注', () => {
  it('OpenAI：4o/4o-mini/4.1 有视觉，3.5 无视觉', () => {
    expect(resolveCapabilities('gpt-4o').vision).toBe(true)
    expect(resolveCapabilities('gpt-4o-mini').vision).toBe(true)
    expect(resolveCapabilities('gpt-4.1-mini').vision).toBe(true)
    expect(resolveCapabilities('gpt-3.5-turbo').vision).toBe(false)
  })

  it('Anthropic Claude 全系（opus/sonnet/haiku）有视觉', () => {
    expect(resolveCapabilities('claude-3-opus-20240229').vision).toBe(true)
    expect(resolveCapabilities('claude-3-5-sonnet-20241022').vision).toBe(true)
    expect(resolveCapabilities('claude-3-5-haiku-20241022').vision).toBe(true)
  })

  it('Gemini 全系有视觉；DeepSeek 无视觉', () => {
    expect(resolveCapabilities('gemini-2.0-flash').vision).toBe(true)
    expect(resolveCapabilities('gemini-1.5-pro').vision).toBe(true)
    expect(resolveCapabilities('deepseek-chat').vision).toBe(false)
    expect(resolveCapabilities('deepseek-reasoner').vision).toBe(false)
  })

  it('通义千问：VL 视觉版有视觉，max/plus/turbo 文本版无视觉', () => {
    expect(resolveCapabilities('qwen2.5-vl-72b-instruct').vision).toBe(true)
    expect(resolveCapabilities('qwen-vl-max').vision).toBe(true)
    expect(resolveCapabilities('qwen-max').vision).toBe(false)
    expect(resolveCapabilities('qwen-plus').vision).toBe(false)
    expect(resolveCapabilities('qwen-turbo').vision).toBe(false)
  })
})

describe('名字启发 vision（本地模型未收录预设时）', () => {
  it('常见本地视觉模型命名 → vision=true', () => {
    const visualNames = [
      'llava:7b',
      'llava-llama3:8b',
      'qwen2.5-vl:7b',
      'qwen-vl:2b',
      'llama3.2-vision:11b',
      'moondream:1.8b',
      'pixtral:12b',
      'minicpm-v:8b'
    ]
    for (const n of visualNames) {
      expect(inferCapabilities(n).vision, `期望 ${n} 有视觉`).toBe(true)
    }
  })

  it('普通文本/代码模型 → vision=false', () => {
    const textNames = [
      'qwen2.5:7b',
      'llama3.1:8b',
      'deepseek-coder:6.7b',
      'qwen3:14b',
      'phi3:3.8b'
    ]
    for (const n of textNames) {
      expect(inferCapabilities(n).vision, `期望 ${n} 无视觉`).toBe(false)
    }
  })
})
