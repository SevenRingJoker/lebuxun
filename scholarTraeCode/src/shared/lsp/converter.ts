// LSP ↔ Monaco 结构纯转换函数 + 文件 URI 工具。
// 输出为与 Monaco 接口形状兼容的普通对象（不 import monaco），保证 node 环境可测。
import {
  LspDiagnosticSeverity,
  LspCompletionItemKind,
  type LspPosition,
  type LspRange,
  type LspDiagnostic,
  type LspCompletionItem,
  type LspHover,
  type LspLocation,
  type LspMarkupContent
} from './types'

// ==================== 文件路径 ↔ URI ====================

/**
 * 本地绝对路径 → file URI。
 * Windows: d:\a\b.ts → file:///d:/a/b.ts；POSIX: /a/b.ts → file:///a/b.ts
 */
export function pathToUri(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  // Windows 盘符（d:）：前面补三个斜杠
  if (/^[a-zA-Z]:/.test(normalized)) {
    return `file:///${encodeURI(normalized)}`
  }
  return `file://${encodeURI(normalized)}`
}

/**
 * file URI → 本地路径（逆操作）。
 * file:///d:/a/b.ts → d:\a\b.ts（Windows）；file:///a/b.ts → /a/b.ts
 */
export function uriToPath(uri: string): string {
  let rest = uri
  if (rest.startsWith('file://')) rest = rest.slice('file://'.length)
  // Windows：file:///d:/... → 去掉前导斜杠得到 d:/...
  if (/^\/[a-zA-Z]:/.test(rest)) rest = rest.slice(1)
  const decoded = decodeURI(rest)
  // Windows 下统一用反斜杠
  if (/^[a-zA-Z]:/.test(decoded)) return decoded.replace(/\//g, '\\')
  return decoded
}

/**
 * 归一化 file URI：消除各语言服务器 URI 形式差异。
 * 例如 Volar（vscode-uri）回推 `file:///d%3A/a.ts`（编码盘符冒号），
 * 我方 pathToUri 产生 `file:///d:/a.ts`；诊断 Map 按字符串索引，
 * 不归一会导致诊断存取失配。非 file URI 原样返回。
 */
export function normalizeUri(uri: string): string {
  if (!uri.startsWith('file://')) return uri
  // 用 decodeURIComponent 而非 decodeURI：后者不还原保留字符（含冒号）的
  // 百分号形式，无法消除 Volar 的编码盘符 d%3A
  let rest = decodeURIComponent(uri.slice('file://'.length))
  // 编码盘符形式：decode 后为 /d:/...，去掉前导斜杠
  if (/^\/[a-zA-Z]:/.test(rest)) rest = rest.slice(1)
  // Windows 盘符：经 pathToUri 统一输出
  if (/^[a-zA-Z]:/.test(rest)) return pathToUri(rest)
  return `file://${rest}`
}

// ==================== 位置 / 区间 ====================

/** Monaco 位置形状（lineNumber/column 均 1-based） */
export interface MonacoLikePosition {
  lineNumber: number
  column: number
}

/** LSP 位置（0-based）→ Monaco 位置（1-based） */
export function lspPositionToMonaco(pos: LspPosition): MonacoLikePosition {
  return { lineNumber: pos.line + 1, column: pos.character + 1 }
}

/** Monaco 位置（1-based）→ LSP 位置（0-based） */
export function monacoPositionToLsp(pos: MonacoLikePosition): LspPosition {
  return { line: pos.lineNumber - 1, character: pos.column - 1 }
}

/** Monaco 区间形状（均 1-based） */
export interface MonacoLikeRange {
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
}

/** LSP 区间（0-based 半开）→ Monaco 区间（1-based 闭合） */
export function lspRangeToMonaco(range: LspRange): MonacoLikeRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1
  }
}

/** Monaco 区间 → LSP 区间 */
export function monacoRangeToLsp(range: MonacoLikeRange): LspRange {
  return {
    start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
    end: { line: range.endLineNumber - 1, character: range.endColumn - 1 }
  }
}

// ==================== 诊断 → Monaco markers ====================

/**
 * Monaco MarkerSeverity：Error=8, Warning=4, Info=2, Hint=1
 * （此处直接用数值，避免 import monaco）
 */
export const MONACO_MARKER_SEVERITY = {
  Error: 8,
  Warning: 4,
  Info: 2,
  Hint: 1
} as const

/** Monaco IMarkerData 形状（纯对象） */
export interface MonacoLikeMarkerData {
  severity: number
  message: string
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
  code?: string | number
  source?: string
}

/** LSP 严重度 → Monaco marker 严重度（缺省按 Error 处理） */
export function diagnosticSeverityToMonaco(severity?: LspDiagnosticSeverity): number {
  switch (severity) {
    case LspDiagnosticSeverity.Error:
      return MONACO_MARKER_SEVERITY.Error
    case LspDiagnosticSeverity.Warning:
      return MONACO_MARKER_SEVERITY.Warning
    case LspDiagnosticSeverity.Information:
      return MONACO_MARKER_SEVERITY.Info
    case LspDiagnosticSeverity.Hint:
      return MONACO_MARKER_SEVERITY.Hint
    default:
      return MONACO_MARKER_SEVERITY.Error
  }
}

