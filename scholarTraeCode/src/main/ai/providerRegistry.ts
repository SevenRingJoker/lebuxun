// Provider 注册中心：集中管理所有模型供应商，提供健康探测与模型清单聚合。
// 新增供应商：在此文件 import 并 push 到 PROVIDERS 即可，调度层自动感知。
import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AiProvider, ModelEntry } from './types'
import { OllamaProvider } from './providers/ollamaProvider'
import { makeOpenAiCompatibleProvider } from './providers/openaiCompatibleProvider'
import { AnthropicProvider } from './providers/anthropicProvider'

// ====================== 供应商配置（持久化） ======================

/** 用户自定义的 OpenAI 兼容端点 */
export interface CustomProviderDef {
  /** 形如 custom-1；自动生成，不允许与预设冲突 */
  id: string
  /** 用户可改的展示名 */
  name: string
  baseUrl: string
}

/** 持久化配置：哪些供应商启用、各供应商的默认模型、自定义端点列表 */
export interface ProviderConfig {
  enabled: string[]
  defaults: { reasoning?: string; completion?: string; chat?: string }
  custom?: CustomProviderDef[]
}

const CONFIG_FILE = () => join(app.getPath('userData'), 'ai-providers.json')

function loadConfig(): ProviderConfig {
  try {
    if (existsSync(CONFIG_FILE())) {
      const cfg = JSON.parse(readFileSync(CONFIG_FILE(), 'utf-8'))
      if (Array.isArray(cfg.enabled)) return cfg
    }
  } catch {
    // 配置损坏时回退默认
  }
  return { enabled: ['ollama'], defaults: {} }
}

function saveConfig(cfg: ProviderConfig): void {
  try {
    writeFileSync(CONFIG_FILE(), JSON.stringify(cfg, null, 2), 'utf-8')
  } catch {
    // 持久化失败不影响运行
  }
}

// ====================== 注册中心 ======================

/** 预设供应商（常驻注册；openai/deepseek/llamacpp 共用 OpenAI 兼容实现） */
const PRESET_PROVIDERS: AiProvider[] = [
  new OllamaProvider(),
  makeOpenAiCompatibleProvider({
    id: 'openai',
    displayName: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1'
  }),
  makeOpenAiCompatibleProvider({
    id: 'deepseek',
    displayName: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1'
  }),
  makeOpenAiCompatibleProvider({
    id: 'llamacpp',
    displayName: 'llama.cpp（本地）',
    baseUrl: 'http://127.0.0.1:8080/v1'
  }),
  new AnthropicProvider()
]

/** 全部已注册供应商实例（预设 + 配置里的自定义端点） */
let PROVIDERS: AiProvider[] = [...PRESET_PROVIDERS]
/** 供应商 id → 实例的快速索引 */
let providerMap = new Map<string, AiProvider>(PROVIDERS.map((p) => [p.id, p]))

let config = loadConfig()
/** 缓存的模型清单（由 refresh() 填充） */
let cachedModels: ModelEntry[] = []

/** 按当前配置重建供应商列表（自定义端点增删后调用） */
function rebuildProviders(): void {
  const customs = (config.custom ?? []).map((c) =>
    makeOpenAiCompatibleProvider({ id: c.id, displayName: c.name, baseUrl: c.baseUrl })
  )
  PROVIDERS = [...PRESET_PROVIDERS, ...customs]
  providerMap = new Map(PROVIDERS.map((p) => [p.id, p]))
}

// 启动时按持久化配置挂上自定义端点
rebuildProviders()

/** 启用的供应商列表 */
export function getEnabledProviders(): AiProvider[] {
  return PROVIDERS.filter((p) => config.enabled.includes(p.id))
}

/** 全部供应商（含未启用），供设置页展示 */
export function getAllProviders(): AiProvider[] {
  return PROVIDERS
}

/** 启用/禁用供应商 */
export function setProviderEnabled(providerId: string, enabled: boolean): void {
  const set = new Set(config.enabled)
  if (enabled) set.add(providerId)
  else set.delete(providerId)
  config.enabled = [...set]
  saveConfig(config)
}

/** 刷新所有启用供应商的模型清单与健康状态 */
export async function refreshModels(): Promise<ModelEntry[]> {
  const all: ModelEntry[] = []
  for (const provider of getEnabledProviders()) {
    const h = await provider.health()
    if (!h.ok) {
      // 供应商不可用：仍列出其模型但标记 unavailable，UI 可据此提示
      try {
        const models = await provider.listModels()
        for (const m of models) all.push({ ...m, available: false })
      } catch {
        // 连模型清单都拿不到就跳过
      }
      continue
    }
    const models = await provider.listModels()
    all.push(...models)
  }
  cachedModels = all
  return all
}

/** 获取缓存的模型清单（无需等待刷新） */
export function getCachedModels(): ModelEntry[] {
  return cachedModels
}

/** 按 id 取供应商实例 */
export function getProvider(id: string): AiProvider | undefined {
  return providerMap.get(id)
}

/** 把 `providerId:modelName` 拆成两段 */
export function parseModelId(id: string): { providerId: string; modelName: string } {
  const idx = id.indexOf(':')
  if (idx < 0) return { providerId: 'ollama', modelName: id }
  return { providerId: id.slice(0, idx), modelName: id.slice(idx + 1) }
}

// ====================== 自定义供应商管理 ======================

/** 是否为内置预设供应商（预设不可删除，只允许启停/配 Key） */
export function isBuiltinProvider(id: string): boolean {
  return PRESET_PROVIDERS.some((p) => p.id === id)
}

/** 自定义端点列表（设置页渲染用） */
export function getCustomProviders(): CustomProviderDef[] {
  return config.custom ?? []
}

/** 新增自定义 OpenAI 兼容端点：自动分配 custom-N id，默认启用 */
export function addCustomProvider(def: { name: string; baseUrl: string }): CustomProviderDef {
  const existing = new Set(PROVIDERS.map((p) => p.id))
  let n = 1
  while (existing.has(`custom-${n}`)) n++
  const entry: CustomProviderDef = {
    id: `custom-${n}`,
    name: def.name.trim() || `自定义端点 ${n}`,
    baseUrl: def.baseUrl.trim().replace(/\/+$/, '') // 去掉尾斜杠，避免拼接出 //chat
  }
  config.custom = [...(config.custom ?? []), entry]
  if (!config.enabled.includes(entry.id)) config.enabled = [...config.enabled, entry.id]
  saveConfig(config)
  rebuildProviders()
  return entry
}

/** 删除自定义端点（仅限 custom-*；同时移出启用列表并清空模型缓存中属于它的条目） */
export function removeCustomProvider(id: string): boolean {
  if (isBuiltinProvider(id)) return false
  const before = (config.custom ?? []).length
  config.custom = (config.custom ?? []).filter((c) => c.id !== id)
  if (config.custom.length === before) return false
  config.enabled = config.enabled.filter((e) => e !== id)
  saveConfig(config)
  rebuildProviders()
  cachedModels = cachedModels.filter((m) => m.providerId !== id)
  return true
}
