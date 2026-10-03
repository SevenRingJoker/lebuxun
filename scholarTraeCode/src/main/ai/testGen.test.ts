// s46 测试骨架生成与受影响测试圈定 · 纯函数单测
import { describe, expect, it } from 'vitest'
import {
  isTestFile,
  testFileFor,
  sourceFileFor,
  buildTestSkeleton,
  resolveImport,
  affectedTests
} from './testGen'
import type { CodeIndex } from './indexer'

/** 构造最小索引（只保留本模块用到的字段） */
function mkIndex(files: Record<string, { imports?: string[] }>): CodeIndex {
  const out: any = { version: 1, root: '/r', updatedAt: '', files: {} }
  for (const [rel, f] of Object.entries(files)) {
    out.files[rel] = { relPath: rel, absPath: '/r/' + rel, mtimeMs: 0, imports: f.imports ?? [], symbols: [], preview: '', size: 0, lang: 'ts' }
  }
  return out
}

describe('路径换算', () => {
  it('isTestFile', () => {
    expect(isTestFile('src/foo.test.ts')).toBe(true)
    expect(isTestFile('src/foo.spec.ts')).toBe(true)
    expect(isTestFile('src/__tests__/foo.ts')).toBe(true)
    expect(isTestFile('src/foo.ts')).toBe(false)
  })

  it('testFileFor / sourceFileFor 互逆', () => {
    expect(testFileFor('src/foo.ts')).toBe('src/foo.test.ts')
    expect(sourceFileFor('src/foo.test.ts')).toBe('src/foo.ts')
    expect(sourceFileFor('a/b/c.spec.tsx')).toBe('a/b/c.tsx')
  })
})

describe('buildTestSkeleton', () => {
  it('只为函数生成 describe+it.todo', () => {
    const skel = buildTestSkeleton('src/util.ts', [
      { name: 'add', kind: 'function', line: 1 },
      { name: 'sub', kind: 'function', line: 5 },
      { name: 'Config', kind: 'interface', line: 9 }
    ])!
    expect(skel).toContain("import { add, sub } from './util'")
    expect(skel).toContain("describe('add'")
    expect(skel).toContain("it.todo('基本行为')")
    expect(skel).not.toContain('Config')
    expect(skel).toContain("from 'vitest'")
  })

  it('同名符号去重；无可测符号返回 null', () => {
    const skel = buildTestSkeleton('src/a.ts', [
      { name: 'f', kind: 'function', line: 1 },
      { name: 'f', kind: 'function', line: 9 }
    ])!
    expect(skel.match(/describe\('f'/g)!.length).toBe(1)
    expect(buildTestSkeleton('src/t.ts', [{ name: 'T', kind: 'type', line: 1 }])).toBeNull()
  })
})

describe('resolveImport', () => {
  const idx = mkIndex({
    'src/core/engine.ts': {},
    'src/a.ts': { imports: ['./core/engine'] },
    'src/deep/b.ts': { imports: ['../core/engine', './sib'] },
    'src/deep/sib.ts': {}
  })

  it('相对说明符解析到索引键', () => {
    expect(resolveImport(idx, 'src/a.ts', './core/engine')).toBe('src/core/engine.ts')
    expect(resolveImport(idx, 'src/deep/b.ts', '../core/engine')).toBe('src/core/engine.ts')
    expect(resolveImport(idx, 'src/deep/b.ts', './sib')).toBe('src/deep/sib.ts')
  })

  it('裸包说明符与未收录文件返回 null', () => {
    expect(resolveImport(idx, 'src/a.ts', 'vue')).toBeNull()
    expect(resolveImport(idx, 'src/a.ts', './missing')).toBeNull()
  })
})

describe('affectedTests 受影响圈定', () => {
  const idx = mkIndex({
    'src/math.ts': {},
    'src/math.test.ts': { imports: ['./math'] },
    'src/service.ts': { imports: ['./math'] },
    'src/service.test.ts': { imports: ['./service'] },
    'src/ui.vue': { imports: ['./service'] },
    'src/alone.ts': {}
  })

  it('源码变更 → 自身测试 + 一跳引用者的测试', () => {
    const r = affectedTests(idx, ['src/math.ts'])
    expect(r).toEqual(['src/math.test.ts', 'src/service.test.ts'])
  })

  it('测试文件变更 → 自身 + 视同源码变更', () => {
    const r = affectedTests(idx, ['src/math.test.ts'])
    expect(r).toContain('src/math.test.ts')
    expect(r).toContain('src/service.test.ts')
  })

  it('无引用且无同名测试 → 空', () => {
    expect(affectedTests(idx, ['src/alone.ts'])).toEqual([])
  })

  it('多文件变更去重排序', () => {
    const r = affectedTests(idx, ['src/service.ts', 'src/math.ts'])
    expect(r).toEqual([...new Set(r)].sort())
    expect(r).toContain('src/service.test.ts')
  })
})
