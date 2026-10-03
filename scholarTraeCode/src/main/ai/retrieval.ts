// 检索层：在持久化索引上做相关性打分与上下文拼装。
// 打分模型：BM25（英文标识符词 + 中文相邻二元组）+ import 双向邻接 + 符号精确命中。
// 另提供 @file / @symbol:名称 / @codebase 显式引用解析，让用户可精确控制注入。
import { promises as fs } from 'node:fs'
import { basename, relative, sep } from 'node:path'
import type { CodeIndex, IndexedFile } from './indexer'

/** BM25 参数（经验值，短文档代码库常用配置） */
const BM25_K1 = 1.5
const BM25_B = 0.75
/** 默认注入预算（字符），与历史上下文注入保持一致 */
export const DEFAULT_MAX_CHARS = 6000
/** @codebase 显式全库检索时的预算倍数 */
const CODEBASE_BUDGET_X = 2
/** 符号引用时截取符号行前后各多少行 */
const SYMBOL_CONTEXT_LINES = 25

/** 词项频次表 */
type TermFreq = Map<string, number>

/**
 * CJK 感知分词：
 * - 拉丁/标识符：[a-z_][a-z0-9_]*（小写化）
 * - 中日韩连续字符：相邻二元组（单字退化为单字），保证中文查询在英文为主的代码库也能命中
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  const lower = text.toLowerCase()
  const latinRe = /[a-z_][a-z0-9_]*/g
  let m: RegExpExecArray | null
  while ((m = latinRe.exec(lower)) !== null) {
    tokens.push(m[0])
  }
  const cjkRe = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g
  while ((m = cjkRe.exec(text)) !== null) {
    const run = m[0]
    if (run.length === 1) {
      tokens.push(run)
    } else {
      for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2))
    }
  }
  return tokens
}

/** 统计词项频次 */
function termFreq(tokens: string[]): TermFreq {
  const tf: TermFreq = new Map()
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
  return tf
}

/** 单文件的检索文档：路径出现 2 次加权、符号名、预览正文 */
function documentText(entry: IndexedFile): string {
  const symbolNames = entry.symbols.map((s) => s.name).join(' ')
  return `${entry.relPath}\n${entry.relPath}\n${symbolNames}\n${entry.preview}`
}

/** 集合级统计，一次构建供多查询复用（BM25 的 df / 平均文档长度） */
export interface CollectionStats {
  n: number
  avgLen: number
  df: Map<string, number>
  docTf: Map<string, TermFreq>
  docLen: Map<string, number>
}

/** 从索引构建集合统计 */
export function buildCollection(index: CodeIndex): CollectionStats {
  const entries = Object.values(index.files)
  const df = new Map<string, number>()
  const docTf = new Map<string, TermFreq>()
  const docLen = new Map<string, number>()
  let totalLen = 0
  for (const e of entries) {
    const tokens = tokenize(documentText(e))
    const tf = termFreq(tokens)
    docTf.set(e.relPath, tf)
    docLen.set(e.relPath, tokens.length)
    totalLen += tokens.length
    for (const term of tf.keys()) df.set(term, (df.get(term) ?? 0) + 1)
  }
  return { n: entries.length, avgLen: entries.length ? totalLen / entries.length : 0, df, docTf, docLen }
}

/** BM25 单文档打分（IDF 取非负变体） */
function bm25Score(stats: CollectionStats, relPath: string, queryTerms: string[]): number {
  const tf = stats.docTf.get(relPath)
  if (!tf) return 0
  const len = stats.docLen.get(relPath) ?? 0
  let score = 0
  for (const q of queryTerms) {
    const f = tf.get(q) ?? 0
    if (!f) continue
    const df = stats.df.get(q) ?? 0
    const idf = Math.log(1 + (stats.n - df + 0.5) / (df + 0.5))
    const norm = (f * (BM25_K1 + 1)) / (f + BM25_K1 * (1 - BM25_B + BM25_B * (len / (stats.avgLen || 1))))
    score += idf * norm
  }
  return score
}

/**
 * 把 import 说明符解析成索引内的 relPath 候选。
 * 代码里的 import 多为 './x'、'@/a/b'、'pkg' 形式，这里用后缀包含做启发式对齐。
 */
