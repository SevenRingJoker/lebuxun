<template>
  <!-- Git 改动 / 检查点差异面板：fixed 遮罩，独立于 cp-page 层级，规避 z-index 问题 -->
  <div v-if="git.viewerOpen" class="dv-mask" @click.self="git.closeViewer()">
    <div class="dv-panel cp-glass">
      <header class="dv-header">
        <div class="dv-title">
          <span class="dv-dot"></span>
          Git 改动与检查点
        </div>
        <div class="dv-header-actions">
          <button class="dv-btn ghost" @click="onCreateCheckpoint" title="把当前全部改动提交为一个检查点">
            创建检查点
          </button>
          <button class="dv-btn ghost" @click="git.refresh()">刷新</button>
          <button class="dv-btn ghost" @click="git.closeViewer()">关闭</button>
        </div>
      </header>

      <!-- 非仓库 / git 不可用：显式引导，不自动 init -->
      <div v-if="!git.gitAvailable" class="dv-empty">
        未检测到本机 git，请安装 Git for Windows 后刷新。
      </div>
      <div v-else-if="git.isRepo === false" class="dv-empty">
        <p>当前工作区还不是 Git 仓库。</p>
        <p class="dv-sub">初始化后可使用：改动差异预览、逐文件还原、AI 任务前自动检查点、一键回滚。</p>
        <button class="dv-btn primary" @click="git.initRepo()">初始化 Git 仓库</button>
      </div>

      <div v-else class="dv-body">
        <!-- 左栏：改动文件 + 检查点历史 -->
        <aside class="dv-side">
          <section class="dv-sec">
            <div class="dv-sec-title">改动文件（{{ git.changes.length }}）</div>
            <div v-if="!git.changes.length" class="dv-side-empty">工作区干净，没有改动</div>
            <ul class="dv-file-list">
              <li
                v-for="c in git.changes"
                :key="c.path + c.rawCode"
                class="dv-file"
                :class="{ active: selected?.path === c.path }"
                @click="selectChange(c)"
              >
                <span class="dv-st-dot" :class="'st-' + c.status" :title="statusLabel(c)"></span>
                <span class="dv-file-name" :title="c.path">{{ shortName(c.path) }}</span>
                <span class="dv-file-dir" :title="c.path">{{ dirOf(c.path) }}</span>
              </li>
            </ul>
          </section>

          <section class="dv-sec dv-cp-sec">
            <div class="dv-sec-title">检查点 / 历史（{{ git.checkpoints.length }}）</div>
            <div v-if="!git.checkpoints.length" class="dv-side-empty">尚无提交</div>
            <ul class="dv-cp-list">
              <li
                v-for="cp in git.checkpoints"
                :key="cp.hash"
                class="dv-cp"
                :title="cp.subject"
              >
                <span class="dv-cp-meta">
                  <span class="dv-cp-hash">{{ cp.shortHash }}</span>
                  <span class="dv-cp-date">{{ cp.date }}</span>
                </span>
                <span class="dv-cp-subj">
                  <em v-if="cp.isTrae" class="dv-cp-tag">检查点</em>{{ cp.subject.replace(/^trae-checkpoint:\s*/, '') }}
                </span>
                <button
                  class="dv-btn danger-mini"
                  title="回滚到此提交（丢弃其后的全部改动，回滚前会自动留存）"
                  @click="askRestore(cp)"
                >
                  回滚
                </button>
              </li>
            </ul>
          </section>
        </aside>

        <!-- 右栏：差异对比 -->
        <main class="dv-main">
          <div v-if="diffError" class="dv-empty">{{ diffError }}</div>
          <div v-else-if="!selected" class="dv-empty">
            <p>选择左侧文件查看差异</p>
          </div>
          <template v-else>
            <div class="dv-diff-bar">
              <span class="dv-diff-path" :title="selected.path">{{ selected.path }}</span>
              <span class="dv-st-tag" :class="'st-' + selected.status">{{ statusLabel(selected) }}</span>
              <button class="dv-btn danger" @click="askDiscard(selected)">
                {{ selected.status === 'untracked' ? '删除此新文件' : '还原此文件' }}
              </button>
            </div>
            <div ref="diffHost" class="dv-diff-host"></div>
          </template>
        </main>
      </div>

      <!-- 非阻塞轻提示 -->
      <transition name="dv-fade">
        <div v-if="git.notice" class="dv-toast" :class="git.notice.type">
          {{ git.notice.text }}
        </div>
      </transition>

      <!-- 应用内强确认（禁用原生 confirm） -->
      <div v-if="confirm" class="dv-confirm-mask" @click.self="confirm = null">
        <div class="dv-confirm cp-glass">
          <div class="dv-confirm-title">{{ confirm.title }}</div>
          <p class="dv-confirm-text">{{ confirm.text }}</p>
          <div class="dv-confirm-actions">
            <button class="dv-btn ghost" @click="confirm = null">取消</button>
            <button class="dv-btn danger" @click="confirm.onOk(); confirm = null">
              {{ confirm.okText }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// Git 差异面板：Monaco DiffEditor 对比 HEAD 与工作区，支持逐文件还原、检查点创建与回滚。
import { ref, watch, onBeforeUnmount, nextTick } from 'vue'
import * as monaco from 'monaco-editor'
import { useGitStore } from '../stores/git'
import { useThemeStore } from '../stores/theme'
import type { UiGitChange, UiGitCheckpoint, UiFileDiff } from '../api'
import { monospaceFontStack, platformFromNavigator } from '@shared/platform'

// 跨平台等宽字体栈：按 navigator.platform 推断，浏览器按序挑首个可用字体
const FONT_STACK = monospaceFontStack(platformFromNavigator(navigator.platform))

const git = useGitStore()
const themeStore = useThemeStore()

const diffHost = ref<HTMLElement | null>(null)
const selected = ref<UiGitChange | null>(null)
const diffError = ref('')

interface ConfirmState {
  title: string
  text: string
  okText: string
  onOk: () => void
}
const confirm = ref<ConfirmState | null>(null)

let diffEditor: monaco.editor.IStandaloneDiffEditor | null = null
let oldModel: monaco.editor.ITextModel | null = null
let newModel: monaco.editor.ITextModel | null = null
let current: UiFileDiff | null = null

/** 按扩展名猜语言（仅影响高亮，猜错不影响 diff 正确性） */
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

function shortName(p: string): string {
  return p.split(/[/\\]/).pop() || p
}
function dirOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(0, i) : ''
}
function statusLabel(c: UiGitChange): string {
  return {
    modified: '已修改',
    added: '新增（已暂存）',
    deleted: '已删除',
    untracked: '新文件',
    renamed: '重命名',
    unknown: `未知(${c.rawCode.trim() || '??'})`
  }[c.status]
}

