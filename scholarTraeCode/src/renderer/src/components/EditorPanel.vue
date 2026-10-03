<script setup lang="ts">
// Monaco 编辑器面板：初始化编辑器、配置 worker、连接 LSP
import { onMounted, onBeforeUnmount, ref, watch, nextTick, computed } from 'vue'
import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import { useWorkspaceStore } from '../stores/workspace'
import { useThemeStore } from '../stores/theme'
import { useDebugStore } from '../stores/debug'
import { useGitStore } from '../stores/git'
import { detectLanguage, languageLabel, COMMON_LANGUAGES } from '../utils/language'
import TerminalPanel from './TerminalPanel.vue'
import { lspClient, type EditApplier } from '../lsp/lspClient'
import { registerMonacoLsp, refreshCurrentMarkers } from '../lsp/monacoLsp'
import { registerInlineCompletionProvider } from '../ai/monacoInline'
import InlineEditWidget from './InlineEditWidget.vue'
import { monospaceFontStack, platformFromNavigator, modKeyName } from '@shared/platform'
import type { LspServerKind } from '@shared/lsp/initialize'

// 跨平台等宽字体栈：按 navigator.platform 推断，浏览器按序挑首个可用字体
const FONT_STACK = monospaceFontStack(platformFromNavigator(navigator.platform))
// 平台主修饰键名（mac 显示 Cmd，Windows/Linux 显示 Ctrl）
const MOD_KEY = modKeyName(platformFromNavigator(navigator.platform))

const ws = useWorkspaceStore()
const themeStore = useThemeStore()
const debugStore = useDebugStore()
const git = useGitStore()
const currentBranch = computed(() => git.branches.find(b => b.current)?.name ?? '')

// 欢迎页快捷入口
function quickNewFile(): void {
  window.dispatchEvent(new CustomEvent('scholar:request-new-file'))
}
function quickAskAi(): void {
  window.dispatchEvent(new CustomEvent('scholar:request-ai'))
}
const containerRef = ref<HTMLDivElement | null>(null)
let editor: monaco.editor.IStandaloneCodeEditor | null = null
// s51 Monaco 模型懒建缓存：path → 独立 TextModel，切换文件用 setModel 保留 undo/光标/选择
const modelCache = new Map<string, monaco.editor.ITextModel>()
// 容器尺寸观察器：尺寸变化（含从 0 恢复、分栏拖拽、面板显隐）时强制重排
let resizeObserver: ResizeObserver | null = null
// 挂载阶段等待容器出现非 0 尺寸的一次性观察器
let readyObserver: ResizeObserver | null = null
// 程序化 setValue（打开/关闭文件、补加载）期间为 true，避免把程序写入误判为用户编辑
let applyingValue = false

// ---------- LSP 接线状态 ----------
/** Monaco provider 聚合 Disposable（卸载时释放） */
let lspDisposable: monaco.IDisposable | null = null
/** didChange 防抖定时器：用户连续输入时合并通知，降低语言服务器压力 */
let didChangeTimer: number | null = null
/** 编辑应用器：把 LSP 返回的跨文件编辑写入磁盘/模型（当前仅预留，provider 直接应用编辑） */
const editApplier: EditApplier = {
  applyChanges: () => {
    // Monaco provider 已自行应用编辑；此处预留供未来服务端发起的 workspace/applyEdit
  }
}
/** 防抖推送文档变化（300ms 内连续编辑合并为一次全量同步） */
function scheduleDidChange(): void {
  if (didChangeTimer !== null) window.clearTimeout(didChangeTimer)
  didChangeTimer = window.setTimeout(() => {
    didChangeTimer = null
    lspClient.didChange(editor?.getValue() ?? '')
  }, 300)
}

// ---------- 内联 AI（Cmd+K 改写 + Tab 补全） ----------
/** 内联改写组件 Disposable：聚合 inline provider，卸载时释放 */
let inlineDisposable: monaco.IDisposable | null = null
/** Cmd+K 改写组件可见性：v-if 控制挂载 */
const inlineEditVisible = ref(false)
/** 改写目标选区快照（捕获时复制，避免编辑器实时选区变化影响会话） */
const inlineSelection = ref<monaco.Selection | null>(null)

// ---------- 多文件 Tab 栏 + 底部状态栏 ----------
// 光标位置（状态栏展示）；编辑器创建后挂 onDidChangeCursorPosition
const cursorLine = ref(1)
const cursorCol = ref(1)

// ---------- 3.1 内置浏览器预览 ----------
import PreviewPanel from './PreviewPanel.vue'
import { usePreviewStore } from '../stores/preview'
const preview = usePreviewStore()
// 中栏模式：editor 代码编辑 | preview 浏览器预览（Tab 栏最右侧切换）
const centerMode = ref<'editor' | 'preview'>('editor')
async function switchToPreview(): Promise<void> {
  centerMode.value = 'preview'
  preview.active = true
}
async function switchToEditor(): Promise<void> {
  centerMode.value = 'editor'
  // 切回编辑器时隐藏预览视图但保留 webContents（不销毁会话）
  await preview.hide()
}

function tabName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

// 点击 Tab 激活：store 内做快照交换，编辑器经 watch currentFile 刷新
function activateTab(path: string): void {
  void ws.openFile(path)
}

// 未保存 Tab 的关闭确认（应用内弹窗，禁原生 confirm）
const closeConfirmPath = ref<string | null>(null)
function requestCloseTab(path: string): void {
  if (ws.closeTab(path) === 'needConfirm') closeConfirmPath.value = path
}
function cancelCloseTab(): void {
  closeConfirmPath.value = null
}
async function confirmSaveAndClose(): Promise<void> {
  const p = closeConfirmPath.value
  closeConfirmPath.value = null
  if (p) await ws.saveAndCloseTab(p)
}
function confirmDiscardClose(): void {
  const p = closeConfirmPath.value
  closeConfirmPath.value = null
  if (p) ws.forceCloseTab(p)
}

// 中键快捷关闭（浏览器默认中键是自动滚动，必须 preventDefault）
function onTabMouseDown(e: MouseEvent, path: string): void {
  if (e.button !== 1) return
  e.preventDefault()
  e.stopPropagation()
  requestCloseTab(path)
}

