// stagingClassify 三档分类规则单测（纯函数层）：
// 覆盖 risky 三触发（锚点/删除/高引用）、direct（计划点名）、incidental（兜底），
// 以及优先级（risky 先于 direct）、路径归一、空计划边界。
import { describe, it, expect } from 'vitest'
import { classifyChanges, planMentions, REF_RISK_THRESHOLD } from './stagingClassify'
import type { AnchorsFile } from './anchors'

const NO_ANCHORS: AnchorsFile = {}

describe('planMentions', () => {
  it('末 1/2/3 段任一命中计划文本', () => {
    const plan = '修改 src/App.vue 与组件 HelloWorld.vue，新增 utils/helper.ts'
    expect(planMentions(plan, 'src/App.vue')).toBe(true)
    expect(planMentions(plan, 'src/components/HelloWorld.vue')).toBe(true) // basename 命中
    expect(planMentions(plan, 'src/utils/helper.ts')).toBe(true) // 末 2 段命中
    expect(planMentions(plan, 'src/other.ts')).toBe(false)
  })

  it('空计划不命中；大小写与反斜杠不敏感', () => {
    expect(planMentions('', 'a.ts')).toBe(false)
    expect(planMentions('改 APP.VUE', 'src\\app.vue')).toBe(true)
  })
})

describe('classifyChanges', () => {
  it('锚点命中 → risky（优先于一切）', () => {
    const anchors: AnchorsFile = { protectedPaths: ['src/core/'] }
    const out = classifyChanges(
      [{ path: 'src/core/engine.ts', kind: 'modify' }],
      anchors,
      {},
      '计划点名 src/core/engine.ts'
    )
    expect(out['src/core/engine.ts'].cls).toBe('risky')
    expect(out['src/core/engine.ts'].reason).toContain('锚点')
  })

  it('删除文件 → risky', () => {
    const out = classifyChanges([{ path: 'src/old.ts', kind: 'delete' }], NO_ANCHORS, {}, '')
    expect(out['src/old.ts'].cls).toBe('risky')
    expect(out['src/old.ts'].reason).toContain('删除')
  })

  it('被引用数达阈值 → risky', () => {
    const out = classifyChanges(
      [{ path: 'src/shared/types.ts', kind: 'modify' }],
      NO_ANCHORS,
      { 'src/shared/types.ts': REF_RISK_THRESHOLD },
      ''
    )
    expect(out['src/shared/types.ts'].cls).toBe('risky')
    expect(out['src/shared/types.ts'].reason).toContain(`${REF_RISK_THRESHOLD} 处`)
  })

  it('计划点名 → direct', () => {
    const out = classifyChanges(
      [
        { path: 'src/App.vue', kind: 'modify' },
        { path: 'src/new.ts', kind: 'create' }
      ],
      NO_ANCHORS,
      {},
      '修改 App.vue 布局'
    )
    expect(out['src/App.vue'].cls).toBe('direct')
    expect(out['src/new.ts'].cls).toBe('incidental')
  })

  it('兜底 → incidental', () => {
    const out = classifyChanges([{ path: 'src/misc/util.ts', kind: 'modify' }], NO_ANCHORS, {}, '')
    expect(out['src/misc/util.ts'].cls).toBe('incidental')
    expect(out['src/misc/util.ts'].reason).toContain('顺带')
  })

  it('引用计数支持反斜杠原始路径键查找', () => {
    // 暂存路径可能带反斜杠，refCounts 用归一化键；分类时应能命中
    const out = classifyChanges(
      [{ path: 'src\\shared\\types.ts', kind: 'modify' }],
      NO_ANCHORS,
      { 'src/shared/types.ts': 99 },
      ''
    )
    expect(out['src\\shared\\types.ts'].cls).toBe('risky')
  })
})
