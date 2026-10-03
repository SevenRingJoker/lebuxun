// Git 状态管理：仓库探测、改动列表、SCM 分组、分支、检查点历史、差异面板开关
// 工作区根路径复用 workspace store；所有失败均带 error 返回，UI 降级提示不崩溃。
import { defineStore } from 'pinia'
import { ref, toRaw } from 'vue'
import type {
  UiGitChange, UiGitCheckpoint, UiFileDiff,
  UiScmGrouped, UiBranchInfo
} from '../api'
import { useWorkspaceStore } from './workspace'

export const useGitStore = defineStore('git', () => {
  const workspace = useWorkspaceStore()

  /** 当前工作区是否为 git 仓库（null=尚未探测） */
  const isRepo = ref<boolean | null>(null)
  /** 本机 git 是否可用（探测命令失败时 false） */
  const gitAvailable = ref(true)
  const changes = ref<UiGitChange[]>([])
  const checkpoints = ref<UiGitCheckpoint[]>([])
  /** SCM 三分组 + 当前分支/HEAD（null=尚未加载） */
  const grouped = ref<UiScmGrouped | null>(null)
  const branches = ref<UiBranchInfo[]>([])
  const viewerOpen = ref(false)
  /** DiffViewer 打开时预选的文件路径（null=不预选） */
  const viewerInitialPath = ref<string | null>(null)
  const loading = ref(false)
  /** 面板内轻提示（应用内非阻塞） */
  const notice = ref<{ type: 'ok' | 'err'; text: string } | null>(null)

  let noticeTimer: ReturnType<typeof setTimeout> | null = null
  function flash(type: 'ok' | 'err', text: string): void {
    notice.value = { type, text }
    if (noticeTimer) clearTimeout(noticeTimer)
    noticeTimer = setTimeout(() => { notice.value = null }, 4000)
  }

  /** 探测仓库状态并拉取改动/分组/分支/检查点；工作区变化/AI 任务结束后调用 */
  async function refresh(): Promise<void> {
    const root = workspace.rootPath
    if (!root) {
      isRepo.value = null
      changes.value = []
      grouped.value = null
      branches.value = []
      return
    }
    try {
      const repo = await window.api.git.isRepo(root)
      isRepo.value = repo
      gitAvailable.value = true
      if (!repo) {
        changes.value = []
        grouped.value = null
        branches.value = []
        return
      }
      // 旧扁平列表 + 检查点供 DiffViewer；grouped + 分支供 SCM 面板
      const [stRes, cpRes, grRes, brRes] = await Promise.all([
        window.api.git.status(root),
        window.api.git.checkpointList(root),
        window.api.git.statusGrouped(root),
        window.api.git.branchList(root)
      ])
      changes.value = stRes.ok && stRes.data ? (stRes.data as UiGitChange[]) : []
      checkpoints.value = cpRes.ok && cpRes.data ? (cpRes.data as UiGitCheckpoint[]) : []
      grouped.value = grRes.ok && grRes.data ? (grRes.data as UiScmGrouped) : null
      branches.value = brRes.ok && brRes.data ? (brRes.data as UiBranchInfo[]) : []
    } catch {
      // git 未安装等：整体降级
      gitAvailable.value = false
      isRepo.value = false
      changes.value = []
      grouped.value = null
      branches.value = []
    }
  }

  /** 用户显式初始化仓库 */
  async function initRepo(): Promise<boolean> {
    const root = workspace.rootPath
    if (!root) return false
    const res = await window.api.git.init(root)
    if (!res.ok) {
      flash('err', res.error || '初始化失败')
      return false
    }
    await refresh()
    flash('ok', 'Git 仓库已初始化')
    return true
  }

  /**
   * 创建检查点。silent=true 用于 AI 任务前自动建点（无变更/失败均静默）。
   * @returns 是否实际产生了提交
   */
  async function createCheckpoint(label: string, silent = false): Promise<boolean> {
    const root = workspace.rootPath
    if (!root || !isRepo.value) return false
    const res = await window.api.git.checkpointCreate(root, label)
    if (!res.ok) {
      if (!silent) flash('err', res.error || '检查点创建失败')
      return false
    }
    const created = !!res.data?.created
    if (created) {
      await refresh()
      if (!silent) flash('ok', '检查点已创建')
    } else if (!silent) {
      flash('ok', res.data?.reason || '没有需要提交的变更')
    }
    return created
  }

  /** 拉取单文件 diff（大文件/错误由调用方展示 error） */
  async function loadDiff(change: UiGitChange): Promise<UiFileDiff | null> {
    const root = workspace.rootPath
    if (!root) return null
    // pinia 状态是 Proxy，IPC 结构化克隆会失败，传普通对象
    const res = await window.api.git.diffFile(root, { ...toRaw(change) })
    if (!res.ok || !res.data) {
      flash('err', res.error || '差异读取失败')
      return null
    }
    return res.data as UiFileDiff
  }

  /**
   * 还原 tracked 文件到 HEAD；untracked 新文件改走回收站删除。
   * @returns true 表示已还原/删除，调用方应刷新列表
   */
  async function discardChange(change: UiGitChange): Promise<boolean> {
    const root = workspace.rootPath
    if (!root) return false
    if (change.status === 'untracked') {
      // git 路径统一用正斜杠；Windows 工作区需转回反斜杠再交 fs.trash
      const sep = root.includes('\\') ? '\\' : '/'
      const rel = change.path.replace(/\//g, sep)
      const abs = root.endsWith(sep) ? root + rel : root + sep + rel
      const res = await window.api.fs.trash(abs)
      if (!res.ok) {
        flash('err', res.error || '删除失败')
        return false
      }
    } else {
      const res = await window.api.git.fileRestore(root, { ...toRaw(change) })
      if (!res.ok) {
        flash('err', res.error || '还原失败')
        return false
      }
    }
    await refresh()
    void workspace.loadTree()
    flash('ok', `已还原：${change.path}`)
    return true
  }

  /**
   * 回滚到检查点。调用方必须先取得用户强确认。
   * 安全双保险：reset 前自动建一个"回滚前"检查点。
   */
  async function restoreCheckpoint(hash: string): Promise<boolean> {
    const root = workspace.rootPath
    if (!root || !isRepo.value) return false
    // 双保险：回滚前留存当前状态（可能无变更，静默）
    await createCheckpoint(`回滚前自动留存`, true)
    const res = await window.api.git.checkpointRestore(root, hash)
    if (!res.ok) {
      flash('err', res.error || '回滚失败')
      return false
    }
    await refresh()
    void workspace.loadTree()
    flash('ok', '已回滚到指定检查点')
    return true
  }

  function openViewer(): void {
    viewerInitialPath.value = null
    viewerOpen.value = true
  }
  /** 打开差异面板并预选指定文件（SCM 面板点击文件名时调用） */
  function openViewerAt(path: string): void {
    viewerInitialPath.value = path
    viewerOpen.value = true
  }
  function closeViewer(): void {
    viewerOpen.value = false
    viewerInitialPath.value = null
  }

  // ---------------- SCM 面板操作 ----------------

  /** 暂存：空数组=全部。成功后刷新状态与文件树 */
  async function stage(paths: string[]): Promise<boolean> {
    const root = workspace.rootPath
    if (!root) return false
    const res = await window.api.git.stage(root, paths)
    if (!res.ok) {
      flash('err', res.error || '暂存失败')
      return false
    }
    await refresh()
    return true
  }

  /** 取消暂存：空数组=全部 */
  async function unstage(paths: string[]): Promise<boolean> {
    const root = workspace.rootPath
    if (!root) return false
    const res = await window.api.git.unstage(root, paths)
    if (!res.ok) {
      flash('err', res.error || '取消暂存失败')
      return false
    }
    await refresh()
    return true
  }

  /** 提交暂存区（不自动 add）；成功后刷新状态与文件树 */
  async function commit(message: string): Promise<boolean> {
    const root = workspace.rootPath
    if (!root) return false
    const res = await window.api.git.commit(root, message)
    if (!res.ok) {
      flash('err', res.error || '提交失败')
      return false
    }
    await refresh()
    void workspace.loadTree()
    return true
  }

  /** 切换本地分支：成功后刷新状态与文件树 */
  async function checkoutBranch(name: string): Promise<boolean> {
    const root = workspace.rootPath
    if (!root) return false
    const res = await window.api.git.checkoutBranch(root, name)
    if (!res.ok) {
      flash('err', res.error || '分支切换失败')
      return false
    }
    await refresh()
    void workspace.loadTree()
    return true
  }

  /** 新建并切换分支 */
  async function createBranch(name: string): Promise<boolean> {
    const root = workspace.rootPath
    if (!root) return false
    const res = await window.api.git.createBranch(root, name)
    if (!res.ok) {
      flash('err', res.error || '分支创建失败')
      return false
    }
    await refresh()
    return true
  }

  return {
    isRepo,
    gitAvailable,
    changes,
    checkpoints,
    grouped,
    branches,
    viewerOpen,
    viewerInitialPath,
    loading,
    notice,
    refresh,
    initRepo,
    createCheckpoint,
    loadDiff,
    discardChange,
    restoreCheckpoint,
    openViewer,
    openViewerAt,
    closeViewer,
    stage,
    unstage,
    commit,
    checkoutBranch,
    createBranch
  }
})