// Tab 拖拽排序：dragstart 记下源下标，drop 时交给 store 重排
const dragTabIndex = ref<number | null>(null)
function onTabDragStart(i: number): void {
  dragTabIndex.value = i
}
function onTabDrop(i: number): void {
  if (dragTabIndex.value !== null) ws.moveTab(dragTabIndex.value, i)
  dragTabIndex.value = null
}
// 空白态：无打开 Tab 且无草稿内容时盖住编辑区（草稿仍可直接输入）
const showEmpty = computed(
  () => ws.openTabs.length === 0 && !ws.currentFile && !ws.currentContent
)

// ---------- 代码语言 ----------
// 手动选择的语言覆盖；null 表示跟随自动识别（按文件名/扩展名，其次 shebang 内容）
const manualLang = ref<string | null>(null)
// 当前自动识别结果（随当前文件路径与内容变化）
const autoLang = computed(() => detectLanguage(ws.currentFile, ws.currentContent))
// 实际生效语言：手动优先，否则自动
const effectiveLang = computed(() => manualLang.value ?? autoLang.value)
const langOptions = COMMON_LANGUAGES
const currentLangLabel = computed(() => languageLabel(effectiveLang.value))
// 是否处于「自动识别」模式（用于头部小标记）
const isAutoLang = computed(() => manualLang.value === null)

function onLangChange(e: Event): void {
  const value = (e.target as HTMLSelectElement).value
  // '__auto__' 是「恢复自动识别」入口，其余为具体语言 id
  manualLang.value = value === '__auto__' ? null : value
}

// Monaco worker 环境配置
self.MonacoEnvironment = {
  getWorker(_: any, label: string) {
    if (label === 'json') return new jsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker()
    if (label === 'typescript' || label === 'javascript') return new tsWorker()
    return new editorWorker()
  }
}

// 三套 Monaco 主题色板：与全局 CSS 变量一一对应
interface MonacoPalette {
  base: monaco.editor.BuiltinTheme
  bg: string
  fg: string
  line: string
  select: string
  selectSoft: string
  cursor: string
  lineNo: string
  indent: string
  indentActive: string
  whitespace: string
  secondary: string
  border: string
  hover: string
  muted: string
}

// 注意：Monaco standalone 的 defineTheme 颜色只接受 hex（#RRGGBB 或 #RRGGBBAA），
// 传 rgba() 会被 Color.fromHex 解析失败并静默回退为纯红 #FF0000，因此透明度一律用 8 位 hex
const PALETTES: Record<'blue' | 'dark' | 'light', MonacoPalette> = {
  // 蓝（亮暗蓝）
  blue: {
    base: 'vs-dark',
    bg: '#0C1322', fg: '#EAF0FA', line: '#14203A',
    // 选中：白色 60% 透明（99）；次级高亮 22% 透明（38）
    select: '#FFFFFF99', selectSoft: '#FFFFFF38', cursor: '#00D4FF',
    lineNo: '#3A4E75', indent: '#1C2842', indentActive: '#2A3C5E', whitespace: '#26375A',
    secondary: '#111A2C', border: '#26375A', hover: '#1D2A44', muted: '#71829F'
  },
  // 黑（纯深黑）
  dark: {
    base: 'vs-dark',
    bg: '#04060A', fg: '#E6EBF2', line: '#0E1420',
    // 选中：白色 60% 透明（99）；次级高亮 20% 透明（33）
    select: '#FFFFFF99', selectSoft: '#FFFFFF33', cursor: '#00D4FF',
    lineNo: '#39445C', indent: '#141B28', indentActive: '#222C40', whitespace: '#1A2230',
    secondary: '#0A0E15', border: '#1A2230', hover: '#161D2B', muted: '#637089'
  },
  // 白（亮色）
  light: {
    base: 'vs',
    bg: '#F4F7FB', fg: '#1B2435', line: '#E6EDF6',
    // 亮色下白色不可见，选区改用深色（#1B2435）22%（38）/10%（1A）透明
    select: '#1B243538', selectSoft: '#1B24351A', cursor: '#0288C7',
    lineNo: '#9AA9BF', indent: '#E2E9F2', indentActive: '#C2CDDD', whitespace: '#D3DCE9',
    secondary: '#FFFFFF', border: '#D3DCE9', hover: '#E4EAF3', muted: '#7B8AA3'
  }
}

// 注册三套 Monaco 主题
function defineScholarThemes(): void {
  for (const [name, p] of Object.entries(PALETTES) as [
    'blue' | 'dark' | 'light',
    MonacoPalette
  ][]) {
    monaco.editor.defineTheme(`scholar-${name}`, {
      base: p.base,
      inherit: true,
      rules: [],
      colors: {
        'editor.background': p.bg,
        'editor.foreground': p.fg,
        'editor.lineHighlightBackground': p.line,
        'editor.lineHighlightBorder': p.line,
        'editor.selectionBackground': p.select,
        'editor.inactiveSelectionBackground': p.selectSoft,
        'editor.selectionHighlightBackground': p.selectSoft,
        'editorCursor.foreground': p.cursor,
        'editorLineNumber.foreground': p.lineNo,
        'editorLineNumber.activeForeground': p.cursor,
        'editorIndentGuide.background': p.indent,
        'editorIndentGuide.activeBackground': p.indentActive,
        'editorWhitespace.foreground': p.whitespace,
        'editorOverviewRuler.background': p.bg,
        'editorOverviewRuler.border': p.secondary,
        'editor.findMatchBackground': p.select,
        'editor.findMatchHighlightBackground': p.selectSoft,
        'editorGutter.foldingControlForeground': p.muted,
        'breadcrumb.background': p.secondary,
        'breadcrumb.foreground': p.muted,
        'breadcrumb.focusForeground': p.cursor,
        'breadcrumb.activeSelectionForeground': p.fg,
        'editorSuggestWidget.background': p.secondary,
        'editorSuggestWidget.border': p.border,
        'editorSuggestWidget.highlightForeground': p.cursor,
        'editorSuggestWidget.selectedBackground': p.hover,
        'editorHoverWidget.background': p.secondary,
        'editorHoverWidget.border': p.border,
        'editorError.foreground': '#EF4444',
        'editorWarning.foreground': '#F59E0B',
        'editorInfo.foreground': p.cursor,
        'editorHint.foreground': p.muted,
        'editorBracketMatch.background': p.selectSoft,
        'editorBracketMatch.border': p.cursor
      }
    })
  }
}

