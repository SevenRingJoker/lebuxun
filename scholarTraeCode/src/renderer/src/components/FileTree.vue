<script setup lang="ts">
// 文件树组件：递归渲染 workspace 目录结构
// 支持右键菜单（新建文件/文件夹、重命名、移入回收站、资源管理器定位、复制路径、刷新）
import { ref, computed, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { useWorkspaceStore, type FsNode } from '../stores/workspace'
import TreeItem from './TreeItem.vue'
import DebugPanel from './DebugPanel.vue'
import ValidationPanel from './ValidationPanel.vue'
import ProblemsPanel from './ProblemsPanel.vue'
import SearchPanel from './SearchPanel.vue'
import ScmPanel from './ScmPanel.vue'
import { lspClient } from '../lsp/lspClient'

const ws = useWorkspaceStore()
const { t } = useI18n()

// 左栏分段：文件 / 搜索 / 调试 / 验证 / 问题
const leftTab = ref<'files' | 'scm' | 'search' | 'debug' | 'validation' | 'problems'>('files')

// 问题 Tab 徽章：诊断总数（随 lspClient 诊断版本号响应式更新）
const problemTotal = computed(() => {
  void lspClient.diagnosticsVersion.value
  return lspClient.getAllDiagnostics().reduce((n, x) => n + x.diagnostics.length, 0)
})

// ---------- 右键菜单 ----------
type MenuAction =
  | 'newFile'
  | 'newDir'
  | 'open'
  | 'rename'
  | 'delete'
  | 'show'
  | 'copyPath'
  | 'refresh'

interface MenuItem {
  label: string
  action?: MenuAction
  divider?: boolean
  danger?: boolean
}

// 右键目标节点：null 表示工作区根/空白区域
const targetNode = ref<FsNode | null>(null)
const menuVisible = ref(false)
const menuX = ref(0)
const menuY = ref(0)

// 根据目标节点生成菜单项
function buildMenuItems(node: FsNode | null): MenuItem[] {
  if (!node) {
    // 空白区域 / 根
    return [
      { label: t('fileTree.newFile'), action: 'newFile' },
      { label: t('fileTree.newFolder'), action: 'newDir' },
      { label: '', divider: true },
      { label: t('fileTree.showInExplorer'), action: 'show' },
      { label: t('fileTree.refresh'), action: 'refresh' }
    ]
  }
  if (node.type === 'directory') {
    return [
      { label: t('fileTree.newFile'), action: 'newFile' },
      { label: t('fileTree.newFolder'), action: 'newDir' },
      { label: '', divider: true },
      { label: t('fileTree.rename'), action: 'rename' },
      { label: t('fileTree.delete'), action: 'delete', danger: true },
      { label: '', divider: true },
      { label: t('fileTree.showInExplorer'), action: 'show' },
      { label: t('fileTree.copyPath'), action: 'copyPath' },
      { label: '', divider: true },
      { label: t('fileTree.refresh'), action: 'refresh' }
    ]
  }
  return [
    { label: t('common.ok'), action: 'open' },
    { label: '', divider: true },
    { label: t('fileTree.rename'), action: 'rename' },
    { label: t('fileTree.delete'), action: 'delete', danger: true },
    { label: '', divider: true },
    { label: t('fileTree.showInExplorer'), action: 'show' },
    { label: t('fileTree.copyPath'), action: 'copyPath' }
  ]
}

const menuItems = ref<MenuItem[]>([])

// 菜单项点击后由 FileTree 主动关闭（overlay 点击只关菜单）
const MENU_WIDTH = 200
const MENU_ROW = 30

function showMenu(node: FsNode | null, clientX: number, clientY: number): void {
  if (!ws.rootPath) return
  targetNode.value = node
  menuItems.value = buildMenuItems(node)
  // 边界收敛，避免菜单超出窗口
  const maxX = window.innerWidth - MENU_WIDTH - 8
  const maxY = window.innerHeight - menuItems.value.length * MENU_ROW - 8
  menuX.value = Math.max(4, Math.min(clientX, maxX))
  menuY.value = Math.max(4, Math.min(clientY, maxY))
  menuVisible.value = true
}

// TreeItem 冒泡上来的右键事件
function onNodeContextMenu(payload: { node: FsNode; x: number; y: number }): void {
  showMenu(payload.node, payload.x, payload.y)
}

// 树空白区域右键：目标为根目录
function onTreeContextMenu(e: MouseEvent): void {
  e.preventDefault()
  showMenu(null, e.clientX, e.clientY)
}

// ---------- 名称输入弹窗 ----------
const modalVisible = ref(false)
const modalTitle = ref('')
const modalPlaceholder = ref('')
const modalValue = ref('')
const modalError = ref('')
const modalBusy = ref(false)
// 重命名时默认选中主文件名（不含扩展名），新建时全选
const modalInputRef = ref<HTMLInputElement | null>(null)
// 确认回调：返回错误字符串则弹窗保持打开，返回空串关闭
let modalConfirm: ((value: string) => Promise<string>) | null = null
// 弹窗输入框的健壮聚焦定时器 / 窗口焦点回调（关闭时统一清理）
let modalFocusTimers: number[] = []
let modalWindowFocusHandler: (() => void) | null = null

// 把焦点可靠地交给弹窗输入框。
// 背景：Windows（尤其远程桌面）下窗口可能尚未持有 OS 键盘焦点，
// 单次 focus() 会落空；窗口随后获得前台焦点时也需重新聚焦，否则用户敲字无反应。
function focusModalInputRobust(initialValue: string, selectBase: boolean): void {
  const doFocus = (): void => {
    const input = modalInputRef.value
    if (!input || !modalVisible.value) return
    input.focus()
    if (selectBase && initialValue.includes('.')) {
      const dot = initialValue.lastIndexOf('.')
      input.setSelectionRange(0, dot > 0 ? dot : initialValue.length)
    } else {
      input.select()
    }
  }
  modalFocusTimers.forEach((t) => window.clearTimeout(t))
  modalFocusTimers = [0, 50, 150, 300].map((delay) => window.setTimeout(doFocus, delay))
  // 窗口从非前台变为前台（用户第一次点击仅激活窗口）时，把焦点补到输入框
  modalWindowFocusHandler = (): void => doFocus()
  window.addEventListener('focus', modalWindowFocusHandler)
}

function openModal(
  title: string,
  placeholder: string,
  initialValue: string,
  selectBase: boolean,
  onConfirm: (value: string) => Promise<string>
): void {
  modalTitle.value = title
  modalPlaceholder.value = placeholder
  modalValue.value = initialValue
  modalError.value = ''
  modalConfirm = onConfirm
  modalVisible.value = true
  nextTick(() => focusModalInputRobust(initialValue, selectBase))
}

function clearModalFocusEffects(): void {
  modalFocusTimers.forEach((t) => window.clearTimeout(t))
  modalFocusTimers = []
  if (modalWindowFocusHandler) {
    window.removeEventListener('focus', modalWindowFocusHandler)
    modalWindowFocusHandler = null
  }
}

function closeModal(): void {
  if (modalBusy.value) return
  modalVisible.value = false
  modalConfirm = null
  clearModalFocusEffects()
}

async function onModalConfirm(): Promise<void> {
  if (!modalConfirm || modalBusy.value) return
  modalBusy.value = true
  modalError.value = ''
  try {
    const err = await modalConfirm(modalValue.value)
    if (!err) {
      modalVisible.value = false
      modalConfirm = null
      clearModalFocusEffects()
    } else {
      modalError.value = err
      // 校验失败（如名称为空）后把焦点立刻还给输入框，方便用户直接重输
      focusModalInputRobust(modalValue.value, false)
    }
  } catch (e: any) {
    // IPC 层异常（如主进程未注册该通道、preload 未更新）也要明确展示，
    // 否则表现为点击「确定」毫无反应
    modalError.value =
      e?.message || String(e?.error) || '操作失败：请完全重启应用（主进程可能未更新）'
  } finally {
    modalBusy.value = false
  }
}

function onModalKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter') {
    e.preventDefault()
    void onModalConfirm()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    closeModal()
  }
}

