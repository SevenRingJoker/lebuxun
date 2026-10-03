<script setup lang="ts">
// 搜索面板：左侧「搜索」Tab 的全局内容搜索（ripgrep 引擎）。
//
// 能力：
// - 搜索框（回车即搜 / 输入防抖自动搜）、区分大小写 Aa、全字、正则三个开关；
// - 高级区：include / exclude glob（逗号或空白分隔）；
// - 文件分组结果树：组可折叠，匹配行实时高亮，点击打开文件并定位行列；
// - 替换入口：切换替换行，点击「替换…」打开 ReplacePreviewModal（预览勾选/二次确认/落盘）。
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { useWorkspaceStore } from '../stores/workspace'
import ReplacePreviewModal from './ReplacePreviewModal.vue'
import type { UiSearchParams, UiSearchResult, UiSearchFileGroup } from '../api'

const ws = useWorkspaceStore()
const { t } = useI18n()

// ---------- 搜索条件 ----------
const query = ref('')
const caseSensitive = ref(false)
const wholeWord = ref(false)
const regexMode = ref(false)
const includesText = ref('')
const excludesText = ref('')
const advancedVisible = ref(false)

// ---------- 结果状态 ----------
const loading = ref(false)
const errorMsg = ref('')
const result = ref<UiSearchResult | null>(null)
const hasSearched = ref(false)
/** 折叠的文件组路径集合 */
const collapsedPaths = ref<Set<string>>(new Set())

// ---------- 替换入口 ----------
const replaceVisible = ref(false)
const replaceText = ref('')
/** 打开替换预览弹窗的载荷（null 时弹窗关闭） */
const replacePayload = ref<{ params: UiSearchParams; replaceText: string } | null>(null)

/** glob 文本切分：逗号（含中文逗号）或空白分隔，去空项 */
function splitGlob(text: string): string[] {
  return text.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean)
}

/** 构造 IPC 搜索参数 */
function buildParams(): UiSearchParams {
  return {
    query: query.value,
    caseSensitive: caseSensitive.value,
    wholeWord: wholeWord.value,
    regexMode: regexMode.value,
    includes: splitGlob(includesText.value),
    excludes: splitGlob(excludesText.value)
  }
}

/** 请求序号：丢弃过期响应，防止旧搜索覆盖新结果 */
let searchToken = 0
let debounceTimer: number | null = null

/** 防抖调度搜索 */
function scheduleSearch(delay = 320): void {
  if (debounceTimer !== null) window.clearTimeout(debounceTimer)
  debounceTimer = window.setTimeout(() => {
    void runSearch()
  }, delay)
}

/** 执行搜索 */
async function runSearch(): Promise<void> {
  if (debounceTimer !== null) {
    window.clearTimeout(debounceTimer)
    debounceTimer = null
  }
  if (!ws.rootPath) {
    errorMsg.value = t('search.noWorkspace')
    return
  }
  if (!query.value) return

  const token = ++searchToken
  loading.value = true
  errorMsg.value = ''
  try {
    const res = await window.api.search.query(ws.rootPath, buildParams())
    // 过期响应直接丢弃（用户已发起更新的搜索）
    if (token !== searchToken) return
    if (res.ok) {
      result.value = res.data
      hasSearched.value = true
      // 新一轮结果默认展开全部文件组
      collapsedPaths.value = new Set()
    } else {
      errorMsg.value = res.error
      result.value = null
    }
  } catch (e) {
    if (token === searchToken) {
      errorMsg.value = e instanceof Error ? e.message : String(e)
    }
  } finally {
    if (token === searchToken) loading.value = false
  }
}

/** 回车立即搜索 */
function onEnterSearch(): void {
  void runSearch()
}

// 条件变化：防抖自动重搜（查询 320ms，选项/glob 立即但仍走 120ms 合并快速连点）
watch(query, () => scheduleSearch(320))
watch([caseSensitive, wholeWord, regexMode, includesText, excludesText], () => {
  if (hasSearched.value || query.value) scheduleSearch(120)
})
// 工作区切换：清空旧结果（不自动搜索）
watch(
  () => ws.rootPath,
  () => {
    searchToken++
    result.value = null
    hasSearched.value = false
    errorMsg.value = ''
  }
)

