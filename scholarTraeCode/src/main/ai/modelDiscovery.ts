// 模型发现层：从 Ollama /api/tags 动态发现所有可用模型，解析能力画像。
// 不依赖任何硬编码模型名——角色调度（adaptiveScheduler）基于画像做选择。
// 零 Electron 依赖，fetch/host 可注入，便于单测。

/** 单个模型的能力画像 */
export interface ModelProfile {
  /** 完整名称，如 "qwen2.5-coder:14b-instruct-q4_K_M" */
  name: string
  /** 家族：qwen | deepseek | llama | mistral | gemma | phi | unknown */
  family: string
  /** 参数量（十亿），如 14 / 8 / 6.7 / 1.5；无法解析为 0 */
  paramSize: number
  /** 量化标识（大写），如 Q4_K_M / Q8_0 / F16；无法解析为 UNKNOWN */
  quantization: string
  /** 磁盘体积（GB） */
  fileSizeGB: number
  /** 是否代码专用（名称含 coder/code/codestral） */
  isCoder: boolean
  /** 是否指令微调（名称含 instruct/chat/-it） */
  isInstruct: boolean
  /** 是否 MoE 架构（如 mixtral/deepseek-coder-v2）；KV cache 按 1/6 估算 */
  isMoE: boolean
  /** 原始 Ollama 响应（调试用） */
  raw: unknown
}

/** Ollama 服务地址（可被 OLLAMA_HOST 环境变量覆盖） */
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434'

/** 从 Ollama /api/tags 拉取全部可用模型（带超时与容错）。失败返回空数组。 */
export async function listOllamaModels(opts?: {
  host?: string
  timeoutMs?: number
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}): Promise<ModelProfile[]> {
  const host = opts?.host ?? OLLAMA_HOST
  const doFetch = opts?.fetchImpl ?? fetch
  const timeoutMs = opts?.timeoutMs ?? 3000
  try {
    const res = await doFetch(`${host}/api/tags`, {
      signal: opts?.signal ?? AbortSignal.timeout(timeoutMs)
    })
    if (!res.ok) return []
    const data = (await res.json()) as { models?: unknown[] }
    return (data.models ?? [])
      .map((m) => parseModelProfile(m))
      .filter((p): p is ModelProfile => p !== null)
  } catch {
    return []
  }
}

/**
 * 从 /api/tags 返回项解析画像（纯函数）。
 * - 参数规模：7b / 14b / 32b / 6.7b / 1.5b / 70b（数字+b 后需为分隔符或结尾，避免误匹配 14b-xxx 中的 14）
 * - 量化：q4_k_m / q5_0 / q8_0 / f16 / fp16 / f32
 * - 家族：qwen/deepseek/llama/mistral/gemma/phi；codestral→mistral；codellama→llama
 */
export function parseModelProfile(raw: unknown): ModelProfile | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const name = typeof r.name === 'string' ? r.name : typeof r.model === 'string' ? r.model : ''
  if (!name) return null

  const lower = name.toLowerCase()
  // 参数规模：要求数字+b 后是分隔符（-_:空格）或结尾，避免 "14b-4bit" 中误抓
  const paramMatch = lower.match(/(\d+(?:\.\d+)?)\s*b(?:[-_:\s]|$)/i)
  const paramSize = paramMatch ? parseFloat(paramMatch[1]) : 0

  // 量化：q4_k_m / q5_k_s / q8_0 / f16 / fp16 / f32
  const quantMatch = lower.match(/\b(q\d+(?:_[a-z0-9]+)*|f(?:p)?16|f32|bf16)\b/i)
  const quantization = quantMatch ? quantMatch[1].toUpperCase() : 'UNKNOWN'

  // 家族识别（codestral/codellama 单独归并）
  let family = 'unknown'
  if (lower.includes('qwen')) family = 'qwen'
  else if (lower.includes('deepseek')) family = 'deepseek'
  else if (lower.includes('llama') || lower.includes('codellama')) family = 'llama'
  else if (lower.includes('mistral') || lower.includes('mixtral') || lower.includes('codestral'))
    family = 'mistral'
  else if (lower.includes('gemma')) family = 'gemma'
  else if (lower.includes('phi')) family = 'phi'

  const isCoder = /coder|code|codestral/i.test(lower)
  const isInstruct = /instruct|chat|-it\b|it[-_:]|it$/i.test(lower)
  const isMoE = /moe|mixtral|deepseek-coder-v2/i.test(lower)
  const sizeBytes = typeof r.size === 'number' && Number.isFinite(r.size) ? r.size : 0

  return {
    name,
    family,
    paramSize,
    quantization,
    fileSizeGB: sizeBytes / 1e9,
    isCoder,
    isInstruct,
    isMoE,
    raw
  }
}

/**
 * 估算模型在给定 num_ctx 下的显存占用（GB）。
 * - 权重显存 ≈ 量化后文件体积
 * - KV Cache：MoE 实际激活参数远小于总参数，按总参数 1/6 估算
 * - Q8 KV cache 经验系数：每 1B 有效参数每 1K ctx 约 0.008GB
 * - 运行时开销 0.5GB
 */
export function estimateVram(profile: ModelProfile, numCtx: number): number {
  const weights = profile.fileSizeGB
  const effectiveParams = profile.isMoE ? profile.paramSize / 6 : profile.paramSize
  const kvCache = effectiveParams * (numCtx / 1024) * 0.008
  const overhead = 0.5
  return weights + kvCache + overhead
}

/** 从 Ollama /api/ps 查询当前已加载的模型（含显存占用 GB） */
export async function listLoadedModels(opts?: {
  host?: string
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}): Promise<{ name: string; sizeVramGB: number }[]> {
  const host = opts?.host ?? OLLAMA_HOST
  const doFetch = opts?.fetchImpl ?? fetch
  try {
    const res = await doFetch(`${host}/api/ps`, {
      signal: opts?.signal ?? AbortSignal.timeout(2000)
    })
    if (!res.ok) return []
    const data = (await res.json()) as { models?: Array<{ name?: string; model?: string; size_vram?: number }> }
    return (data.models ?? []).map((m) => ({
      name: m.name || m.model || '',
      sizeVramGB: (m.size_vram || 0) / 1e9
    }))
  } catch {
    return []
  }
}

/** 探测 Ollama 服务是否可达 */
export async function pingOllama(opts?: {
  host?: string
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}): Promise<boolean> {
  const host = opts?.host ?? OLLAMA_HOST
  const doFetch = opts?.fetchImpl ?? fetch
  try {
    const res = await doFetch(`${host}/api/tags`, {
      method: 'GET',
      signal: opts?.signal ?? AbortSignal.timeout(2000)
    })
    return res.ok
  } catch {
    return false
  }
}
