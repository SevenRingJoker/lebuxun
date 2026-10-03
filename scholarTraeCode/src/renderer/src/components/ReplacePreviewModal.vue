<script setup lang="ts">
// 替换预览弹窗：承接 SearchPanel 的「替换…」请求。
//
// 流程：加载预览 → 勾选文件（全选/取消）→ 二次确认（应用内，无原生 confirm）→ 落盘 → 结果摘要。
// - 预览列出每个文件的变化行，before/after 红绿着色（公共前后缀压缩，行内标出差异段）；
// - 勾选集合携带预览时刻 matchCount 作为 expectedCount，落盘前由主进程重读复核；
// - 关闭时若已完成替换，emit('applied') 通知面板回刷搜索结果。
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { useWorkspaceStore } from '../stores/workspace'
import type {
  UiSearchParams,
  UiReplacePreview,
  UiReplaceFilePlan,
  UiReplaceChange,
  UiReplaceResult
} from '../api'

const props = defineProps<{
  payload: { params: UiSearchParams; replaceText: string }
}>()
const emit = defineEmits<{
  (e: 'close'): void
  /** 替换已落盘，请求回刷搜索结果 */
  (e: 'applied'): void
}>()

const ws = useWorkspaceStore()
const { t } = useI18n()

// 视图阶段：loading 加载预览 / preview 勾选 / confirm 二次确认 / applying 落盘中 / done 结果摘要
type Phase = 'loading' | 'preview' | 'confirm' | 'applying' | 'done'
const phase = ref<Phase>('loading')
const errorMsg = ref('')
const previewData = ref<UiReplacePreview | null>(null)
const applyResult = ref<UiReplaceResult | null>(null)
/** 勾选文件的绝对路径集合 */
const checked = ref<Set<string>>(new Set())
/** 折叠的文件卡片路径集合 */
const collapsed = ref<Set<string>>(new Set())

// ---------- 计算属性 ----------
/** 可勾选文件：未被跳过且有匹配处 */
const selectableFiles = computed<UiReplaceFilePlan[]>(() =>
  (previewData.value?.files ?? []).filter(f => !f.skipped && f.matchCount > 0)
)
/** 因过大等原因跳过的文件（仅展示，不可勾选） */
const skippedFiles = computed<UiReplaceFilePlan[]>(() =>
  (previewData.value?.files ?? []).filter(f => f.skipped)
)
const allChecked = computed(
  () =>
    selectableFiles.value.length > 0 &&
    selectableFiles.value.every(f => checked.value.has(f.path))
)
const selectedFiles = computed(() =>
  selectableFiles.value.filter(f => checked.value.has(f.path))
)
const selectedMatches = computed(() =>
  selectedFiles.value.reduce((sum, f) => sum + f.matchCount, 0)
)
/** 落盘后实际替换处数合计 */
const totalReplacements = computed(() =>
  applyResult.value ? applyResult.value.applied.reduce((s, f) => s + f.replacements, 0) : 0
)

// ---------- 路径展示 ----------
function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p
}
function relPath(p: string): string {
  const root = (ws.rootPath ?? '').replace(/[\\/]$/, '')
  return root && p.startsWith(root) ? p.slice(root.length + 1) : p
}

// ---------- 行内差异（公共前后缀压缩） ----------
interface InlineParts {
  pre: string
  del: string
  ins: string
  post: string
}
/**
 * 切分 before/after：公共前缀 + 删除段 / 新增段 + 公共后缀。
 * 替换场景通常只有 pattern→replacement 一段变化，压缩后定位精准。
 */
function inlineDiff(before: string, after: string): InlineParts {
  let prefix = 0
  const commonMax = Math.min(before.length, after.length)
  while (prefix < commonMax && before[prefix] === after[prefix]) prefix++
  let suffix = 0
  while (
    suffix < commonMax - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++
  }
  return {
    pre: before.slice(0, prefix),
    del: before.slice(prefix, before.length - suffix),
    ins: after.slice(prefix, after.length - suffix),
    post: before.slice(before.length - suffix)
  }
}
/** WeakMap 缓存：避免模板每次渲染重复计算 */
const partsCache = new WeakMap<UiReplaceChange, InlineParts>()
function parts(c: UiReplaceChange): InlineParts {
  let cached = partsCache.get(c)
  if (!cached) {
    cached = inlineDiff(c.before, c.after)
    partsCache.set(c, cached)
  }
  return cached
}

// ---------- 动作 ----------
/**
 * 脱响应式：把 props 载荷显式构造为普通对象/数组。
 * Vue 的 reactive Proxy 跨越 contextBridge 调用 IPC 时，序列化会静默挂起，
 * 浅展开只处理顶层，嵌套的 includes/excludes 数组仍是 Proxy，故逐字段重建。
 */
