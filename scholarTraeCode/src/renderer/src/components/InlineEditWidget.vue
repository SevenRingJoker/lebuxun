<script setup lang="ts">
// 内联改写组件：用户选中代码后按 Cmd/Ctrl+K 唤起本组件。
// 输入改写指令 → 流式调用 AI → 把选中代码就地替换为流式累积的文本（带边框高亮）。
// Tab/Enter 接受；Esc 还原原选中代码并关闭。
// 定位：用 editor.getScrolledVisiblePosition 取选中起点的视口坐标，position: fixed 渲染。
import { ref, watch, onBeforeUnmount, nextTick } from 'vue'
import * as monaco from 'monaco-editor'
import { buildRewritePrompt, extractRewrittenCode } from '@shared/inline/prompts'
import { detectLanguage } from '../utils/language'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  visible: boolean
  editor: monaco.editor.IStandaloneCodeEditor | null
  /** 选中起点（Monaco Selection，1-based） */
  selection: monaco.Selection | null
  /** 当前文件路径（用于语言识别与上下文） */
  currentPath: string | null
  /** 当前文件内容（用于取选中前后文） */
  content: string
  /** 工作区根 */
  workspace: string | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const { t } = useI18n()

/** 组件状态机：input 输入指令 / streaming 流式替换中 / done 完成（可接受/回退） */
type Phase = 'input' | 'streaming' | 'done'
const phase = ref<Phase>('input')
const instruction = ref('')
const errorText = ref('')
const busy = ref(false)
const inputRef = ref<HTMLInputElement | null>(null)

/** 视口坐标（fixed 定位） */
const posX = ref(0)
const posY = ref(0)
const visible = ref(false)

/** 一次改写会话的运行时状态 */
interface RewriteSession {
  startLine: number
  startCol: number
  endLine: number
  endCol: number
  startOffset: number
  original: string
  accumulated: string
  requestId: string
}
let session: RewriteSession | null = null

/** 监听 props.visible：true → 进入 input 阶段并定位 */
watch(
  () => props.visible,
  async (v) => {
    if (v) {
      phase.value = 'input'
      instruction.value = ''
      errorText.value = ''
      busy.value = false
      session = null
      reposition()
      await nextTick()
      // 健壮聚焦：单次 microtask 不够，多帧兜底
      setTimeout(() => inputRef.value?.focus(), 0)
      setTimeout(() => inputRef.value?.focus(), 50)
    } else {
      visible.value = false
    }
  },
  { immediate: true }
)

/** 重新计算视口坐标（滚动/resize/内容变化时调用） */
function reposition(): void {
  if (!props.editor || !props.selection) {
    visible.value = false
    return
  }
  const startPos = props.selection.getStartPosition()
  const scrolled = props.editor.getScrolledVisiblePosition(startPos)
  if (!scrolled) {
    // 选中起点不在视口内：隐藏组件，但不关闭（用户滚动后会复现）
    visible.value = false
    return
  }
  const dom = props.editor.getDomNode()
  if (!dom) return
  const rect = dom.getBoundingClientRect()
  posX.value = rect.left + scrolled.left
  // 起点行下方 4px 处
  posY.value = rect.top + scrolled.top + scrolled.height + 4
  visible.value = true
}

/** 监听编辑器滚动/resize：实时跟随光标位置 */
let scrollDisposer: monaco.IDisposable | null = null
watch(
  () => props.editor,
  (ed) => {
    if (scrollDisposer) {
      scrollDisposer.dispose()
      scrollDisposer = null
    }
    if (ed) {
      scrollDisposer = ed.onDidScrollChange(() => reposition())
    }
  },
  { immediate: true }
)

/** 取选中前后文（用于 FIM 风格的上下文注入） */
function getAroundContext(): { before: string; after: string } {
  if (!props.selection || !props.content) return { before: '', after: '' }
  const lines = props.content.split('\n')
  const startLine = props.selection.startLineNumber
  const endLine = props.selection.endLineNumber
  // 前文：选中起点行之前的内容（取最多 30 行避免过长）
  const beforeStart = Math.max(0, startLine - 2 - 30)
  const before = lines.slice(beforeStart, startLine - 1).join('\n')
  // 后文：选中终点行之后的内容（取最多 20 行）
  const afterEnd = Math.min(lines.length, endLine + 20)
  const after = lines.slice(endLine, afterEnd).join('\n')
  return { before, after }
}

