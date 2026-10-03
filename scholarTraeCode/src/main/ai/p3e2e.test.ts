// P3 通用化改造 · 真实场景端到端验证（零 mock，全部真实 IO）。
//
// 与普通单测不同：本文件真实 spawn 探测运行时、真实执行失败命令拿真实 stderr、
// 真实读 resources/skills、并直连本机 Ollama（qwen2.5-coder:7b）跑一次完整的
// 「连续受阻 → Self-Reflection → 解析修复步骤」真实 LLM 重规划。
//
// 默认整体 skip，不污染全量套件/CI；显式启用：
//   PowerShell:  $env:P3_E2E='1'; npx vitest run src/main/ai/p3e2e.test.ts
import { describe, it, expect } from 'vitest'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Ollama } from 'ollama'

import {
  getEnvironmentReport,
  formatEnvironmentReport
} from './environmentProbe'
import { gateBashMessage, type BashGateContext } from './bashGate'
import { analyzeCommandError } from '../terminal/commandError'
import { listSkills, loadSkill, recommendSkills } from './skills'
import {
  createReplanState,
  noteFailure,
  shouldReplan,
  markReplanned,
  requestReplan,
  sanitizeReplanSteps
} from './replanner'
import type { AiProvider } from './types'

const E2E_ENABLED = process.env.P3_E2E === '1'
const execAsync = promisify(exec)

/** 真实执行一条命令；非零退出时从 error 中取回 stdout/stderr/exitCode（不抛异常） */
async function runReal(cmd: string, cwd?: string): Promise<{
  output: string
  exitCode: number
}> {
  try {
    const { stdout, stderr } = await execAsync(cmd, cwd ? { cwd } : {})
    return { output: `${stdout}${stderr}`, exitCode: 0 }
  } catch (err: any) {
    return {
      output: `${err.stdout ?? ''}${err.stderr ?? ''}`,
      exitCode: typeof err.code === 'number' ? err.code : 1
    }
  }
}

/** 直连本机 Ollama 的真实 provider adapter（绕过 electron userData 依赖） */
function makeRealOllamaAdapter(): AiProvider {
  const client = new Ollama({ host: 'http://127.0.0.1:11434' })
  return {
    id: 'ollama-real',
    displayName: 'Ollama real adapter',
    health: async () => ({ ok: true }),
    listModels: async () => [],
    async chat(params: {
      model: string
      messages: import('./types').AiMessage[]
      tools?: unknown[]
    }) {
      const res = await client.chat({
        model: params.model,
        messages: params.messages as any,
        stream: false
      })
      return {
        ok: true,
        content: res.message?.content ?? '',
        usage: { tokensIn: res.prompt_eval_count, tokensOut: res.eval_count }
      }
    },
    async chatStream() {
      return { ok: true }
    }
  } as unknown as AiProvider
}

function makeGateCtx(overrides: Partial<BashGateContext> = {}): BashGateContext {
  return {
    isProjectCreation: true,
    createdFiles: new Set<string>(),
    ranNpmInstall: false,
    ranServe: false,
    ...overrides
  }
}