onMounted(() => {
  if (!containerRef.value) return
  defineScholarThemes()

  // 关键：必须在容器具备真实尺寸后再创建编辑器。
  // dev 模式下 Vite 注入样式/字体较晚，挂载瞬间容器高度可能还是 0，
  // 此时 create 会让 Monaco 视图层进入「高度 0、不渲染任何行」的状态，
  // 而 automaticLayout 的 ResizeObserver 只在尺寸「变化」时触发——
  // 容器此后不再变化，视图就永久空白，表现为打字进模型但屏幕不显示（写不进）。
  const createWhenReady = (attempt = 0): void => {
    const el = containerRef.value
    if (!el) return
    const rect = el.getBoundingClientRect()
    if ((rect.width === 0 || rect.height === 0) && attempt < 60) {
      // 最多等待约 3 秒（60 × 50ms），由 ResizeObserver 提前唤醒
      setTimeout(() => createWhenReady(attempt + 1), 50)
      return
    }
    createEditor()
  }

  // 容器一旦出现非 0 尺寸立即创建（比轮询更快）
  readyObserver = new ResizeObserver(() => {
    const el = containerRef.value
    if (!el || editor) return
    const rect = el.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) {
      readyObserver?.disconnect()
      readyObserver = null
      createEditor()
    }
  })
  readyObserver.observe(containerRef.value)
  createWhenReady()
})

// 实际创建 Monaco 编辑器实例
function createEditor(): void {
  if (!containerRef.value || editor) return
  // 无论被轮询还是观察器唤醒，都确保一次性观察器被回收
  readyObserver?.disconnect()
  readyObserver = null

  editor = monaco.editor.create(containerRef.value, {
    // 默认空内容；语言按当前文件自动识别，无文件时为纯文本
    value: '',
    language: effectiveLang.value,
    theme: `scholar-${themeStore.theme}`,
    automaticLayout: true,
    fontSize: 13,
    fontFamily: FONT_STACK,
    // 关闭小地图：空文件时其空白列会被误认为编辑器未铺满
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    wordWrap: 'on',
    tabSize: 2,
    padding: { top: 12 },
    // 断点槽：显示 glyphMargin 供点击下断点
    glyphMargin: true
  })

  // 编辑器内容变化时同步到 store。
  // 注意：即使 currentFile 为空也要同步——此时是「未命名草稿」，
  // 用户可先写内容再 Ctrl+S 指定文件名保存
  editor.onDidChangeModelContent(() => {
    if (applyingValue) return
    ws.currentContent = editor?.getValue() ?? ''
    ws.fileDirty = true
    // 防抖同步到 LSP（用户编辑，非程序写入）
    scheduleDidChange()
  })

  // 状态栏光标行列（1-based，Monaco position 原生即 1-based）
  editor.onDidChangeCursorPosition((e) => {
    cursorLine.value = e.position.lineNumber
    cursorCol.value = e.position.column
  })

  // 多帧兜底重排：覆盖样式/字体晚到、flex 布局二次计算等边界时序
  requestAnimationFrame(() => editor?.layout())
  requestAnimationFrame(() => requestAnimationFrame(() => editor?.layout()))
  setTimeout(() => editor?.layout(), 50)
  setTimeout(() => editor?.layout(), 300)

  // ResizeObserver 持续观测容器：分栏拖拽、AI 面板显隐、窗口缩放都能即时重排
  if (containerRef.value) {
    resizeObserver = new ResizeObserver(() => editor?.layout())
    resizeObserver.observe(containerRef.value)
  }
  // 兼容老环境：window resize 也兜底一次（App 分栏拖拽时会派发该事件）
  const onResize = (): void => editor?.layout()
  window.addEventListener('resize', onResize)
  onBeforeUnmount(() => {
    window.removeEventListener('resize', onResize)
    resizeObserver?.disconnect()
  })

  // ---------- 调试断点槽 ----------
  // 装饰器集合：断点红点 / 命中行黄条
  let bpDecorations: monaco.editor.IEditorDecorationsCollection | null = null
  let hitDecorations: monaco.editor.IEditorDecorationsCollection | null = null

  function refreshBreakpointDecorations(): void {
    if (!editor) return
    const file = ws.currentFile
    if (!file) {
      bpDecorations?.clear()
      return
    }
    const lines = debugStore.getBreakpoints(file)
    const decos = lines.map((line) => ({
      range: new monaco.Range(line, 1, line, 1),
      options: {
        glyphMarginClassName: 'debug-bp-glyph',
        glyphMarginHoverMessage: { value: `断点：行 ${line}` },
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
      }
    }))
    if (!bpDecorations) bpDecorations = editor.createDecorationsCollection(decos)
    else bpDecorations.set(decos)
  }

  function refreshHitLineDecoration(): void {
    if (!editor) return
    const hit = debugStore.hitLine
    const file = ws.currentFile
    if (!hit || !file || hit.file !== file) {
      hitDecorations?.clear()
      return
    }
    const decos = [{
      range: new monaco.Range(hit.line, 1, hit.line, 1),
      options: {
        isWholeLine: true,
        className: 'debug-hit-line',
        glyphMarginClassName: 'debug-hit-glyph',
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
      }
    }]
    if (!hitDecorations) hitDecorations = editor.createDecorationsCollection(decos)
    else hitDecorations.set(decos)
  }

  // 点击 glyph margin 切换断点
  editor.onMouseDown((e) => {
    if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return
    const line = e.target.position?.lineNumber
    const file = ws.currentFile
    if (!line || !file) return
    debugStore.toggleBreakpoint(file, line)
    refreshBreakpointDecorations()
  })

  // 文件切换 / 断点变化 / 命中行变化时刷新装饰
  watch(() => ws.currentFile, () => {
    debugStore.setCurrentFile(ws.currentFile)
    refreshBreakpointDecorations()
    refreshHitLineDecoration()
  })
  watch(() => debugStore.breakpoints, refreshBreakpointDecorations, { deep: true })
  watch(() => debugStore.hitLine, refreshHitLineDecoration, { deep: true })

  // 注册 Monaco LSP provider（补全/悬停/定义/引用/重命名/格式化/代码操作 + markers）
  lspDisposable = registerMonacoLsp({
    getEditor: () => editor,
    getCurrentPath: () => ws.currentFile
  })
  // 注册内联 AI 补全 provider（幽灵文本；Tab 接受）
  inlineDisposable = registerInlineCompletionProvider({
    getEditor: () => editor,
    getCurrentPath: () => ws.currentFile,
    getWorkspace: () => ws.rootPath
  })
  // 异步完成 LSP 握手（不阻塞编辑器创建；ready 前 provider 自动返回空结果）
  void startLsp()

  // 若在编辑器延迟创建期间已有内容（文件被打开，或用户输入了未命名草稿），补加载一次
  if (ws.currentFile) {
    const m = editor.getModel()
    if (m) monaco.editor.setModelLanguage(m, effectiveLang.value)
    applyingValue = true
    editor.setValue(ws.currentContent)
    applyingValue = false
    ws.fileDirty = false
    editor.focus()
  } else if (ws.currentContent) {
    // 未命名草稿：恢复内容并保持脏标记
    applyingValue = true
    editor.setValue(ws.currentContent)
    applyingValue = false
  }
}

