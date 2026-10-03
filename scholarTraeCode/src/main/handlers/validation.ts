// 验证锁 IPC 处理器：把 validation.ts 纯函数层暴露给渲染进程，
// 并通过 scheduler 导出的 getter/setter 读写「当前会话」的 manifest 与 ctx 快照。
//
// 设计参考：handlers/debug.ts（薄封装 + 注册函数先例）。
// 接线点：src/main/index.ts 第 174 行附近 registerValidationHandlers()。
//
// 跨 IPC 序列化约束：
// - RegExp / 函数无法跨 IPC 序列化，前端编辑的 manifest 一律用 string command/pattern
//   （runRule 对 string 走子串匹配，行为正确）。
// - vueScaffoldManifest 内置 RegExp 仅在主进程内使用，不受前端影响。
// - getCurrent 返回的 ctx 快照已序列化为可 JSON 化形式（createdFiles→数组、executedCommands→对象）。

import { ipcMain } from 'electron'
import {
  runRule,
  runValidation,
  parseManifest,
  formatValidationMessage,
  type ArtifactManifest,
  type ValidationContext,
  type ValidationRule,
  type ValidationResult,
  type ValidationSummary
} from '../ai/validation'
import { getValidationState, setValidationManifest } from '../ai/scheduler'

/** 前端可序列化的 ctx 快照形式（Set/Map 无法直接跨 IPC，需转为数组/对象） */
export type ValidationCtxSnap = {
  createdFiles?: string[]
  executedCommands?: Record<string, string>
  workspace?: string
} | null

/** 从 IPC 传来的 ctx 快照组装为 ValidationContext（纯函数层需要 Set/Map） */
function toCtx(snap: ValidationCtxSnap): ValidationContext {
  return {
    createdFiles: new Set(snap?.createdFiles ?? []),
    executedCommands: new Map(Object.entries(snap?.executedCommands ?? {})),
    workspace: snap?.workspace
  }
}

/** 把 ValidationContext 序列化为可跨 IPC 的快照形式（供前端展示） */
function snapOfCtx(ctx: ValidationContext | null): ValidationCtxSnap {
  if (!ctx) return null
  return {
    createdFiles: Array.from(ctx.createdFiles),
    executedCommands: Object.fromEntries(ctx.executedCommands),
    workspace: ctx.workspace
  }
}

/** getCurrent 返回结构：当前会话的 manifest + ctx 快照 */
export interface ValidationCurrentState {
  manifest: ArtifactManifest | null
  ctx: ValidationCtxSnap
}

/**
 * 注册验证锁 6 个 IPC 通道：
 * - runRule：单条规则 + ctx 快照 → 结果
 * - runValidation：整 manifest + ctx 快照 → 聚合 summary
 * - parseManifest：解析文本/对象为 manifest（失败返回 null）
 * - formatMessage：把 summary 格式化为给模型的强制继续消息
 * - getCurrent：取当前会话的 manifest + ctx 快照（从 scheduler 单例）
 * - setCurrent：前端编辑后写回 manifest 单例，影响下一次收尾校验
 */
export function registerValidationHandlers(): void {
  // 1) 单条规则执行
  ipcMain.handle(
    'validation:runRule',
    (_e, rule: ValidationRule, ctxSnap?: ValidationCtxSnap): ValidationResult =>
      runRule(rule, toCtx(ctxSnap ?? null))
  )

  // 2) 整 manifest 执行
  ipcMain.handle(
    'validation:runValidation',
    (_e, manifest: ArtifactManifest | null, ctxSnap?: ValidationCtxSnap): ValidationSummary =>
      runValidation(manifest, toCtx(ctxSnap ?? null))
  )

  // 3) 解析 manifest（接受对象或 JSON 字符串；不合法返回 null）
  ipcMain.handle('validation:parseManifest', (_e, raw: unknown): ArtifactManifest | null => {
    if (raw == null) return null
    // 字符串：先尝试 JSON.parse，再交给 parseManifest 校验结构
    if (typeof raw === 'string') {
      try {
        return parseManifest(JSON.parse(raw))
      } catch {
        return null
      }
    }
    return parseManifest(raw)
  })

  // 4) 格式化 summary 为给模型的强制继续消息（allPassed 时返回 null）
  ipcMain.handle(
    'validation:formatMessage',
    (_e, summary: ValidationSummary, ctxSnap?: ValidationCtxSnap): string | null =>
      formatValidationMessage(summary, toCtx(ctxSnap ?? null))
  )

  // 5) 取当前会话 manifest + ctx 快照（任务未运行时 ctx 为 null）
  ipcMain.handle('validation:getCurrent', (): ValidationCurrentState => {
    const st = getValidationState()
    return { manifest: st.manifest, ctx: snapOfCtx(st.ctx) }
  })

  // 6) 前端编辑后写回 manifest 单例（影响下一次收尾校验）
  ipcMain.handle(
    'validation:setCurrent',
    (_e, manifest: ArtifactManifest | null): { ok: boolean } => {
      setValidationManifest(manifest)
      return { ok: true }
    }
  )
}
