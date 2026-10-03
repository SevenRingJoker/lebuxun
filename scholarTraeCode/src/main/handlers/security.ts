// 安全副作用层：工作区路径边界检查与审计日志。
// 与 ai/permissions.ts 的纯决策逻辑分离，便于单测与职责划分。
import { app } from 'electron'
import { appendFileSync, mkdirSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'

/**
 * 判断 target 是否位于 root 目录之内（含 root 自身）。
 * 使用 resolve 归一化 + 带分隔符前缀比较，防 ../ 逃逸、盘符穿越与符号同名前缀绕过。
 * target 为相对路径时按 root 解析。
 */
export function isInside(root: string, target: string): boolean {
  if (!root || !target) return false
  const base = resolve(root)
  const abs = isAbsolute(target) ? resolve(target) : resolve(base, target)
  return abs === base || abs.startsWith(base.endsWith(sep) ? base : base + sep)
}

/** 审计记录条目 */
export interface AuditEntry {
  /** ISO 时间戳 */
  ts?: string
  /** 工具名 */
  tool: string
  /** 操作目标（路径或命令，命令做长度截断） */
  target: string
  /** 当时权限模式 */
  mode: string
  /** allow / allow_always / deny */
  decision: string
  /** 决策/拒绝原因 */
  reason: string
}

/** 命令类目标在审计日志中的最大长度，避免日志被超长命令撑爆 */
const MAX_AUDIT_TARGET = 500

/**
 * 追加一条审计记录。
 * 有工作区写 <workspace>/.trae/audit.log；无工作区写 userData/logs/audit.log。
 * 任何 IO 失败都静默吞掉——安全审计不能阻断主流程。
 */
export function appendAudit(workspace: string | null | undefined, entry: AuditEntry): void {
  try {
    const dir = workspace ? join(workspace, '.trae') : join(app.getPath('userData'), 'logs')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'audit.log')
    const target =
      entry.target && entry.target.length > MAX_AUDIT_TARGET
        ? entry.target.slice(0, MAX_AUDIT_TARGET) + `…(截断,共${entry.target.length}字符)`
        : entry.target
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry, target }) + '\n'
    appendFileSync(file, line, 'utf-8')
  } catch {
    // 审计失败不影响工具执行
  }
}
