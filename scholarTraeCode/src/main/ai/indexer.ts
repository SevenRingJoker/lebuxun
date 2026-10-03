// 持久化增量代码索引：
// - 扫描磁盘（仅 stat）→ 与上次索引按 mtime+size 比对 → 只解析新增/变更文件
// - 落盘 <workspace>/.trae/code-index.json，进程重启后可直接复用
// - 同工作区 5s 节流，避免连续对话重复 stat 快扫
import { promises as fs } from 'node:fs'
import { join, relative, extname, sep } from 'node:path'
import { SOURCE_EXT, IGNORE_DIRS, parseFileContent, type ParsedFile } from './codeParse'

/** 索引文件结构版本：结构不兼容演进时递增，旧索引会被忽略并重建 */
export const INDEX_VERSION = 1
/** 单工作区索引文件数上限，防止巨型仓库拖垮内存与注入预算 */
export const MAX_INDEX_FILES = 3000
/** ensureIndex 节流间隔（毫秒），force=true 可绕过 */
const ENSURE_THROTTLE_MS = 5000
/** 递归扫描深度上限（与历史 buildIndex 行为一致） */
const DEFAULT_DEPTH = 6

/** 单个已索引文件（解析结果 + 磁盘元信息） */
export interface IndexedFile extends ParsedFile {
  /** 相对工作区根的路径（正斜杠） */
  relPath: string
  /** 绝对路径 */
  absPath: string
  /** 最近一次修改时间（毫秒），增量判变依据 */
  mtimeMs: number
}

/** 持久化到 .trae/code-index.json 的结构 */
export interface CodeIndex {
  version: number
  /** 工作区根绝对路径，用于校验索引归属 */
  root: string
  /** ISO 更新时间 */
  updatedAt: string
  /** relPath → 索引项 */
  files: Record<string, IndexedFile>
}

/** 磁盘快扫结果：只含 stat 元信息，不含文件内容 */
export interface ScanResult {
  /** relPath → 磁盘元信息 */
  disk: Map<string, { absPath: string; mtimeMs: number; size: number }>
  /** 是否命中文件数上限（截断） */
  truncated: boolean
}

/** 增量变更计划 */
export interface PlannedDelta {
  /** 磁盘上新增、需要解析的文件 */
  added: string[]
  /** mtime 或 size 变化、需要重新解析的文件 */
  updated: string[]
  /** 旧索引中有、磁盘已消失的文件 */
  removed: string[]
  /** 无变化可直接沿用旧索引项的文件 */
  unchanged: string[]
}

/** 一次增量构建的统计 */
export interface IndexDelta {
  total: number
  added: number
  updated: number
  removed: number
  truncated: boolean
  /** 是否命中节流直接返回了缓存 */
  throttled: boolean
}

/** 索引文件绝对路径 */
export function indexFilePath(root: string): string {
  return join(root, '.trae', 'code-index.json')
}

