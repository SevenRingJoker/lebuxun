// s55 结构化学术报告生成（纯函数层，零 IO，双端可测）：
// 实验元数据 + 章节内容 + 图表引用 + 参考文献 → Markdown 母版；
// 一键导出 LaTeX（纯 TS 模板，不依赖 pandoc，避免外部进程与体积负担）。
// docx 采用「HTML 包装 .doc」兼容方案：Word 可直接打开（零依赖，格式可接受）。
import { extractCitations, buildReferencesSection, type BibEntry } from './bibtex'

/** 报告章节 */
export interface ReportSection {
  /** 章节标识（abstract/intro/methods/results/discussion/conclusion 等） */
  id: string
  /** 章节标题 */
  heading: string
  /** Markdown 正文（可含 ![](chart-xxx) 图表引用） */
  body: string
}

/** 图表附件（id 与正文 Markdown 引用对应） */
export interface ReportChart {
  /** 引用 id：正文用 ![标题](chart:<id>) */
  id: string
  caption: string
  /** 已落盘的相对路径（相对报告文件，用于导出） */
  relPath: string
}

/** 报告输入 */
export interface ReportInput {
  title: string
  /** 作者/机构（可多行） */
  authors?: string
  /** 实验元数据（键值对，渲染为表格；如数据集/随机种子/硬件/日期） */
  meta?: Record<string, string>
  sections: ReportSection[]
  charts?: ReportChart[]
  /** BibTeX 条目库（用于参考文献章节联动） */
  bibEntries?: BibEntry[]
}

/** 默认章节顺序模板（章节缺省时仍输出空标题提示，保证结构完整） */
export const DEFAULT_TEMPLATE: Array<{ id: string; heading: string; hint: string }> = [
  { id: 'abstract', heading: '摘要', hint: '研究问题、方法、主要结果与结论（200 字内）' },
  { id: 'intro', heading: '1 引言', hint: '背景、相关工作与研究问题' },
  { id: 'methods', heading: '2 方法', hint: '数据、模型/算法、实验设置' },
  { id: 'results', heading: '3 结果', hint: '主要发现，引用图表（见图 1）' },
  { id: 'discussion', heading: '4 讨论', hint: '结果解读、局限与未来工作' },
  { id: 'conclusion', heading: '5 结论', hint: '贡献总结' }
]

function escapeMdCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

/** 生成 Markdown 报告 */
export function buildMarkdownReport(input: ReportInput): string {
  const lines: string[] = []
  lines.push(`# ${input.title}`, '')
  if (input.authors) lines.push(input.authors, '')
  lines.push(`> 生成时间：${new Date().toISOString().slice(0, 10)}`, '')

  if (input.meta && Object.keys(input.meta).length > 0) {
    lines.push('## 实验元数据', '')
    lines.push('| 项目 | 内容 |', '|------|------|')
    for (const [k, v] of Object.entries(input.meta)) {
      lines.push(`| ${escapeMdCell(k)} | ${escapeMdCell(v)} |`)
    }
    lines.push('')
  }

  // 按模板顺序输出已有章节（模板外章节追加于后）
  const byId = new Map(input.sections.map((s) => [s.id, s]))
  const emitted = new Set<string>()
  for (const tpl of DEFAULT_TEMPLATE) {
    const sec = byId.get(tpl.id)
    if (sec) {
      lines.push(`## ${sec.heading}`, '', sec.body.trim(), '')
      emitted.add(sec.id)
    }
  }
  for (const sec of input.sections) {
    if (!emitted.has(sec.id)) {
      lines.push(`## ${sec.heading}`, '', sec.body.trim(), '')
    }
  }

  // 图表清单（自动编号，正文按出现顺序引用）
  const charts = input.charts ?? []
  if (charts.length > 0) {
    // 正文中把 chart:<id> 引用替换为相对路径
  }

  // 参考文献（按正文引用顺序）
  if (input.bibEntries && input.bibEntries.length > 0) {
    const bodyText = input.sections.map((s) => s.body).join('\n')
    const cited = extractCitations(bodyText)
    lines.push(buildReferencesSection(cited, input.bibEntries), '')
  }

  let md = lines.join('\n')
  // 图表引用替换：![caption](chart:id) → ![caption](relPath)
  for (const c of charts) {
    md = md.replaceAll(`](chart:${c.id})`, `](${c.relPath})`)
  }
  return md
}

