<script setup lang="ts">
// s48 执行时间线面板：按时间倒序列出工具步骤，支持展开理由/diff/结果；
// 失败步骤红色标记并可「从此步重跑」（经任务快照回到该轮后续跑）。
import { computed } from 'vue'
import { useTimelineStore } from '../stores/timeline'
import { useWorkspaceStore } from '../stores/workspace'

const tl = useTimelineStore()
const ws = useWorkspaceStore()

// 倒序展示（最近步骤在最上）
const ordered = computed(() => [...tl.steps].reverse())

const STATUS_ICON: Record<string, string> = {
  running: '◌',
  ok: '✔',
  fail: '✗',
  cancelled: '⊘'
}

function isExpanded(id: number): boolean {
  return tl.expanded.has(id)
}

function fmtDuration(ms?: number): string {
  if (ms === undefined) return ''
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

async function onRerun(stepId: number): Promise<void> {
  const step = tl.steps.find((s) => s.id === stepId)
  if (!step || !ws.rootPath) return
  await tl.rerun(ws.rootPath, step)
}
</script>

<template>
  <div v-if="tl.visible" class="tl-overlay" @click.self="tl.close()">
    <div class="tl-panel cp-glass">
      <header class="tl-head">
        <span class="tl-title">⏱ 执行时间线</span>
        <span class="tl-count">{{ tl.steps.length }} 步</span>
        <span class="tl-spacer"></span>
        <button class="tl-x" title="关闭" @click="tl.close()">×</button>
      </header>

      <div class="tl-body">
        <div v-if="ordered.length === 0" class="tl-empty">
          暂无执行记录——发起带工具的任务后，每一步都会固化到这里。
        </div>

        <div
          v-for="s in ordered"
          :key="s.id"
          class="tl-step"
          :class="'st-' + s.status"
        >
          <div class="tl-row" @click="tl.toggleExpand(s.id)">
            <span class="tl-icon">{{ STATUS_ICON[s.status] }}</span>
            <span class="tl-name">{{ s.name }}</span>
            <span class="tl-brief" :title="s.title">{{ s.title }}</span>
            <span class="tl-round">R{{ s.round }}</span>
            <span class="tl-dur">{{ fmtDuration(s.durationMs) }}</span>
          </div>

          <!-- 展开区：AI 理由 / diff 摘要 / 结果尾部 / 重跑 -->
          <div v-if="isExpanded(s.id)" class="tl-detail">
            <div v-if="s.reason" class="tl-field">
              <span class="tl-k">理由</span>
              <pre class="tl-pre">{{ s.reason }}</pre>
            </div>
            <div v-if="s.diffSummary" class="tl-field">
              <span class="tl-k">改动</span>
              <span class="tl-v">{{ s.diffSummary }}</span>
            </div>
            <div v-if="s.resultTail" class="tl-field">
              <span class="tl-k">结果</span>
              <pre class="tl-pre">{{ s.resultTail }}</pre>
            </div>
            <button v-if="s.status === 'fail'" class="tl-rerun" @click="onRerun(s.id)">
              ↻ 从此步重跑
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 科技蓝青暗色，与 RepairCard/StagingPanel 同色系 */
.tl-overlay {
  position: fixed; inset: 0; z-index: 88;
  background: rgba(2, 6, 12, 0.55);
  display: flex; justify-content: flex-end;
}
.tl-panel {
  width: 620px; max-width: 92vw; height: 100%;
  border-left: 1px solid rgba(0, 212, 255, 0.3);
  border-radius: 0;
  display: flex; flex-direction: column;
}
.tl-head {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid rgba(0, 212, 255, 0.2);
}
.tl-title { font-weight: 700; color: #5ff0e2; letter-spacing: 1px; }
.tl-count { font-size: 11px; color: #7a8499; }
.tl-spacer { flex: 1; }
.tl-x {
  background: none; border: none; color: #7a8499; cursor: pointer; font-size: 16px;
}
.tl-x:hover { color: #fff; }

.tl-body { flex: 1; overflow: auto; padding: 8px 10px; }
.tl-empty { padding: 40px 16px; text-align: center; color: #7a8499; font-size: 12px; }

.tl-step {
  margin: 4px 0; border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.06);
  background: rgba(255, 255, 255, 0.02);
}
.tl-step.st-fail {
  border-color: rgba(255, 107, 107, 0.45);
  background: rgba(255, 107, 107, 0.06);
}
.tl-step.st-running .tl-icon { animation: tl-pulse 1.1s ease-in-out infinite; }
@keyframes tl-pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.35 } }

.tl-row {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 10px; cursor: pointer; font-size: 12px;
}
.tl-icon { width: 16px; text-align: center; font-weight: 700; color: #5ff0e2; }
.st-fail .tl-icon { color: #ff9d9d; }
.st-cancelled .tl-icon { color: #7a8499; }
.st-ok .tl-icon { color: #5ff0e2; }
.tl-name { color: #b8e6ff; font-family: monospace; min-width: 96px; }
.tl-brief {
  flex: 1; color: #8b95ab; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.tl-round { font-size: 10px; color: #5a6478; font-family: monospace; }
.tl-dur { font-size: 10px; color: #5a6478; min-width: 42px; text-align: right; }

.tl-detail {
  padding: 2px 12px 10px 34px; font-size: 11px;
}
.tl-field { margin: 6px 0; }
.tl-k {
  display: inline-block; margin-right: 8px; padding: 0 6px; border-radius: 3px;
  background: rgba(0, 212, 255, 0.1); color: #5ff0e2; font-size: 10px;
}
.tl-v { color: #b8c2d9; word-break: break-all; }
.tl-pre {
  margin: 4px 0 0; padding: 6px 8px; border-radius: 6px;
  background: rgba(0, 0, 0, 0.3); color: #b8c2d9;
  white-space: pre-wrap; word-break: break-all; font-family: inherit;
}
.tl-rerun {
  margin-top: 8px; padding: 4px 12px; border-radius: 5px; cursor: pointer;
  background: rgba(255, 107, 107, 0.12); border: 1px solid rgba(255, 107, 107, 0.45);
  color: #ff9d9d; font-size: 11px;
}
.tl-rerun:hover { background: rgba(255, 107, 107, 0.22); }
</style>
