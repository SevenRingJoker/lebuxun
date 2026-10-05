<script setup lang="ts">
// AI 聊天面板：消息列表、模型选择、发送框、工具调用模式切换
import { ref, reactive, computed, nextTick, watch, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { useChatStore } from '../stores/chat'
import { useWorkspaceStore } from '../stores/workspace'
import { useGitStore } from '../stores/git'
import { useStagingStore } from '../stores/staging'
import { useBuildStore } from '../stores/build'
import { useTimelineStore } from '../stores/timeline'
import { useKanbanStore } from '../stores/kanban'
import { useDebugStore } from '../stores/debug'
import { useScholarStore } from '../stores/scholar'
import { renderMarkdown } from '../utils/markdown'
import MentionPicker from './MentionPicker.vue'
import SessionHistory from './SessionHistory.vue'
import ToolEventCard from './ToolEventCard.vue'
import DriftReportCard from './DriftReportCard.vue'
import TaskRecoveryBar from './TaskRecoveryBar.vue'
import { stripDriftSection } from '@shared/drift/driftView'
import type { ChatMessage } from '../stores/chat'
import type { UiDebugEvent } from '../api'

const chat = useChatStore()
const ws = useWorkspaceStore()
const git = useGitStore()
const staging = useStagingStore()
const build = useBuildStore()
const timeline = useTimelineStore()
const kanban = useKanbanStore()
const debug = useDebugStore()
const scholar = useScholarStore()
const { t } = useI18n()
const input = ref('')

// ---------- 自适应模型状态栏 ----------
// 模型清单完全来自 Ollama 动态发现（ai:listAvailableModels），无任何硬编码模型名；
// 当前激活模型随调度器 ai:modelCall 事件实时更新。
const availableModelCount = ref(-1) // -1 = 尚未查询
const modelQueryError = ref('')
const activeModelName = ref('')
const modelStatusText = computed(() => {
  if (modelQueryError.value) return '⚠ Ollama 未启动'
  if (availableModelCount.value === 0) return '⚠ 未检测到任何模型'
  if (availableModelCount.value > 0) {
    return activeModelName.value
      ? `✓ 检测到 ${availableModelCount.value} 个模型 当前: ${activeModelName.value}`
      : `✓ 检测到 ${availableModelCount.value} 个模型`
  }
  return ''
})
async function refreshAvailableModels(): Promise<void> {
  try {
    const res = await window.api.ai.listAvailableModels()
    if (res.ok) {
      availableModelCount.value = res.models.length
      modelQueryError.value = ''
    } else {
      availableModelCount.value = -1
      modelQueryError.value = res.error || 'Ollama 未启动'
    }
  } catch {
    availableModelCount.value = -1
    modelQueryError.value = 'Ollama 未启动'
  }
}
onMounted(() => {
  void refreshAvailableModels()
  // 任务跑起来后按模型调用事件更新当前激活模型
  window.api.ai.onModelCall((p) => {
    if (p?.model) activeModelName.value = p.model
  })
})

// ---------- 3.2 元素选择预填 ----------
// 接收预览页采集的元素信息，预填「修改这个元素：...」
const elementPick = ref<{
  selector: string
  outerHTML: string
  bounds: { x: number; y: number; width: number; height: number }
  tagName: string
  text: string
} | null>(null)
const useTools = ref(true)
const messagesRef = ref<HTMLDivElement | null>(null)
// @ 引用浮层状态：mentionToken 为 @ 后已输入的 token，null 表示浮层关闭
const mentionToken = ref<string | null>(null)
const pickerRef = ref<InstanceType<typeof MentionPicker> | null>(null)
// @ 符号在文本中的位置（普通变量即可，不参与渲染）
let mentionAt = -1
// 输入框 DOM 引用：用于随内容自动增高
const textareaRef = ref<HTMLTextAreaElement | null>(null)

// Git 入口按钮提示文案（随仓库状态变化）
const gitBtnTitle = computed(() => {
  if (!git.gitAvailable) return '未检测到本机 git'
  if (git.isRepo === false) return '当前工作区不是 Git 仓库，点击可初始化'
  return git.changes.length
    ? `查看 ${git.changes.length} 个改动文件并对比差异`
    : '工作区干净，点击查看检查点历史'
})

// 打开差异面板前先刷新一次，保证看到最新改动
function onGitClick(): void {
  if (!git.gitAvailable) return
  git.openViewer()
  void git.refresh()
}

// 打开统一设置页并跳转到指定 Tab（App.vue 监听此自定义事件，组件解耦）
function openSettings(tab: 'models' | 'mcp' | 'rulesSkills'): void {
  window.dispatchEvent(new CustomEvent('scholar:open-settings', { detail: { tab } }))
}

onMounted(() => { void git.refresh() })
// 3.2 预览页元素选择：接收 preview:picked 事件，预填「修改这个元素」
onMounted(() => {
  window.api.preview.onPicked((data) => {
    elementPick.value = data
    // 预填 prompt：选择器 + 元素文本摘要
    const summary = data.text.slice(0, 50) || data.tagName
    input.value = `修改这个元素：${data.selector}（${summary}）\n\n`
  })
})
// 命令「切换工具调用模式」经自定义事件桥接到本地 useTools 状态
function onToggleToolsEvent(): void { useTools.value = !useTools.value }
window.addEventListener('scholar:toggle-tools', onToggleToolsEvent)
onBeforeUnmount(() => window.removeEventListener('scholar:toggle-tools', onToggleToolsEvent))

// 终端失败命令「AI 修复」：预填诊断 prompt（不自动发送，用户确认后 Enter）
interface FixTerminalDetail {
  command: string
  summary: string
  severity?: 'auto' | 'manual'
  hints?: string[]
  cwd?: string
}
function onFixTerminalErrorEvent(e: Event): void {
  const d = (e as CustomEvent<FixTerminalDetail>).detail
  if (!d?.command) return
  const cwdLine = d.cwd ? `工作目录：${d.cwd}\n` : ''
  const severityLine = d.severity === 'manual'
    ? '处理分级：需用户介入（安装运行时/系统命令/权限等，不要尝试 sudo 或替用户执行系统级命令）\n'
    : '处理分级：AI 可自修\n'
  const hintsLine = d.hints && d.hints.length > 0 ? `修复方向参考：\n${d.hints.map((h) => `- ${h}`).join('\n')}\n` : ''
  input.value =
    `终端命令执行失败，请诊断原因并直接修复：\n${cwdLine}命令：${d.command}\n诊断摘要：${d.summary}\n${severityLine}${hintsLine}` +
    '请先分析根因（必要时读取相关文件/配置），修复后重新执行该命令验证。'
  // 修复大概率需要读写文件与跑命令，确保工具调用模式开启
  useTools.value = true
  requestAnimationFrame(() => {
    textareaRef.value?.focus()
    autoResize()
  })
}
window.addEventListener('scholar:fix-terminal-error', onFixTerminalErrorEvent)
onBeforeUnmount(() => window.removeEventListener('scholar:fix-terminal-error', onFixTerminalErrorEvent))

// s52 调试异常停驻：自动预填修复 prompt（不自动发送，用户确认后 Enter）
function onDebugException(ev: UiDebugEvent): void {
  if (ev.kind !== 'exception') return
  const topFrame = ev.stack[0]
  const frameText = topFrame
    ? `停驻位置：${topFrame.file}:${topFrame.line}（${topFrame.name}）\n`
    : ''
  const varsText = ev.variables.length > 0
    ? '关键变量快照：\n' + ev.variables.slice(0, 15).map((v) => `- ${v.name} = ${v.value}`).join('\n') + '\n'
    : ''
  input.value =
    `程序运行时抛出异常，请诊断并修复：\n异常：${ev.description}\n${frameText}${varsText}` +
    '请先读取相关源码定位根因，修复后说明验证方式（可继续运行调试或跑测试确认）。'
  useTools.value = true
  requestAnimationFrame(() => {
    textareaRef.value?.focus()
    autoResize()
  })
}
onMounted(() => {
  window.api.debug.onEvent(onDebugException)
})
// 切换工作区后重新探测仓库 + 同步暂存开关与摘要
watch(
  () => ws.rootPath,
  (root) => {
    void git.refresh()
    void staging.loadEnabled(root)
    void staging.refresh(root)
  }
)

// ㊝ 任务结束（taskPhase 回 idle）且暂存非空：提示条提醒先审阅再视为完成
const showStageNotice = computed(
  () => staging.enabled && chat.taskPhase === 'idle' && staging.total > 0
)
function onStageBtnClick(): void {
  void staging.openPanel(ws.rootPath)
}

const displayMessages = computed(() => chat.messages)

// 最后一条 assistant 消息索引：偏差卡片挂在该 msg-row 的气泡之后
// （任务收尾可能还追加了 system 完成提示，故不能直接用 messages.length - 1）
const lastAssistantIdx = computed(() => {
  for (let i = displayMessages.value.length - 1; i >= 0; i--) {
    if (displayMessages.value[i].role === 'assistant') return i
  }
  return -1
})

/**
 * assistant 气泡实际渲染内容：
 * 实时偏差报告存在时，㉚ 追加到末尾的偏差文本块已由卡片结构化展示，
 * 渲染 Markdown 前先剥离，避免「卡片 + 文本」重复；
 * 重载历史会话无 liveDrift → 走原文，偏差文本仍是历史态的唯一载体。
 */
function assistantDisplayContent(msg: ChatMessage): string {
  return chat.liveDrift ? stripDriftSection(msg.content) : msg.content
}

/**
 * ㉜ 偏差明细行点击：相对路径拼工作区根。
 * 文件存在 → 直接打开；不存在（典型 missingArtifact）→ 确认后让 AI 一键生成。
 * 用 readFile 探测存在性：主进程未暴露独立 exists 通道，读取失败即视为缺失。
 */
async function onDriftLocate(detail: string, relPath: string): Promise<void> {
  if (!ws.rootPath) return
  const abs = ws.rootPath.replace(/[\\/]+$/, '') + '\\' + relPath.replace(/\//g, '\\')
  try {
    await window.api.fs.readFile(abs)
    await ws.openFile(abs)
  } catch {
    if (window.confirm(`文件 ${relPath} 尚不存在，是否让 AI 立即生成？`)) {
      await chat.generateMissing(detail)
    }
  }
}

/** 缺失产物「生成」按钮：走 store 固定指令模板 */
async function onDriftGenerate(detail: string): Promise<void> {
  await chat.generateMissing(detail)
}

/**
 * 🛑 物理阻断态操作：
 * - 重试任务：携带 FORCED-RECOVERY 标签重开工具循环（store 注入三阶段固定流程）；
 * - 查看偏差报告：滚动到底部并高亮偏差卡片；
 * - 手动解锁：用户确认风险后解除输入锁定（不推荐，弱化为次级文字按钮）。
 */
const driftFlash = ref(false)
async function onRetryBlocked(): Promise<void> {
  await chat.retryBlockedTask()
}
async function onShowDriftReport(): Promise<void> {
  await nextTick()
  messagesRef.value?.scrollTo({ top: messagesRef.value.scrollHeight, behavior: 'smooth' })
  driftFlash.value = false
  // 下一帧再置 true，保证重复点击也能重新触发动画
  requestAnimationFrame(() => { driftFlash.value = true })
  window.setTimeout(() => { driftFlash.value = false }, 2200)
}
function onDismissBlocked(): void {
  chat.dismissBlocked()
}

// TODO 清单完成数（Agent 通过 todo_write 工具自主维护）
const doneTodoCount = computed(() => chat.todos.filter((t) => t.status === 'completed').length)

// 权限模式分段切换选项
const permissionModes = [
  { value: 'readonly' as const, key: 'readonly' },
  { value: 'ask' as const, key: 'ask' },
  { value: 'auto' as const, key: 'auto' }
]

// 审批条中的工具名中文化
const PERM_TOOL_LABELS: Record<string, string> = {
  write: '写入文件',
  write_file: '写入文件',
  edit: '编辑文件',
  edit_file: '编辑文件',
  create_directory: '创建目录',
  move_file: '移动文件',
  delete_file: '删除文件',
  copy_file: '复制文件',
  bash: '执行终端命令',
  run_terminal_command: '执行终端命令',
  read: '读取文件',
  read_file: '读取文件',
  grep: '内容搜索',
  glob: '文件搜索'
}
const permToolLabel = computed(
  () => PERM_TOOL_LABELS[chat.permission?.tool || ''] || chat.permission?.tool || '工具调用'
)

// 自动滚到底部：消息数量变化或流式内容更新时触发
watch(
  () => [chat.messages.length, chat.thinkingHint, chat.messages[chat.messages.length - 1]?.content.length],
  async () => {
    await nextTick()
    messagesRef.value?.scrollTo({ top: messagesRef.value.scrollHeight, behavior: 'smooth' })
  },
  { flush: 'post' }
)

// ===== 2.3 图片附件输入（粘贴 / 拖拽 / 文件选择 / 剪贴板截图）=====
/** 待发送图片草稿（尚未落盘，仅存 data URL 用于缩略图） */
interface DraftImage {
  id: string
  mimeType: string
  dataUrl: string
}
const draftImages = ref<DraftImage[]>([])
// 隐藏的文件选择框引用
const fileInputRef = ref<HTMLInputElement | null>(null)
// 拖拽悬停态（输入器高亮）
const dragOver = ref(false)
// 剪贴板读取失败等弱提示（几秒后自动消失）
const attachWarn = ref('')
let attachWarnTimer: ReturnType<typeof setTimeout> | null = null

/** Blob → data URL，顺带取归一化 MIME */
async function blobToDataUrl(blob: Blob): Promise<{ mimeType: string; dataUrl: string }> {
  const mimeType = blob.type && blob.type.startsWith('image/')
    ? blob.type
    : 'image/png'
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
  return { mimeType, dataUrl }
}

/** 弱提示：展示 4s 自动清除（不使用原生 alert） */
function showAttachWarn(text: string): void {
  attachWarn.value = text
  if (attachWarnTimer) clearTimeout(attachWarnTimer)
  attachWarnTimer = setTimeout(() => { attachWarn.value = '' }, 4000)
}

/** 批量加入图片草稿（过滤非图片、上限 6 张）；剪贴板项是 Blob、文件选择是 File，统一按 Blob 接收 */
async function addImageFiles(files: ArrayLike<Blob> | Blob[]): Promise<void> {
  const list = Array.from(files).filter((f) => f.type.startsWith('image/'))
  if (list.length === 0) return
  for (const f of list) {
    if (draftImages.value.length >= 6) {
      showAttachWarn('单条消息最多附带 6 张图片')
      break
    }
    try {
      const { mimeType, dataUrl } = await blobToDataUrl(f)
      draftImages.value.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        mimeType,
        dataUrl
      })
    } catch {
      showAttachWarn('图片读取失败，请重试')
    }
  }
}

