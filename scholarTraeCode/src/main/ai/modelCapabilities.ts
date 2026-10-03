// 模型能力预设与价格表：为云端/本地模型提供能力标注与成本估算。
// 用途：router.ts 打分排序 + 用量统计的成本折算。
// 预设表收录主流云端模型的真实参数；未收录模型按名字启发式推断（本地模型共用）。
import type { ModelCapabilities } from './types'

/** 单个模型的价格（美元 / 百万 token），in=输入 out=输出 */
export interface TokenPrice {
  in: number
  out: number
}

/** 预设能力条目：pattern 按小写模型名匹配，先命中先用 */
interface PresetEntry {
  pattern: RegExp
  caps: ModelCapabilities
}

/** 价格表条目 */
interface PriceEntry {
  pattern: RegExp
  price: TokenPrice
}

// ====================== 预设能力矩阵 ======================
const PRESET_CAPABILITIES: PresetEntry[] = [
  // ===== DeepSeek（无视觉） =====
  { pattern: /^deepseek-reasoner/, caps: { reasoning: true, code: true, speed: 'slow', contextWindow: 65536, vision: false, costTier: 2 } },
  { pattern: /^deepseek-chat/, caps: { reasoning: true, code: true, speed: 'balanced', contextWindow: 65536, vision: false, costTier: 1 } },
  // ===== OpenAI（4o/4.1 全系支持视觉，3.5 不支持） =====
  { pattern: /^gpt-4o-mini/, caps: { reasoning: true, code: true, speed: 'fast', contextWindow: 128000, vision: true, costTier: 1 } },
  { pattern: /^gpt-4o/, caps: { reasoning: true, code: true, speed: 'balanced', contextWindow: 128000, vision: true, costTier: 3 } },
  { pattern: /^gpt-4\.1/, caps: { reasoning: true, code: true, speed: 'balanced', contextWindow: 1000000, vision: true, costTier: 3 } },
  { pattern: /^gpt-3\.5/, caps: { reasoning: false, code: true, speed: 'fast', contextWindow: 16385, vision: false, costTier: 1 } },
  // ===== Anthropic Claude 3 全系支持视觉 =====
  { pattern: /opus/, caps: { reasoning: true, code: true, speed: 'slow', contextWindow: 200000, vision: true, costTier: 5 } },
  { pattern: /sonnet/, caps: { reasoning: true, code: true, speed: 'balanced', contextWindow: 200000, vision: true, costTier: 4 } },
  { pattern: /haiku/, caps: { reasoning: true, code: true, speed: 'fast', contextWindow: 200000, vision: true, costTier: 2 } },
  // ===== Google Gemini（全系视觉） =====
  { pattern: /gemini/, caps: { reasoning: true, code: true, speed: 'balanced', contextWindow: 1000000, vision: true, costTier: 2 } },
  // ===== 通义千问 VL 视觉系列（须排在 qwen-* 文本预设之前匹配） =====
  { pattern: /^qwen[\d.]*-vl/, caps: { reasoning: false, code: true, speed: 'balanced', contextWindow: 32768, vision: true, costTier: 2 } },
  // ===== 阿里云百炼（qwen 商用文本版，无视觉） =====
  { pattern: /^qwen-max/, caps: { reasoning: true, code: true, speed: 'balanced', contextWindow: 32768, vision: false, costTier: 3 } },
  { pattern: /^qwen-plus/, caps: { reasoning: true, code: true, speed: 'fast', contextWindow: 131072, vision: false, costTier: 2 } },
  { pattern: /^qwen-turbo/, caps: { reasoning: false, code: true, speed: 'fast', contextWindow: 131072, vision: false, costTier: 1 } }
]

// ====================== 价格表（$/1M tokens，仅供成本估算展示） ======================
const PRICE_TABLE: PriceEntry[] = [
  { pattern: /^deepseek-reasoner/, price: { in: 0.55, out: 2.19 } },
  { pattern: /^deepseek-chat/, price: { in: 0.27, out: 1.1 } },
  { pattern: /^gpt-4o-mini/, price: { in: 0.15, out: 0.6 } },
  { pattern: /^gpt-4o/, price: { in: 2.5, out: 10 } },
  { pattern: /^gpt-4\.1/, price: { in: 2, out: 8 } },
  { pattern: /^gpt-3\.5/, price: { in: 0.5, out: 1.5 } },
  { pattern: /opus/, price: { in: 15, out: 75 } },
  { pattern: /sonnet/, price: { in: 3, out: 15 } },
  { pattern: /haiku/, price: { in: 0.8, out: 4 } },
  { pattern: /^qwen-max/, price: { in: 1.6, out: 6.4 } },
  { pattern: /^qwen-plus/, price: { in: 0.4, out: 1.2 } },
  { pattern: /^qwen-turbo/, price: { in: 0.05, out: 0.2 } }
]

/** 查价格；未收录返回 null（成本按 0 展示） */
export function getPrice(modelName: string): TokenPrice | null {
  const lower = modelName.toLowerCase()
  for (const { pattern, price } of PRICE_TABLE) {
    if (pattern.test(lower)) return price
  }
  return null
}

/**
 * 按模型名启发式推断能力（原 ollamaProvider 内联逻辑迁移至此，本地模型共用）。
 * 规则：含 reason/think/r1/deepseek/qwen → 强推理；含 code/coder → 代码专精；
 *      小尺寸(<=8b) → 快速；大尺寸(>=30b) → 慢/大窗口；
 *      含 vl/llava/vision/moondream/pixtral/minicpm → 视觉。
 */
export function inferCapabilities(name: string): ModelCapabilities {
  const lower = name.toLowerCase()
  const sizeMatch = lower.match(/(\d+(?:\.\d+)?)\s*b/)
  const sizeB = sizeMatch ? parseFloat(sizeMatch[1]) : null

  const code = /code|coder|codellama|wizardcoder|starcoder/.test(lower)
  const reasoning =
    /reason|think|r1|deepseek|o3|o4|qwen/.test(lower) && !code
      ? true
      : sizeB != null && sizeB >= 30
  // 视觉模型启发：本地常见命名（llava / qwen-vl / llama3.2-vision / minicpm-v / moondream / pixtral）
  // vl 后允许的边界：分隔符 - _ :、数字、点或串尾（: 是 Ollama 标签分隔，如 qwen2-vl:7b）
  const vision =
    /llava|(?:^|[-_\w]*[-_])vl(?:[-_0-9.:]|$)|vision|visual|moondream|pixtral|minicpm/.test(lower)
  const speed: ModelCapabilities['speed'] =
    sizeB != null && sizeB <= 8 ? 'fast' : sizeB != null && sizeB >= 30 ? 'slow' : 'balanced'
  const contextWindow = sizeB != null && sizeB >= 30 ? 128_000 : 32_768
  const costTier = sizeB != null ? Math.min(5, Math.ceil(sizeB / 14)) : 2

  return { reasoning, code, speed, contextWindow, vision, costTier }
}

/** 解析模型能力：预设表优先（云端精确标注），未收录回退名字启发式 */
export function resolveCapabilities(modelName: string): ModelCapabilities {
  const lower = modelName.toLowerCase()
  for (const { pattern, caps } of PRESET_CAPABILITIES) {
    if (pattern.test(lower)) return { ...caps }
  }
  return inferCapabilities(modelName)
}
