// 可选语义检索层：通过本机 Ollama /api/embeddings 生成文件向量，
// 与 BM25 关键词检索做归一化混合打分。任何环节失败（无模型/超时/维度不一致）
// 都静默回退纯 BM25，对话永不因向量层不可用而失败。
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { Ollama } from 'ollama'
import type { CodeIndex } from './indexer'
import { searchIndex, tokenize, type SearchHit, type SearchOptions } from './retrieval'

/** Ollama 默认地址（与 ollamaProvider 一致） */
const OLLAMA_URL = process.env.OLLAMA_HOST?.replace(/^tcp/, 'http') || 'http://127.0.0.1:11434'
/** 单次 embedding 请求超时 */
const EMBED_TIMEOUT_MS = 10_000
/** 每次查询最多新算多少个文件向量（其余沿用 BM25，避免首轮上千次请求） */
const MAX_EMBED_BATCH = 80
/** 单文件送 embed 的文本上限（路径+符号+预览截断） */
const MAX_EMBED_CHARS = 2000
/** 向量持久化结构版本 */
const VECTORS_VERSION = 1
/** 混合权重：最终分 = (1-α)×归一化BM25 + α×cosine（无向量文件余弦按 0 计） */
const ALPHA = 0.4

/** 向量存储结构 */
export interface VectorStore {
  version: number
  /** 生成向量所用模型；模型切换后旧向量作废重建 */
  model: string
  /** 向量维度，校验用 */
  dim: number
  /** relPath → 向量 */
  vectors: Record<string, number[]>
}

/** 注入式 HTTP 调用签名（单测传假实现；默认走全局 fetch） */
export type Fetcher = (url: string, init: { method: string; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean
  json: () => Promise<any>
}>

/** 模型清单条目（注入检测用） */
export interface ModelLister {
  list(): Promise<{ models: Array<{ name: string }> }>
}

/** 名称启发式识别 embedding 类模型（bge/nomic/e5/gte/embed 等） */
export function isEmbedModelName(name: string): boolean {
  return /(bge|nomic|e5-|gte|embed|m3-embed|jina|snowflake-arctic)/i.test(name)
}

/**
 * 探测本机可用的 embedding 模型。
 * @param lister 可注入的模型清单客户端（默认 Ollama）
 * @returns 模型名；无可用模型或服务不可达时返回 null
 */
export async function detectEmbedModel(lister?: ModelLister): Promise<string | null> {
  try {
    const client = lister ?? new Ollama()
    const res = await client.list()
    const found = res.models
      .map((m) => m.name)
      .find((n) => isEmbedModelName(n))
    return found ?? null
  } catch {
    return null
  }
}

/** 余弦相似度（输入为等长数值向量；维度不一致或零向量返回 0） */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/**
 * 纯函数：BM25 分与余弦分归一化融合。
 * BM25 除以最大分映射到 [0,1]；cosine 截断到 [0,1]；
 * 无向量的文件余弦按 0（仍可凭 BM25 入选）。
 */
export function fuseScores(
  hits: SearchHit[],
  cosineByRel: Map<string, number>,
  alpha = ALPHA
): SearchHit[] {
  const maxBm25 = hits.reduce((mx, h) => Math.max(mx, h.score), 0) || 1
  return hits
    .map((h) => {
      const normBm25 = Math.max(0, h.score) / maxBm25
      const cos = Math.max(0, Math.min(1, cosineByRel.get(h.relPath) ?? 0))
      return { ...h, score: (1 - alpha) * normBm25 + alpha * cos, bm25: h.score }
    })
    .sort((a, b) => b.score - a.score || a.relPath.localeCompare(b.relPath))
}

/** 调用 Ollama embeddings 接口（单条文本） */
async function embedOne(text: string, model: string, fetcher: Fetcher): Promise<number[]> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), EMBED_TIMEOUT_MS)
  try {
    const res = await fetcher(`${OLLAMA_URL}/api/embeddings`, {
      method: 'POST',
      body: JSON.stringify({ model, prompt: text.slice(0, MAX_EMBED_CHARS) }),
      signal: ctrl.signal
    })
    if (!res.ok) throw new Error('embeddings http error')
    const data = await res.json()
    if (!Array.isArray(data.embedding)) throw new Error('embedding payload invalid')
    return data.embedding
  } finally {
    clearTimeout(timer)
  }
}

