<script setup lang="ts">
// 验证锁面板：展示与编辑当前会话的 artifact manifest，手动触发收尾校验。
// 通过 window.api.validation.* IPC 与主进程交互（handlers/validation.ts 6 通道）。
// 禁用原生 confirm/alert：删除规则用内联二次确认状态，结果反馈用应用内文本。
import { ref, computed, onMounted } from 'vue'
import type {
  UiArtifactManifest,
  UiValidationRule,
  UiValidationSummary,
  UiValidationCtxSnap
} from '../api'

// 本地可编辑 manifest 副本（深拷贝自 getCurrent，编辑不直接影响主进程单例直到保存）
const manifest = ref<UiArtifactManifest>({ id: 'custom', rules: [] })
// 当前会话 ctx 快照（runValidation 用；无活动任务时为 null）
const ctxSnap = ref<UiValidationCtxSnap | null>(null)
const busy = ref(false)
const message = ref('')
// 手动触发的校验结果（展示 failed 列表）
const summary = ref<UiValidationSummary | null>(null)
// JSON 模式编辑
const jsonMode = ref(false)
const jsonText = ref('')
const jsonError = ref('')
// 删除确认状态：首次点击标红提示「再点确认」，二次点击才真正删除（替代原生 confirm）
const pendingRemove = ref<string | null>(null)

const kindOptions: UiValidationRule['kind'][] = ['fileExists', 'contentMatch', 'commandExecuted', 'custom']
const severityOptions: NonNullable<UiValidationRule['severity']>[] = ['block', 'warn']

const hasActivity = computed(() => ctxSnap.value !== null)

/** 从主进程加载当前会话 manifest + ctx 快照（深拷贝 manifest 供本地编辑） */
async function loadCurrent(): Promise<void> {
  busy.value = true
  try {
    const st = await window.api.validation.getCurrent()
    ctxSnap.value = st.ctx
    if (st.manifest) {
      // 深拷贝避免直接修改主进程返回的对象引用
      manifest.value = JSON.parse(JSON.stringify(st.manifest))
    } else {
      manifest.value = { id: 'custom', rules: [] }
    }
    summary.value = null
    message.value = ''
  } finally {
    busy.value = false
  }
}

/** 新增一条规则（默认 fileExists + block） */
function addRule(): void {
  const n = manifest.value.rules.length + 1
  manifest.value.rules.push({
    id: `rule-${n}`,
    description: '新规则描述',
    kind: 'fileExists',
    severity: 'block'
  })
}

/** 删除规则：二次点击确认（禁原生 confirm，pendingRemove 标记首次点击） */
function removeRule(id: string): void {
  if (pendingRemove.value === id) {
    manifest.value.rules = manifest.value.rules.filter((r) => r.id !== id)
    pendingRemove.value = null
  } else {
    pendingRemove.value = id
  }
}

/** 进入 JSON 编辑模式：序列化当前 manifest 到 textarea */
function enterJsonMode(): void {
  jsonText.value = JSON.stringify(manifest.value, null, 2)
  jsonError.value = ''
  jsonMode.value = true
}

/** 应用 JSON 编辑：交主进程 parseManifest 校验结构，合法则替换本地 manifest */
async function applyJson(): Promise<void> {
  const parsed = await window.api.validation.parseManifest(jsonText.value)
  if (!parsed) {
    jsonError.value = '解析失败：JSON 不合法或缺少 id/rules 字段'
    return
  }
  manifest.value = JSON.parse(JSON.stringify(parsed))
  jsonError.value = ''
  jsonMode.value = false
}

/** 保存到主进程单例（影响下一次收尾校验） */
async function save(): Promise<void> {
  busy.value = true
  try {
    await window.api.validation.setCurrent(manifest.value)
    message.value = '✅ 已保存（下一次收尾校验将使用此 manifest）'
  } finally {
    busy.value = false
  }
}

/** 手动触发一次校验（用当前 ctx 快照跑 manifest 全部规则） */
async function runCheck(): Promise<void> {
  if (!ctxSnap.value) {
    message.value = '⚠ 当前无活动任务，无法获取 ctx 快照（启动 AI 任务后再触发）'
    return
  }
  busy.value = true
  try {
    const s = await window.api.validation.runValidation(manifest.value, ctxSnap.value)
    summary.value = s
    const msg = await window.api.validation.formatMessage(s, ctxSnap.value)
    message.value = s.allPassed
      ? '✅ 全部通过（允许收尾）'
      : msg || `🚫 未通过 ${s.failed.length} 项`
  } finally {
    busy.value = false
  }
}

onMounted(loadCurrent)
</script>

