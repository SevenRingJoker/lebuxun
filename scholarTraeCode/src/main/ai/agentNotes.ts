// 持久化笔记系统：跨会话的项目知识记忆。
// 存储路径：<workspace>/.trae/agent-notes.json
// 调度器在任务启动时加载笔记注入分层 Prompt（附注层），
// 任务完成后（验证通过/停滞退出）更新笔记，实现持续学习。
import { promises as fs } from 'node:fs'
import { join, dirname } from 'node:path'

/** 单条常见错误记录（带解法，供后续任务参考） */
export interface CommonError {
  error: string
  fix: string
  /** 出现次数，用于按频率排序 */
  count: number
  /** 最近一次出现时间 */
  lastSeen?: string
}

/** Agent 跨会话笔记 */
export interface AgentNote {
  /** 项目结构摘要（顶层目录 + 关键文件） */
  projectStructure?: string
  /** 常见错误及解法列表 */
  commonErrors?: CommonError[]
  /** 用户偏好修正（如"不要用某 API""喜欢某风格"） */
  userPreferences?: string
  /** 上次任务摘要 */
  lastTask?: string
  /** 上次任务结果（成功/失败/停滞） */
  lastTaskResult?: string
  /** 最近更新时间 ISO 字符串 */
  updatedAt?: string
}

/** 空笔记（首次或读取失败时返回） */
function emptyNote(): AgentNote {
  return {}
}

/** 笔记文件绝对路径 */
function notesPath(workspace: string): string {
  return join(workspace, '.trae', 'agent-notes.json')
}

/** 读取工作区笔记；不存在或损坏返回空对象 */
export async function loadNotes(workspace: string | null | undefined): Promise<AgentNote> {
  if (!workspace) return emptyNote()
  try {
    const raw = await fs.readFile(notesPath(workspace), 'utf-8')
    const parsed = JSON.parse(raw) as AgentNote
    return { ...emptyNote(), ...parsed }
  } catch {
    return emptyNote()
  }
}

/** 全量保存笔记（覆盖） */
export async function saveNotes(workspace: string, note: AgentNote): Promise<void> {
  try {
    const path = notesPath(workspace)
    await fs.mkdir(dirname(path), { recursive: true })
    const payload: AgentNote = { ...note, updatedAt: new Date().toISOString() }
    await fs.writeFile(path, JSON.stringify(payload, null, 2), 'utf-8')
  } catch {
    // 保存失败不阻塞主流程
  }
}

/**
 * 追加一条常见错误记录。
 * 同一错误（按 error 字段去重）已存在则 count+1 并更新 fix 和 lastSeen，
 * 否则新增。保留前 20 条（按 count 降序）。
 */
export async function appendError(
  workspace: string,
  error: string,
  fix: string
): Promise<void> {
  if (!workspace || !error) return
  const note = await loadNotes(workspace)
  const list = note.commonErrors ?? []
  const existing = list.find((e) => e.error === error)
  if (existing) {
    existing.count += 1
    existing.fix = fix || existing.fix
    existing.lastSeen = new Date().toISOString()
  } else {
    list.push({ error, fix, count: 1, lastSeen: new Date().toISOString() })
  }
  // 按出现次数降序，保留前 20 条
  list.sort((a, b) => b.count - a.count)
  note.commonErrors = list.slice(0, 20)
  await saveNotes(workspace, note)
}

/**
 * 任务结束后更新笔记：记录上次任务摘要、结果，并可选更新项目结构。
 */
export async function updateAfterTask(
  workspace: string,
  summary: string,
  result: string,
  projectStructure?: string
): Promise<void> {
  if (!workspace) return
  const note = await loadNotes(workspace)
  note.lastTask = summary.slice(0, 500)
  note.lastTaskResult = result
  if (projectStructure) note.projectStructure = projectStructure
  await saveNotes(workspace, note)
}

/** 把笔记渲染为可注入分层 Prompt 的文本（无内容返回空串） */
export function renderNotesForPrompt(note: AgentNote): string {
  const parts: string[] = []
  if (note.projectStructure) parts.push(`项目结构：${note.projectStructure}`)
  if (note.commonErrors && note.commonErrors.length > 0) {
    const errs = note.commonErrors.slice(0, 5).map((e) => `- ${e.error} → ${e.fix}`).join('\n')
    parts.push(`常见错误及解法（参考）：\n${errs}`)
  }
  if (note.userPreferences) parts.push(`用户偏好修正：${note.userPreferences}`)
  if (note.lastTask) parts.push(`上次任务：${note.lastTask}（${note.lastTaskResult ?? '未知'}）`)
  return parts.join('\n\n')
}