onBeforeUnmount(() => {
  if (debounceTimer !== null) window.clearTimeout(debounceTimer)
})

// ---------- 高亮（与主进程 buildReplaceRegExp 同源） ----------
/** 字面量元字符转义 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 高亮正则源码：按开关组合字面量/正则 + 全词环视 */
const highlightSource = computed(() => {
  let src = regexMode.value ? query.value : escapeRegExp(query.value)
  if (wholeWord.value) {
    src = `(?<![A-Za-z0-9_])(?:${src})(?![A-Za-z0-9_])`
  }
  return src
})

interface Segment {
  text: string
  hit: boolean
}

/** 把行文本按匹配切成片段（高亮用）；非法正则降级为纯文本 */
function splitByHits(line: string): Segment[] {
  if (!query.value) return [{ text: line, hit: false }]
  let re: RegExp
  try {
    re = new RegExp(highlightSource.value, 'g' + (caseSensitive.value ? '' : 'i'))
  } catch {
    return [{ text: line, hit: false }]
  }
  const segs: Segment[] = []
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) segs.push({ text: line.slice(last, m.index), hit: false })
    segs.push({ text: m[0], hit: true })
    last = m.index + m[0].length
    // 防御零宽匹配死循环
    if (m[0].length === 0) re.lastIndex++
  }
  if (last < line.length) segs.push({ text: line.slice(last), hit: false })
  return segs
}

// ---------- 文件组展示与交互 ----------
/** 组折叠切换 */
function toggleGroup(path: string): void {
  const next = new Set(collapsedPaths.value)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  collapsedPaths.value = next
}

/** 工作区相对路径（组副标题） */
function relPath(p: string): string {
  const root = ws.rootPath
  if (root && p.startsWith(root)) {
    return p.slice(root.length + 1).replace(/\\/g, '/')
  }
  return p
}

/** 文件名（组主标题） */
function baseName(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1]
}

/** 点击匹配行：打开文件并定位到首个匹配列 */
async function jumpTo(group: UiSearchFileGroup, lineNumber: number, preview: string): Promise<void> {
  await ws.openFile(group.path)
  let column = 1
  try {
    const re = new RegExp(highlightSource.value, caseSensitive.value ? '' : 'i')
    const m = re.exec(preview)
    if (m) column = m.index + 1
  } catch {
    /* 非法正则时定位到行首 */
  }
  ws.requestReveal(lineNumber, column)
}

/** 点击「替换…」：打开替换预览弹窗 */
function requestReplace(): void {
  if (!result.value || result.value.totalMatches === 0) return
  replacePayload.value = { params: buildParams(), replaceText: replaceText.value }
}

/** 替换落盘后：关闭弹窗并回刷搜索结果 */
function onReplaceApplied(): void {
  replacePayload.value = null
  void runSearch()
}
</script>