/** Markdown 片段 → LaTeX 片段（处理标题/粗体/斜体/行内代码/列表/图片/引用标注） */
function mdInlineToLatex(s: string): string {
  return s
    .replace(/&/g, '\\&')
    .replace(/%/g, '\\%')
    .replace(/#/g, '\\#')
    .replace(/\*\*([^*]+)\*\*/g, '\\textbf{$1}')
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '\\emph{$1}')
    .replace(/`([^`]+)`/g, '\\texttt{$1}')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '\\href{$2}{$1}')
}

/**
 * 导出 LaTeX（article 文档类，含 ctex 兼容注释；图表用 includegraphics）。
 * 中文用户可自行启用 ctexart；此处用 article 保证无外部字体依赖时也能编译英文稿。
 */
export function buildLatexReport(input: ReportInput): string {
  const md = buildMarkdownReport(input)
  const charts = input.charts ?? []
  const L: string[] = []
  L.push('\\documentclass[11pt]{article}')
  L.push('\\usepackage{graphicx}')
  L.push('\\usepackage{hyperref}')
  L.push('\\usepackage{booktabs}')
  L.push('\\usepackage{geometry}')
  L.push('\\geometry{margin=2.5cm}')
  L.push('% 中文稿件请将 documentclass 换为 \\documentclass[11pt]{ctexart}')
  L.push('\\begin{document}')
  L.push('', `\\title{${mdInlineToLatex(input.title)}}`)
  if (input.authors) L.push(`\\author{${mdInlineToLatex(input.authors)}}`)
  L.push('\\maketitle', '')

  // 逐行转换 Markdown（简化处理）
  const lines = md.split('\n')
  let inList = false
  const closeList = (): void => { if (inList) { L.push('\\end{itemize}'); inList = false } }
  for (const raw of lines.slice(md.indexOf('## ') >= 0 ? 0 : 0)) {
    const line = raw.trim()
    if (!line) { closeList(); continue }
    if (line.startsWith('# ')) continue // 标题已用 \title
    const h = line.match(/^(#{2,4})\s+(.*)$/)
    if (h) {
      closeList()
      const level = h[1].length
      const cmd = level === 2 ? 'section' : level === 3 ? 'subsection' : 'subsubsection'
      L.push(`\\${cmd}{${mdInlineToLatex(h[2])}}`, '')
      continue
    }
    const li = line.match(/^[-*+]\s+(.*)$/)
    if (li) {
      if (!inList) { L.push('\\begin{itemize}'); inList = true }
      L.push(`  \\item ${mdInlineToLatex(li[1])}`)
      continue
    }
    const img = line.match(/^!\[([^\]]*)\]\(([^)]+)\)$/)
    if (img) {
      closeList()
      const chart = charts.find((c) => c.relPath === img[2])
      L.push('\\begin{figure}[htbp]')
      L.push('  \\centering')
      L.push(`  \\includegraphics[width=0.85\\linewidth]{${img[2].replace(/\.[^.]+$/, '')}}`)
      if (img[1] || chart) L.push(`  \\caption{${mdInlineToLatex(img[1] || chart?.caption || '')}}`)
      L.push('\\end{figure}', '')
      continue
    }
    if (line.startsWith('> ')) {
      closeList()
      L.push(`\\begin{quote}${mdInlineToLatex(line.slice(2))}\\end{quote}`)
      continue
    }
    if (line.startsWith('|')) {
      // 简化：表格行原样跳过（元数据表格在 LaTeX 中改为逐行文本）
      if (/^\|[\s|-]+\|$/.test(line)) continue
      const cells = line.split('|').slice(1, -1).map((c) => mdInlineToLatex(c.trim()))
      if (cells[0] === '项目') continue
      L.push(`\\noindent\\textbf{${cells[0]}：}${cells[1] ?? ''}\\\\`)
      continue
    }
    closeList()
    L.push(mdInlineToLatex(line), '')
  }
  closeList()
  L.push('\\end{document}')
  return L.join('\n')
}

/**
 * 导出 Word 兼容文档：用 HTML 包装为 .doc（Word/WPS 可直接打开，零依赖方案）。
 * 图表路径必须是报告文件可解析的相对路径或 file URL（调用方保证）。
 */
export function buildDocHtml(input: ReportInput): string {
  const md = buildMarkdownReport(input)
  const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
  const bodyParts: string[] = []
  for (const raw of md.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const h = line.match(/^(#{1,4})\s+(.*)$/)
    if (h) bodyParts.push(`<h${h[1].length + 1}>${esc(h[2])}</h${h[1].length + 1}>`)
    else if (/^[-*+]\s+/.test(line)) bodyParts.push(`<li>${esc(line.replace(/^[-*+]\s+/, ''))}</li>`)
    else if (line.startsWith('|') && !/^\|[\s|-]+\|$/.test(line)) {
      const cells = line.split('|').slice(1, -1).map((c) => `<td>${esc(c.trim())}</td>`)
      bodyParts.push(`<table border="1"><tr>${cells.join('')}</tr></table>`)
    }
    else if (line.startsWith('> ')) bodyParts.push(`<blockquote>${esc(line.slice(2))}</blockquote>`)
    else bodyParts.push(`<p>${esc(line)}</p>`)
  }
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"><title>${esc(input.title)}</title>
<style>body{font-family:'Times New Roman',SimSun,serif;font-size:12pt;line-height:1.6}h1{font-size:18pt}h2{font-size:15pt}h3{font-size:13pt}code{font-family:Consolas}</style>
</head><body>${bodyParts.join('\n')}</body></html>`
}

/** 报告导出格式 */
export type ReportFormat = 'markdown' | 'latex' | 'doc'

/** 统一导出入口 */
export function exportReport(input: ReportInput, format: ReportFormat): { ext: string; content: string } {
  switch (format) {
    case 'latex': return { ext: 'tex', content: buildLatexReport(input) }
    case 'doc': return { ext: 'doc', content: buildDocHtml(input) }
    default: return { ext: 'md', content: buildMarkdownReport(input) }
  }
}
