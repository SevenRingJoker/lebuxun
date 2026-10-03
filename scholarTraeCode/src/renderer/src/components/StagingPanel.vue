<template>
  <!-- ㊝ 变更事务暂存审阅面板：fixed 遮罩与 DiffViewer 同级，规避 cp-page z-index -->
  <div v-if="staging.panelOpen" class="sp-mask" @click.self="onMaskClick">
    <div class="sp-panel cp-glass">
      <header class="sp-header">
        <div class="sp-title">
          <span class="sp-dot"></span>
          {{ staging.bashGateId ? '执行命令前请接受变更' : '待审阅变更' }}
          <span class="sp-count">{{ staging.summary.total }}</span>
        </div>
        <label v-if="!staging.bashGateId" class="sp-switch">
          <input
            type="checkbox"
            :checked="staging.enabled"
            @change="onToggleEnabled(($event.target as HTMLInputElement).checked)"
          />
          <span>审阅模式</span>
        </label>
        <button
          class="sp-btn ghost"
          :disabled="!!staging.bashGateId"
          :title="staging.bashGateId ? '请先应答接受或拒绝' : '关闭'"
          @click="staging.closePanel()"
        >
          关闭
        </button>
      </header>

      <!-- bash 门模式横幅：明确告知不接受则命令不会执行 -->
      <div v-if="staging.bashGateId" class="sp-banner">
        AI 请求执行终端命令。当前有未接受的文件变更，必须先
        <strong>全部接受（落盘）</strong>或拒绝，命令才会继续。
      </div>

      <div v-if="staging.summary.total === 0" class="sp-empty">
        <p>暂存区为空</p>
        <p class="sp-sub">AI 的文件改动出现在这里后，可逐个或批量审阅接受。</p>
      </div>

      <div v-else class="sp-body">
        <!-- 左栏：变更列表 -->
        <aside class="sp-side">
          <label class="sp-pick-all">
            <input
              type="checkbox"
              :checked="allPicked"
              @change="togglePickAll(($event.target as HTMLInputElement).checked)"
            />
            <span>全选（{{ staging.summary.items.length }}）</span>
          </label>
          <ul class="sp-list">
            <li
              v-for="item in staging.summary.items"
              :key="item.path"
              class="sp-item"
              :class="{
                active: activePath === item.path,
                'cls-incidental': classMap[item.path]?.cls === 'incidental',
                'cls-risky': classMap[item.path]?.cls === 'risky'
              }"
              @click="selectItem(item)"
            >
              <input
                type="checkbox"
                class="sp-item-check"
                :checked="picked.has(item.path)"
                @click.stop
                @change="togglePick(item.path, ($event.target as HTMLInputElement).checked)"
              />
              <span class="sp-kind" :class="'k-' + item.kind">{{ kindLabel(item.kind) }}</span>
              <!-- s44 三档分类徽标：需求青 / 顺带灰 / 高风险红，title 为判定原因 -->
              <span
                v-if="classMap[item.path]"
                class="sp-cls"
                :class="'c-' + classMap[item.path].cls"
                :title="classMap[item.path].reason"
              >{{ clsLabel(classMap[item.path].cls) }}</span>
              <span class="sp-item-name" :title="item.path">{{ shortName(item.path) }}</span>
              <span class="sp-item-dir" :title="item.path">{{ dirOf(item.path) }}</span>
            </li>
          </ul>
        </aside>

        <!-- 右栏：diff -->
        <main class="sp-main">
          <div v-if="diffError" class="sp-diff-empty">{{ diffError }}</div>
          <div v-else-if="!activePath" class="sp-diff-empty">
            <p>选择左侧文件查看差异</p>
          </div>
          <template v-else>
            <div class="sp-diff-bar">
              <span class="sp-diff-path" :title="activePath">{{ activePath }}</span>
              <span
                v-if="activeItem"
                class="sp-kind"
                :class="'k-' + activeItem.kind"
              >{{ kindLabel(activeItem.kind) }}</span>
            </div>
            <!-- 逐 hunk 选择 chips（delete/move 无 hunk，仅支持整文件操作） -->
            <div v-if="activeHunks.length" class="sp-hunks">
              <span class="sp-hunks-label">逐块</span>
              <label
                v-for="h in activeHunks"
                :key="h.id"
                class="sp-hunk"
                :title="`hunk ${h.id}：新增 ${addCount(h)} / 删除 ${delCount(h)}；点编号在 diff 中定位`"
              >
                <input
                  type="checkbox"
                  :checked="hunkChecked(activePath, h.id)"
                  @change="toggleHunk(activePath, h.id, ($event.target as HTMLInputElement).checked)"
                />
                <span class="sp-hunk-id" @click="revealHunk(h)">{{ h.id }}</span>
                <span class="sp-hunk-add">+{{ addCount(h) }}</span>
                <span class="sp-hunk-del">-{{ delCount(h) }}</span>
              </label>
            </div>
            <div v-else-if="activePath" class="sp-hunks none">
              「{{ activeItem ? kindLabel(activeItem.kind) : '' }}」仅支持整文件接受/拒绝
            </div>
            <div ref="diffHost" class="sp-diff-host"></div>
          </template>
        </main>
      </div>

      <!-- 批量操作栏 -->
      <footer v-if="staging.summary.total > 0" class="sp-footer">
        <div class="sp-footer-info">
          已选 <strong>{{ selectedTotal }}</strong> / {{ staging.summary.total }}
          <span v-if="selectedHunkCount > 0" class="sp-footer-sub">（含 {{ selectedHunkCount }} 个块）</span>
        </div>
        <div class="sp-footer-actions">
          <button
            class="sp-btn danger"
            :disabled="selectedTotal === 0"
            title="丢弃选中的变更（不写入磁盘）"
            @click="onRejectPicked"
          >
            拒绝选中
          </button>
          <button
            class="sp-btn primary"
            :disabled="selectedTotal === 0 || !!staging.bashGateId"
            :title="staging.bashGateId ? '执行命令前只能全部接受' : '选中变更写入磁盘'"
            @click="onAcceptPicked"
          >
            接受选中
          </button>
          <button
            class="sp-btn danger-ghost"
            title="拒绝全部（bash 门模式下同时拒绝执行命令）"
            @click="onRejectAll"
          >
            全部拒绝
          </button>
          <button class="sp-btn primary-strong" title="全部接受并写入磁盘" @click="onAcceptAll">
            全部接受
          </button>
        </div>
      </footer>

      <!-- 非阻塞轻提示 -->
      <transition name="sp-fade">
        <div v-if="staging.notice" class="sp-toast" :class="staging.notice.type">
          {{ staging.notice.text }}
        </div>
      </transition>
    </div>
  </div>