describe.skipIf(!E2E_ENABLED)('P3 真实场景端到端（零 mock）', () => {
  // ========== 阶段 1：真实环境探测 ==========
  it('阶段1 真实 spawn 探测本机运行时', async () => {
    const report = await getEnvironmentReport(true)
    const text = formatEnvironmentReport(report)
    console.log('\n========== 阶段1 环境探测报告（真实 spawn）==========\n' + text)
    // Node 必然可用（测试本身运行在 Node 上）
    const node = report.entries.find((e) => e.runtime === 'Node.js')
    expect(node?.available).toBe(true)
    expect(node?.version).toBeTruthy()
  }, 60000)

  // ========== 阶段 2：真实门控黑盒 ==========
  it('阶段2 命令门控对真实命令的拦截/放行判定', () => {
    const mustBlock: Array<[string, string]> = [
      ['vue create my-app', '交互脚手架'],
      ['npx create-react-app app', '交互脚手架'],
      ['npm create vite@latest', '交互脚手架'],
      ['yarn create next-app app', '交互脚手架'],
      ['sudo npm install', '破坏命令'],
      ['rm -rf /', '破坏命令'],
      ['mkfs.ext4 /dev/sda1', '破坏命令'],
      ['shutdown -h now', '破坏命令'],
      ['apt install nginx', '缺 -y'],
      ['git commit', '缺 -m']
    ]
    // 注意：npm install 在项目创建+无 package.json 时被依赖图谱拦截（顺序锁，正确行为），
    // 故不放行清单；其「有 package.json 后放行」在下方依赖图谱处单独验证。
    const mustPass = ['git status', 'node src/index.js', 'ls -la', 'go version']

    console.log('\n========== 阶段2 门控黑盒 ==========')
    for (const [cmd, label] of mustBlock) {
      const reason = gateBashMessage(cmd, makeGateCtx())
      expect(reason, `${label}「${cmd}」应被拦截`).not.toBeNull()
      console.log(`[拦截] ${cmd}  ←  ${label}`)
    }
    for (const cmd of mustPass) {
      expect(gateBashMessage(cmd, makeGateCtx()), `「${cmd}」应放行`).toBeNull()
      console.log(`[放行] ${cmd}`)
    }

    // 依赖图谱：项目创建场景 npm install 无 package.json 拦截；有则放行
    expect(gateBashMessage('npm install', makeGateCtx())).toContain('package.json')
    expect(
      gateBashMessage('npm install', makeGateCtx({ createdFiles: new Set(['/p/package.json']) }))
    ).toBeNull()
  })

  // ========== 阶段 3：真实失败命令 → 真实诊断 ==========
  it('阶段3 真实执行失败命令并产出诊断', async () => {
    const tmp = await fs.mkdtemp(join(tmpdir(), 'p3-e2e-'))
    console.log('\n========== 阶段3 真实失败 → 诊断 ==========')

    // 3a 不存在的命令：cmd 真实输出「不是内部或外部命令」
    const r1 = await runReal('nonexistent-cmd-xyz-9527', tmp)
    const info1 = analyzeCommandError('nonexistent-cmd-xyz-9527', r1.output, r1.exitCode)
    console.log(`\n[真实输出] ${r1.output.trim()}`)
    expect(info1).not.toBeNull()
    expect(info1!.severity).toBe('manual')
    expect(info1!.hints.join('\n')).toContain('probe_environment')
    console.log(`[诊断] severity=${info1!.severity} hint=${info1!.hints[0]}`)

    // 3b node 真实报错：执行不存在的脚本
    const r2 = await runReal('node this-script-missing-xyz.js', tmp)
    const info2 = analyzeCommandError('node this-script-missing-xyz.js', r2.output, r2.exitCode)
    console.log(`\n[真实输出] ${r2.output.trim()}`)
    expect(info2).not.toBeNull()
    expect(info2!.hints.length).toBeGreaterThan(0)
    console.log(`[诊断] summary=${info2!.summary}`)

    await fs.rm(tmp, { recursive: true, force: true })
  }, 30000)

  // ========== 阶段 4：真实技能发现与触发推荐 ==========
  it('阶段4 真实加载内置技能并匹配触发推荐', async () => {
    const skills = await listSkills(null)
    console.log('\n========== 阶段4 真实技能 ==========')
    expect(skills.length).toBe(4)
    const nodeSkill = skills.find((s) => s.name === 'node-scaffold')
    expect(nodeSkill?.triggers.length).toBeGreaterThan(0)

    const full = await loadSkill(null, 'python-venv')
    expect(full).toContain('Activate.ps1')
    console.log(`[loadSkill python-venv] ${full.length} 字符，含 win/mac 双激活写法`)

    // 真实文本触发推荐：命中 node-scaffold
    const rec = recommendSkills(skills, '帮我用 express 写一个后端接口服务')
    expect(rec.has('node-scaffold')).toBe(true)
    console.log(`[推荐] express 请求 → ${Array.from(rec).join('、')}`)
  }, 15000)

  // ========== 阶段 5：真实 LLM 动态重规划（核心） ==========
  it('阶段5 真实 Ollama(qwen2.5-coder:7b) Self-Reflection 重规划全链路', async () => {
    const tmp = await fs.mkdtemp(join(tmpdir(), 'p3-replan-'))
    // 模拟真实执行现场：已写 package.json，但连续两条命令失败
    const createdFiles = new Set<string>([join(tmp, 'package.json')])

    const fail1 = await runReal('npm run serve', tmp) // 无 node_modules，真实失败
    const fail2 = await runReal('node missing-xyz.js', tmp)

    const state = createReplanState()
    noteFailure(state, 'commandFailure', `npm run serve\n${fail1.output.slice(-300)}`)
    noteFailure(state, 'commandFailure', `node missing-xyz.js\n${fail2.output.slice(-300)}`)

    console.log('\n========== 阶段5 真实 LLM 重规划 ==========')
    expect(state.consecutiveFailures).toBe(2)
    expect(shouldReplan(state)).toBe(true)

    const provider = makeRealOllamaAdapter()
    const result = await requestReplan({
      provider,
      modelName: 'qwen2.5-coder:7b',
      userRequest: '帮我创建一个 Vue2 项目',
      state,
      createdFiles,
      todos: [
        { id: 1, content: '创建 package.json', status: 'completed', priority: 'high' },
        { id: 2, content: 'npm install', status: 'pending', priority: 'high' },
        { id: 3, content: 'npm run serve', status: 'pending', priority: 'high' }
      ]
    })

    // 真实 LLM 必须产出可解析步骤
    expect(result, '真实 LLM 重规划应返回步骤').not.toBeNull()
    expect(result!.steps.length).toBeGreaterThan(0)
    console.log(`\n[真实 LLM 重规划] 耗时 ${result!.durationMs}ms，产出 ${result!.steps.length} 步：`)
    result!.steps.forEach((s, i) =>
      console.log(`  ${i + 1}. [${s.kind ?? 'step'}] ${s.content}${s.target ? ` → ${s.target}` : ''}`)
    )

    // 5a 真实步骤过门控过滤（与 scheduler 消费逻辑一致）
    const gateCtx = makeGateCtx({
      createdFiles: new Set<string>([...createdFiles, 'package.json'])
    })
    const sanitized = sanitizeReplanSteps(result!.steps, (c) => gateBashMessage(c, gateCtx))
    for (const d of sanitized.dropped) {
      console.log(`  [门控丢弃] ${d.target || d.content}`)
    }
    // 必须至少有一条可执行步骤；kept 的 content+target 均不得含交互脚手架/sudo
    expect(sanitized.kept.length, '过滤后须有可执行步骤').toBeGreaterThan(0)
    const keptText = sanitized.kept
      .map((s) => `${s.content} ${s.target ?? ''}`)
      .join('\n')
    expect(keptText).not.toMatch(/vue\s+create|create-react-app|sudo/)

    // 5b 确定性兜底（不依赖 LLM 稳定性）：手工注入 vue create / sudo 步骤必须被丢弃
    const probe = sanitizeReplanSteps(
      [
        ...sanitized.kept,
        { content: '脚手架创建', kind: 'command' as const, target: 'vue create app' },
        { content: '提权安装', kind: 'command' as const, target: 'sudo npm install' }
      ],
      (c) => gateBashMessage(c, gateCtx)
    )
    expect(probe.dropped.length).toBe(2)
    console.log('[确定性兜底] vue create / sudo 注入步骤被门控丢弃 2 条')

    markReplanned(state)
    expect(state.replanCount).toBe(1)
    // 已用一次配额：再失败两次也仍可触发（上限 2 次）
    noteFailure(state, 'commandFailure', 'x')
    noteFailure(state, 'commandFailure', 'y')
    expect(shouldReplan(state)).toBe(true)
    markReplanned(state)
    noteFailure(state, 'commandFailure', 'x')
    noteFailure(state, 'commandFailure', 'y')
    expect(shouldReplan(state)).toBe(false) // 达上限 2，防抖生效
    console.log('\n[防抖验证] 重规划达 2 次上限后 shouldReplan=false，回退 stall 机制')

    await fs.rm(tmp, { recursive: true, force: true })
  }, 300000)
})
