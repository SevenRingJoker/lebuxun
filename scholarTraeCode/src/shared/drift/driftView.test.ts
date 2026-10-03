// 偏差视图纯函数单测：分组 / 计数 / 文本块剥离。
import { describe, it, expect } from 'vitest'
import {
  groupDriftItems,
  driftCounts,
  stripDriftSection,
  extractDriftFilePath,
  type UiDriftReport,
  type UiDriftItem
} from './driftView'

/** 构造明细项 */
function item(kind: UiDriftItem['kind'], detail: string): UiDriftItem {
  return { kind, severity: kind === 'missingArtifact' ? 'block' : 'warn', detail }
}

function report(items: UiDriftItem[]): UiDriftReport {
  return {
    items,
    hasBlock: items.some((i) => i.severity === 'block'),
    hasWarn: items.some((i) => i.severity === 'warn')
  }
}

describe('groupDriftItems 分组', () => {
  it('三类各归其组并保持顺序', () => {
    const g = groupDriftItems(
      report([
        item('missingArtifact', 'a.js'),
        item('unfinishedTodo', '#1 步骤'),
        item('unexpectedFile', 'x.log'),
        item('missingArtifact', 'b.js')
      ])
    )
    expect(g.missing.map((i) => i.detail)).toEqual(['a.js', 'b.js'])
    expect(g.unfinished.map((i) => i.detail)).toEqual(['#1 步骤'])
    expect(g.unexpected.map((i) => i.detail)).toEqual(['x.log'])
  })

  it('空报告 → 三组皆空', () => {
    const g = groupDriftItems(report([]))
    expect(g.missing).toHaveLength(0)
    expect(g.unfinished).toHaveLength(0)
    expect(g.unexpected).toHaveLength(0)
  })

  it('未知 kind 被忽略不抛异常', () => {
    const g = groupDriftItems({ items: [{ kind: 'future' as any, severity: 'warn', detail: 'x' }] } as UiDriftReport)
    expect(g.missing).toHaveLength(0)
    expect(g.unexpected).toHaveLength(0)
  })
})

describe('driftCounts 计数', () => {
  it('阻断只数 missingArtifact，其余归警告', () => {
    const c = driftCounts(
      report([
        item('missingArtifact', 'a'),
        item('missingArtifact', 'b'),
        item('unfinishedTodo', 'c'),
        item('unexpectedFile', 'd')
      ])
    )
    expect(c).toEqual({ block: 2, warn: 2 })
  })

  it('仅警告时 block=0', () => {
    expect(driftCounts(report([item('unfinishedTodo', 'x')]))).toEqual({ block: 0, warn: 1 })
  })

  it('空报告 → 0/0', () => {
    expect(driftCounts(report([]))).toEqual({ block: 0, warn: 0 })
  })
})

describe('stripDriftSection 文本剥离', () => {
  it('命中：返回标记之前正文，偏差块删除', () => {
    const md = '任务已完成。' + '\n\n⚠️ 计划-执行偏差检测：\n【计划偏差 · 未完成步骤 1 项】\n- #1 x'
    const out = stripDriftSection(md)
    expect(out).toBe('任务已完成。')
    expect(out).not.toContain('偏差')
  })

  it('无标记：原样返回', () => {
    const md = '普通回答，没有偏差块。'
    expect(stripDriftSection(md)).toBe(md)
  })

  it('偏差块之前的 npm 警告必须保留', () => {
    const md =
      '任务已完成。\n\n⚠️ 项目未验证：未执行 npm install，无法确认项目可运行。' +
      '\n\n⚠️ 计划-执行偏差检测：\n【计划偏差 · 未完成步骤 1 项】\n- #1 x'
    const out = stripDriftSection(md)
    expect(out).toContain('项目未验证')
    expect(out).not.toContain('计划-执行偏差检测')
  })

  it('单独出现「计划-执行偏差检测」但无起始空行前缀时不剥离（防御子串误匹配）', () => {
    const md = '正文中提到计划-执行偏差检测这个词。'
    expect(stripDriftSection(md)).toBe(md)
  })

  it('剥离后清理正文尾部多余空白', () => {
    const md = '正文。\n   \n\n⚠️ 计划-执行偏差检测：\nx'
    expect(stripDriftSection(md)).toBe('正文。')
  })
})

describe('extractDriftFilePath 路径提取', () => {
  it('missingArtifact：剥离中文括号说明，保留路径', () => {
    expect(extractDriftFilePath(item('missingArtifact', 'src/main.js（计划声明的产物）'))).toBe('src/main.js')
  })

  it('unexpectedFile：裸路径去空白', () => {
    expect(extractDriftFilePath(item('unexpectedFile', '  src/tmp.log '))).toBe('src/tmp.log')
  })

  it('unfinishedTodo → null（#id 加中文括号是步骤描述不是路径）', () => {
    expect(extractDriftFilePath(item('unfinishedTodo', '#2（未开始）补充单测'))).toBeNull()
  })

  it('明细含换行 → null', () => {
    expect(extractDriftFilePath(item('unexpectedFile', 'a.js\nx'))).toBeNull()
  })

  it('剥离括号后为空 → null', () => {
    expect(extractDriftFilePath(item('missingArtifact', '（说明）'))).toBeNull()
  })
})