/** 读取持久化索引；不存在/损坏/版本或归属不匹配时返回 null（调用方按全量重建处理） */
export async function loadIndex(root: string): Promise<CodeIndex | null> {
  try {
    const raw = await fs.readFile(indexFilePath(root), 'utf-8')
    const parsed = JSON.parse(raw) as CodeIndex
    if (!parsed || parsed.version !== INDEX_VERSION || parsed.root !== root || !parsed.files) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

/** 写入索引（自动创建 .trae 目录；失败静默，不阻断对话） */
export async function saveIndex(root: string, index: CodeIndex): Promise<void> {
  try {
    await fs.mkdir(join(root, '.trae'), { recursive: true })
    await fs.writeFile(indexFilePath(root), JSON.stringify(index), 'utf-8')
  } catch {
    // 持久化失败时内存索引仍可用
  }
}

/** 递归 stat 快扫工作区（不读文件内容） */
export async function scanWorkspace(
  root: string,
  depth = DEFAULT_DEPTH,
  maxFiles = MAX_INDEX_FILES
): Promise<ScanResult> {
  const disk = new Map<string, { absPath: string; mtimeMs: number; size: number }>()
  let truncated = false
  async function walk(dir: string, d: number): Promise<void> {
    if (d <= 0 || truncated) return
    let names: string[]
    try {
      names = await fs.readdir(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (truncated) return
      if (IGNORE_DIRS.has(name)) continue
      const full = join(dir, name)
      let stat
      try {
        stat = await fs.stat(full)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        await walk(full, d - 1)
      } else if (stat.isFile() && SOURCE_EXT.has(extname(name).toLowerCase())) {
        if (disk.size >= maxFiles) {
          truncated = true
          return
        }
        const rel = relative(root, full).split(sep).join('/')
        disk.set(rel, { absPath: full, mtimeMs: stat.mtimeMs, size: stat.size })
      }
    }
  }
  await walk(root, depth)
  return { disk, truncated }
}

/**
 * 纯函数：对比旧索引与磁盘快扫结果，产出增量计划。
 * 判变条件：mtimeMs 或 size 任一不同即视为变更（size 纳入防止同 mtime 的边界问题）。
 */
export function planDelta(old: CodeIndex | null, scan: ScanResult): PlannedDelta {
  const added: string[] = []
  const updated: string[] = []
  const unchanged: string[] = []
  for (const [rel, meta] of scan.disk) {
    const prev = old?.files[rel]
    if (!prev) {
      added.push(rel)
    } else if (prev.mtimeMs !== meta.mtimeMs || prev.size !== meta.size) {
      updated.push(rel)
    } else {
      unchanged.push(rel)
    }
  }
  const removed: string[] = []
  if (old) {
    for (const rel of Object.keys(old.files)) {
      if (!scan.disk.has(rel)) removed.push(rel)
    }
  }
  return { added, updated, removed, unchanged }
}

/** 读取并解析单个磁盘文件；失败返回 null（编码/权限问题跳过） */
async function parseOne(rel: string, meta: { absPath: string; mtimeMs: number }): Promise<IndexedFile | null> {
  try {
    const content = await fs.readFile(meta.absPath, 'utf-8')
    return { relPath: rel, absPath: meta.absPath, mtimeMs: meta.mtimeMs, ...parseFileContent(rel, content) }
  } catch {
    return null
  }
}

/** 全量构建索引（无缓存时使用），返回新索引与统计 */
export async function buildCodeIndex(root: string): Promise<{ index: CodeIndex; delta: IndexDelta }> {
  const scan = await scanWorkspace(root)
  const index: CodeIndex = { version: INDEX_VERSION, root, updatedAt: new Date().toISOString(), files: {} }
  let added = 0
  for (const [rel, meta] of scan.disk) {
    const item = await parseOne(rel, meta)
    if (item) {
      index.files[rel] = item
      added++
    }
  }
  await saveIndex(root, index)
  return {
    index,
    delta: { total: Object.keys(index.files).length, added, updated: 0, removed: 0, truncated: scan.truncated, throttled: false }
  }
}

/** 按增量计划合并出新索引（解析新增/变更，沿用未变化项，剔除删除项） */
async function applyDelta(
  root: string,
  old: CodeIndex | null,
  scan: ScanResult,
  plan: PlannedDelta
): Promise<CodeIndex> {
  const files: Record<string, IndexedFile> = {}
  for (const rel of plan.unchanged) {
    const prev = old?.files[rel]
    if (prev) files[rel] = prev
  }
  for (const rel of [...plan.added, ...plan.updated]) {
    const meta = scan.disk.get(rel)
    if (!meta) continue
    const item = await parseOne(rel, meta)
    if (item) files[rel] = item
  }
  return { version: INDEX_VERSION, root, updatedAt: new Date().toISOString(), files }
}

// ---------- 运行时状态：内存缓存 + 节流 ----------

/** 最近一次真实（非节流）增量构建的统计 */
const lastDelta = new Map<string, IndexDelta>()

interface CacheEntry {
  index: CodeIndex
  lastEnsure: number
  scanning: Promise<CodeIndex> | null
}
const cache = new Map<string, CacheEntry>()

/** 取当前内存索引（不触发扫描），供状态查询使用 */
export function getCachedIndex(root: string): CodeIndex | null {
  return cache.get(root)?.index ?? null
}

/** 是否正在后台构建索引 */
export function isScanning(root: string): boolean {
  return !!cache.get(root)?.scanning
}

/**
 * 增量同步索引：stat 快扫 → 仅解析变更 → 落盘 → 更新内存缓存。
 * @param force 跳过节流与磁盘比对强制全量解析（重建）
 */
export async function ensureIndex(
  root: string,
  opts: { force?: boolean } = {}
): Promise<{ index: CodeIndex; delta: IndexDelta }> {
  const entry = cache.get(root)
  const now = Date.now()
  if (entry?.scanning) {
    const index = await entry.scanning
    return { index, delta: { total: Object.keys(index.files).length, added: 0, updated: 0, removed: 0, truncated: false, throttled: true } }
  }
  if (!opts.force && entry && now - entry.lastEnsure < ENSURE_THROTTLE_MS) {
    return {
      index: entry.index,
      delta: { total: Object.keys(entry.index.files).length, added: 0, updated: 0, removed: 0, truncated: false, throttled: true }
    }
  }

  const task = (async (): Promise<CodeIndex> => {
    if (opts.force) {
      const { index } = await buildCodeIndex(root)
      return index
    }
    const scan = await scanWorkspace(root)
    const old = (await loadIndex(root)) ?? entry?.index ?? null
    const plan = planDelta(old, scan)
    const index = await applyDelta(root, old, scan, plan)
    await saveIndex(root, index)
    // 顺带把本次增量统计挂到缓存上，供首次调用方读取
    lastDelta.set(root, {
      total: Object.keys(index.files).length,
      added: plan.added.length,
      updated: plan.updated.length,
      removed: plan.removed.length,
      truncated: scan.truncated,
      throttled: false
    })
    return index
  })()

  if (!entry) cache.set(root, { index: { version: INDEX_VERSION, root, updatedAt: '', files: {} }, lastEnsure: 0, scanning: null })
  const cur = cache.get(root)!
  cur.scanning = task
  try {
    const index = await task
    cur.index = index
    cur.lastEnsure = Date.now()
    const delta = lastDelta.get(root) ?? {
      total: Object.keys(index.files).length, added: 0, updated: 0, removed: 0, truncated: false, throttled: false
    }
    return { index, delta }
  } finally {
    cur.scanning = null
  }
}

/** 兼容旧接口：全量扫描并返回索引项数组（符号已升级为 CodeSymbol 结构） */
export async function buildIndex(root: string): Promise<IndexedFile[]> {
  const { index } = await ensureIndex(root, { force: true })
  return Object.values(index.files)
}

// ---------- s51 索引 worker 化：把耗时扫描移出主进程主线程 ----------

let indexerWorker: import('node:worker_threads').Worker | null = null
let workerInitFailed = false

/** 懒加载索引 worker；失败时置位 workerInitFailed，调用方回退主线程 */
function getWorker(): import('node:worker_threads').Worker | null {
  if (workerInitFailed) return null
  if (indexerWorker) return indexerWorker
  try {
    const { Worker } = require('node:worker_threads') as typeof import('node:worker_threads')
    // 编译后 indexer.js 与 indexerWorker.js 同目录，用 import.meta.url 定位
    const workerUrl = new URL('./indexerWorker.js', import.meta.url)
    indexerWorker = new Worker(workerUrl)
    indexerWorker.on('error', () => {
      workerInitFailed = true
      indexerWorker = null
    })
    indexerWorker.on('exit', (code) => {
      if (code !== 0) workerInitFailed = true
      indexerWorker = null
    })
    return indexerWorker
  } catch {
    workerInitFailed = true
    return null
  }
}

/**
 * worker 版 ensureIndex：把扫描/解析放到独立线程，避免阻塞主进程事件循环。
 * worker 不可用或超时（10s）时自动回退到主线程 ensureIndex。
 */
export async function ensureIndexWorker(
  root: string,
  opts: { force?: boolean } = {}
): Promise<{ index: CodeIndex; delta: IndexDelta }> {
  const worker = getWorker()
  if (!worker) {
    // worker 不可用：回退主线程
    return ensureIndex(root, opts)
  }
  return new Promise<{ index: CodeIndex; delta: IndexDelta }>((resolve) => {
    let settled = false
    const fallback = async (): Promise<void> => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      worker.off('message', onMessage)
      resolve(await ensureIndex(root, opts))
    }
    const timer = setTimeout(() => { void fallback() }, 10000)
    const onMessage = (msg: { type: string; index?: CodeIndex; delta?: IndexDelta; message?: string }) => {
      if (msg.type === 'result' && msg.index && msg.delta) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        worker.off('message', onMessage)
        // 结果写回主线程缓存与磁盘（worker 独立堆，不共享内存缓存）
        cache.set(root, { index: msg.index, lastEnsure: Date.now(), scanning: null })
        lastDelta.set(root, msg.delta)
        void saveIndex(root, msg.index)
        resolve({ index: msg.index, delta: msg.delta })
      } else if (msg.type === 'error') {
        void fallback()
      }
    }
    worker.on('message', onMessage)
    worker.postMessage({ type: 'ensureIndex', root, opts })
  })
}
