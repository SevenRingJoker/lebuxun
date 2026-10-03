<template>
  <!-- SCM 源代码管理面板：分支头 + 提交框 + 三折叠分组；复用 DiffViewer 看差异 -->
  <div class="scm-panel">
    <!-- 无本机 git -->
    <div v-if="!git.gitAvailable" class="scm-hint">
      {{ t('scm.noGit') }}
    </div>

    <!-- 非仓库：引导初始化 -->
    <div v-else-if="git.isRepo === false" class="scm-hint">
      <p>{{ t('scm.notRepo') }}</p>
      <button class="scm-btn primary" @click="git.initRepo()">
        {{ t('scm.initRepo') }}
      </button>
    </div>

    <!-- 加载中 -->
    <div v-else-if="git.isRepo === null || !git.grouped" class="scm-hint">
      {{ t('common.loading') }}
    </div>

    <template v-else>
      <!-- 分支头 -->
      <div class="scm-branch-bar">
        <button class="scm-branch-btn" @click="branchMenuOpen = !branchMenuOpen">
          <span class="scm-branch-icon">⑂</span>
          <span class="scm-branch-name" :title="branchDisplay">
            {{ git.grouped.currentBranch ?? t('scm.detached') }}
          </span>
          <span class="scm-caret">▾</span>
        </button>
        <button class="scm-icon-only" :title="t('scm.refresh')" @click="git.refresh()">↻</button>

        <!-- 分支下拉 -->
        <div v-if="branchMenuOpen" class="scm-pop-mask" @click="branchMenuOpen = false">
          <div class="scm-pop" @click.stop>
            <button class="scm-pop-item new" @click="startNewBranch">
              ＋ {{ t('scm.newBranch') }}
            </button>
            <div class="scm-pop-sep"></div>
            <button
              v-for="b in git.branches"
              :key="b.name"
              class="scm-pop-item"
              :class="{ current: b.current }"
              @click="onPickBranch(b)"
            >
              <span class="scm-pop-check">{{ b.current ? '●' : '' }}</span>
              <span class="scm-pop-name" :title="b.name">{{ b.name }}</span>
            </button>
          </div>
        </div>

        <!-- 新建分支内联输入 -->
        <div v-if="newBranchMode" class="scm-new-branch">
          <input
            ref="newBranchInput"
            v-model="newBranchName"
            class="scm-input"
            :placeholder="t('scm.newBranchPlaceholder')"
            @keyup.enter="confirmNewBranch"
            @keyup.esc="newBranchMode = false"
          />
          <div class="scm-new-actions">
            <button class="scm-btn" @click="newBranchMode = false">{{ t('common.cancel') }}</button>
            <button class="scm-btn primary" @click="confirmNewBranch">{{ t('common.ok') }}</button>
          </div>
        </div>
      </div>

      <!-- 提交框 -->
      <div class="scm-commit-box">
        <textarea
          v-model="commitMessage"
          class="scm-textarea"
          :placeholder="t('scm.commitPlaceholder')"
          rows="3"
          @keyup.ctrl.enter="onCommit"
          @keyup.meta.enter="onCommit"
        ></textarea>
        <div class="scm-commit-actions">
          <button
            class="scm-btn"
            :disabled="totalChanges === 0"
            :title="t('scm.stageAll')"
            @click="git.stage([])"
          >＋</button>
          <button
            class="scm-btn primary"
            :disabled="git.grouped.staged.length === 0 || committing"
            :title="git.grouped.staged.length === 0 ? t('scm.commitDisabled') : ''"
            @click="onCommit"
          >
            {{ committing ? t('common.loading') : t('scm.commit') }}
          </button>
        </div>
      </div>

      <!-- 三个折叠分组 -->
      <div class="scm-groups">
        <!-- 暂存 -->
        <section v-if="git.grouped.staged.length" class="scm-group">
          <header class="scm-group-head" @click="toggleGroup('staged')">
            <span class="scm-chevron">{{ collapsed.staged ? '▸' : '▾' }}</span>
            <span class="scm-group-title">{{ t('scm.stagedGroup') }}</span>
            <span class="scm-group-count">{{ git.grouped.staged.length }}</span>
            <button
              class="scm-group-action"
              :title="t('scm.unstageAll')"
              @click.stop="git.unstage([])"
            >－</button>
          </header>
          <ul v-show="!collapsed.staged" class="scm-file-list">
            <li
              v-for="item in git.grouped.staged"
              :key="item.path + item.rawCode + '-staged'"
              class="scm-file"
            >
              <span class="scm-badge staged">{{ item.indexLetter }}</span>
              <span class="scm-file-name" :title="fullTitle(item)" @click="git.openViewerAt(item.path)">
                {{ baseName(item.path) }}
              </span>
              <span class="scm-file-ops">
                <button
                  class="scm-file-btn"
                  :title="t('scm.unstage')"
                  @click="git.unstage([item.path])"
                >－</button>
                <button
                  class="scm-file-btn danger"
                  :title="t('scm.discard')"
                  @click="askDiscard(item, 'staged')"
                >×</button>
              </span>
            </li>
          </ul>
        </section>

        <!-- 工作区改动 -->
        <section v-if="git.grouped.unstaged.length" class="scm-group">
          <header class="scm-group-head" @click="toggleGroup('unstaged')">
            <span class="scm-chevron">{{ collapsed.unstaged ? '▸' : '▾' }}</span>
            <span class="scm-group-title">{{ t('scm.changesGroup') }}</span>
            <span class="scm-group-count">{{ git.grouped.unstaged.length }}</span>
            <button
              class="scm-group-action"
              :title="t('scm.stageAll')"
              @click.stop="git.stage([])"
            >＋</button>
          </header>
          <ul v-show="!collapsed.unstaged" class="scm-file-list">
            <li
              v-for="item in git.grouped.unstaged"
              :key="item.path + item.rawCode + '-unstaged'"
              class="scm-file"
            >
              <span class="scm-badge" :class="badgeClass(item.worktreeLetter)">
                {{ item.worktreeLetter }}
              </span>
              <span class="scm-file-name" :title="fullTitle(item)" @click="git.openViewerAt(item.path)">
                {{ baseName(item.path) }}
              </span>
              <span class="scm-file-ops">
                <button
                  class="scm-file-btn"
                  :title="t('scm.stage')"
                  @click="git.stage([item.path])"
                >＋</button>
                <button
                  class="scm-file-btn danger"
                  :title="t('scm.discard')"
                  @click="askDiscard(item, 'unstaged')"
                >×</button>
              </span>
            </li>
          </ul>
        </section>

        <!-- 未跟踪 -->
        <section v-if="git.grouped.untracked.length" class="scm-group">
          <header class="scm-group-head" @click="toggleGroup('untracked')">
            <span class="scm-chevron">{{ collapsed.untracked ? '▸' : '▾' }}</span>
            <span class="scm-group-title">{{ t('scm.untrackedGroup') }}</span>
            <span class="scm-group-count">{{ git.grouped.untracked.length }}</span>
            <button
              class="scm-group-action"
              :title="t('scm.stageAll')"
              @click.stop="git.stage([])"
            >＋</button>
          </header>
          <ul v-show="!collapsed.untracked" class="scm-file-list">
            <li
              v-for="item in git.grouped.untracked"
              :key="item.path + item.rawCode + '-untracked'"
              class="scm-file"
            >
              <span class="scm-badge untracked">U</span>
              <span class="scm-file-name" :title="fullTitle(item)" @click="git.openViewerAt(item.path)">
                {{ baseName(item.path) }}
              </span>
              <span class="scm-file-ops">
                <button
                  class="scm-file-btn"
                  :title="t('scm.stage')"
                  @click="git.stage([item.path])"
                >＋</button>
                <button
                  class="scm-file-btn danger"
                  :title="t('scm.discard')"
                  @click="askDiscard(item, 'untracked')"
                >×</button>
              </span>
            </li>
          </ul>
        </section>

        <!-- 干净空态 -->
        <div v-if="totalChanges === 0" class="scm-clean">
          <span class="scm-clean-mark">✓</span>
          {{ t('scm.clean') }}
        </div>
      </div>

      <!-- 应用内 discard 确认（禁止原生 confirm） -->
      <div v-if="confirm" class="scm-confirm-mask" @click.self="confirm = null">
        <div class="scm-confirm cp-glass">
          <div class="scm-confirm-title">{{ confirm.title }}</div>
          <p class="scm-confirm-text">{{ confirm.text }}</p>
          <div class="scm-confirm-actions">
            <button class="scm-btn" @click="confirm = null">{{ t('common.cancel') }}</button>
            <button class="scm-btn danger" @click="confirm.onOk(); confirm = null">
              {{ confirm.okText }}
            </button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