/** 粘贴：剪贴板含图片则加入草稿（不阻止文本正常粘贴） */
function onPaste(e: ClipboardEvent): void {
  const items = e.clipboardData?.items
  if (!items) return
  const images: File[] = []
  for (const it of items) {
    if (it.kind === 'file' && it.type.startsWith('image/')) {
      const f = it.getAsFile()
      if (f) images.push(f)
    }
  }
  if (images.length > 0) void addImageFiles(images)
}

/** 拖拽：阻止浏览器默认打开文件，接收图片 */
function onDragOver(e: DragEvent): void {
  e.preventDefault()
  dragOver.value = true
}
function onDragLeave(): void {
  dragOver.value = false
}
function onDrop(e: DragEvent): void {
  e.preventDefault()
  dragOver.value = false
  if (e.dataTransfer?.files?.length) void addImageFiles(e.dataTransfer.files)
}

/** 附件按钮 → 打开文件选择 */
function pickFiles(): void {
  fileInputRef.value?.click()
}
function onFilePicked(e: Event): void {
  const inputEl = e.target as HTMLInputElement
  if (inputEl.files?.length) void addImageFiles(inputEl.files)
  // 清空 value，允许再次选择同一文件
  inputEl.value = ''
}

/**
 * 剪贴板截图：navigator.clipboard.read() 读取 image/png（系统截图后直接点此按钮）。
 * 权限被拒 / 无图片时给弱提示。
 */
async function pasteClipboardImage(): Promise<void> {
  if (!navigator.clipboard?.read) {
    showAttachWarn('当前环境不支持剪贴板读取，可直接 Ctrl+V 粘贴截图')
    return
  }
  try {
    const items = await navigator.clipboard.read()
    const images: Blob[] = []
    for (const item of items) {
      if (item.types.some((t) => t.startsWith('image/'))) {
        images.push(await item.getType(item.types.find((t) => t.startsWith('image/'))!))
      }
    }
    if (images.length === 0) {
      showAttachWarn('剪贴板中没有图片')
      return
    }
    await addImageFiles(images)
  } catch {
    showAttachWarn('剪贴板读取被拒绝，可直接在输入框 Ctrl+V 粘贴')
  }
}

function removeDraft(id: string): void {
  draftImages.value = draftImages.value.filter((d) => d.id !== id)
}

/**
 * 视觉门控：显式选定模型且无视觉能力 → 禁用附件；自动路由不拦截。
 * 依据主进程 ModelCapabilities.vision（预设矩阵 + 名字启发）。
 */
const currentModelEntry = computed(() => {
  if (!chat.model || chat.model === 'auto') return null
  return chat.modelGroups.flatMap((g) => g.models).find((m) => m.id === chat.model) ?? null
})
const visionBlocked = computed(
  () => currentModelEntry.value !== null && currentModelEntry.value.capabilities.vision === false
)
const attachmentsEnabled = computed(() => !!ws.rootPath && !visionBlocked.value)
const attachBtnTitle = computed(() => {
  if (!ws.rootPath) return '请先打开工作区文件夹（附件存于工作区 .trae/attachments）'
  if (visionBlocked.value) return `当前模型「${currentModelEntry.value!.displayName}」不支持图片输入`
  return '添加图片附件（也可直接粘贴或拖拽）'
})

