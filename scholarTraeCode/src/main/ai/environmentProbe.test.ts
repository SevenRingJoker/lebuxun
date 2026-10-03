// environmentProbe 单测：版本解析/格式化/缓存；spawn 探测用 mock probeFn 注入
import { describe, it, expect, beforeEach } from 'vitest'
import {
  PROBE_TARGETS,
  parseVersion,
  probeRuntime,
  probeEnvironment,
  formatEnvironmentReport,
  setCachedEnvironmentReport,
  getCachedEnvironmentReport,
  invalidateEnvironmentCache,
  type ProbeTarget,
  type ProbeCommandFn
} from './environmentProbe'

describe('parseVersion', () => {
  it('Python 3.11.4 提取', () => {
    expect(parseVersion('Python 3.11.4\n', /Python\s+([\d.]+)/i)).toBe('3.11.4')
  })
  it('Node v20.10.0 提取（去 v 前缀）', () => {
    expect(parseVersion('v20.10.0\n', /v?([\d.]+)/)).toBe('20.10.0')
  })
  it('Go go1.21.5 提取', () => {
    expect(parseVersion('go version go1.21.5 windows/amd64\n', /go([\d.]+)/)).toBe('1.21.5')
  })
  it('Java -version 输出到 stderr 也能提取', () => {
    const out = 'openjdk version "17.0.9" 2023-10-17\n'
    expect(parseVersion(out, /version\s+"?([\d._]+)/)).toBe('17.0.9')
  })
  it('空输出返回 null', () => {
    expect(parseVersion('', /x/)).toBeNull()
  })
  it('无匹配返回 null', () => {
    expect(parseVersion('foo bar', /Python\s+([\d.]+)/)).toBeNull()
  })
})

// mock probeFn：返回预设的 {ok, output}
function makeProbeFn(map: Record<string, { ok: boolean; output: string; error?: string }>): ProbeCommandFn {
  return async (cmd) => map[cmd] ?? { ok: false, output: '', error: 'ENOENT' }
}

describe('probeRuntime', () => {
  it('首个命令成功则返回版本', async () => {
    const target: ProbeTarget = {
      runtime: 'Python', commands: ['python', 'python3'],
      args: ['--version'], versionRegex: /Python\s+([\d.]+)/i
    }
    const probe = makeProbeFn({ 'python': { ok: true, output: 'Python 3.11.4\n' } })
    const res = await probeRuntime(target, probe)
    expect(res.runtime).toBe('Python')
    expect(res.available).toBe(true)
    expect(res.version).toBe('3.11.4')
  })

  it('首个命令失败则尝试下一个候选', async () => {
    const target: ProbeTarget = {
      runtime: 'Python', commands: ['python', 'python3'],
      args: ['--version'], versionRegex: /Python\s+([\d.]+)/i
    }
    const probe = makeProbeFn({
      'python': { ok: false, output: '', error: 'ENOENT' },
      'python3': { ok: true, output: 'Python 3.10.0\n' }
    })
    const res = await probeRuntime(target, probe)
    expect(res.available).toBe(true)
    expect(res.version).toBe('3.10.0')
  })

  it('全部失败返回 unavailable', async () => {
    const target: ProbeTarget = {
      runtime: 'Python', commands: ['python', 'python3'],
      args: ['--version'], versionRegex: /Python\s+([\d.]+)/i
    }
    const probe = makeProbeFn({})
    const res = await probeRuntime(target, probe)
    expect(res.available).toBe(false)
    expect(res.version).toBeNull()
    expect(res.error).toBeDefined()
  })

  it('命令退出非零但输出含版本号也视为可用（java -version 走 stderr 但 code 0）', async () => {
    const target: ProbeTarget = {
      runtime: 'Java', commands: ['java'],
      args: ['-version'], versionRegex: /version\s+"?([\d._]+)/
    }
    const probe = makeProbeFn({ 'java': { ok: true, output: 'openjdk version "21"\n' } })
    const res = await probeRuntime(target, probe)
    expect(res.available).toBe(true)
  })
})

describe('probeEnvironment', () => {
  it('并发探测全部目标，返回 entries', async () => {
    const probe = makeProbeFn({
      'python': { ok: true, output: 'Python 3.11.4\n' },
      'node': { ok: true, output: 'v20.10.0\n' },
      'go': { ok: false, output: '', error: 'ENOENT' },
      'rustc': { ok: false, output: '', error: 'ENOENT' },
      'docker': { ok: true, output: 'Docker version 24.0.7\n' },
      'git': { ok: true, output: 'git version 2.42.0\n' },
      'java': { ok: true, output: 'openjdk version "17.0.9"\n' }
    })
    const report = await probeEnvironment(PROBE_TARGETS, probe)
    expect(report.entries).toHaveLength(PROBE_TARGETS.length)
    const python = report.entries.find((e) => e.runtime === 'Python')
    expect(python?.available).toBe(true)
    expect(python?.version).toBe('3.11.4')
    const go = report.entries.find((e) => e.runtime === 'Go')
    expect(go?.available).toBe(false)
  })
})

describe('formatEnvironmentReport', () => {
  it('列出可用版本 + 缺失清单 + 引导提示', () => {
    const report = {
      probedAt: '2026-01-01T00:00:00.000Z',
      entries: [
        { runtime: 'Python', available: true, version: '3.11.4' },
        { runtime: 'Node.js', available: true, version: '20.10.0' },
        { runtime: 'Go', available: false, version: null, error: 'ENOENT' }
      ]
    }
    const text = formatEnvironmentReport(report as any)
    expect(text).toContain('Python 3.11.4')
    expect(text).toContain('Node.js 20.10.0')
    expect(text).toContain('Go')
    expect(text).toContain('未安装')
    expect(text).toContain('引导用户安装')
  })

  it('全部缺失时可用列为（无）', () => {
    const report = {
      probedAt: '2026-01-01T00:00:00.000Z',
      entries: [{ runtime: 'Python', available: false, version: null }]
    }
    const text = formatEnvironmentReport(report as any)
    expect(text).toContain('（无）')
  })

  it('全部可用时无未安装段', () => {
    const report = {
      probedAt: '2026-01-01T00:00:00.000Z',
      entries: [{ runtime: 'Python', available: true, version: '3.11.4' }]
    }
    const text = formatEnvironmentReport(report as any)
    expect(text).not.toContain('未安装')
  })
})

describe('缓存', () => {
  beforeEach(() => invalidateEnvironmentCache())

  it('set 后 get 返回同一对象', () => {
    const report = { probedAt: 'x', entries: [] } as any
    setCachedEnvironmentReport(report)
    expect(getCachedEnvironmentReport()).toBe(report)
  })

  it('invalidate 后 get 返回 null', () => {
    setCachedEnvironmentReport({ probedAt: 'x', entries: [] } as any)
    invalidateEnvironmentCache()
    expect(getCachedEnvironmentReport()).toBeNull()
  })

  it('未设置时 get 返回 null', () => {
    expect(getCachedEnvironmentReport()).toBeNull()
  })
})
