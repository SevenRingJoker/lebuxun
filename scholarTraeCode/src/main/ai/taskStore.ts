// 任务快照薄 IO 壳：负责 .trae/tasks/ 下快照文件的原子写、读取、列举与删除。
// 序列化/解析规则全部在 taskSnapshot 纯函数层，本文件不做任何业务判定。
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import {
  parseTaskSnapshot,
  type TaskSnapshotFile,
  type ParsedTaskSnapshot
} from './taskSnapshot'

/** 任务快照目录：<workspace>/.trae/tasks（目录不存在时按需创建） */
export function tasksDir(workspace: string): string {
  return join(workspace, '.trae', 'tasks')
}

/**
 * 原子写快照：先写 .tmp 再 rename，避免崩溃/强杀留下半截 JSON。
 * 文件名直接用 taskId（taskId 仅含 base36 安全字符）。
 */
export function saveTaskSnapshot(workspace: string, file: TaskSnapshotFile): void {
  const dir = tasksDir(workspace)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const target = join(dir, `${file.taskId}.json`)
  const tmp = target + '.tmp'
  writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf-8')
  renameSync(tmp, target)
}

/** 读取并解析单个快照；文件不存在或内容损坏返回 null */
export function loadTaskSnapshot(workspace: string, taskId: string): ParsedTaskSnapshot | null {
  const target = join(tasksDir(workspace), `${taskId}.json`)
  if (!existsSync(target)) return null
  try {
    return parseTaskSnapshot(readFileSync(target, 'utf-8'))
  } catch {
    return null
  }
}

/**
 * 列举工作区全部快照（按文件 updatedAt 倒序）。
 * 损坏/无法解析的文件静默跳过——恢复列表绝不能被一个坏文件卡死。
 */
export function listTaskSnapshots(workspace: string): ParsedTaskSnapshot[] {
  const dir = tasksDir(workspace)
  if (!existsSync(dir)) return []
  const items: ParsedTaskSnapshot[] = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    try {
      const parsed = parseTaskSnapshot(readFileSync(join(dir, f), 'utf-8'))
      if (parsed) items.push(parsed)
    } catch {
      // 单个坏文件不影响整体列举
    }
  }
  return items.sort((a, b) => b.updatedAt - a.updatedAt)
}

/** 删除快照文件；文件不存在视为已删除（幂等） */
export function deleteTaskSnapshot(workspace: string, taskId: string): void {
  const target = join(tasksDir(workspace), `${taskId}.json`)
  if (existsSync(target)) unlinkSync(target)
}

/**
 * 清理回退过程中残留的中断快照：
 * scheduleChatWithTools 在前一个候选模型崩溃后会尝试下一个候选；
 * 当后续候选最终成功时，本次包装器启动（since）之后产生、
 * 且状态为 interrupted 的快照全部删除——恢复条不能展示「实际已完成」的脏任务。
 * @returns 删除的文件数
 */
export function pruneInterruptedSince(workspace: string, since: number): number {
  const dir = tasksDir(workspace)
  if (!existsSync(dir)) return 0
  let removed = 0
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    const target = join(dir, f)
    try {
      const parsed = parseTaskSnapshot(readFileSync(target, 'utf-8'))
      if (!parsed) continue
      if (
        parsed.status === 'interrupted' &&
        parsed.startedAt >= since &&
        parsed.updatedAt >= since
      ) {
        unlinkSync(target)
        removed++
      }
    } catch {
      // 清理失败不阻塞主流程
    }
  }
  return removed
}
