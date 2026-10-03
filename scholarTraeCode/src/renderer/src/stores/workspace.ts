// 工作区状态管理：目录树、当前打开文件、文件内容缓存
import { defineStore } from 'pinia'
import { ref } from 'vue'

export interface FsNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FsNode[]
}

/** 编辑器 Tab：content/dirty 是该文件「非激活期间」的快照；激活时与 currentContent/fileDirty 双向同步 */
export interface EditorTab {
  path: string
  content: string
  dirty: boolean
}

export const useWorkspaceStore = defineStore('workspace', () => {
  // ---------- 状态 ----------
  const rootPath = ref<string | null>(null)
  const tree = ref<FsNode[]>([])
  const currentFile = ref<string | null>(null)
  const currentContent = ref<string>('')
  const fileDirty = ref<boolean>(false)
  // 多文件 Tab 列表（仅真实磁盘文件；未命名草稿不进列表，语义同旧版单文件模型）
  const openTabs = ref<EditorTab[]>([])
  const ollamaReady = ref<boolean>(false)
  const ollamaError = ref<string | null>(null)

  // ---------- 文件树多选（Shift 范围 / Ctrl 单选） ----------
  const selectedPaths = ref<Set<string>>(new Set())
  const lastClickedPath = ref<string | null>(null)

  // ---------- 工作区记忆（localStorage） ----------
  // 用户每次启动不必重新选择目录；恢复前经主进程校验目录仍存在，失效则清除记忆
  const LAST_WS_KEY = 'scholar:lastWorkspace'

  function rememberWorkspace(path: string): void {
    try {
      localStorage.setItem(LAST_WS_KEY, path)
    } catch {
      // 隐私模式/存储被禁用等情况下静默降级，不影响功能
    }
  }

  function forgetWorkspace(): void {
    try {
      localStorage.removeItem(LAST_WS_KEY)
    } catch {
      /* 同上，忽略存储不可用 */
    }
  }

  // 启动恢复：store 创建时即开始执行，编辑器 LSP 等可 await restoreReady 确保拿到工作区
  async function restoreWorkspace(): Promise<boolean> {
    let saved: string | null = null
    try {
      saved = localStorage.getItem(LAST_WS_KEY)
    } catch {
      saved = null
    }
    if (!saved) return false
    // U 盘/网络盘已拔出、目录被删除等情况下放弃恢复，避免界面停在失效路径
    const stillValid = await window.api.fs.isDirectory(saved)
    if (!stillValid) {
      forgetWorkspace()
      return false
    }
    rootPath.value = saved
    await loadTree()
    // 通知主进程：filesystem MCP 允许目录追加该工作区，AI 工具才能读写用户项目
    window.api.mcp.setWorkspaceRoot(saved).catch(() => {})
    // 后台预热代码库索引（增量落盘，不阻塞界面；失败静默）
    warmIndex(saved)
    return true
  }

  const restoreReady = restoreWorkspace()

  // 后台增量构建代码库索引（@ 引用 / 上下文检索用）；不 await、不抛错
  function warmIndex(path: string): void {
    window.api.ai?.ensureIndex(path).catch(() => {})
  }

  // ---------- 动作 ----------
  // 选择工作区目录
  async function selectWorkspace(): Promise<void> {
    const path = await window.api.fs.selectWorkspace()
    if (path) {
      rootPath.value = path
      rememberWorkspace(path)
      await loadTree()
      // 同步 MCP filesystem 允许目录（异步执行，不阻塞界面）
      window.api.mcp.setWorkspaceRoot(path).catch(() => {})
      // 新工作区同样预热索引
      warmIndex(path)
    }
  }

  // 加载目录树
  async function loadTree(): Promise<void> {
    if (!rootPath.value) return
    tree.value = (await window.api.fs.readDirTree(rootPath.value)) as FsNode[]
  }

  // ---------- Tab 同步 ----------
  // 切走前把「当前激活文件」的编辑快照写回其 Tab 记录，保证切回时恢复未保存内容
  function stashActiveTab(): void {
    if (!currentFile.value) return
    const t = openTabs.value.find((t) => t.path === currentFile.value)
    if (t) {
      t.content = currentContent.value
      t.dirty = fileDirty.value
    }
  }

  // 打开文件：已在 Tab 列表则激活（恢复其未保存快照）；不在则读盘后新建 Tab。
  // 不再覆盖旧文档——多 Tab 是本次布局改造的核心语义。
  async function openFile(path: string): Promise<void> {
    if (currentFile.value === path) return
    const existing = openTabs.value.find((t) => t.path === path)
    if (existing) {
      stashActiveTab()
      currentFile.value = path
      currentContent.value = existing.content
      fileDirty.value = existing.dirty
      return
    }
    try {
      const content = await window.api.fs.readFile(path)
      stashActiveTab()
      openTabs.value.push({ path, content, dirty: false })
      currentFile.value = path
      currentContent.value = content
      fileDirty.value = false
    } catch (err) {
      console.error('读取文件失败:', err)
    }
  }

  /** 关闭结果：closed=已关；needConfirm=有未保存内容，需 UI 确认后再决定 */
  type CloseTabResult = 'closed' | 'needConfirm'

  // 从列表移除并修复激活态：关闭的是激活 Tab 时切到邻近 Tab，空列表回空白态
  function removeTab(path: string): void {
    const idx = openTabs.value.findIndex((t) => t.path === path)
    if (idx < 0) return
    openTabs.value.splice(idx, 1)
    if (currentFile.value !== path) return
    const next = openTabs.value[Math.min(idx, openTabs.value.length - 1)]
    if (next) {
      currentFile.value = next.path
      currentContent.value = next.content
      fileDirty.value = next.dirty
    } else {
      currentFile.value = null
      currentContent.value = ''
      fileDirty.value = false
    }
  }

  // 请求关闭 Tab：未保存时不静默丢弃，交给调用方弹确认（保存并关 / 不保存 / 取消）
  function closeTab(path: string): CloseTabResult {
    const t = openTabs.value.find((t) => t.path === path)
    if (!t) return 'closed'
    const dirty = currentFile.value === path ? fileDirty.value : t.dirty
    if (dirty) return 'needConfirm'
    removeTab(path)
    return 'closed'
  }

  // 确认「不保存」后的强制关闭
  function forceCloseTab(path: string): void {
    removeTab(path)
  }

  // 确认「保存并关闭」：激活目标（确保保存的是它的最新内容）→ 落盘 → 关闭
  async function saveAndCloseTab(path: string): Promise<void> {
    await openFile(path)
    await saveCurrentFile()
    removeTab(path)
  }

  // 拖拽排序
  function moveTab(from: number, to: number): void {
    if (from === to) return
    const arr = openTabs.value
    if (from < 0 || from >= arr.length || to < 0 || to >= arr.length) return
    const [moved] = arr.splice(from, 1)
    arr.splice(to, 0, moved)
  }

  // 保存当前文件；返回 false 表示当前没有归属文件（未命名草稿，需调用 saveUntitledAs）
  async function saveCurrentFile(): Promise<boolean> {
    if (!currentFile.value) return false
    await window.api.fs.writeFile(currentFile.value, currentContent.value)
    markSaved()
    return true
  }

  // 保存成功后的统一收尾：清当前脏标记并同步 Tab 快照（避免切走后旧 dirty 残留）
  function markSaved(): void {
    fileDirty.value = false
    const t = openTabs.value.find((t) => t.path === currentFile.value)
    if (t) {
      t.dirty = false
      t.content = currentContent.value
    }
  }

  // 首次保存未命名草稿：在工作区根目录下按给定相对名创建文件并写入内容
  async function saveUntitledAs(
    relName: string
  ): Promise<{ ok: boolean; error?: string }> {
    if (!rootPath.value) return { ok: false, error: '尚未打开工作区目录' }
    const res = await window.api.fs.createFile(rootPath.value, relName)
    if (!res.ok) return { ok: false, error: res.error || '创建文件失败' }
    if (!res.path) return { ok: false, error: '未获取到新文件路径' }
    await window.api.fs.writeFile(res.path, currentContent.value)
    bindAfterSave(res.path)
    return { ok: true }
  }

  // 未选择工作区时：弹系统「另存为」对话框，保存到用户选择的任意位置
  async function saveDraftViaDialog(): Promise<{ ok: boolean; canceled?: boolean; error?: string }> {
    const dlg = await window.api.fs.saveDialog('untitled.txt')
    if (dlg.canceled || !dlg.ok) return { ok: false, canceled: dlg.canceled }
    if (!dlg.path) return { ok: false, error: '未获取到保存路径' }
    try {
      await window.api.fs.writeFile(dlg.path, currentContent.value)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : '写入文件失败' }
    }
    bindAfterSave(dlg.path)
    return { ok: true }
  }

  // 草稿落盘后的统一收尾：关联当前文件、清脏标记；文件在工作区内则刷新文件树。
  // 草稿转正后纳入 Tab 列表，与其他文件享受同样的切换/关闭语义
  function bindAfterSave(path: string): void {
    currentFile.value = path
    fileDirty.value = false
    if (!openTabs.value.some((t) => t.path === path)) {
      openTabs.value.push({ path, content: currentContent.value, dirty: false })
    }
    if (rootPath.value) void loadTree()
  }

  // 关闭当前文件（删除/被移出工作区时调用）：从 Tab 列表移除并切到邻近 Tab
  function closeFile(): void {
    if (currentFile.value && openTabs.value.some((t) => t.path === currentFile.value)) {
      removeTab(currentFile.value)
      return
    }
    // 未命名草稿场景：直接清空编辑区
    currentFile.value = null
    currentContent.value = ''
    fileDirty.value = false
  }

  // ---------- 行跳转请求（问题面板点击诊断 → EditorPanel 滚动定位） ----------
  /** 待消费的跳转请求；nonce 每次自增，保证连续跳转同行也能触发 watch */
  const revealRequest = ref<{ line: number; column: number; nonce: number } | null>(null)
  let revealNonce = 0
  /** 请求编辑器打开后滚动到指定行列（1-based） */
  function requestReveal(line: number, column: number): void {
    revealNonce += 1
    revealRequest.value = { line, column, nonce: revealNonce }
  }

  // 检查 Ollama 状态
  async function checkOllama(): Promise<void> {
    const res = await window.api.ollama.health()
    ollamaReady.value = res.ok
    ollamaError.value = res.error || null
  }

  // ---------- 多选操作 ----------
  /** 清空多选 */
  function clearSelection(): void {
    selectedPaths.value = new Set()
  }

  /** 设置选中列表（替换） */
  function setSelection(paths: string[]): void {
    selectedPaths.value = new Set(paths)
  }

  /** Ctrl+click：切换单个文件的选中态 */
  function toggleSelection(path: string): void {
    const s = new Set(selectedPaths.value)
    if (s.has(path)) s.delete(path)
    else s.add(path)
    selectedPaths.value = s
  }

  return {
    rootPath,
    tree,
    currentFile,
    currentContent,
    fileDirty,
    openTabs,
    ollamaReady,
    ollamaError,
    selectedPaths,
    lastClickedPath,
    revealRequest,
    requestReveal,
    restoreReady,
    restoreWorkspace,
    selectWorkspace,
    loadTree,
    openFile,
    closeFile,
    closeTab,
    forceCloseTab,
    saveAndCloseTab,
    moveTab,
    markSaved,
    saveCurrentFile,
    saveUntitledAs,
    saveDraftViaDialog,
    checkOllama,
    clearSelection,
    setSelection,
    toggleSelection
  }
})
