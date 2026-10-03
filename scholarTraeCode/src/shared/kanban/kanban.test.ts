// s49 看板状态机单测：迁移合法性/优先级/暂停回滚/证据/todo 换算/验收总表双向同步
import { describe, expect, it } from 'vitest'
import {
  addEvidence,
  applyAcceptance,
  canMove,
  cardsFromTodos,
  columnToTodoStatus,
  groupByColumn,
  moveCard,
  requestCardPause,
  rollbackCard,
  setCardRole,
  setPriority,
  toAcceptanceRows,
  todoStatusToColumn,
  type KanbanState
} from './kanban'

function baseState(): KanbanState {
  return cardsFromTodos(
    [
      { id: 1, content: '步骤一', status: 'pending', priority: 'medium' },
      { id: 2, content: '步骤二', status: 'pending', priority: 'low' }
    ],
    's49'
  )
}

describe('s49 看板状态机', () => {
  it('合法迁移表', () => {
    expect(canMove('todo', 'doing')).toBe(true)
    expect(canMove('doing', 'review')).toBe(true)
    expect(canMove('doing', 'todo')).toBe(true)
    expect(canMove('review', 'done')).toBe(true)
    expect(canMove('review', 'doing')).toBe(true)
    expect(canMove('done', 'todo')).toBe(true)
    // 非法：跳过列/逆向
    expect(canMove('todo', 'done')).toBe(false)
    expect(canMove('todo', 'review')).toBe(false)
    expect(canMove('done', 'review')).toBe(false)
  })

  it('moveCard 合法迁移并返回新数组', () => {
    const s0 = baseState()
    const s1 = moveCard(s0, 's49-1', 'doing')
    expect(s1).not.toBe(s0)
    expect(s1[0].status).toBe('doing')
    // 原状态不被突变
    expect(s0[0].status).toBe('todo')
  })

  it('moveCard 非法迁移抛错', () => {
    const s = baseState()
    expect(() => moveCard(s, 's49-1', 'done')).toThrow(/不允许的迁移/)
  })

  it('moveCard 卡片不存在抛错', () => {
    expect(() => moveCard(baseState(), 'x', 'doing')).toThrow(/卡片不存在/)
  })

  it('移到同一列原样返回', () => {
    const s = baseState()
    expect(moveCard(s, 's49-1', 'todo')).toBe(s)
  })

  it('回滚到待办清理 taskId 与暂停标记', () => {
    let s = moveCard(baseState(), 's49-1', 'doing')
    s = requestCardPause(s, 's49-1')
    s = s.map((c) => (c.sid === 's49-1' ? { ...c, taskId: 't-1' } : c))
    s = rollbackCard(s, 's49-1')
    expect(s[0].status).toBe('todo')
    expect(s[0].taskId).toBeNull()
    expect(s[0].pauseRequested).toBe(false)
    expect(s[0].rolledBack).toBe(true)
  })

  it('非进行中卡片不可暂停/回滚', () => {
    const s = baseState()
    expect(() => requestCardPause(s, 's49-1')).toThrow()
    expect(() => rollbackCard(s, 's49-1')).toThrow()
  })

  it('改派优先级', () => {
    const s = setPriority(baseState(), 's49-2', 'high')
    expect(s[1].priority).toBe('high')
    expect(baseState()[1].priority).toBe('low')
  })

  it('证据去重追加', () => {
    let s = addEvidence(baseState(), 's49-1', 'a.ts')
    s = addEvidence(s, 's49-1', 'a.ts')
    s = addEvidence(s, 's49-1', '检查点 #3')
    expect(s[0].evidence).toEqual(['a.ts', '检查点 #3'])
  })

  it('todo ↔ 看板列换算', () => {
    expect(todoStatusToColumn('pending')).toBe('todo')
    expect(todoStatusToColumn('in_progress')).toBe('doing')
    expect(todoStatusToColumn('completed')).toBe('done')
    expect(columnToTodoStatus('review')).toBe('in_progress')
    expect(columnToTodoStatus('todo')).toBe('pending')
    expect(columnToTodoStatus('done')).toBe('completed')
  })

  it('cardsFromTodos 绑定 sid 与标题', () => {
    const s = baseState()
    expect(s.map((c) => c.sid)).toEqual(['s49-1', 's49-2'])
    expect(s[0].title).toBe('步骤一')
  })

  it('groupByColumn 四列分组且列内高优先级在前', () => {
    let s = baseState()
    s = moveCard(s, 's49-1', 'doing')
    s = moveCard(s, 's49-2', 'doing')
    s = setPriority(s, 's49-2', 'high')
    const groups = groupByColumn(s)
    expect(groups.doing.map((c) => c.sid)).toEqual(['s49-2', 's49-1'])
    expect(groups.todo).toHaveLength(0)
  })

  it('看板 → 验收总表：仅 done 通过', () => {
    let s = moveCard(moveCard(baseState(), 's49-1', 'doing'), 's49-1', 'review')
    const rows = toAcceptanceRows(s)
    expect(rows[0].passed).toBe(false)
    expect(rows[0].column).toBe('review')
    expect(rows[1].passed).toBe(false)
  })

  it('验收总表 → 看板：通过落 done，不通过回 doing 返工', () => {
    let s = moveCard(moveCard(baseState(), 's49-1', 'doing'), 's49-1', 'review')
    const passed = applyAcceptance(s, { sid: 's49-1', passed: true })
    expect(passed[0].status).toBe('done')
    const rejected = applyAcceptance(s, { sid: 's49-1', passed: false })
    expect(rejected[0].status).toBe('doing')
  })

  it('非 review 卡片的验收结果不误迁移', () => {
    const s = baseState() // todo 列
    const out = applyAcceptance(s, { sid: 's49-1', passed: true })
    expect(out[0].status).toBe('todo')
  })

  it('s50 setCardRole：合法角色写入，非法忽略，空串清除', () => {
    const s1 = setCardRole(baseState(), 's49-1', 'frontend')
    expect(s1[0].role).toBe('frontend')
    const s2 = setCardRole(s1, 's49-1', 'hacker')
    expect(s2[0].role).toBe('frontend')
    const s3 = setCardRole(s2, 's49-1', '')
    expect(s3[0].role).toBeUndefined()
  })
})