</template>

<script setup lang="ts">
// ㊝ 暂存审阅面板：列表 + 徽标 + Monaco DiffEditor + 逐文件/批量接受拒绝。
// 数据经 stores/staging 走 IPC；本组件只持有选择集与 diff 编辑器实例。
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import * as monaco from 'monaco-editor'
import { useStagingStore } from '../stores/staging'
import { useWorkspaceStore } from '../stores/workspace'
import { useThemeStore } from '../stores/theme'
import type { UiStageItem, UiStageKind, UiStageHunk, UiChangeVerdict, UiChangeClass } from '../api'
import { monospaceFontStack, platformFromNavigator } from '@shared/platform'

const FONT_STACK = monospaceFontStack(platformFromNavigator(navigator.platform))

const staging = useStagingStore()
const workspace = useWorkspaceStore()
const themeStore = useThemeStore()

const diffHost = ref<HTMLElement | null>(null)
const activePath = ref<string | null>(null)
const diffError = ref('')
/** 勾选的文件路径集合（文件级） */
const picked = ref<Set<string>>(new Set())
/** 当前活动文件的 hunk 列表（diff 响应携带） */
const activeHunks = ref<UiStageHunk[]>([])
/** 逐 hunk 选择：路径 → hunk id 集合（与文件级 picked 互斥联动） */
const hunkPicked = ref<Map<string, Set<string>>>(new Map())
/** s44 三档分类：路径 → 判定（summary 变化后重新拉取） */
const classMap = ref<Record<string, UiChangeVerdict>>({})

/** 三档徽标文案：需求 / 顺带 / 高风险 */
function clsLabel(cls: UiChangeClass): string {
  return { direct: '需求', incidental: '顺带', risky: '高风险' }[cls]
}