function plainPayload(): { params: UiSearchParams; replaceText: string } {
  const p = props.payload.params
  return {
    params: {
      query: p.query,
      caseSensitive: p.caseSensitive,
      wholeWord: p.wholeWord,
      regexMode: p.regexMode,
      includes: Array.from(p.includes ?? []),
      excludes: Array.from(p.excludes ?? [])
    },
    replaceText: props.payload.replaceText
  }
}

/** 加载替换预览 */
async function loadPreview(): Promise<void> {
  phase.value = 'loading'
  errorMsg.value = ''
  if (!ws.rootPath) {
    errorMsg.value = t('search.noWorkspace')
    phase.value = 'preview'
    return
  }
  const { params, replaceText } = plainPayload()
  const res = await window.api.search.replacePreview(ws.rootPath, {
    ...params,
    replaceText
  })
  if (res.ok) {
    previewData.value = res.data
    // 默认勾选全部可替换文件
    checked.value = new Set(selectableFiles.value.map(f => f.path))
    phase.value = 'preview'
  } else {
    errorMsg.value = res.error
    phase.value = 'preview'
  }
}

/** 勾选/取消单个文件 */
function toggleFile(path: string): void {
  const next = new Set(checked.value)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  checked.value = next
}

/** 全选 / 取消全选 */
function toggleAll(): void {
  checked.value = allChecked.value
    ? new Set()
    : new Set(selectableFiles.value.map(f => f.path))
}

/** 折叠/展开文件卡片 */
function toggleCollapse(path: string): void {
  const next = new Set(collapsed.value)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  collapsed.value = next
}

/** 进入二次确认 */
function askConfirm(): void {
  if (selectedFiles.value.length === 0) return
  phase.value = 'confirm'
}

/** 确认后落盘 */
async function doApply(): Promise<void> {
  phase.value = 'applying'
  if (!ws.rootPath) {
    errorMsg.value = t('search.noWorkspace')
    phase.value = 'preview'
    return
  }
  // selections 携带预览时刻 matchCount：主进程落盘前重读复核
  const selections = selectedFiles.value.map(f => ({
    path: f.path,
    expectedCount: f.matchCount
  }))
  const { params, replaceText } = plainPayload()
  const res = await window.api.search.replaceApply(ws.rootPath, {
    ...params,
    replaceText,
    selections
  })
  if (!res.ok) {
    errorMsg.value = res.error
    phase.value = 'preview'
    return
  }
  applyResult.value = res.data
  phase.value = 'done'
}

/** 跳过原因文案 */
function skipReasonText(reason: 'too-large' | 'changed' | 'unreadable'): string {
  if (reason === 'too-large') return t('search.rpReasonTooLarge')
  if (reason === 'changed') return t('search.rpReasonChanged')
  return t('search.rpReasonUnreadable')
}

/** 关闭：done 状态视为需要回刷 */
function onClose(): void {
  if (phase.value === 'done') emit('applied')
  else emit('close')
}