<template>
  <div class="search-panel">
    <!-- 搜索输入行 -->
    <div class="search-row">
      <input
        v-model="query"
        class="cp-search-input"
        type="text"
        spellcheck="false"
        :placeholder="t('search.placeholder')"
        @keydown.enter.prevent="onEnterSearch"
      />
      <button
        class="cp-opt"
        :class="{ on: caseSensitive }"
        :title="t('search.caseSensitive')"
        @click="caseSensitive = !caseSensitive"
      >Aa</button>
      <button
        class="cp-opt wide"
        :class="{ on: wholeWord }"
        :title="t('search.wholeWord')"
        @click="wholeWord = !wholeWord"
      >ab</button>
      <button
        class="cp-opt"
        :class="{ on: regexMode }"
        :title="t('search.regex')"
        @click="regexMode = !regexMode"
      >.*</button>
    </div>

    <!-- 工具行：高级开关 + 替换开关 -->
    <div class="tools-row">
      <button
        class="link-btn"
        :class="{ on: advancedVisible }"
        @click="advancedVisible = !advancedVisible"
      >{{ t('search.advanced') }} <span class="chev">{{ advancedVisible ? '▾' : '▸' }}</span></button>
      <button
        class="link-btn replace-switch"
        :class="{ on: replaceVisible }"
        @click="replaceVisible = !replaceVisible"
      >{{ t('search.replaceToggle') }}</button>
    </div>

    <!-- 高级：include / exclude glob -->
    <div v-if="advancedVisible" class="advanced">
      <input
        v-model="includesText"
        class="cp-glob-input"
        type="text"
        spellcheck="false"
        :placeholder="t('search.include')"
      />
      <input
        v-model="excludesText"
        class="cp-glob-input"
        type="text"
        spellcheck="false"
        :placeholder="t('search.exclude')"
      />
    </div>

    <!-- 替换行 -->
    <div v-if="replaceVisible" class="replace-row">
      <input
        v-model="replaceText"
        class="cp-search-input"
        type="text"
        spellcheck="false"
        :placeholder="t('search.replaceWith')"
      />
      <button
        class="cp-btn cp-btn-primary replace-run"
        :disabled="!result || result.totalMatches === 0"
        @click="requestReplace"
      >{{ t('search.replaceRun') }}</button>
    </div>

    <!-- 状态行 -->
    <div class="status-row">
      <span v-if="loading" class="st-searching">
        <span class="dot-pulse"></span>{{ t('search.searching') }}
      </span>
      <template v-else-if="!errorMsg && result">
        <span class="st-count">
          {{ t('search.results', {
            matches: result.totalMatches,
            files: result.fileCount,
            ms: result.elapsedMs
          }) }}
        </span>
        <span v-if="result.truncated" class="st-truncated">⚠ {{ t('search.truncated') }}</span>
      </template>
      <span v-else-if="errorMsg" class="st-error">{{ errorMsg }}</span>
      <span v-else-if="hasSearched" class="st-empty">{{ t('search.noResults') }}</span>
    </div>

    <!-- 结果树 -->
    <div v-if="result && !loading" class="results">
      <div v-for="group in result.groups" :key="group.path" class="file-group">
        <!-- 文件组头 -->
        <div class="group-header" @click="toggleGroup(group.path)">
          <span class="g-chev">{{ collapsedPaths.has(group.path) ? '▸' : '▾' }}</span>
          <span class="g-name">{{ baseName(group.path) }}</span>
          <span class="g-rel">{{ relPath(group.path) }}</span>
          <span class="g-count">{{ group.matchCount }}</span>
        </div>
        <!-- 匹配行 -->
        <div v-if="!collapsedPaths.has(group.path)" class="group-body">
          <div
            v-for="m in group.matches"
            :key="m.lineNumber"
            class="match-row"
            @click="void jumpTo(group, m.lineNumber, m.preview)"
          >
            <span class="m-line">{{ m.lineNumber }}</span>
            <span class="m-preview">
              <template v-for="(seg, i) in splitByHits(m.preview)" :key="i">
                <span v-if="seg.hit" class="m-hit">{{ seg.text }}</span>
                <span v-else>{{ seg.text }}</span>
              </template>
            </span>
          </div>
        </div>
      </div>
    </div>

    <!-- 替换预览弹窗 -->
    <ReplacePreviewModal
      v-if="replacePayload"
      :payload="replacePayload"
      @close="replacePayload = null"
      @applied="onReplaceApplied"
    />
  </div>
</template>

<style scoped>
.search-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

/* ---------- 搜索输入行 ---------- */
.search-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 10px 6px;
  flex-shrink: 0;
}
.cp-search-input {
  flex: 1;
  min-width: 0;
  padding: 5px 9px;
  background: var(--bg-primary);
  border: 1px solid var(--border-light);
  border-radius: 5px;
  color: var(--text-primary);
  font-family: inherit;
  font-size: 12.5px;
  outline: none;
  box-sizing: border-box;
}
.cp-search-input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--border-glow, rgba(0, 229, 255, 0.35));
}

