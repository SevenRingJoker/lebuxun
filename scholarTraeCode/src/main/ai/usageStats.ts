// 用量统计：按模型/按日聚合 token 与成本，持久化 userData/ai-usage.json。
// 数据来源：provider 经 onUsage/chat 返回值上报真实 token；无 usage 时按字符数÷4 保守估算。
// 成本按 modelCapabilities 价格表折算（$/1M tokens）；未收录价格的模型成本记 0。
// 可测试性：核心逻辑在 createUsageStore(filePath) 工厂中，测试传 null 走纯内存；
// 生产侧 recordUsage/getUsageStats/resetUsageStats 是惰性单例，首次调用才解析 userData 路径。
import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPrice } from './modelCapabilities'

/** 单次记账输入：真实 token 或估算标记 */
export interface UsageInput {
  tokensIn?: number
  tokensOut?: number
  /** 无真实 usage 时的估算标记（字符数÷4 得出），UI 可据此提示精度 */
  estimated?: boolean
}

/** 单模型聚合 */
export interface ModelUsage {
  calls: number
  tokensIn: number
  tokensOut: number
  /** 估算成本（美元） */
  cost: number
  /** 其中按字符估算的调用次数 */
  estimatedCalls: number
}

/** 单日聚合 */
export interface DayUsage {
  calls: number
  tokensIn: number
  tokensOut: number
  cost: number
}

export interface UsageStats {
  byModel: Record<string, ModelUsage>
  /** key 为本地日期 YYYY-MM-DD */
  byDay: Record<string, DayUsage>
  totalCalls: number
  totalCost: number
}

/** 本地日期键（用户时区，不用 UTC，保证"今日"与用户感知一致） */
function dayKey(d = new Date()): string {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** 从 `provider:model` 形态中剥离模型名（价格表按裸模型名匹配） */
function bareModelName(modelId: string): string {
  const idx = modelId.indexOf(':')
  return idx >= 0 ? modelId.slice(idx + 1) : modelId
}

/** 字符数 → token 保守估算（中英混合约 4 字符/token） */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * 创建用量存储。filePath 为 null 时纯内存（测试用）。
 * 记账即持久化（写文件失败静默，不影响聊天主流程）。
 */
export function createUsageStore(filePath: string | null) {
  let byModel: Record<string, ModelUsage> = {}
  let byDay: Record<string, DayUsage> = {}

  function load(): void {
    if (!filePath) return
    try {
      if (existsSync(filePath)) {
        const raw = JSON.parse(readFileSync(filePath, 'utf-8'))
        if (raw && typeof raw === 'object') {
          if (raw.byModel && typeof raw.byModel === 'object') byModel = raw.byModel
          if (raw.byDay && typeof raw.byDay === 'object') byDay = raw.byDay
        }
      }
    } catch {
      // 文件损坏按空统计重新开始
    }
  }

  function save(): void {
    if (!filePath) return
    try {
      writeFileSync(filePath, JSON.stringify({ byModel, byDay }, null, 2), 'utf-8')
    } catch {
      // 持久化失败不阻断主流程
    }
  }

  load()

  return {
    /** 记一次调用：按价格表折算成本，聚合进模型/日两个维度 */
    record(modelId: string, input: UsageInput): void {
      const tokensIn = input.tokensIn ?? 0
      const tokensOut = input.tokensOut ?? 0
      const price = getPrice(bareModelName(modelId))
      const cost = price ? (tokensIn * price.in + tokensOut * price.out) / 1_000_000 : 0

      const mu = (byModel[modelId] ??= {
        calls: 0,
        tokensIn: 0,
        tokensOut: 0,
        cost: 0,
        estimatedCalls: 0
      })
      mu.calls++
      mu.tokensIn += tokensIn
      mu.tokensOut += tokensOut
      mu.cost += cost
      if (input.estimated) mu.estimatedCalls++

      const dk = dayKey()
      const du = (byDay[dk] ??= { calls: 0, tokensIn: 0, tokensOut: 0, cost: 0 })
      du.calls++
      du.tokensIn += tokensIn
      du.tokensOut += tokensOut
      du.cost += cost

      save()
    },

    /** 汇总视图：含总计 */
    getStats(): UsageStats {
      let totalCalls = 0
      let totalCost = 0
      for (const m of Object.values(byModel)) {
        totalCalls += m.calls
        totalCost += m.cost
      }
      return { byModel, byDay, totalCalls, totalCost }
    },

    /** 清零（含持久化） */
    reset(): void {
      byModel = {}
      byDay = {}
      save()
    }
  }
}

// ====================== 生产单例（惰性解析 userData，避免 import 期触碰 app） ======================
let singleton: ReturnType<typeof createUsageStore> | null = null

function store(): ReturnType<typeof createUsageStore> {
  if (!singleton) {
    singleton = createUsageStore(join(app.getPath('userData'), 'ai-usage.json'))
  }
  return singleton
}

/** 记一次模型调用（供 scheduler 各调用点使用） */
export function recordUsage(modelId: string, input: UsageInput): void {
  store().record(modelId, input)
}

/** 读取汇总统计（IPC 透传渲染进程） */
export function getUsageStats(): UsageStats {
  return store().getStats()
}

/** 清零统计 */
export function resetUsageStats(): void {
  store().reset()
}

/**
 * 统一记账助手（scheduler/subagents 各 chat 调用点复用）：
 * provider 带回真实 usage 时用真实值；否则按字符数÷4 估算并打 estimated 标记。
 * 记账异常静默，绝不影响聊天主流程。
 */
export function trackChatUsage(
  modelId: string,
  usage: { tokensIn?: number; tokensOut?: number } | undefined,
  inputText: string,
  outputText: string
): void {
  try {
    if (usage && (usage.tokensIn !== undefined || usage.tokensOut !== undefined)) {
      recordUsage(modelId, usage)
    } else {
      recordUsage(modelId, {
        tokensIn: estimateTokens(inputText),
        tokensOut: estimateTokens(outputText),
        estimated: true
      })
    }
  } catch {
    // 记账失败不影响主流程
  }
}
