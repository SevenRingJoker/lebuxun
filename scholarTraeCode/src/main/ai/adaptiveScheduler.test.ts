// adaptiveScheduler 单元测试：角色选择 + 显存约束 + 家族优先级 + 兜底策略 + 诊断版。
import { describe, it, expect } from 'vitest'
import {
  selectModelForRole,
  selectModelForRoleWithDiagnostics,
  getTotalVram,
  getFreeVram,
  type ModelRole
} from './adaptiveScheduler'

function mockModels(models: Array<{ name: string; size: number }>) {
  return (async () =>
    new Response(JSON.stringify({ models }), { status: 200 })) as typeof fetch
}

describe('selectModelForRole', () => {
  it('executor 选参数量最小的（8B 优于 14B）', async () => {
    const fetchImpl = mockModels([
      { name: 'qwen3:14b-q4_K_M', size: 9.5e9 },
      { name: 'qwen3:8b-q4_K_M', size: 5.2e9 }
    ])
    const choice = await selectModelForRole('executor', 12, { fetchImpl })
    expect(choice).not.toBeNull()
    expect(choice!.profile.paramSize).toBe(8)
  })

  it('coder 优先代码专用模型', async () => {
    const fetchImpl = mockModels([
      { name: 'qwen3:14b-q4_K_M', size: 9.5e9 },
      { name: 'deepseek-coder-v2:16b-lite-q4_K_M', size: 8.9e9 }
    ])
    const choice = await selectModelForRole('coder', 12, { fetchImpl })
    expect(choice!.profile.isCoder).toBe(true)
    expect(choice!.profile.family).toBe('deepseek')
  })

  it('显存不足时上下文递减（targetCtx → 0.75× → 0.5× → minCtx）', async () => {
    const fetchImpl = mockModels([{ name: 'qwen3:14b-q4_K_M', size: 9.5e9 }])
    // 14B + 8192 ctx ≈ 10.9GB；availableVram=12 → 12*0.9=10.8 < 10.9，触发 0.75×
    // 0.75× = 6144: 9.5 + 14*6*0.008 + 0.5 = 10.672 ≤ 10.8 → 通过
    const tight = await selectModelForRole('planner', 12, { fetchImpl })
    expect(tight!.numCtx).toBe(6144)
    // 显存充足时直接用 targetCtx
    const enough = await selectModelForRole('planner', 16, { fetchImpl })
    expect(enough!.numCtx).toBe(8192)
  })

  it('极端显存不足走兜底（最小模型+minCtx）', async () => {
    const fetchImpl = mockModels([
      { name: 'qwen3:8b-q4_K_M', size: 5.2e9 },
      { name: 'qwen3:3b-q4_K_M', size: 2e9 }
    ])
    // 可用显存极低（1GB）：所有候选 ctx 档位都过不了 → 兜底选最小文件 + minCtx(2048)
    const choice = await selectModelForRole('executor', 1, { fetchImpl })
    expect(choice).not.toBeNull()
    expect(choice!.numCtx).toBe(2048)
    expect(choice!.profile.paramSize).toBe(3)
    expect(choice!.reason).toContain('兜底')
  })

  it('无可用模型返回 null', async () => {
    const fetchImpl = mockModels([])
    expect(await selectModelForRole('planner', 16, { fetchImpl })).toBeNull()
  })

  it('家族偏好：planner 优先 qwen 再 deepseek', async () => {
    const fetchImpl = mockModels([
      { name: 'deepseek-chat:14b-q4_K_M', size: 9.5e9 },
      { name: 'qwen3:14b-q4_K_M', size: 9.5e9 }
    ])
    const choice = await selectModelForRole('planner', 16, { fetchImpl })
    expect(choice!.profile.family).toBe('qwen')
  })

  it('参数范围过滤：小于 minParams 被排除', async () => {
    const fetchImpl = mockModels([
      { name: 'qwen3:1.5b-q4_K_M', size: 1e9 },
      { name: 'qwen3:8b-q4_K_M', size: 5.2e9 }
    ])
    const choice = await selectModelForRole('planner', 16, { fetchImpl })
    expect(choice!.profile.paramSize).toBe(8)
  })

  it('参数量过滤后无候选 → 放宽到全部模型', async () => {
    const fetchImpl = mockModels([{ name: 'tiny:0.5b-q4_K_M', size: 0.3e9 }])
    // planner 要求 ≥7B，但只有 0.5B → 放宽后兜底
    const choice = await selectModelForRole('planner', 16, { fetchImpl })
    expect(choice).not.toBeNull()
    expect(choice!.profile.paramSize).toBe(0.5)
  })
})

describe('selectModelForRoleWithDiagnostics', () => {
  it('返回拒绝日志与可用模型清单', async () => {
    const fetchImpl = mockModels([
      { name: 'qwen3:1.5b-q4_K_M', size: 1e9 },
      { name: 'qwen3:14b-q4_K_M', size: 9.5e9 }
    ])
    const diag = await selectModelForRoleWithDiagnostics('planner', 16, { fetchImpl })
    expect(diag.totalAvailable).toBe(2)
    expect(diag.availableNames).toContain('qwen3:14b-q4_K_M')
    expect(diag.freeVramGB).toBe(16)
    expect(diag.rejectionLog.some((s) => s.includes('1.5B < 最低要求 7B'))).toBe(true)
    expect(diag.choice).not.toBeNull()
    expect(diag.choice!.reason).toContain('qwen3:14b')
  })

  it('无可用模型时记录原因', async () => {
    const fetchImpl = mockModels([])
    const diag = await selectModelForRoleWithDiagnostics('planner', 16, { fetchImpl })
    expect(diag.choice).toBeNull()
    expect(diag.rejectionLog.some((s) => s.includes('没有任何可用模型'))).toBe(true)
  })
})

describe('getTotalVram', () => {
  it('默认 16GB', () => {
    delete process.env.TRAECODE_VRAM_GB
    expect(getTotalVram()).toBe(16)
  })

  it('环境变量覆盖', () => {
    process.env.TRAECODE_VRAM_GB = '24'
    expect(getTotalVram()).toBe(24)
    delete process.env.TRAECODE_VRAM_GB
  })

  it('非法值回退默认', () => {
    process.env.TRAECODE_VRAM_GB = 'abc'
    expect(getTotalVram()).toBe(16)
    process.env.TRAECODE_VRAM_GB = '-5'
    expect(getTotalVram()).toBe(16)
    delete process.env.TRAECODE_VRAM_GB
  })
})

describe('getFreeVram', () => {
  it('从 listLoadedModels 累加显存', async () => {
    // mock fetch 同时处理 /api/tags 和 /api/ps
    const fetchImpl = (async (url: string) => {
      if (url.includes('/api/ps')) {
        return new Response(
          JSON.stringify({ models: [{ name: 'qwen3:14b', size_vram: 9.5e9 }] }),
          { status: 200 }
        )
      }
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    const free = await getFreeVram({ fetchImpl })
    expect(free).toBeCloseTo(16 - 9.5, 1)
  })
})
