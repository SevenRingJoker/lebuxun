// s48 时间线纯函数单测：记录/配对/状态判定/失败筛选/回放定位/上限裁剪
import { describe, expect, it } from 'vitest'
import {
  MAX_TIMELINE_STEPS,
  argsBriefOf,
  createTimeline,
  diffSummaryOf,
  failedSteps,
  replayRoundOf,
  serializeTimeline,
  stepStatusOf,
  tlFinish,
  tlStart
} from './timeline'

describe('s48 执行时间线', () => {
  it('tlStart 追加 running 步骤并自增 id', () => {
    const tl = createTimeline()
    const s1 = tlStart(tl, { round: 0, name: 'read', args: { path: 'src/a.ts' }, reason: '先读文件' })
    const s2 = tlStart(tl, { round: 0, name: 'grep', args: { pattern: 'foo' }, reason: '再搜索' })
    expect(s1.id).toBe(1)
    expect(s2.id).toBe(2)
    expect(tl.steps.map((s) => s.status)).toEqual(['running', 'running'])
  })

  it('参数摘要优先取路径/命令类字段', () => {
    expect(argsBriefOf('read', { path: 'src/a.ts' })).toBe('read src/a.ts')
    expect(argsBriefOf('bash', { command: 'npm test' })).toBe('bash npm test')
    expect(argsBriefOf('unknown', { a: 1 })).toBe('unknown { a }')
    expect(argsBriefOf('noop', null)).toBe('noop')
  })

  it('长参数在 80 字符处截断', () => {
    const p = 'x'.repeat(100)
    expect(argsBriefOf('read', { path: p }).length).toBeLessThan(95)
  })

  it('diff 摘要：写文件给路径+行数', () => {
    const d = diffSummaryOf('write', { path: 'a.ts', content: '1\n2\n3' })
    expect(d).toBe('a.ts（3 行）')
    expect(diffSummaryOf('write_file', { file_path: 'b.ts', content: '' })).toBe('b.ts（0 行）')
  })

  it('diff 摘要：删除/移动', () => {
    expect(diffSummaryOf('delete', { path: 'a.ts' })).toBe('删除 a.ts')
    expect(diffSummaryOf('move', { source: 'a.ts', destination: 'b.ts' })).toBe('a.ts → b.ts')
    expect(diffSummaryOf('read', { path: 'a.ts' })).toBe('')
  })

  it('tlFinish 匹配尾部最近同名 running 步骤并回填', () => {
    const tl = createTimeline()
    tlStart(tl, { round: 0, name: 'read', args: {}, reason: '' })
    const s = tlFinish(tl, 'read', '成功读取，内容如下')
    expect(s).not.toBeNull()
    expect(s!.status).toBe('ok')
    expect(s!.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('批量同名调用按最近匹配，互不串扰', () => {
    const tl = createTimeline()
    tlStart(tl, { round: 0, name: 'read', args: { path: 'a' }, reason: '' })
    tlStart(tl, { round: 0, name: 'read', args: { path: 'b' }, reason: '' })
    const finishB = tlFinish(tl, 'read', 'b ok')
    expect(finishB!.title).toBe('read b')
    const finishA = tlFinish(tl, 'read', 'a ok')
    expect(finishA!.title).toBe('read a')
    expect(tl.steps.every((s) => s.status === 'ok')).toBe(true)
  })

  it('结果状态判定：取消/失败/成功', () => {
    expect(stepStatusOf('已被用户中止')).toBe('cancelled')
    expect(stepStatusOf('Error: something')).toBe('fail')
    expect(stepStatusOf('Traceback...')).toBe('fail')
    expect(stepStatusOf('完成：已写入')).toBe('ok')
  })

  it('失败步骤筛选（红色标记）', () => {
    const tl = createTimeline()
    tlStart(tl, { round: 0, name: 'read', args: {}, reason: '' })
    tlFinish(tl, 'read', 'ok')
    tlStart(tl, { round: 1, name: 'bash', args: {}, reason: '' })
    tlFinish(tl, 'bash', '错误：命令失败')
    const failed = failedSteps(tl)
    expect(failed).toHaveLength(1)
    expect(failed[0].name).toBe('bash')
    expect(failed[0].round).toBe(1)
  })

  it('未匹配到 running 步骤时 tlFinish 返回 null', () => {
    const tl = createTimeline()
    expect(tlFinish(tl, 'read', 'ok')).toBeNull()
    tlStart(tl, { round: 0, name: 'read', args: {}, reason: '' })
    tlFinish(tl, 'read', 'ok')
    // 再次回填同名（已结束）不再命中
    expect(tlFinish(tl, 'read', 'ok')).toBeNull()
  })

  it('回放定位取步骤所属轮次', () => {
    const tl = createTimeline()
    tlStart(tl, { round: 3, name: 'bash', args: {}, reason: '' })
    const s = tl.steps[0]
    expect(replayRoundOf(s)).toBe(3)
  })

  it('reason/result 超长字段被截断', () => {
    const tl = createTimeline()
    tlStart(tl, { round: 0, name: 'read', args: {}, reason: 'r'.repeat(1000) })
    expect(tl.steps[0].reason.length).toBeLessThan(650)
    tlFinish(tl, 'read', 'x'.repeat(1000))
    expect(tl.steps[0].resultTail.length).toBeLessThan(850)
  })

  it('步骤数超上限时丢弃最旧记录', () => {
    const tl = createTimeline()
    for (let i = 0; i < MAX_TIMELINE_STEPS + 10; i++) {
      tlStart(tl, { round: i, name: 'read', args: {}, reason: '' })
    }
    expect(tl.steps).toHaveLength(MAX_TIMELINE_STEPS)
    // 最旧的是第 11 条（id=11，round=10）
    expect(tl.steps[0].round).toBe(10)
  })

  it('serializeTimeline 返回可拷贝的步骤数组', () => {
    const tl = createTimeline()
    tlStart(tl, { round: 0, name: 'read', args: { path: 'a' }, reason: 'why' })
    const out = serializeTimeline(tl)
    expect(out).toHaveLength(1)
    expect(out[0]).not.toBe(tl.steps[0])
    expect(out[0].reason).toBe('why')
  })
})