let diffEditor: monaco.editor.IStandaloneDiffEditor | null = null
let oldModel: monaco.editor.ITextModel | null = null
let newModel: monaco.editor.ITextModel | null = null

const activeItem = computed<UiStageItem | null>(
  () => staging.summary.items.find((i) => i.path === activePath.value) ?? null
)
const allPicked = computed(
  () => staging.summary.items.length > 0 && staging.summary.items.every((i) => picked.value.has(i.path))
)

/** 已选 hunk 总数（跨文件） */
const selectedHunkCount = computed(() => {
  let n = 0
  for (const s of hunkPicked.value.values()) n += s.size
  return n
})
/** 底部操作栏口径：文件级选择 + hunk 选择 */
const selectedTotal = computed(() => picked.value.size + selectedHunkCount.value)

/** 徽标文案：新增青 / 修改蓝 / 删除红 / 移动紫 */
function kindLabel(kind: UiStageKind): string {
  return { create: '新增', modify: '修改', delete: '删除', move: '移动' }[kind]
}
function shortName(p: string): string {
  return p.split(/[/\\]/).pop() || p
}
function dirOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(0, i) : ''
}
function langOf(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() || ''
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    vue: 'html', json: 'json', md: 'markdown', css: 'css', scss: 'scss',
    html: 'html', py: 'python', java: 'java', go: 'go', rs: 'rust',
    c: 'c', h: 'c', cpp: 'cpp', xml: 'xml', yml: 'yaml', yaml: 'yaml',
    sh: 'shell', bat: 'bat', ps1: 'powershell'
  }
  return map[ext] || 'plaintext'
}

/** 列表点击：勾选行 + 拉 diff */
async function selectItem(item: UiStageItem): Promise<void> {
  activePath.value = item.path
  diffError.value = ''
  activeHunks.value = []
  if (!workspace.rootPath) return
  const d = await window.api.staging.diff(workspace.rootPath, item.path)
  activeHunks.value = d.hunks ?? []
  await nextTick()
  renderDiff(d.original, d.modified, item.path)
}

/** hunk 是否勾选 */
function hunkChecked(path: string, id: string): boolean {
  return hunkPicked.value.get(path)?.has(id) ?? false
}

/** 勾选/取消单个 hunk；勾选 hunk 时自动解除该文件的文件级选择 */
function toggleHunk(path: string, id: string, on: boolean): void {
  const nextMap = new Map(hunkPicked.value)
  const set = new Set(nextMap.get(path) ?? [])
  if (on) {
    set.add(id)
    if (picked.value.has(path)) {
      const nextPicked = new Set(picked.value)
      nextPicked.delete(path)
      picked.value = nextPicked
    }
  } else {
    set.delete(id)
  }
  if (set.size) nextMap.set(path, set)
  else nextMap.delete(path)
  hunkPicked.value = nextMap
}

/** hunk 增/删行计数（chips 展示） */
function addCount(h: UiStageHunk): number {
  return h.lines.filter((l) => l.kind === 'add').length
}
function delCount(h: UiStageHunk): number {
  return h.lines.filter((l) => l.kind === 'del').length
}

/** 点击 hunk 编号 → 在 diff 中定位（删除类 hunk 用左侧原文定位） */
function revealHunk(h: UiStageHunk): void {
  if (!diffEditor) return
  if (h.newLines > 0) {
    diffEditor.getModifiedEditor().revealLineInCenter(Math.max(1, h.newStart))
  } else {
    diffEditor.getOriginalEditor().revealLineInCenter(Math.max(1, h.oldStart))
  }
}

function ensureEditor(): void {
  if (diffEditor || !diffHost.value) return
  diffEditor = monaco.editor.createDiffEditor(diffHost.value, {
    theme: `scholar-${themeStore.theme}`,
    automaticLayout: true,
    fontSize: 13,
    fontFamily: FONT_STACK,
    readOnly: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    wordWrap: 'on',
    renderSideBySide: true,
    scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 }
  })
}

function renderDiff(original: string, modified: string, path: string): void {
  ensureEditor()
  if (!diffEditor) return
  // 先挂新模型再释放旧模型，顺序反了会触发 monaco disposed 警告
  const prevOld = oldModel
  const prevNew = newModel
  const lang = langOf(path)
  oldModel = monaco.editor.createModel(original, lang)
  newModel = monaco.editor.createModel(modified, lang)
  diffEditor.setModel({ original: oldModel, modified: newModel })
  prevOld?.dispose()
  prevNew?.dispose()
}

