// 真机冒烟：genericDapSession 与真实 debugpy.adapter 的端到端 DAP 会话。
// 环境要求：本机可解析 python 且已安装 debugpy（pip install debugpy）；
// 缺失时整组 skip（与计划「未装则记录跳过，不宣称通过」一致）。
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { vi } from 'vitest'

// mock electron：集成测试在 Node 环境运行，emit 走空窗口列表
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] }
}))

import {
  startDapSession,
  stopDapSession,
  setDapBreakpoints,
  dapEvaluate,
  getDapSnapshot,
  getDapStoppedContext
} from './genericDapSession'

// ---------- 环境探测 ----------

function resolvePython(): string | null {
  // 优先 PATH 中的 python；Windows 缺失时回退 py 启动器解析真实路径
  try {
    execFileSync('python', ['-c', 'import debugpy'], { stdio: 'ignore' })
    return 'python'
  } catch { /* 继续尝试 py */ }
  try {
    const exe = execFileSync('py', ['-c', 'import debugpy, sys; print(sys.executable)'], { encoding: 'utf-8' }).trim()
    if (exe) {
      // 把 python.exe 所在目录 prepend 到 PATH，使 spawn('python') 可解析
      process.env.PATH = `${dirname(exe)};${process.env.PATH}`
      return 'python'
    }
  } catch { /* 无 python */ }
  return null
}

// ---------- 轮询等待 ----------

async function waitFor(cond: () => boolean, timeoutMs = 15000, step = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, step))
  }
  throw new Error('等待超时')
}

// ---------- 冒烟 ----------

const pyOk = resolvePython() !== null
let scriptPath = ''

beforeAll(async () => {
  if (!pyOk) return
  // 临时脚本：第 2 行断点，x 应先被赋 1
  scriptPath = join(tmpdir(), `scholar-dap-smoke-${Date.now()}.py`)
  await fsp.writeFile(scriptPath, 'x = 1\ny = x + 41\nprint(y)\n', 'utf-8')
})

afterAll(async () => {
  await stopDapSession().catch(() => {})
  if (scriptPath) await fsp.unlink(scriptPath).catch(() => {})
})

describe.skipIf(!pyOk)('真机冒烟：debugpy DAP 会话', () => {
  it('launch → 断点停驻 → 堆栈/变量 → evaluate → 终止', async () => {
    // 1. 启动（launch 请求在 startDapSession 内完成）
    const r = await startDapSession({ runtime: 'debugpy', request: 'launch', program: scriptPath })
    expect(r.ok).toBe(true)
    expect(getDapSnapshot().state).not.toBe('idle')

    // 2. 下断点（第 2 行）
    const bp = await setDapBreakpoints(scriptPath, [2])
    expect(bp.ok).toBe(true)

    // 3. 等待停驻（configurationDone 已发，程序跑到断点）
    await waitFor(() => getDapSnapshot().state === 'stopped' && getDapStoppedContext() !== null)

    // 4. 验证堆栈：首帧在脚本第 2 行
    const ctx = getDapStoppedContext()!
    expect(ctx.stack.length).toBeGreaterThan(0)
    expect(ctx.stack[0].line).toBe(2)
    expect(ctx.stack[0].file.replace(/\//g, '\\')).toContain('scholar-dap-smoke')

    // 5. 验证变量：x = 1 已生效
    const xVar = ctx.variables.find((v) => v.name === 'x')
    expect(xVar).toBeDefined()
    expect(xVar!.value).toBe('1')

    // 6. REPL 求值
    const ev = await dapEvaluate('x + 1')
    expect(ev.ok).toBe(true)
    expect(ev.result).toBe('2')

    // 7. 停止会话
    const stop = await stopDapSession()
    expect(stop.ok).toBe(true)
    await waitFor(() => getDapSnapshot().state === 'terminated' || getDapSnapshot().state === 'idle', 5000)
  }, 30000)
})

describe('环境记录', () => {
  it('记录本机 debugpy 可用性（跳过信息用）', () => {
    // 该用例恒过：把探测结果打到输出，供验收记录实际跳过项
    console.log(`[dap-smoke] python+debugpy 可用: ${pyOk}`)
    expect(true).toBe(true)
  })
})
