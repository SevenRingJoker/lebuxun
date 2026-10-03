// 检索层单测：CJK 分词、BM25 排序、依赖邻接、@mention 解析、上下文预算
import { describe, it, expect, beforeEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  tokenize,
  searchIndex,
  parseMentions,
  buildContext,
  type SearchHit
} from './retrieval'
import { INDEX_VERSION, type CodeIndex, type IndexedFile } from './indexer'
import type { CodeSymbol } from './codeParse'

/** 构造索引项的测试夹具 */
function file(
  relPath: string,
  opts: { preview?: string; symbols?: Array<[string, CodeSymbol['kind'], number]>; imports?: string[] } = {}
): IndexedFile {
  return {
    relPath,
    absPath: relPath.startsWith('/') ? relPath : `/ws/${relPath}`,
    mtimeMs: 0,
    size: (opts.preview ?? '').length,
    imports: opts.imports ?? [],
    symbols: (opts.symbols ?? []).map(([name, kind, line]) => ({ name, kind, line })),
    preview: opts.preview ?? '',
    lang: 'ts'
  }
}

function indexOf(files: IndexedFile[], root = '/ws'): CodeIndex {
  const record: CodeIndex['files'] = {}
  for (const f of files) record[f.relPath] = f
  return { version: INDEX_VERSION, root, updatedAt: '', files: record }
}

function rels(hits: SearchHit[]): string[] {
  return hits.map((h) => h.relPath)
}

describe('tokenize CJK 感知分词', () => {
  it('拉丁标识符小写化', () => {
    expect(tokenize('HelloWorld permission_gate 123')).toContain('helloworld')
    expect(tokenize('HelloWorld permission_gate 123')).toContain('permission_gate')
  })
  it('中文产生相邻二元组', () => {
    expect(tokenize('权限审批')).toEqual(['权限', '限审', '审批'])
  })
  it('中英混合同时产出两类词项', () => {
    const t = tokenize('permissions 权限')
    expect(t).toContain('permissions')
    expect(t).toContain('权限')
  })
})

describe('searchIndex BM25 与图加权', () => {
  it('查询词命中的文件排在无命中之前', () => {
    const idx = indexOf([
      file('a.ts', { preview: 'totally unrelated content about weather' }),
      file('b.ts', { preview: 'export function checkPermission() { deny write }' })
    ])
    const hits = searchIndex(idx, 'permission write deny')
    expect(rels(hits)[0]).toBe('b.ts')
  })

  it('中文查询通过二元组命中', () => {
    const idx = indexOf([
      file('a.ts', { preview: 'const x = 1 // 今日天气不错' }),
      file('permissions.ts', { preview: '// 权限审批闸门：危险操作必须确认' })
    ])
    const hits = searchIndex(idx, '权限审批')
    expect(rels(hits)[0]).toBe('permissions.ts')
  })

  it('稀有词（高 IDF）比常见词更能决定排序', () => {
    const idx = indexOf([
      file('a.ts', { preview: 'common common common zephyr' }),
      file('b.ts', { preview: 'common common common common' }),
      file('c.ts', { preview: 'common' })
    ])
    const hits = searchIndex(idx, 'zephyr common')
    expect(rels(hits)[0]).toBe('a.ts')
  })

  it('当前文件的 import 邻居获得加权，自身被降权', () => {
    const idx = indexOf([
      file('src/app.ts', { preview: 'bootstrap', imports: ['./util'] }),
      file('src/util.ts', { preview: 'helper helpers misc' }),
      file('src/other.ts', { preview: 'bootstrap helper' })
    ])
    // 查询词只命中 other 的预览，但 util 是 app 的直接依赖
    const hits = searchIndex(idx, 'bootstrap', { currentRel: 'src/app.ts' })
    const order = rels(hits)
    expect(order).not.toContain('src/app.ts')
    expect(order.indexOf('src/util.ts')).toBeLessThan(order.indexOf('src/other.ts') + 1)
  })

  it('符号名被问题直接命中时返回 symbol 字段', () => {
    const idx = indexOf([
      file('a.ts', { preview: 'nothing here', symbols: [['calculateRisk', 'function', 12]] })
    ])
    const hits = searchIndex(idx, 'calculateRisk 的逻辑')
    expect(hits[0].symbol).toBe('calculateRisk')
    expect(hits[0].symbolLine).toBe(12)
  })

  it('反向依赖：import 当前文件的文件也被加权', () => {
    const idx = indexOf([
      file('src/core.ts', { preview: 'core logic zzz' }),
      file('src/consumer.ts', { preview: 'zzz', imports: ['./core'] }),
      file('src/random.ts', { preview: 'zzz zzz zzz' })
    ])
    const hits = searchIndex(idx, 'zzz', { currentRel: 'src/core.ts' })
    // consumer 内容只有一个 zzz，但靠反向依赖加权不应垫底
    expect(rels(hits).indexOf('src/consumer.ts')).toBeLessThan(rels(hits).length - 1)
  })
})

