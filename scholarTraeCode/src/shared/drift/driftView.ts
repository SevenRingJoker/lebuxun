// 偏差报告前端视图纯函数层（零 DOM / 零 Electron 依赖，可单测）。
//
// ㉚ 在主进程产出 DriftReport 并把文本块追加到最终输出；本模块负责：
//   - 按三类分组 / 计数，供 DriftReportCard 分区渲染；
//   - stripDriftSection：实时态渲染 assistant Markdown 前剥离末尾偏差文本块，
//     让「卡片」与「文本」不重复展示（历史会话无事件数据时仍保留文本）。

export type UiDriftKind = 'unfinishedTodo' | 'missingArtifact' | 'unexpectedFile'
export type UiDriftSeverity = 'block' | 'warn'

export interface UiDriftItem {
  kind: UiDriftKind
  severity: UiDriftSeverity
  detail: string
}

export interface UiDriftReport {
  items: UiDriftItem[]
  hasBlock: boolean
  hasWarn: boolean
  /** 工具循环中途强制中断（前端据此插入系统中断指令，而非仅在收尾展示） */
  interrupted?: boolean
}

/** 分组结果：关键产物缺失 / 未完成步骤 / 计划外文件 */
export interface DriftGroups {
  missing: UiDriftItem[]
  unfinished: UiDriftItem[]
  unexpected: UiDriftItem[]
}

/** 偏差文本块起始标记（与 main/ai/planDrift.ts formatDriftReport 输出一致） */
const DRIFT_MARKER = '\n\n⚠️ 计划-执行偏差检测：'

/** 按三类分组；未知 kind 忽略（防御未来新增类型） */
export function groupDriftItems(report: UiDriftReport): DriftGroups {
  const groups: DriftGroups = { missing: [], unfinished: [], unexpected: [] }
  for (const item of report.items ?? []) {
    if (item.kind === 'missingArtifact') groups.missing.push(item)
    else if (item.kind === 'unfinishedTodo') groups.unfinished.push(item)
    else if (item.kind === 'unexpectedFile') groups.unexpected.push(item)
  }
  return groups
}

/** 计数：阻断 = 关键产物缺失项；警告 = 其余项 */
export function driftCounts(report: UiDriftReport): { block: number; warn: number } {
  let block = 0
  let warn = 0
  for (const item of report.items ?? []) {
    if (item.kind === 'missingArtifact' || item.severity === 'block') block++
    else warn++
  }
  return { block, warn }
}

/**
 * 剥离 assistant 末尾的偏差文本块（从起始标记到字符串结尾）。
 * - 命中：返回标记之前的正文（trim 尾部多余换行）；
 * - 无标记：原样返回（无偏差 / 历史会话 / 其他 ⚠️ 警告均安全）。
 *
 * 其他警告（如 npm 未验证）出现在偏差块之前，且不含本标记，不会被误伤。
 */
export function stripDriftSection(markdown: string): string {
  const idx = markdown.indexOf(DRIFT_MARKER)
  if (idx === -1) return markdown
  return markdown.slice(0, idx).replace(/\s+$/, '')
}

/**
 * 从偏差明细中提取文件路径（㊜ 偏差行点击定位用）：
 * - missingArtifact 的明细形如 `path（说明）` → 取首个中文括号之前的部分；
 * - unexpectedFile 为裸路径 → 去空白即可；
 * - unfinishedTodo（`#id（…）正文`）不可定位 → null。
 *
 * 结果含换行或为空时返回 null，避免把多行文本误当路径。
 */
export function extractDriftFilePath(item: UiDriftItem): string | null {
  if (!item || typeof item.detail !== 'string') return null
  if (item.kind !== 'missingArtifact' && item.kind !== 'unexpectedFile') return null
  // 截掉中文括号注释段（说明文字均为全角括号包裹）
  const path = item.detail.replace(/（[^）]*）\s*$/, '').trim()
  if (!path || path.includes('\n') || path.includes('\r')) return null
  return path
}
