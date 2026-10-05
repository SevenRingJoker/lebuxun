// modelDiscovery 单元测试：画像解析（纯函数）+ /api/tags 拉取（mock fetch）+ 显存估算公式。
import { describe, it, expect } from 'vitest'
import { parseModelProfile, listOllamaModels, listLoadedModels, pingOllama, estimateVram } from './modelDiscovery'

describe('parseModelProfile', () => {
  it('qwen 全家桶：家族/参数量/量化/指令微调', () => {
    const p = parseModelProfile({ name: 'qwen3:14b-instruct-q4_K_M', size: 9.5e9 })
    expect(p).not.toBeNull()
    expect(p!.family).toBe('qwen')
    expect(p!.paramSize).toBe(14)
    expect(p!.quantization).toBe('Q4_K_M')
    expect(p!.isInstruct).toBe(true)
    expect(p!.isCoder).toBe(false)
    expect(p!.isMoE).toBe(false)
    expect(p!.fileSizeGB).toBeCloseTo(9.5, 1)
  })

  it('deepseek-coder-v2 识别 isCoder + isMoE', () => {
    const p = parseModelProfile({ name: 'deepseek-coder-v2:16b-lite-instruct-q4_K_M', size: 8.9e9 })
    expect(p!.family).toBe('deepseek')
    expect(p!.paramSize).toBe(16)
    expect(p!.isCoder).toBe(true)
    expect(p!.isMoE).toBe(true)
  })

  it('mixtral 识别 isMoE + 归并 mistral 家族', () => {
    const p = parseModelProfile({ name: 'mixtral:8x7b-q4_K_M', size: 26e9 })
    expect(p!.isMoE).toBe(true)
    expect(p!.family).toBe('mistral')
  })

  it('codestral → mistral 家族 + isCoder', () => {
    const p = parseModelProfile({ name: 'codestral:22b-q4_K_M', size: 12e9 })
    expect(p!.family).toBe('mistral')
    expect(p!.isCoder).toBe(true)
  })

  it('codellama → llama 家族 + isCoder', () => {
    const p = parseModelProfile({ name: 'codellama:7b-q4_K_M', size: 4e9 })
    expect(p!.family).toBe('llama')
    expect(p!.isCoder).toBe(true)
  })

  it('小数参数量（6.7b / 1.5b）', () => {
    expect(parseModelProfile({ name: 'deepseek-coder:6.7b', size: 0 })!.paramSize).toBe(6.7)
    expect(parseModelProfile({ name: 'qwen2:1.5b', size: 0 })!.paramSize).toBe(1.5)
  })

  it('无量化标识回退 UNKNOWN', () => {
    const p = parseModelProfile({ name: 'llama3:8b', size: 0 })
    expect(p!.quantization).toBe('UNKNOWN')
    expect(p!.family).toBe('llama')
  })

  it('f16 / fp16 量化识别', () => {
    expect(parseModelProfile({ name: 'mistral:7b-f16', size: 0 })!.quantization).toBe('F16')
    expect(parseModelProfile({ name: 'mistral:7b-fp16', size: 0 })!.quantization).toBe('FP16')
  })

  it('size 缺失/非法按 0 处理', () => {
    expect(parseModelProfile({ name: 'qwen3:8b' })!.fileSizeGB).toBe(0)
    expect(parseModelProfile({ name: 'qwen3:8b', size: NaN })!.fileSizeGB).toBe(0)
  })

  it('raw 字段保留原始响应', () => {
    const raw = { name: 'qwen3:8b', size: 5e9, digest: 'abc' }
    const p = parseModelProfile(raw)
    expect(p!.raw).toEqual(raw)
  })

  it('无名条目返回 null', () => {
    expect(parseModelProfile({})).toBeNull()
    expect(parseModelProfile(null)).toBeNull()
    expect(parseModelProfile('str')).toBeNull()
  })

  it('model 字段兜底（部分 Ollama 版本返回 model 而非 name）', () => {
    const p = parseModelProfile({ model: 'phi4:14b-q4_K_M', size: 9e9 })
    expect(p!.name).toBe('phi4:14b-q4_K_M')
    expect(p!.family).toBe('phi')
  })
})

