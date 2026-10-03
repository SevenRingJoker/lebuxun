<script setup lang="ts">
// s54–s56 学术/报告面板（fixed 右侧抽屉）：
//  Tab1 数据→图表：选数据文件 → 解析列名 → 配图表 → 渲染落盘 .trae/charts
//  Tab2 报告生成：标题/元数据/章节 → 勾选图表 → 导出 md / LaTeX / doc
//  Tab3 参考文献：BibTeX 导入 → 解析条目 → 保存文献库
import { ref, computed } from 'vue'
import { useScholarStore, type ChartRecord } from '../stores/scholar'
import { useWorkspaceStore } from '../stores/workspace'
import { csvToTable, numericColumns } from '../../../shared/scholar/csv'
import type { ReportInput, ReportSection } from '../../../shared/scholar/report'
import type { BibEntry } from '../../../shared/scholar/bibtex'

const scholar = useScholarStore()
const ws = useWorkspaceStore()

// 工作区根路径（面板仅在已打开工作区时可用；空串时 IPC 返回明确错误）
const root = computed(() => ws.rootPath ?? '')

const tab = ref<'chart' | 'report' | 'refs'>('chart')

// ---------- Tab1 图表 ----------
const chartType = ref<'line' | 'bar' | 'scatter'>('line')
const chartTitle = ref('')
const xCol = ref('')
const yCols = ref<string[]>([])
const xLabel = ref('')
const yLabel = ref('')
const previewSvg = ref('')
const busy = ref(false)

const numericCols = computed(() => scholar.columns)

