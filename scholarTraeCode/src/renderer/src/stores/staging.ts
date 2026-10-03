// ㊝ 变更事务暂存的渲染端状态：面板开合、bash 接受门、摘要缓存、审阅开关与轻提示。
// 真正的暂存数据在主进程（.trae/staging/pending.json），本 store 只做 UI 协调，
// 不缓存记录明细——每次刷新都走 IPC 拉取，避免与主进程状态漂移。
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { UiStageSummary } from '../api'

export const useStagingStore = defineStore('staging', () => {
  /** 审阅面板是否打开 */
  const panelOpen = ref(false)
  /** 当前摘要（空区时给零值结构，模板不用判空） */
  const summary = ref<UiStageSummary>({
    total: 0,
    counts: { create: 0, modify: 0, delete: 0, move: 0 },
    items: []
  })
  /** 审阅开关（默认关，主进程持久化在 config.json） */
  const enabled = ref(false)
  /**
   * bash 接受门 id：非空表示面板是由「bash 前请先接受」唤起的，
   * 接受/拒绝走 staging.bashAcceptResponse；为空时走普通 accept/reject。
   */
  const bashGateId = ref<string | null>(null)
  /** 非阻塞提示（错误/成功），由面板组件定时清空 */
  const notice = ref<{ type: 'ok' | 'err'; text: string } | null>(null)

  const total = computed(() => summary.value.total)

  /** 从主进程拉摘要；无工作区时直接置零。返回为 {enabled, summary} 包络，顺带同步开关态 */
  async function refresh(workspace: string | null): Promise<void> {
    if (!workspace) {
      summary.value = { total: 0, counts: { create: 0, modify: 0, delete: 0, move: 0 }, items: [] }
      return
    }
    const r = await window.api.staging.get(workspace)
    summary.value = r.summary
    enabled.value = r.enabled
  }

  async function loadEnabled(workspace: string | null): Promise<void> {
    enabled.value = workspace ? await window.api.staging.getEnabled(workspace) : false
  }

  /** 打开审阅面板（普通入口） */
  async function openPanel(workspace: string | null): Promise<void> {
    bashGateId.value = null
    panelOpen.value = true
    await refresh(workspace)
  }

  /** 关闭面板：bash 门模式下不允许简单关闭（挂起的 bash 必须应答），调用方需先处理门 */
  function closePanel(): void {
    if (bashGateId.value) return
    panelOpen.value = false
  }

  /** bash 前接受门：带着门 id 打开面板，用户应答后才释放主进程的等待 */
  async function openBashGate(
    workspace: string | null,
    id: string,
    next: UiStageSummary
  ): Promise<void> {
    bashGateId.value = id
    summary.value = next
    panelOpen.value = true
  }

  /**
   * 接受选中文件（paths 为相对路径数组或 'all'）。
   * bash 门模式下必须走 bashAcceptResponse：它内部全部落盘并释放 bash。
   */
  async function accept(
    workspace: string | null,
    paths: string[] | 'all',
    hunkIds?: Record<string, string[]>
  ): Promise<boolean> {
    if (!workspace) return false
    if (bashGateId.value && paths !== 'all') {
      notice.value = { type: 'err', text: '执行命令前必须接受全部变更，不支持逐文件接受' }
      return false
    }
    if (bashGateId.value) {
      const r = await window.api.staging.bashAcceptResponse(workspace, bashGateId.value, 'accept')
      if (!r.released) {
        notice.value = { type: 'err', text: '存在冲突，无法接受：请先在文件树处理冲突文件' }
        return false
      }
      bashGateId.value = null
      panelOpen.value = false
      await refresh(workspace)
      return true
    }
    const r = await window.api.staging.accept(workspace, paths, hunkIds)
    if (!r.ok) {
      notice.value = { type: 'err', text: r.error || '接受失败（可能存在冲突），整批未写入' }
      return false
    }
    await refresh(workspace)
    return true
  }

  /** 拒绝（丢弃）选中文件；bash 门模式下拒绝即拒绝执行命令 */
  async function reject(
    workspace: string | null,
    paths: string[] | 'all',
    hunkIds?: Record<string, string[]>
  ): Promise<void> {
    if (!workspace) return
    if (bashGateId.value) {
      await window.api.staging.bashAcceptResponse(workspace, bashGateId.value, 'reject')
      bashGateId.value = null
      panelOpen.value = false
      await refresh(workspace)
      return
    }
    await window.api.staging.reject(workspace, paths, hunkIds)
    await refresh(workspace)
  }

  async function setEnabled(workspace: string | null, value: boolean): Promise<void> {
    if (!workspace) return
    enabled.value = await window.api.staging.setEnabled(workspace, value)
  }

  return {
    panelOpen,
    summary,
    enabled,
    bashGateId,
    notice,
    total,
    refresh,
    loadEnabled,
    openPanel,
    closePanel,
    openBashGate,
    accept,
    reject,
    setEnabled
  }
})