// 点击弹窗空白区域（非输入框/按钮）时保持输入框焦点，避免敲字突然无反应
function onModalBoxMouseDown(e: MouseEvent): void {
  const target = e.target as HTMLElement
  if (target.tagName !== 'INPUT' && target.tagName !== 'BUTTON') {
    e.preventDefault()
    modalInputRef.value?.focus()
  }
}

// ---------- 应用内确认/提示弹窗（替代 window.confirm / window.alert） ----------
// 关键：Electron 的 window.confirm/alert 是同步阻塞渲染进程的原生模态框，
// 在 Windows 远程桌面/自绘标题栏下可能弹到窗口背后且不可见，表现为界面整个冻死、无法操作。
const dlgVisible = ref(false)
const dlgTitle = ref('')
const dlgMessage = ref('')
const dlgConfirmText = ref('确定')
const dlgDanger = ref(false)
const dlgShowCancel = ref(true)
let dlgResolve: ((ok: boolean) => void) | null = null
// 确认按钮引用：弹窗打开后聚焦它，保证 Enter/Esc 能在弹窗内被处理
const dlgConfirmBtnRef = ref<HTMLButtonElement | null>(null)
let dlgFocusTimers: number[] = []

// 多帧把焦点落到确认按钮上（远程桌面下窗口可能刚被激活，单次 focus 会落空）
function focusDlgConfirm(): void {
  dlgFocusTimers.forEach((t) => window.clearTimeout(t))
  dlgFocusTimers = [0, 60, 200].map((delay) =>
    window.setTimeout(() => {
      if (dlgVisible.value) dlgConfirmBtnRef.value?.focus()
    }, delay)
  )
}

