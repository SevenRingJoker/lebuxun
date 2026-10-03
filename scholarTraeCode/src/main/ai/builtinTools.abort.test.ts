// s29 工具内部打断：bash 工具 abort 真杀进程树（Windows taskkill /T /F；POSIX 进程组 SIGKILL）
// 真实 spawn 长命令验证端到端行为，不 mock 子进程。
import { describe, it, expect } from 'vitest'
import { callBuiltinTool } from './builtinTools'

const isWin = process.platform === 'win32'
// 跨平台长命令：Windows ping 约 30s；POSIX sleep 30s
const LONG_CMD = isWin ? 'ping -n 30 127.0.0.1' : 'sleep 30'

describe('s29 bash 工具内部打断', () => {
  it('在途长命令被 abort 后迅速以「已被用户中止」收尾（进程树被杀）', async () => {
    const ctrl = new AbortController()
    const start = Date.now()
    const p = callBuiltinTool('bash', { command: LONG_CMD, timeoutMs: 60000 }, process.cwd(), ctrl.signal)
    setTimeout(() => ctrl.abort(), 300)
    const r = await p
    const elapsed = Date.now() - start
    expect(r).toContain('已被用户中止')
    // 真杀进程：应远早于命令自然结束（30s）
    expect(elapsed).toBeLessThan(5000)
  }, 20000)

  it('signal 已中止时不发起执行', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const r = await callBuiltinTool(
      'bash',
      { command: 'echo should-not-run', timeoutMs: 5000 },
      process.cwd(),
      ctrl.signal
    )
    expect(r).toContain('已被用户中止')
    expect(r).not.toContain('should-not-run')
  })

  it('无 signal 时正常执行完成', async () => {
    const r = await callBuiltinTool('bash', { command: 'echo s29-ok', timeoutMs: 10000 }, process.cwd())
    expect(r).toContain('s29-ok')
  }, 15000)
})
