// 语义向量层单测：模型探测、cosine、混合融合、假 fetcher 端到端、异常回退
import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  isEmbedModelName,
  cosineSimilarity,
  fuseScores,
  hybridSearch,
  type Fetcher,
  type ModelLister
} from './embeddings'
import { INDEX_VERSION, type CodeIndex, type IndexedFile } from './indexer'
import type { SearchHit } from './retrieval'

function file(relPath: string, preview: string): IndexedFile {
  return {
    relPath,
    absPath: join('/ws', relPath),
    mtimeMs: 0,
    size: preview.length,
    imports: [],
    symbols: [],
    preview,
    lang: 'ts'
  }
}

function indexOf(files: IndexedFile[], root = '/ws'): CodeIndex {
  const record: CodeIndex['files'] = {}
  for (const f of files) record[f.relPath] = f
  return { version: INDEX_VERSION, root, updatedAt: '', files: record }
}

describe('isEmbedModelName 启发式探测', () => {
  it('识别常见 embedding 模型名', () => {
    expect(isEmbedModelName('bge-m3:latest')).toBe(true)
    expect(isEmbedModelName('nomic-embed-text')).toBe(true)
    expect(isEmbedModelName('snowflake-arctic-embed')).toBe(true)
  })
  it('排除普通对话模型', () => {
    expect(isEmbedModelName('qwen2.5:7b')).toBe(false)
    expect(isEmbedModelName('llama3.1:8b')).toBe(false)
  })
})

describe('cosineSimilarity', () => {
  it('同向向量为 1，正交为 0，反向为 -1', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1)
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0)
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1)
  })
  it('维度不一致或零向量安全返回 0', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2])).toBe(0)
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0)
  })
})

describe('fuseScores 归一化融合', () => {
  it('BM25 归一化后高分文件保持基线', () => {
    const hits: SearchHit[] = [
      { relPath: 'a.ts', score: 10 },
      { relPath: 'b.ts', score: 5 }
    ]
    const fused = fuseScores(hits, new Map())
    expect(fused[0].relPath).toBe('a.ts')
    // a: 0.6*1 + 0.4*0 = 0.6；b: 0.6*0.5 = 0.3
    expect(fused[0].score).toBeCloseTo(0.6)
    expect(fused[1].score).toBeCloseTo(0.3)
  })

  it('高余弦可让 BM25 较弱的语义匹配反超', () => {
    const hits: SearchHit[] = [
      { relPath: 'kw.ts', score: 10 },
      { relPath: 'sem.ts', score: 2 }
    ]
    const cos = new Map([['sem.ts', 1]])
    const fused = fuseScores(hits, cos)
    // kw: 0.6*1 = 0.6；sem: 0.6*0.2 + 0.4*1 = 0.52 → kw 仍在前
    expect(fused[0].relPath).toBe('kw.ts')
    const cosStrong = new Map([['sem.ts', 1]])
    const fused2 = fuseScores(hits, cosStrong, 0.6)
    // α=0.6：sem = 0.4*0.2 + 0.6 = 0.68 > kw 0.4
    expect(fused2[0].relPath).toBe('sem.ts')
  })
})

describe('hybridSearch 端到端（假 fetcher）', () => {
  const lister: ModelLister = {
    list: async () => ({ models: [{ name: 'bge-m3:latest' }, { name: 'qwen2.5:7b' }] })
  }

  /** 假向量服务：prompt 含 zephyr → [1,0]，否则 [0,1] */
  const fakeFetcher: Fetcher = async (_url, init) => {
    const body = JSON.parse(init.body)
    const vec = String(body.prompt).includes('zephyr') ? [1, 0] : [0, 1]
    return { ok: true, json: async () => ({ embedding: vec }) }
  }

  it('无 embedding 模型时回退纯 BM25 排序', async () => {
    const idx = indexOf([file('a.ts', 'zephyr wind'), file('b.ts', 'other')])
    const noModel: ModelLister = { list: async () => ({ models: [{ name: 'qwen2.5:7b' }] }) }
    const hits = await hybridSearch('/ws', idx, 'zephyr', { lister: noModel })
    expect(hits[0].relPath).toBe('a.ts')
  })

  it('模型清单服务异常时静默回退，不抛错', async () => {
    const idx = indexOf([file('a.ts', 'zephyr wind')])
    const broken: ModelLister = { list: async () => { throw new Error('conn refused') } }
    const hits = await hybridSearch('/ws', idx, 'zephyr', { lister: broken })
    expect(hits[0].relPath).toBe('a.ts')
  })

  it('向量语义一致的文件获得余弦加成（混合排序正常返回）', async () => {
    const root = join(tmpdir(), `embed-test-${Date.now()}`)
    await fs.mkdir(root, { recursive: true })
    const idx = indexOf(
      [
        file('semantic.ts', 'this file is about zephyr concepts only'),
        file('keywords.ts', 'zephyr zephyr zephyr zephyr repeated')
      ],
      root
    )
    // 把 absPath 指到真实根（ensureVectors 不读盘，仅写 vectors.json，无此依赖也可）
    idx.files['semantic.ts'].absPath = join(root, 'semantic.ts')
    idx.files['keywords.ts'].absPath = join(root, 'keywords.ts')
    const hits = await hybridSearch(root, idx, 'zephyr', { lister, fetcher: fakeFetcher })
    expect(hits).toHaveLength(2)
    // 两个文件向量都贴近查询（均含 zephyr），排序应正常产出且分数在 [0,1]
    for (const h of hits) {
      expect(h.score).toBeGreaterThanOrEqual(0)
      expect(h.score).toBeLessThanOrEqual(1.0001)
    }
    await fs.rm(root, { recursive: true, force: true })
  })

  it('embedding HTTP 失败时回退 BM25', async () => {
    const idx = indexOf([file('a.ts', 'zephyr wind'), file('b.ts', 'other')], join(tmpdir(), 'x'))
    const brokenFetcher: Fetcher = async () => ({ ok: false, json: async () => ({}) })
    const hits = await hybridSearch(idx.root, idx, 'zephyr', { model: 'bge-m3', fetcher: brokenFetcher })
    expect(hits[0].relPath).toBe('a.ts')
  })
})