// 二次确认框：返回 true=确认 / false=取消
function appConfirm(opts: {
  title: string
  message?: string
  confirmText?: string
  danger?: boolean
}): Promise<boolean> {
  return new Promise((resolve) => {
    dlgTitle.value = opts.title
    dlgMessage.value = opts.message || ''
    dlgConfirmText.value = opts.confirmText || '确定'
    dlgDanger.value = !!opts.danger
    dlgShowCancel.value = true
    dlgResolve = resolve
    dlgVisible.value = true
    nextTick(focusDlgConfirm)
  })
}

// 错误/信息提示框：仅一个「知道了」按钮
function appAlert(title: string, message: string): Promise<void> {
  return new Promise((resolve) => {
    dlgTitle.value = title
    dlgMessage.value = message
    dlgConfirmText.value = '知道了'
    dlgDanger.value = false
    dlgShowCancel.value = false
    dlgResolve = () => resolve()
    dlgVisible.value = true
    nextTick(focusDlgConfirm)
  })
}

function onDlgChoose(ok: boolean): void {
  dlgVisible.value = false
  dlgFocusTimers.forEach((t) => window.clearTimeout(t))
  dlgFocusTimers = []
  const resolve = dlgResolve
  dlgResolve = null
  resolve?.(ok)
}

function onDlgKeydown(e: KeyboardEvent): void {
  // 提示框（无取消按钮）时 Enter/Esc 都等同确认
  if (e.key === 'Enter' || (!dlgShowCancel.value && e.key === 'Escape')) {
    e.preventDefault()
    onDlgChoose(true)
  } else if (e.key === 'Escape') {
    e.preventDefault()
    onDlgChoose(false)
  }
}

// ---------- 新建/重命名后要求展开的目录 ----------
const expandedPaths = ref<string[]>([])
// 新建目标所在目录（目录节点即自身，根/文件取工作区根）
function targetDir(node: FsNode | null): string {
  if (node?.type === 'directory') return node.path
  return ws.rootPath as string
}