onBeforeUnmount(() => {
  readyObserver?.disconnect()
  resizeObserver?.disconnect()
  clearSaveFocusEffects()
  // LSP 资源清理：防抖定时器、provider 注册、语言服务器连接
  if (didChangeTimer !== null) window.clearTimeout(didChangeTimer)
  lspDisposable?.dispose()
  inlineDisposable?.dispose()
  void lspClient.stop()
  // s51 释放全部缓存的 Monaco 模型
  for (const m of modelCache.values()) m.dispose()
  modelCache.clear()
  editor?.dispose()
})

// 全局主题切换时，联动切换 Monaco 编辑器主题
watch(
  () => themeStore.theme,
  (t) => {
    monaco.editor.setTheme(`scholar-${t}`)
  }
)

// 监听 store 中文件切换，更新编辑器内容
watch(
  () => ws.currentFile,
  (file) => {
    void syncEditorToFile(file)
  }
)

// s51 Tab 关闭时释放对应 Monaco 模型：对比前后 openTabs，找出被移除的路径
let prevTabPaths = new Set(ws.openTabs.map((t) => t.path))
watch(
  () => ws.openTabs.map((t) => t.path),
  (paths) => {
    const cur = new Set(paths)
    for (const p of prevTabPaths) {
      if (!cur.has(p)) disposeModel(p)
    }
    prevTabPaths = cur
  }
)

// 文件切换实际编排（异步：打开 .vue 时可能需要先切换到 Volar）
async function syncEditorToFile(file: string | null): Promise<void> {
  if (!editor) return
  // 切换文件（含关闭、草稿另存为后绑定新路径）：放弃旧的手动语言选择，
  // 交还给自动识别按新文件扩展名判定
  manualLang.value = null
  // 文件被关闭（删除/移出工作区）：清空编辑区，避免中间仍显示已不存在的文件
  if (!file) {
    applyingValue = true
    editor.setValue('')
    applyingValue = false
    // 通知 LSP 关闭文档，并清空前模型的 markers
    lspClient.didClose()
    monaco.editor.setModelMarkers(editor.getModel()!, 'lsp', [])
    return
  }
  // 打开 .vue 且当前不是 Volar：先切换语言服务器（Take Over 仅升级不回退）
  if (file.toLowerCase().endsWith('.vue') && lspClient.serverKind !== 'vue') {
    try {
      await lspClient.start('vue', ws.rootPath, editApplier)
    } catch (err) {
      console.error('Vue 语言服务器切换失败：', err)
    }
  }
  // s51 Monaco 模型懒建：缓存中已有则直接 setModel（保留 undo/光标/选择），
  // 否则 createModel 并缓存；只在首次创建时写入内容
  let model = modelCache.get(file)
  if (!model) {
    model = monaco.editor.createModel(ws.currentContent, effectiveLang.value)
    modelCache.set(file, model)
  } else {
    // 缓存命中：若 store 内容比 model 新（外部修改落盘后重新读盘），同步内容
    if (model.getValue() !== ws.currentContent) {
      applyingValue = true
      model.setValue(ws.currentContent)
      applyingValue = false
    }
    monaco.editor.setModelLanguage(model, effectiveLang.value)
  }
  applyingValue = true
  editor.setModel(model)
  applyingValue = false
  // 注意：此处不再重置 ws.fileDirty——多 Tab 下切回未保存文件时脏标记由
  // store 快照恢复（openFile 已设置正确值），重置会丢脏导致关闭确认失效
  // 通知 LSP 打开新文档（内部自动关闭旧文档）；languageId 用生效语言
  lspClient.didOpen(file, effectiveLang.value, model.getValue())
  // 打开文件后强制重排一次，防止 view-lines 高度为 0 导致内容不绘制
  editor.layout()
  // 恢复该文件已有诊断到当前模型（诊断可能在打开前已推送）
  refreshCurrentMarkers({
    getEditor: () => editor,
    getCurrentPath: () => ws.currentFile
  })
  // 打开/新建文件后立即把焦点交给编辑器：
  // 否则右键新建（弹窗回车）或点击文件树后焦点停留在弹窗/树节点上，用户直接敲字无反应
  editor.focus()
}

/** s51 释放指定文件的缓存模型（Tab 关闭时调用） */
function disposeModel(path: string): void {
  const m = modelCache.get(path)
  if (m) {
    if (editor?.getModel() === m) {
      // 若释放的是当前激活模型，先切到空内容避免 Monaco 持有已 dispose 的模型
      applyingValue = true
      editor.setValue('')
      applyingValue = false
    }
    m.dispose()
    modelCache.delete(path)
  }
}