<template>
  <div class="validation-panel">
    <div class="vp-header">
      <span class="vp-title">验证锁</span>
      <span class="vp-activity" :class="{ active: hasActivity }">
        {{ hasActivity ? '任务运行中' : '无活动任务' }}
      </span>
      <button class="vp-btn" @click="loadCurrent" :disabled="busy">刷新</button>
    </div>

    <!-- JSON 模式 -->
    <div v-if="jsonMode" class="vp-section">
      <div class="vp-section-title">JSON 编辑</div>
      <textarea v-model="jsonText" class="vp-json" rows="14" spellcheck="false"></textarea>
      <div v-if="jsonError" class="vp-error">{{ jsonError }}</div>
      <div class="vp-row">
        <button class="vp-btn primary" @click="applyJson">应用</button>
        <button class="vp-btn" @click="jsonMode = false">取消</button>
      </div>
    </div>

    <!-- 表格编辑模式 -->
    <template v-else>
      <div class="vp-section">
        <div class="vp-section-title">产物清单 (manifest)</div>
        <div class="vp-row">
          <label class="vp-label">id</label>
          <input v-model="manifest.id" class="vp-input" placeholder="manifest 标识" />
        </div>
      </div>

      <div class="vp-section">
        <div class="vp-section-title">
          <span>规则 ({{ manifest.rules.length }})</span>
          <button class="vp-btn mini" @click="addRule">+ 新增</button>
          <button class="vp-btn mini" @click="enterJsonMode">JSON</button>
        </div>
        <div v-if="!manifest.rules.length" class="vp-empty">暂无规则（点击「+ 新增」或「JSON」加载）</div>
        <div v-for="r in manifest.rules" :key="r.id" class="vp-rule">
          <div class="vp-rule-row">
            <input v-model="r.id" class="vp-input vp-col-id" placeholder="id" />
            <select v-model="r.kind" class="vp-input vp-col-kind">
              <option v-for="k in kindOptions" :key="k" :value="k">{{ k }}</option>
            </select>
            <select v-model="r.severity" class="vp-input vp-col-sev">
              <option v-for="s in severityOptions" :key="s" :value="s">{{ s }}</option>
            </select>
            <button
              class="vp-btn mini danger"
              :class="{ confirming: pendingRemove === r.id }"
              @click="removeRule(r.id)"
            >{{ pendingRemove === r.id ? '再点确认删除' : '×' }}</button>
          </div>
          <input v-model="r.description" class="vp-input" placeholder="缺失时的提示文案" />
          <input
            v-if="r.kind === 'fileExists' || r.kind === 'contentMatch'"
            v-model="r.path"
            class="vp-input"
            placeholder="path（相对工作区路径）"
          />
          <input
            v-if="r.kind === 'commandExecuted'"
            v-model="r.command"
            class="vp-input"
            placeholder="command（命令文本子串，如 npm install）"
          />
          <input
            v-if="r.kind === 'contentMatch'"
            v-model="r.pattern"
            class="vp-input"
            placeholder="pattern（内容正则/字符串）"
          />
        </div>
      </div>

      <div class="vp-row vp-actions">
        <button class="vp-btn primary" @click="save" :disabled="busy">保存</button>
        <button class="vp-btn" @click="runCheck" :disabled="busy">手动触发校验</button>
      </div>

      <div v-if="message" class="vp-message" :class="{ ok: message.startsWith('✅') }">{{ message }}</div>

      <!-- 未通过项列表 -->
      <div v-if="summary && !summary.allPassed" class="vp-section">
        <div class="vp-section-title">未通过项 ({{ summary.failed.length }})</div>
        <div v-for="f in summary.failed" :key="f.ruleId" class="vp-failed">
          <span class="vp-failed-id">{{ f.ruleId }}</span>
          <span class="vp-failed-msg">{{ f.message }}</span>
          <span class="vp-failed-sev">{{ f.severity }}</span>
        </div>
      </div>

      <!-- ctx 快照 -->
      <div v-if="ctxSnap" class="vp-section">
        <div class="vp-section-title">ctx 快照</div>
        <div class="vp-ctx">已创建 {{ ctxSnap.createdFiles.length }} 个文件：{{ ctxSnap.createdFiles.join('、') || '（空）' }}</div>
        <div class="vp-ctx">已执行命令：{{ Object.keys(ctxSnap.executedCommands).join('、') || '（无）' }}</div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.validation-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px;
  font-size: 12px;
  color: var(--fg-primary);
}
.vp-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border);
}
.vp-title { font-weight: 600; flex: 1; }
.vp-activity {
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 11px;
  background: var(--bg-secondary);
  color: var(--fg-muted);
}
.vp-activity.active { background: #22c55e22; color: #22c55e; }
.vp-section { display: flex; flex-direction: column; gap: 4px; }
.vp-section-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  color: var(--fg-muted);
  font-size: 11px;
}
.vp-row { display: flex; gap: 6px; align-items: center; }
.vp-label { color: var(--fg-muted); font-size: 11px; min-width: 24px; }
.vp-input {
  flex: 1;
  padding: 4px 6px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--fg-primary);
  font-size: 12px;
}
.vp-col-id { flex: 1.2; }
.vp-col-kind, .vp-col-sev { flex: 0 0 110px; }
.vp-btn {
  padding: 4px 8px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--fg-primary);
  cursor: pointer;
  font-size: 11px;
}
.vp-btn:hover:not(:disabled) { background: var(--bg-hover); }
.vp-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.vp-btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.vp-btn.danger { background: #ef444422; border-color: #ef4444; color: #ef4444; }
.vp-btn.danger.confirming { background: #ef4444; color: #fff; }
.vp-btn.mini { padding: 2px 6px; font-size: 10px; }
.vp-actions { gap: 6px; }
.vp-rule {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 4px;
}
.vp-rule-row { display: flex; gap: 4px; align-items: center; }
.vp-empty { color: var(--fg-muted); font-style: italic; padding: 8px 4px; }
.vp-message {
  padding: 6px 8px;
  border-radius: 4px;
  background: var(--bg-secondary);
  word-break: break-all;
}
.vp-message.ok { background: #22c55e22; color: #22c55e; }
.vp-error { color: #ef4444; font-size: 11px; }
.vp-json {
  width: 100%;
  padding: 6px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--fg-primary);
  font-family: monospace;
  font-size: 11px;
  resize: vertical;
}
.vp-failed {
  display: flex;
  gap: 6px;
  padding: 3px 4px;
  background: #ef444422;
  border-radius: 3px;
  font-family: monospace;
  font-size: 11px;
}
.vp-failed-id { color: #ef4444; min-width: 60px; }
.vp-failed-msg { flex: 1; word-break: break-all; }
.vp-failed-sev { color: var(--fg-muted); }
.vp-ctx { color: var(--fg-muted); word-break: break-all; font-size: 11px; }
</style>
