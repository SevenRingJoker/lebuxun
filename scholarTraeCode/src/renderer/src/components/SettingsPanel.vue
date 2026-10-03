<script setup lang="ts">
// 统一设置页：Tab 聚合 通用 / 模型 / MCP / 规则技能 / 快捷键
// 已有三个管理组件以 embedded 模式内嵌复用，不重复造管理 UI
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { useChatStore } from '../stores/chat'
import { useWorkspaceStore } from '../stores/workspace'
import { useStagingStore } from '../stores/staging'
import { useThemeStore, type ThemeName } from '../stores/theme'
import { useCommandRegistry, type SettingsTab } from '../commands/registry'
import { setLocale, getLocale, type AppLocale } from '../i18n'
import ModelSettings from './ModelSettings.vue'
import McpSettings from './McpSettings.vue'
import RulesSkillsSettings from './RulesSkillsSettings.vue'

const props = defineProps<{ initialTab?: SettingsTab }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const chat = useChatStore()
const workspace = useWorkspaceStore()
const staging = useStagingStore()
const theme = useThemeStore()
const { t } = useI18n()
const { commands, effectiveKeys, conflicts, rebind, resetKeymap } = useCommandRegistry()

const activeTab = ref<SettingsTab>(props.initialTab ?? 'general')

const TABS: { key: SettingsTab; label: string }[] = [
  { key: 'general', label: t('settings.general') },
  { key: 'models', label: t('settings.models') },
  { key: 'mcp', label: t('settings.mcp') },
  { key: 'rulesSkills', label: t('settings.rulesSkills') },
  { key: 'keymap', label: t('settings.shortcuts') }
]

const themeOptions: { key: ThemeName; label: string }[] = [
  { key: 'light', label: '白色' },
  { key: 'dark', label: '黑色' },
  { key: 'blue', label: '蓝色' }
]

const permissionModes = [
  { value: 'readonly' as const, label: t('chat.readonly'), desc: '禁止任何写入/执行' },
  { value: 'ask' as const, label: t('chat.ask'), desc: '写入/执行前逐次确认' },
  { value: 'auto' as const, label: t('chat.auto'), desc: '常规操作放行，危险命令仍确认' }
]

// ---------- 语言切换 ----------
const localeOptions: { value: AppLocale; label: string }[] = [
  { value: 'zh-CN', label: '中文' },
  { value: 'en', label: 'English' }
]
const currentLocale = ref<AppLocale>(getLocale())
function switchLocale(locale: AppLocale): void {
  setLocale(locale)
  currentLocale.value = locale
}

// ---------- 快捷键 Tab ----------
/** 正在录制按键的命令 id */
const recordingId = ref<string | null>(null)

/** 按分组整理命令清单 */
const groupedCommands = computed(() => {
  const groups = new Map<string, typeof commands>()
  for (const cmd of commands) {
    const list = groups.get(cmd.group) ?? []
    list.push(cmd)
    groups.set(cmd.group, list)
  }
  return [...groups.entries()]
})

/** 指定命令是否与别的命令存在按键冲突 */
function conflictOf(id: string): string | null {
  for (const c of conflicts.value) {
    if (c.commandIds.includes(id)) {
      const others = c.commandIds.filter((x) => x !== id)
      const names = others.map((x) => commands.find((cmd) => cmd.id === x)?.title ?? x).join('、')
      return `与「${names}」按键冲突（${c.key}）`
    }
  }
  return null
}

function startRecord(id: string): void {
  recordingId.value = id
}

function cancelRecord(): void {
  recordingId.value = null
}

/** 录制态键盘捕获：把下一次修饰键组合写入 keymap；Esc 取消；必须含修饰键防误触 */
function onRecordKeydown(e: KeyboardEvent): void {
  e.preventDefault()
  e.stopPropagation()
  if (e.key === 'Escape') {
    cancelRecord()
    return
  }
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return // 只按了修饰键，继续等
  if (!e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) return // 无修饰键的组合不收录
  const parts: string[] = []
  // 跨平台：ctrlKey 记为 'Ctrl'，metaKey 记为 'Cmd'（比 'Meta' 更可读）
  // parseAccelerator 都识别；matchKeyEvent 视 ctrl/meta 为可互换的主修饰键
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.shiftKey) parts.push('Shift')
  if (e.altKey) parts.push('Alt')
  if (e.metaKey) parts.push('Cmd')
  parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key)
  if (recordingId.value) rebind(recordingId.value, parts.join('+'))
  recordingId.value = null
}