describe('parseMentions @ 引用解析', () => {
  const idx = indexOf([
    file('src/app.ts', { symbols: [['bootstrap', 'function', 1]], preview: 'bootstrap' }),
    file('src/utils/format.ts', { symbols: [['trim', 'function', 9]], preview: 'trim' }),
    file('src/views/detail.vue', { preview: 'detail page' })
  ])

  it('@codebase 标记全库并从查询剥离', () => {
    const r = parseMentions('@codebase 帮我梳理整体架构', idx)
    expect(r.codebase).toBe(true)
    expect(r.cleanQuery).toBe('帮我梳理整体架构')
  })

  it('带路径的 token 按文件匹配（子串/后缀消歧）', () => {
    const r = parseMentions('解释 @src/utils/format.ts 的逻辑', idx)
    expect(r.files).toEqual(['src/utils/format.ts'])
    expect(r.cleanQuery).toBe('解释 的逻辑')
  })

  it('@symbol:名称 精确定位符号文件', () => {
    const r = parseMentions('@symbol:trim 为什么没生效', idx)
    expect(r.files).toEqual(['src/utils/format.ts'])
    expect(r.symbols).toEqual(['trim'])
  })

  it('裸 token 先匹配文件名再匹配符号名', () => {
    const byFile = parseMentions('看看 @detail 页面', idx)
    expect(byFile.files).toEqual(['src/views/detail.vue'])
    const bySym = parseMentions('@bootstrap 何时执行', idx)
    expect(bySym.files).toEqual(['src/app.ts'])
    expect(bySym.symbols).toEqual(['bootstrap'])
  })

  it('无法解析的 mention 保留原文，不丢失用户意图', () => {
    const r = parseMentions('@不存在的东西 怎么改', idx)
    expect(r.files).toEqual([])
    expect(r.cleanQuery).toContain('@不存在的东西')
  })

  it('无索引时原样返回', () => {
    const r = parseMentions('@app.ts 看看', null)
    expect(r.cleanQuery).toBe('@app.ts 看看')
    expect(r.files).toEqual([])
  })
})

describe('buildContext 上下文拼装', () => {
  it('预算截断：只放得下高分文件', async () => {
    const idx = indexOf([
      file('a.ts', { preview: 'alpha '.repeat(50) }),
      file('b.ts', { preview: 'beta '.repeat(50) })
    ])
    const r = await buildContext(idx, 'alpha', null, '/ws', 200, null)
    expect(r.text).toContain('a.ts')
    expect(r.text).not.toContain('b.ts')
  })

  it('mention 强制文件优先于 BM25 结果', async () => {
    const idx = indexOf([
      file('wanted.ts', { preview: 'this file has no matching vocabulary at all' }),
      file('matched.ts', { preview: 'zephyr zephyr zephyr' })
    ])
    const mentions = parseMentions('@wanted.ts 解释一下', idx)
    const r = await buildContext(idx, mentions.cleanQuery, null, '/ws', 6000, mentions)
    expect(r.included[0]).toBe('wanted.ts')
  })

  it('@symbol 注入磁盘真实文件中符号行附近的窗口', async () => {
    const root = join(tmpdir(), `ctx-test-${Date.now()}`)
    await fs.mkdir(join(root, 'src'), { recursive: true })
    const lines = Array.from({ length: 60 }, (_, i) => `line${i + 1}`)
    lines[30] = 'function needle() { return 42 }'
    const abs = join(root, 'src', 'a.ts')
    await fs.writeFile(abs, lines.join('\n'), 'utf-8')
    const idx = indexOf([
      {
        ...file('src/a.ts', { symbols: [['needle', 'function', 31]] }),
        absPath: abs,
        preview: lines.slice(0, 5).join('\n')
      }
    ], root)
    const mentions = parseMentions('@symbol:needle', idx)
    const r = await buildContext(idx, '', null, root, 6000, mentions)
    expect(r.text).toContain('function needle()')
    expect(r.text).toContain('line6') // 符号行前 25 行（31-25=6）
    await fs.rm(root, { recursive: true, force: true })
  })
})
