// s45/s46 修复提案与自动回归的渲染端状态。
// 主进程事件源：terminal:repairProposals（bash/测试失败的修复卡片）、test:autoRun（自动回归结果）。
// 卡片确认后才执行修复命令；执行结果与检查点 hash 留在卡片内，支持一键回滚。
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { UiRepairProposal, UiRepairRunResult, UiAutoTestResult } from '../api'

export const useRepairStore = defineStore('repair', () => {
  /** 当前待确认修复提案（同一时间只展示最新一张卡片） */
  const proposal = ref<UiRepairProposal | null>(null)
  /** 修复执行中（按钮 loading） */
  const running = ref(false)
  /** 最近一次修复执行结果（含检查点 hash，可回滚） */
  const result = ref<UiRepairRunResult | null>(null)
  /** 执行中的动作 id（卡片内逐动作展示状态） */
  const activeActionId = ref<string | null>(null)
  /** s46 最近一次自动回归结果（轻提示；有提案时让位） */
  const autoTest = ref<UiAutoTestResult | null>(null)
  /** 已忽略的失败指纹（用户点「忽略」后同一失败不再弹） */
  const dismissed = new Set<string>()

  function key(p: UiRepairProposal): string {
    return `${p.origin}|${p.command}|${p.report.summary}`
  }

  function onProposal(p: UiRepairProposal): void {
    if (dismissed.has(key(p))) return
    proposal.value = p
    result.value = null
    activeActionId.value = null
  }

  /** 确认执行某个修复动作 */
  async function run(workspace: string, actionId: string): Promise<void> {
    const p = proposal.value
    const action = p?.actions.find((a) => a.id === actionId)
    if (!p || !action?.command || running.value) return
    running.value = true
    activeActionId.value = actionId
    try {
      result.value = await window.api.repair.run(workspace, action.command)
    } catch (e) {
      result.value = { ok: false, exitCode: null, tail: String(e), checkpointHash: null, error: String(e) }
    } finally {
      running.value = false
    }
  }

  /** 回滚到修复前检查点 */
  async function rollback(workspace: string): Promise<void> {
    const hash = result.value?.checkpointHash
    if (!hash) return
    await window.api.repair.rollback(workspace, hash)
    result.value = null
    proposal.value = null
  }

  /** 忽略本次失败（同指纹不再弹） */
  function dismiss(): void {
    if (proposal.value) dismissed.add(key(proposal.value))
    proposal.value = null
    result.value = null
  }

  /** 修复成功 → 关闭卡片 */
  function close(): void {
    proposal.value = null
    result.value = null
    activeActionId.value = null
  }

  function onAutoTest(r: UiAutoTestResult): void {
    autoTest.value = r
    // 通过的提示 6s 自动清；失败常显（配合提案卡片）
    if (r.ran && r.ok) setTimeout(() => { if (autoTest.value === r) autoTest.value = null }, 6000)
  }

  return { proposal, running, result, activeActionId, autoTest, onProposal, run, rollback, dismiss, close, onAutoTest }
})