// 历史会话中的附件按路径懒加载为 data URL（响应式 Map 缓存）
const imageCache = reactive(new Map<string, string>())
const failedImages = ref<Set<string>>(new Set())
async function ensureImage(path: string): Promise<void> {
  if (imageCache.has(path) || failedImages.value.has(path)) return
  try {
    const r = await window.api.ai.readAttachment(path, ws.rootPath ?? undefined)
    if (r.ok && r.dataUrl) {
      imageCache.set(path, r.dataUrl)
    } else {
      failedImages.value.add(path)
    }
  } catch {
    failedImages.value.add(path)
  }
}
/** 消息列表变化时补齐所有附件图片 */
watch(
  () => chat.messages.map((m) => m.attachments?.map((a) => a.path).join(',') ?? '').join('|'),
  () => {
    for (const m of chat.messages) {
      for (const a of m.attachments ?? []) void ensureImage(a.path)
    }
  },
  { immediate: true }
)

// 发送按钮可用条件：有文本或图片且当前不在发送中
const canSend = computed(
  () => (input.value.trim().length > 0 || draftImages.value.length > 0) && !chat.sending
)

async function onSend(): Promise<void> {
  let text = input.value.trim()
  // 图片落盘到工作区附件目录，消息只携带路径引用
  let attachments: { path: string; mimeType: string }[] = []
  // 3.2 元素选择：发送时把选择器/HTML 追加到 prompt 末尾（截图走 attachments）
  if (elementPick.value) {
    const ep = elementPick.value
    text += `\n\n元素信息：\n- 选择器：${ep.selector}\n- 标签：<${ep.tagName}>\n- 文本：${ep.text.slice(0, 100)}\n- HTML：\n\`\`\`html\n${ep.outerHTML.slice(0, 2000)}\n\`\`\``
    if (ws.rootPath) {
      const cap = await window.api.preview.captureElement(ep.bounds)
      if (cap.ok && cap.dataUrl) {
        const data = cap.dataUrl.slice(cap.dataUrl.indexOf(',') + 1)
        const r = await window.api.ai.saveAttachment({
          workspace: ws.rootPath,
          mimeType: 'image/png',
          data
        })
        if (r.ok && r.path) attachments.push({ path: r.path, mimeType: 'image/png' })
      }
    }
    elementPick.value = null
  }
  if (draftImages.value.length > 0) {
    if (!ws.rootPath) {
      showAttachWarn('请先打开工作区文件夹后再发送图片')
      return
    }
    for (const d of draftImages.value) {
      // data URL 去掉前缀取 base64
      const data = d.dataUrl.slice(d.dataUrl.indexOf(',') + 1)
      const r = await window.api.ai.saveAttachment({
        workspace: ws.rootPath,
        mimeType: d.mimeType,
        data
      })
      if (r.ok && r.path) {
        attachments.push({ path: r.path, mimeType: d.mimeType })
      } else {
        showAttachWarn(r.error || '附件保存失败，已中止发送')
        return
      }
    }
  }
  if ((!text && attachments.length === 0) || chat.sending) return
  draftImages.value = []
  input.value = ''
  closeMention()
  // 发送后重置输入框高度
  requestAnimationFrame(() => autoResize())
  if (useTools.value) {
    await chat.sendWithTools(text, attachments.length ? attachments : undefined)
  } else {
    await chat.send(text, attachments.length ? attachments : undefined)
  }
  await nextTick()
  messagesRef.value?.scrollTo({ top: messagesRef.value.scrollHeight, behavior: 'smooth' })
}

// ===== ㊜ 1b 放弃确认（暂停态 live 任务）=====
// 放弃可选回滚（reset --hard 是破坏性操作），与恢复条放弃同款行内确认
const showAbandonConfirm = ref(false)
const rollbackChecked = ref(true)

function openAbandonConfirm(): void {
  rollbackChecked.value = !!chat.activeCheckpoint
  showAbandonConfirm.value = true
}
function cancelAbandonConfirm(): void {
  showAbandonConfirm.value = false
}
async function confirmAbandon(): Promise<void> {
  const rollback = rollbackChecked.value && !!chat.activeCheckpoint
  showAbandonConfirm.value = false
  await chat.abortRunning(rollback)
}

function onKeydown(e: KeyboardEvent): void {
  // 浮层打开时 ↑↓/Enter/Tab/Esc 先交给候选浮层处理（不抢焦点方案：由 textarea 转发）
  if (mentionToken.value !== null && pickerRef.value) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      pickerRef.value.moveDown()
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      pickerRef.value.moveUp()
      return
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      if (pickerRef.value.selectActive()) return
      // 无候选时 Enter 回落到发送、Tab 直接关浮层
      if (e.key === 'Tab') {
        closeMention()
        return
      }
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      closeMention()
      return
    }
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    onSend()
  }
}

// 输入事件：自动增高 + 重新探测 @ 引用（v-model 已先于此同步 input）
function onComposerInput(): void {
  autoResize()
  detectMention()
}

/**
 * 根据光标位置探测 @ 引用：
 * 光标前文本须以「@ + 合法 token」结尾，且 @ 位于行首或空白/标点之后。
 */
function detectMention(): void {
  const el = textareaRef.value
  if (!el || !ws.rootPath) {
    mentionToken.value = null
    return
  }
  const pos = el.selectionStart ?? input.value.length
  const upto = input.value.slice(0, pos)
  const m = /(^|[\s，。；：、（）()【】[\]])@([\w./\\:一-鿿]*)$/.exec(upto)
  if (m) {
    mentionAt = m.index + m[1].length
    mentionToken.value = m[2]
  } else {
    mentionToken.value = null
    mentionAt = -1
  }
}

function closeMention(): void {
  mentionToken.value = null
  mentionAt = -1
}

/** 浮层选中后把 @token 片段替换为完整引用文本，并把光标置于引用之后 */
function insertMention(text: string): void {
  const el = textareaRef.value
  if (!el) return
  const pos = el.selectionStart ?? input.value.length
  const start = mentionAt >= 0 ? mentionAt : pos
  const before = input.value.slice(0, start)
  const after = input.value.slice(pos)
  input.value = before + text + after
  const caret = before.length + text.length
  closeMention()
  void nextTick(() => {
    el.focus()
    el.setSelectionRange(caret, caret)
    autoResize()
  })
}

// 输入框随内容自动增高（44px ~ 160px），超出后内部滚动
function autoResize(): void {
  const el = textareaRef.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 160) + 'px'
}
</script>

