// s54–s56 学术链路纯函数单测：CSV/JSON 解析、SVG 图表、BibTeX、报告生成
import { describe, it, expect } from 'vitest'
import {
  parseCsvText, csvToTable, jsonToTable, parseDataFile, parseCell, numericColumns,
  type DataTable
} from './csv'
import { renderSvgChart } from './svgChart'
import {
  parseBibtex, formatBibtex, extractCitations, formatReferenceLine, buildReferencesSection
} from './bibtex'
import {
  buildMarkdownReport, buildLatexReport, buildDocHtml, exportReport,
  DEFAULT_TEMPLATE, type ReportInput
} from './report'

describe('s54 CSV 解析', () => {
  it('parseCell 数字与文本识别', () => {
    expect(parseCell('3.14')).toBe(3.14)
    expect(parseCell('-2e3')).toBe(-2000)
    expect(parseCell('hello')).toBe('hello')
    expect(parseCell('')).toBeNull()
    expect(parseCell('NA')).toBeNull()
    expect(parseCell('007')).toBe('007') // 前导零编号不误判
  })

  it('基础逗号 CSV：表头+数值列自动识别', () => {
    const t = csvToTable('name,score,note\nAlice,95,good\nBob,88,\n')
    expect(t.columns).toEqual(['name', 'score', 'note'])
    expect(t.rows).toHaveLength(2)
    expect(t.rows[0].name).toBe('Alice')
    expect(t.rows[0].score).toBe(95)
    expect(t.rows[1].note).toBeNull()
    expect(numericColumns(t)).toEqual(['score'])
  })

  it('引号包裹逗号与转义双引号', () => {
    const recs = parseCsvText('a,b\n"x,y","he said ""hi"""')
    expect(recs[1]).toEqual(['x,y', 'he said "hi"'])
  })

  it('引号内换行', () => {
    const recs = parseCsvText('a,b\n"line1\nline2",z')
    expect(recs).toHaveLength(2)
    expect(recs[1][0]).toBe('line1\nline2')
  })

  it('分号分隔自动探测', () => {
    const t = csvToTable('x;y\n1;2\n')
    expect(t.columns).toEqual(['x', 'y'])
    expect(t.rows[0].x).toBe(1)
  })

  it('表头重名追加序号', () => {
    const t = csvToTable('v,v\n1,2\n')
    expect(t.columns).toEqual(['v', 'v_2'])
  })

  it('JSON 对象数组', () => {
    const t = jsonToTable('[{"a":1,"b":"x"},{"a":2,"b":"y"}]')
    expect(t.columns).toEqual(['a', 'b'])
    expect(t.rows[1].b).toBe('y')
  })

  it('JSON {columns, rows} 数组行', () => {
    const t = jsonToTable('{"columns":["x","y"],"rows":[[1,2],[3,4]]}')
    expect(t.rows[1]).toEqual({ x: 3, y: 4 })
  })

  it('parseDataFile 按扩展名分流', () => {
    expect(parseDataFile('a.tsv', 'x\ty\n1\t2\n').rows[0].x).toBe(1)
    expect(parseDataFile('a.json', '[{"x":1}]').rows[0].x).toBe(1)
    expect(parseDataFile('a.csv', 'x\n1\n').rows[0].x).toBe(1)
  })

  it('非法 JSON 抛错', () => {
    expect(() => jsonToTable('{"x":1}')).toThrow(/对象数组|columns/)
  })
})

describe('s54 SVG 图表', () => {
  const table: DataTable = {
    columns: ['epoch', 'acc', 'loss'],
    rows: [
      { epoch: 1, acc: 0.6, loss: 0.9 },
      { epoch: 2, acc: 0.75, loss: 0.5 },
      { epoch: 3, acc: 0.88, loss: 0.2 }
    ]
  }

  it('折线图输出合法 SVG 骨架与双系列配色', () => {
    const svg = renderSvgChart(table, { type: 'line', title: '训练曲线', x: 'epoch', y: ['acc', 'loss'] })
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('训练曲线')
    expect(svg).toContain('#0072B2') // acc 蓝色
    expect(svg).toContain('#D55E00') // loss 橙色
    expect(svg).toContain('<polyline')
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true)
  })

  it('柱状图含 rect', () => {
    const svg = renderSvgChart(table, { type: 'bar', title: '准确率', x: 'epoch', y: ['acc'] })
    expect(svg).toContain('<rect')
  })

  it('散点图含 circle', () => {
    const svg = renderSvgChart(table, { type: 'scatter', title: '散点', x: 'acc', y: ['loss'] })
    expect(svg).toContain('<circle')
  })

  it('分类 X 轴（柱状图字符串列）', () => {
    const cat: DataTable = {
      columns: ['model', 'score'],
      rows: [{ model: 'A', score: 10 }, { model: 'B', score: 20 }]
    }
    const svg = renderSvgChart(cat, { type: 'bar', title: '模型对比', x: 'model', y: ['score'] })
    expect(svg).toContain('模型对比')
    expect(svg).toContain('>A<')
  })

  it('不存在的列抛错', () => {
    expect(() => renderSvgChart(table, { type: 'line', title: 't', x: 'nope', y: ['acc'] }))
      .toThrow('X 列不存在')
  })

  it('空 Y 列抛错', () => {
    expect(() => renderSvgChart(table, { type: 'line', title: 't', x: 'epoch', y: [] }))
      .toThrow('至少指定一个')
  })
})