async function selectChange(c: UiGitChange): Promise<void> {
  selected.value = c
  diffError.value = ''
  const d = await git.loadDiff(c)
  if (!d) {
    diffError.value = '差异读取失败或文件过大（>200KB）'
    return
  }
  current = d
  await nextTick()
  renderDiff(d)
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

function renderDiff(d: UiFileDiff): void {
  ensureEditor()
  if (!diffEditor) return
  // 先切换到新模型，再释放旧模型；
  // 反过来 dispose 会触发 "TextModel got disposed before model got reset"
  const prevOld = oldModel
  const prevNew = newModel
  const lang = langOf(d.path)
  oldModel = monaco.editor.createModel(d.oldContent, lang)
  newModel = monaco.editor.createModel(d.newContent, lang)
  diffEditor.setModel({ original: oldModel, modified: newModel })
  prevOld?.dispose()
  prevNew?.dispose()
}

async function onCreateCheckpoint(): Promise<void> {
  await git.createCheckpoint('手动检查点')
}

function askDiscard(c: UiGitChange): void {
  const isNew = c.status === 'untracked'
  confirm.value = {
    title: isNew ? '删除新文件？' : '放弃该文件的改动？',
    text: isNew
      ? `新文件 ${c.path} 将被移入回收站，无法继续对比。确定删除？`
      : `文件 ${c.path} 将恢复到最近一次提交的内容，未提交的改动会丢失。确定还原？`,
    okText: isNew ? '删除文件' : '放弃改动',
    onOk: async () => {
      const ok = await git.discardChange(c)
      if (ok) {
        selected.value = null
        oldModel?.dispose(); newModel?.dispose()
        oldModel = newModel = null
      }
    }
  }
}

function askRestore(cp: UiGitCheckpoint): void {
  confirm.value = {
    title: '回滚到此检查点？',
    text: `将硬重置到 ${cp.shortHash}（${cp.subject.replace(/^trae-checkpoint:\s*/, '')}）。此提交之后的全部改动会从工作区消失；回滚前会自动创建一个留存检查点，仍可找回。确定继续？`,
    okText: '确认回滚',
    onOk: async () => {
      const ok = await git.restoreCheckpoint(cp.hash)
      if (ok) {
        selected.value = null
        oldModel?.dispose(); newModel?.dispose()
        oldModel = newModel = null
      }
    }
  }
}

// 主题变化同步给 Monaco
watch(() => themeStore.theme, (t) => {
  if (diffEditor) monaco.editor.setTheme(`scholar-${t}`)
})

// 面板打开：若携带预选路径（SCM 面板点击文件名），自动选中对应改动；
// 面板关闭释放编辑器与模型，避免双模型内存泄漏
watch(() => git.viewerOpen, (open) => {
  if (open) {
    const initial = git.viewerInitialPath
    if (initial) {
      const target = git.changes.find((c) => c.path === initial)
      if (target) void selectChange(target)
    }
    return
  }
  oldModel?.dispose(); newModel?.dispose()
  diffEditor?.dispose()
  oldModel = newModel = null
  diffEditor = null
  selected.value = null
  current = null
  diffError.value = ''
})

onBeforeUnmount(() => {
  oldModel?.dispose(); newModel?.dispose()
  diffEditor?.dispose()
})
</script>

<style scoped>
/* 科技蓝青风，全部走 CSS 变量，适配三套主题 */
.dv-mask {
  position: fixed;
  inset: 0;
  z-index: 9000;
  background: rgba(3, 10, 22, 0.62);
  backdrop-filter: blur(6px);
  display: flex;
  align-items: center;
  justify-content: center;
}

.dv-panel {
  width: min(1180px, 92vw);
  height: min(82vh, 780px);
  border: 1px solid var(--border-glow, rgba(0, 212, 255, 0.25));
  border-radius: 14px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.55);
}

