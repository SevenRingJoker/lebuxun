// Monaco ↔ LSP 接线：关闭 Monaco 内置 TS/JS 语言服务，注册 7 类 LSP provider，
// 跨文件跳转前预加载目标模型（经 fs 读真实内容），诊断推送写入 Monaco markers。
import * as monaco from 'monaco-editor'
import { lspClient } from './lspClient'
import { registerVueLanguage } from './vueLanguage'
import {
  pathToUri,
  uriToPath,
  monacoPositionToLsp,
  monacoRangeToLsp,
  lspRangeToMonaco,
  diagnosticToMarker,
  completionItemToMonaco,
  hoverToMonaco,
  type MonacoLikeRange
} from '@shared/lsp/converter'
import type {
  LspCompletionItem,
  LspDiagnostic,
  LspTextEdit
} from '@shared/lsp/types'

/** LSP 接管的语言 ID（TS 全家桶 + vue；vue 模式下 Volar Take Over 全部） */
const LSP_LANGUAGE_IDS = [
  'typescript',
  'javascript',
  'typescriptreact',
  'javascriptreact',
  'vue'
]

/** 扩展名 → Monaco 语言 ID（跨文件模型预加载时判定语言） */
const EXT_LANG: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  tsx: 'typescriptreact',
  jsx: 'javascriptreact',
  vue: 'vue'
}

/** 接线上下文：编辑器与当前文件由 EditorPanel 注入 */
export interface MonacoLspContext {
  getEditor: () => monaco.editor.IStandaloneCodeEditor | null
  getCurrentPath: () => string | null
}

/** 关闭 Monaco 内置 TS/JS 语言服务的全部 provider（避免与 LSP 重复） */
function disableBuiltinTs(): void {
  const disabled = {
    completionItems: false,
    hovers: false,
    documentSymbols: false,
    definitions: false,
    references: false,
    documentHighlights: false,
    rename: false,
    diagnostics: false,
    documentRangeFormattingEdits: false,
    signatureHelp: false,
    onTypeFormattingEdits: false,
    codeActions: false,
    inlayHints: false
  }
  monaco.languages.typescript.typescriptDefaults.setModeConfiguration(disabled)
  monaco.languages.typescript.javascriptDefaults.setModeConfiguration(disabled)
}

/** 确保跨文件目标模型存在：不存在则经 fs 读真实内容建模型 */
async function ensureModel(uri: string): Promise<void> {
  const parsed = monaco.Uri.parse(uri)
  if (monaco.editor.getModel(parsed)) return
  const path = uriToPath(uri)
  const ext = path.split('.').pop() ?? ''
  const languageId = EXT_LANG[ext.toLowerCase()] ?? 'plaintext'
  try {
    const content = await window.api.fs.readFile(path)
    monaco.editor.createModel(content, languageId, parsed)
  } catch {
    // 目标文件读不到（未保存/已删除）：建空模型，避免跳转崩溃
    monaco.editor.createModel('', languageId, parsed)
  }
}

/** LSP WorkspaceEdit changes → Monaco workspace text edits */
function changesToResourceEdits(
  changes: Record<string, LspTextEdit[]>
): monaco.languages.IWorkspaceTextEdit[] {
  return Object.entries(changes).flatMap(([uri, edits]) =>
    edits.map((e) => ({
      resource: monaco.Uri.parse(uri),
      versionId: undefined,
      textEdit: { range: lspRangeToMonaco(e.range), text: e.newText }
    }))
  )
}

/**
 * 注册全部 Monaco LSP provider，返回聚合 Disposable。
 * LSP 握手由 lspClient.start 完成；provider 在 ready 前自动返回空结果。
 */
