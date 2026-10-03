// s54 学术图表 SVG 渲染器（纯函数层，零依赖）：
// 输入 DataTable + 图表规格，输出可直接落盘/嵌入的 SVG 字符串。
// 学术规范预设：白底、无网格线或淡网格、衬线标注、色盲友好配色（Nature 风格）、
// 坐标轴带标题与刻度、图例置于右上/底部。输出声明 width/height（对应 300dpi 打印尺寸）。
import type { DataTable } from './csv'

export type ChartType = 'line' | 'bar' | 'scatter'

/** 图表规格 */
export interface ChartSpec {
  type: ChartType
  title: string
  /** X 轴列名 */
  x: string
  /** Y 轴列名（多系列时为多个；柱状图单系列即可） */
  y: string[]
  /** 系列显示名（缺省用列名） */
  seriesNames?: string[]
  xLabel?: string
  yLabel?: string
  width?: number
  height?: number
}

/** 色盲友好的学术配色（Wong 2011 调色板前 6 色，黑白打印可区分） */
const PALETTE = ['#0072B2', '#D55E00', '#009E73', '#CC79A7', '#F0E442', '#56B4E9']

/** 默认画布尺寸（像素；学术单栏图约 3.3in×2.5in @300dpi≈990×750，屏幕显示缩小） */
const DEFAULT_W = 720
const DEFAULT_H = 460

const MARGIN = { top: 56, right: 32, bottom: 64, left: 72 }

interface Scale {
  min: number
  max: number
}

function numScale(values: number[]): Scale {
  const nums = values.filter((n) => Number.isFinite(n))
  if (nums.length === 0) return { min: 0, max: 1 }
  let min = Math.min(...nums)
  let max = Math.max(...nums)
  if (min === max) { min -= 1; max += 1 }
  return { min, max }
}

/** 线性刻度（5 档左右，取整齐数） */
function ticks(scale: Scale, count = 5): number[] {
  const { min, max } = scale
  const raw = (max - min) / count
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const norm = raw / mag
  const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag
  const start = Math.ceil(min / step) * step
  const out: number[] = []
  for (let v = start; v <= max + step * 0.001; v += step) {
    out.push(Number(v.toFixed(10)))
    if (out.length > 10) break
  }
  return out
}

function fmtTick(v: number): string {
  if (Math.abs(v) >= 1000 || (v !== 0 && Math.abs(v) < 0.01)) return v.toExponential(1)
  return String(Number(v.toFixed(4)))
}

function escapeXml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 取列的数值序列（null 跳过；X 非数值时按行序号） */
function columnNumbers(table: DataTable, col: string): (number | null)[] {
  return table.rows.map((r) => {
    const v = r[col]
    return typeof v === 'number' ? v : v == null ? null : Number(v)
  }).map((v) => (v != null && Number.isFinite(v) ? v : null))
}

/**
 * 生成 SVG 字符串。数据缺失或规格非法时抛出明确错误（调用方转卡片提示）。
 */
