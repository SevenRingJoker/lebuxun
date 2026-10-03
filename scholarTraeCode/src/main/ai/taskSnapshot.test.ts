// taskSnapshot 纯函数单测：序列化往返、脏数据清洗、版本/字段边界、可恢复分类。
import { describe, it, expect } from 'vitest'
import {
  buildTaskSnapshot,
  parseTaskSnapshot,
  classifyRecoverable,
  serializeCtx,
  restoreCtx,
  clampRound,
  TASK_SCHEMA_VERSION,
  TASK_MAX_ROUNDS,
  USER_REQUEST_LIMIT,
  type SnapshotCollectInput,
  type ParsedTaskSnapshot,
  type TaskStatus
} from './taskSnapshot'
import type { PromptContext } from './promptBuilder'
import type { AiMessage } from './types'
import { createReplanState } from './replanner'

// ---------- 工厂 ----------

function makeCtx(over: Partial<PromptContext> = {}): PromptContext {
  return {
    workspace: 'D:/ws',
    currentFile: null,
    plan: null,
    isProjectCreation: true,
    createdFiles: new Set<string>(),
    ranNpmInstall: false,
    ranServe: false,
    ranMkdir: false,
    round: 0,
    stallRestarts: 0,
    agentsMd: null,
    rulesText: null,
    notesText: '',
    tools: [{ name: 'write' }],
    mcpServers: [],
    skillsText: undefined,
    todosText: '',
    currentTodo: null,
    directive: undefined,
    artifactManifest: null,
    environmentReport: '',
    ...over
  }
}

function makeInput(over: Partial<SnapshotCollectInput> = {}): SnapshotCollectInput {
  const ctx = over.ctx ?? makeCtx()
  return {
    taskId: 'task-abc',
    workspace: 'D:/ws',
    modelId: 'ollama:qwen2.5-coder',
    sessionId: 'sess-1',
    startRound: 0,
    convo: [{ role: 'user', content: '创建一个 vue 项目' }],
    ctx,
    todoSeq: 2,
    todos: [
      { id: 1, content: '建目录', status: 'completed', priority: 'high' },
      { id: 2, content: '写文件', status: 'pending', priority: 'medium' }
    ],
    replan: createReplanState(),
    executed: new Map<string, string>(),
    counters: { stallCount: 1, stallRestarts: 0, dedupStallCount: 0 },
    preTaskCheckpoint: null,
    startedAt: 1000,
    ...over
  }
}

/** build → JSON 字符串 → parse 完整往返 */
function roundtrip(input: SnapshotCollectInput, status: TaskStatus = 'running'): ParsedTaskSnapshot {
  const snap = buildTaskSnapshot(input, { status, updatedAt: 2000 })
  const parsed = parseTaskSnapshot(JSON.stringify(snap))
  if (!parsed) throw new Error('roundtrip parse 返回 null')
  return parsed
}

// ---------- buildTaskSnapshot ----------

describe('buildTaskSnapshot', () => {
  it('基本字段与计数原样落盘', () => {
    const s = buildTaskSnapshot(makeInput(), { status: 'running', updatedAt: 2000 })
    expect(s.schemaVersion).toBe(TASK_SCHEMA_VERSION)
    expect(s.taskId).toBe('task-abc')
    expect(s.workspace).toBe('D:/ws')
    expect(s.modelId).toBe('ollama:qwen2.5-coder')
    expect(s.sessionId).toBe('sess-1')
    expect(s.counters.stallCount).toBe(1)
    expect(s.startedAt).toBe(1000)
    expect(s.updatedAt).toBe(2000)
  })

  it('createdFiles Set → 排序数组', () => {
    const ctx = makeCtx({ createdFiles: new Set(['src/b.js', 'src/a.js', 'package.json']) })
    const s = buildTaskSnapshot(makeInput({ ctx }), { status: 'running', updatedAt: 1 })
    expect(s.ctx.createdFiles).toEqual(['package.json', 'src/a.js', 'src/b.js'])
  })

  it('executed Map → 按键排序 entry', () => {
    const executed = new Map([
      ['write {"path":"b"}', 'ok-b'],
      ['write {"path":"a"}', 'ok-a']
    ])
    const s = buildTaskSnapshot(makeInput({ executed }), { status: 'running', updatedAt: 1 })
    expect(s.executed).toEqual([
      ['write {"path":"a"}', 'ok-a'],
      ['write {"path":"b"}', 'ok-b']
    ])
  })

  it('空集合落为空数组，不产生 null', () => {
    const s = buildTaskSnapshot(makeInput(), { status: 'running', updatedAt: 1 })
    expect(s.executed).toEqual([])
    expect(s.ctx.createdFiles).toEqual([])
  })

  it('userRequest 优先取 plan，无 plan 时取末条 user 文本', () => {
    const withPlan = buildTaskSnapshot(
      makeInput({ ctx: makeCtx({ plan: '详细计划文本' }) }),
      { status: 'running', updatedAt: 1 }
    )
    expect(withPlan.userRequest).toBe('详细计划文本')

    const noPlan = buildTaskSnapshot(makeInput(), { status: 'running', updatedAt: 1 })
    expect(noPlan.userRequest).toBe('创建一个 vue 项目')
  })

  it('userRequest 超过 500 字截断并补省略号', () => {
    const long = '计'.repeat(600)
    const s = buildTaskSnapshot(makeInput({ ctx: makeCtx({ plan: long }) }), {
      status: 'running',
      updatedAt: 1
    })
    expect(s.userRequest.length).toBe(USER_REQUEST_LIMIT + 1)
    expect(s.userRequest.endsWith('…')).toBe(true)
  })
})

