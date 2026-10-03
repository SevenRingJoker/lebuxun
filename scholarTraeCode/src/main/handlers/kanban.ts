// s49 卡片式任务看板持久化（主进程侧）：
// 看板状态以 JSON 落盘 <workspace>/.trae/kanban.json，原子写防半截；
// 状态机运算在双端共享的 shared/kanban，这里仅做读写注册。
import { app, ipcMain } from 'electron'
import { promises as fs } from 'fs'
import path from 'path'
import type { KanbanState } from '../../shared/kanban/kanban'
import { getLogger } from '../ai/logger'

const log = getLogger('kanban')

const KANBAN_VERSION = 1

interface KanbanFile {
  schemaVersion: number
  workspace: string
  updatedAt: number
  cards: KanbanState
}

function boardPath(workspace: string): string {
  return path.join(workspace, '.trae', 'kanban.json')
}

/** 原子写：.tmp + rename */
async function writeBoard(workspace: string, cards: KanbanState): Promise<void> {
  const file: KanbanFile = { schemaVersion: KANBAN_VERSION, workspace, updatedAt: Date.now(), cards }
  const target = boardPath(workspace)
  const tmp = target + '.tmp'
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(tmp, JSON.stringify(file, null, 2), 'utf-8')
  await fs.rename(tmp, target)
}

export async function readBoard(workspace: string): Promise<KanbanState> {
  try {
    const raw = await fs.readFile(boardPath(workspace), 'utf-8')
    const file = JSON.parse(raw) as Partial<KanbanFile>
    if (file.schemaVersion !== KANBAN_VERSION || file.workspace !== workspace) {
      log.warn(`看板文件版本/工作区不匹配，忽略：${workspace}`)
      return []
    }
    return Array.isArray(file.cards) ? (file.cards as KanbanState) : []
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    log.warn(`看板读取失败：${String(e)}`)
    return []
  }
}

/** 注册看板 IPC（主进程启动时调用一次） */
export function registerKanbanHandlers(): void {
  ipcMain.handle('kanban:get', async (_e, workspace: string) => {
    if (!workspace) return []
    return await readBoard(workspace)
  })

  ipcMain.handle('kanban:save', async (_e, workspace: string, cards: KanbanState) => {
    if (!workspace || !Array.isArray(cards)) return { ok: false, error: '参数无效' }
    try {
      await writeBoard(workspace, cards)
      return { ok: true }
    } catch (e) {
      log.error(`看板保存失败：${e instanceof Error ? e.message : String(e)}`)
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('kanban:reset', async (_e, workspace: string) => {
    try {
      await fs.unlink(boardPath(workspace))
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
    return { ok: true }
  })

  log.debug(`看板 IPC 已注册（app ${app.getVersion()}）`)
}
