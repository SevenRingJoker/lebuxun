// s54 make_chart 内置工具端到端：真实临时目录写 CSV → 调工具 → 校验落盘 SVG 与对话内联
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { callBuiltinTool, isBuiltinTool } from './builtinTools'

let root: string

beforeEach(async () => {
  root = join(tmpdir(), `scholar-chart-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  await fsp.mkdir(join(root, 'results'), { recursive: true })
})

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true })
})

describe('s54 make_chart 工具', () => {
  it('工具已注册', () => {
    expect(isBuiltinTool('make_chart')).toBe(true)
  })

  it('CSV → 折线图：落盘 .trae/charts 且对话内联 data URL', async () => {
    await fsp.writeFile(
      join(root, 'results', 'acc.csv'),
      'epoch,acc,loss\n1,0.6,0.9\n2,0.75,0.5\n3,0.88,0.2\n',
      'utf-8'
    )
    const out = await callBuiltinTool('make_chart', {
      dataFile: 'results/acc.csv',
      type: 'line',
      title: '训练曲线',
      x: 'epoch',
      y: ['acc', 'loss']
    }, root)

    expect(out).toContain('图表「训练曲线」已生成')
    expect(out).toContain('.trae/charts/')
    expect(out).toContain('![训练曲线](data:image/svg+xml')

    // 落盘文件真实存在且为 SVG
    const files = await fsp.readdir(join(root, '.trae', 'charts'))
    expect(files).toHaveLength(1)
    const svg = await fsp.readFile(join(root, '.trae', 'charts', files[0]), 'utf-8')
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('训练曲线')
    expect(svg).toContain('<polyline')
  })

  it('柱状图（单系列，Y 轴从 0 基线起）', async () => {
    await fsp.writeFile(join(root, 'm.csv'), 'model,score\nA,10\nB,20\n', 'utf-8')
    const out = await callBuiltinTool('make_chart', {
      dataFile: 'm.csv', type: 'bar', title: '模型对比', x: 'model', y: ['score']
    }, root)
    expect(out).toContain('已生成')
    // data URL 中 < 被编码为 %3C
    expect(out).toContain('%3Crect')

    // 落盘 SVG：两个柱子高度都应 > 0（基线从 0 起，10 的柱子不再塌缩）
    const files = await fsp.readdir(join(root, '.trae', 'charts'))
    const svg = await fsp.readFile(join(root, '.trae', 'charts', files[0]), 'utf-8')
    const heights = [...svg.matchAll(/<rect[^>]*height="(\d+(?:\.\d+)?)"/g)]
      .map((m) => Number(m[1]))
      .filter((h) => h > 0)
    // 背景 rect 高度=460 排除后，应有两根数据柱
    const bars = heights.filter((h) => h < 400)
    expect(bars).toHaveLength(2)
  })

  it('缺少必填参数返回错误提示', async () => {
    const out = await callBuiltinTool('make_chart', { dataFile: 'a.csv' }, root)
    expect(out).toContain('错误')
    expect(out).toContain('缺少必填参数')
  })

  it('Y 列不存在时提示核对列名', async () => {
    await fsp.writeFile(join(root, 'a.csv'), 'x,y\n1,2\n', 'utf-8')
    const out = await callBuiltinTool('make_chart', {
      dataFile: 'a.csv', type: 'line', title: 't', x: 'x', y: ['nope']
    }, root)
    expect(out).toContain('列不存在')
    expect(out).toContain('确认 x/y 列名')
  })

  it('路径越界被拒绝', async () => {
    const out = await callBuiltinTool('make_chart', {
      dataFile: '../../etc/passwd', type: 'line', title: 't', x: 'x', y: ['y']
    }, root)
    expect(out).toContain('越出工作区')
  })
})