// ---------- ctx 互转 ----------

describe('ctx 序列化/还原', () => {
  it('完整往返保持字段一致', () => {
    const ctx = makeCtx({
      createdFiles: new Set(['a.js']),
      ranNpmInstall: true,
      ranServe: true,
      ranMkdir: true,
      round: 3,
      mcpServers: ['m1'],
      todosText: '清单',
      artifactManifest: { rules: [{ kind: 'fileExists', path: 'a.js' }] } as any
    })
    const restored = restoreCtx(serializeCtx(ctx))
    expect(restored.createdFiles).toBeInstanceOf(Set)
    expect(restored.createdFiles.has('a.js')).toBe(true)
    expect(restored.ranNpmInstall).toBe(true)
    expect(restored.ranServe).toBe(true)
    expect(restored.ranMkdir).toBe(true)
    expect(restored.round).toBe(3)
    expect(restored.mcpServers).toEqual(['m1'])
    expect(restored.todosText).toBe('清单')
    expect(restored.artifactManifest).toEqual({ rules: [{ kind: 'fileExists', path: 'a.js' }] })
  })

  it('还原缺省/残缺 ctx 不炸，tools 与 mcpServers 兜底为空数组', () => {
    const restored = restoreCtx({} as any)
    expect(restored.tools).toEqual([])
    expect(restored.mcpServers).toEqual([])
    expect(restored.createdFiles).toBeInstanceOf(Set)
    expect(restored.createdFiles.size).toBe(0)
  })
})

// ---------- parse ----------

