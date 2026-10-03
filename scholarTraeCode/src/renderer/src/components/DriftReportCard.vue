<script setup lang="ts">
// 计划-执行偏差报告卡片：任务收尾事件到达时，在最后一条 assistant 消息之后
// 结构化展示三类偏差。含阻断级时默认展开（阻断必须可见），仅警告默认折叠。
import { ref, computed } from 'vue'
import {
  groupDriftItems,
  driftCounts,
  extractDriftFilePath,
  type UiDriftReport,
  type UiDriftItem
} from '@shared/drift/driftView'

const props = defineProps<{ report: UiDriftReport }>()
// ㉜ 行点击定位文件；missingArtifact 行尾「生成」一键补齐
const emit = defineEmits<{
  locate: [detail: string, path: string]
  generate: [detail: string]
}>()

// 分组明细与计数（纯函数层，零状态逻辑）
const groups = computed(() => groupDriftItems(props.report))
const counts = computed(() => driftCounts(props.report))

// 展开状态：有阻断默认展开，仅警告默认折叠
const expanded = ref(props.report.hasBlock)

/** 从明细文本提取可定位路径（仅缺失/计划外两类产物；提取不到则行不可点） */
function extractPath(item: UiDriftItem): string | null {
  return extractDriftFilePath(item)
}
function onLocate(item: UiDriftItem): void {
  const path = extractDriftFilePath(item)
  if (path) emit('locate', item.detail, path)
}

/** 组标题配置：标题 + 明细样式类 */
const groupConfigs = computed(() => [
  { key: 'missing', title: '关键产物缺失', items: groups.value.missing, cls: 'block' },
  { key: 'unfinished', title: '未完成步骤', items: groups.value.unfinished, cls: 'warn' },
  { key: 'unexpected', title: '计划外文件', items: groups.value.unexpected, cls: 'warn' }
] as { key: string; title: string; items: UiDriftItem[]; cls: 'block' | 'warn' }[])
</script>

<template>
  <div class="drift-card cp-glass" :class="{ 'has-block': report.hasBlock }">
    <!-- 头部：点击折叠/展开 -->
    <div
      class="dr-head"
      role="button"
      tabindex="0"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
      @keydown.enter="expanded = !expanded"
      @keydown.space.prevent="expanded = !expanded"
    >
      <span class="dr-icon">⚠</span>
      <span class="dr-title">计划-执行偏差</span>
      <!-- 计数徽标：阻断红、警告青 -->
      <span v-if="counts.block > 0" class="dr-badge block">阻断 {{ counts.block }}</span>
      <span v-if="counts.warn > 0" class="dr-badge warn">警告 {{ counts.warn }}</span>
      <span class="dr-chevron" :class="{ open: expanded }">▾</span>
    </div>
    <!-- 明细：三组，空组不渲染 -->
    <div v-if="expanded" class="dr-body">
      <div v-for="g in groupConfigs" :key="g.key" v-show="g.items.length > 0" class="dr-group" :class="g.cls">
        <div class="dr-group-title">
          {{ g.title }} <span class="dr-group-count">{{ g.items.length }}</span>
        </div>
        <ul class="dr-list">
          <li
            v-for="(it, i) in g.items"
            :key="i"
            class="dr-item"
            :class="{ locatable: !!extractPath(it) }"
            @click="onLocate(it)"
          >
            <span class="dr-item-text">{{ it.detail }}</span>
            <!-- 缺失产物一键生成：点击不冒泡触发行定位 -->
            <button
              v-if="it.kind === 'missingArtifact'"
              class="dr-gen"
              type="button"
              @click.stop="emit('generate', it.detail)"
            >生成</button>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>

<style scoped>
.drift-card {
  align-self: flex-start;
  width: 88%;
  max-width: 720px;
  margin: 6px 0 2px;
  padding: 6px 10px;
  border: 1px solid var(--border-light);
  border-left-width: 2px;
  border-radius: 7px;
  background: var(--bg-panel);
  font-size: 12px;
}
/* 含阻断：左条与头部图标走红；仅警告走琥珀/青 */
.drift-card.has-block {
  border-left-color: var(--danger);
}
.drift-card:not(.has-block) {
  border-left-color: var(--warn, #d9a441);
}
.dr-head {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}
.dr-icon {
  flex: none;
  width: 16px;
  text-align: center;
  font-size: 12px;
}
.has-block .dr-icon {
  color: var(--danger);
}
.drift-card:not(.has-block) .dr-icon {
  color: var(--warn, #d9a441);
}
.dr-title {
  flex: none;
  font-weight: 600;
  color: var(--text-primary);
}
.dr-badge {
  flex: none;
  padding: 1px 7px;
  border-radius: 9px;
  font-size: 10px;
  font-weight: 600;
  line-height: 1.5;
}
.dr-badge.block {
  background: rgba(255, 82, 82, 0.16);
  color: var(--danger);
}
.dr-badge.warn {
  background: rgba(0, 229, 255, 0.14);
  color: var(--accent);
}
.dr-chevron {
  margin-left: auto;
  color: var(--text-muted);
  transition: transform 0.15s;
}
.dr-chevron.open {
  transform: rotate(180deg);
}
.dr-body {
  margin-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.dr-group-title {
  color: var(--text-secondary);
  font-size: 11px;
}
.dr-group.block .dr-group-title {
  color: var(--danger);
}
.dr-group-count {
  opacity: 0.8;
}
.dr-list {
  margin: 3px 0 0;
  padding: 0;
  list-style: none;
}
.dr-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 0 2px 12px;
  border-left: 1px solid var(--border-light);
  margin-bottom: 2px;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.5;
  word-break: break-all;
}
.dr-item-text {
  flex: 1;
  min-width: 0;
}
/* 可定位行：hover 给青辉光与指针光标，暗示可点击 */
.dr-item.locatable {
  cursor: pointer;
  transition: color 0.12s, border-color 0.12s, background 0.12s;
}
.dr-item.locatable:hover {
  color: var(--accent);
  border-left-color: var(--accent);
  background: rgba(0, 229, 255, 0.06);
}
/* 「生成」小按钮：默认低存在感，hover 转青实底 */
.dr-gen {
  flex: none;
  padding: 0 8px;
  height: 18px;
  border: 1px solid rgba(0, 229, 255, 0.45);
  border-radius: 9px;
  background: transparent;
  color: var(--accent);
  font-size: 10px;
  line-height: 16px;
  cursor: pointer;
}
.dr-gen:hover {
  background: rgba(0, 229, 255, 0.18);
  box-shadow: 0 0 8px rgba(0, 229, 255, 0.35);
}
.dr-group.block .dr-item {
  color: var(--text-secondary);
  border-left-color: rgba(255, 82, 82, 0.5);
}
</style>