/* 三个选项开关 */
.cp-opt {
  flex-shrink: 0;
  min-width: 26px;
  height: 24px;
  padding: 0 5px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 4px;
  color: var(--text-muted, #7a8699);
  font-family: 'Consolas', monospace;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}
.cp-opt.wide { font-size: 12px; font-style: italic; }
.cp-opt:hover {
  color: var(--text-primary);
  border-color: var(--border);
}
.cp-opt.on {
  color: var(--accent, #00e5ff);
  background: rgba(0, 229, 255, 0.1);
  border-color: rgba(0, 229, 255, 0.45);
}

/* ---------- 工具行 ---------- */
.tools-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 10px 6px;
  flex-shrink: 0;
}
.link-btn {
  background: transparent;
  border: none;
  padding: 2px 4px;
  color: var(--text-muted, #7a8699);
  font-size: 11px;
  cursor: pointer;
  border-radius: 3px;
}
.link-btn:hover { color: var(--text-primary); }
.link-btn.on { color: var(--accent, #00e5ff); }
.chev { font-size: 9px; }
.replace-switch { margin-left: auto; }

/* ---------- 高级区 ---------- */
.advanced {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 0 10px 7px;
  flex-shrink: 0;
}
.cp-glob-input {
  padding: 4px 9px;
  background: var(--bg-primary);
  border: 1px solid var(--border-light);
  border-radius: 5px;
  color: var(--text-primary);
  font-family: inherit;
  font-size: 11.5px;
  outline: none;
  box-sizing: border-box;
}
.cp-glob-input:focus { border-color: var(--accent); }

/* ---------- 替换行 ---------- */
.replace-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px 7px;
  flex-shrink: 0;
}
.replace-run {
  flex-shrink: 0;
  padding: 4px 10px;
  font-size: 11.5px;
}

/* ---------- 状态行 ---------- */
.status-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 22px;
  padding: 2px 12px;
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  font-size: 11px;
  flex-shrink: 0;
  flex-wrap: wrap;
}
.st-searching {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--accent, #00e5ff);
}
.dot-pulse {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent, #00e5ff);
  animation: pulse 1s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 0.3; transform: scale(0.85); }
  50% { opacity: 1; transform: scale(1.15); }
}
.st-count { color: var(--text-secondary, #9aa7b8); }
.st-truncated { color: #ffb84d; }
.st-error { color: var(--danger, #ff6b81); word-break: break-word; }
.st-empty { color: var(--text-muted); }

/* ---------- 结果树 ---------- */
.results {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}
.file-group { margin-bottom: 1px; }

.group-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  cursor: pointer;
  user-select: none;
}
.group-header:hover { background: rgba(0, 229, 255, 0.06); }
.g-chev {
  flex-shrink: 0;
  width: 10px;
  color: var(--text-muted);
  font-size: 9px;
}
.g-name {
  flex-shrink: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
}
.g-rel {
  flex: 1;
  min-width: 0;
  font-size: 10.5px;
  color: var(--text-muted, #7a8699);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl;
}
.g-count {
  flex-shrink: 0;
  min-width: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: rgba(0, 229, 255, 0.12);
  color: var(--accent, #00e5ff);
  font-size: 10px;
  font-weight: 700;
  line-height: 16px;
  text-align: center;
}

/* 匹配行 */
.group-body { padding-bottom: 2px; }
.match-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 2px 10px 2px 26px;
  cursor: pointer;
}
.match-row:hover { background: rgba(0, 229, 255, 0.07); }
.m-line {
  flex-shrink: 0;
  width: 38px;
  text-align: right;
  color: var(--text-muted, #68738a);
  font-family: 'Consolas', monospace;
  font-size: 10.5px;
}
.m-preview {
  flex: 1;
  min-width: 0;
  white-space: pre;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: 'Consolas', 'Microsoft YaHei', monospace;
  font-size: 11.5px;
  color: var(--text-secondary, #b8c4d4);
}
.m-hit {
  background: rgba(0, 229, 255, 0.22);
  color: #7ff3ff;
  border-radius: 2px;
  border-bottom: 1px solid rgba(0, 229, 255, 0.55);
}
</style>