.dv-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
}
.dv-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary, #e6f6ff);
}
.dv-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #00d4ff;
  box-shadow: 0 0 8px #00d4ff;
}
.dv-header-actions { display: flex; gap: 8px; }

.dv-btn {
  font-size: 12px;
  padding: 5px 12px;
  border-radius: 7px;
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.14));
  background: transparent;
  color: var(--text-secondary, #9fb8c8);
  cursor: pointer;
  transition: all 0.15s ease;
}
.dv-btn:hover {
  border-color: rgba(0, 212, 255, 0.55);
  color: #b8f1ff;
}
.dv-btn.primary {
  background: rgba(0, 212, 255, 0.14);
  border-color: rgba(0, 212, 255, 0.6);
  color: #bdf3ff;
}
.dv-btn.danger, .dv-btn.danger-mini {
  border-color: rgba(255, 91, 91, 0.5);
  color: #ff8b8b;
}
.dv-btn.danger:hover, .dv-btn.danger-mini:hover {
  background: rgba(255, 64, 64, 0.16);
  color: #ffb0b0;
}
.dv-btn.danger-mini { padding: 2px 8px; font-size: 11px; }

.dv-body { flex: 1; display: flex; min-height: 0; }

.dv-side {
  width: 300px;
  flex-shrink: 0;
  border-right: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.dv-sec { display: flex; flex-direction: column; min-height: 0; }
.dv-cp-sec { flex: 1; }
.dv-sec-title {
  padding: 10px 14px 6px;
  font-size: 11px;
  letter-spacing: 0.08em;
  color: var(--text-muted, #6f8595);
  text-transform: uppercase;
}
.dv-side-empty {
  padding: 4px 14px 10px;
  font-size: 12px;
  color: var(--text-muted, #6f8595);
}

.dv-file-list, .dv-cp-list {
  list-style: none;
  margin: 0;
  padding: 0 6px;
  overflow-y: auto;
}
.dv-file-list { max-height: 260px; }
.dv-cp-list { flex: 1; }

.dv-file {
  display: grid;
  grid-template-columns: 10px 1fr;
  grid-template-rows: auto auto;
  gap: 0 7px;
  padding: 6px 8px;
  border-radius: 7px;
  cursor: pointer;
}
.dv-file:hover { background: rgba(255, 255, 255, 0.05); }
.dv-file.active { background: rgba(0, 212, 255, 0.12); }
.dv-st-dot {
  grid-row: 1;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-top: 5px;
}
.dv-file-name {
  font-size: 12.5px;
  color: var(--text-primary, #d7ecf7);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dv-file-dir {
  grid-column: 2;
  font-size: 10.5px;
  color: var(--text-muted, #6f8595);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.st-modified { background: #e3b341; box-shadow: 0 0 6px rgba(227, 179, 65, 0.6); }
.st-added { background: #3fb950; box-shadow: 0 0 6px rgba(63, 185, 80, 0.6); }
.st-untracked { background: #00d4ff; box-shadow: 0 0 6px rgba(0, 212, 255, 0.7); }
.st-deleted { background: #ff5b5b; box-shadow: 0 0 6px rgba(255, 91, 91, 0.6); }
.st-renamed { background: #d2a8ff; }
.st-unknown { background: #8b98a5; }

.dv-cp {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 7px;
}
.dv-cp:hover { background: rgba(255, 255, 255, 0.05); }
.dv-cp-meta { display: flex; flex-direction: column; flex-shrink: 0; width: 76px; }
.dv-cp-hash {
  font-family: var(--font-mono);
  font-size: 11px;
  color: #00d4ff;
}
.dv-cp-date { font-size: 10px; color: var(--text-muted, #6f8595); }
.dv-cp-subj {
  flex: 1;
  font-size: 11.5px;
  color: var(--text-secondary, #a9c2d2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dv-cp-tag {
  font-style: normal;
  font-size: 10px;
  color: #04121c;
  background: #00d4ff;
  border-radius: 4px;
  padding: 0 5px;
  margin-right: 5px;
}

.dv-main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.dv-diff-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
}
.dv-diff-path {
  flex: 1;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-primary, #d7ecf7);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dv-st-tag {
  font-size: 10.5px;
  padding: 2px 8px;
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.08);
  color: var(--text-secondary, #a9c2d2);
}
.dv-diff-host { flex: 1; min-height: 0; }

.dv-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 30px;
  font-size: 13px;
  color: var(--text-secondary, #9fb8c8);
  text-align: center;
}
.dv-sub { font-size: 12px; color: var(--text-muted, #6f8595); max-width: 420px; }

.dv-toast {
  position: absolute;
  left: 50%;
  bottom: 22px;
  transform: translateX(-50%);
  padding: 8px 18px;
  border-radius: 9px;
  font-size: 12.5px;
  background: rgba(8, 26, 38, 0.92);
  border: 1px solid rgba(0, 212, 255, 0.45);
  color: #bdf3ff;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.5);
}
.dv-toast.err {
  border-color: rgba(255, 91, 91, 0.55);
  color: #ffb0b0;
}
.dv-fade-enter-active, .dv-fade-leave-active { transition: opacity 0.2s; }
.dv-fade-enter-from, .dv-fade-leave-to { opacity: 0; }

.dv-confirm-mask {
  position: absolute;
  inset: 0;
  background: rgba(2, 8, 16, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 14px;
}
.dv-confirm {
  width: 420px;
  max-width: 86%;
  padding: 20px 22px;
  border-radius: 12px;
  border: 1px solid rgba(255, 91, 91, 0.4);
}
.dv-confirm-title {
  font-size: 14px;
  font-weight: 600;
  color: #ffb0b0;
  margin-bottom: 10px;
}
.dv-confirm-text {
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--text-secondary, #a9c2d2);
  margin: 0 0 18px;
}
.dv-confirm-actions { display: flex; justify-content: flex-end; gap: 10px; }
</style>