/** Esc：confirm 中返回上一步；applying 中忽略；其余关闭 */
function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  if (phase.value === 'applying') return
  if (phase.value === 'confirm') {
    phase.value = 'preview'
    return
  }
  onClose()
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  void loadPreview()
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div class="modal-overlay" @click.self="onClose">
    <div class="replace-modal">
      <!-- 头部 -->
      <div class="rp-header">
        <span class="rp-title">{{ t('search.rpTitle') }}</span>
        <button class="rp-close" title="Esc" @click="onClose">✕</button>
      </div>

      <!-- 加载中 -->
      <div v-if="phase === 'loading'" class="rp-body center">
        <span class="dot-pulse"></span>{{ t('search.rpLoading') }}
      </div>

      <!-- 预览勾选 -->
      <template v-else-if="phase === 'preview'">
        <div v-if="errorMsg" class="rp-error">⚠ {{ errorMsg }}</div>
        <template v-else-if="previewData">
          <div class="rp-toolbar">
            <button class="link-btn" @click="toggleAll">
              {{ allChecked ? t('search.rpDeselectAll') : t('search.rpSelectAll') }}
            </button>
            <span class="rp-selected-count">
              {{ t('search.rpSelected', {
                selected: selectedFiles.length,
                total: selectableFiles.length
              }) }}
            </span>
          </div>

          <div class="rp-body">
            <!-- 跳过文件（不可勾选） -->
            <div v-for="f in skippedFiles" :key="f.path" class="file-card is-skipped">
              <div class="file-head">
                <span class="g-chev"></span>
                <span class="g-name">{{ baseName(f.path) }}</span>
                <span class="g-rel">{{ relPath(f.path) }}</span>
                <span class="skip-tag">{{ t('search.rpSkipTooLarge') }}</span>
              </div>
            </div>

            <!-- 可替换文件 -->
            <div v-for="f in selectableFiles" :key="f.path" class="file-card">
              <div class="file-head" @click="toggleCollapse(f.path)">
                <span class="g-chev">{{ collapsed.has(f.path) ? '▸' : '▾' }}</span>
                <input
                  :checked="checked.has(f.path)"
                  class="rp-check"
                  type="checkbox"
                  @click.stop="toggleFile(f.path)"
                />
                <span class="g-name">{{ baseName(f.path) }}</span>
                <span class="g-rel">{{ relPath(f.path) }}</span>
                <span class="g-count">{{ f.matchCount }}</span>
              </div>

              <div v-if="!collapsed.has(f.path)" class="change-list">
                <div v-if="f.changes.length === 0" class="no-changes">
                  {{ t('search.rpNoChangedLines') }}
                </div>
                <div v-for="(c, i) in f.changes" :key="i" class="change-pair">
                  <!-- before：红 -->
                  <div class="diff-line line-del">
                    <span class="sign">−</span>
                    <span class="ln">{{ c.lineNumber }}</span>
                    <span class="dt">
                      {{ parts(c).pre }}<b class="hl-del">{{ parts(c).del }}</b>{{ parts(c).post }}
                    </span>
                  </div>
                  <!-- after：青绿 -->
                  <div class="diff-line line-ins">
                    <span class="sign">+</span>
                    <span class="ln">{{ c.lineNumber }}</span>
                    <span class="dt">
                      {{ parts(c).pre }}<b class="hl-ins">{{ parts(c).ins }}</b>{{ parts(c).post }}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="rp-footer">
            <button class="cp-btn" @click="onClose">{{ t('common.cancel') }}</button>
            <button
              class="cp-btn cp-btn-primary"
              :disabled="selectedFiles.length === 0"
              @click="askConfirm"
            >
              {{ t('search.rpApply', { n: selectedFiles.length }) }}
            </button>
          </div>
        </template>
      </template>

      <!-- 二次确认 -->
      <div v-else-if="phase === 'confirm'" class="rp-body confirm-body">
        <div class="confirm-icon">⚠</div>
        <div class="confirm-title">{{ t('search.rpConfirmTitle') }}</div>
        <div class="confirm-text">
          {{ t('search.rpConfirmBody', {
            files: selectedFiles.length,
            matches: selectedMatches
          }) }}
        </div>
        <div class="confirm-actions">
          <button class="cp-btn" @click="phase = 'preview'">
            {{ t('search.rpConfirmBack') }}
          </button>
          <button class="rp-btn-danger" @click="doApply">
            {{ t('search.rpConfirmOk') }}
          </button>
        </div>
      </div>

      <!-- 落盘中 -->
      <div v-else-if="phase === 'applying'" class="rp-body center">
        <span class="dot-pulse"></span>{{ t('search.rpApplying') }}
      </div>

      <!-- 结果摘要 -->
      <div v-else-if="phase === 'done' && applyResult" class="rp-body done-body">
        <div class="done-icon">✓</div>
        <div class="done-title">{{ t('search.rpDoneTitle') }}</div>
        <div class="done-summary">
          {{ t('search.rpDoneSummary', {
            files: applyResult.applied.length,
            replacements: totalReplacements
          }) }}
        </div>
        <div v-if="applyResult.skipped.length > 0" class="done-skipped">
          <div class="done-skipped-title">
            {{ t('search.rpSkippedTitle', { n: applyResult.skipped.length }) }}
          </div>
          <div v-for="s in applyResult.skipped" :key="s.path" class="skip-line">
            <span class="g-name">{{ baseName(s.path) }}</span>
            <span class="skip-reason">{{ skipReasonText(s.reason) }}</span>
          </div>
        </div>
        <div class="rp-footer">
          <button class="cp-btn cp-btn-primary" @click="onClose">
            {{ t('search.rpClose') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 2000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
}
.replace-modal {
  width: 680px;
  max-width: calc(100vw - 48px);
  max-height: 82vh;
  display: flex;
  flex-direction: column;
  border-radius: 10px;
  border: 1px solid var(--border-light);
  background: var(--bg-secondary);
  box-shadow: 0 0 0 1px var(--border-glow), 0 12px 40px rgba(0, 0, 0, 0.5);
  overflow: hidden;
}

/* 头部 */
.rp-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
}
.rp-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}
.rp-close {
  border: none;
  background: none;
  color: var(--text-muted);
  font-size: 13px;
  cursor: pointer;
  padding: 2px 6px;
}
.rp-close:hover {
  color: var(--text-primary);
}

