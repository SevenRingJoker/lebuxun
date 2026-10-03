// 计划-执行偏差检测纯函数层（零 IO / 零 Electron 依赖，可单测）。
//
// 验证锁（validation.ts）只管「模型想收尾时关键产物在不在」，照看不到：
//   ① TodoStore 中仍有未完成项（计划的显式步骤被遗弃）；
//   ② dedup 放弃 / break 等绕过验证锁的收尾路径，产物缺失却无明确清单；
//   ③ 模型跑偏创建计划外文件（范围蔓延）。
//
// 本模块在任务收尾统一比对「计划承诺 vs 实际产物」，如实产出偏差报告：
//   - unfinishedTodo  (warn)  todo 未完成
//   - missingArtifact (block) manifest 声明的 fileExists 产物缺失
//   - unexpectedFile  (warn)  创建了计划/清单覆盖不到的文件
//
// 与 validation.ts 的匹配规则保持同款（normPath + 后缀匹配），逻辑内联不跨模块依赖。

import type { TodoItem } from './todoManager'
import type { ArtifactManifest } from './validation'

export type DriftKind = 'unfinishedTodo' | 'missingArtifact' | 'unexpectedFile'
export type DriftSeverity = 'block' | 'warn'

export interface DriftItem {
  kind: DriftKind
  severity: DriftSeverity
  /** 人类可读描述（中文） */
  detail: string
}

export interface DriftReport {
  items: DriftItem[]
  /** 是否含 block 级偏差（关键产物缺失） */
  hasBlock: boolean
  /** 是否含 warn 级偏差 */
  hasWarn: boolean
  /**
   * 是否为工具循环中途的强制中断报告（区别于收尾后报告）：
   * 调度器在越序动作点（缺基础文件仍跑命令/反复修补残缺文件）检测到 hasBlock 时置 true，
   * 前端据此在对话流插入「已强制中断」系统指令并立即展开偏差卡片。
   */
  interrupted?: boolean
}

export interface DriftInput {
  todos: TodoItem[]
  createdFiles: Set<string>
  manifest?: ArtifactManifest | null
  plan?: string | null
}

/** 路径归一：反斜杠转正斜杠 + 小写（与 validation.normPath 同款） */
function normPath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}

/** 取路径末 N 段（用于计划文本子串匹配，避开盘符绝对路径差异） */
function tailSegments(p: string, n: number): string {
  const parts = normPath(p).split('/').filter(Boolean)
  return parts.slice(-n).join('/')
}

/**
 * createdFiles 中是否存在以 path 结尾的文件（与 validation.fileExistsInCreated 同款）：
 * 后缀为独立路径段或整体相等。
 */
function fileCreated(path: string, createdFiles: Set<string>): boolean {
  const target = normPath(path)
  for (const f of createdFiles) {
    const n = normPath(f)
    if (n === target || n.endsWith('/' + target)) return true
  }
  return false
}

/**
 * 判断已创建文件是否属于计划范围：
 *   1) 命中 manifest 任一 fileExists 路径后缀模式；
 *   2) 路径末 2/3 段在 plan 文本（归一小写）中作为子串出现。
 * 任一满足即计划内；无 manifest 时调用方不应进入此判定。
 */
function isPlannedFile(file: string, manifest: ArtifactManifest | null, planNorm: string): boolean {
  const paths = (manifest?.rules ?? [])
    .filter((r) => r.kind === 'fileExists' && typeof r.path === 'string')
    .map((r) => r.path as string)
  for (const p of paths) {
    const target = normPath(p)
    const n = normPath(file)
    if (n === target || n.endsWith('/' + target)) return true
  }
  if (planNorm) {
    // 末 2/3 段处理「目录/文件」连写；basename 兜底处理计划中
    // 「在 X 目录创建 Y」这类目录与文件名不连续的写法（warn 级判定宁漏勿滥）
    const tail1 = tailSegments(file, 1)
    const tail2 = tailSegments(file, 2)
    const tail3 = tailSegments(file, 3)
    if ((tail1 && planNorm.includes(tail1)) ||
        (tail2 && planNorm.includes(tail2)) ||
        (tail3 && planNorm.includes(tail3))) return true
  }
  return false
}

/**
 * 检测计划-执行偏差。
 * 边界：无 todos 且无 createdFiles → 空报告；输入缺省不抛异常。
 */
export function detectPlanDrift(input: DriftInput): DriftReport {
  const todos = input.todos ?? []
  const createdFiles = input.createdFiles ?? new Set<string>()
  const manifest = input.manifest ?? null
  const planNorm = (input.plan ?? '').replace(/\\/g, '/').toLowerCase()
  const items: DriftItem[] = []

  // ① 未完成 todo（pending / in_progress）
  for (const t of todos) {
    if (t.status !== 'completed') {
      const stateText = t.status === 'in_progress' ? '进行中未完成' : '未开始'
      items.push({
        kind: 'unfinishedTodo',
        severity: 'warn',
        detail: `#${t.id}（${stateText}）${t.content}`
      })
    }
  }

  // ② manifest 声明的 fileExists 产物缺失
  for (const rule of manifest?.rules ?? []) {
    if (rule.kind === 'fileExists' && typeof rule.path === 'string') {
      if (!fileCreated(rule.path, createdFiles)) {
        items.push({
          kind: 'missingArtifact',
          severity: 'block',
          detail: `${rule.path}（${rule.description || '计划声明的产物'}）`
        })
      }
    }
  }

  // ③ 计划外文件：仅 manifest 存在（项目创建场景，有明确范围）时评估
  if (manifest) {
    for (const f of createdFiles) {
      if (!isPlannedFile(f, manifest, planNorm)) {
        items.push({
          kind: 'unexpectedFile',
          severity: 'warn',
          detail: f
        })
      }
    }
  }

  return {
    items,
    hasBlock: items.some((i) => i.severity === 'block'),
    hasWarn: items.some((i) => i.severity === 'warn')
  }
}

/**
 * 把偏差报告格式化为追加到最终输出的文本段；无偏差返回空串。
 * 分块列出，让用户能逐条核对。
 */
export function formatDriftReport(report: DriftReport): string {
  if (report.items.length === 0) return ''
  const blocks: string[] = []

  const missing = report.items.filter((i) => i.kind === 'missingArtifact')
  if (missing.length > 0) {
    blocks.push(
      `【计划偏差 · 关键产物缺失 ${missing.length} 项】\n` +
      missing.map((i) => `- ${i.detail}`).join('\n')
    )
  }
  const unfinished = report.items.filter((i) => i.kind === 'unfinishedTodo')
  if (unfinished.length > 0) {
    blocks.push(
      `【计划偏差 · 未完成步骤 ${unfinished.length} 项】\n` +
      unfinished.map((i) => `- ${i.detail}`).join('\n')
    )
  }
  const unexpected = report.items.filter((i) => i.kind === 'unexpectedFile')
  if (unexpected.length > 0) {
    blocks.push(
      `【计划偏差 · 计划外文件 ${unexpected.length} 个】\n` +
      unexpected.map((i) => `- ${i.detail}`).join('\n')
    )
  }
  return `\n\n⚠️ 计划-执行偏差检测：\n${blocks.join('\n')}`
}
