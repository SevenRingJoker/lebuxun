<script setup lang="ts">// 终端面板：编辑器下方的真 PTY 终端（node-pty + xterm.js）。
// 支持：多终端 Tab、彩色输出、Ctrl+C、Tab 补全、窗口/面板缩放自适应、
//       AI 交互命令自动开 Tab（标记 AI）、右键「送 AI 诊断」、后台长任务管理弹窗。
// 旧哨兵管道（AI 一次性命令拿结构化结果）仍在主进程保留，本组件只消费 PTY 通道。
import { ref, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import type {
  UiPtyInfo,
  UiTaskSnapshot,
  BackgroundTaskEvent
} from '../api'
import { useWorkspaceStore } from '../stores/workspace'

const ws = useWorkspaceStore()
const { t } = useI18n()

// 面板可见性与高度（像素），可拖拽上边缘调整
// 初始隐藏：有会话输出（用户新建/AI 启动）时自动展开
const visible = ref(false)
const height = ref(220)
const dragging = ref(false)

// shell 类别 → Tab 标题文案
const SHELL_LABEL: Record<string, string> = {
  pwsh: 'PWSH 7',
  powershell: 'PowerShell',
  cmd: 'CMD',
  posix: 'Shell',
  fish: 'fish'
}

/** Tab 模型：xterm 实例 + FitAddon + 容器元素 + 会话状态 */
interface TermTab {
  id: string
  shell: string
  origin: 'user' | 'ai'
  alive: boolean
  exitCode: number | null
  term: Terminal | null
  fit: FitAddon | null
  el: HTMLDivElement | null
}

const tabs = ref<TermTab[]>([])
const activeId = ref('')

const activeTab = (): TermTab | undefined =>
  tabs.value.find((t) => t.id === activeId.value)

/** cyber 配色 xterm 主题（背景与面板底色对齐） */
const XTERM_THEME = {
  background: '#0b0f16',
  foreground: '#c9d4e3',
  cursor: '#00d4ff',
  cursorAccent: '#0b0f16',
  selectionBackground: '#14496b',
  selectionForeground: '#e6f6ff',
  black: '#0b0f16',
  red: '#ff6b81',
  green: '#4ade80',
  yellow: '#ffd166',
  blue: '#5ab7ff',
  magenta: '#c792ea',
  cyan: '#2dd4ee',
  white: '#d7e2f0',
  brightBlack: '#5a6a80',
  brightRed: '#ff8da1',
  brightGreen: '#7bed9f',
  brightYellow: '#ffe08a',
  brightBlue: '#8fd0ff',
  brightMagenta: '#dbb6f5',
  brightCyan: '#7fe7f7',
  brightWhite: '#f2f7ff'
}

/**
 * 为会话创建 xterm 实例并挂载到 Tab 容器。
 * 容器 display:none 时 fit 尺寸为 0——挂载后仅当 Tab 激活时执行 fit。
 */
async function mountTerminal(tab: TermTab): Promise<void> {
  await nextTick()
  if (!tab.el || tab.term) return
  const term = new Terminal({
    fontFamily: 'var(--font-mono), Consolas, monospace',
    fontSize: 12.5,
    lineHeight: 1.2,
    cursorBlink: true,
    scrollback: 5000,
    theme: XTERM_THEME,
    allowProposedApi: true
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.loadAddon(new WebLinksAddon())
  // 用户按键 → PTY
  term.onData((data) => {
    void window.api.terminal.ptyWrite(tab.id, data)
  })
  term.open(tab.el)
  tab.term = term
  tab.fit = fit
  if (tab.id === activeId.value) {
    fitActive(tab)
  }
}

/** 按实测尺寸 fit 并把行列同步回 PTY */
function fitActive(tab?: TermTab): void {
  const target = tab ?? activeTab()
  if (!target?.fit || !target.term || target.id !== activeId.value) return
  try {
    target.fit.fit()
    const dims = target.fit.proposeDimensions()
    if (dims) {
      void window.api.terminal.ptyResize(target.id, dims.cols, dims.rows)
    }
  } catch {
    // 容器尺寸暂不可用（隐藏/布局中），等 resize/激活时重试
  }
}

/** 新建终端 Tab：ptyCreate 成功后挂 xterm */
async function createTab(): Promise<void> {
  const r = await window.api.terminal.ptyCreate({
    cwd: ws.rootPath || undefined
  })
  if (!r.ok) return
  addTabForInfo(r.info)
}

/** 根据主进程会话摘要挂一个 Tab（新建 + ptyList 恢复共用） */
function addTabForInfo(info: UiPtyInfo, activate = true): void {
  // 已存在（重复事件）直接激活
  const existed = tabs.value.find((t) => t.id === info.id)
  if (existed) {
    if (activate) void activateTab(existed.id)
    return
  }
  const tab: TermTab = {
    id: info.id,
    shell: info.shell,
    origin: info.origin,
    alive: info.alive,
    exitCode: info.exitCode,
    term: null,
    fit: null,
    el: null
  }
  tabs.value.push(tab)
  if (activate) activeId.value = tab.id
  void mountTerminal(tab)
}

/** 切换激活 Tab：display 切换后 nextTick 重新 fit（容器尺寸刚恢复） */
async function activateTab(id: string): Promise<void> {
  if (activeId.value === id) return
  activeId.value = id
  await nextTick()
  requestAnimationFrame(() => fitActive())
}

/** 关闭 Tab：杀会话 + 销毁 xterm；最后一个关掉时自动补一个新终端 */
async function closeTab(id: string): Promise<void> {
  const idx = tabs.value.findIndex((t) => t.id === id)
  if (idx < 0) return
  const tab = tabs.value[idx]
  try {
    if (tab.alive) await window.api.terminal.ptyKill(id)
  } finally {
    tab.term?.dispose()
    tabs.value.splice(idx, 1)
    if (tabs.value.length === 0) {
      void createTab()
      return
    }
    if (activeId.value === id) {
      const next = tabs.value[Math.min(idx, tabs.value.length - 1)]
      void activateTab(next.id)
    }
  }
}

/** 清屏当前终端 */
function clearActive(): void {
  activeTab()?.term?.clear()
}

// ---------- PTY 输出/退出事件 ----------

function onPtyData(payload: { id: string; data: string }): void {
  const tab = tabs.value.find((t) => t.id === payload.id)
  if (!tab) {
    // 无对应 Tab（主进程已有会话但本组件刚挂载且尚未 ptyList）：忽略，
    // 恢复流程以 ptyList 为准
    return
  }
  tab.term?.write(payload.data)
  // 有输出自动展开面板
  visible.value = true
}

function onPtyExit(payload: { id: string; code: number | null }): void {
  const tab = tabs.value.find((item) => item.id === payload.id)
  if (!tab) return
  tab.alive = false
  tab.exitCode = payload.code
  const codeText = payload.code ?? t('terminal.unknownCode')
  tab.term?.write(`\r\n\x1b[90m[${t('terminal.processExited', { code: codeText })}]\x1b[0m\r\n`)
}

// ---------- 右键菜单：送 AI 诊断 ----------

const ctxMenu = ref<{ x: number; y: number; text: string } | null>(null)

function openContextMenu(e: MouseEvent): void {
  const tab = activeTab()
  const selection = tab?.term?.hasSelection() ? tab.term!.getSelection() : ''
  if (!selection.trim()) {
    // 无选中：不拦截默认菜单（保留 xterm 原生复制等能力）
    ctxMenu.value = null
    return
  }
  e.preventDefault()
  ctxMenu.value = { x: e.clientX, y: e.clientY, text: selection }
}

/** 把选中文本送入聊天面板预填（沿用既有事件，summary 取选区尾部） */
function sendSelectionToAi(): void {
  const menu = ctxMenu.value
  ctxMenu.value = null
  if (!menu) return
  const summary = menu.text.length > 1200 ? menu.text.slice(-1200) : menu.text
  window.dispatchEvent(
    new CustomEvent('scholar:fix-terminal-error', {
      detail: {
        command: '',
        summary,
        severity: 'manual',
        hints: [],
        cwd: ws.rootPath || ''
      }
    })
  )
}

function closeContextMenu(): void {
  ctxMenu.value = null
}

// ---------- 高度拖拽 ----------

function startDrag(e: MouseEvent): void {
  e.preventDefault()
  dragging.value = true
  document.body.style.userSelect = 'none'
  document.body.style.cursor = 'row-resize'
  const onMove = (ev: MouseEvent): void => {
    // 面板位于底部：向上拖增大高度
    const panel = (ev.target as HTMLElement | null)?.closest?.('.terminal-panel') as HTMLElement | null
    const anchor = panel ?? document.querySelector('.terminal-panel')
    if (!anchor) return
    const rect = anchor.getBoundingClientRect()
    const h = rect.bottom - ev.clientY
    height.value = Math.min(500, Math.max(100, h))
    fitActive()
  }
  const onUp = (): void => {
    dragging.value = false
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    fitActive()
  }
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}

// ---------- 后台任务管理（沿用既有弹窗） ----------

const taskModalVisible = ref(false)
const tasks = ref<UiTaskSnapshot[]>([])
/** 展开输出的任务 id 集合 */
const expanded = ref<Set<string>>(new Set())
/** 各任务展开输出文本 */
const taskOutputs = ref<Record<string, string>>({})
/** 每秒刷新运行时长；展开的运行中任务顺便追读输出 */
const now = ref(Date.now())
let tickTimer: number | null = null
let tailTimer: number | null = null

function durationOf(t: UiTaskSnapshot): string {
  const end = t.status === 'exited' ? t.endedAt ?? t.startedAt : now.value
  const ms = Math.max(0, end - t.startedAt)
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  const rest = Math.floor(s % 60)
  if (m < 60) return `${m}m${String(rest).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

const runningCount = (): number => tasks.value.filter((t) => t.status === 'running').length

async function refreshTasks(): Promise<void> {
  tasks.value = await window.api.terminal.taskList()
}

async function openTaskModal(): Promise<void> {
  taskModalVisible.value = true
  await refreshTasks()
}

function closeTaskModal(): void {
  taskModalVisible.value = false
  expanded.value.clear()
  taskOutputs.value = {}
}

async function toggleTaskOutput(t: UiTaskSnapshot): Promise<void> {
  const next = new Set(expanded.value)
  if (next.has(t.id)) {
    next.delete(t.id)
  } else {
    next.add(t.id)
    const r = await window.api.terminal.taskTail(t.id, 0)
    if (r.ok) taskOutputs.value[t.id] = r.text
  }
  expanded.value = next
}

async function killTask(task: UiTaskSnapshot): Promise<void> {
  const r = await window.api.terminal.taskKill(task.id)
  if (!r.ok) tabInfoNote(t('terminal.killTaskFailed', { id: task.id, error: r.error }))
  await refreshTasks()
}

/** 后台任务错误提示：写到当前激活终端的回看里（简单追加一行） */
function tabInfoNote(text: string): void {
  activeTab()?.term?.write(`\r\n\x1b[33m${text}\x1b[0m\r\n`)
}

function handleTaskEvent(ev: BackgroundTaskEvent): void {
  if (ev.kind === 'task-start' || ev.kind === 'task-exit') {
    void refreshTasks()
  }
}

// ---------- 窗口尺寸 ----------

function onWindowResize(): void {
  fitActive()
}

/** v-for 容器元素回填 */
function bodyRef(tab: TermTab) {
  return (el: unknown): void => {
    tab.el = el as HTMLDivElement | null
  }
}

onMounted(async () => {
  // PTY 事件
  window.api.terminal.onPtyData(onPtyData)
  window.api.terminal.onPtyExit(onPtyExit)
  window.api.terminal.onTaskEvent(handleTaskEvent)
  window.addEventListener('resize', onWindowResize)
  document.addEventListener('mousedown', closeContextMenu)

  // 恢复主进程已有会话；没有则新建一个用户终端
  const list = await window.api.terminal.ptyList()
  if (list.length > 0) {
    for (const info of list) addTabForInfo(info, false)
    activeId.value = list[0].id
    await nextTick()
    requestAnimationFrame(() => fitActive())
  } else {
    await createTab()
  }

  await refreshTasks()
  tickTimer = window.setInterval(() => {
    now.value = Date.now()
  }, 1000)
  // 展开中的运行中任务每 1.5s 追读尾部输出
  tailTimer = window.setInterval(async () => {
    if (!taskModalVisible.value || expanded.value.size === 0) return
    for (const t of tasks.value) {
      if (expanded.value.has(t.id)) {
        const res = await window.api.terminal.taskTail(t.id, 0)
        if (res.ok) taskOutputs.value[t.id] = res.text
      }
    }
  }, 1500)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', onWindowResize)
  document.removeEventListener('mousedown', closeContextMenu)
  if (tickTimer !== null) clearInterval(tickTimer)
  if (tailTimer !== null) clearInterval(tailTimer)
  // PTY 会话在主进程保留（用户关 Tab 才杀），仅销毁本地渲染实例
  for (const tab of tabs.value) tab.term?.dispose()
})
</script>

<template>
  <!-- 折叠态：点击展开终端 -->
  <div v-if="!visible" class="term-collapsed" @click="visible = true">
    <span class="term-collapsed-icon">▶_</span>
    <span>{{ t('terminal.title') }}</span>
  </div>
  <!-- 展开态：完整终端面板 -->
  <div v-else class="terminal-panel" :style="{ height: height + 'px' }">
    <!-- 上边缘拖拽条：调整终端高度 -->
    <div class="term-drag" :class="{ active: dragging }" @mousedown="startDrag"></div>

    <!-- Tab 栏 -->
    <div class="term-tabbar">
      <div class="term-tabs">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          class="term-tab"
          :class="{ active: tab.id === activeId }"
          :title="`${tab.shell} · ${tab.id}`"
          @click="activateTab(tab.id)"
        >
          <span v-if="tab.origin === 'ai'" class="tab-ai">[AI]</span>
          <span class="tab-dot" :class="{ dead: !tab.alive }"></span>
          <span class="tab-label">{{ SHELL_LABEL[tab.shell] ?? tab.shell }}</span>
          <span
            class="tab-close"
            :title="t('terminal.closeTab')"
            @click.stop="closeTab(tab.id)"
          >✕</span>
        </button>
        <button class="term-tab tab-add" :title="t('terminal.newTab')" @click="createTab">＋</button>
      </div>
      <div class="term-actions">
        <button class="term-btn" :title="t('terminal.backgroundHint')" @click="openTaskModal">
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M2 3h12v2H2V3Zm0 4h12v2H2V7Zm0 4h8v2H2v-2Z"/></svg>
          <span v-if="runningCount() > 0" class="task-badge">{{ runningCount() }}</span>
        </button>
        <button class="term-btn icon-only" :title="t('terminal.clear')" @click="clearActive">
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M6 2h5l1 1v1H3v1h11V6H4v7a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1V8h2v5a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V4a2 2 0 0 1 2-2h2Z"/></svg>
        </button>
        <button class="term-btn icon-only" :title="t('terminal.hide')" @click="visible = false">
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M3 5h10v2H3V5Z"/></svg>
        </button>
      </div>
    </div>

    <!-- 终端容器（每个 Tab 一个；非激活 display:none） -->
    <div class="term-body-wrap" @contextmenu="openContextMenu">
      <div
        v-for="tab in tabs"
        :key="tab.id"
        class="term-body"
        :class="{ active: tab.id === activeId }"
        :ref="bodyRef(tab)"
      ></div>
    </div>

    <!-- 右键菜单：有选中文本时可送 AI 诊断 -->
    <div
      v-if="ctxMenu"
      class="term-ctx-menu"
      :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
      @click.stop
    >
      <button class="ctx-item" @click="sendSelectionToAi">{{ t('terminal.sendToAi') }}</button>
    </div>

    <!-- 后台任务管理弹窗（应用内 modal，禁原生弹窗） -->
    <div v-if="taskModalVisible" class="modal-overlay" @click.self="closeTaskModal">
      <div class="task-modal">
        <div class="task-modal-header">
          <span class="task-modal-title">{{ t('terminal.tasksTitle') }}</span>
          <button class="term-btn" :title="t('terminal.close')" @click="closeTaskModal">✕</button>
        </div>
        <div class="task-list">
          <div v-if="tasks.length === 0" class="task-empty">{{ t('terminal.taskEmpty') }}</div>
          <div v-for="task in tasks" :key="task.id" class="task-item">
            <div class="task-row">
              <span class="task-status" :class="task.status">{{ task.status === 'running' ? t('terminal.running') : t('terminal.exited') }}</span>
              <span class="task-cmd" :title="task.command">{{ task.command }}</span>
              <span class="task-meta">{{ durationOf(task) }} · pid {{ task.pid }}<template v-if="task.status === 'exited'"> · code {{ task.exitCode }}</template></span>
              <button class="task-op" @click="toggleTaskOutput(task)">{{ expanded.has(task.id) ? t('terminal.collapseOutput') : t('terminal.output') }}</button>
              <button v-if="task.status === 'running'" class="task-op danger" @click="killTask(task)">{{ t('terminal.kill') }}</button>
            </div>
            <pre v-if="expanded.has(task.id)" class="task-output">{{ taskOutputs[task.id] || t('terminal.noOutput') }}</pre>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 折叠态按钮条 */
.term-collapsed {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  background: var(--bg-tertiary, #0d1117);
  border-top: 1px solid var(--border, #1e2530);
  cursor: pointer;
  font-size: 12px;
  color: var(--text-secondary, #8b949e);
  transition: background 0.15s;
}
.term-collapsed:hover {
  background: var(--accent-dim, rgba(0, 212, 255, 0.1));
  color: var(--accent, #00d4ff);
}
.term-collapsed-icon { font-weight: bold; }

.terminal-panel {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: #141417;
  border-top: 1px solid var(--border);
  position: relative;
  min-height: 0;
  border-radius: 0 0 var(--radius-md) var(--radius-md);
  overflow: hidden;
}

/* 顶部拖拽条 */
.term-drag {
  position: absolute;
  top: -3px;
  left: 0;
  right: 0;
  height: 6px;
  cursor: row-resize;
  z-index: 5;
}
.term-drag:hover,
.term-drag.active {
  background: var(--primary);
  box-shadow: 0 0 6px var(--primary-dim);
}

/* Tab 栏 */
.term-tabbar {
  display: flex;
  align-items: stretch;
  justify-content: space-between;
  height: 32px;
  background: #1A1A1F;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.term-tabs {
  display: flex;
  align-items: stretch;
  min-width: 0;
}

.term-tab {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 0 8px;
  background: transparent;
  border: none;
  border-right: 1px solid var(--border);
  color: var(--text-muted);
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
  white-space: nowrap;
}
.term-tab:hover {
  color: var(--text-primary);
}
.term-tab.active {
  background: #141417;
  color: var(--primary);
  box-shadow: inset 0 -2px 0 var(--primary);
}

.tab-ai {
  color: #c792ea;
  font-size: 10px;
  font-weight: 700;
}

.tab-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #4ade80;
  box-shadow: 0 0 5px rgba(74, 222, 128, 0.7);
}
.tab-dot.dead {
  background: var(--text-muted);
  box-shadow: none;
}

.tab-label {
  font-family: var(--font-mono);
}

.tab-close {
  font-size: 10px;
  opacity: 0.55;
  padding: 0 2px;
}
.tab-close:hover {
  opacity: 1;
  color: #ff8da1;
}

.tab-add {
  font-size: 14px;
  color: var(--text-muted);
  padding: 0 10px;
}
.tab-add:hover {
  color: var(--accent);
}

.term-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  padding-right: 8px;
  flex-shrink: 0;
}

.term-btn {
  background: transparent;
  border: 1px solid transparent;
  border-radius: 4px;
  color: var(--text-muted);
  font-size: 11px;
  padding: 2px 8px;
  cursor: pointer;
  font-family: inherit;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.term-btn:hover {
  color: var(--primary);
  border-color: var(--border);
}
.term-btn.icon-only {
  padding: 4px;
  width: 26px;
  height: 26px;
  justify-content: center;
}

/* 终端容器区 */
.term-body-wrap {
  flex: 1;
  min-height: 0;
  position: relative;
}

.term-body {
  display: none;
  width: 100%;
  height: 100%;
  padding: 4px 6px 0;
}
.term-body.active {
  display: block;
}
.term-body :deep(.xterm) {
  height: 100%;
}
.term-body :deep(.xterm-viewport) {
  overflow-y: auto;
}

/* 右键菜单 */
.term-ctx-menu {
  position: fixed;
  z-index: 1200;
  min-width: 120px;
  background: #0f1520;
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.55);
  padding: 4px;
}
.ctx-item {
  display: block;
  width: 100%;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 12px;
  text-align: left;
  padding: 6px 10px;
  cursor: pointer;
  font-family: inherit;
}
.ctx-item:hover {
  background: var(--accent-dim);
  color: var(--accent);
}

/* 后台任务运行数角标 */
.task-badge {
  display: inline-block;
  min-width: 14px;
  margin-left: 4px;
  padding: 0 4px;
  border-radius: 7px;
  background: var(--accent);
  color: #04121b;
  font-size: 10px;
  font-weight: 700;
  text-align: center;
}

/* 后台任务管理弹窗 */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(2, 8, 16, 0.62);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.task-modal {
  width: min(720px, 88vw);
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  background: #0f1520;
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.55);
}
.task-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
}
.task-modal-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}
.task-list {
  overflow-y: auto;
  padding: 8px 14px 14px;
}
.task-empty {
  padding: 24px 0;
  text-align: center;
  color: var(--text-muted);
  font-size: 12px;
}
.task-item {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 10px;
  margin-bottom: 8px;
  background: #0b111a;
}
.task-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.task-status {
  flex-shrink: 0;
  font-size: 11px;
}
.task-status.running {
  color: #4ade80;
}
.task-status.exited {
  color: var(--text-muted);
}
.task-cmd {
  flex: 1;
  min-width: 0;
  color: #c9d4e3;
  font-family: var(--font-mono);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.task-meta {
  flex-shrink: 0;
  color: var(--text-muted);
  font-size: 11px;
}
.task-op {
  flex-shrink: 0;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-muted);
  font-size: 11px;
  padding: 1px 8px;
  cursor: pointer;
  font-family: inherit;
}
.task-op:hover {
  color: var(--accent);
  border-color: var(--accent);
}
.task-op.danger:hover {
  color: #f08d8d;
  border-color: #f08d8d;
}
.task-output {
  margin: 8px 0 0;
  max-height: 220px;
  overflow: auto;
  padding: 6px 8px;
  background: #070b11;
  border-radius: 4px;
  color: #9fb2c8;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