<template>
  <div class="chat-panel">
    <!-- 头部：标题 + 会话操作 + 权限模式切换 + 连接状态 -->
    <div class="chat-header">
      <div class="title-wrap">
        <span class="title">{{ t('chat.title') }}</span>
        <span v-if="chat.currentTitle" class="session-sub" :title="chat.currentTitle">{{ chat.currentTitle }}</span>
      </div>
      <div class="header-right">
        <!-- 会话操作：新建 / 历史 -->
        <button
          class="session-btn"
          :disabled="chat.sending"
          :title="chat.sending ? t('chat.newSession') : t('chat.newSession')"
          @click="void chat.newSession()"
        >
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
            <path fill="currentColor" d="M8 2a.8.8 0 0 1 .8.8v4.4h4.4a.8.8 0 0 1 0 1.6H8.8v4.4a.8.8 0 0 1-1.6 0V8.8H2.8a.8.8 0 0 1 0-1.6h4.4V2.8A.8.8 0 0 1 8 2Z"/>
          </svg>
        </button>
        <button
          class="session-btn"
          :title="t('chat.sessionHistory')"
          @click="chat.showHistory = true"
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path fill="currentColor" d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm0 1.4a5.6 5.6 0 1 1 0 11.2A5.6 5.6 0 0 1 8 2.4Zm-.3 1.9a.7.7 0 0 0-.7.7v3.3c0 .19.07.36.2.49l2.1 2.1a.7.7 0 0 0 .99-.99L8.4 8.04V5a.7.7 0 0 0-.7-.7Z"/>
          </svg>
        </button>
        <!-- Git 改动入口：仓库可用时显示改动数徽章；非仓库置灰提示先初始化 -->
        <button
          class="git-btn"
          :class="{ 'has-changes': git.changes.length > 0, off: git.isRepo === false || !git.gitAvailable }"
          :title="gitBtnTitle"
          @click="onGitClick"
        >
          改动<span v-if="git.changes.length" class="git-badge">{{ git.changes.length }}</span>
        </button>
        <!-- ㊝ 变更暂存入口：审阅模式开启且有待决变更时高亮 -->
        <button
          class="stage-btn"
          :class="{ 'has-stage': staging.total > 0 && staging.enabled }"
          :title="staging.enabled
            ? (staging.total ? `审阅 ${staging.total} 个待接受变更` : '暂存区为空')
            : '审阅模式未开启（可在设置-通用中开启）'"
          @click="onStageBtnClick"
        >
          暂存<span v-if="staging.total" class="stage-badge">{{ staging.total }}</span>
        </button>
        <!-- s47 一键打包入口：进行中转圈高亮 -->
        <button
          class="stage-btn build-btn"
          :class="{ 'has-stage': build.running }"
          :title="build.running ? '打包进行中…点击查看日志' : '一键打包成品（electron-builder）'"
          @click="build.visible = true"
        >打包</button>
        <!-- s48 执行时间线入口：失败步骤数高亮 -->
        <button
          class="stage-btn"
          :class="{ 'has-stage': timeline.steps.length > 0 }"
          :title="'执行时间线：每步工具调用的理由/改动/耗时，失败可从此步重跑'"
          @click="timeline.open()"
        >时间线</button>
        <!-- s49 卡片式任务看板入口：进行中数量高亮 -->
        <button
          class="stage-btn"
          :class="{ 'has-stage': kanban.doingCount > 0 }"
          :title="'任务看板：待办/进行中/待验收/完成，支持单卡片暂停与回滚'"
          @click="kanban.open()"
        >看板</button>
        <!-- s54–s56 学术/报告链路入口 -->
        <button
          class="stage-btn"
          :class="{ 'has-stage': scholar.charts.length > 0 }"
          title="学术链路：实验数据(CSV/JSON)→学术图表→结构化报告→参考文献"
          @click="scholar.open()"
        >学术</button>
        <!-- AI 任务前自动检查点开关 -->
        <button
          class="cp-toggle"
          :class="{ on: chat.autoCheckpoint }"
          :title="chat.autoCheckpoint ? '每次 AI 任务前自动创建 Git 检查点（点击关闭）' : 'AI 任务前不自动建检查点（点击开启）'"
          @click="chat.toggleAutoCheckpoint(!chat.autoCheckpoint)"
        >{{ t('chat.checkpoints') }}</button>
        <!-- 工具权限模式：只读 / 询问 / 自动 -->
        <div class="mode-switch" :title="t('chat.permissionMode')" role="radiogroup" :aria-label="t('chat.permissionMode')">
          <button
            v-for="m in permissionModes"
            :key="m.value"
            class="mode-btn"
            :class="{ active: chat.permissionMode === m.value }"
            role="radio"
            :aria-checked="chat.permissionMode === m.value"
            @click="chat.setPermissionMode(m.value)"
          >{{ t('chat.' + m.key) }}</button>
        </div>
        <!-- 规则与技能管理入口（统一设置页-规则技能 Tab） -->
        <button class="settings-btn" :title="t('settings.rulesSkills')" @click="openSettings('rulesSkills')">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
            <path d="M2 3.5A1.5 1.5 0 0 1 3.5 2H7v11H3.5A1.5 1.5 0 0 0 2 14.5V3.5Z"/>
            <path d="M14 3.5A1.5 1.5 0 0 0 12.5 2H9v11h3.5a1.5 1.5 0 0 1 1.5 1.5V3.5Z"/>
          </svg>
        </button>
        <!-- MCP 服务器管理入口（统一设置页-MCP Tab） -->
        <button class="settings-btn" :title="t('settings.mcp')" @click="openSettings('mcp')">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
            <path d="M6 1v3M10 1v3M4.5 4h7v2.8a3.5 3.5 0 0 1-7 0V4Z"/>
            <path d="M8 10.3V13.2M5.9 15h4.2"/>
          </svg>
        </button>
        <!-- 模型管理入口（统一设置页-模型 Tab） -->
        <button class="settings-btn" title="模型管理" @click="openSettings('models')">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path fill="currentColor" d="M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm6.8-2.9l-1.2-2.1A6.2 6.2 0 0 0 13 1l-2.1-1.2a6.2 6.2 0 0 0-2.8 2.1h-2a6.2 6.2 0 0 0-2.8-2.1L1.1 1A6.2 6.2 0 0 0 2.4 5l-1.2 2.1a6.2 6.2 0 0 0 0 1.9l1.2 2.1A6.2 6.2 0 0 0 1.1 15l2.1 1.2a6.2 6.2 0 0 0 2.8-2.1h2a6.2 6.2 0 0 0 2.8 2.1l2.1-1.2a6.2 6.2 0 0 0-1.3-4l1.2-2.1a6.2 6.2 0 0 0 0-1.9Z"/>
          </svg>
        </button>
        <span class="status-dot" :class="{ online: ws.ollamaReady }"
          :title="ws.ollamaReady ? 'Ollama 已连接' : 'Ollama 未连接'"></span>
        <!-- 自适应模型状态：模型清单来自 Ollama 动态发现，当前模型随调度事件更新 -->
        <span
          v-if="modelStatusText"
          class="model-status"
          :class="{ warn: !!modelQueryError || availableModelCount === 0 }"
          :title="modelStatusText"
          >{{ modelStatusText }}</span
        >
      </div>
    </div>

    <!-- ㊝ 任务结束但暂存未清空：提醒变更尚未落盘，点击去审阅 -->
    <div v-if="showStageNotice" class="stage-notice cp-glass" @click="onStageBtnClick">
      <span class="stage-notice-dot"></span>
      有 {{ staging.total }} 个文件变更待审阅，尚未写入磁盘——接受后才算真正完成。
      <em class="stage-notice-go">去审阅 →</em>
    </div>

    <!-- 消息列表 -->
    <div ref="messagesRef" class="messages">
      <!-- ㊜ 未完成任务恢复条（列表为空时组件内部不渲染） -->
      <TaskRecoveryBar />
      <div
        v-for="(msg, idx) in displayMessages"
        :key="idx"
        class="msg-row"
        :class="[msg.role, { notice: msg.isNotice }]"
      >
        <!-- 结构化工具事件卡片（替代旧的纯文本工具 notice） -->
        <ToolEventCard v-if="msg.role === 'tool' && msg.toolEvent" :msg="msg" />
        <div v-else class="msg-bubble cp-glass">
          <!-- 思考中标识：AI 消息已建立但还没有任何输出时显示；工具循环期间展示当前动作 -->
          <div v-if="msg.role === 'assistant' && msg.isStreaming && !msg.content" class="thinking">
            <span class="thinking-dots"><i></i><i></i><i></i></span>
            <span class="thinking-text">{{ chat.thinkingHint || '思考中' }}</span>
          </div>
          <!-- AI 消息渲染 Markdown（内部已转义，安全）；实时偏差块由卡片承载，渲染前剥离 -->
          <div
            v-else-if="msg.role === 'assistant' && !msg.isNotice"
            class="msg-content md-body"
            v-html="renderMarkdown(assistantDisplayContent(msg))"
          ></div>
          <template v-else>
            <!-- 2.3 用户消息文本（图片-only 时无此块） -->
            <div v-if="msg.content" class="msg-content" v-text="msg.content"></div>
            <!-- 2.3 附件图片：按路径懒加载；缺失/加载中给占位 -->
            <div v-if="msg.attachments?.length" class="msg-images">
              <template v-for="(a, ai2) in msg.attachments" :key="ai2">
                <img
                  v-if="imageCache.get(a.path)"
                  :src="imageCache.get(a.path)"
                  class="msg-image"
                  alt="附件图片"
                >
                <div v-else-if="failedImages.has(a.path)" class="img-missing">
                  <span>图片缺失</span>
                </div>
                <div v-else class="img-loading">图片加载中…</div>
              </template>
            </div>
          </template>
          <div v-if="msg.toolName" class="tool-name">tool: {{ msg.toolName }}</div>
        </div>
        <!-- 任务收尾偏差卡片：仅挂在最后一条 assistant 消息所在 msg-row -->
        <div v-if="msg.role === 'assistant' && !msg.isNotice && idx === lastAssistantIdx && chat.liveDrift" class="drift-card-wrap" :class="{ flash: driftFlash }">
          <DriftReportCard
            :report="chat.liveDrift"
            @locate="onDriftLocate"
            @generate="onDriftGenerate"
          />
        </div>
      </div>
    </div>

    <!-- 进度条：模型执行/工具调用实时反馈 -->
    <div v-if="chat.progress" class="progress-bar">
      <div class="progress-info">
        <span class="progress-model">{{ chat.progress.model }}</span>
        <span class="progress-phase">{{ chat.progress.phase }}{{ chat.progress.tool ? ` · ${chat.progress.tool}` : '' }}</span>
      </div>
      <div class="progress-track">
        <div class="progress-fill" :style="{ width: chat.progress.round > 0 ? (chat.progress.round / chat.progress.maxRounds * 100) + '%' : '15%' }"></div>
      </div>
    </div>

    <!-- Agent 自主任务规划：TODO 子任务清单实时进度 -->
    <div v-if="chat.todos.length" class="todo-panel cp-glass">
      <div class="todo-head">
        <span class="todo-title">子任务清单</span>
        <span class="todo-count">{{ doneTodoCount }}/{{ chat.todos.length }}</span>
      </div>
      <ul class="todo-list">
        <li
          v-for="t in chat.todos"
          :key="t.id"
          class="todo-item"
          :class="[t.status, { high: t.priority === 'high' }]"
        >
          <span class="todo-check">{{ t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◐' : '○' }}</span>
          <span class="todo-text">{{ t.content }}</span>
        </li>
      </ul>
    </div>

    <!-- 子代理并行编排状态条 -->
    <div v-if="chat.subagent && chat.subagent.phase !== 'done'" class="subagent-bar">
      <span class="subagent-icon">⇄</span>
      <span class="subagent-text">
        子代理 {{ chat.subagent.current }}/{{ chat.subagent.total }} · {{ chat.subagent.detail }}
      </span>
    </div>

    <!-- 工具权限审批条：ask 模式/危险操作时挂起 Agent 等待用户裁决 -->
    <div v-if="chat.permission" class="perm-bar cp-glass" :class="{ danger: chat.permission.danger }">
      <div class="perm-head">
        <span class="perm-badge">{{ chat.permission.danger ? '⚠ ' + t('chat.danger') : t('chat.permissionApproval') }}</span>
        <span class="perm-tool">{{ permToolLabel }}</span>
      </div>
      <div class="perm-reason">{{ chat.permission.reason }}</div>
      <pre class="perm-target">{{ chat.permission.target }}</pre>
      <div class="perm-actions">
        <button class="perm-btn deny" @click="chat.respondPermission('deny')">{{ t('chat.deny') }}</button>
        <button
          v-if="!chat.permission.danger"
          class="perm-btn ghost"
          :title="t('chat.allowSession')"
          @click="chat.respondPermission('allow_always')"
        >{{ t('chat.allowSession') }}</button>
        <button class="perm-btn allow" @click="chat.respondPermission('allow_once')">{{ t('chat.allowOnce') }}</button>
      </div>
    </div>

    <!-- 输入区：Trae 风格一体化圆角输入器 -->
    <div class="composer-wrap">
      <!-- @ 引用候选浮层：输入 @ 触发文件/符号精确注入 -->
      <MentionPicker
        v-if="mentionToken !== null && ws.rootPath"
        ref="pickerRef"
        :root="ws.rootPath"
        :query="mentionToken"
        @select="insertMention"
        @close="closeMention"
      />
      <div
        class="composer"
        :class="{ 'drag-over': dragOver }"
        @dragover="onDragOver"
        @dragleave="onDragLeave"
        @drop="onDrop"
      >
        <!-- 2.3 待发送图片缩略图（可删除） -->
        <div v-if="draftImages.length" class="draft-thumbs">
          <div v-for="d in draftImages" :key="d.id" class="draft-thumb">
            <img :src="d.dataUrl" alt="待发送图片">
            <button class="thumb-remove" type="button" title="移除" @click="removeDraft(d.id)">×</button>
          </div>
        </div>
        <!-- 附件相关弱提示（非模态） -->
        <div v-if="attachWarn" class="attach-warn">{{ attachWarn }}</div>
        <!-- 🛑 物理阻断态：输入区锁定，只放行「重试任务」与「查看偏差报告」 -->
        <div v-if="chat.taskBlocked" class="blocked-bar">
          <span class="blocked-icon">⛔</span>
          <span class="blocked-text">任务已物理中断，AI 的后续工具调用已全部丢弃，不会再修改文件。</span>
          <button class="blocked-btn blocked-retry" type="button" :disabled="chat.sending" @click="void onRetryBlocked()">
            {{ chat.sending ? '正在重试…' : '重试任务' }}
          </button>
          <button class="blocked-btn" type="button" @click="void onShowDriftReport()">查看偏差报告</button>
          <button class="blocked-dismiss" type="button" title="已知晓风险，手动解锁输入（不推荐）" @click="onDismissBlocked">
            解锁输入
          </button>
        </div>
        <textarea
          ref="textareaRef"
          v-model="input"
          class="composer-input"
          :disabled="chat.taskBlocked"
          :placeholder="chat.taskBlocked
            ? '⛔ 任务已被系统物理中断，输入已锁定。请点击「重试任务」按固定顺序恢复，或「查看偏差报告」…'
            : '输入指令，Enter 发送，Shift+Enter 换行；@ 引用文件或符号；可粘贴/拖入图片...'"
          rows="1"
          @keydown="onKeydown"
          @input="onComposerInput"
          @click="detectMention"
          @keyup="detectMention"
          @paste="onPaste"
        ></textarea>
        <!-- 隐藏的图片文件选择框 -->
        <input
          ref="fileInputRef"
          type="file"
          accept="image/*"
          multiple
          class="hidden-file"
          @change="onFilePicked"
        >
        <div class="composer-bar">
          <div class="composer-left">
            <!-- 2.3 添加图片附件 -->
            <button
              class="attach-btn"
              type="button"
              :disabled="!attachmentsEnabled || chat.taskBlocked"
              :title="attachBtnTitle"
              @click="pickFiles"
            >
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <path fill="currentColor" d="M11.5 3.5a3 3 0 0 0-4.24 0L3.2 7.56a2.4 2.4 0 0 0 3.39 3.4l4.06-4.06a1.5 1.5 0 0 0-2.12-2.12L5.1 8.3a.6.6 0 0 0 .85.85l3.43-3.43a.3.3 0 0 1 .42.42L6.37 9.57a1.5 1.5 0 0 1-2.12-2.12l4.06-4.06a1.8 1.8 0 0 1 2.55 2.55l-4.06 4.06a3 3 0 0 1-4.25-4.24l4.06-4.06a4.2 4.2 0 0 1 5.94 5.94l-4.06 4.06a.6.6 0 1 1-.85-.85l4.06-4.06a3 3 0 0 0 0-4.24Z"/>
              </svg>
            </button>
            <!-- 2.3 读取剪贴板截图 -->
            <button
              class="attach-btn"
              type="button"
              :disabled="!attachmentsEnabled || chat.taskBlocked"
              :title="attachBtnTitle.indexOf('请先') === 0 || visionBlocked
                ? attachBtnTitle
                : '读取剪贴板中的截图（系统截图后点此）'"
              @click="void pasteClipboardImage()"
            >
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <path fill="currentColor" d="M5 2h6a1 1 0 0 1 1 1v1h.5A1.5 1.5 0 0 1 14 5.5v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-6A1.5 1.5 0 0 1 3.5 4H4V3a1 1 0 0 1 1-1Zm0 2v-.4h6V4H5Zm1.5 3.2a2 2 0 1 0 0 .01ZM8 6.4a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8Z"/>
              </svg>
            </button>
            <!-- 工具调用开关胶囊 -->
            <button
              class="pill"
              :class="{ active: useTools }"
              :title="useTools ? '允许 AI 调用 MCP 工具' : '仅对话，不调用工具'"
              @click="useTools = !useTools"
            >
              <!-- 盾牌图标 -->
              <svg class="pill-icon" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M8 1.5 2.75 3.4v3.45c0 3.18 2.18 5.9 5.25 6.65 3.07-.75 5.25-3.47 5.25-6.65V3.4L8 1.5Zm-1.1 7.9L5.4 7.9l.95-.95 1.05 1.05 2.6-2.6.95.95-3.55 3.55Z"
                />
              </svg>
              <span>{{ useTools ? '工具调用' : '仅对话' }}</span>
              <svg class="pill-chevron" viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">
                <path fill="currentColor" d="M4 6l4 4 4-4H4Z" />
              </svg>
            </button>
            <!-- 模型选择胶囊：自动 = 智能路由 + 超时回退；也可按供应商手动指定 -->
            <label class="pill model-pill" title="选择模型：自动 = 按任务智能路由，失败/超时自动回退">
              <span class="at-mark">@</span>
              <select v-model="chat.model" class="model-select">
                <option value="auto">自动 · 智能路由</option>
                <optgroup v-for="g in chat.modelGroups" :key="g.providerId" :label="g.label">
                  <option v-for="m in g.models" :key="m.id" :value="m.id">
                    {{ m.displayName }}{{ m.available ? '' : '（不可用）' }}
                  </option>
                </optgroup>
              </select>
            </label>
          </div>
          <!-- 发送中：工具任务显示运行门（暂停/继续/放弃）+ 停止键；纯流式仅停止键 -->
          <div v-if="chat.sending" class="run-controls">
            <!-- 暂停态：继续 + 放弃（放弃弹确认面板，可选回滚） -->
            <template v-if="chat.taskPhase === 'paused'">
              <button class="gate-btn gate-resume" type="button" title="继续任务" @click="void chat.resumeRunning()">
                <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                  <path fill="currentColor" d="M4.5 3.2v9.6c0 .8.87 1.28 1.55.87l7.2-4.8a1.02 1.02 0 0 0 0-1.74l-7.2-4.8C5.37 1.92 4.5 2.4 4.5 3.2Z" />
                </svg>
              </button>
              <button class="gate-btn gate-abandon" type="button" title="放弃任务" @click="openAbandonConfirm">
                放弃
              </button>
            </template>
            <!-- 运行中/暂停请求中：软暂停键（pausing 时禁用，当前操作跑完才到安全点） -->
            <button
              v-else-if="chat.taskPhase !== 'idle'"
              class="gate-btn gate-pause"
              type="button"
              :disabled="chat.taskPhase === 'pausing'"
              :title="chat.taskPhase === 'pausing' ? '暂停中：到达安全点后挂起' : '软暂停（当前操作完成后挂起，可随时继续）'"
              @click="void chat.pauseRunning()"
            >
              <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                <rect x="4" y="3" width="3" height="10" rx="1" fill="currentColor" />
                <rect x="9" y="3" width="3" height="10" rx="1" fill="currentColor" />
              </svg>
              <span v-if="chat.taskPhase === 'pausing'" class="gate-label">暂停中</span>
            </button>
            <!-- 硬停止：立即掐断当前任务（保留 aborted 快照，不进恢复条） -->
            <button
              class="send-square stop-square"
              type="button"
              title="立即停止当前任务"
              @click="void chat.stopSending()"
            >
              <!-- 方块停止图标 -->
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor" />
              </svg>
            </button>
          </div>
          <button
            v-else
            class="send-square"
            :disabled="!canSend || chat.taskBlocked"
            :title="chat.taskBlocked ? '任务已物理中断，请先重试任务' : '发送'"
            @click="onSend"
          >
            <!-- 向上箭头图标 -->
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <path
                fill="currentColor"
                d="M8 2.8 3.4 7.4l.95.95L7.25 5.5v6.95h1.35V5.5l2.9 2.85.95-.95L8 2.8Z"
              />
            </svg>
          </button>
        </div>
      </div>
      <!-- ㊜ 1b 放弃确认：上浮于输入区，回滚勾选按检查点有无禁用 -->
      <div v-if="showAbandonConfirm" class="abandon-pop cp-glass">
        <div class="abandon-text">放弃该任务？</div>
        <label class="abandon-check" :class="{ disabled: !chat.activeCheckpoint }">
          <input
            v-model="rollbackChecked"
            type="checkbox"
            :disabled="!chat.activeCheckpoint"
          >
          同时回滚到任务前检查点
        </label>
        <div class="abandon-actions">
          <button class="gate-btn" type="button" @click="cancelAbandonConfirm">取消</button>
          <button class="gate-btn gate-abandon" type="button" @click="void confirmAbandon()">
            确认放弃
          </button>
        </div>
      </div>
    </div>
  </div>

  <SessionHistory v-if="chat.showHistory" @close="chat.showHistory = false" />
</template>

<style scoped>
.chat-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-panel);
}

.chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 12px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
  gap: 8px;
}

.title {
  font-size: 12px;
  font-weight: 600;
  color: var(--primary);
  letter-spacing: 0.5px;
}

/* 标题列：AI 助手 + 当前会话名副标题 */
.title-wrap {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.session-sub {
  font-size: 11px;
  color: var(--text-muted, #7a8499);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 180px;
}

/* 头部会话操作按钮（新建/历史） */
.session-btn {
  appearance: none;
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  padding: 4px 6px;
  cursor: pointer;
  transition: all 0.15s;
}
.session-btn:hover:not(:disabled) {
  color: var(--primary);
  border-color: var(--primary);
  background: var(--primary-dim);
}
.session-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--danger);
}

.status-dot.online {
  background: var(--success);
  box-shadow: 0 0 6px var(--success);
}

/* 自适应模型状态文本：跟随头部状态点，超长省略 */
.model-status {
  font-size: 11px;
  color: var(--text-dim, #8a93a6);
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-status.warn {
  color: var(--warning, #e6a23c);
}

.messages {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.msg-row {
  display: flex;
  flex-direction: column;
}

.msg-row.user {
  align-items: flex-end;
}

.msg-row.assistant,
.msg-row.tool {
  align-items: flex-start;
}

.msg-bubble {
  max-width: 88%;
  padding: 10px 14px;
  border-radius: var(--radius-md);
  font-size: 13px;
  line-height: 1.6;
  word-break: break-word;
  font-family: var(--font-sans);
}

/* 用户消息：右对齐，primary 背景，白字，右下角圆角为 0（气泡尖角感） */
.msg-row.user .msg-bubble {
  background: var(--primary);
  color: #FFFFFF;
  border: 1px solid var(--primary);
  border-bottom-right-radius: 2px;
  box-shadow: 0 2px 8px rgba(99, 102, 241, 0.25);
}

/* AI 消息：左对齐，hover 背景，主文本色，左下角圆角为 0 */
.msg-row.assistant .msg-bubble {
  background: var(--bg-hover);
  color: var(--text-primary);
  border: 1px solid var(--border);
  border-bottom-left-radius: 2px;
  max-width: 88%;
}

.msg-row.tool .msg-bubble {
  background: var(--tool-bubble-bg);
  border-color: var(--accent);
  font-family: var(--font-mono);
  font-size: 11px;
}

/* 回退提示等通知：居中、虚线框、弱化展示 */
.msg-row.notice {
  align-items: center;
}

.msg-row.notice .msg-bubble {
  background: transparent;
  border: 1px dashed var(--border);
  color: var(--text-muted);
  font-size: 11px;
  padding: 4px 10px;
}

.msg-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 2px;
}

/* 思考中标识：三个青色圆点依次脉动 */
.thinking {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 2px;
}

.thinking-dots {
  display: inline-flex;
  gap: 4px;
}

.thinking-dots i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  animation: thinking-pulse 1.2s ease-in-out infinite;
}

.thinking-dots i:nth-child(2) {
  animation-delay: 0.2s;
}

.thinking-dots i:nth-child(3) {
  animation-delay: 0.4s;
}

.thinking-text {
  font-size: 12px;
  color: var(--text-muted);
  letter-spacing: 1px;
  animation: thinking-breathe 1.2s ease-in-out infinite;
}

@keyframes thinking-pulse {
  0%, 60%, 100% { transform: scale(0.6); opacity: 0.35; }
  30% { transform: scale(1); opacity: 1; }
}

@keyframes thinking-breathe {
  0%, 100% { opacity: 0.5; }
  50% { opacity: 1; }
}

.msg-content {
  white-space: pre-wrap;
}

/* Markdown 渲染体：HTML 排版不需要 pre-wrap */
.msg-content.md-body {
  white-space: normal;
}

/* ---------- 2.3 用户消息附件图片 ---------- */
.msg-images {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}

.msg-image {
  max-width: 220px;
  max-height: 160px;
  border-radius: 8px;
  border: 1px solid var(--border);
  display: block;
  object-fit: cover;
}

.img-missing,
.img-loading {
  width: 110px;
  height: 72px;
  border-radius: 8px;
  border: 1px dashed var(--border);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  font-size: 11px;
}

/* ---------- AI 消息 Markdown 样式（v-html 内容需 :deep 穿透 scoped） ---------- */
/* 段落 */
.md-body :deep(.md-p) {
  margin: 4px 0;
  line-height: 1.65;
}

.md-body :deep(.md-p:first-child) {
  margin-top: 0;
}

.md-body :deep(.md-p:last-child) {
  margin-bottom: 0;
}

/* 标题：左侧青色竖线 + 渐变层次 */
.md-body :deep(.md-h) {
  margin: 12px 0 6px;
  font-weight: 600;
  color: var(--text-primary);
  line-height: 1.4;
}

.md-body :deep(.md-h1) {
  font-size: 17px;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--border);
}

.md-body :deep(.md-h2) {
  font-size: 15px;
  padding-left: 8px;
  border-left: 3px solid var(--accent);
}

.md-body :deep(.md-h3) {
  font-size: 14px;
  padding-left: 8px;
  border-left: 3px solid var(--accent);
}

.md-body :deep(.md-h4) {
  font-size: 13px;
  color: var(--accent);
}

.md-body :deep(.md-h:first-child) {
  margin-top: 2px;
}

/* 加粗/斜体/删除线 */
.md-body :deep(.md-strong) {
  color: var(--text-primary);
  font-weight: 600;
}

.md-body :deep(.md-em) {
  color: var(--text-secondary);
}

.md-body :deep(.md-del) {
  color: var(--text-muted);
}

/* 行内代码：青色描边小胶囊 */
.md-body :deep(.md-inline) {
  padding: 1px 6px;
  margin: 0 1px;
  border-radius: 4px;
  background: var(--accent-dim);
  border: 1px solid var(--border);
  color: var(--accent);
  font-family: var(--font-mono);
  font-size: 12px;
}

/* 代码块：深色底 + 顶部语言标签 */
.md-body :deep(.md-code) {
  margin: 8px 0;
  border-radius: 8px;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  overflow: hidden;
}

.md-body :deep(.md-code-head) {
  display: flex;
  align-items: center;
  padding: 4px 10px;
  background: var(--bg-tertiary);
  border-bottom: 1px solid var(--border);
  min-height: 18px;
}

.md-body :deep(.md-code-lang) {
  font-size: 10px;
  color: var(--accent);
  text-transform: uppercase;
  letter-spacing: 1px;
}

.md-body :deep(.md-code code) {
  display: block;
  padding: 10px 12px;
  overflow-x: auto;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-primary);
  white-space: pre;
}

