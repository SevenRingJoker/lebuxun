<script setup lang="ts">
// @ 引用候选浮层：输入 @ 后按当前 token 检索代码库索引，
// 列出文件/符号候选；键盘选择由父组件 textarea 统一转发（不抢焦点）。
import { ref, watch } from 'vue'

interface Hit {
  relPath: string
  score: number
  symbol?: string
  symbolLine?: number
}

const props = defineProps<{
  /** 工作区根（IPC 检索入参） */
  root: string
  /** @ 后已输入的 token */
  query: string
}>()

const emit = defineEmits<{
  /** 选中候选，text 为要插回输入框的完整文本（含 @ 与尾空格） */
  select: [text: string]
  close: []
}>()

const items = ref<Hit[]>([])
const activeIndex = ref(0)
const loading = ref(false)
let reqSeq = 0

// 依据 token 实时检索（空 token 不请求；竞态用自增序号丢弃过期结果）
watch(
  () => props.query,
  async (q) => {
    const seq = ++reqSeq
    items.value = []
    activeIndex.value = 0
    if (!q.trim() || !props.root) return
    loading.value = true
    try {
      const hits = await window.api.ai.searchIndex({ root: props.root, query: q, limit: 10 })
      if (seq === reqSeq) items.value = hits
    } catch {
      if (seq === reqSeq) items.value = []
    } finally {
      if (seq === reqSeq) loading.value = false
    }
  },
  { immediate: true }
)

/** 候选高亮项移动（键盘 ↑↓） */
function move(step: number): void {
  if (items.value.length === 0) return
  activeIndex.value = (activeIndex.value + step + items.value.length) % items.value.length
}

/** 选中项对应的插入文本：token 与符号名匹配时插 @symbol:，否则插文件路径 */
function insertTextOf(hit: Hit): string {
  const q = props.query.toLowerCase()
  if (hit.symbol && (!q || hit.symbol.toLowerCase().startsWith(q))) {
    return `@symbol:${hit.symbol} `
  }
  return `@${hit.relPath} `
}

function choose(hit: Hit): void {
  emit('select', insertTextOf(hit))
}

/** 键盘 Enter/Tab 确认当前高亮项 */
function selectActive(): boolean {
  const hit = items.value[activeIndex.value]
  if (!hit) return false
  choose(hit)
  return true
}

defineExpose({ moveUp: () => move(-1), moveDown: () => move(1), selectActive })
</script>

<template>
  <div class="mention-picker cp-glass" @mousedown.prevent>
    <div v-if="loading" class="mp-hint">检索中…</div>
    <div v-else-if="items.length === 0" class="mp-hint">无匹配文件或符号</div>
    <ul v-else class="mp-list">
      <li
        v-for="(hit, i) in items"
        :key="hit.relPath + (hit.symbol || '')"
        class="mp-item"
        :class="{ active: i === activeIndex }"
        @mouseenter="activeIndex = i"
        @click="choose(hit)"
      >
        <span class="mp-icon">{{ hit.symbol ? 'ƒ' : '⌘' }}</span>
        <span class="mp-main">
          <span class="mp-path">{{ hit.relPath }}</span>
          <span v-if="hit.symbol" class="mp-symbol">
            {{ hit.symbol }}<span v-if="hit.symbolLine" class="mp-line">:{{ hit.symbolLine }}</span>
          </span>
        </span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.mention-picker {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: calc(100% + 6px);
  max-height: 240px;
  overflow-y: auto;
  border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45), 0 0 0 1px var(--border-glow);
  z-index: 30;
}
.mp-hint {
  padding: 10px 12px;
  font-size: 12px;
  color: var(--text-muted);
}
.mp-list {
  list-style: none;
  margin: 0;
  padding: 4px;
}
.mp-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
}
.mp-item.active {
  background: var(--accent-dim);
  color: var(--accent);
}
.mp-icon {
  color: var(--accent);
  width: 14px;
  text-align: center;
  flex-shrink: 0;
}
.mp-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.mp-path {
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mp-item.active .mp-path {
  color: var(--accent);
}
.mp-symbol {
  color: var(--text-muted);
  font-size: 11px;
}
.mp-line {
  opacity: 0.7;
}
</style>
