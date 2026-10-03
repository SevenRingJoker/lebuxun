// 持久化增量索引单测：增量计划纯函数 + 真实临时目录的端到端往返
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  scanWorkspace,
  planDelta,
  ensureIndex,
  ensureIndexWorker,
  loadIndex,
  INDEX_VERSION,
  type CodeIndex,
  type ScanResult
} from './indexer'

/** 创建唯一临时工作区目录 */
async function makeTmpRoot(): Promise<string> {
  const dir = join(tmpdir(), `code-index-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

async function writeFile(root: string, rel: string, content: string): Promise<void> {
  const full = join(root, ...rel.split('/'))
  await fs.mkdir(join(full, '..'), { recursive: true })
  await fs.writeFile(full, content, 'utf-8')
}

/** 用内存对象构造 ScanResult（planDelta 纯函数测试用） */
function makeScan(entries: Array<[string, number, number]>): ScanResult {
  const disk = new Map()
  for (const [rel, mtimeMs, size] of entries) {
    disk.set(rel, { absPath: rel, mtimeMs, size })
  }
  return { disk, truncated: false }
}

function makeIndex(root: string, entries: Array<[string, number, number]>): CodeIndex {
  const files: CodeIndex['files'] = {}
  for (const [rel, mtimeMs, size] of entries) {
    files[rel] = {
      relPath: rel,
      absPath: rel,
      mtimeMs,
      size,
      imports: [],
      symbols: [],
      preview: '',
      lang: 'ts',
    }
  }
  return { version: INDEX_VERSION, root, updatedAt: '', files }
}

describe('planDelta 增量计划', () => {
  it('全量新增：旧索引为空时全部进入 added', () => {
    const scan = makeScan([['a.ts', 1, 10], ['b.ts', 2, 20]])
    const plan = planDelta(null, scan)
    expect(plan.added.sort()).toEqual(['a.ts', 'b.ts'])
    expect(plan.updated).toEqual([])
    expect(plan.removed).toEqual([])
  })

  it('mtime 或 size 变化进入 updated，完全一致进入 unchanged', () => {
    const root = '/ws'
    const old = makeIndex(root, [['a.ts', 100, 10], ['b.ts', 200, 20], ['c.ts', 300, 30]])
    const scan = makeScan([['a.ts', 100, 10], ['b.ts', 201, 20], ['c.ts', 300, 31]])
    const plan = planDelta(old, scan)
    expect(plan.unchanged).toEqual(['a.ts'])
    expect(plan.updated.sort()).toEqual(['b.ts', 'c.ts'])
  })

  it('磁盘上已消失的文件进入 removed', () => {
    const root = '/ws'
    const old = makeIndex(root, [['a.ts', 1, 1], ['gone.ts', 2, 2]])
    const scan = makeScan([['a.ts', 1, 1]])
    const plan = planDelta(old, scan)
    expect(plan.removed).toEqual(['gone.ts'])
  })
})

describe('ensureIndex 端到端（真实临时目录）', () => {
  let root: string

  beforeEach(async () => {
    root = await makeTmpRoot()
  })
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('首次构建解析文件与符号并落盘，二次加载可复用', async () => {
    await writeFile(root, 'src/a.ts', 'export function hello() {}\nconst VALUE = 1\n')
    await writeFile(root, 'src/b.py', 'def foo():\n    pass\n')
    const { index, delta } = await ensureIndex(root, { force: true })
    expect(delta.total).toBe(2)
    expect(Object.keys(index.files).sort()).toEqual(['src/a.ts', 'src/b.py'])
    const a = index.files['src/a.ts']
    expect(a.symbols.map((s) => s.name).sort()).toEqual(['VALUE', 'hello'])
    expect(a.symbols.find((s) => s.name === 'hello')?.kind).toBe('function')
    expect(a.symbols.find((s) => s.name === 'hello')?.line).toBe(1)
    expect(index.files['src/b.py'].symbols[0]).toMatchObject({ name: 'foo', kind: 'function', line: 1 })

    // 落盘内容可重新加载
    const reloaded = await loadIndex(root)
    expect(reloaded).not.toBeNull()
    expect(Object.keys(reloaded!.files)).toHaveLength(2)
  })

  it('跳过 node_modules / .trae / dist 等目录', async () => {
    await writeFile(root, 'src/a.ts', 'const a = 1\n')
    await writeFile(root, 'node_modules/pkg/index.js', 'module.exports = {}\n')
    await writeFile(root, '.trae/agent-notes.json', '{}\n')
    await writeFile(root, 'dist/bundle.js', 'var x=1\n')
    const scan = await scanWorkspace(root)
    expect([...scan.disk.keys()]).toEqual(['src/a.ts'])
  })

  it('增量更新：修改文件后 mtime 变化被识别为 updated，删除文件被清理', async () => {
    await writeFile(root, 'a.ts', 'const a = 1\n')
    await writeFile(root, 'b.ts', 'const b = 2\n')
    const first = await ensureIndex(root, { force: true })
    expect(first.delta.total).toBe(2)

    // 修改 a.ts 并把 mtime 拨到未来；删除 b.ts
    const aPath = join(root, 'a.ts')
    await fs.writeFile(aPath, 'const a = 11\nconst c = 3\n', 'utf-8')
    const future = new Date(Date.now() + 10_000)
    await fs.utimes(aPath, future, future)
    await fs.rm(join(root, 'b.ts'))

    const scan = await scanWorkspace(root)
    const plan = planDelta(first.index, scan)
    expect(plan.updated).toEqual(['a.ts'])
    expect(plan.removed).toEqual(['b.ts'])
  })

  it('损坏的索引文件被忽略并重建', async () => {
    await fs.mkdir(join(root, '.trae'), { recursive: true })
    await fs.writeFile(join(root, '.trae', 'code-index.json'), '{ not json', 'utf-8')
    await writeFile(root, 'a.ts', 'const a = 1\n')
    const { index } = await ensureIndex(root)
    expect(Object.keys(index.files)).toEqual(['a.ts'])
  })

  // s51 索引 worker 化：ensureIndexWorker 无论走 worker 还是回退主线程，都应返回正确索引
  it('ensureIndexWorker 返回与 ensureIndex 一致的结果', async () => {
    await writeFile(root, 'a.ts', 'export const x = 1\n')
    await writeFile(root, 'b.ts', 'export const y = 2\n')
    const { index } = await ensureIndexWorker(root, { force: true })
    expect(Object.keys(index.files).sort()).toEqual(['a.ts', 'b.ts'])
    // 落盘文件应存在
    const loaded = await loadIndex(root)
    expect(loaded).not.toBeNull()
    expect(Object.keys(loaded!.files).sort()).toEqual(['a.ts', 'b.ts'])
  }, 15000)
})