export function renderSvgChart(table: DataTable, spec: ChartSpec): string {
  if (!table.columns.includes(spec.x)) throw new Error(`X 列不存在：${spec.x}`)
  for (const y of spec.y) {
    if (!table.columns.includes(y)) throw new Error(`Y 列不存在：${y}`)
  }
  if (spec.y.length === 0) throw new Error('至少指定一个 Y 列')

  const W = spec.width ?? DEFAULT_W
  const H = spec.height ?? DEFAULT_H
  const plotL = MARGIN.left
  const plotR = W - MARGIN.right
  const plotT = MARGIN.top
  const plotB = H - MARGIN.bottom
  const plotW = plotR - plotL
  const plotH = plotB - plotT

  // X 值：数值用数值刻度；否则用分类（柱状图常见）等距排布
  const xRaw = table.rows.map((r) => r[spec.x])
  const xNumeric = xRaw.every((v) => v == null || typeof v === 'number')
  const xNums = xRaw.map((v) => (typeof v === 'number' ? v : null))
  const xScale = xNumeric ? numScale(xNums.filter((v): v is number => v != null)) : { min: 0, max: Math.max(1, table.rows.length - 1) }

  const yValues: number[] = []
  for (const y of spec.y) {
    for (const v of columnNumbers(table, y)) if (v != null) yValues.push(v)
  }
  const yScaleRaw = numScale(yValues)
  // 学术规范：柱状图高度必须从 0 基线起（非负数据），否则柱高比例会误导读者
  const yScale: Scale =
    spec.type === 'bar' && yValues.every((v) => v >= 0)
      ? { min: 0, max: yScaleRaw.max }
      : yScaleRaw
  const yTicks = ticks(yScale)
  const xTicks = xNumeric ? ticks(xScale) : xRaw.map((v, i) => i)

  const sx = (v: number): number => plotL + ((v - xScale.min) / (xScale.max - xScale.min)) * plotW
  const sy = (v: number): number => plotB - ((v - yScale.min) / (yScale.max - yScale.min)) * plotH
  const bandX = (i: number): number => plotL + ((i + 0.5) / Math.max(1, table.rows.length)) * plotW

  const parts: string[] = []
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Georgia,'Times New Roman',serif" font-size="13">`)
  parts.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`)

  // 标题
  parts.push(`<text x="${W / 2}" y="28" text-anchor="middle" font-size="16" font-weight="bold" fill="#1a1a1a">${escapeXml(spec.title)}</text>`)

  // 淡水平网格线（学术图常见，仅 Y 方向）
  for (const t of yTicks) {
    parts.push(`<line x1="${plotL}" y1="${sy(t)}" x2="${plotR}" y2="${sy(t)}" stroke="#e6e6e6" stroke-width="1"/>`)
  }

  // 坐标轴
  parts.push(`<line x1="${plotL}" y1="${plotT}" x2="${plotL}" y2="${plotB}" stroke="#333" stroke-width="1.2"/>`)
  parts.push(`<line x1="${plotL}" y1="${plotB}" x2="${plotR}" y2="${plotB}" stroke="#333" stroke-width="1.2"/>`)

  // Y 刻度与标签
  for (const t of yTicks) {
    parts.push(`<line x1="${plotL - 5}" y1="${sy(t)}" x2="${plotL}" y2="${sy(t)}" stroke="#333"/>`)
    parts.push(`<text x="${plotL - 9}" y="${sy(t) + 4}" text-anchor="end" fill="#444">${fmtTick(t)}</text>`)
  }
  // X 刻度（分类轴最多显示 12 个标签防重叠）
  const labelStep = Math.max(1, Math.ceil(xTicks.length / 12))
  xTicks.forEach((t, i) => {
    const px = xNumeric ? sx(Number(t)) : bandX(i)
    parts.push(`<line x1="${px}" y1="${plotB}" x2="${px}" y2="${plotB + 5}" stroke="#333"/>`)
    if (xNumeric) {
      parts.push(`<text x="${px}" y="${plotB + 18}" text-anchor="middle" fill="#444">${fmtTick(Number(t))}</text>`)
    } else if (i % labelStep === 0) {
      const label = String(xRaw[i] ?? '')
      parts.push(`<text x="${px}" y="${plotB + 18}" text-anchor="end" transform="rotate(-35 ${px} ${plotB + 18})" fill="#444">${escapeXml(label.length > 14 ? label.slice(0, 13) + '…' : label)}</text>`)
    }
  })

  // 轴标题
  parts.push(`<text x="${W / 2}" y="${H - 14}" text-anchor="middle" fill="#222">${escapeXml(spec.xLabel ?? spec.x)}</text>`)
  parts.push(`<text x="20" y="${plotT + plotH / 2}" text-anchor="middle" transform="rotate(-90 20 ${plotT + plotH / 2})" fill="#222">${escapeXml(spec.yLabel ?? spec.y.join(' / '))}</text>`)

  const names = spec.seriesNames ?? spec.y

  if (spec.type === 'line') {
    spec.y.forEach((y, si) => {
      const color = PALETTE[si % PALETTE.length]
      const pts: string[] = []
      table.rows.forEach((r, i) => {
        const yv = r[y]
        if (typeof yv !== 'number') return
        const xv = xNumeric && typeof r[spec.x] === 'number' ? (r[spec.x] as number) : i
        pts.push(`${sx(xv)},${sy(yv)}`)
      })
      if (pts.length > 1) {
        parts.push(`<polyline fill="none" stroke="${color}" stroke-width="2" points="${pts.join(' ')}"/>`)
      }
      pts.forEach((p) => {
        const [cx, cy] = p.split(',')
        parts.push(`<circle cx="${cx}" cy="${cy}" r="3" fill="${color}"/>`)
      })
    })
  } else if (spec.type === 'bar') {
    const y = spec.y[0]
    const color = PALETTE[0]
    const n = table.rows.length
    const slot = plotW / Math.max(1, n)
    const barW = Math.min(48, slot * 0.62)
    table.rows.forEach((r, i) => {
      const yv = r[y]
      if (typeof yv !== 'number' || yv < yScale.min) return
      const cx = bandX(i)
      const top = sy(Math.max(yv, yScale.min))
      parts.push(`<rect x="${cx - barW / 2}" y="${top}" width="${barW}" height="${plotB - top}" fill="${color}" opacity="0.85"/>`)
    })
  } else {
    // scatter
    spec.y.forEach((y, si) => {
      const color = PALETTE[si % PALETTE.length]
      table.rows.forEach((r, i) => {
        const yv = r[y]
        if (typeof yv !== 'number') return
        const xv = xNumeric && typeof r[spec.x] === 'number' ? (r[spec.x] as number) : i
        parts.push(`<circle cx="${sx(xv)}" cy="${sy(yv)}" r="4" fill="${color}" opacity="0.75"/>`)
      })
    })
  }

  // 图例（多系列时显示；置于绘图区上方右侧）
  if (spec.y.length > 1) {
    let lx = plotR - 10
    const legendParts: string[] = []
    spec.y.forEach((y, si) => {
      const color = PALETTE[si % PALETTE.length]
      const label = names[si] ?? y
      legendParts.push(`<g class="legend-item"><rect x="0" y="-9" width="14" height="3" fill="${color}"/><text x="20" y="-3" fill="#333">${escapeXml(label)}</text></g>`)
    })
    // 简化：图例竖排于标题下方右侧
    let ly = 48
    parts.push(`<g transform="translate(${plotR - 150},0)">`)
    spec.y.forEach((y, si) => {
      const color = PALETTE[si % PALETTE.length]
      parts.push(`<rect x="0" y="${ly - 9}" width="14" height="3" fill="${color}"/>`)
      parts.push(`<text x="20" y="${ly - 3}" fill="#333">${escapeXml(names[si] ?? y)}</text>`)
      ly += 18
    })
    parts.push(`</g>`)
    void legendParts
  }

  parts.push('</svg>')
  return parts.join('')
}

/** SVG → 可嵌入 Markdown 的 data URL（报告内嵌用；额外编码括号避免 Markdown 图片语法截断） */
export function svgToDataUrl(svg: string): string {
  const encoded = encodeURIComponent(svg).replace(/\(/g, '%28').replace(/\)/g, '%29')
  return `data:image/svg+xml;utf8,${encoded}`
}
