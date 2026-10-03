<script setup lang="ts">
// 根布局：左侧文件树 / 中间 Monaco 编辑器 / 右侧 AI 聊天面板
// 三栏之间以可拖拽分隔条连接，中间编辑器铺满剩余空间；顶栏可切换 白/黑/蓝 主题
// 挂全局快捷键分发（capture 阶段）+ 命令面板 + 统一设置页
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import FileTree from './components/FileTree.vue'
import EditorPanel from './components/EditorPanel.vue'
import ChatPanel from './components/ChatPanel.vue'
import DiffViewer from './components/DiffViewer.vue'
import StagingPanel from './components/StagingPanel.vue'
import RepairCard from './components/RepairCard.vue'
import BuildCard from './components/BuildCard.vue'
import TimelinePanel from './components/TimelinePanel.vue'
import KanbanBoard from './components/KanbanBoard.vue'
import ScholarPanel from './components/ScholarPanel.vue'
import CommandPalette from './components/CommandPalette.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import { useStagingStore } from './stores/staging'
import { useRepairStore } from './stores/repair'
import { useBuildStore } from './stores/build'
import { useTimelineStore } from './stores/timeline'
import { useKanbanStore } from './stores/kanban'
import { useChatStore } from './stores/chat'
import { useWorkspaceStore } from './stores/workspace'
import { useThemeStore, type ThemeName } from './stores/theme'
import { useCommandRegistry, type CommandContext, type SettingsTab } from './commands/registry'

const ws = useWorkspaceStore()
const staging = useStagingStore()
const repair = useRepairStore()
const build = useBuildStore()
const timeline = useTimelineStore()
const kanban = useKanbanStore()
const chat = useChatStore()
const themeStore = useThemeStore()
const { t } = useI18n()

// ---------- 命令面板 / 统一设置页 ----------
const showPalette = ref(false)
const showSettings = ref(false)
const settingsTab = ref<SettingsTab>('general')

const cmdCtx: CommandContext = {
  openSettings: (tab) => {
    settingsTab.value = tab ?? 'general'
    showSettings.value = true
  },
  openPalette: () => { showPalette.value = true },
  toggleChatPanel: () => { chatVisible.value = !chatVisible.value }
}

// ChatPanel 头部设置图标通过自定义事件跳转设置页对应 Tab（组件解耦）
function onOpenSettingsEvent(e: Event): void {
  const tab = (e as CustomEvent<{ tab?: SettingsTab }>).detail?.tab
  cmdCtx.openSettings(tab)
}

// ---------- 全局快捷键分发 ----------
const registry = useCommandRegistry()

function isEditableTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el || !el.tagName) return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable
}

// capture 阶段监听，保证 Monaco 编辑器内按键也能命中命令（如 Ctrl+Shift+P）
function onGlobalKeydown(e: KeyboardEvent): void {
  if (showPalette.value) return // 面板打开时按键由面板自己处理
  const cmd = registry.matchCommand(e)
  if (!cmd) return
  // 输入框焦点下仅响应带修饰键的组合，避免误触
  if (isEditableTarget(e.target) && !e.ctrlKey && !e.altKey && !e.metaKey) return
  e.preventDefault()
  e.stopPropagation()
  cmd.run(cmdCtx)
}

// Windows 下原生标题栏被隐藏，右上角会叠加 最小化/最大化/关闭 三个按钮，顶栏需要留白
const isWin = window.api?.platform === 'win32'

// 主题切换按钮配置
const themeOptions: { key: ThemeName; label: string; dot: string }[] = [
  { key: 'light', label: '白', dot: '#F4F7FB' },
  { key: 'dark', label: '黑', dot: '#04060A' },
  { key: 'blue', label: '蓝', dot: '#00D4FF' }
]

// ---------- 布局状态持久化（localStorage） ----------
// 栏宽与左右栏折叠态重启后保留；读取出错/越界一律回落默认值
const LAYOUT_KEY = 'scholar:layout'

interface LayoutPrefs {
  leftWidth: number
  rightWidth: number
  leftVisible: boolean
  chatVisible: boolean
}

function loadLayoutPrefs(): LayoutPrefs {
  const def: LayoutPrefs = { leftWidth: 20, rightWidth: 30, leftVisible: true, chatVisible: true }
  try {
    const raw = localStorage.getItem(LAYOUT_KEY)
    if (!raw) return def
    const o = JSON.parse(raw) as Partial<LayoutPrefs>
    return {
      leftWidth: typeof o.leftWidth === 'number' ? Math.min(40, Math.max(10, o.leftWidth)) : def.leftWidth,
      rightWidth: typeof o.rightWidth === 'number' ? Math.min(50, Math.max(15, o.rightWidth)) : def.rightWidth,
      leftVisible: o.leftVisible !== false,
      chatVisible: o.chatVisible !== false
    }
  } catch {
    return def
  }
}

