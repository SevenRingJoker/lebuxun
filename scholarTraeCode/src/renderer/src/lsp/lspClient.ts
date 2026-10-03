// LSP 客户端：在 Electron IPC 传输桥之上，实现完整 LSP 生命周期——
// initialize（声明全量客户端能力）→ initialized → 文档同步（didOpen/Change/Close/Save）
// → 语言能力请求（补全/悬停/定义/引用/重命名/格式化/代码操作）→ 诊断收集。
// 支持两种语言服务器（ts / vue）按需启动与切换：vue 模式为 Volar Take Over。
// Monaco 无关：编辑应用经注入的 EditApplier 完成，诊断经订阅回调广播。
import { ref } from 'vue'
import { createJsonRpc, type JsonRpc, type RpcTransport } from '@shared/lsp/rpc'
import { pathToUri, normalizeUri } from '@shared/lsp/converter'
import {
  buildInitializeParams,
  type LspServerKind
} from '@shared/lsp/initialize'
import type {
  InitializeResult,
  LspCompletionItem,
  LspHover,
  LspLocation,
  LspTextEdit,
  LspCodeAction,
  PublishDiagnosticsParams,
  LspDiagnostic
} from '@shared/lsp/types'

/** 编辑应用器：把语言服务器返回的 WorkspaceEdit 落到编辑器（由 monacoLsp 实现注入） */
export interface EditApplier {
  applyChanges(changes: Record<string, LspTextEdit[]>): void
}

/** 诊断订阅回调（每次 publishDiagnostics 触发） */
export type DiagnosticsListener = (uri: string, diagnostics: LspDiagnostic[]) => void

/** 已打开的文档（单编辑器应用中同时只有一个） */
export interface OpenDoc {
  uri: string
  languageId: string
  version: number
}

class LspClient {
  private rpc: JsonRpc | null = null
  private ready = false
  /** 当前运行的服务器种类（null=未启动） */
  private kind: LspServerKind | null = null
  private openDoc: OpenDoc | null = null
  private editApplier: EditApplier | null = null
  /** 诊断状态：归一化 uri → 诊断数组 */
  private diagnosticsMap = new Map<string, LspDiagnostic[]>()
  private diagnosticsListeners = new Set<DiagnosticsListener>()
  /** 诊断版本号（响应式）：每次推送自增，供 computed 重算（问题面板/Tab 徽章） */
  readonly diagnosticsVersion = ref(0)

  /** 是否已完成 initialize 握手 */
  get isReady(): boolean {
    return this.ready
  }

  /** 当前服务器种类（null=未启动） */
  get serverKind(): LspServerKind | null {
    return this.kind
  }

  /**
   * 启动指定语言服务器并完成握手；种类变化时先完整停止旧服务器再启动。
   * @param kind 服务器种类：'ts' | 'vue'
   * @param rootPath 工作区根（可空）
   * @param editApplier 编辑应用器
   */
  async start(
    kind: LspServerKind,
    rootPath: string | null,
    editApplier: EditApplier
  ): Promise<void> {
    // 同种类已就绪：幂等返回
    if (this.ready && this.kind === kind) return
    // 种类不同（或残留未就绪连接）：完整拆除旧生命周期
    if (this.kind !== null || this.rpc !== null) {
      await this.teardown()
    }
    this.editApplier = editApplier

    // 启动主进程对应服务器子进程，取回运行时 tsdk（供 Volar initialize）
    const started = await window.api.lsp.start(kind)
    if (!started?.ok) {
      throw new Error(started?.error || `语言服务器启动失败：${kind}`)
    }
    const tsdk = started.tsdk ?? ''

    // IPC 桥适配为 RpcTransport（回调按 kind 过滤，防止切换期串帧）
    const transport: RpcTransport = {
      send: (data) => window.api.lsp.write(kind, data),
      onMessage: (cb) =>
        window.api.lsp.onMessage((k, msg) => {
          if (k === kind) cb(msg)
        })
    }
    this.rpc = createJsonRpc(transport)

    // 订阅诊断推送（URI 归一化后存取）
    this.rpc.onNotification('textDocument/publishDiagnostics', (params) => {
      const p = params as PublishDiagnosticsParams
      const uri = normalizeUri(p.uri)
      this.diagnosticsMap.set(uri, p.diagnostics)
      this.diagnosticsVersion.value += 1
      for (const l of this.diagnosticsListeners) l(uri, p.diagnostics)
    })

    // initialize 握手（参数按服务器种类分支）
    const result = await this.rpc.request<InitializeResult>(
      'initialize',
      buildInitializeParams(kind, rootPath, tsdk)
    )
    this.rpc.notify('initialized', {})
    this.kind = kind
    this.ready = true
    void result // server capabilities 当前按请求驱动，无需缓存
  }