/* 列表：紧凑缩进 + 青色标记 */
.md-body :deep(.md-list) {
  margin: 4px 0;
  padding-left: 20px;
}

.md-body :deep(.md-li) {
  margin: 3px 0;
  line-height: 1.6;
}

.md-body :deep(ul.md-list .md-li)::marker {
  color: var(--accent);
}

.md-body :deep(ol.md-list .md-li)::marker {
  color: var(--accent);
  font-weight: 600;
}

/* 引用块 */
.md-body :deep(.md-quote) {
  margin: 6px 0;
  padding: 4px 10px;
  border-left: 3px solid var(--border-light);
  color: var(--text-muted);
  background: var(--bg-secondary);
  border-radius: 0 6px 6px 0;
}

/* 分隔线 */
.md-body :deep(.md-hr) {
  border: none;
  border-top: 1px solid var(--border);
  margin: 10px 0;
}

/* 链接 */
.md-body :deep(.md-link) {
  color: var(--accent);
  text-decoration: none;
  border-bottom: 1px dashed var(--accent);
}

.md-body :deep(.md-link:hover) {
  color: var(--accent-hover);
  border-bottom-style: solid;
}

/* s54 学术图表：白底图卡在深色气泡内加描边，最大宽度自适应 */
.md-body :deep(.md-img) {
  display: block;
  max-width: 100%;
  margin: 8px 0;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.25);
}

