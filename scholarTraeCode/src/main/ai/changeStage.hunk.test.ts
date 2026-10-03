// changeStage.hunk 纯函数层单测（s24）：diff 拆分、上下文分组、unified 解析回环、
// 选中 hunk 重放、重叠/基线漂移冲突，以及 CRLF/中文/末行换行边角。
import { describe, it, expect } from 'vitest'
import {
  splitHunks,
  parseUnifiedDiff,
  formatUnifiedDiff,
  applyHunksToBase,
  hunksOverlap,
  type Hunk
} from './changeStage.hunk'

/** 生成 1..n 行文本（默认带末尾换行） */
function lines(n: number): string {
  return Array.from({ length: n }, (_, i) => `L${i + 1}`).join('\n') + '\n'
}

describe('splitHunks 拆分与分组', () => {
  it('远距离两处改动 → 两个 hunk，含 3 行上下文与正确坐标', () => {
    const base = lines(12)
    const current = base.replace('L2\n', 'L2X\n').replace('L10\n', 'L10X\n')
    const hunks = splitHunks(base, current)
    expect(hunks).toHaveLength(2)

    // h1：前文不足 3 行只取 L1；改 L2；后取 L3..L5
    expect(hunks[0].oldStart).toBe(1)
    expect(hunks[0].oldLines).toBe(5)
    expect(hunks[0].newStart).toBe(1)
    expect(hunks[0].newLines).toBe(5)
    expect(hunks[0].lines.map((l) => l.kind).join('')).toBe('ctxdeladdctxctxctx')

    // h2：前取 L7..L9；改 L10；后取 L11,L12
    expect(hunks[1].oldStart).toBe(7)
    expect(hunks[1].oldLines).toBe(6)
    expect(hunks[1].newLines).toBe(6)
    expect(hunks[1].id).toBe('h2')
  })

  it('相邻改动合并为同一 hunk', () => {
    const base = lines(10)
    const current = base.replace('L2\n', 'L2X\n').replace('L3\n', 'L3X\n')
    const hunks = splitHunks(base, current)
    expect(hunks).toHaveLength(1)
    expect(hunks[0].lines.filter((l) => l.kind === 'del')).toHaveLength(2)
    expect(hunks[0].lines.filter((l) => l.kind === 'add')).toHaveLength(2)
  })

  it('无差异 → 空数组', () => {
    expect(splitHunks('a\nb\n', 'a\nb\n')).toEqual([])
  })

  it('空文件创建：oldStart=0 / oldLines=0，新行计数正确', () => {
    const hunks = splitHunks('', 'a\nb\nc\n')
    expect(hunks).toHaveLength(1)
    expect(hunks[0].oldStart).toBe(0)
    expect(hunks[0].oldLines).toBe(0)
    expect(hunks[0].newStart).toBe(1)
    expect(hunks[0].newLines).toBe(3)
    expect(hunks[0].lines.every((l) => l.kind === 'add')).toBe(true)
  })

  it('整文件删除：纯 del hunk', () => {
    const hunks = splitHunks('x\ny\n', '')
    expect(hunks).toHaveLength(1)
    expect(hunks[0].oldLines).toBe(2)
    expect(hunks[0].newLines).toBe(0)
  })
})

describe('parseUnifiedDiff / formatUnifiedDiff', () => {
  it('format → parse 回环一致', () => {
    const base = lines(12)
    const current = base.replace('L2\n', 'L2X\n').replace('L10\n', 'L10X\n')
    const hunks = splitHunks(base, current)
    const patch = formatUnifiedDiff(hunks, 'a/x.txt', 'b/x.txt')
    expect(patch.startsWith('--- a/x.txt\n+++ b/x.txt\n@@')).toBe(true)
    const reparsed = parseUnifiedDiff(patch)
    expect(reparsed).toHaveLength(2)
    expect(reparsed[0]).toEqual(hunks[0])
    expect(reparsed[1]).toEqual(hunks[1])
  })

  it('解析独立 patch：跳过文件头，识别 hunk 坐标与行类型', () => {
    const patch = [
      'diff --git a/f b/f',
      'index 111..222 100644',
      '--- a/f',
      '+++ b/f',
      '@@ -1,2 +1,2 @@',
      ' keep',
      '-old',
      '+new',
      ''
    ].join('\n')
    const hunks = parseUnifiedDiff(patch)
    expect(hunks).toHaveLength(1)
    expect(hunks[0].oldStart).toBe(1)
    expect(hunks[0].lines.map((l) => `${l.kind}:${l.text}`)).toEqual([
      'ctx:keep',
      'del:old',
      'add:new'
    ])
  })
})

