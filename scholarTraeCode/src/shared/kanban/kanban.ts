// s49 卡片式任务看板纯函数层（双端共享，零 IO）：
// 计划步骤 → 四列卡片（待办/进行中/待验收/完成）；卡片绑定 s 编号、
// 任务 id 与验收证据；支持暂停/回滚标记与人工改派优先级。
// 状态迁移全部数据驱动，与 todo 状态可双向换算。

/** 看板四列状态 */
export type KanbanColumn = 'todo' | 'doing' | 'review' | 'done'

/** 优先级（与 TodoItem.priority 一致） */
export type KanbanPriority = 'high' | 'medium' | 'low'

/** 看板卡片 */
export interface KanbanCard {
  /** s 编号（如 s48-2；计划内步骤唯一） */
  sid: string
  /** 关联任务 id（活任务态；可空） */
  taskId: string | null
  title: string
  status: KanbanColumn
  priority: KanbanPriority
  /** 验收证据：文件路径/检查点/测试摘要等（待验收列必填展示） */
  evidence: string[]
  /** 已请求单卡片暂停（暂停按钮标记，等待任务门进入 paused） */
  pauseRequested: boolean
  /** 已回滚（回滚到任务前检查点，卡片退回待办） */
  rolledBack: boolean
  /**
   * s50 分派角色（'frontend'/'backend'/'test'；仅作字符串持有，
   * 派发时由主进程角色层校验，避免 shared 反向依赖 main）。
   */
  role?: string
}

/** 看板状态：卡片集合 */
export type KanbanState = KanbanCard[]

/** 列中文标签（渲染端表头） */
export const COLUMN_LABELS: Record<KanbanColumn, string> = {
  todo: '待办',
  doing: '进行中',
  review: '待验收',
  done: '完成'
}

/** 合法迁移表（四列状态机） */
const TRANSITIONS: Record<KanbanColumn, KanbanColumn[]> = {
  todo: ['doing'],
  // 进行中：完成 → 待验收；人工暂停/回滚 → 退回待办
  doing: ['review', 'todo'],
  // 待验收：验收通过 → 完成；验收不通过 → 退回进行中返工
  review: ['done', 'doing'],
  // 完成：回滚可退回待办（重新发起的极端情况）
  done: ['todo']
}

export function canMove(from: KanbanColumn, to: KanbanColumn): boolean {
  return TRANSITIONS[from].includes(to)
}

/**
 * 迁移卡片列：非法迁移抛错（调用方捕获后给前端提示）。
 * 返回新数组（不可变，便于响应式与测试断言）。
 */
export function moveCard(state: KanbanState, sid: string, to: KanbanColumn): KanbanState {
  const card = state.find((c) => c.sid === sid)
  if (!card) throw new Error(`卡片不存在：${sid}`)
  if (card.status === to) return state
  if (!canMove(card.status, to)) {
    throw new Error(`不允许的迁移：${COLUMN_LABELS[card.status]} → ${COLUMN_LABELS[to]}`)
  }
  return state.map((c) => {
    if (c.sid !== sid) return c
    const next: KanbanCard = { ...c, status: to }
    // 回滚/暂停 → 待办时清理运行标记
    if (to === 'todo') {
      next.pauseRequested = false
      next.rolledBack = c.rolledBack
      next.taskId = null
    }
    if (to === 'done') next.pauseRequested = false
    return next
  })
}

/** 人工改派优先级：返回新数组 */
export function setPriority(state: KanbanState, sid: string, priority: KanbanPriority): KanbanState {
  return state.map((c) => (c.sid === sid ? { ...c, priority } : c))
}

/**
 * s50 设置卡片分派角色：仅接受 frontend/backend/test（空串清除）；
 * 非法角色原样返回。
 */
export function setCardRole(state: KanbanState, sid: string, role: string): KanbanState {
  if (role && role !== 'frontend' && role !== 'backend' && role !== 'test') return state
  return state.map((c) => (c.sid === sid ? { ...c, role: role || undefined } : c))
}

/** 单卡片暂停请求（仅进行中卡片允许；真正挂起由任务门执行） */
export function requestCardPause(state: KanbanState, sid: string): KanbanState {
  const card = state.find((c) => c.sid === sid)
  if (!card) throw new Error(`卡片不存在：${sid}`)
  if (card.status !== 'doing') throw new Error('仅进行中的卡片可以暂停')
  return state.map((c) => (c.sid === sid ? { ...c, pauseRequested: true } : c))
}