// ---------- 菜单动作 ----------
async function onMenuAction(item: MenuItem): Promise<void> {
  menuVisible.value = false
  const action = item.action
  if (!action) return

  switch (action) {
    case 'refresh':
      await ws.loadTree()
      return
    case 'open':
      if (targetNode.value) await ws.openFile(targetNode.value.path)
      return
    case 'copyPath':
      if (targetNode.value) {
        try {
          await navigator.clipboard.writeText(targetNode.value.path)
        } catch (err) {
          console.error('复制路径失败:', err)
        }
      }
      return
    case 'show':
      await window.api.fs.showItem(targetNode.value ? targetNode.value.path : (ws.rootPath as string))
      return
    case 'newFile': {
      const dir = targetDir(targetNode.value)
      if (targetNode.value?.type === 'directory') {
        expandedPaths.value = [...new Set([...expandedPaths.value, targetNode.value.path])]
      }
      openModal('新建文件', '文件名，支持相对路径，如 src/index.ts', '', false, async (name) => {
        const res = await window.api.fs.createFile(dir, name)
        if (!res.ok) return res.error || '创建失败'
        await ws.loadTree()
        if (res.path) await ws.openFile(res.path)
        return ''
      })
      return
    }
    case 'newDir': {
      const dir = targetDir(targetNode.value)
      if (targetNode.value?.type === 'directory') {
        expandedPaths.value = [...new Set([...expandedPaths.value, targetNode.value.path])]
      }
      openModal('新建文件夹', '文件夹名，支持相对路径，如 src/components', '', false, async (name) => {
        const res = await window.api.fs.createDirectory(dir, name)
        if (!res.ok) return res.error || '创建失败'
        await ws.loadTree()
        return ''
      })
      return
    }
    case 'rename': {
      const node = targetNode.value
      if (!node) return
      const oldPath = node.path
      const wasCurrent = ws.currentFile === oldPath
      openModal('重命名', '输入新名称', node.name, true, async (newName) => {
        const res = await window.api.fs.rename(oldPath, newName)
        if (!res.ok) return res.error || '重命名失败'
        await ws.loadTree()
        // 当前打开的文件被改名：重新打开新路径
        if (wasCurrent && res.path) await ws.openFile(res.path)
        return ''
      })
      return
    }
    case 'delete': {
      const node = targetNode.value
      if (!node) return
      // 多选删除：右键节点在选中集合内时，删除全部选中项
      const selectedSet = ws.selectedPaths
      const isMulti = selectedSet.size > 0 && selectedSet.has(node.path)
      const paths = isMulti ? [...selectedSet] : [node.path]

      // 检查是否有选中项影响当前打开的文件
      const affectsCurrent =
        !!ws.currentFile &&
        paths.some(
          (p) => ws.currentFile === p || isPathInside(ws.currentFile!, p + '\\')
        )
      const dirtyHint =
        affectsCurrent && ws.fileDirty ? '当前文件有未保存的修改，删除后这些修改将无法保存。' : ''

      const count = paths.length
      const confirmed = await appConfirm({
        title: `删除${isMulti ? ` ${count} 项` : node.type === 'directory' ? '文件夹' : '文件'}`,
        message: isMulti
          ? `确定将选中的 ${count} 项移入回收站吗？${dirtyHint ? '\n\n' + dirtyHint : ''}`
          : `确定将${node.type === 'directory' ? '文件夹及其全部内容' : '文件'}「${node.name}」移入回收站吗？${dirtyHint ? '\n\n' + dirtyHint : ''}`,
        confirmText: '移入回收站',
        danger: true
      })
      if (!confirmed) return

      // 逐个删除（回收站），收集失败项
      const failed: string[] = []
      for (const p of paths) {
        try {
          const res = await window.api.fs.trash(p)
          if (!res.ok) failed.push(p)
        } catch {
          failed.push(p)
        }
      }

      if (failed.length > 0) {
        await appAlert('部分删除失败', `${failed.length} 项删除失败，可能已被移动或删除。`)
      }

      await ws.loadTree()
      ws.clearSelection()
      if (affectsCurrent) ws.closeFile()
      return
    }
  }
}

// 头部「+」按钮：在工作区根新建文件
function onQuickNewFile(e: MouseEvent): void {
  if (!ws.rootPath) return
  showMenu(null, e.clientX - 160, e.clientY + 28)
}

// ---------- 拖拽移动 ----------
const draggingNode = ref<FsNode | null>(null)
const dropTargetPath = ref<string | null>(null)

// ---------- 多选（Shift 范围 / Ctrl 单选） ----------
// 将可见树展平为一维列表，用于 Shift+click 范围选择
function flattenVisible(nodes: FsNode[], expanded: string[]): FsNode[] {
  const result: FsNode[] = []
  function walk(list: FsNode[]): void {
    for (const n of list) {
      result.push(n)
      if (n.type === 'directory' && n.children && expanded.includes(n.path)) {
        walk(n.children)
      }
    }
  }
  walk(nodes)
  return result
}

