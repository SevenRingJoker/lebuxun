// agentTrace.ts 集成单测：轨迹录制/原子写入/列表/加载/滚动清理
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  TraceRecorder,
  saveTrace,
  listTraces,
  loadTrace,
  rotateTraces,
  type AgentTrace
} from './agentTrace'

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'scholar-trace-'))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('TraceRecorder — 基本录制', () => {
  it('初始状态为 running', () => {
    const r = new TraceRecorder('task-1', 'qwen2.5:7b', '/ws', null, false)
    const snap = r.snapshot()
    expect(snap.status).toBe('running')
    expect(snap.rounds).toHaveLength(0)
    expect(snap.model).toBe('qwen2.5:7b')
    expect(snap.workspace).toBe('/ws')
    expect(snap.isProjectCreation).toBe(false)
    expect(snap.startTime).toBeTruthy()
  })

  it('beginRound + recordModelCall 记录模型调用', () => {
    const r = new TraceRecorder('task-1', 'qwen2.5:7b', null, null, false)
    r.beginRound(0)
    r.recordModelCall(0, 5000, { promptTokens: 100, completionTokens: 50, totalTokens: 150 })
    const snap = r.snapshot()
    expect(snap.rounds).toHaveLength(1)
    expect(snap.rounds[0].round).toBe(0)
    expect(snap.rounds[0].modelCall?.durationMs).toBeGreaterThanOrEqual(0)
    expect(snap.rounds[0].modelCall?.systemChars).toBe(5000)
    expect(snap.rounds[0].modelCall?.usage?.totalTokens).toBe(150)
  })

  it('recordToolCall 记录工具调用（含截断）', () => {
    const r = new TraceRecorder('task-1', 'qwen2.5:7b', null, null, false)
    r.beginRound(0)
    r.recordModelCall(0, 100)
    const longArgs = 'x'.repeat(600)
    const longResult = 'y'.repeat(2500)
    r.recordToolCall(0, 'write_file', { path: '/test', content: longArgs }, longResult, 42)
    const snap = r.snapshot()
    expect(snap.rounds[0].tools).toHaveLength(1)
    expect(snap.rounds[0].tools[0].name).toBe('write_file')
    expect(snap.rounds[0].tools[0].durationMs).toBe(42)
    // 参数截断到 500 字符以内（含截断标记）
    expect(snap.rounds[0].tools[0].args.length).toBeLessThan(600)
    // 结果截断
    expect(snap.rounds[0].tools[0].result.length).toBeLessThan(2500)
    expect(snap.rounds[0].tools[0].result).toContain('截断')
  })

  it('finish 标记结束状态', () => {
    const r = new TraceRecorder('task-1', 'qwen2.5:7b', null, null, false)
    r.beginRound(0)
    r.finish('completed', '任务完成')
    const snap = r.snapshot()
    expect(snap.status).toBe('completed')
    expect(snap.endTime).toBeTruthy()
    expect(snap.finalContent).toContain('任务完成')
  })

  it('finish error 记录错误信息', () => {
    const r = new TraceRecorder('task-1', 'qwen2.5:7b', null, null, false)
    r.finish('error', undefined, '模型调用超时')
    const snap = r.snapshot()
    expect(snap.status).toBe('error')
    expect(snap.error).toBe('模型调用超时')
  })

  it('skipped 标记', () => {
    const r = new TraceRecorder('task-1', 'qwen2.5:7b', null, null, false)
    r.beginRound(0)
    r.recordToolCall(0, 'bash', { cmd: 'ls' }, '已拦截', 0, true)
    expect(r.snapshot().rounds[0].tools[0].skipped).toBe(true)
  })
})

describe('saveTrace + loadTrace', () => {
  it('原子写入并加载完整轨迹', async () => {
    const r = new TraceRecorder('task-abc', 'qwen2.5:7b', '/ws', null, true)
    r.beginRound(0)
    r.recordModelCall(0, 1000, { totalTokens: 200 })
    r.recordToolCall(0, 'write_file', { path: '/a.ts' }, '写入成功', 10)
    r.beginRound(1)
    r.recordModelCall(1, 1200, { totalTokens: 300 })
    r.finish('completed', '完成')

    saveTrace(dir, r.snapshot())
    const files = await fs.readdir(dir)
    expect(files).toHaveLength(1)
    expect(files[0]).toContain('task-abc')

    const loaded = loadTrace(dir, files[0])
    expect(loaded).not.toBeNull()
    expect(loaded!.rounds).toHaveLength(2)
    expect(loaded!.rounds[0].tools).toHaveLength(1)
    expect(loaded!.rounds[0].tools[0].name).toBe('write_file')
    expect(loaded!.status).toBe('completed')
  })

  it('加载不存在的文件返回 null', () => {
    expect(loadTrace(dir, 'nonexistent.json')).toBeNull()
  })
})

describe('listTraces', () => {
  it('按时间倒序列出元数据', async () => {
    // 创建 3 条轨迹，时间不同
    for (let i = 0; i < 3; i++) {
      const r = new TraceRecorder(`task-${i}`, 'qwen2.5:7b', null, null, false)
      // 手动改 startTime 以保证顺序
      const snap = r.snapshot()
      snap.startTime = `2026-09-2${i}T10:00:00.000Z`
      snap.status = 'completed'
      saveTrace(dir, snap)
    }
    const list = listTraces(dir)
    expect(list).toHaveLength(3)
    // 倒序：最新的在前
    expect(list[0].startTime > list[1].startTime).toBe(true)
    expect(list[0].taskId).toBe('task-2')
  })

  it('空目录返回空数组', () => {
    expect(listTraces(dir)).toEqual([])
  })

  it('损坏的 JSON 文件被跳过', async () => {
    await fs.writeFile(join(dir, 'bad.json'), 'not json', 'utf-8')
    const r = new TraceRecorder('good', 'qwen2.5:7b', null, null, false)
    saveTrace(dir, r.snapshot())
    const list = listTraces(dir)
    expect(list).toHaveLength(1)
    expect(list[0].taskId).toBe('good')
  })
})

describe('rotateTraces', () => {
  it('删除超过保留天数的轨迹', async () => {
    // 写一个正常的轨迹
    const r = new TraceRecorder('recent', 'qwen2.5:7b', null, null, false)
    saveTrace(dir, r.snapshot())
    // 手动创建一个旧文件（修改 mtime）
    const oldFile = join(dir, '2026-01-01-old.json')
    const trace: AgentTrace = {
      version: 1,
      taskId: 'old',
      startTime: '2026-01-01T00:00:00.000Z',
      model: 'test',
      isProjectCreation: false,
      rounds: [],
      status: 'completed'
    }
    await fs.writeFile(oldFile, JSON.stringify(trace), 'utf-8')
    // 修改 mtime 为 10 天前
    const oldTime = new Date(Date.now() - 10 * 86400000)
    await fs.utimes(oldFile, oldTime, oldTime)

    rotateTraces(dir, 7)
    // 旧文件被删除，新文件保留
    await expect(fs.access(oldFile)).rejects.toThrow()
    const remaining = await fs.readdir(dir)
    expect(remaining.length).toBe(1)
  })
})