/** 单卡片回滚：进行中 → 待办并打回滚标记（主进程随后恢复任务前检查点） */
export function rollbackCard(state: KanbanState, sid: string): KanbanState {
  const card = state.find((c) => c.sid === sid)
  if (!card) throw new Error(`卡片不存在：${sid}`)
  if (card.status !== 'doing') throw new Error('仅进行中的卡片可以回滚')
  return state.map((c) =>
    c.sid === sid
      ? { ...c, status: 'todo', pauseRequested: false, rolledBack: true, taskId: null }
      : c
  )
}

/** 追加验收证据（任务完成步骤产出文件/检查点/测试结果时写入） */
export function addEvidence(state: KanbanState, sid: string, evidence: string): KanbanState {
  if (!evidence) return state
  return state.map((c) =>
    c.sid === sid && !c.evidence.includes(evidence) ? { ...c, evidence: [...c.evidence, evidence] } : c
  )
}

// ===== 与 todo 列表的双向换算（看板状态与 44 式验收总表同步的桥梁）=====

/** todo 状态 → 看板列 */
export function todoStatusToColumn(status: string): KanbanColumn {
  switch (status) {
    case 'in_progress':
      return 'doing'
    case 'completed':
      return 'done'
    default:
      return 'todo'
  }
}

/** 看板列 → todo 状态（review 无对应，归一为 in_progress 待回填） */
export function columnToTodoStatus(col: KanbanColumn): 'pending' | 'in_progress' | 'completed' {
  switch (col) {
    case 'doing':
    case 'review':
      return 'in_progress'
    case 'done':
      return 'completed'
    default:
      return 'pending'
  }
}

/** 从 todo 列表构建卡片（sid 用序号生成：s<round>-<seq>） */
export interface TodoLike {
  id: number
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  priority?: 'high' | 'medium' | 'low'
}

export function cardsFromTodos(todos: TodoLike[], sidPrefix = 's0'): KanbanState {
  return todos.map((t, i) => ({
    sid: `${sidPrefix}-${i + 1}`,
    taskId: null,
    title: t.content,
    status: todoStatusToColumn(t.status),
    priority: t.priority ?? 'medium',
    evidence: [],
    pauseRequested: false,
    rolledBack: false
  }))
}
/** 按列分组（渲染端四列）：列内按 高→中→低 优先级，同级保持稳定顺序 */
const PRIORITY_ORDER: Record<KanbanPriority, number> = { high: 0, medium: 1, low: 2 }
export function groupByColumn(state: KanbanState): Record<KanbanColumn, KanbanCard[]> {
  const groups: Record<KanbanColumn, KanbanCard[]> = { todo: [], doing: [], review: [], done: [] }
  for (const c of state) groups[c.status].push(c)
  for (const col of Object.keys(groups) as KanbanColumn[]) {
    groups[col].sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority])
  }
  return groups
}

/** 验收总表行（44 式）：看板卡片 → 总表一行的扁平结构 */
export interface AcceptanceRow {
  sid: string
  title: string
  column: KanbanColumn
  passed: boolean
  evidence: string[]
}

/** 看板 → 验收总表：done 视为通过，其余为未通过；review 行携带证据待审 */
export function toAcceptanceRows(state: KanbanState): AcceptanceRow[] {
  return state.map((c) => ({
    sid: c.sid,
    title: c.title,
    column: c.status,
    passed: c.status === 'done',
    evidence: c.evidence
  }))
}

/** 验收总表 → 看板：外部验收结果回写（仅能确认通过 → done；不通过 → doing 返工） */
export function applyAcceptance(state: KanbanState, row: { sid: string; passed: boolean }): KanbanState {
  return state.map((c) => {
    if (c.sid !== row.sid) return c
    if (row.passed && (c.status === 'review' || c.status === 'done')) {
      return { ...c, status: 'done' as KanbanColumn, pauseRequested: false }
    }
    if (!row.passed && c.status === 'review') {
      return { ...c, status: 'doing' as KanbanColumn }
    }
    return c
  })
}
