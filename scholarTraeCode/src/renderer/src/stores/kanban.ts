// s49 卡片式任务看板渲染端状态：
// 以 chat todos 为计划源构建四列卡片，绑定任务 id 与验收证据；
// 单卡片暂停/回滚分别接任务门与任务前检查点；变更落盘主进程 kanban.json。
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  addEvidence,
  groupByColumn,
  moveCard,
  requestCardPause,
  rollbackCard,
  setCardRole,
  setPriority as setPrio,
  type KanbanCard,
  type KanbanColumn,
  type KanbanPriority,
  type KanbanState
} from '../../../shared/kanban/kanban'
import type { UiTimelinePayload } from '../api'
import { useWorkspaceStore } from './workspace'

export const useKanbanStore = defineStore('kanban', () => {
  const visible = ref(false)
  const cards = ref<KanbanState>([])
  /** 最近一次同步所用任务 id（卡片绑定） */
  const boundTaskId = ref<string | null>(null)
  /** 最近一次派发返回的汇总报告（看板内展示） */
  const lastReport = ref<string>('')

  const groups = computed(() => groupByColumn(cards.value))
  const total = computed(() => cards.value.length)
  const doingCount = computed(() => groups.value.doing.length)

  /** 落盘（失败仅告警，不阻断交互） */
  async function persist(): Promise<void> {
    const ws = useWorkspaceStore()
    if (!ws.rootPath) return
    try {
      await window.api.kanban.save(ws.rootPath, cards.value)
    } catch {
      /* 持久化失败静默 */
    }
  }

  /** 工作区就绪/切换：载入已落盘看板 */
  async function init(workspace: string | null): Promise<void> {
    if (!workspace) {
      cards.value = []
      boundTaskId.value = null
      return
    }
    try {
      cards.value = await window.api.kanban.get(workspace)
    } catch {
      cards.value = []
    }
  }

  /**
   * 与 chat todos 对账（todo_write 广播 → 看板）。
   * - 新 todo（按 sid=s<id> 未找到）→ 待办卡片；
   * - in_progress 且卡片在待办 → 进行中并绑定任务；
   * - completed 且卡片在进行中 → 待验收（等待验收，不自动完成）；
   * - 已在 review/done 的卡片不因 todo 反复而降级。
   */
  function syncFromTodos(
    todos: { id: number; content: string; status: string; priority?: KanbanPriority }[],
    taskId: string | null
  ): void {
    let next = cards.value
    const known = new Map(next.map((c) => [c.sid, c]))
    // 补建缺失卡片
    for (const t of todos) {
      const sid = `s${t.id}`
      if (!known.has(sid)) {
        const card: KanbanCard = {
          sid,
          taskId: null,
          title: t.content,
          status: 'todo',
          priority: t.priority ?? 'medium',
          evidence: [],
          pauseRequested: false,
          rolledBack: false
        }
        next = [...next, card]
      }
    }
    boundTaskId.value = taskId
    // 状态对账（逐 todo，非法迁移被 try 吞掉）
    for (const t of todos) {
      const sid = `s${t.id}`
      const card = next.find((c) => c.sid === sid)
      if (!card) continue
      try {
        if (t.status === 'in_progress' && card.status === 'todo') {
          next = moveCard(next, sid, 'doing').map((c) =>
            c.sid === sid ? { ...c, taskId } : c
          )
        } else if (t.status === 'completed' && card.status === 'doing') {
          next = moveCard(next, sid, 'review')
        }
      } catch {
        /* 迁移不适用，保持现状 */
      }
    }
    cards.value = next
    void persist()
  }

  /** 时间线广播：把成功写改步骤的 diff 摘要作为验收证据挂到进行中卡片 */
  function onTimeline(p: UiTimelinePayload): void {
    const additions = p.steps
      .filter((s) => s.status === 'ok' && s.diffSummary)
      .map((s) => s.diffSummary)
    if (!additions.length) return
    let next = cards.value
    for (const ev of additions) {
      for (const card of groups.value.doing) {
        if (!card.evidence.includes(ev)) next = addEvidence(next, card.sid, ev)
      }
    }
    cards.value = next
    void persist()
  }

  /** 人工改派优先级 */
  async function changePriority(sid: string, priority: KanbanPriority): Promise<void> {
    cards.value = setPrio(cards.value, sid, priority)
    await persist()
  }

  /** 合法范围内人工迁移列 */
  async function manualMove(sid: string, to: KanbanColumn): Promise<void> {
    try {
      cards.value = moveCard(cards.value, sid, to)
      await persist()
    } catch {
      /* 非法迁移忽略 */
    }
  }

  /** 验收通过：待验收 → 完成 */
  async function accept(sid: string): Promise<void> {
    try {
      cards.value = moveCard(cards.value, sid, 'done')
      await persist()
    } catch {
      /* 忽略 */
    }
  }

  /**
   * 单卡片暂停：打暂停标记 + 请求任务门暂停。
   * 暂停真正生效以 ai:taskControl pausing/paused 为准。
   */
  async function pause(sid: string, pauseTask: () => Promise<void>): Promise<void> {
    try {
      cards.value = requestCardPause(cards.value, sid)
      await persist()
      await pauseTask()
    } catch {
      /* 非进行中卡片忽略 */
    }
  }

  /**
   * 单卡片回滚：状态机先退回待办，再请主进程中止运行并恢复任务前检查点。
   * @param taskId 卡片绑定的任务 id
   */
  async function rollback(sid: string, taskId: string | null): Promise<{ ok: boolean; error?: string }> {
    if (!taskId) return { ok: false, error: '卡片未绑定任务' }
    const ws = useWorkspaceStore()
    if (!ws.rootPath) return { ok: false, error: '无工作区' }
    try {
      cards.value = rollbackCard(cards.value, sid)
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    await persist()
    const r = await window.api.ai.rollbackCard(ws.rootPath, taskId)
    if (!r.ok) return r
    return { ok: true }
  }

  function open(): void { visible.value = true }
  function close(): void { visible.value = false }

  /** s50 设置卡片角色（前端/后端/测试），非法值忽略 */
  async function changeRole(sid: string, role: string): Promise<void> {
    cards.value = setCardRole(cards.value, sid, role)
    await persist()
  }

  /**
   * s50 按看板卡片派发：取待办列卡片（可指定 sids）→ 角色 Agent 并行。
   * 派发期间卡片置进行中（未绑定任务快照，回滚请用聊天任务流）；
   * 返回汇总裁决报告。
   */
  async function dispatchTodo(sids?: string[]): Promise<{ ok: boolean; error?: string }> {
    const ws = useWorkspaceStore()
    if (!ws.rootPath) return { ok: false, error: '无工作区' }
    const picked = groups.value.todo.filter((c) => !sids || sids.includes(c.sid))
    if (picked.length === 0) return { ok: false, error: '待办列为空，无可派发卡片' }
    // 乐观置进行中
    let next = cards.value
    for (const c of picked) {
      try { next = moveCard(next, c.sid, 'doing') } catch { /* 忽略 */ }
    }
    cards.value = next
    await persist()
    try {
      const r = await window.api.ai.dispatchFromCards(
        ws.rootPath,
        picked.map((c) => ({ sid: c.sid, title: c.title, role: c.role }))
      )
      if (!r.ok) return { ok: false, error: r.error }
      lastReport.value = r.report ?? ''
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  return {
    visible, cards, groups, total, doingCount, boundTaskId, lastReport,
    init, syncFromTodos, onTimeline,
    changePriority, manualMove, accept, pause, rollback, changeRole, dispatchTodo,
    open, close
  }
})