const layoutPrefs = loadLayoutPrefs()
// 左右栏宽度（百分比），中间编辑器 flex:1 自动铺满剩余空间
const leftWidth = ref(layoutPrefs.leftWidth)
const rightWidth = ref(layoutPrefs.rightWidth)
const chatVisible = ref(layoutPrefs.chatVisible)
// 左侧资源管理器整体折叠（需求§一：折叠后中间区自动扩展填充）
const fileTreeVisible = ref(layoutPrefs.leftVisible)

// 任一布局状态变化即持久化（拖拽/折叠均为高频低频混合，写 localStorage 成本可忽略）
watch([leftWidth, rightWidth, fileTreeVisible, chatVisible], () => {
  try {
    localStorage.setItem(
      LAYOUT_KEY,
      JSON.stringify({
        leftWidth: leftWidth.value,
        rightWidth: rightWidth.value,
        leftVisible: fileTreeVisible.value,
        chatVisible: chatVisible.value
      })
    )
  } catch {
    /* 存储不可用时静默降级 */
  }
  // 折叠/展开后通知 Monaco 重排
  requestAnimationFrame(() => window.dispatchEvent(new Event('resize')))
})
// 当前正在拖拽的分隔条（用于高亮 + 禁用文本选择）
const dragging = ref<'left' | 'right' | null>(null)

// 开始拖拽：监听 document 级 mousemove/mouseup，按比例更新栏宽
function startDrag(which: 'left' | 'right', e: MouseEvent): void {
  e.preventDefault()
  dragging.value = which
  document.body.style.userSelect = 'none'
  document.body.style.cursor = 'col-resize'

  const onMove = (ev: MouseEvent): void => {
    const layout = document.querySelector('.main-layout')
    if (!layout) return
    const rect = layout.getBoundingClientRect()
    if (which === 'left') {
      const pct = ((ev.clientX - rect.left) / rect.width) * 100
      leftWidth.value = Math.min(40, Math.max(10, pct))
    } else {
      const pct = ((rect.right - ev.clientX) / rect.width) * 100
      rightWidth.value = Math.min(50, Math.max(15, pct))
    }
    // 栏宽变化后通知 Monaco 重排，保证编辑器铺满
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')))
  }
  const onUp = (): void => {
    dragging.value = null
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    // 拖拽结束再兜底重排一次
    window.dispatchEvent(new Event('resize'))
  }
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}

onMounted(async () => {
  // 全局快捷键分发（capture）+ ChatPanel 设置入口事件
  window.addEventListener('keydown', onGlobalKeydown, true)
  window.addEventListener('scholar:open-settings', onOpenSettingsEvent)

  // 欢迎页快捷入口：确保面板可见后再派发内部事件
  window.addEventListener('scholar:request-new-file', () => {
    fileTreeVisible.value = true
    nextTick(() => window.dispatchEvent(new CustomEvent('scholar:new-file')))
  })
  window.addEventListener('scholar:request-ai', () => {
    chatVisible.value = true
  })

  // ㊝ 暂存事件：变更后刷面板数据；bash 前接受门直接唤起审阅面板
  window.api.staging.onChanged(() => {
    void staging.refresh(ws.rootPath)
  })
  window.api.ai.onBashAcceptRequest((payload) => {
    void staging.openBashGate(ws.rootPath, payload.id, payload.summary)
  })
  // s45/s46：终端失败修复提案 + 自动回归结果 → 修复卡片
  // 注意：事件监听必须先于任何 await 注册——异步等待期间到达的广播没有监听器会永久丢失
  window.api.terminal.onRepairProposals((p) => repair.onProposal(p))
  window.api.test.onAutoRun((r) => repair.onAutoTest(r))
  // s47：打包日志与完成事件 → 构建卡片
  window.api.build.onLog((l) => build.onLog(l))
  window.api.build.onDone((d) => build.onDone(d))
  // s48 执行时间线：面板数据 + 看板证据挂载（监听必须先于 await 注册）
  window.api.ai.onTimelineUpdate((p) => {
    timeline.onPayload(p)
    kanban.onTimeline(p)
  })
  // s49 看板：todos 变化即对账（chat store 另有独立监听，互不影响）
  window.api.ai.onTodoUpdate((items) => {
    kanban.syncFromTodos(items, chat.activeTaskId)
  })
  // 工作区切换：重载看板、清空旧时间线
  watch(
    () => ws.rootPath,
    (root, old) => {
      if (root !== old) {
        timeline.reset()
        void kanban.init(root)
      }
    }
  )
  // 打开应用时自动检查 Ollama 健康状态（耗时网络探测，放监听注册之后）
  await ws.checkOllama()
  // 工作区恢复完成后同步审阅开关（恢复列表里可能也有待决暂存）
  await ws.restoreReady
  await Promise.all([staging.loadEnabled(ws.rootPath), staging.refresh(ws.rootPath)])
  // s49 载入已落盘看板
  await kanban.init(ws.rootPath)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKeydown, true)
  window.removeEventListener('scholar:open-settings', onOpenSettingsEvent)
})
</script>

