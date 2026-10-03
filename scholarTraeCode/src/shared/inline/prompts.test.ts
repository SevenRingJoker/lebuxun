// inline/prompts 单测：改写/FIM 提示词构建 + 响应解析（含围栏剥离/截断）
import { describe, it, expect } from 'vitest'
import {
  buildRewritePrompt,
  buildFimPrompt,
  extractRewrittenCode,
  extractCompletion,
  INLINE_LIMITS
} from './prompts'

describe('buildRewritePrompt', () => {
  it('基本：系统约束 + 用户消息含 selection 与 instruction', () => {
    const msgs = buildRewritePrompt('const a = 1', '加注释', 'typescript')
    expect(msgs).toHaveLength(2)
    expect(msgs[0].role).toBe('system')
    expect(msgs[0].content).toContain('代码改写助手')
    expect(msgs[0].content).toContain('typescript')
    expect(msgs[0].content).toContain('禁止')
    expect(msgs[1].role).toBe('user')
    expect(msgs[1].content).toContain('const a = 1')
    expect(msgs[1].content).toContain('加注释')
    expect(msgs[1].content).toContain('需改写的选中代码')
  })

  it('带前后文：分段呈现', () => {
    const msgs = buildRewritePrompt(
      'foo()',
      '重命名',
      'javascript',
      'function bar() {',
      '} bar();'
    )
    expect(msgs[1].content).toContain('[前文上下文]')
    expect(msgs[1].content).toContain('function bar() {')
    expect(msgs[1].content).toContain('[后文上下文]')
    expect(msgs[1].content).toContain('} bar();')
  })

  it('selection 超长截断', () => {
    const longSel = 'x'.repeat(INLINE_LIMITS.MAX_SELECTION + 200)
    const msgs = buildRewritePrompt(longSel, 'noop', 'ts')
    expect(msgs[1].content).toContain('…截断…')
    // 截断后总长不应超过 MAX_SELECTION + 标记
    expect(msgs[1].content.length).toBeLessThan(longSel.length)
  })

  it('instruction 空白被 trim', () => {
    const msgs = buildRewritePrompt('a', '   改名   ', 'ts')
    expect(msgs[1].content).toContain('改名')
    expect(msgs[1].content).not.toContain('   ')
  })

  it('语言为空时仍能生成（兜底 plain）', () => {
    const msgs = buildRewritePrompt('a', 'b', '')
    expect(msgs[0].content).toMatch(/改写助手/)
    expect(msgs).toHaveLength(2)
  })
})

describe('buildFimPrompt', () => {
  it('基本：系统约束 + 前文/后文/插入提示', () => {
    const msgs = buildFimPrompt('const a = 1\n', '\nconst b = 2', 'typescript')
    expect(msgs).toHaveLength(2)
    expect(msgs[0].role).toBe('system')
    expect(msgs[0].content).toContain('补全助手')
    expect(msgs[0].content).toContain('typescript')
    expect(msgs[0].content).toContain('禁止')
    expect(msgs[1].content).toContain('[前文]')
    expect(msgs[1].content).toContain('const a = 1')
    expect(msgs[1].content).toContain('[后文]')
    expect(msgs[1].content).toContain('const b = 2')
    expect(msgs[1].content).toContain('应插入的代码')
  })

  it('prefix 超长截断', () => {
    const long = 'a'.repeat(INLINE_LIMITS.MAX_PREFIX + 100)
    const msgs = buildFimPrompt(long, '', 'ts')
    expect(msgs[1].content).toContain('…截断…')
  })

  it('suffix 超长截断', () => {
    const long = 'b'.repeat(INLINE_LIMITS.MAX_SUFFIX + 100)
    const msgs = buildFimPrompt('', long, 'ts')
    expect(msgs[1].content).toContain('…截断…')
  })

  it('空 prefix/suffix 仍可生成', () => {
    const msgs = buildFimPrompt('', '', 'ts')
    expect(msgs[1].content).toContain('[前文]\n\n')
    expect(msgs[1].content).toContain('[后文]\n\n')
  })
})

describe('extractRewrittenCode', () => {
  it('直接代码（无围栏）', () => {
    expect(extractRewrittenCode('const a = 1\n')).toBe('const a = 1')
  })

  it('标准围栏代码块（带语言标注）', () => {
    const raw = '```typescript\nconst a = 1\n```'
    expect(extractRewrittenCode(raw)).toBe('const a = 1')
  })

  it('围栏无语言标注', () => {
    const raw = '```\nconst b = 2\n```'
    expect(extractRewrittenCode(raw)).toBe('const b = 2')
  })

  it('首个围栏被采用（多块时取首块）', () => {
    const raw = '```ts\nfoo\n```\n解释文字\n```ts\nbar\n```'
    expect(extractRewrittenCode(raw)).toBe('foo')
  })

  it('单边围栏（首尾 ```）剥离', () => {
    const raw = '```\nconst c = 3'
    expect(extractRewrittenCode(raw)).toBe('const c = 3')
  })

  it('尾部多余空白被 trim', () => {
    expect(extractRewrittenCode('a\n\n\n')).toBe('a')
  })

  it('空字符串返回空', () => {
    expect(extractRewrittenCode('')).toBe('')
  })
})

describe('extractCompletion', () => {
  it('短补全原样返回', () => {
    expect(extractCompletion('const b = 2')).toBe('const b = 2')
  })

  it('围栏剥离', () => {
    expect(extractCompletion('```\nfoo()\n```')).toBe('foo()')
  })

  it('超长截断到行边界', () => {
    const long = 'line1\nline2\nline3\n' + 'x'.repeat(INLINE_LIMITS.MAX_COMPLETION + 50)
    const out = extractCompletion(long)
    expect(out.length).toBeLessThanOrEqual(INLINE_LIMITS.MAX_COMPLETION)
    expect(out.endsWith('\n')).toBe(true) // 截到行尾保留换行
  })

  it('超长无换行时硬截断', () => {
    const long = 'x'.repeat(INLINE_LIMITS.MAX_COMPLETION + 50)
    const out = extractCompletion(long)
    expect(out.length).toBeLessThanOrEqual(INLINE_LIMITS.MAX_COMPLETION)
  })

  it('空响应返回空', () => {
    expect(extractCompletion('')).toBe('')
    expect(extractCompletion('```\n```')).toBe('')
  })
})