  /** 通知打开文档（编辑器切到某文件时） */
  didOpen(path: string, languageId: string, text: string): void {
    if (!this.rpc || !this.ready) return
    const uri = pathToUri(path)
    // 先关闭旧文档（单编辑器）
    if (this.openDoc && this.openDoc.uri !== uri) {
      this.rpc.notify('textDocument/didClose', { textDocument: { uri: this.openDoc.uri } })
    }
    this.openDoc = { uri, languageId, version: 0 }
    this.rpc.notify('textDocument/didOpen', {
      textDocument: { uri, languageId, version: 0, text }
    })
  }

  /** 通知文档内容变化（全量同步，简单可靠） */
  didChange(text: string): void {
    if (!this.rpc || !this.ready || !this.openDoc) return
    this.openDoc.version += 1
    this.rpc.notify('textDocument/didChange', {
      textDocument: { uri: this.openDoc.uri, version: this.openDoc.version },
      contentChanges: [{ text }]
    })
  }

  /** 通知保存 */
  didSave(text: string): void {
    if (!this.rpc || !this.ready || !this.openDoc) return
    this.rpc.notify('textDocument/didSave', {
      textDocument: { uri: this.openDoc.uri },
      text
    })
  }

  /** 通知关闭文档（文件切走时由 didOpen 自动调用；无文件时显式调用） */
  didClose(): void {
    if (!this.rpc || !this.openDoc) return
    this.rpc.notify('textDocument/didClose', { textDocument: { uri: this.openDoc.uri } })
    this.openDoc = null
  }

  // ---------- 语言能力请求 ----------

  /** 补全（返回原始 LSP 补全项数组，转换由调用方做） */
  async completion(
    path: string,
    line: number,
    character: number
  ): Promise<{ items: LspCompletionItem[]; isIncomplete: boolean }> {
    if (!this.rpc || !this.ready) return { items: [], isIncomplete: true }
    const res = await this.rpc.request<LspCompletionItem[] | { items: LspCompletionItem[]; isIncomplete: boolean }>(
      'textDocument/completion',
      {
        textDocument: { uri: pathToUri(path) },
        position: { line, character }
      }
    )
    return Array.isArray(res)
      ? { items: res, isIncomplete: false }
      : { items: res.items, isIncomplete: res.isIncomplete }
  }

  /** 解析补全项（补充 detail/documentation） */
  async resolveCompletion(item: LspCompletionItem): Promise<LspCompletionItem> {
    if (!this.rpc || !this.ready) return item
    return this.rpc.request<LspCompletionItem>('completionItem/resolve', item)
  }

  /** 悬停 */
  async hover(path: string, line: number, character: number): Promise<LspHover | null> {
    if (!this.rpc || !this.ready) return null
    return this.rpc.request<LspHover | null>('textDocument/hover', {
      textDocument: { uri: pathToUri(path) },
      position: { line, character }
    })
  }

  /** 跳转定义 */
  async definition(path: string, line: number, character: number): Promise<LspLocation[]> {
    if (!this.rpc || !this.ready) return []
    const res = await this.rpc.request<LspLocation | LspLocation[] | null>('textDocument/definition', {
      textDocument: { uri: pathToUri(path) },
      position: { line, character }
    })
    if (!res) return []
    return Array.isArray(res) ? res : [res]
  }

