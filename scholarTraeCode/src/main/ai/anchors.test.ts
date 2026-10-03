// anchors 模块单测：
// 纯函数层覆盖 路径命中三规则 / 符号删除检测 / 提示词格式化；
// IO 层用临时目录覆盖 缺失文件/坏 JSON 降级、写后读回环。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  matchProtectedPath,
  removedProtectedSymbols,
  formatAnchorBlock,
  formatAnchorSummary,
  loadAnchors,
  saveAnchors,
  type AnchorsFile
} from './anchors'

describe('matchProtectedPath', () => {
  const anchors: AnchorsFile = {
    protectedPaths: ['src/core/engine.ts', 'config/', 'README.md']
  }

  it('完全相等命中', () => {
    expect(matchProtectedPath(anchors, 'src/core/engine.ts')).toBe('src/core/engine.ts')
  })

  it('后缀段命中（计划写短路径也拦得住）', () => {
    expect(matchProtectedPath(anchors, 'core/engine.ts')).toBe('src/core/engine.ts')
    expect(matchProtectedPath(anchors, 'engine.ts')).toBe('src/core/engine.ts')
  })

  it('目录前缀命中', () => {
    expect(matchProtectedPath(anchors, 'config/app.json')).toBe('config/')
    expect(matchProtectedPath(anchors, 'config/deep/x.yaml')).toBe('config/')
  })

  it('未命中返回 null；大小写与反斜杠不敏感', () => {
    expect(matchProtectedPath(anchors, 'src/other.ts')).toBeNull()
    expect(matchProtectedPath(anchors, 'SRC\\CORE\\ENGINE.TS')).toBe('src/core/engine.ts')
    expect(matchProtectedPath({}, 'a.ts')).toBeNull()
  })
})

describe('removedProtectedSymbols', () => {
  const oldContent = 'export function keepMe() {}\nexport function gone() {}\n'
  const newContent = 'export function keepMe() {}\n'

  it('path 缺省时任意文件的同名符号受保护', () => {
    const anchors: AnchorsFile = { protectedSymbols: [{ name: 'gone' }] }
    expect(removedProtectedSymbols(anchors, 'src/a.ts', oldContent, newContent)).toEqual(['gone'])
  })

  it('path 限定时只在该文件命中', () => {
    const anchors: AnchorsFile = { protectedSymbols: [{ name: 'gone', path: 'src/a.ts' }] }
    expect(removedProtectedSymbols(anchors, 'src/a.ts', oldContent, newContent)).toEqual(['gone'])
    expect(removedProtectedSymbols(anchors, 'src/b.ts', oldContent, newContent)).toEqual([])
  })

  it('符号未删除/无保护清单返回空', () => {
    const anchors: AnchorsFile = { protectedSymbols: [{ name: 'gone' }] }
    expect(removedProtectedSymbols(anchors, 'src/a.ts', oldContent, oldContent)).toEqual([])
    expect(removedProtectedSymbols({}, 'src/a.ts', oldContent, newContent)).toEqual([])
  })

  it('未受保护的符号删除不命中', () => {
    const anchors: AnchorsFile = { protectedSymbols: [{ name: 'other' }] }
    expect(removedProtectedSymbols(anchors, 'src/a.ts', oldContent, newContent)).toEqual([])
  })
})

describe('formatAnchorBlock / formatAnchorSummary', () => {
  it('空锚点返回空串/提示未配置', () => {
    expect(formatAnchorBlock({})).toBe('')
    expect(formatAnchorSummary({}, () => true)).toContain('未配置 spec 锚点')
  })

  it('清单 + 备注 + 行为约束', () => {
    const anchors: AnchorsFile = {
      protectedPaths: ['src/core/'],
      protectedSymbols: [{ name: 'engine', path: 'src/core/engine.ts' }],
      notes: '核心模块冻结'
    }
    const text = formatAnchorBlock(anchors)
    expect(text).toContain('禁改路径')
    expect(text).toContain('- src/core/')
    expect(text).toContain('- engine（src/core/engine.ts）')
    expect(text).toContain('备注：核心模块冻结')
    expect(text).toContain('被阻断')
  })

  it('摘要包含存在性检查', () => {
    const anchors: AnchorsFile = { protectedPaths: ['src/core/'] }
    const text = formatAnchorSummary(anchors, (p) => p !== 'src/core/')
    expect(text).toContain('⚠ 磁盘上不存在')
  })
})

describe('loadAnchors / saveAnchors IO', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'anchors-test-'))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('文件缺失返回空锚点', async () => {
    expect(await loadAnchors(dir)).toEqual({})
  })

  it('坏 JSON 安全降级为空锚点', async () => {
    await fs.mkdir(join(dir, '.trae'), { recursive: true })
    await fs.writeFile(join(dir, '.trae', 'anchors.json'), '{oops', 'utf-8')
    expect(await loadAnchors(dir)).toEqual({})
  })

  it('写后读回环；非法字段被清洗', async () => {
    await saveAnchors(dir, {
      protectedPaths: ['a.ts'],
      protectedSymbols: [{ name: 'foo', path: 'a.ts' }],
      notes: 'n'
    })
    expect(await loadAnchors(dir)).toEqual({
      protectedPaths: ['a.ts'],
      protectedSymbols: [{ name: 'foo', path: 'a.ts' }],
      notes: 'n'
    })
    // 混进坏条目也被过滤
    await fs.writeFile(
      join(dir, '.trae', 'anchors.json'),
      JSON.stringify({ protectedPaths: ['ok', 1, null], protectedSymbols: [{ name: 'x' }, { bad: 1 }] }),
      'utf-8'
    )
    expect(await loadAnchors(dir)).toEqual({ protectedPaths: ['ok'], protectedSymbols: [{ name: 'x' }] })
  })
})
