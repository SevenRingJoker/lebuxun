// 分级日志模块：写入 userData/logs/app-YYYY-MM-DD.log，按日滚动，支持等级过滤
// 设计：纯函数层（注入 logDir），不直接 import electron，便于 vitest 测试
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

/** 日志记录器配置 */
export interface LoggerOptions {
  /** 日志目录（通常为 userData/logs） */
  logDir: string
  /** 最低输出等级，低于此等级的日志丢弃 */
  level?: LogLevel
  /** 保留天数，超过自动删除（默认 7） */
  retentionDays?: number
  /** 是否同时输出到 console（开发态建议开启） */
  console?: boolean
}

/** 日志条目（写入文件前结构化） */
export interface LogEntry {
  ts: string
  level: LogLevel
  module: string
  message: string
}

/** 单条日志写入：追加到当日文件，文件不存在则创建 */
function appendLine(logDir: string, line: string): void {
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true })
  const date = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
  const file = join(logDir, `app-${date}.log`)
  appendFileSync(file, line + '\n', 'utf-8')
}

/** 清理超过保留天数的旧日志文件 */
function rotate(logDir: string, retentionDays: number): void {
  if (!existsSync(logDir)) return
  const now = Date.now()
  const maxAge = retentionDays * 24 * 60 * 60 * 1000
  for (const name of readdirSync(logDir)) {
    if (!/^app-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue
    try {
      const st = statSync(join(logDir, name))
      if (now - st.mtimeMs > maxAge) unlinkSync(join(logDir, name))
    } catch {
      // 单个文件清理失败不影响其他
    }
  }
}

/** 格式化单条日志为文本行 */
export function formatEntry(entry: LogEntry): string {
  return `${entry.ts} [${entry.level.toUpperCase()}] [${entry.module}] ${entry.message}`
}

/** 创建一个带模块标签的日志记录器 */
export function createLogger(module: string, opts: LoggerOptions) {
  const minLevel = LEVEL_ORDER[opts.level ?? 'info']
  const retention = opts.retentionDays ?? 7
  const toConsole = opts.console ?? false

  // 每次写日志时顺带滚动清理（频率低，开销可忽略）
  let lastRotate = 0

  function log(level: LogLevel, message: string): void {
    if (LEVEL_ORDER[level] < minLevel) return
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      module,
      message
    }
    const line = formatEntry(entry)
    try {
      appendLine(opts.logDir, line)
      const now = Date.now()
      if (now - lastRotate > 60_000) {
        rotate(opts.logDir, retention)
        lastRotate = now
      }
    } catch {
      // 磁盘写入失败不影响主流程，降级到 console
      if (toConsole) console[level === 'debug' ? 'log' : level](line)
      return
    }
    if (toConsole) console[level === 'debug' ? 'log' : level](line)
  }

  return {
    debug: (msg: string) => log('debug', msg),
    info: (msg: string) => log('info', msg),
    warn: (msg: string) => log('warn', msg),
    error: (msg: string) => log('error', msg)
  }
}

export type Logger = ReturnType<typeof createLogger>

// ===== 全局日志配置（供 ai/ 模块便捷调用，测试时 init 到 tmp 目录）=====
let globalOpts: LoggerOptions | null = null

/** 初始化全局日志配置（主进程启动时调用一次） */
export function initGlobalLogger(opts: LoggerOptions): void {
  globalOpts = opts
}

/** 按模块名获取日志记录器；未初始化时返回空操作记录器（不影响测试） */
export function getLogger(module: string): Logger {
  if (!globalOpts) {
    // 未初始化：所有调用静默丢弃（测试环境或早期启动阶段）
    return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
  }
  return createLogger(module, globalOpts)
}