.tool-name {
  margin-top: 6px;
  font-size: 10px;
  color: var(--accent);
  border-top: 1px solid var(--border);
  padding-top: 4px;
}

/* ---------- 一体化圆角输入器 ---------- */
/* 进度条 */
.progress-bar {
  flex-shrink: 0;
  padding: 6px 12px;
  background: var(--bg-tertiary, rgba(0,0,0,0.06));
  border-top: 1px solid var(--border, rgba(0,0,0,0.08));
}
.progress-info {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
  font-size: 11px;
}
.progress-model {
  color: var(--accent, #00d4ff);
  font-weight: 600;
}
.progress-phase {
  color: var(--text-secondary, #8b949e);
}
.progress-track {
  height: 3px;
  background: var(--bg-quaternary, rgba(0,0,0,0.1));
  border-radius: 2px;
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--accent, #00d4ff), var(--accent-dim, rgba(0,212,255,0.5)));
  border-radius: 2px;
  transition: width 0.3s ease;
  animation: progress-pulse 1.5s ease-in-out infinite;
}
@keyframes progress-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.7; }
}

/* ---------- Agent TODO 子任务清单面板 ---------- */
.todo-panel {
  flex-shrink: 0;
  margin: 0 12px 2px;
  padding: 8px 10px;
  border-radius: 10px;
  border: 1px solid var(--border);
  max-height: 180px;
  overflow-y: auto;
}
.todo-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}
.todo-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--accent, #00d4ff);
  letter-spacing: 1px;
}
.todo-count {
  font-size: 11px;
  color: var(--text-muted);
}
.todo-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.todo-item {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  font-size: 12px;
  color: var(--text-secondary, #b8c2d9);
  line-height: 1.5;
}
.todo-check {
  flex-shrink: 0;
  width: 14px;
  color: var(--text-muted);
  font-size: 11px;
  line-height: 18px;
}
/* 进行中：青色高亮 + 呼吸感 */
.todo-item.in_progress .todo-check {
  color: var(--accent, #00d4ff);
  animation: thinking-breathe 1.2s ease-in-out infinite;
}
.todo-item.in_progress .todo-text {
  color: var(--accent, #00d4ff);
}
/* 已完成：弱化 + 删除线 */
.todo-item.completed {
  opacity: 0.55;
}
.todo-item.completed .todo-check {
  color: var(--success, #2ecc71);
}
.todo-item.completed .todo-text {
  text-decoration: line-through;
}
/* 高优先级任务左侧青色竖条提示 */
.todo-item.high.pending .todo-check {
  color: #ff7b72;
}

/* ---------- 子代理并行编排状态条 ---------- */
.subagent-bar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 12px 2px;
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid var(--accent, #00d4ff);
  background: var(--accent-dim, rgba(0, 212, 255, 0.08));
  font-size: 11px;
}
.subagent-icon {
  color: var(--accent, #00d4ff);
  font-weight: 700;
  animation: thinking-breathe 1.2s ease-in-out infinite;
}
.subagent-text {
  color: var(--text-secondary, #b8c2d9);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 头部右侧：权限模式分段切换 + 连接状态点 */
.header-right {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.mode-switch {
  display: flex;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
}

/* Git 改动入口 */
.git-btn {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  font-size: 10.5px;
  padding: 3px 8px;
  cursor: pointer;
  transition: all 0.15s;
}
.git-btn:hover { color: var(--text-secondary); border-color: var(--border-light); }
.git-btn.has-changes {
  color: var(--primary);
  border-color: var(--primary);
  background: var(--primary-dim);
}
.git-btn.off { opacity: 0.45; }
.git-badge {
  min-width: 15px;
  height: 15px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--primary);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  line-height: 15px;
  text-align: center;
}

/* ㊝ 暂存入口：默认低调，有待决变更时靛蓝高亮 */
.stage-btn {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  font-size: 10.5px;
  padding: 3px 8px;
  cursor: pointer;
  transition: all 0.15s;
}
.stage-btn:hover { color: var(--text-secondary); border-color: var(--border-light); }
.stage-btn.has-stage {
  border-color: var(--primary);
  color: var(--primary);
  background: var(--primary-dim);
}
.stage-badge {
  min-width: 15px;
  height: 15px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--primary);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  line-height: 15px;
  text-align: center;
}

/* ㊝ 任务结束提示条：整条可点击去审阅 */
.stage-notice {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 10px 0;
  padding: 8px 12px;
  border: 1px solid rgba(46, 230, 214, 0.45);
  border-radius: 8px;
  font-size: 12px;
  color: #bfeee9;
  cursor: pointer;
  flex-shrink: 0;
  transition: all 0.15s;
}
.stage-notice:hover {
  background: rgba(46, 230, 214, 0.1);
  border-color: rgba(46, 230, 214, 0.75);
}
.stage-notice-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #2ee6d6;
  box-shadow: 0 0 8px #2ee6d6;
}
.stage-notice-go {
  font-style: normal;
  margin-left: auto;
  color: #5ff0e2;
  font-size: 11.5px;
}

/* 自动检查点开关 */
.cp-toggle {
  appearance: none;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  font-size: 10.5px;
  padding: 3px 8px;
  cursor: pointer;
  transition: all 0.15s;
}
.cp-toggle.on {
  color: var(--primary);
  border-color: var(--primary);
  background: var(--primary-dim);
}

.mode-btn {
  appearance: none;
  border: none;
  background: transparent;
  color: var(--text-muted);
  font-size: 10px;
  line-height: 1;
  padding: 3px 8px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.mode-btn + .mode-btn {
  border-left: 1px solid var(--border);
}

.mode-btn:hover {
  color: var(--text-secondary);
}

.mode-btn.active {
  background: var(--primary-dim);
  color: var(--primary);
  font-weight: 600;
}

/* 模型管理入口按钮（头部右侧齿轮） */
.settings-btn {
  appearance: none;
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--border, rgba(0, 212, 255, 0.2));
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted, #7a8499);
  padding: 4px 6px;
  cursor: pointer;
  transition: all 0.15s;
}
.settings-btn:hover {
  color: var(--accent, #00d4ff);
  border-color: rgba(0, 212, 255, 0.55);
  box-shadow: 0 0 8px rgba(0, 212, 255, 0.25) inset;
}

/* 工具权限审批条 */
.perm-bar {
  flex-shrink: 0;
  margin: 0 12px 4px;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--accent, #00d4ff);
  background: var(--accent-dim, rgba(0, 212, 255, 0.08));
  animation: thinking-breathe 1.6s ease-in-out infinite;
}

.perm-bar.danger {
  border-color: var(--danger, #ff4d6d);
  background: rgba(255, 77, 109, 0.08);
  animation: none;
}

.perm-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.perm-badge {
  font-size: 11px;
  font-weight: 700;
  color: var(--accent, #00d4ff);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.perm-bar.danger .perm-badge {
  color: var(--danger, #ff4d6d);
}

.perm-tool {
  font-size: 11px;
  color: var(--text-secondary, #b8c2d9);
}

.perm-reason {
  font-size: 11px;
  color: var(--text-secondary, #b8c2d9);
  margin-bottom: 6px;
}

.perm-target {
  margin: 0 0 8px;
  padding: 6px 8px;
  max-height: 88px;
  overflow: auto;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.35);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
  font-family: monospace;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-primary, #e2e8f0);
  white-space: pre-wrap;
  word-break: break-all;
}

.perm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.perm-btn {
  appearance: none;
  border-radius: 6px;
  font-size: 11px;
  line-height: 1;
  padding: 6px 12px;
  cursor: pointer;
  border: 1px solid var(--border, rgba(0, 212, 255, 0.3));
  background: transparent;
  color: var(--text-secondary, #b8c2d9);
  transition: all 0.15s;
}

.perm-btn:hover {
  border-color: var(--accent, #00d4ff);
  color: var(--accent, #00d4ff);
}

.perm-btn.deny:hover {
  border-color: var(--danger, #ff4d6d);
  color: var(--danger, #ff4d6d);
}

.perm-btn.allow {
  background: var(--accent, #00d4ff);
  border-color: var(--accent, #00d4ff);
  color: #04121f;
  font-weight: 600;
}

.perm-btn.allow:hover {
  box-shadow: 0 0 8px var(--accent, #00d4ff);
  color: #04121f;
}

.composer-wrap {
  position: relative;
  padding: 16px;
  border-top: 1px solid var(--border);
  flex-shrink: 0;
}

.composer {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px 8px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  transition: border-color 0.15s, box-shadow 0.15s;
}

.composer:focus-within {
  border-color: var(--primary);
  box-shadow: 0 0 0 1px var(--primary-dim);
}

.composer-input {
  width: 100%;
  min-height: 44px;
  max-height: 160px;
  background: transparent;
  border: none;
  outline: none;
  resize: none;
  color: var(--text-primary);
  font-family: inherit;
  font-size: 13px;
  line-height: 1.5;
  padding: 2px 2px 0;
}

.composer-input::placeholder {
  color: var(--text-muted);
}

/* ---------- 2.3 待发送缩略图 / 附件按钮 ---------- */
.draft-thumbs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.draft-thumb {
  position: relative;
  width: 64px;
  height: 64px;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--border);
}

.draft-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.thumb-remove {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: none;
  background: rgba(0, 0, 0, 0.65);
  color: #fff;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}

.thumb-remove:hover {
  background: rgba(0, 0, 0, 0.9);
}

/* 附件弱提示条 */
.attach-warn {
  font-size: 11px;
  color: var(--warning);
  padding: 2px 2px 0;
}

/* 🛑 物理阻断条：红橙警示玻璃条，任务中断后只放行重试/查看报告 */
.blocked-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 6px;
  padding: 8px 10px;
  border-radius: 10px;
  border: 1px solid rgba(239, 68, 68, 0.55);
  background: linear-gradient(135deg, rgba(239, 68, 68, 0.16), rgba(245, 158, 11, 0.10));
  box-shadow: 0 0 0 1px rgba(239, 68, 68, 0.12), 0 4px 18px rgba(239, 68, 68, 0.14);
  font-size: 12px;
  line-height: 1.4;
}

.blocked-icon {
  font-size: 15px;
  flex: none;
}

.blocked-text {
  color: var(--text-primary);
  flex: 1 1 200px;
  min-width: 180px;
}

.blocked-btn {
  flex: none;
  padding: 5px 14px;
  border-radius: 8px;
  border: 1px solid rgba(239, 68, 68, 0.55);
  background: rgba(239, 68, 68, 0.12);
  color: var(--text-primary);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
}

.blocked-btn:hover:not(:disabled) {
  background: rgba(239, 68, 68, 0.24);
  border-color: var(--danger);
}

.blocked-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.blocked-retry {
  border-color: var(--accent);
  background: rgba(99, 102, 241, 0.22);
}

.blocked-retry:hover:not(:disabled) {
  background: rgba(99, 102, 241, 0.38);
  border-color: var(--accent);
}

.blocked-dismiss {
  flex: none;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 11px;
  text-decoration: underline;
  cursor: pointer;
  padding: 2px 4px;
}

.blocked-dismiss:hover {
  color: var(--text-primary);
}

.composer-input:disabled {
  opacity: 0.65;
  cursor: not-allowed;
}

/* 「查看偏差报告」定位高亮：卡片外发光脉冲两秒 */
.drift-card-wrap.flash {
  animation: drift-flash 0.55s ease-in-out 0s 4;
  border-radius: 12px;
}

@keyframes drift-flash {
  0%, 100% { box-shadow: none; }
  50% {
    box-shadow: 0 0 0 2px var(--warning), 0 0 22px rgba(245, 158, 11, 0.55);
  }
}

/* 附件/截图按钮：青色弱图标 */
.attach-btn {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.15s;
}

.attach-btn:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}

.attach-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* 隐藏的文件选择框：不占布局 */
.hidden-file {
  display: none;
}

/* 拖拽悬停：输入器靛蓝描边高亮 */
.composer.drag-over {
  border-color: var(--primary);
  box-shadow: 0 0 0 1px var(--primary-dim), 0 0 12px var(--primary-dim);
}

.composer-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.composer-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

/* 底部胶囊按钮 */
.pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 10px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text-secondary);
  font-family: inherit;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s;
}

/* 工具调用开关：纯图标按钮（文字与箭头隐藏，仅 title 提示） */
.pill:not(.model-pill) {
  padding: 0;
  width: 28px;
  justify-content: center;
}
.pill:not(.model-pill) > span,
.pill:not(.model-pill) .pill-chevron {
  display: none;
}

.pill:hover {
  border-color: var(--accent);
  color: var(--text-primary);
}

/* 激活态（工具调用开启）：靛蓝描边+淡靛底 */
.pill.active {
  color: var(--primary);
  border-color: var(--primary);
  background: var(--primary-dim);
}

.pill-icon {
  flex-shrink: 0;
}

.pill-chevron {
  flex-shrink: 0;
  opacity: 0.7;
}

/* 模型选择胶囊：@ 前缀 + 无边框原生 select */
.model-pill {
  cursor: default;
  max-width: 180px;
}

.at-mark {
  color: var(--text-muted);
  font-weight: 600;
}

.model-select {
  appearance: none;
  background: transparent;
  border: none;
  outline: none;
  color: inherit;
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  max-width: 130px;
}
/* 白色主题下 select 选项强制白底深字，防止系统下拉继承半透明背景 */
.model-select option {
  background: var(--bg-secondary);
  color: var(--text-primary);
}

/* 方形发送键 */
.send-square {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  border: none;
  border-radius: 9px;
  background: var(--accent);
  color: var(--btn-primary-text);
  cursor: pointer;
  transition: background 0.15s, box-shadow 0.15s, transform 0.1s;
}

.send-square:hover:not(:disabled) {
  background: var(--accent-hover);
  box-shadow: 0 0 12px var(--border-glow);
}

.send-square:active:not(:disabled) {
  transform: translateY(1px);
}

.send-square:disabled {
  background: var(--bg-tertiary);
  color: var(--text-muted);
  cursor: not-allowed;
}

/* 停止键：发送中替换发送键，警示色 */
.stop-square {
  background: rgba(255, 107, 107, 0.18);
  color: #ff6b6b;
  border: 1px solid rgba(255, 107, 107, 0.45);
}

.stop-square:hover {
  background: rgba(255, 107, 107, 0.3);
  box-shadow: 0 0 12px rgba(255, 107, 107, 0.35);
}

/* ===== ㊜ 1b 运行门 ===== */
/* 按钮组：暂停门与停止键横排，随 composer-bar 对齐 */
.run-controls {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.gate-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--border-light);
  border-radius: 9px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 11px;
  cursor: pointer;
  transition: all 0.15s;
}
.gate-btn:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}
.gate-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
/* 暂停键：青色描边（软控制，区别于红色硬停止） */
.gate-pause {
  border-color: rgba(0, 229, 255, 0.5);
  color: var(--accent);
}
.gate-pause:hover:not(:disabled) {
  background: rgba(0, 229, 255, 0.12);
  box-shadow: 0 0 10px rgba(0, 229, 255, 0.25);
}
/* 继续键：青实心 = 主动作 */
.gate-resume {
  width: 32px;
  padding: 0;
  border: none;
  background: var(--accent);
  color: var(--btn-primary-text);
}
.gate-resume:hover {
  background: var(--accent-hover);
  box-shadow: 0 0 12px var(--border-glow);
}
/* 放弃键：红色描边 */
.gate-abandon {
  border-color: rgba(255, 107, 107, 0.5);
  color: #ff6b6b;
}
.gate-abandon:hover:not(:disabled) {
  background: rgba(255, 107, 107, 0.14);
  box-shadow: 0 0 10px rgba(255, 107, 107, 0.25);
}

/* 放弃确认面板：上浮贴输入区顶边，右对齐靠按钮侧 */
.abandon-pop {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: calc(100% - 6px);
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  padding: 10px 14px;
  border: 1px solid rgba(255, 107, 107, 0.4);
  border-radius: 12px;
  background: var(--bg-panel);
  box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.45), 0 0 16px rgba(255, 107, 107, 0.12);
  z-index: 20;
}
.abandon-text {
  color: var(--text-primary);
  font-size: 12px;
}
.abandon-check {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--text-secondary);
  font-size: 11px;
  cursor: pointer;
  user-select: none;
}
.abandon-check.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.abandon-check input {
  margin: 0;
  accent-color: var(--accent);
}
.abandon-actions {
  margin-left: auto;
  display: flex;
  gap: 8px;
}
</style>
