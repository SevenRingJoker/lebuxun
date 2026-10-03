// 调试 IPC 处理器：桥接 debugSession（Node CDP）与 genericDapSession（Python/Go DAP）到渲染进程
import { ipcMain } from 'electron'
import {
  startDebugSession,
  stopDebugSession,
  setDebugBreakpoints,
  debugControl,
  getDebugSnapshot
} from '../debug/debugSession'
import {
  startDapSession,
  stopDapSession,
  setDapBreakpoints,
  dapControl,
  dapEvaluate,
  getDapSnapshot,
  type DapConfig
} from '../debug/genericDapSession'

export function registerDebugHandlers(): void {
  // Node CDP（原有）
  ipcMain.handle('debug:start', (_e, cfg: { kind: 'launch'; entry: string; port?: number } | { kind: 'attach'; port: number; host?: string }) =>
    startDebugSession(cfg)
  )
  ipcMain.handle('debug:stop', () => stopDebugSession())
  ipcMain.handle('debug:setBreakpoints', (_e, payload: { file: string; lines: number[] }) =>
    setDebugBreakpoints(payload?.file ?? '', payload?.lines ?? [])
  )
  ipcMain.handle('debug:control', (_e, payload: { action: 'continue' | 'next' | 'stepIn' | 'stepOut' | 'pause' }) =>
    debugControl(payload?.action)
  )
  ipcMain.handle('debug:state', () => getDebugSnapshot())

  // 3.3 通用 DAP（Python debugpy / Go dlv）
  ipcMain.handle('dap:start', (_e, cfg: DapConfig) => startDapSession(cfg))
  ipcMain.handle('dap:stop', () => stopDapSession())
  ipcMain.handle('dap:setBreakpoints', (_e, payload: { file: string; lines: number[] }) =>
    setDapBreakpoints(payload?.file ?? '', payload?.lines ?? [])
  )
  ipcMain.handle('dap:control', (_e, payload: { action: 'continue' | 'next' | 'stepIn' | 'stepOut' | 'pause' }) =>
    dapControl(payload?.action)
  )
  ipcMain.handle('dap:state', () => getDapSnapshot())
  ipcMain.handle('dap:evaluate', (_e, expression: string) => dapEvaluate(expression))
}