// 工作区切换（用户在 UI 中选择新目录）后重启 LSP，更新 rootUri 与服务器种类
watch(
  () => ws.rootPath,
  (newRoot) => {
    // LSP 尚未启动（初始工作区恢复中）：交由 startLsp 处理，避免重复启动
    if (lspClient.serverKind === null) return
    void restartLspForWorkspace(newRoot)
  }
)

async function restartLspForWorkspace(root: string | null): Promise<void> {
  try {
    let kind: LspServerKind = 'ts'
    if (root) kind = (await window.api.lsp.detectVue(root)) ? 'vue' : 'ts'
    // 显式停止旧服务器：即使种类相同也要重启以更新 rootUri
    await lspClient.stop()
    await lspClient.start(kind, root, editApplier)
    if (ws.currentFile) {
      lspClient.didOpen(ws.currentFile, effectiveLang.value, ws.currentContent)
      refreshCurrentMarkers({
        getEditor: () => editor,
        getCurrentPath: () => ws.currentFile
      })
    }
  } catch (err) {
    console.error('工作区切换后 LSP 重启失败：', err)
  }
}

// 文件保存完成（fileDirty 由 true → false）：通知 LSP didSave
watch(
  () => ws.fileDirty,
  (dirty, old) => {
    if (!dirty && old && ws.currentFile) {
      lspClient.didSave(ws.currentContent)
    }
  }
)

// 问题面板跳转请求：滚动到指定行列并设置光标（nonce 变化即触发）
watch(
  () => ws.revealRequest,
  (req) => {
    if (!editor || !req) return
    editor.revealLineInCenter(req.line)
    editor.setPosition({ lineNumber: req.line, column: req.column })
    editor.focus()
  }
)

// 生效语言变化（自动识别结果变化或手动切换）时，立即切换 Monaco 模型语言
watch(
  effectiveLang,
  (lang) => {
    const model = editor?.getModel()
    if (model && model.getLanguageId() !== lang) {
      monaco.editor.setModelLanguage(model, lang)
    }
  }
)

// 启动 LSP：按工作区是否含 .vue 选择服务器，完成 initialize 握手并同步当前文档
async function startLsp(): Promise<void> {
  // 等待工作区恢复完成，initialize 才能带上正确的 rootUri
  await ws.restoreReady
  try {
    // 默认服务器：工作区含 .vue → Volar（Take Over）；否则 typescript-language-server
    let kind: LspServerKind = 'ts'
    if (ws.rootPath) {
      kind = (await window.api.lsp.detectVue(ws.rootPath)) ? 'vue' : 'ts'
    }
    await lspClient.start(kind, ws.rootPath, editApplier)
    // 握手成功：若当前已有打开文件，补发 didOpen
    if (ws.currentFile) {
      lspClient.didOpen(ws.currentFile, effectiveLang.value, ws.currentContent)
      refreshCurrentMarkers({
        getEditor: () => editor,
        getCurrentPath: () => ws.currentFile
      })
    }
  } catch (err) {
    console.error('LSP 启动失败：', err)
  }
}

// Ctrl+S 保存：已有文件直接写盘；未命名草稿先询问文件名再落盘
// Ctrl/Cmd+K：选中代码 → 唤起 InlineEditWidget 流式改写；无选中 → 触发幽灵补全
onMounted(() => {
  const handler = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
      e.preventDefault()
      if (saveModalVisible.value) return
      void doSave()
      return
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault()
      e.stopPropagation()
      // 改写进行中：忽略后续 Cmd+K，避免重复触发
      if (inlineEditVisible.value) return
      if (!editor) return
      const sel = editor.getSelection()
      if (sel && !sel.isEmpty()) {
        // 选中非空：捕获快照，唤起改写组件
        inlineSelection.value = new monaco.Selection(
          sel.startLineNumber, sel.startColumn,
          sel.endLineNumber, sel.endColumn
        )
        inlineEditVisible.value = true
      } else {
        // 无选中：手动触发幽灵补全（InlineCompletionsProvider）
        editor.trigger('keyboard', 'editor.action.inlineSuggest.trigger', null)
      }
    }
  }
  window.addEventListener('keydown', handler)
  onBeforeUnmount(() => window.removeEventListener('keydown', handler))
})

// Ctrl+S：已有文件直接写盘；草稿已开始编辑则进入「另存为」流程
async function doSave(): Promise<void> {
  if (ws.currentFile) {
    await ws.saveCurrentFile()
    return
  }
  // 从未输入过：Ctrl+S 静默，避免无意义弹窗
  if (!ws.fileDirty) return
  await startSaveAs()
}

// 「另存为」流程入口（Ctrl+S 或点击标签栏「保存为…」）：
// 有工作区 → 应用内弹窗输入相对路径；无工作区 → 系统对话框选择任意位置
async function startSaveAs(): Promise<void> {
  if (!ws.rootPath) {
    const res = await ws.saveDraftViaDialog()
    if (!res.ok && !res.canceled) {
      // 用应用内提示替代 window.alert（后者同步阻塞渲染进程，远程桌面下可能冻死界面）
      noticeMessage.value = res.error || '未知错误'
      noticeVisible.value = true
    }
    return
  }
  openSaveModal()
}

// ---------- 轻量提示弹窗（替代 window.alert） ----------
const noticeVisible = ref(false)
const noticeMessage = ref('')
const noticeBtnRef = ref<HTMLButtonElement | null>(null)
function closeNotice(): void {
  noticeVisible.value = false
}
function onNoticeKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter' || e.key === 'Escape') {
    e.preventDefault()
    closeNotice()
  }
}
watch(noticeVisible, (v) => {
  if (v) nextTick(() => setTimeout(() => noticeBtnRef.value?.focus(), 0))
})

// ---------- 未命名草稿「保存为」弹窗 ----------
const saveModalVisible = ref(false)
const saveModalValue = ref('untitled.txt')
const saveModalError = ref('')
const saveModalBusy = ref(false)
const saveModalInputRef = ref<HTMLInputElement | null>(null)
// 健壮聚焦的定时器与窗口焦点回调（关闭/卸载时清理）
let saveFocusTimers: number[] = []
let saveWindowFocusHandler: (() => void) | null = null