// 录制期间挂 window 捕获监听（含 App.vue 全局分发之前拦截），退出录制即摘除
watch(recordingId, (id) => {
  if (id) window.addEventListener('keydown', onRecordKeydown, true)
  else window.removeEventListener('keydown', onRecordKeydown, true)
})
onBeforeUnmount(() => window.removeEventListener('keydown', onRecordKeydown, true))

/** 解绑单条命令 */
function unbind(id: string): void {
  rebind(id, '')
}

function onOverlayClick(e: MouseEvent): void {
  if ((e.target as HTMLElement).classList.contains('settings-overlay')) emit('close')
}
</script>

<template>
  <div class="settings-overlay" @click="onOverlayClick">
    <div class="settings-panel cp-glass">
      <!-- 左侧 Tab 导航 -->
      <aside class="settings-nav">
        <div class="nav-title">设置</div>
        <button
          v-for="t in TABS"
          :key="t.key"
          class="nav-item"
          :class="{ active: activeTab === t.key }"
          @click="activeTab = t.key"
        >{{ t.label }}</button>
        <div class="nav-spacer"></div>
        <button class="nav-close" title="关闭设置" @click="emit('close')">✕ 关闭</button>
      </aside>

      <!-- 右侧内容区 -->
      <section class="settings-content">
        <!-- 通用 -->
        <div v-if="activeTab === 'general'" class="tab-pane">
          <div class="section-title">主题外观</div>
          <div class="row">
            <button
              v-for="opt in themeOptions"
              :key="opt.key"
              class="opt-btn"
              :class="{ active: theme.theme === opt.key }"
              @click="theme.setTheme(opt.key)"
            >{{ opt.label }}</button>
          </div>

          <div class="section-title">{{ t('settings.language') }}</div>
          <div class="row">
            <button
              v-for="opt in localeOptions"
              :key="opt.value"
              class="opt-btn"
              :class="{ active: currentLocale === opt.value }"
              @click="switchLocale(opt.value)"
            >{{ opt.label }}</button>
          </div>

          <div class="section-title">工具权限模式</div>
          <div class="perm-cards">
            <button
              v-for="m in permissionModes"
              :key="m.value"
              class="perm-card"
              :class="{ active: chat.permissionMode === m.value }"
              @click="void chat.setPermissionMode(m.value)"
            >
              <span class="perm-name">{{ m.label }}</span>
              <span class="perm-desc">{{ m.desc }}</span>
            </button>
          </div>

          <div class="section-title">AI 行为</div>
          <label class="check-row">
            <input
              type="checkbox"
              :checked="chat.autoCheckpoint"
              @change="chat.toggleAutoCheckpoint(($event.target as HTMLInputElement).checked)"
            />
            <span>每次 AI 任务前自动创建 Git 检查点</span>
          </label>
          <!-- ㊝ 审阅模式：AI 文件改动先进暂存，用户接受才落盘 -->
          <label class="check-row">
            <input
              type="checkbox"
              :checked="staging.enabled"
              @change="void staging.setEnabled(workspace.rootPath, ($event.target as HTMLInputElement).checked)"
            />
            <span>变更审阅模式：AI 文件改动先入暂存区，接受后才写入磁盘</span>
          </label>
        </div>

        <!-- 模型 / MCP / 规则技能：内嵌既有管理组件 -->
        <div v-else-if="activeTab === 'models'" class="tab-pane embed-pane">
          <ModelSettings embedded @close="emit('close')" @changed="() => { void chat.loadModels() }" />
        </div>
        <div v-else-if="activeTab === 'mcp'" class="tab-pane embed-pane">
          <McpSettings embedded @close="emit('close')" />
        </div>
        <div v-else-if="activeTab === 'rulesSkills'" class="tab-pane embed-pane">
          <RulesSkillsSettings embedded @close="emit('close')" />
        </div>

        <!-- 快捷键 -->
        <div v-else-if="activeTab === 'keymap'" class="tab-pane">
          <div class="keymap-head">
            <span class="section-title" style="margin: 0">快捷键映射</span>
            <button class="opt-btn" @click="resetKeymap">全部恢复默认</button>
          </div>
          <div class="keymap-hint">点击「改键」后按下新的组合键（需含 Ctrl/Shift/Alt 之一），Esc 取消。</div>
          <div v-for="[group, cmds] in groupedCommands" :key="group" class="keymap-group">
            <div class="keymap-group-name">{{ group }}</div>
            <div v-for="cmd in cmds" :key="cmd.id" class="keymap-row">
              <span class="keymap-title">{{ cmd.title }}</span>
              <span v-if="conflictOf(cmd.id)" class="keymap-conflict">{{ conflictOf(cmd.id) }}</span>
              <template v-if="recordingId === cmd.id">
                <span class="keymap-key recording">按下新按键…</span>
              </template>
              <template v-else>
                <span class="keymap-key" :class="{ unbound: !effectiveKeys[cmd.id] }">
                  {{ effectiveKeys[cmd.id] || '未绑定' }}
                </span>
                <button class="mini-btn" @click="startRecord(cmd.id)">改键</button>
                <button v-if="effectiveKeys[cmd.id]" class="mini-btn" title="解绑" @click="unbind(cmd.id)">×</button>
              </template>
            </div>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.settings-overlay {
  position: fixed;
  inset: 0;
  z-index: 2500;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
}

