// LSP（Language Server Protocol）最小类型集合：只声明本项目实际使用的结构。
// 零依赖、零 DOM/Electron 引用，可直接在 vitest（node 环境）下测试。

/** LSP 位置：line/character 均为 0-based */
export interface LspPosition {
  line: number
  character: number
}

/** LSP 区间：start/end 均为 0-based 半开区间 */
export interface LspRange {
  start: LspPosition
  end: LspPosition
}

/** 诊断严重度（LSP 1=Error ... 4=Hint） */
export enum LspDiagnosticSeverity {
  Error = 1,
  Warning = 2,
  Information = 3,
  Hint = 4
}

/** 单条诊断（textDocument/publishDiagnostics 载荷元素） */
export interface LspDiagnostic {
  range: LspRange
  severity?: LspDiagnosticSeverity
  code?: string | number
  source?: string
  message: string
}

/** publishDiagnostics 通知参数 */
export interface PublishDiagnosticsParams {
  uri: string
  diagnostics: LspDiagnostic[]
}

/** 补全项类型（LSP CompletionItemKind 1-25） */
export enum LspCompletionItemKind {
  Text = 1,
  Method = 2,
  Function = 3,
  Constructor = 4,
  Field = 5,
  Variable = 6,
  Class = 7,
  Interface = 8,
  Module = 9,
  Property = 10,
  Unit = 11,
  Value = 12,
  Enum = 13,
  Keyword = 14,
  Snippet = 15,
  Color = 16,
  File = 17,
  Reference = 18,
  Folder = 19,
  EnumMember = 20,
  Constant = 21,
  Struct = 22,
  Event = 23,
  Operator = 24,
  TypeParameter = 25
}

/** 补全项 */
export interface LspCompletionItem {
  label: string
  kind?: LspCompletionItemKind
  detail?: string
  documentation?: string | { value: string; kind?: string }
  insertText?: string
  /** 补全项被选择后应用的编辑（优先于 insertText） */
  textEdit?: { range: LspRange; newText: string }
  data?: unknown
}

/** completion 请求返回：数组或 CompletionList */
export type LspCompletionList = LspCompletionItem[] | {
  isIncomplete: boolean
  items: LspCompletionItem[]
}

/** MarkupContent（hover/documentation 载体） */
export interface LspMarkupContent {
  kind: 'plaintext' | 'markdown'
  value: string
}

/** hover 请求返回 */
export interface LspHover {
  contents: LspMarkupContent | string | Array<{ value: string }>
  range?: LspRange
}

/** 代码位置（definition/references 请求元素） */
export interface LspLocation {
  uri: string
  range: LspRange
}

/** 文本编辑（格式化/重命名返回元素） */
export interface LspTextEdit {
  range: LspRange
  newText: string
}

/** 代码操作（quickfix/refactor） */
export interface LspCodeAction {
  title: string
  kind?: string
  diagnostics?: LspDiagnostic[]
  edit?: {
    changes?: Record<string, LspTextEdit[]>
  }
}

/** JSON-RPC 2.0 错误对象 */
export interface RpcError {
  code: number
  message: string
  data?: unknown
}

/** initialize 请求返回 */
export interface InitializeResult {
  capabilities: Record<string, unknown>
  serverInfo?: { name: string; version?: string }
}

/** 文本同步类型：1=Full, 2=Incremental */
export const TEXT_DOCUMENT_SYNC_FULL = 1
export const TEXT_DOCUMENT_SYNC_INCREMENTAL = 2
