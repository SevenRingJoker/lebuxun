<script setup lang="ts">
// 工具事件卡片：在消息流中实时展示一次工具调用的全过程。
// 折叠态一行：状态图标（运行中/成功/失败）+ 工具名 + 参数摘要 + 耗时；
// 点击展开：等宽 pre 展示完整工具结果文本。
import { ref, computed } from 'vue'
import type { ChatMessage } from '../stores/chat'

const props = defineProps<{ msg: ChatMessage }>()

// 展开状态（默认折叠，避免长结果刷屏）
const expanded = ref(false)

// 工具事件元数据（onToolCall 时建立、onToolResult 时回填）
const ev = computed(() => props.msg.toolEvent)

// 状态图标：运行中三点动画、成功/失败/已取消用彩色小圆点
const statusColor = computed(() => {
  if (ev.value?.status === 'ok') return 'var(--success)'
  if (ev.value?.status === 'fail') return 'var(--danger-soft)'
  if (ev.value?.status === 'cancelled') return 'var(--warning)'
  return 'var(--accent)'
})

// 耗时文本：≥1s 显示秒（一位小数），否则显示毫秒
const durationText = computed(() => {
  const ms = ev.value?.durationMs
  if (ms === undefined) return ''
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
})

// 结果是否值得展开：非空且非运行中
const canExpand = computed(() => ev.value?.status !== 'running' && !!props.msg.content)
</script>

<template>
  <div
    v-if="ev"
    class="tool-event cp-glass"
    :class="ev.status"
    role="button"
    :tabindex="canExpand ? 0 : -1"
    :aria-expanded="canExpand ? expanded : undefined"
    @click="canExpand && (expanded = !expanded)"
    @keydown.enter="canExpand && (expanded = !expanded)"
    @keydown.space.prevent="canExpand && (expanded = !expanded)"
  >
    <div class="te-head">
      <span class="te-icon">
        <!-- 运行中用三点动画；其它状态用彩色小圆点 -->
        <span v-if="ev.status === 'running'" class="te-spinner"><i></i><i></i><i></i></span>
        <span v-else class="te-dot" :style="{ background: statusColor }"></span>
      </span>
      <span class="te-name">{{ msg.toolName }}</span>
      <span class="te-brief">{{ ev.argsBrief }}</span>
      <span v-if="ev.status === 'cancelled'" class="te-cancelled">已取消</span>
      <span v-if="durationText" class="te-duration">{{ durationText }}</span>
      <span v-if="canExpand" class="te-chevron" :class="{ open: expanded }">▾</span>
    </div>
    <!-- 完整结果：展开后纯文本展示（结果已经 contentGuard 脱敏） -->
    <pre v-if="canExpand && expanded" class="te-result">{{ msg.content }}</pre>
  </div>
</template>

<style scoped>
/* 卡片不做气泡包裹样式，独立成块嵌入消息流 */
.tool-event {
  align-self: flex-start;
  max-width: 88%;
  margin: 3px 0;
  padding: 5px 10px;
  border: 1px solid var(--border-light);
  border-left-width: 2px;
  border-radius: 7px;
  cursor: default;
  font-size: 12px;
  background: var(--bg-panel);
}
.tool-event[role='button'] {
  cursor: pointer;
}
/* 状态配色：左侧条 + 图标 */
.tool-event.running {
  border-left-color: var(--accent);
}
.tool-event.ok {
  border-left-color: var(--success);
}
.tool-event.fail {
  border-left-color: var(--danger-soft);
}
.tool-event.cancelled {
  border-left-color: var(--warning);
}
.tool-event.cancelled .te-icon,
.te-cancelled {
  color: var(--warning);
}
.te-cancelled {
  flex: none;
  font-size: 11px;
}
.te-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.te-icon {
  flex: none;
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
/* 状态小圆点：8x8 圆点，由行内 background 决定颜色 */
.te-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
  flex-shrink: 0;
}
/* 运行中三点动画（与思考中标识同风格） */
.te-spinner {
  display: inline-flex;
  gap: 2px;
}
.te-spinner i {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--accent);
  animation: te-blink 1s infinite both;
}
.te-spinner i:nth-child(2) { animation-delay: 0.2s; }
.te-spinner i:nth-child(3) { animation-delay: 0.4s; }
@keyframes te-blink {
  0%, 80%, 100% { opacity: 0.2; }
  40% { opacity: 1; }
}
.te-name {
  flex: none;
  color: var(--accent);
  font-weight: 600;
}
.te-brief {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-secondary);
}
.tool-event.fail .te-brief {
  color: var(--text-secondary);
}
.te-duration {
  flex: none;
  color: var(--text-muted);
}
.te-chevron {
  flex: none;
  color: var(--text-muted);
  transition: transform 0.15s;
}
.te-chevron.open {
  transform: rotate(180deg);
}
.te-result {
  margin: 6px 0 2px;
  padding: 8px;
  max-height: 260px;
  overflow: auto;
  border-radius: 5px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
