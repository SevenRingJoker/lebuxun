// s46 改动落盘后的受影响测试自动回归（IO 层）：
// staging accept 成功后异步触发——按 s42 索引圈定受影响测试子集，spawn vitest 跑子集，
// 结果广播给渲染端；失败转成 s45 修复提案（同一张确认卡片承载修复循环）。
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { relative, sep, join } from 'node:path'
import { BrowserWindow } from 'electron'
import { ensureIndex } from './indexer'
import { affectedTests } from './testGen'
import { classifyFailure, proposeRepairs, type RepairProposal } from '../terminal/repairAdvisor'

export interface AutoTestResult {
  /** 是否真的跑了测试（无 vitest / 无受影响测试时为 false） */
  ran: boolean
  reason?: string
  tests?: string[]
  ok?: boolean
  /** vitest 输出尾部 */
  tail?: string
  durationMs?: number
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

/** package.json 是否声明 vitest */
async function hasVitest(workspace: string): Promise<boolean> {
  try {
    const pkg = JSON.parse(await readFile(join(workspace, 'package.json'), 'utf-8'))
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }
    return 'vitest' in deps
  } catch {
    return false
  }
}

/**
 *  vitest 配置解析：
 * - 工作区自带 vite/vitest 配置 → 沿用（返回 null，不加 --config）
 * - 否则生成最小配置到 .trae/ 并显式指定——否则 vitest 会向上误捡父级仓库的
 *   vitest.config（其 include 通常不含本子目录，导致「No test files found」假失败）
 */
function ensureVitestConfig(workspace: string): string | null {
  const OWN = [
    'vitest.config.ts', 'vitest.config.js', 'vitest.config.mts', 'vitest.config.mjs',
    'vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vite.config.mjs'
  ]
  for (const n of OWN) {
    if (existsSync(join(workspace, n))) return null
  }
  try {
    const dir = join(workspace, '.trae')
    mkdirSync(dir, { recursive: true })
    const cfg = join(dir, 'vitest.autorun.config.mjs')
    writeFileSync(cfg,
      '// 自动生成：自动回归专用最小 vitest 配置（工作区无自带配置时启用）\n' +
      "export default { test: { include: ['**/*.{test,spec}.{ts,tsx,js,jsx,mts,mjs,cts,cjs}'], exclude: ['**/node_modules/**', '**/dist/**'] } }\n",
      'utf-8')
    return cfg
  } catch {
    return null
  }
}

/** 变更落盘后自动跑受影响测试子集（异步，不阻塞 accept 返回） */
export async function runAffectedTests(workspace: string, changedAbs: string[]): Promise<void> {
  const t0 = Date.now()
  try {
    if (!(await hasVitest(workspace))) return
    const { index } = await ensureIndex(workspace)
    const rels = changedAbs
      .map((p) => relative(workspace, p).split(sep).join('/'))
      .filter((r) => r && !r.startsWith('..'))
    const tests = affectedTests(index, rels)
    if (tests.length === 0) {
      broadcast('test:autoRun', { ran: false, reason: '无受影响测试' } satisfies AutoTestResult)
      return
    }
    const cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx'
    const cfg = ensureVitestConfig(workspace)
    const args = ['vitest', 'run', ...(cfg ? ['--config', cfg] : []), ...tests]
    const output: string[] = []
    const code = await new Promise<number>((resolve) => {
      // Windows 需 shell:true（CVE-2024-27980 后直接 spawn .cmd 会抛 EINVAL）
      const proc = spawn(cmd, args, { cwd: workspace, windowsHide: true, shell: true })
      const timer = setTimeout(() => {
        proc.kill()
        resolve(-1)
      }, 180_000)
      proc.stdout.on('data', (b: Buffer) => output.push(b.toString('utf8')))
      proc.stderr.on('data', (b: Buffer) => output.push(b.toString('utf8')))
      proc.on('close', (c) => {
        clearTimeout(timer)
        resolve(c ?? -1)
      })
      proc.on('error', () => {
        clearTimeout(timer)
        resolve(-1)
      })
    })
    const text = output.join('')
    const tail = text.length > 2000 ? text.slice(-2000) : text
    const ok = code === 0
    broadcast('test:autoRun', {
      ran: true,
      tests,
      ok,
      tail,
      durationMs: Date.now() - t0
    } satisfies AutoTestResult)
    // 失败 → 转 s45 修复提案卡片（origin=test），进入同款修复循环
    if (!ok) {
      const report = classifyFailure(`npx vitest run ${tests.join(' ')}`, text, code)
      if (report) {
        const actions = proposeRepairs(report)
        const proposal: RepairProposal = {
          origin: 'test',
          command: `npx vitest run ${tests.join(' ')}`,
          cwd: workspace,
          report,
          actions
        }
        // 测试失败多为代码错误（无自动动作）——仅在有修复动作时弹卡
        if (actions.length > 0) broadcast('terminal:repairProposals', proposal)
      }
    }
  } catch {
    // 自动回归是辅助链路：任何异常静默降级，不影响主流程
  }
}