function togglePick(path: string, on: boolean): void {
  const next = new Set(picked.value)
  if (on) {
    next.add(path)
    // 文件级勾选 → 清除该文件的 hunk 选择
    if (hunkPicked.value.has(path)) {
      const m = new Map(hunkPicked.value)
      m.delete(path)
      hunkPicked.value = m
    }
  } else {
    next.delete(path)
  }
  picked.value = next
}

function togglePickAll(on: boolean): void {
  picked.value = on ? new Set(staging.summary.items.map((i) => i.path)) : new Set()
  if (!on) hunkPicked.value = new Map()
}

/** 汇总当前选择为 IPC 参数：文件级 + hunk 级（hunk 路径以 hunkIds 标注） */
function buildSelection(): { paths: string[]; hunkIds: Record<string, string[]> } {
  const hunkIds: Record<string, string[]> = {}
  for (const [p, s] of hunkPicked.value) {
    if (s.size) hunkIds[p] = [...s]
  }
  const hunkPaths = new Set(Object.keys(hunkIds))
  const filePaths = [...picked.value].filter((p) => !hunkPaths.has(p))
  return { paths: [...filePaths, ...hunkPaths], hunkIds }
}

async function onAcceptPicked(): Promise<void> {
  const { paths, hunkIds } = buildSelection()
  if (!paths.length) return
  await staging.accept(workspace.rootPath, paths, Object.keys(hunkIds).length ? hunkIds : undefined)
  afterBatch()
}
async function onRejectPicked(): Promise<void> {
  const { paths, hunkIds } = buildSelection()
  if (!paths.length) return
  await staging.reject(workspace.rootPath, paths, Object.keys(hunkIds).length ? hunkIds : undefined)
  afterBatch()
}
async function onAcceptAll(): Promise<void> {
  await staging.accept(workspace.rootPath, 'all')
  afterBatch()
}
async function onRejectAll(): Promise<void> {
  await staging.reject(workspace.rootPath, 'all')
  afterBatch()
}

/** 批量操作后同步选择集：剔除已消失项，活动行消失则清空 diff；
 *  部分接受后记录被重基线，活动文件需重新拉 diff 与 hunk 列表 */
function afterBatch(): void {
  hunkPicked.value = new Map()
  const live = new Set(staging.summary.items.map((i) => i.path))
  picked.value = new Set([...picked.value].filter((p) => live.has(p)))
  if (activePath.value && !live.has(activePath.value)) {
    activePath.value = null
    activeHunks.value = []
    oldModel?.dispose(); newModel?.dispose()
    oldModel = newModel = null
  } else if (activePath.value) {
    const it = staging.summary.items.find((i) => i.path === activePath.value)
    if (it) void selectItem(it) // 重基线内容/新 hunk
  }
}

async function onToggleEnabled(on: boolean): Promise<void> {
  await staging.setEnabled(workspace.rootPath, on)
}

/** 遮罩点击：bash 门模式下禁止逃逸，普通模式等价关闭 */
function onMaskClick(): void {
  staging.closePanel()
}

// s44 三档分类：摘要变化（刷新/接受/拒绝）后重新拉取；顺带档默认不勾选由空 picked 天然满足
watch(
  () => staging.summary.items,
  async (items) => {
    if (!workspace.rootPath || items.length === 0) {
      classMap.value = {}
      return
    }
    try {
      classMap.value = await window.api.staging.classify(workspace.rootPath)
    } catch {
      classMap.value = {}
    }
  },
  { immediate: true }
)

// 面板关闭（含组件内部状态重置）：释放编辑器，避免模型泄漏
watch(
  () => staging.panelOpen,
  (open) => {
    if (!open) {
      oldModel?.dispose(); newModel?.dispose()
      diffEditor?.dispose()
      oldModel = newModel = null
      diffEditor = null
      activePath.value = null
      diffError.value = ''
      activeHunks.value = []
      hunkPicked.value = new Map()
      picked.value = new Set()
    }
  }
)