function focusSaveInputRobust(): void {
  const doFocus = (): void => {
    const input = saveModalInputRef.value
    if (!input || !saveModalVisible.value) return
    input.focus()
    // 默认选中主文件名，方便直接键入替换
    const dot = saveModalValue.value.lastIndexOf('.')
    input.setSelectionRange(0, dot > 0 ? dot : saveModalValue.value.length)
  }
  saveFocusTimers.forEach((t) => window.clearTimeout(t))
  saveFocusTimers = [0, 50, 150, 300].map((delay) => window.setTimeout(doFocus, delay))
  // 窗口首次点击仅被激活时，在其真正获得前台焦点后把焦点补到输入框
  saveWindowFocusHandler = (): void => doFocus()
  window.addEventListener('focus', saveWindowFocusHandler)
}

function clearSaveFocusEffects(): void {
  saveFocusTimers.forEach((t) => window.clearTimeout(t))
  saveFocusTimers = []
  if (saveWindowFocusHandler) {
    window.removeEventListener('focus', saveWindowFocusHandler)
    saveWindowFocusHandler = null
  }
}

function openSaveModal(): void {
  saveModalValue.value = 'untitled.txt'
  saveModalError.value = ''
  saveModalVisible.value = true
  nextTick(() => focusSaveInputRobust())
}

function closeSaveModal(): void {
  if (saveModalBusy.value) return
  saveModalVisible.value = false
  clearSaveFocusEffects()
}

async function confirmSaveAs(): Promise<void> {
  if (saveModalBusy.value) return
  const name = saveModalValue.value.trim()
  if (!name) {
    saveModalError.value = '文件名不能为空'
    focusSaveInputRobust()
    return
  }
  saveModalBusy.value = true
  saveModalError.value = ''
  try {
    const res = await ws.saveUntitledAs(name)
    if (res.ok) {
      saveModalVisible.value = false
      clearSaveFocusEffects()
    } else {
      saveModalError.value = res.error || '保存失败'
      focusSaveInputRobust()
    }
  } catch (e: any) {
    // IPC 层异常也要明确展示，否则表现为点「确定」毫无反应
    saveModalError.value = e?.message || String(e) || '保存失败：请完全重启应用（主进程可能未更新）'
  } finally {
    saveModalBusy.value = false
  }
}

function onSaveModalKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter') {
    e.preventDefault()
    void confirmSaveAs()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    closeSaveModal()
  }
}

// 点击保存弹窗空白区域时保持输入框焦点
function onSaveBoxMouseDown(e: MouseEvent): void {
  const target = e.target as HTMLElement
  if (target.tagName !== 'INPUT' && target.tagName !== 'BUTTON') {
    e.preventDefault()
    saveModalInputRef.value?.focus()
  }
}
</script>

