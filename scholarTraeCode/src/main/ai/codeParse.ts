// 代码解析纯函数层：单文件的 import / 符号 / 预览抽取。
// 不做任何磁盘 IO，输入路径+内容，输出结构化解析结果，便于单测与增量索引复用。
import { extname } from 'node:path'

/** 源码扩展名白名单，避免把图片/二进制/依赖目录纳入索引 */
export const SOURCE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.json',
  '.py', '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.go', '.rs',
  '.php', '.rb', '.kt', '.swift', '.sql', '.sh', '.bash', '.zsh',
  '.yml', '.yaml', '.toml', '.ini', '.xml', '.md', '.html', '.css', '.scss'
])

/** 索引时跳过的目录：依赖、构建产物、IDE 配置，以及本应用自身的 .trae 数据目录 */
export const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'out', 'build', 'release',
  '.idea', '.vscode', '.trae'
])

/** 单文件预览保留的最大行数（与历史行为一致，控制索引体积） */
export const PREVIEW_LINES = 80

/** 符号类别（供检索加权与前端展示） */
export type SymbolKind = 'function' | 'class' | 'interface' | 'type' | 'enum' | 'const'

/** 抽取出的符号定义 */
export interface CodeSymbol {
  /** 符号名 */
  name: string
  /** 符号类别 */
  kind: SymbolKind
  /** 1 起始行号 */
  line: number
}

/** 单文件解析结果（不含磁盘元信息） */
export interface ParsedFile {
  /** 该文件 import/require 的目标（原始说明符或 Python 模块名） */
  imports: string[]
  /** 导出/定义的符号 */
  symbols: CodeSymbol[]
  /** 文件内容预览（前 PREVIEW_LINES 行），用于相关性打分与注入 */
  preview: string
  /** 内容字符数 */
  size: number
  /** 语言标识（扩展名去掉点，小写） */
  lang: string
}

/** 从文件内容中抽取 import 目标（支持 ES import / require / Python import） */
export function extractImports(content: string, ext: string): string[] {
  const imports = new Set<string>()
  if (ext === '.py') {
    const re = /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.,\s]+))/gm
    for (const m of content.matchAll(re)) {
      const target = (m[1] || m[2] || '').trim()
      if (target) imports.add(target.split(/[,\s]/)[0])
    }
  } else {
    // ES import / require / 动态 import
    const re = /(?:import\s+(?:[\w*{},\s]+\s+from\s+)?|require\s*\(\s*|import\s*\(\s*)["'`]([^"'`]+)["'`]/g
    for (const m of content.matchAll(re)) {
      if (m[1]) imports.add(m[1])
    }
  }
  return [...imports]
}

/** 计算字符偏移所在的 1 起始行号 */
function lineAt(content: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < content.length; i++) {
    if (content.charCodeAt(i) === 10) line++
  }
  return line
}

/** 抽取符号定义（带类别与行号）：JS 家族 export/function/class/const/interface/type/enum；Python def/class */
export function extractSymbolDefs(content: string, ext: string): CodeSymbol[] {
  const symbols: CodeSymbol[] = []
  const seen = new Set<string>()
  const push = (name: string, kind: SymbolKind, line: number): void => {
    // 同名同类别去重（重载/重复声明只保留首次位置）
    const key = `${kind}:${name}`
    if (name && !seen.has(key)) {
      seen.add(key)
      symbols.push({ name, kind, line })
    }
  }
  if (ext === '.py') {
    const re = /^[ \t]*(?:async\s+)?def\s+(\w+)|^[ \t]*class\s+(\w+)/gm
    for (const m of content.matchAll(re)) {
      const idx = m.index ?? 0
      if (m[1]) push(m[1], 'function', lineAt(content, idx))
      if (m[2]) push(m[2], 'class', lineAt(content, idx))
    }
  } else {
    const re = /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?(function|class|interface|type|enum|const|let|var)\s+(\w+)/g
    for (const m of content.matchAll(re)) {
      const raw = (m[1] || '').toLowerCase()
      const kind: SymbolKind =
        raw === 'let' || raw === 'var' ? 'const' : (raw as SymbolKind)
      push(m[2], kind, lineAt(content, m.index ?? 0))
    }
  }
  return symbols
}

/**
 * 解析单个文件内容。
 * @param relPath 相对工作区根的路径（正斜杠），用于推断语言
 * @param content 文件 UTF-8 文本
 */
export function parseFileContent(relPath: string, content: string): ParsedFile {
  const ext = extname(relPath).toLowerCase()
  const lines = content.split(/\r?\n/)
  return {
    imports: extractImports(content, ext),
    symbols: extractSymbolDefs(content, ext),
    preview: lines.slice(0, PREVIEW_LINES).join('\n'),
    size: content.length,
    lang: ext ? ext.slice(1) : ''
  }
}