// 主题切换同步 Monaco
watch(
  () => themeStore.theme,
  (t) => {
    if (diffEditor) monaco.editor.setTheme(`scholar-${t}`)
  }
)

onBeforeUnmount(() => {
  oldModel?.dispose(); newModel?.dispose()
  diffEditor?.dispose()
})
</script>

<style scoped>
/* 科技蓝青风，统一走 CSS 变量，适配三套主题 */
.sp-mask {
  position: fixed;
  inset: 0;
  z-index: 9100;
  background: rgba(3, 10, 22, 0.62);
  backdrop-filter: blur(6px);
  display: flex;
  align-items: center;
  justify-content: center;
}

.sp-panel {
  width: min(1100px, 92vw);
  height: min(80vh, 760px);
  border: 1px solid var(--border-glow, rgba(0, 212, 255, 0.25));
  border-radius: 14px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.55);
}

.sp-header {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
}
.sp-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary, #e6f6ff);
  flex: 1;
}
.sp-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #00d4ff;
  box-shadow: 0 0 8px #00d4ff;
}
.sp-count {
  font-size: 11px;
  font-weight: 500;
  padding: 1px 8px;
  border-radius: 9px;
  background: rgba(0, 212, 255, 0.16);
  color: #8ee9ff;
}

.sp-switch {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-secondary, #9fb8c8);
  cursor: pointer;
}
.sp-switch input { accent-color: #00d4ff; cursor: pointer; }

.sp-btn {
  font-size: 12px;
  padding: 5px 12px;
  border-radius: 7px;
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.14));
  background: transparent;
  color: var(--text-secondary, #9fb8c8);
  cursor: pointer;
  transition: all 0.15s ease;
}
.sp-btn:hover:not(:disabled) {
  border-color: rgba(0, 212, 255, 0.55);
  color: #b8f1ff;
}
.sp-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.sp-btn.primary {
  background: rgba(0, 212, 255, 0.14);
  border-color: rgba(0, 212, 255, 0.6);
  color: #bdf3ff;
}
.sp-btn.primary-strong {
  background: linear-gradient(135deg, rgba(0, 180, 255, 0.3), rgba(0, 230, 200, 0.26));
  border-color: rgba(0, 212, 255, 0.7);
  color: #e8fcff;
  box-shadow: 0 0 14px rgba(0, 212, 255, 0.25);
}
.sp-btn.danger {
  border-color: rgba(255, 91, 91, 0.5);
  color: #ff8b8b;
}
.sp-btn.danger:hover:not(:disabled) {
  background: rgba(255, 64, 64, 0.16);
  color: #ffb0b0;
}
.sp-btn.danger-ghost {
  border-color: rgba(255, 91, 91, 0.32);
  color: #d98a8a;
}