// SCM 面板：分组状态来自 git store grouped；分支切换/新建、提交、暂存均走 store actions。
import { ref, reactive, computed, onMounted, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { useGitStore } from '../stores/git'
import { useWorkspaceStore } from '../stores/workspace'
import type { UiScmItem, UiGitChange } from '../api'

const { t } = useI18n()
const git = useGitStore()
const ws = useWorkspaceStore()

// 折叠状态：组计数为 0 的组自然消失，无需持久化
const collapsed = reactive({ staged: false, unstaged: false, untracked: false })
function toggleGroup(g: 'staged' | 'unstaged' | 'untracked'): void {
  collapsed[g] = !collapsed[g]
}

const totalChanges = computed(() => {
  const g = git.grouped
  if (!g) return 0
  return g.staged.length + g.unstaged.length + g.untracked.length
})

const branchDisplay = computed(() => git.grouped?.currentBranch ?? '')

// ---------------- 分支 ----------------
const branchMenuOpen = ref(false)
const newBranchMode = ref(false)
const newBranchName = ref('')
const newBranchInput = ref<HTMLInputElement | null>(null)

async function onPickBranch(b: { name: string; current: boolean }): Promise<void> {
  branchMenuOpen.value = false
  if (!b.current) await git.checkoutBranch(b.name)
}

function startNewBranch(): void {
  branchMenuOpen.value = false
  newBranchMode.value = true
  newBranchName.value = ''
  void nextTick(() => newBranchInput.value?.focus())
}

async function confirmNewBranch(): Promise<void> {
  const name = newBranchName.value.trim()
  if (!name) return
  const ok = await git.createBranch(name)
  if (ok) newBranchMode.value = false
}

// ---------------- 提交 ----------------
const commitMessage = ref('')
const committing = ref(false)

async function onCommit(): Promise<void> {
  if (!git.grouped || git.grouped.staged.length === 0 || committing.value) return
  committing.value = true
  try {
    const ok = await git.commit(commitMessage.value)
    if (ok) commitMessage.value = ''
  } finally {
    committing.value = false
  }
}

// ---------------- 展示辅助 ----------------
function baseName(p: string): string {
  return p.split(/[/\\]/).pop() || p
}
function fullTitle(item: UiScmItem): string {
  return item.oldPath ? `${item.path}  ←  ${item.oldPath}` : item.path
}
function badgeClass(letter: string): string {
  if (letter === 'D') return 'danger-badge'
  if (letter === 'M') return 'modified-badge'
  if (letter === 'R' || letter === 'C') return 'rename-badge'
  if (letter === 'A') return 'staged'
  return ''
}

// ---------------- discard 确认 ----------------
interface ConfirmState {
  title: string
  text: string
  okText: string
  onOk: () => void
}
const confirm = ref<ConfirmState | null>(null)

/** ScmItem → 旧扁平 UiGitChange（discardChange 需要 status/rawCode） */
function toChange(item: UiScmItem, group: string): UiGitChange {
  // 优先复用扁平列表中的同路径项，保证字段一致
  const existing = git.changes.find((c) => c.path === item.path)
  if (existing) return existing

  const letter = group === 'staged' ? item.indexLetter : item.worktreeLetter
  const status =
    group === 'untracked' ? 'untracked'
      : letter === 'D' ? 'deleted'
        : letter === 'R' || letter === 'C' ? 'renamed'
          : letter === 'A' ? 'added'
            : letter === 'M' ? 'modified'
              : 'unknown'
  return {
    path: item.path,
    status,
    staged: group === 'staged',
    rawCode: item.rawCode
  }
}

function askDiscard(item: UiScmItem, group: string): void {
  const isUntracked = group === 'untracked'
  // 同文件同时在暂存组时，discard 会连带放弃暂存内容（风险节约定）
  const alsoStaged =
    group !== 'staged' &&
    !!git.grouped?.staged.some((s) => s.path === item.path)

  const title = isUntracked ? t('scm.confirmDeleteTitle') : t('scm.confirmDiscardTitle')
  const text = isUntracked
    ? t('scm.confirmDeleteText', { path: item.path })
    : alsoStaged
      ? t('scm.confirmDiscardStagedText', { path: item.path })
      : t('scm.confirmDiscardText', { path: item.path })

  confirm.value = {
    title,
    text,
    okText: isUntracked ? t('common.delete') : t('scm.confirmOk'),
    onOk: () => {
      void git.discardChange(toChange(item, group))
    }
  }
}

// 挂载与工作区切换：未探测过则拉取
onMounted(() => {
  if (git.isRepo === null) void git.refresh()
})
watch(() => ws.rootPath, () => {
  void git.refresh()
  commitMessage.value = ''
})
</script>

<style scoped>
/* 科技蓝青风，紧凑左栏布局 */
.scm-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  overflow-y: auto;
}