describe('listOllamaModels', () => {
  it('正常拉取并过滤无效项', async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          models: [
            { name: 'qwen3:14b-q4_K_M', size: 9.5e9 },
            { name: 'qwen3:8b-q4_K_M', size: 5.2e9 },
            { bad: 'entry' }
          ]
        }),
        { status: 200 }
      )
    const list = await listOllamaModels({ fetchImpl: fetchImpl as typeof fetch })
    expect(list).toHaveLength(2)
    expect(list[0].paramSize).toBe(14)
    expect(list[1].paramSize).toBe(8)
  })

  it('HTTP 非 200 → 空数组', async () => {
    const fetchImpl = async () => new Response('err', { status: 500 })
    expect(await listOllamaModels({ fetchImpl: fetchImpl as typeof fetch })).toEqual([])
  })

  it('网络异常 → 空数组（不抛）', async () => {
    const fetchImpl = async () => {
      throw new Error('ECONNREFUSED')
    }
    expect(await listOllamaModels({ fetchImpl: fetchImpl as typeof fetch })).toEqual([])
  })
})

describe('listLoadedModels', () => {
  it('返回已加载模型及显存占用（GB）', async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          models: [
            { name: 'qwen3:14b', size_vram: 9.5e9 },
            { name: 'qwen3:8b', size_vram: 5.2e9 }
          ]
        }),
        { status: 200 }
      )
    const list = await listLoadedModels({ fetchImpl: fetchImpl as typeof fetch })
    expect(list).toHaveLength(2)
    expect(list[0].sizeVramGB).toBeCloseTo(9.5, 1)
  })

  it('异常返回空数组', async () => {
    const fetchImpl = async () => {
      throw new Error('x')
    }
    expect(await listLoadedModels({ fetchImpl: fetchImpl as typeof fetch })).toEqual([])
  })
})

describe('pingOllama', () => {
  it('200 → true', async () => {
    const fetchImpl = async () => new Response('{}', { status: 200 })
    expect(await pingOllama({ fetchImpl: fetchImpl as typeof fetch })).toBe(true)
  })
  it('异常 → false', async () => {
    const fetchImpl = async () => {
      throw new Error('x')
    }
    expect(await pingOllama({ fetchImpl: fetchImpl as typeof fetch })).toBe(false)
  })
})

describe('estimateVram', () => {
  it('权重 + KV cache + 0.5GB 开销', () => {
    const p = parseModelProfile({ name: 'qwen3:14b', size: 9.5e9 })!
    // weights=9.5, kv=14*(8192/1024)*0.008=0.896, overhead=0.5 → ≈10.896
    expect(estimateVram(p, 8192)).toBeCloseTo(9.5 + 0.896 + 0.5, 2)
  })

  it('MoE 模型 KV cache 按 paramSize/6 估算', () => {
    const p = parseModelProfile({ name: 'deepseek-coder-v2:16b-lite-q4_K_M', size: 8.9e9 })!
    // effectiveParams = 16/6 ≈ 2.667; kv = 2.667*(16384/1024)*0.008 ≈ 0.341
    const expected = 8.9 + (16 / 6) * 16 * 0.008 + 0.5
    expect(estimateVram(p, 16384)).toBeCloseTo(expected, 2)
  })

  it('num_ctx 减半 → 估算同步下降', () => {
    const p = parseModelProfile({ name: 'qwen3:14b', size: 9.5e9 })!
    const full = estimateVram(p, 8192)
    const half = estimateVram(p, 4096)
    expect(full - half).toBeCloseTo(14 * 4 * 0.008, 3)
  })
})
