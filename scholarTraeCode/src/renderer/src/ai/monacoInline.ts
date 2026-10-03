// 内联 AI 接线：注册 Monaco InlineCompletionsProvider（Ghost Text 幽灵补全）。
// 与 LSP 补全（弹出建议浮层）不同：内联补全在光标处直接渲染灰色续写文本，Tab 接受。
// 通过 ai:inlineStream IPC 走与聊天隔离的事件通道，requestId 过滤并发/陈旧响应。
import * as monaco from 'monaco-editor'
import { buildFimPrompt, extractCompletion } from '@shared/inline/prompts'
import { COMMON_LANGUAGES, detectLanguageByPath } from '../utils/language'

/** 接线上下文：编辑器、当前文件路径、工作区根由 EditorPanel 注入 */
export interface InlineAiContext {
  getEditor: () => monaco.editor.IStandaloneCodeEditor | null
  getCurrentPath: () => string | null
  getWorkspace: () => string | null
}

/** 全局 requestId 自增：每次发起 inline 请求递增，过滤陈旧响应 */
let inlineSeq = 0

/**
 * 注册内联补全 provider。
 * 一次性为 COMMON_LANGUAGES 全部语言注册（Monaco 0.52 已内置这些语言 id）。
 * 触发时机：Monaco 在用户输入后内部去抖调用 provideInlineCompletions；
 * 用户继续输入时旧请求的 CancellationToken 被 cancel，本端调用 stopInline 中止。
 */
export function registerInlineCompletionProvider(ctx: InlineAiContext): monaco.IDisposable {
  const disposables: monaco.IDisposable[] = []

  for (const lang of COMMON_LANGUAGES) {
    // plaintext 不补全：无语法特征，FIM 噪声大、价值低
    if (lang.id === 'plaintext') continue
    const d = monaco.languages.registerInlineCompletionsProvider(lang.id, {
      provideInlineCompletions: async (model, position, _context, token) => {
        if (token.isCancellationRequested) return { items: [] }
        // 仅在行内有意义的上下文时触发：避免纯空白行/文件首部空行触发
        const lineContent = model.getLineContent(position.lineNumber)
        const before = lineContent.slice(0, position.column - 1)
        // 当前行完全空白且为文件首行：跳过（无任何上下文）
        if (!before.trim() && position.lineNumber === 1) return { items: [] }

        // 构建 FIM：前文（开头到光标）+ 后文（光标到末尾）
        const prefix = model.getValueInRange({
          startLineNumber: 1,
          startColumn: 1,
          endLineNumber: position.lineNumber,
          endColumn: position.column
        })
        const lastLine = model.getLineCount()
        const suffix = model.getValueInRange({
          startLineNumber: position.lineNumber,
          startColumn: position.column,
          endLineNumber: lastLine,
          endColumn: model.getLineMaxColumn(lastLine)
        })

        // 路径识别优先；退化到当前模型语言 id
        const langId =
          detectLanguageByPath(ctx.getCurrentPath() ?? '') || model.getLanguageId()
        const messages = buildFimPrompt(prefix, suffix, langId)

        const requestId = `inline-${++inlineSeq}`
        let accumulated = ''
        let resolveDone!: () => void
        const donePromise = new Promise<void>((r) => {
          resolveDone = r
        })

        const offChunk = window.api.ai.onInlineChunk((p) => {
          if (p.requestId !== requestId) return
          accumulated += p.delta
        })
        const offDone = window.api.ai.onInlineDone((p) => {
          if (p.requestId !== requestId) return
          resolveDone()
        })
        const offErr = window.api.ai.onInlineError((p) => {
          if (p.requestId !== requestId) return
          resolveDone() // 出错视作空响应，graceful 收尾
        })

        let cancelled = false
        const tokenSub = token.onCancellationRequested(() => {
          cancelled = true
          void window.api.ai.stopInline()
          resolveDone()
        })

        try {
          await window.api.ai.inlineStream({
            requestId,
            messages,
            taskType: 'completion',
            currentFile: ctx.getCurrentPath(),
            workspace: ctx.getWorkspace(),
            timeoutMs: 8000
          })
          // IPC 返回时 onDone 已发，但事件循环顺序不保证，等 donePromise 兜底
          await Promise.race([
            donePromise,
            new Promise<void>((r) => setTimeout(r, 500)) // 500ms 兜底，防止事件丢失挂死
          ])
        } catch {
          // IPC 异常视作空响应
        } finally {
          offChunk()
          offDone()
          offErr()
          tokenSub.dispose()
        }

        if (cancelled || token.isCancellationRequested) return { items: [] }
        const text = extractCompletion(accumulated)
        if (!text) return { items: [] }
        return {
          items: [
            {
              insertText: text,
              range: new monaco.Range(
                position.lineNumber,
                position.column,
                position.lineNumber,
                position.column
              )
            }
          ]
        }
      },
      freeInlineCompletions: () => {
        /* 无需手动释放：items 为纯数据，GC 自动回收 */
      }
    })
    disposables.push(d)
  }

  // 聚合 Disposable（monaco.IDisposable.from 不存在）
  return {
    dispose: () => disposables.forEach((d) => d.dispose())
  }
}