.scm-hint {
  padding: 18px 14px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-muted);
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: center;
}

/* 分支头 */
.scm-branch-bar {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
}
.scm-branch-btn {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 9px;
  border-radius: 7px;
  border: 1px solid var(--border-color);
  background: rgba(0, 229, 255, 0.06);
  color: var(--text-primary);
  cursor: pointer;
  font-size: 12px;
}
.scm-branch-btn:hover { border-color: rgba(0, 229, 255, 0.5); }
.scm-branch-icon { color: var(--accent); }
.scm-branch-name {
  flex: 1;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.scm-caret { color: var(--text-muted); font-size: 10px; }
.scm-icon-only {
  width: 26px;
  height: 26px;
  border-radius: 7px;
  border: 1px solid var(--border-color);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}
.scm-icon-only:hover { color: var(--accent); border-color: rgba(0, 229, 255, 0.5); }

/* 分支下拉 */
.scm-pop-mask {
  position: fixed;
  inset: 0;
  z-index: 9500;
}
.scm-pop {
  position: absolute;
  top: 100%;
  left: 10px;
  right: 10px;
  z-index: 9501;
  margin-top: 4px;
  max-height: 320px;
  overflow-y: auto;
  background: var(--bg-elevated, #0a1622);
  border: 1px solid rgba(0, 229, 255, 0.3);
  border-radius: 9px;
  padding: 5px;
  box-shadow: 0 14px 40px rgba(0, 0, 0, 0.6);
}
.scm-pop-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 9px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  text-align: left;
}
.scm-pop-item:hover { background: rgba(0, 229, 255, 0.1); color: var(--text-primary); }
.scm-pop-item.current { color: var(--accent); }
.scm-pop-item.new { color: var(--accent); }
.scm-pop-check { width: 12px; font-size: 9px; }
.scm-pop-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.scm-pop-sep { height: 1px; background: var(--border-color); margin: 4px 2px; }

/* 新建分支 */
.scm-new-branch {
  position: absolute;
  top: 100%;
  left: 10px;
  right: 10px;
  z-index: 9502;
  padding: 10px;
  background: var(--bg-elevated, #0a1622);
  border: 1px solid rgba(0, 229, 255, 0.3);
  border-radius: 9px;
  box-shadow: 0 14px 40px rgba(0, 0, 0, 0.6);
}
.scm-input {
  width: 100%;
  box-sizing: border-box;
  padding: 6px 9px;
  border-radius: 6px;
  border: 1px solid var(--border-color);
  background: var(--bg-input, #060f18);
  color: var(--text-primary);
  font-size: 12px;
  outline: none;
}
.scm-input:focus { border-color: var(--accent); }
.scm-new-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  margin-top: 8px;
}

/* 提交框 */
.scm-commit-box {
  padding: 4px 10px 10px;
}
.scm-textarea {
  width: 100%;
  box-sizing: border-box;
  resize: vertical;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--border-color);
  background: var(--bg-input, #060f18);
  color: var(--text-primary);
  font-size: 12px;
  line-height: 1.6;
  outline: none;
  font-family: inherit;
}
.scm-textarea:focus { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(0,229,255,0.12); }
.scm-commit-actions {
  display: flex;
  justify-content: space-between;
  margin-top: 7px;
}

/* 通用小按钮 */
.scm-btn {
  font-size: 12px;
  padding: 4px 12px;
  border-radius: 7px;
  border: 1px solid var(--border-color);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.15s ease;
}
.scm-btn:hover:not(:disabled) {
  border-color: rgba(0, 229, 255, 0.5);
  color: var(--text-primary);
}
.scm-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.scm-btn.primary {
  background: rgba(0, 229, 255, 0.14);
  border-color: rgba(0, 229, 255, 0.55);
  color: var(--accent);
}
.scm-btn.danger {
  border-color: rgba(255, 82, 112, 0.5);
  color: #ff7a94;
}
.scm-btn.danger:hover { background: rgba(255, 82, 112, 0.14); }

/* 分组 */
.scm-groups { padding-bottom: 14px; }
.scm-group { margin-top: 4px; }
.scm-group-head {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  cursor: pointer;
  user-select: none;
}
.scm-group-head:hover { background: rgba(255, 255, 255, 0.04); }
.scm-chevron { font-size: 9px; color: var(--text-muted); width: 10px; }
.scm-group-title {
  flex: 1;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.03em;
  color: var(--text-secondary);
}
.scm-group-count {
  font-size: 10px;
  min-width: 16px;
  padding: 0 5px;
  text-align: center;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.08);
  color: var(--text-muted);
}
.scm-group-action {
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 13px;
  padding: 0 3px;
  border-radius: 4px;
}
.scm-group-action:hover { color: var(--accent); background: rgba(0,229,255,0.1); }

.scm-file-list {
  list-style: none;
  margin: 0;
  padding: 0 6px;
}
.scm-file {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 6px;
  border-radius: 6px;
}
.scm-file:hover { background: rgba(255, 255, 255, 0.05); }
.scm-file:hover .scm-file-ops { opacity: 1; }

.scm-badge {
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 700;
  flex-shrink: 0;
}
.scm-badge.staged {
  color: #04121c;
  background: var(--accent);
  box-shadow: 0 0 6px rgba(0, 229, 255, 0.5);
}
.scm-badge.modified-badge { color: #e2c08d; background: rgba(226, 192, 141, 0.14); }
.scm-badge.danger-badge { color: #ff7a94; background: rgba(255, 82, 112, 0.14); }
.scm-badge.untracked { color: #04121c; background: #73c991; }
.scm-badge.rename-badge { color: #d2a8ff; background: rgba(210, 168, 255, 0.14); }

.scm-file-name {
  flex: 1;
  font-size: 12px;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
}
.scm-file-name:hover { color: var(--accent); }

.scm-file-ops {
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.12s;
}
.scm-file-btn {
  width: 18px;
  height: 18px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 11px;
  padding: 0;
}
.scm-file-btn:hover { color: var(--accent); background: rgba(0,229,255,0.12); }
.scm-file-btn.danger:hover { color: #ff7a94; background: rgba(255,82,112,0.12); }

/* 干净态 */
.scm-clean {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 34px 16px;
  font-size: 12px;
  color: var(--text-muted);
}
.scm-clean-mark {
  color: #73c991;
  font-size: 13px;
}

/* discard 确认 */
.scm-confirm-mask {
  position: fixed;
  inset: 0;
  z-index: 9600;
  background: rgba(3, 10, 22, 0.6);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
}
.scm-confirm {
  width: 320px;
  max-width: 88%;
  padding: 18px 20px;
  border-radius: 12px;
  border: 1px solid rgba(255, 82, 112, 0.4);
}
.scm-confirm-title {
  font-size: 13.5px;
  font-weight: 600;
  color: #ff9bab;
  margin-bottom: 10px;
}
.scm-confirm-text {
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-secondary);
  margin: 0 0 16px;
}
.scm-confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