<template>
  <div class="editor-panel">
    <!-- 多文件 Tab 标签栏：切换/关闭（×或中键）/拖拽排序；全部关闭后隐藏并显示空白态 -->
    <div v-if="ws.openTabs.length || centerMode === 'preview'" class="tab-bar" @dragover.prevent>
      <template v-if="centerMode === 'editor'">
        <div
          v-for="(t, i) in ws.openTabs"
          :key="t.path"
          class="tab"
          :class="{ active: t.path === ws.currentFile }"
          :title="t.path"
          draggable="true"
          @click="activateTab(t.path)"
          @mousedown="onTabMouseDown($event, t.path)"
          @dragstart="onTabDragStart(i)"
          @drop="onTabDrop(i)"
          @dragover.prevent
        >
          <span class="tab-name">{{ tabName(t.path) }}</span>
          <span v-if="t.path === ws.currentFile ? ws.fileDirty : t.dirty" class="tab-dirty">●</span>
          <button class="tab-close" title="关闭" @click.stop="requestCloseTab(t.path)">×</button>
        </div>
      </template>
      <!-- 3.1 预览 Tab：与代码编辑互斥 -->
      <div
        class="tab preview-tab"
        :class="{ active: centerMode === 'preview' }"
        title="内置浏览器预览（localhost）"
        @click="switchToPreview"
      >
        <span class="tab-name">🌐 预览</span>
      </div>
      <!-- 编辑器模式入口（预览激活时回到编辑器） -->
      <div
        v-if="centerMode === 'preview'"
        class="tab"
        title="返回编辑器"
        @click="switchToEditor"
      >
        <span class="tab-name">← 编辑器</span>
      </div>
    </div>

    <div v-if="centerMode === 'editor'" class="editor-header">
      <!-- 左侧：当前文件 / 未命名草稿 / 空状态 -->
      <div class="header-left">
      <template v-if="ws.currentFile">
        <span class="file-path">{{ ws.currentFile }}</span>
        <span class="status" :class="{ dirty: ws.fileDirty }">
          {{ ws.fileDirty ? '●' : '已保存' }}
        </span>
      </template>
      <template v-else-if="ws.fileDirty">
        <!-- 未命名草稿：有内容但尚未关联磁盘文件 -->
        <span class="file-path draft">
          未命名草稿（{{ ws.rootPath ? '尚未保存到文件' : '未选择工作区，将保存到所选位置' }}）
        </span>
        <span class="status save-link" :title="MOD_KEY + '+S 保存为新文件'" @click="startSaveAs">保存为…</span>
      </template>
      <template v-else>
        <span class="file-path muted">未打开文件</span>
      </template>
      </div>
    </div>
    <!-- 3.1 编辑器/预览模式：互斥切换 -->
    <div v-if="centerMode === 'editor'" class="editor-body">
      <div ref="containerRef" class="editor-container"></div>
      <!-- 空白态：大号 Logo + 名称 + 三快捷操作卡片 -->
      <div v-if="showEmpty" class="editor-empty">
        <div class="empty-brand">
          <div class="empty-logo">⌘</div>
          <div class="empty-title">ScholarTreaCode</div>
          <div class="empty-hint">AI 本地编辑器 · 用对话驱动开发</div>
        </div>
        <div class="empty-actions">
          <button class="empty-card" @click="void ws.selectWorkspace()">
            <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
              <path fill="currentColor" d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Zm2 0v11h14V8H10l-2-2H5Z"/>
            </svg>
            <span class="ec-title">打开文件夹</span>
            <span class="ec-desc">选择工作区开始项目</span>
          </button>
          <button class="empty-card" @click="quickNewFile">
            <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
              <path fill="currentColor" d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9l-6-6Zm-1 1.5L16.5 10H13V7.5H12v-3ZM12 12v2H9v2h3v3h2v-3h3v-2h-3v-2h-2Z"/>
            </svg>
            <span class="ec-title">新建文件</span>
            <span class="ec-desc">在工作区根创建文件</span>
          </button>
          <button class="empty-card" @click="quickAskAi">
            <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
              <path fill="currentColor" d="M12 3a3 3 0 0 1 3 3v1h1a3 3 0 0 1 3 3v5a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3v-5a3 3 0 0 1 3-3h1V6a3 3 0 0 1 3-3Zm-3 9a1.2 1.2 0 1 0 0-2.4A1.2 1.2 0 0 0 9 12Zm6 0a1.2 1.2 0 1 0 0-2.4A1.2 1.2 0 0 0 15 12Zm-3 4c.9-1 2.3-1.5 3.8-1.5s2.9.5 3.8 1.5c.2.3.1.6-.1.8-.3.2-.6.1-.8-.1-.6-.6-1.5-.9-2.5-.9s-1.9.3-2.5.9c-.2.2-.5.3-.8.1-.2-.2-.3-.5-.1-.8Z"/>
            </svg>
            <span class="ec-title">问 AI</span>
            <span class="ec-desc">打开对话面板提问</span>
          </button>
        </div>
      </div>
    </div>
    <div v-else class="editor-body preview-body">
      <PreviewPanel />
    </div>

    <!-- 底部终端面板：用户命令与 AI 工具调用共用同一持久 shell -->
    <TerminalPanel />

    <!-- 底部状态栏：分支 / 光标行列 / 语言 / 编码 / 换行符 / 保存状态 -->
    <div class="status-bar">
      <span v-if="currentBranch" class="sb-item sb-branch">
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M5 3a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Zm-1.5 0a.5.5 0 1 0-1 0 .5.5 0 0 0 1 0ZM10 5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3ZM8.5 3.5a.5.5 0 1 0 1 0 .5.5 0 0 0-1 0ZM4.5 7h2a1 1 0 0 0 1-1V5.2A2.5 2.5 0 0 0 10 5.5v1a1 1 0 0 1-1 1H7.5a1 1 0 0 0-1 1v4.3a1.5 1.5 0 1 1-1 0V7.5a1 1 0 0 1 1-1Z"/></svg>
        {{ currentBranch }}
      </span>
      <span class="sb-item">行 {{ cursorLine }}，列 {{ cursorCol }}</span>
      <span class="sb-spacer"></span>
      <button class="sb-btn">UTF-8</button>
      <button class="sb-btn">LF</button>
      <select class="sb-select" :value="effectiveLang" @change="onLangChange" title="选择代码语言">
        <option value="__auto__">自动：{{ currentLangLabel }}</option>
        <option v-for="lang in langOptions" :key="lang.id" :value="lang.id">{{ lang.label }}</option>
      </select>
      <span class="sb-item" :class="{ dirty: ws.fileDirty }">
        {{ ws.fileDirty ? '未保存' : '已保存' }}
      </span>
    </div>

    <!-- 未命名草稿首次保存：输入文件名 -->
    <template v-if="saveModalVisible">
      <div class="modal-overlay" @click.self="closeSaveModal">
        <div class="name-modal cp-glass" @keydown="onSaveModalKeydown">
          <div class="modal-title">保存新文件</div>
          <input
            ref="saveModalInputRef"
            v-model="saveModalValue"
            class="modal-input"
            type="text"
            spellcheck="false"
            placeholder="文件名，支持相对路径，如 src/index.ts"
          />
          <div v-if="saveModalError" class="modal-error">{{ saveModalError }}</div>
          <div class="modal-actions">
            <button class="cp-btn" :disabled="saveModalBusy" @click="closeSaveModal">取消</button>
            <button class="cp-btn cp-btn-primary" :disabled="saveModalBusy" @click="confirmSaveAs">
              {{ saveModalBusy ? '保存中...' : '保存' }}
            </button>
          </div>
        </div>
      </div>
    </template>

    <!-- 轻量提示（替代阻塞式 window.alert） -->
    <template v-if="noticeVisible">
      <div class="modal-overlay" @click.self="closeNotice">
        <div class="name-modal cp-glass notice-modal" @keydown="onNoticeKeydown">
          <div class="modal-title">保存失败</div>
          <div class="notice-message">{{ noticeMessage }}</div>
          <div class="modal-actions">
            <button ref="noticeBtnRef" class="cp-btn cp-btn-primary" @click="closeNotice">知道了</button>
          </div>
        </div>
      </div>
    </template>

    <!-- 未保存 Tab 关闭确认：保存并关 / 不保存 / 取消 -->
    <template v-if="closeConfirmPath">
      <div class="modal-overlay" @click.self="cancelCloseTab">
        <div class="name-modal cp-glass notice-modal">
          <div class="modal-title">关闭前保存？</div>
          <div class="notice-message">{{ tabName(closeConfirmPath) }} 有未保存的更改，关闭后将丢失。</div>
          <div class="modal-actions">
            <button class="cp-btn" @click="cancelCloseTab">取消</button>
            <button class="cp-btn" @click="confirmDiscardClose">不保存</button>
            <button class="cp-btn cp-btn-primary" @click="confirmSaveAndClose">保存并关闭</button>
          </div>
        </div>
      </div>
    </template>

    <!-- 内联 AI 改写组件（Cmd+K 选中代码后唤起；流式就地替换 + Tab 接受 / Esc 回退） -->
    <InlineEditWidget
      v-if="inlineEditVisible"
      :visible="inlineEditVisible"
      :editor="editor"
      :selection="inlineSelection"
      :current-path="ws.currentFile"
      :content="ws.currentContent"
      :workspace="ws.rootPath"
      @close="inlineEditVisible = false"
    />
  </div>