describe('s56 BibTeX', () => {
  const sample = `
% 这是注释
@article{smith2024deep,
  author = {Smith, John and 张三},
  title = {A {Deep} Study},
  journal = {Nature},
  volume = {12},
  year = 2024,
  pages = {1-10}
}
@inproceedings{lee2023net,
  author = "Lee, A. and Park, B.",
  title = "Network Things",
  booktitle = {Proc. NeurIPS},
  year = {2023}
}
`

  it('解析两条目及字段类型', () => {
    const entries = parseBibtex(sample)
    expect(entries).toHaveLength(2)
    expect(entries[0].type).toBe('article')
    expect(entries[0].key).toBe('smith2024deep')
    expect(entries[0].fields.title).toBe('A Deep Study') // 保护词去括号
    expect(entries[0].fields.year).toBe('2024')
    expect(entries[1].type).toBe('inproceedings')
  })

  it('往返：format → parse 保留关键字段', () => {
    const entries = parseBibtex(sample)
    const text = formatBibtex(entries)
    const reparsed = parseBibtex(text)
    expect(reparsed).toHaveLength(2)
    expect(reparsed[0].fields.journal).toBe('Nature')
    expect(reparsed[1].fields.booktitle).toBe('Proc. NeurIPS')
  })

  it('注释与 preamble 被跳过', () => {
    const text = '@comment{x,y}\n@preamble{"\\newcommand"}'
    expect(parseBibtex(text)).toHaveLength(0)
  })

  it('正文引用提取：方括号/分号/裸键', () => {
    const md = '见 [@smith2024deep; @lee2023net]，另见 @smith2024deep。联系 a@b.com 不算。'
    const keys = extractCitations(md)
    expect(keys).toEqual(['smith2024deep', 'lee2023net'])
  })

  it('参考文献章节按引用顺序编号，缺失键占位', () => {
    const entries = parseBibtex(sample)
    const md = buildReferencesSection(['lee2023net', 'ghost'], entries)
    expect(md).toContain('[1]')
    expect(md).toContain('A. Lee')
    expect(md).toContain('未找到条目：ghost')
  })

  it('formatReferenceLine article 包含期刊年份', () => {
    const e = parseBibtex(sample)[0]
    const line = formatReferenceLine(e)
    expect(line).toContain('John Smith')
    expect(line).toContain('2024')
    expect(line).toContain('Nature')
  })
})

describe('s55 报告生成', () => {
  const input: ReportInput = {
    title: '实验报告',
    authors: '张三',
    meta: { 数据集: 'MNIST', 随机种子: '42' },
    sections: [
      { id: 'abstract', heading: '摘要', body: '本研究验证了 **方法**。' },
      { id: 'results', heading: '3 结果', body: '曲线见图 [@smith2024deep]。\n\n![训练曲线](chart:train)' }
    ],
    charts: [{ id: 'train', caption: '训练曲线', relPath: 'charts/train.svg' }],
    bibEntries: parseBibtex('@article{smith2024deep,\n author={Smith, J.},\n title={Deep},\n year={2024},\n journal={Nature}\n}')
  }

  it('Markdown 含标题/元数据表格/章节', () => {
    const md = buildMarkdownReport(input)
    expect(md).toContain('# 实验报告')
    expect(md).toContain('| 数据集 | MNIST |')
    expect(md).toContain('## 摘要')
    expect(md).toContain('**方法**')
  })

  it('图表 chart: 引用替换为相对路径', () => {
    const md = buildMarkdownReport(input)
    expect(md).toContain('](charts/train.svg)')
    expect(md).not.toContain('chart:train')
  })

  it('参考文献章节联动生成', () => {
    const md = buildMarkdownReport(input)
    expect(md).toContain('## 参考文献')
    expect(md).toContain('smith2024deep')
  })

  it('LaTeX 文档骨架与图片引用', () => {
    const tex = buildLatexReport(input)
    expect(tex).toContain('\\documentclass[11pt]{article}')
    expect(tex).toContain('\\begin{document}')
    expect(tex).toContain('\\includegraphics')
    expect(tex).toContain('\\section{摘要}')
    expect(tex).toContain('\\textbf{方法}')
    expect(tex).toContain('\\end{document}')
  })

  it('doc HTML 包含标题与 Office 命名空间', () => {
    const html = buildDocHtml(input)
    expect(html).toContain('urn:schemas-microsoft-com:office:word')
    expect(html).toContain('<strong>方法</strong>')
  })

  it('exportReport 三格式扩展名', () => {
    expect(exportReport(input, 'markdown').ext).toBe('md')
    expect(exportReport(input, 'latex').ext).toBe('tex')
    expect(exportReport(input, 'doc').ext).toBe('doc')
  })

  it('默认模板包含标准六章节', () => {
    expect(DEFAULT_TEMPLATE.map((t) => t.id)).toEqual([
      'abstract', 'intro', 'methods', 'results', 'discussion', 'conclusion'
    ])
  })
})