.settings-panel {
  width: 780px;
  max-width: calc(100vw - 48px);
  height: 560px;
  max-height: 85vh;
  display: flex;
  border-radius: 12px;
  border: 1px solid var(--border-light);
  background: var(--bg-secondary);
  box-shadow: 0 0 0 1px var(--border-glow), 0 12px 40px rgba(0, 0, 0, 0.5);
  overflow: hidden;
}

/* 左侧导航 */
.settings-nav {
  width: 140px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 12px 8px;
  border-right: 1px solid var(--border);
  background: var(--bg-panel);
}
.nav-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  padding: 4px 8px 10px;
  letter-spacing: 1px;
}
.nav-item {
  text-align: left;
  padding: 7px 10px;
  font-size: 13px;
  border-radius: 6px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.12s;
}
.nav-item:hover { color: var(--text-primary); background: var(--bg-hover); }
.nav-item.active { color: var(--accent); background: var(--accent-dim); border-color: var(--border-glow); }
.nav-spacer { flex: 1; }
.nav-close {
  padding: 7px 10px;
  font-size: 12px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}
.nav-close:hover { color: var(--accent); border-color: var(--border-glow); }

/* 右侧内容区 */
.settings-content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.tab-pane {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
}
/* 内嵌管理组件的面板自己管理滚动，去掉外层 padding */
.tab-pane.embed-pane {
  padding: 0;
  overflow: hidden;
}

.section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 14px 0 8px;
}
.section-title:first-child { margin-top: 0; }

.row { display: flex; gap: 8px; }
.opt-btn {
  padding: 5px 14px;
  font-size: 12px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.12s;
}
.opt-btn:hover { color: var(--accent); border-color: var(--border-glow); }
.opt-btn.active { color: var(--accent); background: var(--accent-dim); border-color: var(--accent); }

.perm-cards { display: flex; gap: 8px; }
.perm-card {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  text-align: left;
  transition: all 0.12s;
}
.perm-card:hover { border-color: var(--border-glow); }
.perm-card.active { border-color: var(--accent); background: var(--accent-dim); }
.perm-name { font-size: 13px; font-weight: 600; color: var(--text-primary); }
.perm-desc { font-size: 11px; color: var(--text-muted); }

.check-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-secondary);
  cursor: pointer;
}
.check-row input { accent-color: var(--accent); }

/* 快捷键 Tab */
.keymap-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.keymap-hint {
  font-size: 11px;
  color: var(--text-muted);
  margin: 8px 0 12px;
}
.keymap-group { margin-bottom: 12px; }
.keymap-group-name {
  font-size: 11px;
  color: var(--text-muted);
  letter-spacing: 1px;
  margin-bottom: 4px;
}
.keymap-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 0;
  border-bottom: 1px solid var(--border);
}
.keymap-title { flex: 1; font-size: 13px; color: var(--text-primary); }
.keymap-conflict { font-size: 11px; color: #ff6b6b; }
.keymap-key {
  font-size: 11px;
  color: var(--text-secondary);
  background: var(--bg-panel);
  padding: 2px 8px;
  border-radius: 4px;
  border: 1px solid var(--border);
  min-width: 72px;
  text-align: center;
}
.keymap-key.unbound { color: var(--text-muted); }
.keymap-key.recording {
  color: var(--accent);
  border-color: var(--accent);
  outline: none;
  animation: recordBlink 1s infinite;
}
@keyframes recordBlink { 50% { opacity: 0.5; } }
.mini-btn {
  padding: 2px 8px;
  font-size: 11px;
  border-radius: 4px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}
.mini-btn:hover { color: var(--accent); border-color: var(--border-glow); }
</style>
