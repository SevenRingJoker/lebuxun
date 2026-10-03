<script setup lang="ts">
// ㊜ 未完成任务恢复条：应用启动 / 工作区切换后，若存在崩溃中断（running 残留 → interrupted）
// 或用户软暂停（paused，1b 起）的任务，在消息区顶部提示：
// 「继续」沿用原模型续跑；「放弃」带可选任务前检查点回滚。
// 注意：live 任务（本进程仍在运行/挂起）不在这里控制，由 ChatPanel 输入区运行门承载。
import { ref } from 'vue'
import { useChatStore } from '../stores/chat'
import type { UiRecoverableTask } from '../api'

const chat = useChatStore()

// 当前展开放弃确认的任务 id（同时只允许一条）
const confirmingId = ref<string | null>(null)
// 回滚勾选：默认随检查点存在与否勾选；无检查点时强制 false 且禁用
const rollbackChecked = ref(true)

/** 请求摘要：单行截断 */
function brief(t: UiRecoverableTask): string {
  return t.userRequest.replace(/\s+/g, ' ').slice(0, 60)
}

/** 相对时间（中文；分钟内显示"刚刚"） */
function relTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  const min = Math.floor(diff / 60_000)
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  return `${Math.floor(hr / 24)} 天前`
}

function openConfirm(t: UiRecoverableTask): void {
  confirmingId.value = t.taskId
  rollbackChecked.value = !!t.preTaskCheckpoint
}
function cancelConfirm(): void {
  confirmingId.value = null
}

async function doContinue(t: UiRecoverableTask): Promise<void> {
  if (chat.sending) return
  await chat.resumeTask(t.taskId)
}

async function doAbandon(t: UiRecoverableTask): Promise<void> {
  const rollback = rollbackChecked.value && !!t.preTaskCheckpoint
  confirmingId.value = null
  await chat.abandonTask(t.taskId, rollback)
}
</script>

<template>
  <div v-if="chat.recoverableTasks.length > 0" class="recovery-bar cp-glass">
    <div v-for="t in chat.recoverableTasks" :key="t.taskId" class="rb-item">
      <!-- 确认弹层以外的常规行 -->
      <template v-if="confirmingId !== t.taskId">
        <span class="rb-icon">↻</span>
        <div class="rb-main">
          <div class="rb-request">{{ brief(t) }}</div>
          <div class="rb-meta">
            第 {{ t.startRound }} 轮{{ t.status === 'paused' ? '暂停' : '中断' }} · {{ t.createdCount }} 个产物 · {{ relTime(t.updatedAt) }}
          </div>
        </div>
        <button class="rb-btn continue" type="button" :disabled="chat.sending" @click="doContinue(t)">
          继续
        </button>
        <button class="rb-btn abandon" type="button" @click="openConfirm(t)">放弃</button>
      </template>

      <!-- 放弃确认：回滚是破坏性操作（reset --hard），必须强确认 -->
      <div v-else class="rb-confirm">
        <span class="rb-confirm-text">
          放弃该任务？<template v-if="!t.preTaskCheckpoint">（无任务前检查点，不可回滚）</template>
        </span>
        <label class="rb-check" :class="{ disabled: !t.preTaskCheckpoint }">
          <input
            v-model="rollbackChecked"
            type="checkbox"
            :disabled="!t.preTaskCheckpoint"
          >
          同时回滚到任务前检查点
        </label>
        <div class="rb-confirm-actions">
          <button class="rb-btn" type="button" @click="cancelConfirm">取消</button>
          <button class="rb-btn danger" type="button" @click="doAbandon(t)">确认放弃</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.recovery-bar {
  width: 100%;
  margin-bottom: 8px;
  padding: 8px 12px;
  border: 1px solid rgba(0, 229, 255, 0.28);
  border-radius: 8px;
  background: var(--bg-panel);
  /* 科技感：青色内辉光，提示"系统检测到可恢复状态" */
  box-shadow: inset 0 0 18px rgba(0, 229, 255, 0.06), 0 0 12px rgba(0, 229, 255, 0.08);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.rb-item {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
}
.rb-icon {
  flex: none;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 1px solid rgba(0, 229, 255, 0.5);
  color: var(--accent);
  text-align: center;
  line-height: 16px;
  font-size: 11px;
}
.rb-main {
  flex: 1;
  min-width: 0;
}
.rb-request {
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.rb-meta {
  color: var(--text-muted);
  font-size: 10px;
  margin-top: 1px;
}
.rb-btn {
  flex: none;
  height: 22px;
  padding: 0 12px;
  border: 1px solid var(--border-light);
  border-radius: 11px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 11px;
  cursor: pointer;
  transition: all 0.12s;
}
.rb-btn:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}
.rb-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.rb-btn.continue {
  border-color: rgba(0, 229, 255, 0.55);
  color: var(--accent);
}
.rb-btn.continue:hover:not(:disabled) {
  background: rgba(0, 229, 255, 0.15);
  box-shadow: 0 0 10px rgba(0, 229, 255, 0.3);
}
.rb-btn.abandon:hover {
  border-color: var(--danger);
  color: var(--danger);
}
.rb-btn.danger {
  border-color: var(--danger);
  color: var(--danger);
}
.rb-btn.danger:hover {
  background: rgba(255, 82, 82, 0.14);
}
/* 确认弹层占满整行 */
.rb-confirm {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.rb-confirm-text {
  color: var(--text-primary);
}
.rb-check {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--text-secondary);
  font-size: 11px;
  cursor: pointer;
  user-select: none;
}
.rb-check.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.rb-check input {
  accent-color: var(--accent);
  margin: 0;
}
.rb-confirm-actions {
  margin-left: auto;
  display: flex;
  gap: 8px;
}
</style>
