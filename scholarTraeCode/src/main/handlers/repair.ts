// s45 修复动作执行与回滚 IPC：
// - repair:run  用户确认卡片后执行修复命令；执行前打 git 检查点（留痕可回滚，非 git 仓库降级跳过）
// - repair:rollback  修复改坏时一键回到检查点
// 修复命令走持久终端（面板可见），失败仍会触发新一轮修复提案（修复循环）。
import { ipcMain } from 'electron'
import { runTerminalForAi } from './terminal'
import { createCheckpoint, restoreCheckpoint } from './git'

export interface RepairRunResult {
  ok: boolean
  exitCode: number | null
  /** 输出尾部（卡片展示） */
  tail: string
  /** 执行前检查点 hash；非 git 仓库为 null */
  checkpointHash: string | null
  error?: string
}

export function registerRepairHandlers(): void {
  ipcMain.handle(
    'repair:run',
    async (_e, workspace: string, command: string): Promise<RepairRunResult> => {
      if (!workspace || !command) return { ok: false, exitCode: null, tail: '', checkpointHash: null, error: '参数缺失' }
      // 留痕：修复动作前先打检查点（非 git 仓库降级为 null，不阻断修复）
      let checkpointHash: string | null = null
      try {
        const cp = await createCheckpoint(workspace, `修复前：${command.slice(0, 60)}`)
        if (cp.ok && cp.data?.created && cp.data.hash) checkpointHash = cp.data.hash
      } catch {
        checkpointHash = null
      }
      const r = await runTerminalForAi({ command, cwd: workspace, source: 'user' })
      const tail = r.output.length > 1200 ? r.output.slice(-1200) : r.output
      return { ok: r.ok, exitCode: r.exitCode, tail, checkpointHash }
    }
  )

  ipcMain.handle('repair:rollback', async (_e, workspace: string, hash: string) => {
    if (!workspace || !hash) return { ok: false, error: '参数缺失' }
    return restoreCheckpoint(workspace, hash)
  })
}