// TreeItem 冒泡的 shift/ctrl 点击
function onNodeSelect(payload: { node: FsNode; shiftKey: boolean; ctrlKey: boolean }): void {
  const { node, shiftKey } = payload
  if (shiftKey && ws.lastClickedPath) {
    // 范围选择：从上次点击到当前节点之间的所有可见节点
    const flat = flattenVisible(ws.tree, expandedPaths.value)
    const fromIdx = flat.findIndex((n) => n.path === ws.lastClickedPath)
    const toIdx = flat.findIndex((n) => n.path === node.path)
    if (fromIdx >= 0 && toIdx >= 0) {
      const [start, end] = fromIdx < toIdx ? [fromIdx, toIdx] : [toIdx, fromIdx]
      ws.setSelection(flat.slice(start, end + 1).map((n) => n.path))
    } else {
      ws.setSelection([node.path])
    }
    return
  }
  // Ctrl+click：切换单个节点
  ws.toggleSelection(node.path)
  ws.lastClickedPath = node.path
}

// 普通点击：清空多选，记录最后点击
function onNodeActivate(payload: { node: FsNode }): void {
  ws.clearSelection()
  ws.lastClickedPath = payload.node.path
}

// 统一用反斜杠判断包含关系（Windows 路径；同时兼容 / 分隔）
function isPathInside(child: string, dir: string): boolean {
  const norm = (s: string): string => s.replace(/\//g, '\\').replace(/\\+$/, '')
  const c = norm(child)
  const d = norm(dir)
  return c !== d && c.startsWith(d + '\\')
}

// 判断拖拽源是否允许放到目标目录
function canDrop(src: FsNode | null, destDir: string): boolean {
  if (!src || !ws.rootPath) return false
  if (src.path === destDir) return false
  // 文件夹不能拖入自身或自己的子目录
  if (src.type === 'directory' && isPathInside(destDir, src.path)) return false
  return true
}

function onNodeDragStart(payload: { node: FsNode }): void {
  draggingNode.value = payload.node
  dropTargetPath.value = null
}

function onNodeDragOver(payload: { node: FsNode }): void {
  if (!draggingNode.value) return
  if (canDrop(draggingNode.value, payload.node.path)) {
    dropTargetPath.value = payload.node.path
  }
}

function onNodeDragLeave(payload: { node: FsNode }): void {
  // 仅当离开的正是当前高亮目标时清除（移入子节点时子节点会先更新高亮）
  if (dropTargetPath.value === payload.node.path) {
    dropTargetPath.value = null
  }
}

// 树空白区域：允许放置到工作区根目录
function onTreeDragOver(e: DragEvent): void {
  if (!draggingNode.value || !canDrop(draggingNode.value, ws.rootPath as string)) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
}

function onTreeDrop(e: DragEvent): void {
  if (!draggingNode.value || !ws.rootPath) return
  e.preventDefault()
  // 事件目标若命中目录节点，已由 node-drop 处理（stopPropagation）；
  // 走到这里说明落在空白区域，目标为工作区根
  void doMove(ws.rootPath)
}

function onNodeDrop(payload: { node: FsNode }): void {
  void doMove(payload.node.path)
}

function onNodeDragEnd(): void {
  draggingNode.value = null
  dropTargetPath.value = null
}

// 在树中按路径查找节点
function findNode(nodes: FsNode[], path: string): FsNode | null {
  for (const n of nodes) {
    if (n.path === path) return n
    if (n.type === 'directory' && n.children) {
      const found = findNode(n.children, path)
      if (found) return found
    }
  }
  return null
}

// 执行移动：确认 → 逐个 IPC 移动 → 刷新树 → 必要时重开当前文件
async function doMove(destDir: string): Promise<void> {
  const src = draggingNode.value
  draggingNode.value = null
  dropTargetPath.value = null
  if (!src || !ws.rootPath) return

  // 多选移动：拖拽源在选中集合内时，移动全部选中项
  const selectedSet = ws.selectedPaths
  const isMulti = selectedSet.size > 1 && selectedSet.has(src.path)
  const movePaths = isMulti ? [...selectedSet] : [src.path]

  const normSep = (s: string): string => s.replace(/\//g, '\\').replace(/\\+$/, '')
  const destName = destDir === ws.rootPath ? '工作区根目录' : destDir.slice(destDir.lastIndexOf('\\') + 1)

  // 过滤掉不可放置的项（如目标自身、目录拖入自己的子目录）
  const validPaths = movePaths.filter((p) => {
    const node = findNode(ws.tree, p)
    return canDrop(node, destDir) &&
      normSep(p.slice(0, p.lastIndexOf('\\'))) !== normSep(destDir)
  })
  if (validPaths.length === 0) return

  const count = validPaths.length
  const confirmed = await appConfirm({
    title: '移动文件',
    message: isMulti
      ? `将选中的 ${count} 项移动到文件夹「${destName}」中？`
      : `将「${src.name}」移动到文件夹「${destName}」中？`,
    confirmText: '移动'
  })
  if (!confirmed) return

  // 逐个移动，收集结果
  const failed: string[] = []
  const movedPaths: { oldPath: string; newPath: string }[] = []
  for (const p of validPaths) {
    try {
      const res = await window.api.fs.move(ws.rootPath, p, destDir)
      if (res.ok && res.path) {
        movedPaths.push({ oldPath: p, newPath: res.path })
      } else {
        failed.push(p)
      }
    } catch {
      failed.push(p)
    }
  }

  if (failed.length > 0) {
    await appAlert('部分移动失败', `${failed.length} 项移动失败。`)
  }

  // 展开目标目录，让用户看到移动结果
  expandedPaths.value = [...new Set([...expandedPaths.value, destDir])]
  await ws.loadTree()
  if (isMulti) ws.clearSelection()

  // 当前打开的文件在被移动项内：重定向到新路径
  const oldCur = ws.currentFile
  if (oldCur) {
    for (const { oldPath, newPath } of movedPaths) {
      if (oldCur === oldPath) {
        await ws.openFile(newPath)
        break
      } else if (isPathInside(oldCur, oldPath)) {
        const rel = oldCur.slice(oldPath.length)
        await ws.openFile(newPath + rel)
        break
      }
    }
  }
}

// 欢迎页「新建文件」快捷入口：弹出根目录的新建菜单
function onNewFileRequest(): void {
  if (!ws.rootPath) {
    void ws.selectWorkspace()
    return
  }
  showMenu(null, Math.min(window.innerWidth / 2, 420), 140)
}
onMounted(() => window.addEventListener('scholar:new-file', onNewFileRequest))
onBeforeUnmount(() => window.removeEventListener('scholar:new-file', onNewFileRequest))
</script>

<template>
  <div class="file-tree">
    <div class="header">
      <div class="tab-switch">
        <button
          class="tab-btn"
          :class="{ active: leftTab === 'files' }"
          @click="leftTab = 'files'"
        >文件</button>
        <button
          class="tab-btn"
          :class="{ active: leftTab === 'scm' }"
          @click="leftTab = 'scm'"
        >源代码管理</button>
        <button
          class="tab-btn"
          :class="{ active: leftTab === 'search' }"
          @click="leftTab = 'search'"
        >{{ t('search.placeholder') }}</button>
        <button
          class="tab-btn"
          :class="{ active: leftTab === 'debug' }"
          @click="leftTab = 'debug'"
        >调试</button>
        <button
          class="tab-btn"
          :class="{ active: leftTab === 'validation' }"
          @click="leftTab = 'validation'"
        >验证</button>
        <button
          class="tab-btn problems-tab"
          :class="{ active: leftTab === 'problems' }"
          @click="leftTab = 'problems'"
        >
          {{ t('problems.title') }}<span v-if="problemTotal > 0" class="tab-count">{{ problemTotal }}</span>
        </button>
      </div>
    </div>
    <!-- files 段标题行（需求§二）：「资源管理器」标题 + 图标工具栏；独立于分段行 -->
    <div class="panel-toolbar" v-if="leftTab === 'files'">
      <span class="panel-title">资源管理器</span>
      <button
        v-if="ws.rootPath"
        class="cp-btn icon-btn"
        title="新建（文件/文件夹）"
        @click="onQuickNewFile($event)"
      >＋</button>
      <button
        v-if="ws.rootPath"
        class="cp-btn icon-btn"
        title="折叠全部目录"
        @click="expandedPaths = []"
      >⇤</button>
      <button class="cp-btn icon-btn" title="刷新" @click="ws.loadTree">↻</button>
    </div>
    <DebugPanel v-if="leftTab === 'debug'" />
    <ValidationPanel v-if="leftTab === 'validation'" />
    <ProblemsPanel v-if="leftTab === 'problems'" />
    <!-- SCM 源代码管理：无工作区时面板内自行处理 -->
    <ScmPanel v-if="leftTab === 'scm'" />
    <!-- 搜索 Tab：无工作区时面板内自行提示 -->
    <SearchPanel v-if="leftTab === 'search'" />
    <template v-if="leftTab === 'files'">
    <div v-if="!ws.rootPath" class="empty">
      <div>未选择工作区</div>
      <button class="cp-btn cp-btn-primary" @click="ws.selectWorkspace">选择目录</button>
    </div>
    <div
      v-else
      class="tree"
      :class="{ 'tree-dragging': draggingNode }"
      @click.self="ws.clearSelection()"
      @contextmenu="onTreeContextMenu"
      @dragover="onTreeDragOver"
      @drop="onTreeDrop"
    >
      <TreeItem
        v-for="node in ws.tree"
        :key="node.path"
        :node="node"
        :expanded-paths="expandedPaths"
        :dragging-path="draggingNode?.path ?? null"
        :drop-target-path="dropTargetPath"
        @node-contextmenu="onNodeContextMenu"
        @node-dragstart="onNodeDragStart"
        @node-dragover="onNodeDragOver"
        @node-dragleave="onNodeDragLeave"
        @node-drop="onNodeDrop"
        @node-dragend="onNodeDragEnd"
        @node-select="onNodeSelect"
        @node-activate="onNodeActivate"
      />
      <div v-if="ws.tree.length === 0" class="tree-hint">
        空白区域右键可新建文件/文件夹<br />
        拖拽文件时松开到此处可移到工作区根目录
      </div>
    </div>
    </template>

    <!-- 右键菜单：全屏透明遮罩用于点击关闭 -->
    <template v-if="menuVisible">
      <div class="menu-overlay" @click="menuVisible = false" @contextmenu.prevent="menuVisible = false"></div>
      <div class="ctx-menu" :style="{ left: menuX + 'px', top: menuY + 'px' }">
        <template v-for="(item, idx) in menuItems" :key="idx">
          <div v-if="item.divider" class="ctx-divider"></div>
          <button
            v-else
            class="ctx-item"
            :class="{ danger: item.danger }"
            @click="onMenuAction(item)"
          >
            {{ item.label }}
          </button>
        </template>
      </div>
    </template>

    <!-- 名称输入弹窗 -->
    <template v-if="modalVisible">
      <div class="modal-overlay" @click.self="closeModal">
        <div class="name-modal cp-glass" @keydown="onModalKeydown" @mousedown="onModalBoxMouseDown">
          <div class="modal-title">{{ modalTitle }}</div>
          <input
            ref="modalInputRef"
            v-model="modalValue"
            class="modal-input"
            type="text"
            spellcheck="false"
            :placeholder="modalPlaceholder"
          />
          <div v-if="modalError" class="modal-error">{{ modalError }}</div>
          <div class="modal-actions">
            <button class="cp-btn" :disabled="modalBusy" @click="closeModal">取消</button>
            <button class="cp-btn cp-btn-primary" :disabled="modalBusy" @click="onModalConfirm">
              {{ modalBusy ? '处理中...' : '确定' }}
            </button>
          </div>
        </div>
      </div>
    </template>

    <!-- 应用内确认/提示弹窗（非阻塞，替代 window.confirm / window.alert） -->
    <template v-if="dlgVisible">
      <div
        class="modal-overlay"
        @click.self="onDlgChoose(dlgShowCancel ? false : true)"
      >
        <div class="name-modal cp-glass confirm-modal" @keydown="onDlgKeydown">
          <div class="modal-title">{{ dlgTitle }}</div>
          <div v-if="dlgMessage" class="dlg-message">{{ dlgMessage }}</div>
          <div class="modal-actions">
            <button v-if="dlgShowCancel" class="cp-btn" @click="onDlgChoose(false)">取消</button>
            <button
              ref="dlgConfirmBtnRef"
              class="cp-btn"
              :class="dlgDanger ? 'cp-btn-danger' : 'cp-btn-primary'"
              @click="onDlgChoose(true)"
            >
              {{ dlgConfirmText }}
            </button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.file-tree {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  padding: 4px 12px 0;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.label {
  font-size: 12px;
  font-weight: 600;
  color: var(--accent);
  text-transform: uppercase;
  letter-spacing: 1px;
}

.tab-switch {
  display: flex;
  gap: 2px;
  align-items: flex-end;
}

/* 浏览器 Tab 风：仅顶部 2px 高亮，无厚重背景，padding-top 4px */
.tab-btn {
  padding: 6px 10px 4px;
  background: transparent;
  border: none;
  border-top: 2px solid transparent;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 12px;
  transition: color 0.15s, border-color 0.15s;
}

.tab-btn:hover { color: var(--text-primary); }

.tab-btn.active {
  background: transparent;
  border-top-color: var(--primary);
  color: var(--text-primary);
}

/* 问题 Tab 诊断计数徽章 */
.tab-count {
  display: inline-block;
  margin-left: 5px;
  min-width: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: rgba(255, 107, 129, 0.18);
  color: #ff6b81;
  font-size: 10px;
  font-weight: 700;
  line-height: 15px;
  text-align: center;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

/* files 段标题行：「资源管理器」标题居左、图标按钮靠右，独立于分段 Tab 行 */
.panel-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.panel-title {
  margin-right: auto;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 1px;
  color: var(--text-secondary, var(--fg-muted));
  opacity: 0.8;
}

.icon-btn {
  min-width: 24px;
  height: 24px;
  padding: 0 6px;
  font-size: 14px;
  line-height: 1;
}

.empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--text-muted);
  padding: 20px;
  text-align: center;
}

.tree {
  flex: 1;
  overflow: auto;
  padding: 4px 0;
}

/* 拖拽进行中：树区域显示移动光标 */
.tree-dragging {
  cursor: grabbing;
}

.tree-hint {
  padding: 16px 12px;
  color: var(--text-muted);
  font-size: 12px;
  text-align: center;
  line-height: 1.6;
}

/* ---------- 右键菜单 ---------- */
.menu-overlay {
  position: fixed;
  inset: 0;
  z-index: 900;
}

.ctx-menu {
  position: fixed;
  z-index: 901;
  min-width: 180px;
  padding: 4px;
  background: var(--bg-panel);
  border: 1px solid var(--border-light);
  border-radius: 8px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.55);
}

.ctx-item {
  display: block;
  width: 100%;
  padding: 6px 12px;
  background: transparent;
  border: none;
  border-radius: 5px;
  color: var(--text-secondary);
  font-family: inherit;
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
  white-space: nowrap;
}

.ctx-item:hover {
  background: var(--accent-dim);
  color: var(--text-primary);
}

.ctx-item.danger {
  color: var(--danger, #ff6b6b);
}

.ctx-item.danger:hover {
  background: rgba(255, 80, 80, 0.14);
  color: #ff8585;
}

.ctx-divider {
  height: 1px;
  margin: 4px 8px;
  background: var(--border);
}

/* ---------- 名称输入弹窗 ---------- */
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

/* ---------- 应用内确认/提示弹窗 ---------- */
.confirm-modal {
  width: 380px;
}

.dlg-message {
  margin-top: 4px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-secondary, var(--text-primary));
  white-space: pre-line;
  word-break: break-all;
}

/* 危险操作按钮（删除） */
.cp-btn-danger {
  background: var(--danger, #ff5f57);
  border-color: var(--danger, #ff5f57);
  color: #fff;
}

.cp-btn-danger:hover {
  filter: brightness(1.1);
}
</style>