</template>

<style scoped>
.editor-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-primary);
}

.editor-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.file-path {
  font-size: 12px;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  flex: 0 1 auto;
}

/* 左侧文件信息组：路径过长时省略，把空间让给语言选择器 */
.header-left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  flex: 1;
  margin-right: 12px;
}

/* ---------- 语言识别 / 选择器（已迁至底部状态栏，保留占位） ---------- */

.file-path.muted {
  color: var(--text-muted);
}

.file-path.draft {
  color: var(--warning);
}

.status {
  font-size: 11px;
  color: var(--success);
}

.status.dirty {
  color: var(--warning);
}

/* 未命名草稿的「保存为…」操作入口 */
.save-link {
  color: var(--accent, #00d4ff);
  cursor: pointer;
  user-select: none;
}

.save-link:hover {
  text-decoration: underline;
}

.editor-container {
  flex: 1;
  /* 显式铺满父容器，配合 Monaco 的 layout() 保证不留黑带 */
  width: 100%;
  min-height: 0;
  overflow: hidden;
}

/* ---------- Tab 标签栏 ---------- */
.tab-bar {
  display: flex;
  align-items: stretch;
  overflow-x: auto;
  overflow-y: hidden;
  flex-shrink: 0;
  background: var(--bg-secondary, rgba(255, 255, 255, 0.02));
  border-bottom: 1px solid var(--border-light);
  scrollbar-width: thin;
}

.tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  max-width: 180px;
  flex-shrink: 0;
  cursor: pointer;
  user-select: none;
  border-right: 1px solid var(--border-light);
  color: var(--text-secondary, var(--text-primary));
  font-size: 12px;
  border-top: 2px solid transparent;
}

.tab:hover {
  background: rgba(255, 255, 255, 0.04);
}

.tab.active {
  background: var(--bg-primary);
  color: var(--text-primary);
  border-top-color: var(--accent);
}

.tab-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tab-dirty {
  color: var(--accent);
  font-size: 10px;
  flex-shrink: 0;
}

.tab-close {
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  padding: 0 2px;
  border-radius: 4px;
  opacity: 0.6;
  flex-shrink: 0;
}

.tab-close:hover {
  opacity: 1;
  background: rgba(255, 255, 255, 0.1);
}

/* ---------- 编辑器主体包裹（承载空白态覆盖层） ---------- */
.editor-body {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
}

.editor-empty {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 32px;
  background: var(--bg-panel);
  padding: 24px;
}

.empty-brand {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}
.empty-logo {
  width: 64px;
  height: 64px;
  border-radius: 16px;
  background: linear-gradient(135deg, var(--primary), #8B5CF6);
  color: #fff;
  font-size: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 8px 24px rgba(99, 102, 241, 0.35);
}
.empty-title {
  font-size: 22px;
  font-weight: 600;
  color: var(--text-primary);
  letter-spacing: 0.5px;
}
.empty-hint {
  font-size: 13px;
  color: var(--text-secondary);
}

.empty-actions {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  justify-content: center;
}
.empty-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  width: 140px;
  padding: 20px 12px;
  background: var(--bg-hover);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  cursor: pointer;
  transition: transform 0.15s, border-color 0.15s, color 0.15s, background 0.15s;
}
.empty-card:hover {
  transform: translateY(-3px);
  border-color: var(--primary);
  color: var(--primary);
  background: var(--bg-elevated);
}
.empty-card .ec-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}
.empty-card:hover .ec-title {
  color: var(--primary);
}
.empty-card .ec-desc {
  font-size: 11px;
  color: var(--text-muted);
  text-align: center;
  line-height: 1.4;
}

/* ---------- 底部状态栏 ---------- */
.status-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 3px 12px;
  flex-shrink: 0;
  font-size: 11px;
  color: var(--text-secondary);
  background: var(--bg-panel);
  border-top: 1px solid var(--border);
  font-family: var(--font-sans);
}

.sb-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.sb-branch {
  color: var(--text-secondary);
}
.sb-branch svg {
  color: var(--primary);
}

.sb-spacer {
  flex: 1;
}

/* 小巧文字按钮：hover 变品牌色 */
.sb-btn {
  background: transparent;
  border: none;
  color: var(--text-secondary);
  font-size: 11px;
  font-family: inherit;
  padding: 2px 6px;
  border-radius: 4px;
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}
.sb-btn:hover {
  color: var(--primary);
  background: var(--bg-hover);
}

/* 底部状态栏语言下拉：紧凑、与文字按钮同高 */
.sb-select {
  background: transparent;
  border: none;
  color: var(--text-secondary);
  font-size: 11px;
  font-family: inherit;
  padding: 2px 4px;
  border-radius: 4px;
  cursor: pointer;
  outline: none;
  max-width: 120px;
}
.sb-select:hover {
  color: var(--primary);
  background: var(--bg-hover);
}
.sb-select option {
  background: var(--bg-panel);
  color: var(--text-primary);
}

.sb-item.dirty {
  color: var(--warning);
}

/* ---------- 未命名草稿「保存为」弹窗（与文件树名称弹窗同款） ---------- */
.modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 920;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
}

.name-modal {
  width: 340px;
  max-width: calc(100vw - 40px);
  padding: 16px;
  border-radius: 10px;
  border: 1px solid var(--border-light);
}

.modal-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 10px;
}

.modal-input {
  width: 100%;
  padding: 7px 10px;
  background: var(--bg-primary);
  border: 1px solid var(--border-light);
  border-radius: 6px;
  color: var(--text-primary);
  font-family: inherit;
  font-size: 13px;
  outline: none;
  box-sizing: border-box;
}

.modal-input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--border-glow);
}

.modal-error {
  margin-top: 8px;
  font-size: 12px;
  color: var(--danger, #ff6b6b);
  word-break: break-all;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
}

/* ---------- 轻量提示弹窗 ---------- */
.notice-modal {
  width: 360px;
}

.notice-message {
  margin-top: 4px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-secondary, var(--text-primary));
  white-space: pre-line;
  word-break: break-all;
}
</style>
