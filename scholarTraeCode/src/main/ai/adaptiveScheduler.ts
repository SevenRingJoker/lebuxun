// 自适应调度器：根据任务角色 + 可用显存 + 已发现模型，动态选择最优模型。
// 核心原则：不硬编码任何模型名，完全依赖 ModelProfile 画像 + 显存约束做选择。

import {
  listOllamaModels,
  listLoadedModels,
  estimateVram,
  type ModelProfile
} from './modelDiscovery'

export type ModelRole = 'planner' | 'executor' | 'coder' | 'observer'

/** 角色需求画像（不指定具体模型，只描述能力要求）。
 * 阶段三统一：字段名与 modelDiscovery.ModelProfile 一一对应——
 *   minParams/maxParams ↔ ModelProfile.paramSize（参数量 B）
 *   preferCoder        ↔ ModelProfile.isCoder（是否代码专用）
 *   preferFamily       ↔ ModelProfile.family（家族标识：qwen/deepseek/llama/...）
 *   targetCtx/minCtx   ↔ 上下文窗口档位（RoleRequirement 特有，用于显存估算）
 * 确保两处共享同一套能力语义，避免双写漂移。 */
interface RoleRequirement {
  /** 最低参数量（B）：太小无法胜任 */
  minParams: number
  /** 最高参数量（B）：太大拖慢且占显存 */
  maxParams: number
  /** 是否优先代码专用模型 */
  preferCoder: boolean
  /** 家族偏好（按优先级排序） */
  preferFamily: string[]
  /** 该角色建议的上下文窗口 */
  targetCtx: number
  /** 上下文下限（低于此则降级） */
  minCtx: number
}

const ROLE_REQUIREMENTS: Record<ModelRole, RoleRequirement> = {
  planner: {
    minParams: 7,
    maxParams: 40,
    preferCoder: false,
    preferFamily: ['qwen', 'deepseek', 'llama'],
    targetCtx: 8192,
    minCtx: 4096
  },
  executor: {
    minParams: 3,
    maxParams: 20,
    preferCoder: false,
    preferFamily: ['qwen', 'llama', 'gemma', 'mistral'],
    targetCtx: 4096,
    minCtx: 2048
  },
  coder: {
    minParams: 6,
    maxParams: 30,
    preferCoder: true,
    preferFamily: ['deepseek', 'qwen', 'mistral'],
    targetCtx: 16384,
    minCtx: 4096
  },
  observer: {
    minParams: 7,
    maxParams: 40,
    preferCoder: false,
    preferFamily: ['qwen', 'deepseek', 'llama'],
    targetCtx: 8192,
    minCtx: 4096
  }
}

export interface ModelChoice {
  profile: ModelProfile
  numCtx: number
  /** 选择原因（供 UI 展示/日志） */
  reason: string
}

export interface SelectionDiagnostics {
  totalAvailable: number
  availableNames: string[]
  freeVramGB: number
  choice: ModelChoice | null
  /** 被拒绝的候选及原因（供 UI 排错） */
  rejectionLog: string[]
}

/**
 * 总显存（GB）：默认 16，可通过环境变量 TRAECODE_VRAM_GB 覆盖
 */
export function getTotalVram(): number {
  const envVal = parseFloat(process.env.TRAECODE_VRAM_GB || '')
  if (!isNaN(envVal) && envVal > 0) return envVal
  return 16
}

/**
 * 计算当前可用显存（GB）。
 * 探测失败按 total 总量、0 已用处理（绝不阻塞调度）。
 */
export async function getFreeVram(opts?: {
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}): Promise<number> {
  const total = getTotalVram()
  const loaded = await listLoadedModels({ signal: opts?.signal, fetchImpl: opts?.fetchImpl })
  const used = loaded.reduce((s, m) => s + m.sizeVramGB, 0)
  return Math.max(0, total - used)
}

/** 兼容旧 API：返回 {total, used, free} 结构 */
export async function getVramInfo(opts?: {
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}): Promise<{ total: number; used: number; free: number }> {
  const total = getTotalVram()
  const loaded = await listLoadedModels({ signal: opts?.signal, fetchImpl: opts?.fetchImpl })
  const used = loaded.reduce((s, m) => s + m.sizeVramGB, 0)
  const free = Math.max(0, total - used)
  return { total, used, free }
}

/**
 * 核心：为指定角色自适应选择模型（无诊断）。
 * 失败返回 null；详细原因用 selectModelForRoleWithDiagnostics。
 */
export async function selectModelForRole(
  role: ModelRole,
  availableVram: number,
  opts?: { signal?: AbortSignal; fetchImpl?: typeof fetch }
): Promise<ModelChoice | null> {
  const diag = await selectModelForRoleWithDiagnostics(role, availableVram, opts)
  return diag.choice
}

