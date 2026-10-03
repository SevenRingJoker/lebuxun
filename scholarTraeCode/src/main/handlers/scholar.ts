// s54–s56 学术链路主进程 IPC：
// - scholar:renderChart  读数据文件(CSV/JSON) → 渲染 SVG → 落盘 <ws>/.trae/charts/
// - scholar:saveChart    渲染端直接生成的 SVG 落盘（AI 工具回传）
// - scholar:exportReport 报告导出 md/tex/doc（含图表文件拷贝到相对目录）
// - scholar:readBib / scholar:saveBib  文献库 <ws>/.trae/references.bib
// 纯运算全部在 shared/scholar，本层只做文件读写、路径越界校验与原子写。
import { ipcMain } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { getLogger } from '../ai/logger'
import { parseDataFile } from '../../shared/scholar/csv'
import { renderSvgChart, type ChartSpec } from '../../shared/scholar/svgChart'
import { exportReport, type ReportInput, type ReportFormat } from '../../shared/scholar/report'
import { parseBibtex, formatBibtex, type BibEntry } from '../../shared/scholar/bibtex'

const log = getLogger('scholar')

function traeDir(workspace: string): string {
  return path.join(workspace, '.trae')
}
function chartsDir(workspace: string): string {
  return path.join(traeDir(workspace), 'charts')
}
function bibPath(workspace: string): string {
  return path.join(traeDir(workspace), 'references.bib')
}

/** 路径必须位于工作区内（防止 ../ 越界写） */
function assertInsideWorkspace(workspace: string, target: string): void {
  const rel = path.relative(workspace, target)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('目标路径越出工作区')
  }
}

/** 生成安全的图表文件名 */
function chartFileName(title: string): string {
  const stamp = Date.now().toString(36)
  const slug = title.replace(/[^\w一-龥-]+/g, '_').slice(0, 40) || 'chart'
  return `${slug}-${stamp}.svg`
}

export function registerScholarHandlers(): void {
  // 读取数据文件并渲染图表落盘，返回文件绝对/相对路径与图表规格回显
  ipcMain.handle(
    'scholar:renderChart',
    async (_e, workspace: string, dataFile: string, spec: ChartSpec) => {
      try {
        if (!workspace || !dataFile) return { ok: false, error: '缺少工作区或数据文件' }
        assertInsideWorkspace(workspace, dataFile)
        const text = await fs.readFile(dataFile, 'utf-8')
        const table = parseDataFile(dataFile, text)
        const svg = renderSvgChart(table, spec)
        await fs.mkdir(chartsDir(workspace), { recursive: true })
        const name = chartFileName(spec.title)
        const abs = path.join(chartsDir(workspace), name)
        await fs.writeFile(abs, svg, 'utf-8')
        log.info(`图表已生成：${path.relative(workspace, abs)}（${table.rows.length} 行）`)
        return {
          ok: true,
          path: abs,
          relPath: path.relative(workspace, abs).replace(/\\/g, '/'),
          rowCount: table.rows.length,
          columns: table.columns
        }
      } catch (err) {
        log.warn(`图表生成失败：${err instanceof Error ? err.message : String(err)}`)
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // 渲染端/AI 已生成 SVG 字符串时直接落盘
  ipcMain.handle(
    'scholar:saveChart',
    async (_e, workspace: string, title: string, svg: string) => {
      try {
        if (!workspace || typeof svg !== 'string' || !svg.trim()) {
          return { ok: false, error: '参数无效' }
        }
        await fs.mkdir(chartsDir(workspace), { recursive: true })
        const name = chartFileName(title || 'chart')
        const abs = path.join(chartsDir(workspace), name)
        await fs.writeFile(abs, svg, 'utf-8')
        return { ok: true, path: abs, relPath: path.relative(workspace, abs).replace(/\\/g, '/') }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // 导出报告到工作区（reports/ 目录；图表随报告用相对 .trae/charts 路径引用）
  ipcMain.handle(
    'scholar:exportReport',
    async (_e, workspace: string, input: ReportInput, format: ReportFormat) => {
      try {
        if (!workspace || !input?.title) return { ok: false, error: '缺少工作区或标题' }
        const { ext, content } = exportReport(input, format)
        const dir = path.join(workspace, 'reports')
        await fs.mkdir(dir, { recursive: true })
        const slug = input.title.replace(/[^\w一-龥-]+/g, '_').slice(0, 60) || 'report'
        const file = path.join(dir, `${slug}.${ext}`)
        assertInsideWorkspace(workspace, file)
        await fs.writeFile(file, content, 'utf-8')
        log.info(`报告已导出：${path.relative(workspace, file)}（${format}）`)
        return { ok: true, path: file, relPath: path.relative(workspace, file).replace(/\\/g, '/') }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // 读取文献库
  ipcMain.handle('scholar:readBib', async (_e, workspace: string) => {
    try {
      const raw = await fs.readFile(bibPath(workspace), 'utf-8')
      return { ok: true, entries: parseBibtex(raw) as BibEntry[], text: raw }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { ok: true, entries: [], text: '' }
      }
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // 保存文献库（entries → 规范 BibTeX，原子写）
  ipcMain.handle('scholar:saveBib', async (_e, workspace: string, entries: BibEntry[]) => {
    try {
      if (!workspace || !Array.isArray(entries)) return { ok: false, error: '参数无效' }
      const text = formatBibtex(entries)
      const target = bibPath(workspace)
      await fs.mkdir(path.dirname(target), { recursive: true })
      const tmp = target + '.tmp'
      await fs.writeFile(tmp, text, 'utf-8')
      await fs.rename(tmp, target)
      return { ok: true, path: target, count: entries.length }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
