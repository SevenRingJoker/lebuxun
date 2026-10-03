// todoManager 单元测试：TodoStore 的 add/update/list/clear/render 行为
import { describe, it, expect } from 'vitest'
import { TodoStore } from './todoManager'

// ==================== TodoStore ====================
describe('TodoStore', () => {
  it('批量 add 建立清单', () => {
    const store = new TodoStore()
    const result = store.handle({
      action: 'add',
      todos: [{ content: '任务 A' }, { content: '任务 B', priority: 'high' }]
    })
    expect(result).toContain('已新增 2 个任务')
    expect(store.items).toHaveLength(2)
    expect(store.items[0].content).toBe('任务 A')
    expect(store.items[1].priority).toBe('high')
  })

  it('单条 add', () => {
    const store = new TodoStore()
    const result = store.handle({ action: 'add', content: '单条任务' })
    expect(result).toContain('#1')
    expect(store.items).toHaveLength(1)
  })

  it('add 空内容返回错误', () => {
    const store = new TodoStore()
    expect(store.handle({ action: 'add' })).toContain('错误')
    expect(store.items).toHaveLength(0)
  })

  it('update 状态为 completed', () => {
    const store = new TodoStore()
    store.handle({ action: 'add', content: '任务 A' })
    const result = store.handle({ action: 'update', id: 1, status: 'completed' })
    expect(result).toContain('已更新')
    expect(store.items[0].status).toBe('completed')
  })

  it('update 不存在的 id 返回错误', () => {
    const store = new TodoStore()
    expect(store.handle({ action: 'update', id: 999, status: 'completed' })).toContain('错误')
  })

  it('update 缺 id 返回错误', () => {
    const store = new TodoStore()
    expect(store.handle({ action: 'update', status: 'completed' })).toContain('错误')
  })

  it('clear 清空全部', () => {
    const store = new TodoStore()
    store.handle({ action: 'add', content: 'A' })
    store.handle({ action: 'add', content: 'B' })
    expect(store.handle({ action: 'clear' })).toContain('已清空')
    expect(store.items).toHaveLength(0)
  })

  it('list 返回清单文本', () => {
    const store = new TodoStore()
    store.handle({ action: 'add', content: 'A' })
    const result = store.handle({ action: 'list' })
    expect(result).toContain('子任务进度')
    expect(result).toContain('A')
  })

  it('空清单 list 返回"任务清单为空"', () => {
    const store = new TodoStore()
    expect(store.handle({ action: 'list' })).toBe('任务清单为空')
  })

  it('render 正确显示完成数与状态标记', () => {
    const store = new TodoStore()
    store.handle({ action: 'add', content: 'A' })
    store.handle({ action: 'add', content: 'B' })
    store.handle({ action: 'update', id: 1, status: 'completed' })
    const text = store.render()
    expect(text).toContain('1/2 完成')
    expect(text).toContain('[x] #1 A')
    expect(text).toContain('[ ] #2 B')
  })

  it('render 空清单返回空串', () => {
    expect(new TodoStore().render()).toBe('')
  })

  it('id 自增不重复', () => {
    const store = new TodoStore()
    store.handle({ action: 'add', content: 'A' })
    store.handle({ action: 'add', content: 'B' })
    store.handle({ action: 'clear' })
    store.handle({ action: 'add', content: 'C' })
    // clear 不重置 seq，所以 C 的 id 是 3
    expect(store.items[0].id).toBe(3)
  })

  it('默认 priority 为 medium，非法 priority 兜底为 medium', () => {
    const store = new TodoStore()
    store.handle({ action: 'add', content: 'A' })
    store.handle({ action: 'add', content: 'B', priority: 'invalid' as any })
    expect(store.items[0].priority).toBe('medium')
    expect(store.items[1].priority).toBe('medium')
  })

  it('默认 status 为 pending', () => {
    const store = new TodoStore()
    store.handle({ action: 'add', content: 'A' })
    expect(store.items[0].status).toBe('pending')
  })

  it('可空参数不崩溃（null/undefined）', () => {
    const store = new TodoStore()
    expect(() => store.handle(null)).not.toThrow()
    expect(() => store.handle(undefined)).not.toThrow()
  })

  it('nextIncomplete：返回第一个未完成项', () => {
    const store = new TodoStore()
    store.handle({ action: 'add', content: 'A' })
    store.handle({ action: 'add', content: 'B' })
    store.handle({ action: 'update', id: 1, status: 'completed' })
    const next = store.nextIncomplete()
    expect(next?.id).toBe(2)
    expect(next?.content).toBe('B')
  })

  it('nextIncomplete：全部完成返回 null', () => {
    const store = new TodoStore()
    store.handle({ action: 'add', content: 'A' })
    store.handle({ action: 'update', id: 1, status: 'completed' })
    expect(store.nextIncomplete()).toBeNull()
  })

  it('nextIncomplete：空清单返回 null', () => {
    expect(new TodoStore().nextIncomplete()).toBeNull()
  })
})
