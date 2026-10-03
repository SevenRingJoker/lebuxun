// 环境探测纯函数层：探测本机可用运行时（python/node/go/rustc/docker/git/java），
// 为 AI 规划提供环境上下文——避免在未安装 Python 的机器上盲执行 pip install。
//
// 架构：spawn 执行 + 版本号解析分离。探测执行函数可注入（单测用 mock），
// 版本解析/格式化/缓存全部为纯函数，可在 vitest node 环境直接单测。
import { spawn } from 'node:child_process'

/** 单个运行时的探测目标 */
export interface ProbeTarget {
  /** 显示名（用于报告与工具说明，如 'Python'） */
  runtime: string
  /** 可执行文件名候选，按顺序尝试（如 python/python3） */
  commands: string[]
  /** 探测参数（通常 ['--version']，docker 需先 version 再 info） */
  args: string[]
  /** 版本号提取正则：首个捕获组为版本字符串 */
  versionRegex: RegExp
}

/** 单个运行时探测结果 */
export interface EnvironmentReportEntry {
  runtime: string
  available: boolean
  /** 解析出的版本号；未安装/解析失败为 null */
  version: string | null
  /** 失败原因（命令不存在/超时/非零退出） */
  error?: string
}

/** 完整环境探测报告 */
export interface EnvironmentReport {
  /** 探测时刻 ISO 时间戳 */
  probedAt: string
  entries: EnvironmentReportEntry[]
}

/** 探测目标表：覆盖主流运行时。每个 runtime 给定命令候选 + 版本提取正则。 */
export const PROBE_TARGETS: ProbeTarget[] = [
  { runtime: 'Python', commands: ['python', 'python3'], args: ['--version'], versionRegex: /Python\s+([\d.]+)/i },
  { runtime: 'Node.js', commands: ['node'], args: ['-v'], versionRegex: /v?([\d.]+)/ },
  { runtime: 'Go', commands: ['go'], args: ['version'], versionRegex: /go([\d.]+)/ },
  { runtime: 'Rust', commands: ['rustc'], args: ['--version'], versionRegex: /rustc\s+([\d.]+)/ },
  { runtime: 'Docker', commands: ['docker'], args: ['--version'], versionRegex: /Docker\s+version\s+([\d.]+)/ },
  { runtime: 'Git', commands: ['git'], args: ['--version'], versionRegex: /git\s+version\s+([\d.]+)/ },
  { runtime: 'Java', commands: ['java'], args: ['-version'], versionRegex: /version\s+"?([\d._]+)/ }
]

/** 单项探测超时（毫秒）——单个运行时探测不应阻塞整体太久 */
const SINGLE_TIMEOUT_MS = 3000

/** 探测命令执行函数签名：供单测注入 mock 替代真实 spawn */
export type ProbeCommandFn = (
  command: string,
  args: string[],
  timeoutMs?: number
) => Promise<{ ok: boolean; output: string; error?: string }>

/**
 * 单次命令探测：spawn 执行，合并 stdout+stderr，返回原始输出。
 * 命令不存在/超时/非零退出均返回带 error 的结果，不抛异常。
 */
export const probeCommand: ProbeCommandFn = (
  command: string,
  args: string[],
  timeoutMs: number = SINGLE_TIMEOUT_MS
): Promise<{ ok: boolean; output: string; error?: string }> => {
  return new Promise((resolve) => {
    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn(command, args, { windowsHide: true, timeout: timeoutMs })
    } catch (e: any) {
      resolve({ ok: false, output: '', error: e?.message || String(e) })
      return
    }
    let output = ''
    proc.stdout?.on('data', (c) => { output += c.toString() })
    proc.stderr?.on('data', (c) => { output += c.toString() })
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL') } catch {}
    }, timeoutMs)
    proc.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, output: '', error: e?.message || String(e) })
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      // java -version 输出到 stderr 但退出码 0；只要有可解析输出即视为成功
      resolve({ ok: code === 0, output, error: code === 0 ? undefined : `exit ${code}` })
    })
  })
}

/**
 * 从原始输出中提取版本号；匹配不到返回 null。
 */
export function parseVersion(output: string, regex: RegExp): string | null {
  if (!output) return null
  const m = output.match(regex)
  return m && m[1] ? m[1] : null
}

/**
 * 探测单个运行时：按 commands 候选顺序尝试，返回第一个成功的结果。
 */
export async function probeRuntime(
  target: ProbeTarget,
  probeFn: typeof probeCommand = probeCommand
): Promise<EnvironmentReportEntry> {
  let lastErr = ''
  for (const cmd of target.commands) {
    const res = await probeFn(cmd, target.args, SINGLE_TIMEOUT_MS)
    const version = parseVersion(res.output, target.versionRegex)
    if (version) {
      return { runtime: target.runtime, available: true, version }
    }
    lastErr = res.error || 'version parse failed'
  }
  return { runtime: target.runtime, available: false, version: null, error: lastErr }
}

/**
 * 并发探测全部运行时，返回完整报告。
 */
export async function probeEnvironment(
  targets: ProbeTarget[] = PROBE_TARGETS,
  probeFn: typeof probeCommand = probeCommand
): Promise<EnvironmentReport> {
  const entries = await Promise.all(targets.map((t) => probeRuntime(t, probeFn)))
  return { probedAt: new Date().toISOString(), entries }
}

/**
 * 把报告格式化为注入系统提示词的中文摘要。
 * 结构：可用运行时（带版本）+ 缺失运行时（提示 AI 不要依赖或引导用户安装）。
 */
export function formatEnvironmentReport(report: EnvironmentReport): string {
  const available = report.entries.filter((e) => e.available)
  const missing = report.entries.filter((e) => !e.available)
  const lines: string[] = ['[环境探测] 本机可用运行时：']
  if (available.length > 0) {
    for (const e of available) {
      lines.push(`- ${e.runtime} ${e.version}`)
    }
  } else {
    lines.push('- （无）')
  }
  if (missing.length > 0) {
    lines.push(`未安装：${missing.map((e) => e.runtime).join('、')}。`)
    lines.push('规划时若需使用未安装的运行时，请引导用户安装或改用已安装的运行时，禁止盲目执行安装/包管理命令。')
  }
  return lines.join('\n')
}

// ====================== 会话级缓存 ======================

/** 缓存存活时间（毫秒）：环境变化不频繁，10 分钟内复用避免每次任务重复 spawn */
const CACHE_TTL_MS = 10 * 60 * 1000
let cachedReport: EnvironmentReport | null = null
let cachedAt = 0

/** 获取缓存报告；未命中或过期返回 null */
export function getCachedEnvironmentReport(): EnvironmentReport | null {
  if (!cachedReport) return null
  if (Date.now() - cachedAt > CACHE_TTL_MS) return null
  return cachedReport
}

/** 写入缓存 */
export function setCachedEnvironmentReport(report: EnvironmentReport): void {
  cachedReport = report
  cachedAt = Date.now()
}

/** 失效缓存（工作区切换/用户主动刷新时调用） */
export function invalidateEnvironmentCache(): void {
  cachedReport = null
  cachedAt = 0
}

/**
 * 获取环境报告：有缓存用缓存，无缓存执行探测并写入缓存。
 * 供调度器在 generatePlan 前自动调用，以及 probe_environment 工具复用。
 */
export async function getEnvironmentReport(force = false): Promise<EnvironmentReport> {
  if (!force) {
    const cached = getCachedEnvironmentReport()
    if (cached) return cached
  }
  const report = await probeEnvironment()
  setCachedEnvironmentReport(report)
  return report
}