async function loadDataFile(): Promise<void> {
  if (!scholar.dataFile) {
    scholar.setStatus('请先填写相对工作区的数据文件路径')
    return
  }
  try {
    const abs = `${root.value}/${scholar.dataFile}`.replace(/\\/g, '/')
    const text = await window.api.fs.readFile(abs)
    const table = csvToTable(text)
    scholar.setData(scholar.dataFile, numericColumns(table).length ? numericColumns(table) : table.columns)
    xCol.value = table.columns[0] ?? ''
    yCols.value = numericColumns(table).slice(0, 1)
    scholar.setStatus(`已解析 ${table.rows.length} 行、${table.columns.length} 列`)
  } catch (e) {
    scholar.setStatus(`读取失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

function toggleY(col: string): void {
  const i = yCols.value.indexOf(col)
  if (i >= 0) yCols.value.splice(i, 1)
  else yCols.value.push(col)
}

async function generateChart(): Promise<void> {
  if (!scholar.dataFile || !chartTitle.value || !xCol.value || yCols.value.length === 0) {
    scholar.setStatus('请完善标题、X 列并至少勾选一个 Y 列')
    return
  }
  busy.value = true
  try {
    const r = await window.api.scholar.renderChart(root.value, scholar.dataFile, {
      type: chartType.value,
      title: chartTitle.value,
      x: xCol.value,
      y: yCols.value,
      xLabel: xLabel.value || undefined,
      yLabel: yLabel.value || undefined
    })
    if (r.ok && r.relPath) {
      const rec: ChartRecord = {
        id: r.relPath,
        title: chartTitle.value,
        relPath: r.relPath,
        caption: chartTitle.value
      }
      scholar.addChart(rec)
      // 读回 SVG 预览
      previewSvg.value = await window.api.fs.readFile(`${root.value}/${r.relPath}`)
      scholar.setStatus(`图表已保存：${r.relPath}`)
    } else {
      scholar.setStatus(`生成失败：${r.error}`)
    }
  } finally {
    busy.value = false
  }
}

// ---------- Tab2 报告 ----------
const reportTitle = ref('')
const reportAuthors = ref('')
const reportMeta = ref('数据集：\n指标：\n随机种子：')
const abstract = ref('')
const results = ref('')
const selectedCharts = ref<Set<string>>(new Set())
const linkRefs = ref(true)

function toggleChart(id: string): void {
  if (selectedCharts.value.has(id)) selectedCharts.value.delete(id)
  else selectedCharts.value.add(id)
}

async function exportAs(format: 'markdown' | 'latex' | 'doc'): Promise<void> {
  if (!reportTitle.value) {
    scholar.setStatus('请填写报告标题')
    return
  }
  const meta: Record<string, string> = {}
  for (const line of reportMeta.value.split('\n')) {
    const idx = line.indexOf('：')
    if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
  }
  const chosen = scholar.charts.filter((c) => selectedCharts.value.has(c.relPath))
  let body = results.value
  if (chosen.length) {
    body += '\n\n' + chosen.map((c) => `![${c.caption}](${c.relPath})`).join('\n\n')
  }
  const sections: ReportSection[] = [
    { id: 'abstract', heading: '摘要', body: abstract.value || '（待补充）' },
    { id: 'results', heading: '3 结果', body: body || '（待补充）' }
  ]
  const input: ReportInput = {
    title: reportTitle.value,
    authors: reportAuthors.value || undefined,
    meta,
    sections,
    charts: chosen.map((c) => ({ id: c.id, caption: c.caption, relPath: c.relPath })),
    bibEntries: linkRefs.value ? (scholar.entries as BibEntry[]) : []
  }
  const r = await window.api.scholar.exportReport(root.value, input, format)
  scholar.setStatus(r.ok ? `报告已导出：${r.relPath}` : `导出失败：${r.error}`)
}

// ---------- Tab3 文献 ----------
const bibText = ref('')
async function loadBib(): Promise<void> {
  const r = await window.api.scholar.readBib(root.value)
  if (r.ok) {
    scholar.setEntries(r.entries ?? [])
    bibText.value = r.text ?? ''
    scholar.setStatus(`文献库 ${r.entries?.length ?? 0} 条`)
  }
}

async function saveBib(): Promise<void> {
  // 渲染端解析后交主进程规范化保存
  const { parseBibtex, formatBibtex } = await import('../../../shared/scholar/bibtex')
  const entries = parseBibtex(bibText.value)
  if (entries.length === 0 && bibText.value.trim()) {
    scholar.setStatus('未解析出有效条目，请检查 BibTeX 格式')
    return
  }
  bibText.value = formatBibtex(entries)
  scholar.setEntries(entries)
  const r = await window.api.scholar.saveBib(root.value, entries)
  scholar.setStatus(r.ok ? `已保存 ${r.count} 条文献到 .trae/references.bib` : `保存失败：${r.error}`)
}
</script>

<template>
  <Teleport to="body">
    <div v-if="scholar.visible" class="scholar-mask" @click.self="scholar.close()">
      <div class="scholar-drawer">
        <header class="sh-header">
          <div class="sh-tabs">
            <button :class="{ active: tab === 'chart' }" @click="tab = 'chart'">数据→图表</button>
            <button :class="{ active: tab === 'report' }" @click="tab = 'report'">报告生成</button>
            <button :class="{ active: tab === 'refs' }" @click="tab = 'refs'; loadBib()">参考文献</button>
          </div>
          <button class="sh-close" title="关闭" @click="scholar.close()">×</button>
        </header>

        <div v-if="scholar.status" class="sh-status">{{ scholar.status }}</div>

        <!-- Tab1 数据→图表 -->
        <div v-show="tab === 'chart'" class="sh-body">
          <label class="sh-field">
            <span>数据文件（相对工作区，CSV/TSV/JSON）</span>
            <div class="sh-row">
              <input v-model="scholar.dataFile" placeholder="results/metrics.csv" />
              <button @click="loadDataFile">读取</button>
            </div>
          </label>

          <label class="sh-field">
            <span>图表标题</span>
            <input v-model="chartTitle" placeholder="如：模型准确率随训练轮次变化" />
          </label>

          <div class="sh-row">
            <label class="sh-field">
              <span>类型</span>
              <select v-model="chartType">
                <option value="line">折线图</option>
                <option value="bar">柱状图</option>
                <option value="scatter">散点图</option>
              </select>
            </label>
            <label class="sh-field">
              <span>X 轴列</span>
              <select v-model="xCol">
                <option v-for="c in scholar.columns" :key="c" :value="c">{{ c }}</option>
              </select>
            </label>
          </div>

          <div class="sh-field">
            <span>Y 轴列（可多选系列）</span>
            <div class="sh-cols">
              <label v-for="c in numericCols" :key="c" class="sh-chip">
                <input type="checkbox" :value="c" :checked="yCols.includes(c)" @change="toggleY(c)" />
                {{ c }}
              </label>
            </div>
          </div>

          <div class="sh-row">
            <label class="sh-field"><span>X 轴标题</span><input v-model="xLabel" /></label>
            <label class="sh-field"><span>Y 轴标题</span><input v-model="yLabel" /></label>
          </div>

          <button class="sh-primary" :disabled="busy" @click="generateChart">
            {{ busy ? '生成中…' : '生成图表（落盘 .trae/charts）' }}
          </button>

          <div v-if="previewSvg" class="sh-preview" v-html="previewSvg"></div>
        </div>

        <!-- Tab2 报告 -->
        <div v-show="tab === 'report'" class="sh-body">
          <label class="sh-field"><span>报告标题</span><input v-model="reportTitle" /></label>
          <label class="sh-field"><span>作者/机构</span><input v-model="reportAuthors" /></label>
          <label class="sh-field">
            <span>实验元数据（每行「键：值」）</span>
            <textarea v-model="reportMeta" rows="3"></textarea>
          </label>
          <label class="sh-field"><span>摘要</span><textarea v-model="abstract" rows="3"></textarea></label>
          <label class="sh-field">
            <span>结果正文（引用图表在下方勾选后自动追加；用 [@key] 标注文献）</span>
            <textarea v-model="results" rows="5"></textarea>
          </label>

          <div class="sh-field" v-if="scholar.charts.length">
            <span>插入图表</span>
            <div class="sh-cols">
              <label v-for="c in scholar.charts" :key="c.relPath" class="sh-chip">
                <input type="checkbox" :checked="selectedCharts.has(c.relPath)" @change="toggleChart(c.relPath)" />
                {{ c.title }}
              </label>
            </div>
          </div>

          <label class="sh-check">
            <input type="checkbox" v-model="linkRefs" /> 联动文献库自动生成参考文献章节
          </label>

          <div class="sh-row">
            <button class="sh-primary" @click="exportAs('markdown')">导出 Markdown</button>
            <button @click="exportAs('latex')">导出 LaTeX</button>
            <button @click="exportAs('doc')">导出 Word(.doc)</button>
          </div>
        </div>

        <!-- Tab3 参考文献 -->
        <div v-show="tab === 'refs'" class="sh-body">
          <p class="sh-hint">粘贴 BibTeX（@article/@inproceedings/@book…），保存到 .trae/references.bib。报告正文中用 [@key] 引用。</p>
          <textarea v-model="bibText" rows="14" placeholder="@article{key2024,&#10;  author = {…},&#10;  title = {…},&#10;  year = {2024}&#10;}"></textarea>
          <div class="sh-row">
            <button class="sh-primary" @click="saveBib">解析并保存（{{ scholar.entries.length }} 条）</button>
            <button @click="loadBib">重新载入</button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.scholar-mask {
  position: fixed; inset: 0; z-index: 9000;
  background: rgba(2, 8, 18, 0.55);
  display: flex; justify-content: flex-end;
  backdrop-filter: blur(2px);
}
.scholar-drawer {
  width: min(560px, 94vw); height: 100%;
  background: var(--bg-elevated, #0e1729);
  border-left: 1px solid var(--border, #1c2c45);
  box-shadow: -12px 0 40px rgba(0, 0, 0, 0.5);
  display: flex; flex-direction: column;
  color: var(--text-primary, #e6ebf2);
}
.sh-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 14px; border-bottom: 1px solid var(--border, #1c2c45);
}
.sh-tabs { display: flex; gap: 6px; }
.sh-tabs button {
  background: transparent; border: 1px solid transparent; color: var(--text-secondary, #8a98b0);
  padding: 5px 12px; border-radius: 6px; cursor: pointer; font-size: 13px;
}
.sh-tabs button.active {
  color: var(--accent, #00d4ff); border-color: var(--accent, #00d4ff);
  background: rgba(0, 212, 255, 0.08);
}
.sh-close {
  background: transparent; border: none; color: var(--text-secondary, #8a98b0);
  font-size: 22px; cursor: pointer; line-height: 1;
}
.sh-status {
  margin: 10px 14px 0; padding: 7px 10px; font-size: 12px;
  background: rgba(0, 212, 255, 0.1); border: 1px solid rgba(0, 212, 255, 0.3);
  border-radius: 6px; color: var(--accent, #00d4ff);
}
.sh-body { padding: 14px; overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 12px; }
.sh-field { display: flex; flex-direction: column; gap: 5px; flex: 1; font-size: 12px; color: var(--text-secondary, #8a98b0); }
.sh-field input, .sh-field select, .sh-field textarea {
  background: var(--bg-input, #0a1220); border: 1px solid var(--border, #1c2c45);
  border-radius: 6px; padding: 7px 9px; color: var(--text-primary, #e6ebf2); font-size: 13px;
  font-family: inherit; resize: vertical;
}
.sh-row { display: flex; gap: 10px; }
.sh-row button, .sh-body > button {
  background: rgba(0, 212, 255, 0.12); color: var(--accent, #00d4ff);
  border: 1px solid rgba(0, 212, 255, 0.35); border-radius: 6px;
  padding: 7px 14px; cursor: pointer; font-size: 13px; white-space: nowrap;
}
.sh-primary {
  background: linear-gradient(135deg, #00d4ff, #0090ff) !important;
  color: #04101f !important; border: none !important; font-weight: 600;
}
.sh-primary:disabled { opacity: 0.5; cursor: wait; }
.sh-cols { display: flex; flex-wrap: wrap; gap: 6px; }
.sh-chip {
  display: inline-flex; align-items: center; gap: 4px;
  background: var(--bg-input, #0a1220); border: 1px solid var(--border, #1c2c45);
  border-radius: 14px; padding: 3px 10px; font-size: 12px; color: var(--text-primary, #e6ebf2);
}
.sh-check { font-size: 12px; color: var(--text-secondary, #8a98b0); display: flex; align-items: center; gap: 6px; }
.sh-hint { font-size: 12px; color: var(--text-secondary, #8a98b0); margin: 0; line-height: 1.6; }
.sh-preview {
  background: #fff; border-radius: 6px; padding: 8px; max-height: 320px; overflow: auto;
}
.sh-preview :deep(svg) { width: 100%; height: auto; }
</style>