<template>
  <div class="app-shell">
    <!-- 顶部标题栏（Windows 下整条可拖动，右侧为原生窗口按钮留白） -->
    <header class="topbar" :class="{ win: isWin }" :style="isWin ? { paddingRight: '138px' } : {}">
      <div class="brand">
        <span class="logo">⌘</span>
        <span class="title">ScholarTreaCode</span>
        <span class="subtitle">AI 本地编辑器</span>
      </div>
      <div class="actions">
        <!-- 主题切换：白 / 黑 / 蓝 -->
        <div class="theme-switch cp-glass">
          <button
            v-for="opt in themeOptions"
            :key="opt.key"
            class="theme-btn"
            :class="{ active: themeStore.theme === opt.key }"
            :title="`切换到${opt.label}色主题`"
            @click="themeStore.setTheme(opt.key)"
          >
            <span class="theme-dot" :style="{ background: opt.dot }"></span>
            <span>{{ opt.label }}</span>
          </button>
        </div>
        <!-- 组间垂直分隔线 -->
        <span class="actions-divider"></span>
        <button class="cp-btn icon-btn" @click="ws.selectWorkspace" :title="ws.rootPath ? t('app.switchDir') : t('app.selectWorkspace')">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path fill="currentColor" d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Zm2 0v11h14V8H10l-2-2H5Z"/>
          </svg>
        </button>
        <button class="cp-btn icon-btn" @click="fileTreeVisible = !fileTreeVisible" :aria-expanded="fileTreeVisible" :title="fileTreeVisible ? t('app.hideFiles') : t('app.showFiles')">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path fill="currentColor" d="M3 5a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5Zm3 1v12h3V6H6Zm5 0h8v12h-8V6Z"/>
          </svg>
        </button>
        <button class="cp-btn icon-btn" @click="chatVisible = !chatVisible" :aria-expanded="chatVisible" :title="chatVisible ? t('app.hideAi') : t('app.showAi')">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path fill="currentColor" d="M12 3a3 3 0 0 1 3 3v1h1a3 3 0 0 1 3 3v5a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3v-5a3 3 0 0 1 3-3h1V6a3 3 0 0 1 3-3Zm-1 3v1h2V6a1 1 0 0 0-2 0Zm-3 6a1.2 1.2 0 1 0 0-2.4A1.2 1.2 0 0 0 8 12Zm8 0a1.2 1.2 0 1 0 0-2.4A1.2 1.2 0 0 0 16 12Zm-3.5 3.5c.7-.7 1.7-1 2.7-1s2 .3 2.7 1c.2.2.2.5 0 .7-.2.2-.5.2-.7 0-.4-.4-.9-.6-1.4-.6s-1 .2-1.4.6c-.2.2-.5.2-.7 0-.2-.2-.2-.5 0-.7ZM12 1a1 1 0 0 1 1 1v1a1 1 0 1 1-2 0V2a1 1 0 0 1 1-1Z"/>
          </svg>
        </button>
      </div>
    </header>

    <!-- 主体三栏：左右宽度可调且均可折叠，中间铺满 -->
    <main class="main-layout" :class="{ dragging: dragging !== null }">
      <template v-if="fileTreeVisible">
        <aside class="sidebar left" :style="{ width: leftWidth + '%' }">
          <FileTree />
        </aside>
        <div
          class="splitter"
          :class="{ active: dragging === 'left' }"
          @mousedown="startDrag('left', $event)"
        ></div>
      </template>
      <section class="editor-area">
        <EditorPanel />
      </section>
      <template v-if="chatVisible">
        <div
          class="splitter"
          :class="{ active: dragging === 'right' }"
          @mousedown="startDrag('right', $event)"
        ></div>
        <aside class="sidebar right" :style="{ width: rightWidth + '%' }">
          <ChatPanel />
        </aside>
      </template>
    </main>

    <!-- Git 改动/检查点差异面板（fixed 遮罩，挂根层级规避 cp-page z-index） -->
    <DiffViewer />
    <!-- ㊝ 变更事务暂存审阅面板（AI 改动接受后才落盘） -->
    <StagingPanel />
    <!-- s45/s46 失败修复确认卡片（含自动回归 toast） -->
    <RepairCard />
    <!-- s47 一键打包构建卡片 -->
    <BuildCard />
    <!-- s48 执行时间线（失败标红 + 从此步重跑） -->
    <TimelinePanel />
    <!-- s49 卡片式任务看板（四列 + 单卡片暂停/回滚） -->
    <KanbanBoard />
    <!-- s54–s56 学术/报告链路（数据→图表→报告→文献） -->
    <ScholarPanel />

    <!-- 命令面板（Ctrl+Shift+P）与统一设置页 -->
    <CommandPalette v-if="showPalette" :ctx="cmdCtx" @close="showPalette = false" />
    <SettingsPanel v-if="showSettings" :initial-tab="settingsTab" @close="showSettings = false" />
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
  /* 左右下 8px 内边距留出卡片呼吸空间；顶部留 0 让顶栏贴合原生标题栏按钮区 */
  padding: 0 8px 8px;
  gap: 8px;
  background: var(--bg-base);
  box-sizing: border-box;
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  height: 44px;
  background: var(--topbar-bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--topbar-shadow);
  flex-shrink: 0;
}

