<script setup lang="ts">
// 命令面板：Ctrl+Shift+P 唤起，模糊搜索命令，↑↓/Enter/Esc 键盘操作
// 挂载在 App.vue 根级，全局唯一
import { ref, computed, watch, nextTick, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useCommandRegistry, searchCommands, type CommandDef, type SettingsTab } from '../commands/registry'
import { modKeyName, platformFromNavigator } from '@shared/platform'

// 平台主修饰键名（mac 显示 Cmd，Windows/Linux 显示 Ctrl）
const MOD_KEY = modKeyName(platformFromNavigator(navigator.platform))

const emit = defineEmits<{ (e: 'close'): void }>()
const props = defineProps<{
  /** 命令执行上下文（由 App.vue 注入） */
  ctx: {
    openSettings: (tab?: SettingsTab) => void
    openPalette: () => void
    toggleChatPanel: () => void
  }
}>()

const { commands, effectiveKeys } = useCommandRegistry()
const { t } = useI18n()

const query = ref('')
const selectedIndex = ref(0)
const inputRef = ref<HTMLInputElement | null>(null)

const filtered = computed(() => searchCommands(query.value, commands))

// 选中项始终保持在可见范围内
watch(filtered, () => {
  selectedIndex.value = 0
})

// 打开时自动聚焦输入框
onMounted(async () => {
  await nextTick()
  inputRef.value?.focus()
})

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    emit('close')
    return
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    selectedIndex.value = Math.min(selectedIndex.value + 1, filtered.value.length - 1)
    scrollToSelected()
    return
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault()
    selectedIndex.value = Math.max(selectedIndex.value - 1, 0)
    scrollToSelected()
    return
  }
  if (e.key === 'Enter') {
    e.preventDefault()
    executeSelected()
  }
}

function scrollToSelected(): void {
  nextTick(() => {
    const el = document.querySelector('.palette-item.active')
    el?.scrollIntoView({ block: 'nearest' })
  })
}

function executeSelected(): void {
  const cmd = filtered.value[selectedIndex.value]
  if (!cmd) return
  const result = cmd.run(props.ctx as Parameters<typeof cmd.run>[0])
  if (result !== false) emit('close')
}

function onItemClick(cmd: CommandDef): void {
  const runtime = commands.find((c) => c.id === cmd.id)
  if (!runtime) return
  const result = runtime.run(props.ctx as Parameters<typeof runtime.run>[0])
  if (result !== false) emit('close')
}

function onOverlayClick(e: MouseEvent): void {
  if ((e.target as HTMLElement).classList.contains('palette-overlay')) {
    emit('close')
  }
}
</script>

<template>
  <div class="palette-overlay" @click="onOverlayClick">
    <div class="palette-box cp-glass">
      <div class="palette-input-wrap">
        <svg class="palette-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path fill="currentColor" d="M11.7 10.3a5 5 0 1 0-1.4 1.4l3 3a.7.7 0 1 0 1-1l-3-3ZM8 12a4 4 0 1 1 0-8 4 4 0 0 1 0 8Z"/>
        </svg>
        <input
          ref="inputRef"
          v-model="query"
          class="palette-input"
          :placeholder="t('command.palettePlaceholder')"
          @keydown="onKeydown"
        />
        <span class="palette-hint">{{ MOD_KEY }}+Shift+P</span>
      </div>
      <div class="palette-list">
        <div
          v-for="(cmd, idx) in filtered"
          :key="cmd.id"
          class="palette-item"
          :class="{ active: idx === selectedIndex }"
          @click="onItemClick(cmd)"
          @mouseenter="selectedIndex = idx"
        >
          <span class="palette-group">{{ cmd.group }}</span>
          <span class="palette-title">{{ cmd.title }}</span>
          <span v-if="effectiveKeys[cmd.id]" class="palette-key">{{ effectiveKeys[cmd.id] }}</span>
        </div>
        <div v-if="filtered.length === 0" class="palette-empty">{{ t('command.noResults') }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.palette-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  z-index: 3000;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 15vh;
}

.palette-box {
  width: 480px;
  max-height: 50vh;
  display: flex;
  flex-direction: column;
  border-radius: 8px;
  overflow: hidden;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}

.palette-input-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}

.palette-icon {
  color: var(--text-muted);
  flex-shrink: 0;
}

.palette-input {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  color: var(--text-primary);
  font-size: 14px;
  font-family: inherit;
}

.palette-input::placeholder {
  color: var(--text-muted);
}

.palette-hint {
  font-size: 11px;
  color: var(--text-muted);
  background: var(--bg-panel);
  padding: 2px 6px;
  border-radius: 3px;
  border: 1px solid var(--border);
  flex-shrink: 0;
}

.palette-list {
  overflow-y: auto;
  flex: 1;
}

.palette-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  cursor: pointer;
  transition: background 0.1s;
}

.palette-item.active {
  background: var(--accent-dim);
}

.palette-group {
  font-size: 11px;
  color: var(--text-muted);
  background: var(--bg-panel);
  padding: 1px 5px;
  border-radius: 3px;
  border: 1px solid var(--border);
  flex-shrink: 0;
  min-width: 36px;
  text-align: center;
}

.palette-title {
  flex: 1;
  color: var(--text-primary);
  font-size: 13px;
}

.palette-key {
  font-size: 11px;
  color: var(--text-muted);
  background: var(--bg-panel);
  padding: 1px 5px;
  border-radius: 3px;
  border: 1px solid var(--border);
  flex-shrink: 0;
}

.palette-empty {
  padding: 24px;
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
}
</style>