.sp-banner {
  padding: 9px 16px;
  font-size: 12px;
  color: #cfe9f5;
  background: rgba(0, 120, 200, 0.12);
  border-bottom: 1px solid rgba(0, 212, 255, 0.2);
}
.sp-banner strong { color: #8ee9ff; }

.sp-empty, .sp-diff-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 30px;
  font-size: 13px;
  color: var(--text-secondary, #9fb8c8);
  text-align: center;
}
.sp-sub { font-size: 12px; color: var(--text-muted, #6f8595); }

.sp-body { flex: 1; display: flex; min-height: 0; }

.sp-side {
  width: 310px;
  flex-shrink: 0;
  border-right: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.sp-pick-all {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 10px 14px;
  font-size: 12px;
  color: var(--text-secondary, #9fb8c8);
  cursor: pointer;
}
.sp-pick-all input { accent-color: #00d4ff; cursor: pointer; }

.sp-list {
  list-style: none;
  margin: 0;
  padding: 0 6px 8px;
  overflow-y: auto;
  flex: 1;
}
.sp-item {
  display: grid;
  grid-template-columns: 16px 44px auto 1fr;
  grid-template-rows: auto auto;
  gap: 3px 7px;
  padding: 7px 8px;
  border-radius: 7px;
  cursor: pointer;
}
.sp-item:hover { background: rgba(255, 255, 255, 0.05); }
.sp-item.active { background: rgba(0, 212, 255, 0.12); }
/* s44 顺带改动淡化、高风险行暖色描边提示 */
.sp-item.cls-incidental { opacity: 0.72; }
.sp-item.cls-risky { box-shadow: inset 0 0 0 1px rgba(255, 107, 107, 0.35); }
/* s44 三档分类徽标 */
.sp-cls {
  grid-row: 1;
  font-size: 10.5px;
  text-align: center;
  padding: 1px 6px;
  border-radius: 5px;
  align-self: center;
  white-space: nowrap;
}
.c-direct {
  color: #062a2e;
  background: #2ee6d6;
  box-shadow: 0 0 8px rgba(46, 230, 214, 0.4);
}
.c-incidental {
  color: #d7ecf7;
  background: rgba(159, 184, 200, 0.28);
}
.c-risky {
  color: #2e0707;
  background: #ff6b6b;
  box-shadow: 0 0 8px rgba(255, 107, 107, 0.5);
}
.sp-item-check {
  grid-row: 1;
  margin-top: 3px;
  accent-color: #00d4ff;
  cursor: pointer;
}
.sp-kind {
  grid-row: 1;
  font-size: 10.5px;
  text-align: center;
  padding: 1px 0;
  border-radius: 5px;
  align-self: center;
}
.k-create {
  color: #062a2e;
  background: #2ee6d6;
  box-shadow: 0 0 8px rgba(46, 230, 214, 0.5);
}
.k-modify {
  color: #051a2e;
  background: #4aa8ff;
  box-shadow: 0 0 8px rgba(74, 168, 255, 0.5);
}
.k-delete {
  color: #2e0707;
  background: #ff6b6b;
  box-shadow: 0 0 8px rgba(255, 107, 107, 0.5);
}
.k-move {
  color: #220a33;
  background: #c79bff;
  box-shadow: 0 0 8px rgba(199, 155, 255, 0.5);
}
.sp-item-name {
  font-size: 12.5px;
  color: var(--text-primary, #d7ecf7);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sp-item-dir {
  grid-column: 2 / 5;
  font-size: 10.5px;
  color: var(--text-muted, #6f8595);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sp-main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.sp-diff-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
}
.sp-diff-path {
  flex: 1;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-primary, #d7ecf7);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sp-diff-host { flex: 1; min-height: 0; }

/* 逐 hunk chips 栏 */
.sp-hunks {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 7px 12px;
  border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
}
.sp-hunks.none {
  font-size: 11.5px;
  color: var(--text-muted, #6f8595);
}
.sp-hunks-label {
  font-size: 11px;
  color: var(--text-muted, #6f8595);
  margin-right: 2px;
}
.sp-hunk {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px 2px 6px;
  border-radius: 6px;
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.14));
  background: rgba(255, 255, 255, 0.03);
  font-size: 11px;
  cursor: pointer;
}
.sp-hunk:hover { border-color: rgba(0, 212, 255, 0.45); }
.sp-hunk input { accent-color: #00d4ff; margin: 0; cursor: pointer; }
.sp-hunk-id {
  color: #8ee9ff;
  font-family: var(--font-mono);
  font-weight: 600;
}
.sp-hunk-id:hover { text-shadow: 0 0 8px rgba(0, 212, 255, 0.8); }
.sp-hunk-add { color: #3ddc97; font-family: var(--font-mono); }
.sp-hunk-del { color: #ff8585; font-family: var(--font-mono); }
.sp-footer-sub { font-size: 11px; color: var(--text-muted, #6f8595); }

.sp-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  border-top: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
}
.sp-footer-info { font-size: 12px; color: var(--text-muted, #6f8595); }
.sp-footer-info strong { color: #8ee9ff; }
.sp-footer-actions { display: flex; gap: 8px; }

.sp-toast {
  position: absolute;
  left: 50%;
  bottom: 64px;
  transform: translateX(-50%);
  padding: 8px 18px;
  border-radius: 9px;
  font-size: 12.5px;
  background: rgba(8, 26, 38, 0.92);
  border: 1px solid rgba(0, 212, 255, 0.45);
  color: #bdf3ff;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.5);
}
.sp-toast.err {
  border-color: rgba(255, 91, 91, 0.55);
  color: #ffb0b0;
}
.sp-fade-enter-active, .sp-fade-leave-active { transition: opacity 0.2s; }
.sp-fade-enter-from, .sp-fade-leave-to { opacity: 0; }
</style>
