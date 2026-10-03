// s54–s56 学术链路渲染端状态：面板显隐 + 当前数据/图表/文献。
// 重运算与落盘走 window.api.scholar（主进程 shared/scholar 纯函数）。
import { defineStore } from 'pinia'
import { ref } from 'vue'

/** 已生成图表记录（报告生成时勾选引用） */
export interface ChartRecord {
  id: string
  title: string
  relPath: string
  caption: string
}

/** 文献条目（与主进程 BibEntry 对齐） */
export interface BibEntryUi {
  type: string
  key: string
  fields: Record<string, string>
}

export const useScholarStore = defineStore('scholar', () => {
  const visible = ref(false)
  /** 当前选中的数据文件（相对工作区路径） */
  const dataFile = ref('')
  /** 解析出的列名 */
  const columns = ref<string[]>([])
  /** 已生成图表 */
  const charts = ref<ChartRecord[]>([])
  /** 文献库 */
  const entries = ref<BibEntryUi[]>([])
  /** 最近一次状态提示/错误 */
  const status = ref('')

  function open(): void { visible.value = true }
  function close(): void { visible.value = false }

  function setData(file: string, cols: string[]): void {
    dataFile.value = file
    columns.value = cols
  }

  function addChart(c: ChartRecord): void {
    if (!charts.value.some((x) => x.relPath === c.relPath)) charts.value.push(c)
  }

  function setEntries(e: BibEntryUi[]): void { entries.value = e }

  function setStatus(s: string): void {
    status.value = s
    if (s) window.setTimeout(() => { if (status.value === s) status.value = '' }, 4000)
  }

  function reset(): void {
    dataFile.value = ''
    columns.value = []
    charts.value = []
    entries.value = []
    status.value = ''
  }

  return {
    visible, dataFile, columns, charts, entries, status,
    open, close, setData, addChart, setEntries, setStatus, reset
  }
})