function resolveImport(spec: string, allRels: string[], importer?: IndexedFile): string | null {
  const norm = spec.replace(/^\.\//, '').replace(/^@\//, '').replace(/\\/g, '/').replace(/^[a-z]+:/, '')
  const withExt = [norm, `${norm}.ts`, `${norm}.tsx`, `${norm}.js`, `${norm}.vue`, `${norm}/index.ts`, `${norm}/index.js`]
  // 以 importer 所在目录解析相对路径
  const baseDir = importer ? importer.relPath.split('/').slice(0, -1).join('/') : ''
  if (spec.startsWith('.')) {
    const resolved = baseDir ? `${baseDir}/${norm}`.replace(/\/\.\//g, '/') : norm
    withExt.push(resolved, ...['.ts', '.tsx', '.js', '.vue', '/index.ts'].map((e) => resolved + e))
  }
  for (const cand of withExt) {
    const hit = allRels.find((r) => r === cand || r.endsWith(`/${cand}`))
    if (hit) return hit
  }
  // 兜底：说明符末段与路径末段匹配
  const tail = norm.split('/').filter(Boolean).pop()
  if (tail && tail.length > 2) {
    const hit = allRels.find((r) => basename(r).replace(/\.[^.]+$/, '') === tail)
    if (hit) return hit
  }
  return null
}

/** 检索结果条目 */
export interface SearchHit {
  relPath: string
  score: number
  /** 命中的符号名（符号精确命中时返回） */
  symbol?: string
  symbolLine?: number
  /** 混合检索时保留的原始 BM25 分（调试/展示用） */
  bm25?: number
}

/** 检索参数 */
export interface SearchOptions {
  /** 当前打开文件（import 邻接加权用） */
  currentRel?: string | null
  /** 返回条数上限 */
  limit?: number
  /** BM25 之外的附加分（如向量混合分由 embeddings 层注入） */
  extraScores?: Map<string, number>
}

/**
 * 核心检索：BM25 + 依赖邻接 + 符号命中。
 * 返回按总分降序、分数 > 0 的命中；currentRel 自身降权（用户正在看）。
 */
export function searchIndex(index: CodeIndex, query: string, opts: SearchOptions = {}): SearchHit[] {
  const entries = Object.values(index.files)
  if (entries.length === 0) return []
  const stats = buildCollection(index)
  const queryTerms = tokenize(query)
  const queryLower = query.toLowerCase()
  const allRels = entries.map((e) => e.relPath)
  const currentEntry = opts.currentRel ? index.files[opts.currentRel] : undefined

  // 预构建反向依赖：谁 import 了谁
  const forwardEdges = new Map<string, Set<string>>()
  const reverseEdges = new Map<string, Set<string>>()
  for (const e of entries) {
    for (const spec of e.imports) {
      const target = resolveImport(spec, allRels, e)
      if (!target || target === e.relPath) continue
      if (!forwardEdges.has(e.relPath)) forwardEdges.set(e.relPath, new Set())
      forwardEdges.get(e.relPath)!.add(target)
      if (!reverseEdges.has(target)) reverseEdges.set(target, new Set())
      reverseEdges.get(target)!.add(e.relPath)
    }
  }

  const neighbors = currentEntry ? forwardEdges.get(currentEntry.relPath) : undefined
  const reverse = currentEntry ? reverseEdges.get(currentEntry.relPath) : undefined

  const hits: SearchHit[] = []
  for (const e of entries) {
    let score = bm25Score(stats, e.relPath, queryTerms)
    // 当前文件 import 了它 → 强相关；它 import 了当前文件 → 次强
    if (neighbors?.has(e.relPath)) score += 6
    if (reverse?.has(e.relPath)) score += 4
    // 符号名被问题直接提及
    for (const s of e.symbols) {
      if (s.name.length >= 2 && queryLower.includes(s.name.toLowerCase())) {
        score += 3
        if (!hits.some((h) => h.relPath === e.relPath)) {
          hits.push({ relPath: e.relPath, score, symbol: s.name, symbolLine: s.line })
        }
        break
      }
    }
    if (opts.extraScores?.has(e.relPath)) score += opts.extraScores.get(e.relPath)!
    // 当前文件自身降权
    if (opts.currentRel && e.relPath === opts.currentRel) score -= 100
    const existing = hits.find((h) => h.relPath === e.relPath)
    if (existing) {
      existing.score = score
    } else if (score > 0) {
      hits.push({ relPath: e.relPath, score })
    }
  }
  hits.sort((a, b) => b.score - a.score || a.relPath.localeCompare(b.relPath))
  return (opts.limit ? hits.slice(0, opts.limit) : hits).filter((h) => h.score > 0)
}

// ---------------- @ 显式引用 ----------------

/** 解析后的引用结果 */
export interface ParsedMentions {
  /** 去掉已解析 mention 后的纯净查询（未解析的 mention 保留原文，避免丢意图） */
  cleanQuery: string
  /** 强制注入的文件 relPath（去重保序） */
  files: string[]
  /** 强制定位的符号名 */
  symbols: string[]
  /** 是否出现 @codebase（扩大检索预算） */
  codebase: boolean
}

/** mention 匹配细节（内部用） */
interface MentionMatch {
  raw: string
  start: number
  end: number
  file?: string
  symbol?: string
  codebase?: boolean
}

/** 文件引用打分：完全一致 > 文件名一致 > 路径子串；并列取路径更短者 */
function matchFile(token: string, index: CodeIndex): string | null {
  const t = token.replace(/\\/g, '/').toLowerCase()
  const scored = Object.keys(index.files)
    .map((rel) => {
      const r = rel.toLowerCase()
      const base = basename(r)
      let s = 0
      if (r === t) s = 100
      else if (base === t) s = 60
      else if (r.includes(t)) s = 20 + t.length / r.length
      else if (base.includes(t)) s = 10 + t.length / base.length
      return { rel, s }
    })
    .filter((x) => x.s > 0)
  if (scored.length === 0) return null
  scored.sort((a, b) => b.s - a.s || a.rel.length - b.rel.length)
  return scored[0].rel
}

/** 按符号名找文件：唯一直接返回；重名时按与 query 的 BM25 相关性取最优 */
function matchSymbol(name: string, index: CodeIndex, contextQuery: string): { rel: string; line: number } | null {
  const lower = name.toLowerCase()
  const owners = Object.values(index.files)
    .flatMap((e) => e.symbols.filter((s) => s.name.toLowerCase() === lower).map((s) => ({ rel: e.relPath, line: s.line })))
  if (owners.length === 0) return null
  if (owners.length === 1) return owners[0]
  const ranked = searchIndex(index, contextQuery, { limit: owners.length })
  for (const h of ranked) {
    const owner = owners.find((o) => o.rel === h.relPath)
    if (owner) return owner
  }
  return owners[0]
}

const MENTION_RE = /(^|[^\w@])@([A-Za-z0-9_./\\:一-鿿]+)/g

/**
 * 从用户输入解析 @ 引用：
 * - @codebase：标记全库加预算
 * - @symbol:名称：按符号定位文件
 * - 含 / 或 . 的 token：按文件路径/文件名匹配
 * - 其余裸 token：先试文件名，再试符号名
 * 解析成功的片段从 cleanQuery 剥离；失败的保留原文。
 */
export function parseMentions(text: string, index: CodeIndex | null): ParsedMentions {
  const result: ParsedMentions = { cleanQuery: text, files: [], symbols: [], codebase: false }
  if (!index) return result
  const matches: MentionMatch[] = []
  let m: RegExpExecArray | null
  MENTION_RE.lastIndex = 0
  while ((m = MENTION_RE.exec(text)) !== null) {
    const prefix = m[1]
    const token = m[2]
    const start = m.index + prefix.length
    const end = start + 1 + token.length // 含 @
    const raw = text.slice(start, end)
    if (token === 'codebase') {
      matches.push({ raw, start, end, codebase: true })
      continue
    }
    if (/^symbol:/i.test(token)) {
      const name = token.slice('symbol:'.length)
      if (name) {
        const hit = matchSymbol(name, index, text.replace(raw, ' '))
        if (hit) matches.push({ raw, start, end, file: hit.rel, symbol: name })
      }
      continue
    }
    if (/[/.\\]/.test(token)) {
      const file = matchFile(token, index)
      if (file) matches.push({ raw, start, end, file })
      continue
    }
    // 裸 token：先文件后符号
    const file = matchFile(token, index)
    if (file) {
      matches.push({ raw, start, end, file })
    } else {
      const hit = matchSymbol(token, index, text.replace(raw, ' '))
      if (hit) matches.push({ raw, start, end, file: hit.rel, symbol: token })
    }
  }

  if (matches.length === 0) return result
  // 从后往前替换，偏移不失效
  let clean = text
  for (let i = matches.length - 1; i >= 0; i--) {
    clean = clean.slice(0, matches[i].start) + ' ' + clean.slice(matches[i].end)
  }
  result.cleanQuery = clean.replace(/\s+/g, ' ').trim()
  for (const mt of matches) {
    if (mt.codebase) result.codebase = true
    if (mt.file && !result.files.includes(mt.file)) result.files.push(mt.file)
    if (mt.symbol && !result.symbols.includes(mt.symbol)) result.symbols.push(mt.symbol)
  }
  return result
}

// ---------------- 上下文拼装 ----------------

/** 读文件指定行窗口（1 起始，包含两端）；失败回退预览 */
async function readLines(absPath: string, start: number, end: number, fallback: string): Promise<string> {
  try {
    const content = await fs.readFile(absPath, 'utf-8')
    const lines = content.split(/\r?\n/)
    const s = Math.max(1, start)
    return lines.slice(s - 1, end).join('\n')
  } catch {
    return fallback
  }
}

export interface BuildContextResult {
  text: string
  /** 实际注入的文件 relPath（按顺序） */
  included: string[]
}

/**
 * 组装注入模型的上下文文本：
 * 1) mention 指定文件强制注入全文（预算内）；@symbol 定位到符号行附近窗口
 * 2) 其余预算用 BM25 检索结果的预览填充
 */
export async function buildContext(
  index: CodeIndex,
  query: string,
  currentFile: string | null,
  root?: string,
  maxChars: number = DEFAULT_MAX_CHARS,
  mentions: ParsedMentions | null = null,
  /** 预计算命中（embeddings 混合检索注入）；不传则内部走纯 BM25 */
  precomputedHits?: SearchHit[]
): Promise<BuildContextResult> {
  const currentRel =
    currentFile && root ? relative(root, currentFile).split(sep).join('/') : null
  const budget0 = mentions?.codebase ? maxChars * CODEBASE_BUDGET_X : maxChars
  let budget = budget0
  const parts: string[] = []
  const included: string[] = []

  const pushChunk = (header: string, body: string): boolean => {
    const chunk = `// === ${header} ===\n${body}\n`
    if (chunk.length > budget) {
      // 单块过大仍按剩余预算截断（mention 强制文件至少给一部分）
      if (parts.length === 0 || budget > 400) {
        parts.push(chunk.slice(0, Math.max(0, budget)))
        budget = 0
        return true
      }
      return false
    }
    parts.push(chunk)
    budget -= chunk.length
    return true
  }

  // 1) 显式引用优先
  if (mentions) {
    for (const rel of mentions.files) {
      const entry = index.files[rel]
      if (!entry || included.includes(rel)) continue
      let body: string
      if (mentions.symbols.length > 0) {
        const sym = entry.symbols.find((s) => mentions.symbols.includes(s.name))
        body = sym
          ? await readLines(entry.absPath, sym.line - SYMBOL_CONTEXT_LINES, sym.line + SYMBOL_CONTEXT_LINES, entry.preview)
          : entry.preview
      } else {
        body = await readLines(entry.absPath, 1, 400, entry.preview)
      }
      if (pushChunk(rel, body)) included.push(rel)
      if (budget <= 0) break
    }
  }

  // 2) 相关性检索补位（跳过已注入与当前文件）
  if (budget > 0 && query.trim()) {
    const hits = precomputedHits ?? searchIndex(index, mentions?.cleanQuery ?? query, { currentRel })
    for (const hit of hits) {
      if (budget <= 0) break
      if (included.includes(hit.relPath) || hit.relPath === currentRel) continue
      const entry = index.files[hit.relPath]
      if (!entry) continue
      if (pushChunk(hit.relPath, entry.preview)) included.push(hit.relPath)
    }
  }

  return { text: parts.join('\n'), included }
}

/**
 * 兼容旧签名的同步封装：无 mention、用预览而非读盘。
 * 供 context.ts re-export；新代码应直接使用 buildContext。
 */
export function selectContext(
  index: CodeIndex,
  query: string,
  currentFile: string | null,
  maxChars: number = DEFAULT_MAX_CHARS,
  root?: string
): string {
  const currentRel =
    currentFile && root ? relative(root, currentFile).split(sep).join('/') : null
  const hits = searchIndex(index, query, { currentRel })
  let budget = maxChars
  const parts: string[] = []
  for (const hit of hits) {
    const entry = index.files[hit.relPath]
    if (!entry) continue
    const chunk = `// === ${hit.relPath} ===\n${entry.preview}\n`
    if (chunk.length > budget) continue
    parts.push(chunk)
    budget -= chunk.length
  }
  return parts.join('\n')
}