/* Windows 自绘标题栏：整条顶栏可拖动移动窗口 */
.topbar.win {
  -webkit-app-region: drag;
}
/* 交互控件必须排除在拖动区域外，否则无法点击 */
.topbar.win .actions,
.topbar.win .actions button,
.topbar.win .actions .theme-switch {
  -webkit-app-region: no-drag;
}

.brand {
  display: flex;
  align-items: center;
  gap: 8px;
}

.logo {
  color: var(--accent);
  font-size: 18px;
  font-weight: bold;
  text-shadow: var(--logo-shadow);
}

.title {
  font-weight: 600;
  color: var(--text-primary);
  letter-spacing: 1px;
}

.subtitle {
  color: var(--text-muted);
  font-size: 11px;
  margin-left: 4px;
  letter-spacing: 2px;
}

.actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

/* 组间垂直分隔线：1px 细线 */
.actions-divider {
  width: 1px;
  height: 18px;
  background: #3E3E42;
  margin: 0 6px;
  flex-shrink: 0;
}

/* 顶栏图标按钮：方形，仅放图标 */
.icon-btn {
  padding: 6px;
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  border-radius: 4px;
}
.icon-btn:hover {
  color: var(--text-primary);
  background: rgba(255, 255, 255, 0.1);
}

/* 主题切换器 */
.theme-switch {
  display: flex;
  padding: 2px;
  gap: 2px;
  border-radius: 5px;
}

.theme-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 4px;
  color: var(--text-secondary);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}
.theme-btn:hover {
  color: var(--accent);
}
.theme-btn.active {
  background: var(--accent-dim);
  border-color: var(--accent);
  color: var(--accent);
}

.theme-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 1px solid var(--border-light);
}

.main-layout {
  display: flex;
  flex: 1;
  overflow: hidden;
  gap: 8px;
}

/* 拖拽中禁用内部指针事件，避免 Monaco/文本干扰拖拽 */
.main-layout.dragging .editor-area,
.main-layout.dragging .sidebar {
  pointer-events: none;
}

.sidebar {
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
}

/* 中间编辑器铺满剩余空间（卡片化） */
.editor-area {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}

/* 可拖拽分隔条：4px 宽，透明，悬停高亮 */
.splitter {
  width: 4px;
  flex-shrink: 0;
  cursor: col-resize;
  background: transparent;
  position: relative;
  transition: background 0.15s;
  border-radius: 2px;
}
.splitter::after {
  content: '';
  position: absolute;
  inset: 0;
  background: var(--border);
  border-radius: 2px;
  opacity: 0;
  transition: opacity 0.15s;
}
.splitter:hover::after,
.splitter.active::after {
  background: var(--accent);
  opacity: 1;
}
</style>
