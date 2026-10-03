<script setup lang="ts">
// 问题面板：汇总 LSP 诊断，按文件分组，点击条目打开文件并跳转到对应行列。
// 数据来自 lspClient（publishDiagnostics 实时推送），自身只做展示与跳转。
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { lspClient } from '../lsp/lspClient'
import { useWorkspaceStore } from '../stores/workspace'
import { uriToPath } from '@shared/lsp/converter'
import { LspDiagnosticSeverity, type LspDiagnostic } from '@shared/lsp/types'

const { t } = useI18n()
const ws = useWorkspaceStore()

/** 拉取全部诊断并拍平为条目（含文件路径与相对路径） */
const entries = computed(() => {
  // 建立响应式依赖：每次 publishDiagnostics 版本号变化时重算
  void lspClient.diagnosticsVersion.value
  const all = lspClient.getAllDiagnostics()
  const list: Array<{
    uri: string
    absPath: string
    relPath: string
    line: number
    column: number
    severity: LspDiagnosticSeverity | undefined
    message: string
    source?: string
  }> = []
  for (const { uri, diagnostics } of all) {
    const absPath = uriToPath(uri)
    const relPath = ws.rootPath && absPath.startsWith(ws.rootPath)
      ? absPath.slice(ws.rootPath.length + 1)
      : absPath
    for (const d of diagnostics) {
      list.push({
        uri,
        absPath,
        relPath,
        line: d.range.start.line + 1,
        column: d.range.start.character + 1,
        severity: d.severity,
        message: d.message,
        source: d.source
      })
    }
  }
  // 错误优先，其次警告，再按文件、行号排序
  const rank = (s?: LspDiagnosticSeverity): number => s ?? LspDiagnosticSeverity.Error
  list.sort((a, b) =>
    rank(a.severity) - rank(b.severity) ||
    a.relPath.localeCompare(b.relPath) ||
    a.line - b.line
  )
  return list
})

/** 严重度统计（供头部徽章） */
const errorCount = computed(() =>
  entries.value.filter((e) => (e.severity ?? LspDiagnosticSeverity.Error) === LspDiagnosticSeverity.Error).length
)
const warningCount = computed(() =>
  entries.value.filter((e) => e.severity === LspDiagnosticSeverity.Warning).length
)

/** 严重度样式与图标 */
function severityClass(d: LspDiagnosticSeverity | undefined): string {
  switch (d) {
    case LspDiagnosticSeverity.Error: return 'sev-error'
    case LspDiagnosticSeverity.Warning: return 'sev-warning'
    case LspDiagnosticSeverity.Information: return 'sev-info'
    case LspDiagnosticSeverity.Hint: return 'sev-hint'
    default: return 'sev-error'
  }
}
function severityIcon(d: LspDiagnosticSeverity | undefined): string {
  switch (d) {
    case LspDiagnosticSeverity.Error: return '✕'
    case LspDiagnosticSeverity.Warning: return '⚠'
    case LspDiagnosticSeverity.Information: return 'ℹ'
    case LspDiagnosticSeverity.Hint: return '…'
    default: return '✕'
  }
}

/** 点击条目：打开文件并跳转（跳转由 workspace store 透传给 EditorPanel） */
async function jump(e: { absPath: string; line: number; column: number }): Promise<void> {
  await ws.openFile(e.absPath)
  ws.requestReveal(e.line, e.column)
}
</script>

<template>
  <div class="problems-panel">
    <!-- 头部：错误/警告计数 -->
    <div class="problems-summary">
      <span v-if="errorCount > 0" class="badge error">✕ {{ errorCount }}</span>
      <span v-if="warningCount > 0" class="badge warning">⚠ {{ warningCount }}</span>
      <span v-if="entries.length === 0" class="clean">{{ t('problems.empty') }}</span>
    </div>

    <!-- 诊断条目列表 -->
    <div class="problems-list" role="list">
      <div
        v-for="(e, i) in entries"
        :key="i"
        class="problem-item"
        :class="severityClass(e.severity)"
        role="listitem"
        @click="void jump(e)"
      >
        <span class="p-icon">{{ severityIcon(e.severity) }}</span>
        <div class="p-body">
          <div class="p-message">{{ e.message }}</div>
          <div class="p-location">
            <span class="p-file">{{ e.relPath }}</span>
            <span class="p-pos">[{{ e.line }}, {{ e.column }}]</span>
            <span v-if="e.source" class="p-source">{{ e.source }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.problems-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

/* 头部计数行 */
.problems-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--cp-border, rgba(0, 229, 255, 0.15));
  font-size: 12px;
}
.badge {
  padding: 1px 7px;
  border-radius: 9px;
  font-weight: 600;
}
.badge.error {
  color: #ff6b81;
  background: rgba(255, 107, 129, 0.12);
}
.badge.warning {
  color: #ffb84d;
  background: rgba(255, 184, 77, 0.12);
}
.clean {
  color: #2ee6a6;
}

/* 条目列表 */
.problems-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}
.problem-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 7px 12px;
  cursor: pointer;
  border-left: 2px solid transparent;
}
.problem-item:hover {
  background: rgba(0, 229, 255, 0.06);
}
.p-icon {
  flex-shrink: 0;
  width: 16px;
  font-size: 11px;
  font-weight: 700;
  text-align: center;
  margin-top: 1px;
}
.sev-error .p-icon, .sev-error { border-left-color: #ff6b81; }
.sev-error .p-icon { color: #ff6b81; }
.sev-warning .p-icon { color: #ffb84d; }
.sev-info .p-icon { color: #4db8ff; }
.sev-hint .p-icon { color: #8a93a6; }

.p-body {
  min-width: 0;
  flex: 1;
}
.p-message {
  font-size: 12px;
  line-height: 1.45;
  color: var(--cp-text, #d6e4f0);
  word-break: break-word;
}
.p-location {
  display: flex;
  gap: 6px;
  margin-top: 2px;
  font-size: 11px;
  color: var(--cp-text-dim, #7a8699);
}
.p-file {
  color: var(--cp-accent, #00e5ff);
  word-break: break-all;
}
</style>
