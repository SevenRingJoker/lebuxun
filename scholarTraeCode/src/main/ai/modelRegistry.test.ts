// modelRegistry 单元测试：自适应切换 + 互斥锁 + warmup/unload。
// mock fetch 覆盖 /api/tags（模型发现）、/api/ps（显存/已加载）、/api/generate（unload/warmup）。
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  switchModel,
  safeSwitch,
  currentRole,
  currentChoice,
  unloadCurrentModel,
  warmupModel,
  _resetRegistryForTest,
  _setCurrentForTest
} from './modelRegistry'
import type { ModelChoice } from './adaptiveScheduler'
import type { ModelProfile } from './modelDiscovery'

function mkProfile(name: string, paramSize: number, fileSizeGB: number, isCoder = false): ModelProfile {
  return {
    name,
    family: 'qwen',
    paramSize,
    quantization: 'Q4_K_M',
    fileSizeGB,
    isCoder,
    isInstruct: true,
    isMoE: false,
    raw: { name, size: fileSizeGB * 1e9 }
  }
}

function mkChoice(name: string, paramSize: number, fileSizeGB: number, numCtx = 4096, isCoder = false): ModelChoice {
  const profile = mkProfile(name, paramSize, fileSizeGB, isCoder)
  return { profile, numCtx, reason: `${name} ctx=${numCtx}` }
}

/** 构造 mock fetch：覆盖 /api/tags（模型清单）、/api/ps（已加载）、/api/generate（unload/warmup）、/api/chat（warmup） */
function mockFetch(models: Array<{ name: string; size: number }>, loaded: Array<{ name: string; size_vram: number }> = []) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url)
    if (u.includes('/api/tags')) {
      return new Response(JSON.stringify({ models }), { status: 200 })
    }
    if (u.includes('/api/ps')) {
      return new Response(JSON.stringify({ models: loaded }), { status: 200 })
    }
    if (u.includes('/api/generate')) {
      return new Response('{}', { status: 200 })
    }
    if (u.includes('/api/chat')) {
      return new Response(JSON.stringify({ message: { content: 'ok' } }), { status: 200 })
    }
    return new Response('not found', { status: 404 })
  }) as unknown as typeof fetch
}

describe('modelRegistry（自适应版）', () => {
  beforeEach(() => {
    _resetRegistryForTest()
    vi.stubGlobal('fetch', mockFetch([]))
  })

  describe('switchModel', () => {
    it('从 Ollama 动态选择模型（不硬编码）', async () => {
      vi.stubGlobal('fetch', mockFetch([{ name: 'qwen3:8b-q4_K_M', size: 5.2e9 }]))
      const r = await switchModel('executor')
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(r.choice.profile.name).toBe('qwen3:8b-q4_K_M')
        expect(r.choice.numCtx).toBeGreaterThan(0)
      }
    })

    it('已在驻留同角色 → 直接返回', async () => {
      vi.stubGlobal('fetch', mockFetch([{ name: 'qwen3:8b-q4_K_M', size: 5.2e9 }]))
      const first = await switchModel('executor')
      expect(first.ok).toBe(true)
      const second = await switchModel('executor')
      expect(second.ok).toBe(true)
      if (second.ok) {
        expect(second.choice.profile.name).toBe('qwen3:8b-q4_K_M')
      }
    })

    it('切换角色 → 卸载旧模型并加载新模型', async () => {
      vi.stubGlobal('fetch', mockFetch([{ name: 'qwen3:8b-q4_K_M', size: 5.2e9 }]))
      await switchModel('executor')
      expect(currentRole()).toBe('executor')
      // 再切 planner：会 unload 再 warmup（mock fetch 已覆盖）
      const r = await switchModel('planner')
      expect(r.ok).toBe(true)
      expect(currentRole()).toBe('planner')
    })

    it('无可用模型 → 返回 error', async () => {
      vi.stubGlobal('fetch', mockFetch([]))
      const r = await switchModel('planner')
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.error).toContain('无可用模型')
      }
    })
  })

  describe('safeSwitch', () => {
    it('无可用模型时返回 error（自适应内部已处理降级/放宽）', async () => {
      vi.stubGlobal('fetch', mockFetch([]))
      const r = await safeSwitch('planner')
      expect(r.ok).toBe(false)
    })

    it('正常选择', async () => {
      vi.stubGlobal('fetch', mockFetch([{ name: 'qwen3:14b-q4_K_M', size: 9.5e9 }]))
      const r = await safeSwitch('planner')
      expect(r.ok).toBe(true)
    })
  })

  describe('warmupModel', () => {
    it('成功返回 ok', async () => {
      const choice = mkChoice('qwen3:8b', 8, 5.2)
      const r = await warmupModel(choice)
      expect(r.ok).toBe(true)
    })
  })

  describe('unloadCurrentModel', () => {
    it('清空 current 与 currentRole_', async () => {
      const choice = mkChoice('qwen3:8b', 8, 5.2)
      _setCurrentForTest(choice, 'executor')
      expect(currentChoice()).not.toBeNull()
      await unloadCurrentModel()
      expect(currentChoice()).toBeNull()
      expect(currentRole()).toBeNull()
    })

    it('current 为 null 时安全返回', async () => {
      await expect(unloadCurrentModel()).resolves.toBeUndefined()
    })
  })

  describe('测试辅助', () => {
    it('_setCurrentForTest 设置驻留状态', () => {
      const choice = mkChoice('qwen3:14b', 14, 9.5)
      _setCurrentForTest(choice, 'planner')
      expect(currentRole()).toBe('planner')
      expect(currentChoice()?.profile.name).toBe('qwen3:14b')
    })
  })
})