describe('applyHunksToBase 选中重放', () => {
  const base = lines(12)
  const current = base.replace('L2\n', 'L2X\n').replace('L10\n', 'L10X\n')
  const hunks = splitHunks(base, current)

  it('只选第二个 hunk：仅 L10 改变', () => {
    const r = applyHunksToBase(base, hunks, ['h2'])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.content).toBe(base.replace('L10\n', 'L10X\n'))
    expect(r.content).not.toContain('L2X')
  })

  it('选中全部 hunk = 当前内容', () => {
    const r = applyHunksToBase(base, hunks, ['h1', 'h2'])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.content).toBe(current)
  })

  it('不选任何 hunk = 基线原样', () => {
    const r = applyHunksToBase(base, hunks, [])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.content).toBe(base)
  })

  it('空文件创建重放', () => {
    const hs = splitHunks('', 'a\nb\nc\n')
    const r = applyHunksToBase('', hs, ['h1'])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.content).toBe('a\nb\nc\n')
  })

  it('整文件删除重放为空串', () => {
    const hs = splitHunks('x\ny\n', '')
    const r = applyHunksToBase('x\ny\n', hs, ['h1'])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.content).toBe('')
  })

  it('未知 id → code=id', () => {
    const r = applyHunksToBase(base, hunks, ['h9'])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('id')
  })

  it('基线漂移（上下文不匹配）→ code=context', () => {
    const drifted = base.replace('L1\n', 'L1-CHANGED\n')
    const r = applyHunksToBase(drifted, hunks, ['h1'])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('context')
  })

  it('选中区间重叠 → code=overlap', () => {
    const a: Hunk = {
      id: 'x',
      oldStart: 2,
      oldLines: 3,
      newStart: 2,
      newLines: 3,
      lines: []
    }
    const b: Hunk = {
      id: 'y',
      oldStart: 4,
      oldLines: 2,
      newStart: 4,
      newLines: 2,
      lines: []
    }
    expect(hunksOverlap(a, b)).toBe(true)
    const r = applyHunksToBase(base, [a, b], ['x', 'y'])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('overlap')
  })

  it('不重叠的相邻区间通过', () => {
    const a: Hunk = {
      id: 'x',
      oldStart: 2,
      oldLines: 2,
      newStart: 2,
      newLines: 2,
      lines: []
    }
    const b: Hunk = {
      id: 'y',
      oldStart: 4,
      oldLines: 2,
      newStart: 4,
      newLines: 2,
      lines: []
    }
    expect(hunksOverlap(a, b)).toBe(false)
  })
})

describe('行风格边角', () => {
  it('CRLF 基线输出保持 CRLF', () => {
    const base = 'a\r\nb\r\nc\r\n'
    const current = 'a\r\nB\r\nc\r\n'
    const hunks = splitHunks(base, current)
    const r = applyHunksToBase(base, hunks, ['h1'])
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.content).toBe(current)
      expect(r.content).toContain('\r\n')
      expect(r.content).not.toMatch(/[^\r]\n/)
    }
  })

  it('中文行内容正确增删', () => {
    const base = '第一行\n第二行\n第三行\n'
    const current = '第一行\n第二行改\n第三行\n'
    const hunks = splitHunks(base, current)
    expect(hunks[0].lines.some((l) => l.text === '第二行')).toBe(true)
    const r = applyHunksToBase(base, hunks, ['h1'])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.content).toBe(current)
  })

  it('末尾无换行保持无换行', () => {
    const base = 'a\nb'
    const current = 'a\nB'
    const hunks = splitHunks(base, current)
    const r = applyHunksToBase(base, hunks, ['h1'])
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.content).toBe('a\nB')
      expect(r.content.endsWith('\n')).toBe(false)
    }
  })

  it('末尾有换行保持有换行', () => {
    const base = 'a\nb\n'
    const current = 'a\nB\n'
    const hunks = splitHunks(base, current)
    const r = applyHunksToBase(base, hunks, ['h1'])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.content.endsWith('\n')).toBe(true)
  })
})