/** 向量文件路径 */
function vectorsPath(root: string): string {
  return join(root, '.trae', 'code-vectors.json')
}

/** 加载向量库；损坏/版本不符/模型不符返回 null（调用方按重建处理） */
async function loadVectors(root: string, model: string): Promise<VectorStore | null> {
  try {
    const raw = await fs.readFile(vectorsPath(root), 'utf-8')
    const parsed = JSON.parse(raw) as VectorStore
    if (parsed.version !== VECTORS_VERSION || parsed.model !== model || !parsed.vectors) return null
    return parsed
  } catch {
    return null
  }
}

/** 文件送入 embed 的文本：路径 + 符号名 + 预览 */
function embedTextOf(rel: string, index: CodeIndex): string {
  const e = index.files[rel]
  if (!e) return rel
  return `${rel}\n${e.symbols.map((s) => s.name).join(' ')}\n${e.preview}`.slice(0, MAX_EMBED_CHARS)
}

/**
 * 确保向量库就绪：缺失文件分批补算（每轮最多 MAX_EMBED_BATCH 个），
 * 被删除/失效文件剔除，最后持久化。
 * @returns 最新向量库；任何 IO/模型错误向上抛出由调用方决定降级
 */
export async function ensureVectors(
  root: string,
  index: CodeIndex,
  model: string,
  fetcher: Fetcher = fetch as unknown as Fetcher
): Promise<VectorStore> {
  const store = (await loadVectors(root, model)) ?? { version: VECTORS_VERSION, model, dim: 0, vectors: {} }
  const rels = Object.keys(index.files)
  // 剔除磁盘索引已不存在的条目
  for (const rel of Object.keys(store.vectors)) {
    if (!index.files[rel]) delete store.vectors[rel]
  }
  const missing = rels.filter((r) => !store.vectors[r]).slice(0, MAX_EMBED_BATCH)
  for (const rel of missing) {
    const vec = await embedOne(embedTextOf(rel, index), model, fetcher)
    if (vec.length > 0) {
      if (!store.dim) store.dim = vec.length
      if (vec.length === store.dim) store.vectors[rel] = vec
    }
  }
  try {
    await fs.mkdir(join(root, '.trae'), { recursive: true })
    await fs.writeFile(vectorsPath(root), JSON.stringify(store), 'utf-8')
  } catch {
    // 落盘失败不影响本轮内存使用
  }
  return store
}

export interface HybridOptions extends SearchOptions {
  /** 强制使用的模型（默认自动探测） */
  model?: string | null
  /** 注入 fetcher（测试用） */
  fetcher?: Fetcher
  /** 注入模型清单（测试用） */
  lister?: ModelLister
}

/**
 * 混合检索：BM25 全量打分 + 已就绪文件向量的余弦相似度融合。
 * embedding 模型不存在、补算失败、超时时，返回纯 BM25 结果。
 */
export async function hybridSearch(
  root: string,
  index: CodeIndex,
  query: string,
  opts: HybridOptions = {}
): Promise<SearchHit[]> {
  const bm25Hits = searchIndex(index, query, {
    currentRel: opts.currentRel,
    limit: opts.limit ? Math.max(opts.limit * 3, 30) : undefined
  })
  if (bm25Hits.length === 0) return []

  try {
    const model = opts.model === undefined ? await detectEmbedModel(opts.lister) : opts.model
    if (!model) return opts.limit ? bm25Hits.slice(0, opts.limit) : bm25Hits
    const fetcher = opts.fetcher ?? (fetch as unknown as Fetcher)
    const store = await ensureVectors(root, index, model, fetcher)
    const qvec = await embedOne(query, model, fetcher)
    const cosineByRel = new Map<string, number>()
    for (const rel of Object.keys(store.vectors)) {
      cosineByRel.set(rel, cosineSimilarity(qvec, store.vectors[rel]))
    }
    const fused = fuseScores(bm25Hits, cosineByRel)
    return opts.limit ? fused.slice(0, opts.limit) : fused
  } catch {
    return opts.limit ? bm25Hits.slice(0, opts.limit) : bm25Hits
  }
}

/** 便捷入口：查询词项（供上层判断 query 是否为空等） */
export function queryTokens(query: string): string[] {
  return tokenize(query)
}
