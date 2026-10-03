// logger.ts 集成单测：文件写入/等级过滤/按日滚动/全局初始化
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createLogger,
  initGlobalLogger,
  getLogger,
  formatEntry,
  type LogEntry
} from './logger'

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'scholar-log-'))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('formatEntry', () => {
  it('格式化为 ISO时间 [LEVEL] [module] message', () => {
    const entry: LogEntry = { ts: '2026-09-30T10:00:00.000Z', level: 'info', module: 'test', message: 'hello' }
    expect(formatEntry(entry)).toBe('2026-09-30T10:00:00.000Z [INFO] [test] hello')
  })

  it('error 级别大写', () => {
    const entry: LogEntry = { ts: 'T', level: 'error', module: 'm', message: 'boom' }
    expect(formatEntry(entry)).toContain('[ERROR]')
  })
})

describe('createLogger — 文件写入', () => {
  it('info 级别写入当日文件', async () => {
    const logger = createLogger('app', { logDir: dir, console: false })
    logger.info('启动完成')
    const date = new Date().toISOString().slice(0, 10)
    const content = await fs.readFile(join(dir, `app-${date}.log`), 'utf-8')
    expect(content).toContain('[INFO]')
    expect(content).toContain('[app]')
    expect(content).toContain('启动完成')
  })

  it('多行追加（不覆盖）', async () => {
    const logger = createLogger('m', { logDir: dir, console: false })
    logger.info('第一行')
    logger.info('第二行')
    const date = new Date().toISOString().slice(0, 10)
    const content = await fs.readFile(join(dir, `app-${date}.log`), 'utf-8')
    expect(content.split('\n').filter(Boolean)).toHaveLength(2)
  })
})

describe('createLogger — 等级过滤', () => {
  it('level=warn 时丢弃 debug 和 info', async () => {
    const logger = createLogger('m', { logDir: dir, level: 'warn', console: false })
    logger.debug('d')
    logger.info('i')
    logger.warn('w')
    logger.error('e')
    const date = new Date().toISOString().slice(0, 10)
    const content = await fs.readFile(join(dir, `app-${date}.log`), 'utf-8')
    expect(content).not.toContain('[DEBUG]')
    expect(content).not.toContain('"i"')
    expect(content).toContain('[WARN]')
    expect(content).toContain('[ERROR]')
  })
})

describe('createLogger — 按日滚动', () => {
  it('删除超过保留天数的旧文件', async () => {
    // 手动创建一个旧日志文件
    const oldDate = '2020-01-01'
    const oldFile = join(dir, `app-${oldDate}.log`)
    await fs.writeFile(oldFile, 'old content', 'utf-8')
    // 修改 mtime 为 10 天前，使 rotate 判定为过期
    const oldTime = new Date(Date.now() - 10 * 86400000)
    await fs.utimes(oldFile, oldTime, oldTime)
    // 创建 logger 时 retentionDays=7，首次写入触发 rotate
    const logger = createLogger('m', { logDir: dir, retentionDays: 7, console: false })
    logger.info('trigger rotate')
    // 旧文件应被删除
    await expect(fs.access(oldFile)).rejects.toThrow()
  })

  it('保留天数内的文件不被删除', async () => {
    // 创建一个 3 天前的文件
    const recent = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10)
    const recentFile = join(dir, `app-${recent}.log`)
    await fs.writeFile(recentFile, 'recent', 'utf-8')
    const logger = createLogger('m', { logDir: dir, retentionDays: 7, console: false })
    logger.info('trigger')
    // 文件应存在
    const stat = await fs.stat(recentFile)
    expect(stat.size).toBeGreaterThan(0)
  })
})

describe('全局 logger', () => {
  it('未初始化时 getLogger 返回空操作记录器', () => {
    // 不调用 initGlobalLogger，getLogger 应返回静默丢弃的记录器
    const logger = getLogger('uninit')
    // 应不抛错、不写文件
    logger.info('should be noop')
    logger.error('should be noop')
  })

  it('初始化后 getLogger 写入同一目录', async () => {
    initGlobalLogger({ logDir: dir, console: false })
    const logger = getLogger('global-test')
    logger.info('全局写入')
    const date = new Date().toISOString().slice(0, 10)
    const content = await fs.readFile(join(dir, `app-${date}.log`), 'utf-8')
    expect(content).toContain('[global-test]')
    expect(content).toContain('全局写入')
  })
})