describe('parseTaskSnapshot', () => {
  it('完整往返恢复消息/待办/计数', () => {
    const executed = new Map([['bash npm install', 'done']])
    const r = roundtrip(makeInput({ executed, startRound: 4 }))
    expect(r.startRound).toBe(4)
    expect(r.convo[0].content).toBe('创建一个 vue 项目')
    expect(r.todos.map((t) => t.id)).toEqual([1, 2])
    expect(r.executed).toEqual([['bash npm install', 'done']])
  })

  it('非法 JSON → null', () => {
    expect(parseTaskSnapshot('{not json')).toBeNull()
  })

  it('版本不符 → null', () => {
    const raw = JSON.stringify({ ...buildTaskSnapshot(makeInput(), { status: 'running', updatedAt: 1 }), schemaVersion: 99 })
    expect(parseTaskSnapshot(raw)).toBeNull()
  })

  it('convo 缺失或非数组 → null', () => {
    const base: any = buildTaskSnapshot(makeInput(), { status: 'running', updatedAt: 1 })
    expect(parseTaskSnapshot(JSON.stringify({ ...base, convo: undefined }))).toBeNull()
    expect(parseTaskSnapshot(JSON.stringify({ ...base, convo: 'x' }))).toBeNull()
  })

  it('convo 全部是脏消息 → null；部分脏则过滤', () => {
    const base: any = buildTaskSnapshot(makeInput(), { status: 'running', updatedAt: 1 })
    const allDirty = JSON.stringify({ ...base, convo: [{ role: 'hacker', content: 'x' }, { role: 'user' }] })
    expect(parseTaskSnapshot(allDirty)).toBeNull()

    const mixed = JSON.stringify({
      ...base,
      convo: [
        { role: 'user', content: '好' },
        { role: 'bad', content: '丢' },
        { role: 'assistant', content: '答', junk: 1 }
      ]
    })
    const r = parseTaskSnapshot(mixed)!
    expect(r.convo).toEqual([
      { role: 'user', content: '好', name: undefined },
      { role: 'assistant', content: '答', name: undefined }
    ])
  })

  it('待办脏数据清洗，todoSeq 取声明值与最大 id 的较大者', () => {
    const base: any = buildTaskSnapshot(makeInput(), { status: 'running', updatedAt: 1 })
    const raw = JSON.stringify({
      ...base,
      todoSeq: 1,
      todos: [
        { id: 5, content: '有效', status: 'completed', priority: 'high' },
        { id: -1, content: '坏 id' },
        { id: 6, content: '坏状态', status: 'xxx' },
        { id: 7 }
      ]
    })
    const r = parseTaskSnapshot(raw)!
    expect(r.todos).toHaveLength(2)
    expect(r.todos[0].id).toBe(5)
    expect(r.todos[1].status).toBe('pending')
    expect(r.todos[1].priority).toBe('medium')
    expect(r.todoSeq).toBe(6)
  })

  it('executed 脏 entry 被过滤', () => {
    const base: any = buildTaskSnapshot(makeInput(), { status: 'running', updatedAt: 1 })
    const raw = JSON.stringify({
      ...base,
      executed: [['ok', 'v'], ['bad', 1], 'nope', null]
    })
    expect(parseTaskSnapshot(raw)!.executed).toEqual([['ok', 'v']])
  })

  it('replan 信号清洗；replan 整体缺失按空状态恢复', () => {
    const base: any = buildTaskSnapshot(makeInput(), { status: 'running', updatedAt: 1 })
    const withSignals = JSON.stringify({
      ...base,
      replan: {
        consecutiveFailures: 3,
        replanCount: 1,
        signals: [
          { trigger: 'commandFailure', detail: 'npm ERR!', at: 50 },
          { trigger: 'bogus', detail: 'x' }
        ]
      }
    })
    const r = parseTaskSnapshot(withSignals)!
    expect(r.replan.consecutiveFailures).toBe(3)
    expect(r.replan.replanCount).toBe(1)
    expect(r.replan.signals).toHaveLength(1)
    expect(r.replan.signals[0].trigger).toBe('commandFailure')

    const noReplan = parseTaskSnapshot(JSON.stringify({ ...base, replan: undefined }))!
    expect(noReplan.replan).toEqual({ consecutiveFailures: 0, replanCount: 0, signals: [] })
  })

  it('非法 status 兜底为 interrupted', () => {
    const base: any = buildTaskSnapshot(makeInput(), { status: 'running', updatedAt: 1 })
    expect(parseTaskSnapshot(JSON.stringify({ ...base, status: 'wtf' }))!.status).toBe('interrupted')
  })

  it('ctx 整体缺失不炸，恢复为默认 ctx', () => {
    const base: any = buildTaskSnapshot(makeInput(), { status: 'running', updatedAt: 1 })
    const r = parseTaskSnapshot(JSON.stringify({ ...base, ctx: undefined }))!
    expect(r.ctx.tools).toEqual([])
    expect(r.ctx.createdFiles).toBeInstanceOf(Set)
    expect(r.ctx.createdFiles.size).toBe(0)
    expect(r.ctx.isProjectCreation).toBe(false)
  })

  it('检查点信息清洗：hash 为空则置 null', () => {
    const withCp = roundtrip(
      makeInput({ preTaskCheckpoint: { hash: 'abc123', label: '任务前' } })
    )
    expect(withCp.preTaskCheckpoint).toEqual({ hash: 'abc123', label: '任务前' })

    const base: any = buildTaskSnapshot(makeInput(), { status: 'running', updatedAt: 1 })
    const badCp = parseTaskSnapshot(
      JSON.stringify({ ...base, preTaskCheckpoint: { hash: '', label: 'x' } })
    )!
    expect(badCp.preTaskCheckpoint).toBeNull()
  })
})

// ---------- clampRound ----------

describe('clampRound', () => {
  it('负数/NaN/非数字 → 0', () => {
    expect(clampRound(-3)).toBe(0)
    expect(clampRound(NaN)).toBe(0)
    expect(clampRound('x' as any)).toBe(0)
  })
  it('超过最大轮数钳到上限，小数向下取整', () => {
    expect(clampRound(TASK_MAX_ROUNDS + 5)).toBe(TASK_MAX_ROUNDS)
    expect(clampRound(2.9)).toBe(2)
  })
})

// ---------- classifyRecoverable ----------

describe('classifyRecoverable', () => {
  // 构造 ParsedTaskSnapshot：build 盘上结构 → 改写 status → 走 parse
  function file(status: TaskStatus, updatedAt: number): ParsedTaskSnapshot {
    const disk = buildTaskSnapshot(makeInput(), { status, updatedAt })
    return parseTaskSnapshot(JSON.stringify({ ...disk, status, updatedAt }))!
  }

  it('running 归为 interrupted（崩溃识别），paused 保留', () => {
    const [a, b] = classifyRecoverable([file('running', 1), file('paused', 2)])
    expect(b.status).toBe('interrupted')
    expect(a.status).toBe('paused')
  })

  it('completed/aborted 不进恢复列表', () => {
    expect(classifyRecoverable([file('completed', 1), file('aborted', 2)])).toHaveLength(0)
  })

  it('interrupted 原样保留且按 updatedAt 倒序', () => {
    const list = classifyRecoverable([file('interrupted', 100), file('interrupted', 300)])
    expect(list.map((f) => f.updatedAt)).toEqual([300, 100])
  })

  it('空输入 → 空数组', () => {
    expect(classifyRecoverable([])).toEqual([])
  })
})