/** LSP 诊断 → Monaco marker 数据 */
export function diagnosticToMarker(diag: LspDiagnostic): MonacoLikeMarkerData {
  const range = lspRangeToMonaco(diag.range)
  return {
    severity: diagnosticSeverityToMonaco(diag.severity),
    message: diag.message,
    startLineNumber: range.startLineNumber,
    startColumn: range.startColumn,
    endLineNumber: range.endLineNumber,
    endColumn: range.endColumn,
    code: diag.code,
    source: diag.source
  }
}

/** LSP 诊断数组 → Monaco marker 数组 */
export function diagnosticsToMarkers(diags: LspDiagnostic[]): MonacoLikeMarkerData[] {
  return diags.map(diagnosticToMarker)
}

// ==================== 补全项 ====================

/**
 * LSP CompletionItemKind → Monaco CompletionItemKind 数值映射。
 * Monaco 枚举：Method=0, Function=1, Constructor=2, Field=3, Variable=4,
 * Class=5, Struct=6, Interface=7, Module=8, Property=9, Event=10, Operator=11,
 * Unit=12, Value=13, Constant=14, Enum=15, EnumMember=16, Keyword=17, Text=18,
 * Color=19, File=20, Reference=21, Folder=23, TypeParameter=24, Snippet=27
 */
const COMPLETION_KIND_TO_MONACO: Record<number, number> = {
  [LspCompletionItemKind.Method]: 0,
  [LspCompletionItemKind.Function]: 1,
  [LspCompletionItemKind.Constructor]: 2,
  [LspCompletionItemKind.Field]: 3,
  [LspCompletionItemKind.Variable]: 4,
  [LspCompletionItemKind.Class]: 5,
  [LspCompletionItemKind.Struct]: 6,
  [LspCompletionItemKind.Interface]: 7,
  [LspCompletionItemKind.Module]: 8,
  [LspCompletionItemKind.Property]: 9,
  [LspCompletionItemKind.Event]: 10,
  [LspCompletionItemKind.Operator]: 11,
  [LspCompletionItemKind.Unit]: 12,
  [LspCompletionItemKind.Value]: 13,
  [LspCompletionItemKind.Constant]: 14,
  [LspCompletionItemKind.Enum]: 15,
  [LspCompletionItemKind.EnumMember]: 16,
  [LspCompletionItemKind.Keyword]: 17,
  [LspCompletionItemKind.Text]: 18,
  [LspCompletionItemKind.Color]: 19,
  [LspCompletionItemKind.File]: 20,
  [LspCompletionItemKind.Reference]: 21,
  [LspCompletionItemKind.Folder]: 23,
  [LspCompletionItemKind.TypeParameter]: 24,
  [LspCompletionItemKind.Snippet]: 27
}

/** Monaco 补全项形状（纯对象，insertText 原样插入） */
export interface MonacoLikeCompletionItem {
  label: string
  kind: number
  detail?: string
  documentation?: string
  insertText: string
  range?: MonacoLikeRange
}

/** LSP 补全项 → Monaco 补全项 */
export function completionItemToMonaco(item: LspCompletionItem): MonacoLikeCompletionItem {
  const result: MonacoLikeCompletionItem = {
    label: item.label,
    kind: item.kind ? (COMPLETION_KIND_TO_MONACO[item.kind] ?? 18) : 18, // 缺省 Text
    insertText: item.textEdit?.newText ?? item.insertText ?? item.label
  }
  if (item.detail) result.detail = item.detail
  if (typeof item.documentation === 'string') {
    result.documentation = item.documentation
  } else if (item.documentation?.value) {
    result.documentation = item.documentation.value
  }
  if (item.textEdit) result.range = lspRangeToMonaco(item.textEdit.range)
  return result
}

/** 归一化 completion 响应为数组（兼容数组与 CompletionList 两种形态） */
export function normalizeCompletionList(
  list: LspCompletionItem[] | { items: LspCompletionItem[] }
): LspCompletionItem[] {
  return Array.isArray(list) ? list : list.items
}

// ==================== Hover / Location ====================

/** 提取 MarkupContent/MarkedString 中的纯文本 */
export function extractMarkupText(content: LspHover['contents']): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((c) => c.value ?? '').join('\n')
  const markup = content as LspMarkupContent
  return markup.value ?? ''
}

/** LSP hover → Monaco hover（contents 纯文本 + range） */
export function hoverToMonaco(hover: LspHover): {
  contents: { value: string }
  range?: MonacoLikeRange
} {
  return {
    contents: { value: extractMarkupText(hover.contents) },
    range: hover.range ? lspRangeToMonaco(hover.range) : undefined
  }
}

/** LSP location → {path, range（Monaco 形状）}，供渲染端打开文件并跳转 */
export function locationToMonaco(loc: LspLocation): {
  uri: string
  path: string
  range: MonacoLikeRange
} {
  return {
    uri: loc.uri,
    path: uriToPath(loc.uri),
    range: lspRangeToMonaco(loc.range)
  }
}