  /** 查找引用 */
  async references(path: string, line: number, character: number): Promise<LspLocation[]> {
    if (!this.rpc || !this.ready) return []
    return (await this.rpc.request<LspLocation[] | null>('textDocument/references', {
      textDocument: { uri: pathToUri(path) },
      position: { line, character },
      context: { includeDeclaration: true }
    })) ?? []
  }

  /** 重命名符号：返回 LSP WorkspaceEdit 的 changes（由调用方转 Monaco edit 应用） */
  async rename(
    path: string,
    line: number,
    character: number,
    newName: string
  ): Promise<Record<string, LspTextEdit[]>> {
    if (!this.rpc || !this.ready) return {}
    const edit = await this.rpc.request<{ changes?: Record<string, LspTextEdit[]> } | null>(
      'textDocument/rename',
      {
        textDocument: { uri: pathToUri(path) },
        position: { line, character },
        newName
      }
    )
    return edit?.changes ?? {}
  }

  /** 文档格式化：返回 LSP TextEdit 数组（由调用方转 Monaco edits 应用） */
  async formatDocument(path: string, tabSize: number): Promise<LspTextEdit[]> {
    if (!this.rpc || !this.ready) return []
    const edits = await this.rpc.request<LspTextEdit[] | null>('textDocument/formatting', {
      textDocument: { uri: pathToUri(path) },
      options: { tabSize, insertSpaces: true }
    })
    return edits ?? []
  }

  /** 代码操作（quickfix/refactor） */
  async codeActions(
    path: string,
    range: { start: { line: number; character: number }; end: { line: number; character: number } },
    diagnostics: LspDiagnostic[]
  ): Promise<LspCodeAction[]> {
    if (!this.rpc || !this.ready) return []
    return (await this.rpc.request<LspCodeAction[] | null>('textDocument/codeAction', {
      textDocument: { uri: pathToUri(path) },
      range,
      context: { diagnostics }
    })) ?? []
  }

  /** 应用代码操作携带的 WorkspaceEdit */
  applyCodeAction(action: LspCodeAction): void {
    if (action.edit?.changes && this.editApplier) {
      this.editApplier.applyChanges(action.edit.changes)
    }
  }

  // ---------- 诊断 ----------

  /** 订阅诊断更新 */
  onDiagnostics(listener: DiagnosticsListener): () => void {
    this.diagnosticsListeners.add(listener)
    return () => this.diagnosticsListeners.delete(listener)
  }

  /** 获取某文件的当前诊断（uri 经归一化） */
  getDiagnostics(uri: string): LspDiagnostic[] {
    return this.diagnosticsMap.get(normalizeUri(uri)) ?? []
  }

  /** 获取全部诊断（供问题面板；uri 为归一化形式） */
  getAllDiagnostics(): Array<{ uri: string; diagnostics: LspDiagnostic[] }> {
    return [...this.diagnosticsMap.entries()].map(([uri, diagnostics]) => ({ uri, diagnostics }))
  }

  // ---------- 生命周期拆除 ----------

  /** 内部拆除：断开 JSON-RPC、清状态、停止主进程子进程 */
  private async teardown(): Promise<void> {
    const oldKind = this.kind
    this.rpc?.dispose()
    this.rpc = null
    this.ready = false
    this.kind = null
    this.openDoc = null
    // 旧服务器诊断对新服务器无效：清空并触发一次版本更新
    if (this.diagnosticsMap.size > 0) {
      this.diagnosticsMap.clear()
      this.diagnosticsVersion.value += 1
    }
    if (oldKind) await window.api.lsp.stop(oldKind)
  }

  /** 断开（窗口卸载时） */
  async stop(): Promise<void> {
    if (this.rpc || this.kind !== null) await this.teardown()
  }
}

/** 全局单例：EditorPanel 启动、ProblemsPanel 消费 */
export const lspClient = new LspClient()
