// s48 执行时间线渲染端状态：接收主进程 ai:timelineUpdate 广播，
// 维护步骤列表供 TimelinePanel 渲染；失败步骤可「从此步重跑」。
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { UiTimelinePayload, UiTimelineStep } from '../api'

export const useTimelineStore = defineStore('timeline', () => {
  /** 面板可见性（ChatPanel 头部按钮切换） */
  const visible = ref(false)
  /** 当前任务 id（重跑定位用） */
  const taskId = ref<string | null>(null)
  /** 步骤（时间正序，视图倒序渲染） */
  const steps = ref<UiTimelineStep[]>([])
  /** 展开的步骤 id 集合 */
  const expanded = ref<Set<number>>(new Set())

  /** 广播到达：更新任务与步骤 */
  function onPayload(p: UiTimelinePayload): void {
    taskId.value = p.taskId
    steps.value = p.steps
  }

  function toggleExpand(id: number): void {
    if (expanded.value.has(id)) expanded.value.delete(id)
    else expanded.value.add(id)
  }

  /** 从此步重跑：由面板失败步骤按钮调用 */
  async function rerun(workspace: string, step: UiTimelineStep): Promise<{ ok: boolean; error?: string }> {
    if (!workspace || !taskId.value) return { ok: false, error: '任务或工作区缺失' }
    try {
      return await window.api.ai.rerunFromStep(workspace, taskId.value, step.round)
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  function open(): void { visible.value = true }
  function close(): void { visible.value = false }

  /** 工作区切换：清空旧步骤 */
  function reset(): void {
    taskId.value = null
    steps.value = []
    expanded.value.clear()
  }

  return { visible, taskId, steps, expanded, onPayload, toggleExpand, rerun, open, close, reset }
})