/** 提交改写指令：开始流式 IPC + 就地替换 */
async function submit(): Promise<void> {
  if (!props.editor || !props.selection || busy.value) return
  const inst = instruction.value.trim()
  if (!inst) {
    errorText.value = t('inline.emptyInstruction')
    return
  }
  const model = props.editor.getModel()
  if (!model) return

  const start = props.selection.getStartPosition()
  const startOffset = model.getOffsetAt(start)
  const original = model.getValueInRange(props.selection)
  const requestId = `rewrite-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  session = {
    startLine: start.lineNumber,
    startCol: start.column,
    endLine: start.lineNumber,
    endCol: start.column,
    startOffset,
    original,
    accumulated: '',
    requestId
  }

  // 语言识别
  const lang = detectLanguage(props.currentPath, original)
  // 选中前后文
  const { before, after } = getAroundContext()
  const messages = buildRewritePrompt(original, inst, lang, before, after)

  phase.value = 'streaming'
  busy.value = true
  errorText.value = ''

  // 先清空选中（替换为空字符串），让 AI 文本从起点开始累积
  props.editor.executeEdits('inline-rewrite-clear', [
    {
      range: props.selection,
      text: '',
      forceMoveMarkers: true
    }
  ])

  // 订阅流式事件
  const offChunk = window.api.ai.onInlineChunk((p) => {
    if (p.requestId !== requestId) return
    applyChunk(p.delta)
  })
  const offDone = window.api.ai.onInlineDone((p) => {
    if (p.requestId !== requestId) return
    finish()
  })
  const offErr = window.api.ai.onInlineError((p) => {
    if (p.requestId !== requestId) return
    errorText.value = p.err
    finish()
  })
  const offFallback = window.api.ai.onInlineFallback((p) => {
    if (p.requestId !== requestId) return
    // 回退提示不阻断，仅记录到 errorText 供用户感知
    errorText.value = `${t('inline.fallback')}: ${p.from} → ${p.to}（${p.reason}）`
  })

  try {
    await window.api.ai.inlineStream({
      requestId,
      messages,
      taskType: 'completion',
      currentFile: props.currentPath,
      workspace: props.workspace,
      timeoutMs: 30_000
    })
    // IPC 已返回；事件应已到达。兜底：若仍 streaming，1s 后强制完成
    if (phase.value === 'streaming') {
      setTimeout(() => {
        if (phase.value === 'streaming') finish()
      }, 1000)
    }
  } catch (e: any) {
    errorText.value = e?.message || String(e)
    finish()
  } finally {
    offChunk()
    offDone()
    offErr()
    offFallback()
  }
}

/** 应用一段增量文本到编辑器（替换当前 AI 文本范围） */
function applyChunk(delta: string): void {
  if (!props.editor || !session) return
  const model = props.editor.getModel()
  if (!model) return
  session.accumulated += delta
  // 当前 AI 文本终点：基于 startOffset + accumulated.length 计算
  const endOffset = session.startOffset + session.accumulated.length
  const endPos = model.getPositionAt(endOffset)
  // 替换 [start, endPos] 为新累积文本
  // 首次：endPos == start（零宽，纯插入）；后续：覆盖已有 AI 文本
  props.editor.executeEdits('inline-rewrite-chunk', [
    {
      range: new monaco.Range(
        session.startLine,
        session.startCol,
        endPos.lineNumber,
        endPos.column
      ),
      text: session.accumulated,
      forceMoveMarkers: true
    }
  ])
  session.endLine = endPos.lineNumber
  session.endCol = endPos.column
}

/** 流式结束：进入 done 阶段（Tab 接受 / Esc 回退） */
function finish(): void {
  busy.value = false
  phase.value = 'done'
  // 应用最终提取（剥围栏等清洗）：若清洗结果与原累积不同，再替换一次
  if (props.editor && session) {
    const cleaned = extractRewrittenCode(session.accumulated)
    if (cleaned !== session.accumulated && cleaned.length >= 0) {
      session.accumulated = cleaned
      applyChunk('') // 用空 delta 触发一次重写为 cleaned
    }
  }
}

/** 接受改写（Tab/Enter） */
function accept(): void {
  if (phase.value !== 'done') return
  close()
}

/** 回退到原始选中代码（Esc） */
function revert(): void {
  if (!props.editor || !session) {
    close()
    return
  }
  const model = props.editor.getModel()
  if (model) {
    // 用一次 executeEdits 把当前 AI 文本替换回 original
    props.editor.executeEdits('inline-rewrite-revert', [
      {
        range: new monaco.Range(
          session.startLine,
          session.startCol,
          session.endLine,
          session.endCol
        ),
        text: session.original,
        forceMoveMarkers: true
      }
    ])
    // 还原选区，方便用户再按 Cmd+K 重试
    props.editor.setSelection(
      new monaco.Selection(
        session.startLine,
        session.startCol,
        session.startLine,
        session.startCol + session.original.length
      )
    )
  }
  close()
}

/** 关闭组件 */
function close(): void {
  visible.value = false
  emit('close')
}

/** 键盘处理：input 阶段 Enter 提交 / Esc 关闭；done 阶段 Tab 接受 / Esc 回退 */
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    if (phase.value === 'streaming') {
      // 流式中 Esc：先停止 IPC，再回退
      void window.api.ai.stopInline().then(() => revert())
    } else if (phase.value === 'done') {
      revert()
    } else {
      close()
    }
    return
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    if (phase.value === 'input') {
      e.preventDefault()
      e.stopPropagation()
      void submit()
    } else if (phase.value === 'done') {
      e.preventDefault()
      e.stopPropagation()
      accept()
    }
    return
  }
  if (e.key === 'Tab') {
    if (phase.value === 'done') {
      e.preventDefault()
      e.stopPropagation()
      accept()
    }
  }
}

onBeforeUnmount(() => {
  scrollDisposer?.dispose()
  // 卸载时若仍在 streaming，尽力停掉远端
  if (phase.value === 'streaming') void window.api.ai.stopInline()
})
</script>

<template>
  <div
    v-if="visible && (phase === 'input' || phase === 'streaming' || phase === 'done')"
    class="inline-edit-widget cp-glass"
    :class="`phase-${phase}`"
    :style="{ left: posX + 'px', top: posY + 'px' }"
    @keydown="onKeydown"
  >
    <!-- 输入阶段 -->
    <div v-if="phase === 'input'" class="input-row">
      <span class="hint-icon" aria-hidden="true">✨</span>
      <input
        ref="inputRef"
        v-model="instruction"
        class="instruction-input"
        type="text"
        spellcheck="false"
        :placeholder="t('inline.placeholder')"
        :aria-label="t('inline.placeholder')"
      />
      <span class="hint-keys">{{ t('inline.hintInput') }}</span>
    </div>
    <!-- 流式阶段 -->
    <div v-else-if="phase === 'streaming'" class="status-row">
      <span class="hint-icon streaming" aria-hidden="true">⏳</span>
      <span class="status-text">{{ t('inline.streaming') }}</span>
      <span class="hint-keys">{{ t('inline.hintStreaming') }}</span>
    </div>
    <!-- 完成阶段 -->
    <div v-else class="status-row">
      <span class="hint-icon done" aria-hidden="true">✓</span>
      <span class="status-text">{{ t('inline.done') }}</span>
      <span class="hint-keys">{{ t('inline.hintDone') }}</span>
    </div>
    <!-- 错误/回退提示 -->
    <div v-if="errorText" class="error-text">{{ errorText }}</div>
  </div>
</template>

<style scoped>
.inline-edit-widget {
  position: fixed;
  z-index: 930;
  min-width: 280px;
  max-width: 480px;
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid var(--accent, #00d4ff);
  background: var(--bg-secondary, #11192c);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  font-size: 12px;
  color: var(--text-primary, #eaf0fa);
}

.inline-edit-widget.phase-streaming {
  border-color: var(--warning, #f59e0b);
}

.inline-edit-widget.phase-done {
  border-color: var(--success, #22c55e);
}

.input-row,
.status-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.hint-icon {
  font-size: 14px;
  flex-shrink: 0;
}

.hint-icon.streaming {
  animation: pulse 1.2s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 0.5; }
  50% { opacity: 1; }
}

.instruction-input {
  flex: 1;
  min-width: 0;
  padding: 4px 6px;
  background: transparent;
  border: none;
  outline: none;
  color: inherit;
  font-family: inherit;
  font-size: 12px;
}

.instruction-input::placeholder {
  color: var(--text-muted, #71829f);
}

.status-text {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.hint-keys {
  font-size: 10px;
  color: var(--text-muted, #71829f);
  white-space: nowrap;
  user-select: none;
}

.error-text {
  margin-top: 4px;
  padding-top: 4px;
  border-top: 1px solid var(--border, #1a2230);
  color: var(--warning, #f59e0b);
  font-size: 11px;
  line-height: 1.4;
}
</style>
