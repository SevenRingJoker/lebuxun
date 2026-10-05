// observer.ts 单元测试：状态机（noteReadFailure/canTrigger/防抖）、
// 提示词构建、诊断 JSON 解析容错。
import { describe, expect, it } from 'vitest'
import {
  createObserverState,
  noteReadFailure,
  noteReadSuccess,
  canTrigger,
  serializeObserverState,
  deserializeObserverState,
  buildObserverPrompt,
  parseObserverVerdict,
  TRIGGER_THRESHOLD,
  MAX_TRIGGERS
} from './observer'

describe('createObserverState', () => {
  it('初始状态为全零', () => {
    const s = createObserverState()
    expect(s.readFailures).toBe(0)
    expect(s.triggerCount).toBe(0)
    expect(s.lastTriggerPath).toBeNull()
  })
})

describe('noteReadFailure', () => {
  it('未达阈值不触发', () => {
    const s = createObserverState()
    for (let i = 0; i < TRIGGER_THRESHOLD - 1; i++) {
      expect(noteReadFailure(s, `path${i}`)).toBe(false)
    }
    expect(s.readFailures).toBe(TRIGGER_THRESHOLD - 1)
    expect(s.triggerCount).toBe(0)
  })

  it('达阈值首次触发并复位计数', () => {
    const s = createObserverState()
    let triggered = false
    for (let i = 0; i < TRIGGER_THRESHOLD; i++) {
      triggered = noteReadFailure(s, `path${i}`)
    }
    expect(triggered).toBe(true)
    expect(s.triggerCount).toBe(1)
    expect(s.readFailures).toBe(0)
    expect(s.lastTriggerPath).toBe(`path${TRIGGER_THRESHOLD - 1}`)
  })

  it('同一路径重复触发短路不重复计数', () => {
    const s = createObserverState()
    for (let i = 0; i < TRIGGER_THRESHOLD; i++) noteReadFailure(s, 'a')
    const before = s.readFailures
    expect(noteReadFailure(s, 'a')).toBe(false)
    expect(s.readFailures).toBe(before)
  })

  it('超过防抖上限后不再触发', () => {
    const s = createObserverState()
    // 第一次触发
    for (let i = 0; i < TRIGGER_THRESHOLD; i++) noteReadFailure(s, `r1-${i}`)
    expect(s.triggerCount).toBe(1)
    // 第二次触发
    for (let i = 0; i < TRIGGER_THRESHOLD; i++) noteReadFailure(s, `r2-${i}`)
    expect(s.triggerCount).toBe(2)
    expect(canTrigger(s)).toBe(false)
    // 第三次尝试：canTrigger=false，noteReadFailure 不再 bump triggerCount
    for (let i = 0; i < TRIGGER_THRESHOLD * 2; i++) {
      expect(noteReadFailure(s, `r3-${i}`)).toBe(false)
    }
    expect(s.triggerCount).toBe(MAX_TRIGGERS)
  })

  it('触发后 readFailures 重置，可重新累计', () => {
    const s = createObserverState()
    for (let i = 0; i < TRIGGER_THRESHOLD; i++) noteReadFailure(s, `x${i}`)
    expect(s.readFailures).toBe(0)
    // 再累计一次
    for (let i = 0; i < TRIGGER_THRESHOLD; i++) noteReadFailure(s, `y${i}`)
    expect(s.triggerCount).toBe(2)
  })
})

describe('noteReadSuccess', () => {
  it('重置连续失败计数', () => {
    const s = createObserverState()
    noteReadFailure(s, 'a')
    noteReadFailure(s, 'b')
    expect(s.readFailures).toBe(2)
    noteReadSuccess(s)
    expect(s.readFailures).toBe(0)
  })
})

describe('canTrigger', () => {
  it('triggerCount < MAX_TRIGGERS 时为 true', () => {
    const s = createObserverState()
    expect(canTrigger(s)).toBe(true)
    s.triggerCount = MAX_TRIGGERS - 1
    expect(canTrigger(s)).toBe(true)
    s.triggerCount = MAX_TRIGGERS
    expect(canTrigger(s)).toBe(false)
  })
})

describe('serialize/deserialize', () => {
  it('序列化往返一致', () => {
    const s = createObserverState()
    s.readFailures = 2
    s.triggerCount = 1
    s.lastTriggerPath = 'src/main.js'
    const restored = deserializeObserverState(serializeObserverState(s))
    expect(restored).toEqual(s)
  })

  it('容忍缺失字段（旧快照兼容）', () => {
    const restored = deserializeObserverState({})
    expect(restored.readFailures).toBe(0)
    expect(restored.triggerCount).toBe(0)
    expect(restored.lastTriggerPath).toBeNull()
  })

  it('非对象输入返回初始状态', () => {
    expect(deserializeObserverState(null)).toEqual(createObserverState())
    expect(deserializeObserverState('x')).toEqual(createObserverState())
    expect(deserializeObserverState(42)).toEqual(createObserverState())
  })

  it('非法数字归一化为 0', () => {
    const restored = deserializeObserverState({ readFailures: -1, triggerCount: NaN })
    expect(restored.readFailures).toBe(0)
    expect(restored.triggerCount).toBe(0)
  })
})

describe('buildObserverPrompt', () => {
  it('包含失败路径、轨迹、状态摘要与 JSON 输出要求', () => {
    const p = buildObserverPrompt('src/a.js', 'trace-content', 'ctx-summary')
    expect(p).toContain('src/a.js')
    expect(p).toContain('trace-content')
    expect(p).toContain('ctx-summary')
    expect(p).toContain('"kind"')
    expect(p).toContain('strategy')
    expect(p).toContain('codefix')
  })
})

describe('parseObserverVerdict', () => {
  it('解析 strategy', () => {
    const r = parseObserverVerdict('前言 {"kind":"strategy","instruction":"停止读取，直接 write 创建 package.json"} 后记')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.verdict.kind).toBe('strategy')
      expect((r.verdict as { instruction: string }).instruction).toBe('停止读取，直接 write 创建 package.json')
    }
  })

  it('解析 codefix（含 targetFiles）', () => {
    const r = parseObserverVerdict('{"kind":"codefix","instruction":"修复导入","targetFiles":["src/main.js","src/App.vue"]}')
    expect(r.ok).toBe(true)
    if (r.ok && r.verdict.kind === 'codefix') {
      expect(r.verdict.targetFiles).toEqual(['src/main.js', 'src/App.vue'])
    }
  })

  it('无 JSON 块返回 error', () => {
    const r = parseObserverVerdict('没有 JSON')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('未找到 JSON')
  })

  it('JSON 语法错误返回 error', () => {
    const r = parseObserverVerdict('{"kind":}')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('JSON 解析失败')
  })

  it('instruction 为空返回 error', () => {
    const r = parseObserverVerdict('{"kind":"strategy","instruction":"  "}')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('instruction 为空')
  })

  it('codefix 缺 targetFiles 返回 error', () => {
    const r = parseObserverVerdict('{"kind":"codefix","instruction":"修复"}')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('targetFiles')
  })

  it('codefix targetFiles 过滤空字符串', () => {
    const r = parseObserverVerdict('{"kind":"codefix","instruction":"修复","targetFiles":["a.js","","  "]}')
    expect(r.ok).toBe(true)
    if (r.ok && r.verdict.kind === 'codefix') {
      expect(r.verdict.targetFiles).toEqual(['a.js'])
    }
  })

  it('未知 kind 返回 error', () => {
    const r = parseObserverVerdict('{"kind":"other","instruction":"x"}')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('未知 kind')
  })
})