export function registerMonacoLsp(ctx: MonacoLspContext): monaco.IDisposable {
  // 先注册 vue 独立语言（Monarch + configuration），provider 才能挂到 'vue'
  registerVueLanguage()
  disableBuiltinTs()
  const disposables: monaco.IDisposable[] = []

  for (const languageId of LSP_LANGUAGE_IDS) {
    // ---------- 1. 补全 ----------
    disposables.push(
      monaco.languages.registerCompletionItemProvider(languageId, {
        triggerCharacters: ['.', "'", '"', '/', '`', '@'],
        provideCompletionItems: async (model, position) => {
          const path = ctx.getCurrentPath()
          if (!path) return { suggestions: [] }
          const lspPos = monacoPositionToLsp({
            lineNumber: position.lineNumber,
            column: position.column
          })
          const { items } = await lspClient.completion(path, lspPos.line, lspPos.character)
          const suggestions = items.map((item) => {
            const m = completionItemToMonaco(item)
            // 挂上原始 LSP 项供 resolve 阶段取回
            ;(m as unknown as { _lsp: LspCompletionItem })._lsp = item
            return m as monaco.languages.CompletionItem
          })
          return { suggestions }
        },
        resolveCompletionItem: async (item) => {
          const raw = (item as unknown as { _lsp?: LspCompletionItem })._lsp
          if (!raw) return item
          const resolved = await lspClient.resolveCompletion(raw)
          return { ...item, ...completionItemToMonaco(resolved) }
        }
      })
    )

    // ---------- 2. 悬停 ----------
    disposables.push(
      monaco.languages.registerHoverProvider(languageId, {
        provideHover: async (_model, position) => {
          const path = ctx.getCurrentPath()
          if (!path) return null
          const lspPos = monacoPositionToLsp({
            lineNumber: position.lineNumber,
            column: position.column
          })
          const hover = await lspClient.hover(path, lspPos.line, lspPos.character)
          if (!hover) return null
          const m = hoverToMonaco(hover)
          return { range: m.range as MonacoLikeRange, contents: [m.contents] }
        }
      })
    )

    // ---------- 3. 跳转定义 ----------
    disposables.push(
      monaco.languages.registerDefinitionProvider(languageId, {
        provideDefinition: async (_model, position) => {
          const path = ctx.getCurrentPath()
          if (!path) return null
          const lspPos = monacoPositionToLsp({
            lineNumber: position.lineNumber,
            column: position.column
          })
          const locs = await lspClient.definition(path, lspPos.line, lspPos.character)
          // 预加载全部目标模型（Peek/跳转展示真实内容）
          await Promise.all(locs.map((l) => ensureModel(l.uri)))
          return locs.map((l) => ({
            uri: monaco.Uri.parse(l.uri),
            range: lspRangeToMonaco(l.range)
          }))
        }
      })
    )

    // ---------- 4. 查找引用 ----------
    disposables.push(
      monaco.languages.registerReferenceProvider(languageId, {
        provideReferences: async (_model, position) => {
          const path = ctx.getCurrentPath()
          if (!path) return []
          const lspPos = monacoPositionToLsp({
            lineNumber: position.lineNumber,
            column: position.column
          })
          const locs = await lspClient.references(path, lspPos.line, lspPos.character)
          await Promise.all(locs.map((l) => ensureModel(l.uri)))
          return locs.map((l) => ({
            uri: monaco.Uri.parse(l.uri),
            range: lspRangeToMonaco(l.range)
          }))
        }
      })
    )

    // ---------- 5. 重命名 ----------
    disposables.push(
      monaco.languages.registerRenameProvider(languageId, {
        provideRenameEdits: async (_model, position, newName) => {
          const path = ctx.getCurrentPath()
          if (!path) return null
          const lspPos = monacoPositionToLsp({
            lineNumber: position.lineNumber,
            column: position.column
          })
          const changes = await lspClient.rename(path, lspPos.line, lspPos.character, newName)
          await Promise.all(Object.keys(changes).map((uri) => ensureModel(uri)))
          return { edits: changesToResourceEdits(changes) }
        }
      })
    )

    // ---------- 6. 文档格式化 ----------
    disposables.push(
      monaco.languages.registerDocumentFormattingEditProvider(languageId, {
        provideDocumentFormattingEdits: async (_model, options) => {
          const path = ctx.getCurrentPath()
          if (!path) return []
          const edits = await lspClient.formatDocument(path, options.tabSize ?? 2)
          return edits.map((e) => ({ range: lspRangeToMonaco(e.range), text: e.newText }))
        }
      })
    )

    // ---------- 7. 代码操作 ----------
    disposables.push(
      monaco.languages.registerCodeActionProvider(languageId, {
        provideCodeActions: async (_model, range, context) => {
          const path = ctx.getCurrentPath()
          if (!path) return { actions: [], dispose: () => {} }
          const lspRange = monacoRangeToLsp({
            startLineNumber: range.startLineNumber,
            startColumn: range.startColumn,
            endLineNumber: range.endLineNumber,
            endColumn: range.endColumn
          })
          // 当前文件诊断（取与选区相交的）
          const uri = pathToUri(path)
          const diagnostics = lspClient
            .getDiagnostics(uri)
            .filter((d) => intersects(d, lspRange))
          const actions = await lspClient.codeActions(path, lspRange, diagnostics)
          return {
            actions: actions.map((a) => ({
              title: a.title,
              kind: a.kind,
              edit: a.edit?.changes ? { edits: changesToResourceEdits(a.edit.changes) } : undefined,
              diagnostics: (a.diagnostics ?? []).map(diagnosticToMarker) as monaco.editor.IMarkerData[]
            })),
            dispose: () => {}
          }
        }
      })
    )
  }

  // ---------- 诊断 → markers ----------
  const off = lspClient.onDiagnostics((uri) => {
    const editor = ctx.getEditor()
    const path = ctx.getCurrentPath()
    if (!editor || !path || uri !== pathToUri(path)) return
    const model = editor.getModel()
    if (!model) return
    monaco.editor.setModelMarkers(
      model,
      'lsp',
      lspClient.getDiagnostics(uri).map(diagnosticToMarker) as monaco.editor.IMarkerData[]
    )
  })
  disposables.push({ dispose: off })

  // 聚合 Disposable：释放时逐个释放全部 provider 与监听
  return { dispose: () => disposables.forEach((d) => d.dispose()) }
}

/** 判断 LSP 诊断区间是否与目标区间相交 */
function intersects(diag: LspDiagnostic, range: { start: { line: number }; end: { line: number } }): boolean {
  const s = diag.range.start.line
  const e = diag.range.end.line
  return e >= range.start.line && s <= range.end.line
}

/** 文件切换后重刷当前模型 markers（诊断可能在切换前已推送） */
export function refreshCurrentMarkers(ctx: MonacoLspContext): void {
  const editor = ctx.getEditor()
  const path = ctx.getCurrentPath()
  if (!editor || !path) return
  const model = editor.getModel()
  if (!model) return
  const uri = pathToUri(path)
  monaco.editor.setModelMarkers(
    model,
    'lsp',
    lspClient.getDiagnostics(uri).map(diagnosticToMarker) as monaco.editor.IMarkerData[]
  )
}
