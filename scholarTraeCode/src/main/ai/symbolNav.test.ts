// symbolNav 纯函数层单测：
// 覆盖 定义收集/定义与引用分离/引用报告格式化/符号大纲/改动影响分析与格式化。
// findReferences 的 rg 调用不在此测（走 IPC 冒烟与集成验证），这里只测可注入部分。
import { describe, it, expect } from 'vitest'
import {
  collectSymbolDefs,
  splitDefsAndRefs,
  formatReferenceReport,
  symbolOutline,
  buildEditImpact,
  formatEditImpact,
  symbolPattern
} from './symbolNav'
import type { CodeIndex, IndexedFile } from './indexer'

/** 构造索引项的快捷工厂 */
function idxFile(relPath: string, symbols: Array<{ name: string; kind: any; line: number }>): IndexedFile {
  return {
    relPath,
    absPath: '/root/' + relPath,
    mtimeMs: 0,
    imports: [],
    symbols,
    preview: '',
    size: 0,
    lang: 'ts'
  }
}

function makeIndex(files: Record<string, IndexedFile>): CodeIndex {
  return { version: 1, root: '/root', updatedAt: '', files }
}

describe('collectSymbolDefs', () => {
  it('跨文件收集同名定义', () => {
    const index = makeIndex({
      'a.ts': idxFile('a.ts', [{ name: 'foo', kind: 'function', line: 3 }]),
      'b.ts': idxFile('b.ts', [
        { name: 'bar', kind: 'const', line: 1 },
        { name: 'foo', kind: 'function', line: 9 }
      ])
    })
    const defs = collectSymbolDefs(index, 'foo')
    expect(defs).toHaveLength(2)
    expect(defs.map((d) => `${d.path}:${d.line}`)).toEqual(['a.ts:3', 'b.ts:9'])
  })

  it('无索引或未知名返回空', () => {
    expect(collectSymbolDefs(null, 'foo')).toEqual([])
    expect(collectSymbolDefs(makeIndex({}), 'foo')).toEqual([])
    expect(collectSymbolDefs(makeIndex({ 'a.ts': idxFile('a.ts', []) }), '')).toEqual([])
  })
})

describe('splitDefsAndRefs', () => {
  it('与定义同文件同行的命中被剔除，其余计为引用', () => {
    const defs = [{ name: 'foo', kind: 'function', path: 'a.ts', line: 3 }]
    const matches = [
      { path: 'a.ts', lineNumber: 3, preview: 'export function foo() {}' }, // 定义本身
      { path: 'a.ts', lineNumber: 10, preview: 'foo()' }, // 本文件引用
      { path: 'src/b.ts', lineNumber: 5, preview: 'foo()' } // 跨文件引用
    ]
    const { refs } = splitDefsAndRefs(defs, matches)
    expect(refs).toHaveLength(2)
    expect(refs[0]).toMatchObject({ path: 'a.ts', line: 10 })
    expect(refs[1]).toMatchObject({ path: 'src/b.ts', line: 5 })
  })

  it('Windows 反斜杠路径被归一后也能比对定义键', () => {
    const defs = [{ name: 'foo', kind: 'function', path: 'src/a.ts', line: 3 }]
    const matches = [{ path: 'src\\a.ts', lineNumber: 3, preview: 'x' }]
    expect(splitDefsAndRefs(defs, matches).refs).toHaveLength(0)
  })
})

describe('formatReferenceReport', () => {
  it('定义与引用分块输出', () => {
    const text = formatReferenceReport(
      'foo',
      [{ name: 'foo', kind: 'function', path: 'a.ts', line: 3 }],
      [{ path: 'b.ts', line: 7, preview: 'foo()' }]
    )
    expect(text).toContain('定义（1 处）')
    expect(text).toContain('- a.ts:3（function）')
    expect(text).toContain('引用（1 处')
    expect(text).toContain('- b.ts:7: foo()')
  })

  it('无定义/无引用边界', () => {
    expect(formatReferenceReport('x', [], [])).toContain('未找到定义')
    expect(formatReferenceReport('x', [{ name: 'x', kind: 'const', path: 'a.ts', line: 1 }], [])).toContain(
      '未发现其他引用'
    )
  })

  it('引用超限时截断标注', () => {
    const refs = Array.from({ length: 35 }, (_, i) => ({ path: 'b.ts', line: i + 1, preview: 'foo()' }))
    const text = formatReferenceReport('foo', [], refs)
    expect(text).toContain('仅列前 30')
  })
})

describe('symbolOutline', () => {
  it('输出符号大纲', () => {
    const index = makeIndex({
      'a.ts': idxFile('a.ts', [
        { name: 'Foo', kind: 'class', line: 1 },
        { name: 'bar', kind: 'function', line: 5 }
      ])
    })
    const text = symbolOutline(index, 'a.ts')
    expect(text).toContain('符号大纲（2 个）')
    expect(text).toContain('L1 [class] Foo')
    expect(text).toContain('L5 [function] bar')
  })

  it('文件未入索引/无符号的提示', () => {
    const index = makeIndex({ 'a.ts': idxFile('a.ts', []) })
    expect(symbolOutline(index, 'missing.ts')).toContain('未在索引中找到文件')
    expect(symbolOutline(index, 'a.ts')).toContain('未抽取到符号定义')
  })
})

describe('symbolPattern', () => {
  it('词边界 + 元字符转义', () => {
    const re = new RegExp(symbolPattern('foo.bar'))
    expect(re.test('foo.bar()')).toBe(true)
    expect(re.test('xfoo.bar')).toBe(false)
    expect(re.test('fooXbar')).toBe(false)
  })
})

describe('buildEditImpact', () => {
  const oldContent = [
    'export function keepMe() { return 1 }',
    'export function gone() { return 2 }',
    'const local = 1'
  ].join('\n')
  const newContent = ['export function keepMe() { return 10 }', 'const local = 2'].join('\n')

  it('被删除且有引用的符号进入清单', async () => {
    const impacts = await buildEditImpact(oldContent, newContent, 'a.ts', async (name) =>
      name === 'gone' ? 3 : 0
    )
    expect(impacts).toEqual([{ symbol: 'gone', refCount: 3 }])
  })

  it('被删除但无引用的符号不提醒', async () => {
    const impacts = await buildEditImpact(oldContent, newContent, 'a.ts', async () => 0)
    expect(impacts).toEqual([])
  })

  it('Python 文件同样按 def/class 对比', async () => {
    const oldPy = 'def old_fn():\n    pass\n'
    const newPy = 'pass\n'
    const impacts = await buildEditImpact(oldPy, newPy, 'm.py', async () => 2)
    expect(impacts).toEqual([{ symbol: 'old_fn', refCount: 2 }])
  })
})

describe('formatEditImpact', () => {
  it('空清单返回空串', () => {
    expect(formatEditImpact([])).toBe('')
  })
  it('输出提醒文本', () => {
    const text = formatEditImpact([{ symbol: 'gone', refCount: 2 }])
    expect(text).toContain('改动影响提醒')
    expect(text).toContain('符号 gone 被删除，仍有 2 处引用')
  })
})
