// s42 符号级代码导航纯函数层：
// 在 code-index 既有资产之上落地「定义 → 引用」图谱——
// 定义取自索引的符号表（extractSymbolDefs 抽取），引用用 ripgrep 词边界搜索全仓，
// 二者分离后产出「定义清单 + 引用清单」，供 find_references/symbol_outline 工具
// 与调度器的改动影响提醒（符号被删仍有引用）复用。
// 本层只做纯数据加工与一次内容搜索调用，零 Electron 依赖，可确定性单测。
import { extname, relative, sep } from 'node:path'
import { runContentSearch } from '../search/searchEngine'
import { extractSymbolDefs } from './codeParse'
import type { CodeIndex, IndexedFile } from './indexer'

/** 单处符号定义（索引侧） */
export interface SymbolDef {
  name: string
  kind: string
  /** 相对工作区根路径（正斜杠） */
  path: string
  line: number
}

/** 单处引用（grep 侧） */
export interface SymbolRef {
  /** 相对工作区根路径（正斜杠） */
  path: string
  line: number
  /** 命中行预览（截断） */
  preview: string
}

/** 转义正则元字符 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 构造符号引用的词边界正则（\b 口径，避免子串误报） */
export function symbolPattern(name: string): string {
  return `\\b${escapeRegExp(name)}\\b`
}

/**
 * 从索引中收集某符号的全部定义位置（跨文件）。
 * 同名符号可能定义在多处（不同模块各自导出），全部列出。
 */
export function collectSymbolDefs(index: CodeIndex | null, name: string): SymbolDef[] {
  if (!index || !name) return []
  const defs: SymbolDef[] = []
  for (const [rel, file] of Object.entries(index.files)) {
    for (const s of file.symbols) {
      if (s.name === name) {
        defs.push({ name: s.name, kind: s.kind, path: rel, line: s.line })
      }
    }
  }
  return defs
}

/**
 * 把 grep 命中与定义清单分离：
 * 命中行与某定义同文件同行 → 视为定义本身，不计入引用；其余为引用。
 * grep 行号与索引行号同口径（1 起始）。
 */
export function splitDefsAndRefs(
  defs: SymbolDef[],
  grepMatches: Array<{ path: string; lineNumber: number; preview: string }>
): { defs: SymbolDef[]; refs: SymbolRef[] } {
  const defKeys = new Set(defs.map((d) => `${d.path}:${d.line}`))
  const refs: SymbolRef[] = []
  for (const m of grepMatches) {
    const rel = m.path.replace(/\\/g, '/')
    if (defKeys.has(`${rel}:${m.lineNumber}`)) continue
    refs.push({ path: rel, line: m.lineNumber, preview: m.preview.trim().slice(0, 160) })
  }
  return { defs, refs }
}

/**
 * 全仓查找符号引用：ripgrep 词边界搜索，与定义分离。
 * @param root 工作区根（绝对路径）
 * @param index 代码索引（定义清单来源；可为 null，此时仅有引用清单）
 * @param symbol 符号名
 */
export async function findReferences(
  root: string,
  index: CodeIndex | null,
  symbol: string
): Promise<{ defs: SymbolDef[]; refs: SymbolRef[] }> {
  const defs = collectSymbolDefs(index, symbol)
  let matches: Array<{ path: string; lineNumber: number; preview: string }> = []
  try {
    const search = await runContentSearch(root, {
      query: symbolPattern(symbol),
      caseSensitive: true,
      wholeWord: false,
      regexMode: true,
      includes: [],
      excludes: []
    })
    for (const g of search.groups) {
      const rel = relative(root, g.path).split(sep).join('/')
      for (const m of g.matches) {
        matches.push({ path: rel, lineNumber: m.lineNumber, preview: m.preview })
      }
    }
  } catch {
    // rg 不可用时退化为「只有定义清单」，不抛错阻断 Agent
  }
  return splitDefsAndRefs(defs, matches)
}

/** 引用报告格式化（中文，供工具结果直接回填模型） */
export function formatReferenceReport(
  symbol: string,
  defs: SymbolDef[],
  refs: SymbolRef[],
  limit = 30
): string {
  const parts: string[] = []
  if (defs.length === 0) {
    parts.push(`符号 ${symbol}：索引中未找到定义（可能是外部依赖或动态生成）。`)
  } else {
    parts.push(
      `符号 ${symbol} 定义（${defs.length} 处）：\n` +
        defs.map((d) => `- ${d.path}:${d.line}（${d.kind}）`).join('\n')
    )
  }
  if (refs.length > 0) {
    const shown = refs.slice(0, limit)
    parts.push(
      `引用（${refs.length} 处${refs.length > limit ? `，仅列前 ${limit}` : ''}）：\n` +
        shown.map((r) => `- ${r.path}:${r.line}: ${r.preview}`).join('\n')
    )
  } else {
    parts.push('引用：工作区内未发现其他引用。')
  }
  return parts.join('\n')
}

/** 单文件符号大纲（symbol_outline 工具输出） */
export function symbolOutline(index: CodeIndex | null, relPath: string): string {
  const file: IndexedFile | undefined = index?.files[relPath.replace(/\\/g, '/')]
  if (!file) return `未在索引中找到文件：${relPath}（索引可能未覆盖该文件，可先重新打开工作区触发索引）`
  if (file.symbols.length === 0) return `${relPath}：未抽取到符号定义（空文件或无可识别结构）。`
  return (
    `${relPath} 符号大纲（${file.symbols.length} 个）：\n` +
    file.symbols.map((s) => `- L${s.line} [${s.kind}] ${s.name}`).join('\n')
  )
}

/** 改动影响提醒的一条发现 */
export interface EditImpact {
  /** 被删除的符号名 */
  symbol: string
  /** 工作区内仍存在的引用处数（含其他文件） */
  refCount: number
}

/**
 * 改动影响分析（调度器 edit/write 成功后调用）：
 * 对比旧/新内容的符号定义，找出「被删除的符号」；
 * 每个被删符号在磁盘全文中做词边界 grep，统计残余引用。
 * @param oldContent 改动前磁盘内容（执行前抓取）
 * @param newContent 改动后内容
 * @param relPath 被改文件相对路径（引用统计时排除本文件，避免把残留旧行算入——edit 已完成）
 * @param grepCount 异步计数回调（注入便于单测；生产实现走 runContentSearch）
 */
export async function buildEditImpact(
  oldContent: string,
  newContent: string,
  relPath: string,
  grepCount: (symbol: string) => Promise<number>
): Promise<EditImpact[]> {
  const ext = extname(relPath).toLowerCase()
  const before = extractSymbolDefs(oldContent, ext)
  const after = new Set(extractSymbolDefs(newContent, ext).map((s) => `${s.kind}:${s.name}`))
  const impacts: EditImpact[] = []
  for (const s of before) {
    if (after.has(`${s.kind}:${s.name}`)) continue
    const count = await grepCount(s.name)
    if (count > 0) impacts.push({ symbol: s.name, refCount: count })
  }
  return impacts
}

/** 影响提醒文本：追加到工具结果尾部，无影响返回空串 */
export function formatEditImpact(impacts: EditImpact[]): string {
  if (impacts.length === 0) return ''
  return (
    '\n\n⚠ 改动影响提醒：以下符号在本次改动中被删除，但工作区内仍有引用——请确认这些引用是否需要同步更新：\n' +
    impacts.map((i) => `- 符号 ${i.symbol} 被删除，仍有 ${i.refCount} 处引用`).join('\n')
  )
}
