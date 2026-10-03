// s44 变更集分类审阅纯函数层：
// StagingPanel 在文件清单上叠加三档分类标记——
//   direct（需求直接相关）：计划文本中点名该文件；
//   incidental（顺带改动）：计划没提、也非高风险的改动；
//   risky（高风险触碰）：命中 spec 锚点、删除文件、或被引用面很广（≥10 处）的核心文件。
// 分类依据 = s43 锚点 + s42 索引引用统计 + 计划文本后缀段匹配。
// 零 IO / 零 Electron 依赖，所有输入由 handlers/staging 组装后传入，可确定性单测。
import { matchProtectedPath, type AnchorsFile } from './anchors'

/** 三档分类 */
export type ChangeClass = 'direct' | 'incidental' | 'risky'

/** 单文件分类结果 */
export interface ChangeVerdict {
  cls: ChangeClass
  /** 中文原因（UI title 提示） */
  reason: string
}

/** 被引用面阈值：达到即视为核心文件（高风险） */
export const REF_RISK_THRESHOLD = 10

/** 路径归一：反斜杠转正斜杠、去开头 ./、小写（与 anchors/planDrift 同款口径） */
function normPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\/+/, '').toLowerCase()
}

/** 取路径末 N 段（计划文本子串匹配用，避开盘符差异） */
function tailSegments(p: string, n: number): string {
  const parts = normPath(p).split('/').filter(Boolean)
  return parts.slice(-n).join('/')
}

/**
 * 计划文本是否点名该文件：末 1/2/3 段任一作为子串出现在归一化计划文本中。
 * basename 兜底处理「在 X 目录创建 Y」这类目录与文件名不连续的写法。
 */
export function planMentions(planText: string, relPath: string): boolean {
  const planNorm = normPath(planText)
  if (!planNorm) return false
  const t1 = tailSegments(relPath, 1)
  const t2 = tailSegments(relPath, 2)
  const t3 = tailSegments(relPath, 3)
  return (!!t1 && planNorm.includes(t1)) ||
    (!!t2 && planNorm.includes(t2)) ||
    (!!t3 && planNorm.includes(t3))
}

/**
 * 批量分类暂存变更。
 * @param items    暂存清单（path 相对工作区、kind 变更类型）
 * @param anchors  spec 锚点（禁改路径）
 * @param refCounts 路径 → 被引用处数（由索引 imports 统计，缺省视为 0）
 * @param planText 计划/需求文本（可为空串）
 */
export function classifyChanges(
  items: Array<{ path: string; kind: 'create' | 'modify' | 'delete' | 'move' }>,
  anchors: AnchorsFile,
  refCounts: Record<string, number>,
  planText: string
): Record<string, ChangeVerdict> {
  const out: Record<string, ChangeVerdict> = {}
  for (const item of items) {
    const rel = normPath(item.path)
    // —— risky 优先（宁滥勿缺，审阅场景误标高风险代价低于漏标）——
    const anchorHit = matchProtectedPath(anchors, item.path)
    if (anchorHit) {
      out[item.path] = { cls: 'risky', reason: `命中 spec 锚点禁改路径：${anchorHit}` }
      continue
    }
    if (item.kind === 'delete') {
      out[item.path] = { cls: 'risky', reason: '删除文件操作，需人工确认' }
      continue
    }
    const refCount = refCounts[rel] ?? refCounts[item.path] ?? 0
    if (refCount >= REF_RISK_THRESHOLD) {
      out[item.path] = { cls: 'risky', reason: `核心文件：工作区内被引用 ${refCount} 处` }
      continue
    }
    // —— direct：计划点名 ——
    if (planMentions(planText, item.path)) {
      out[item.path] = { cls: 'direct', reason: '计划文本中点名该文件，属需求直接相关改动' }
      continue
    }
    // —— 其余顺带 ——
    out[item.path] = { cls: 'incidental', reason: '计划未点名该文件，属顺带改动，请确认是否必要' }
  }
  return out
}