/**
 * 决策层唯一对外入口：根据任务角色 + 当前显存 → 给出最终 ModelChoice（含诊断）。
 * 内部完成：可用显存探测 → 候选过滤 → 显存档位递减。
 * 调用方拿到 SelectionDiagnostics 后自行决定后续动作（通常是交给 ModelRegistry.switchModel）。
 *
 * 注意：本方法只负责「选谁」，不负责「加载/切换」——那是治理层 ModelRegistry 的职责。
 * 阶段二之后，scheduler 不再关心候选列表回退，只需调用本方法 + safeSwitch。
 */
export async function resolveModelForTask(
  role: ModelRole,
  opts?: { signal?: AbortSignal; fetchImpl?: typeof fetch }
): Promise<SelectionDiagnostics> {
  const freeVram = await getFreeVram(opts)
  return selectModelForRoleWithDiagnostics(role, freeVram, opts)
}

/**
 * 带诊断信息的选择：UI 可展示为什么选了某模型 / 为什么没选。
 * 选择顺序：
 * 1. 参数量过滤（minParams ~ maxParams），无候选则放宽到全部
 * 2. preferCoder 时优先代码专用模型
 * 3. 家族偏好排序（同家族内按参数量升序，省显存）
 * 4. 显存约束：对每个候选，按 targetCtx → 0.75× → 0.5× → minCtx 递减尝试
 * 5. 兜底：选磁盘体积最小模型 + minCtx
 */
export async function selectModelForRoleWithDiagnostics(
  role: ModelRole,
  availableVram: number,
  opts?: { signal?: AbortSignal; fetchImpl?: typeof fetch }
): Promise<SelectionDiagnostics> {
  const req = ROLE_REQUIREMENTS[role]
  const allModels = await listOllamaModels({ signal: opts?.signal, fetchImpl: opts?.fetchImpl })

  const diagnostics: SelectionDiagnostics = {
    totalAvailable: allModels.length,
    availableNames: allModels.map((m) => m.name),
    freeVramGB: availableVram,
    choice: null,
    rejectionLog: []
  }

  if (allModels.length === 0) {
    diagnostics.rejectionLog.push('Ollama 中没有任何可用模型')
    return diagnostics
  }

  // 1. 参数量过滤
  let candidates = allModels.filter((m) => {
    if (m.paramSize < req.minParams) {
      diagnostics.rejectionLog.push(`${m.name}: 参数量 ${m.paramSize}B < 最低要求 ${req.minParams}B`)
      return false
    }
    if (m.paramSize > req.maxParams) {
      diagnostics.rejectionLog.push(`${m.name}: 参数量 ${m.paramSize}B > 最高要求 ${req.maxParams}B`)
      return false
    }
    if (m.fileSizeGB <= 0) {
      diagnostics.rejectionLog.push(`${m.name}: 磁盘体积未知`)
      return false
    }
    return true
  })

  // 2. 参数量过滤后无候选 → 放宽到全部模型
  if (candidates.length === 0) {
    diagnostics.rejectionLog.push(`参数量过滤后无候选，放宽至全部 ${allModels.length} 个模型`)
    candidates = allModels.filter((m) => m.fileSizeGB > 0)
  }

  // 3. 代码角色优先代码专用模型
  if (req.preferCoder) {
    const coders = candidates.filter((m) => m.isCoder)
    if (coders.length > 0) {
      candidates = coders
    } else {
      diagnostics.rejectionLog.push('未找到代码专用模型，使用通用模型')
    }
  }

  // 4. 家族偏好排序（同家族内按参数量降序，优先大模型）
  candidates.sort((a, b) => {
    const aIdx = req.preferFamily.indexOf(a.family)
    const bIdx = req.preferFamily.indexOf(b.family)
    const aScore = aIdx === -1 ? 99 : aIdx
    const bScore = bIdx === -1 ? 99 : bIdx
    if (aScore !== bScore) return aScore - bScore
    return b.paramSize - a.paramSize
  })

  // 5. 显存约束：从 targetCtx 递减尝试
  const ctxCandidates = [
    req.targetCtx,
    Math.floor(req.targetCtx * 0.75),
    Math.floor(req.targetCtx / 2),
    req.minCtx
  ]

  for (const profile of candidates) {
    for (const numCtx of ctxCandidates) {
      const vramNeeded = estimateVram(profile, numCtx)
      if (vramNeeded <= availableVram * 0.9) {
        diagnostics.choice = {
          profile,
          numCtx,
          reason: `${profile.name} (${profile.paramSize}B/${profile.quantization}) ctx=${numCtx} 显存需求≈${vramNeeded.toFixed(1)}GB`
        }
        return diagnostics
      }
    }
    diagnostics.rejectionLog.push(`${profile.name}: 所有 ctx 档位均超显存`)
  }

  // 6. 兜底：选磁盘体积最小的模型 + minCtx
  candidates.sort((a, b) => a.fileSizeGB - b.fileSizeGB)
  if (candidates[0]) {
    diagnostics.choice = {
      profile: candidates[0],
      numCtx: req.minCtx,
      reason: `显存严重不足，兜底选择最小模型 ${candidates[0].name} ctx=${req.minCtx}`
    }
    return diagnostics
  }

  diagnostics.rejectionLog.push('所有模型均无法满足显存约束')
  return diagnostics
}
