// 任务规划与状态管理：Agent 通过 todo_write 工具自主创建、跟踪、完成子任务。
// TodoStore 为单次 Agent 运行的内存状态，每轮渲染进分层 Prompt 的 S11 层，
// 并通过事件推送给前端实现进度可视化。㊜ 起支持经 hydrate 从任务快照断点恢复。

export type TodoStatus = 'pending' | 'in_progress' | 'completed'
export type TodoPriority = 'high' | 'medium' | 'low'

/** 单个子任务 */
export interface TodoItem {
  id: number
  content: string
  status: TodoStatus
  priority: TodoPriority
}

/** todo_write 工具入参（支持批量 add 与单条 update） */
export interface TodoWriteArgs {
  /** add=新增（可用 todos 批量）；update=更新状态/内容；list=查看清单；clear=清空 */
  action?: 'add' | 'update' | 'list' | 'clear'
  /** 批量新增（规划阶段一次性建立任务清单） */
  todos?: { content: string; priority?: TodoPriority; status?: TodoStatus }[]
  /** 单条新增内容 */
  content?: string
  priority?: TodoPriority
  /** update 时指定任务 id */
  id?: number
  status?: TodoStatus
}

export class TodoStore {
  private seq = 0
  readonly items: TodoItem[] = []

  /**
   * 处理 todo_write 工具调用，返回给模型的人类可读确认文本。
   * 非法参数返回错误提示（不抛异常，让模型自行纠正）。
   */
  handle(args: TodoWriteArgs | null | undefined): string {
    const action = args?.action ?? 'list'
    switch (action) {
      case 'add':
        return this.handleAdd(args)
      case 'update':
        return this.handleUpdate(args)
      case 'clear':
        this.items.length = 0
        return '已清空全部任务'
      case 'list':
      default:
        return this.render() || '任务清单为空'
    }
  }

  /** 新增：支持 todos 批量或单条 content */
  private handleAdd(args: TodoWriteArgs | null | undefined): string {
    const batch = args?.todos
    if (Array.isArray(batch) && batch.length > 0) {
      const added: TodoItem[] = []
      for (const t of batch) {
        if (!t || typeof t.content !== 'string' || !t.content.trim()) continue
        added.push(this.add(t.content.trim(), t.priority, t.status))
      }
      if (added.length === 0) return '错误：todos 中没有有效的 content'
      return `已新增 ${added.length} 个任务\n${this.render()}`
    }
    if (typeof args?.content === 'string' && args.content.trim()) {
      const item = this.add(args.content.trim(), args.priority, args.status)
      return `已新增任务 #${item.id}\n${this.render()}`
    }
    return '错误：add 需要 content 或 todos 参数'
  }

  /** 更新任务状态或内容 */
  private handleUpdate(args: TodoWriteArgs | null | undefined): string {
    if (typeof args?.id !== 'number') return '错误：update 需要数字 id（用 list 查看 id）'
    const item = this.items.find((t) => t.id === args.id)
    if (!item) return `错误：未找到任务 #${args.id}`
    if (args.status === 'pending' || args.status === 'in_progress' || args.status === 'completed') {
      item.status = args.status
    }
    if (typeof args.content === 'string' && args.content.trim()) {
      item.content = args.content.trim()
    }
    if (typeof args.priority === 'string') item.priority = args.priority
    return `任务 #${item.id} 已更新\n${this.render()}`
  }

  private add(content: string, priority?: TodoPriority, status?: TodoStatus): TodoItem {
    const item: TodoItem = {
      id: ++this.seq,
      content,
      status: status === 'in_progress' || status === 'completed' ? status : 'pending',
      priority: priority === 'high' || priority === 'low' ? priority : 'medium'
    }
    this.items.push(item)
    return item
  }

  /** 找到第一个未完成（pending/in_progress）的任务；全部完成时返回 null */
  nextIncomplete(): TodoItem | null {
    return this.items.find((t) => t.status !== 'completed') ?? null
  }

  /** 读取当前自增序号（任务快照收集用） */
  getSeq(): number {
    return this.seq
  }

  /**
   * 从任务快照恢复清单（断点续跑专用）。
   * seq 取声明值与最大 id 的较大者，避免恢复后新建 id 撞车；
   * 条目逐项重建而非直接引用，切断与快照对象的别名关系。
   */
  hydrate(seq: number, items: TodoItem[]): void {
    this.items.length = 0
    let maxId = 0
    for (const it of items) {
      if (!it || typeof it.id !== 'number' || typeof it.content !== 'string') continue
      const item: TodoItem = {
        id: it.id,
        content: it.content,
        status: it.status === 'in_progress' || it.status === 'completed' ? it.status : 'pending',
        priority: it.priority === 'high' || it.priority === 'low' ? it.priority : 'medium'
      }
      this.items.push(item)
      if (item.id > maxId) maxId = item.id
    }
    this.seq = Math.max(seq, maxId)
  }

  /** 渲染给系统提示词的清单文本 */
  render(): string {
    if (this.items.length === 0) return ''
    const done = this.items.filter((t) => t.status === 'completed').length
    const lines = this.items.map((t) => {
      const mark = t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[~]' : '[ ]'
      return `${mark} #${t.id} ${t.content}`
    })
    return `子任务进度（${done}/${this.items.length} 完成）：\n${lines.join('\n')}`
  }
}