/* 工具行 */
.rp-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border);
}
.rp-selected-count {
  font-size: 12px;
  color: var(--text-muted);
}

/* 主体 */
.rp-body {
  flex: 1;
  overflow-y: auto;
  padding: 10px 14px;
}
.rp-body.center {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--text-muted);
  font-size: 13px;
  padding: 40px 16px;
}
.rp-error {
  margin: 16px;
  padding: 10px 12px;
  border-radius: 6px;
  border: 1px solid var(--danger);
  color: var(--danger);
  font-size: 12px;
}

/* 文件卡片 */
.file-card {
  border: 1px solid var(--border);
  border-radius: 8px;
  margin-bottom: 8px;
  overflow: hidden;
  background: var(--bg-panel);
}
.file-card.is-skipped {
  opacity: 0.65;
}
.file-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  cursor: pointer;
  user-select: none;
}
.g-chev {
  width: 12px;
  color: var(--text-muted);
  font-size: 10px;
}
.g-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
}
.g-rel {
  font-size: 11px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.g-count {
  margin-left: auto;
  min-width: 20px;
  padding: 0 6px;
  border-radius: 9px;
  font-size: 11px;
  text-align: center;
  color: var(--accent);
  background: var(--accent-dim);
  border: 1px solid var(--border-glow);
}
.skip-tag {
  margin-left: auto;
  font-size: 11px;
  color: var(--danger);
}
.rp-check {
  margin: 0;
  accent-color: var(--accent);
  cursor: pointer;
}

/* 变化行 */
.change-list {
  border-top: 1px solid var(--border);
  padding: 6px 0;
}
.no-changes {
  padding: 6px 12px;
  font-size: 11px;
  color: var(--text-muted);
}
.change-pair {
  margin: 2px 0;
}
.diff-line {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 1px 10px;
  font-size: 12px;
  line-height: 1.6;
}
.diff-line .sign {
  width: 10px;
  font-weight: 700;
  flex-shrink: 0;
}
.diff-line .ln {
  width: 34px;
  text-align: right;
  color: var(--text-muted);
  opacity: 0.7;
  flex-shrink: 0;
  user-select: none;
}
.diff-line .dt {
  white-space: pre-wrap;
  word-break: break-all;
}
.line-del {
  background: rgba(255, 82, 112, 0.1);
}
.line-del .sign,
.line-del .hl-del {
  color: var(--danger);
}
.hl-del {
  background: rgba(255, 82, 112, 0.25);
  border-radius: 2px;
}
.line-ins {
  background: rgba(0, 229, 255, 0.08);
}
.line-ins .sign,
.line-ins .hl-ins {
  color: var(--accent);
}
.hl-ins {
  background: rgba(0, 229, 255, 0.22);
  border-radius: 2px;
}

/* 底部 */
.rp-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
}

/* 危险按钮（本组件内自定义） */
.rp-btn-danger {
  padding: 6px 14px;
  border-radius: 6px;
  font-size: 13px;
  color: var(--danger);
  background: rgba(255, 82, 112, 0.12);
  border: 1px solid var(--danger);
  cursor: pointer;
  transition: all 0.15s;
}
.rp-btn-danger:hover {
  background: rgba(255, 82, 112, 0.25);
  box-shadow: 0 0 8px rgba(255, 82, 112, 0.4);
}

/* 二次确认 */
.confirm-body {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 36px 24px 20px;
}
.confirm-icon {
  font-size: 34px;
  color: var(--danger);
  text-shadow: 0 0 14px rgba(255, 82, 112, 0.6);
  margin-bottom: 14px;
}
.confirm-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 10px;
}
.confirm-text {
  font-size: 13px;
  color: var(--text-muted);
  line-height: 1.7;
  max-width: 420px;
}
.confirm-actions {
  display: flex;
  gap: 10px;
  margin-top: 24px;
}

/* 结果摘要 */
.done-body {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 30px 24px 10px;
}
.done-icon {
  width: 46px;
  height: 46px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
  color: var(--success);
  border: 1px solid var(--success);
  box-shadow: 0 0 16px rgba(34, 197, 94, 0.4);
  margin-bottom: 14px;
}
.done-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}
.done-summary {
  font-size: 13px;
  color: var(--text-muted);
  margin-top: 8px;
}
.done-skipped {
  width: 100%;
  margin-top: 18px;
  text-align: left;
  border-top: 1px solid var(--border);
  padding-top: 10px;
}
.done-skipped-title {
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 6px;
}
.skip-line {
  display: flex;
  justify-content: space-between;
  padding: 4px 6px;
  font-size: 12px;
}
.skip-reason {
  color: var(--danger);
}
.done-body .rp-footer {
  width: 100%;
  border-top: none;
  margin-top: 10px;
}
</style>
