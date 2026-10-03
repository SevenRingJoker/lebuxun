<script setup lang="ts">
// 会话历史弹窗：搜索 / 新建 / 切换 / 重命名 / 删除（应用内确认）/ 导出 Markdown。
// 数据全部来自 chat store（按当前工作区自动隔离）；发送中禁用切换与新建。
import { ref, computed, nextTick, onMounted } from 'vue'
import { useChatStore } from '../stores/chat'

const emit = defineEmits<{ (e: 'close'): void }>()
const chat = useChatStore()

const keyword = ref('')
const notice = ref('')
const searchRef = ref<HTMLInputElement | null>(null)

// 行内重命名状态
const editingId = ref<string | null>(null)
const editingTitle = ref('')
// 删除二次确认（应用内确认，禁原生 confirm）
const confirmDeleteId = ref<string | null>(null)

const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  if (!kw) return chat.sessions
  return chat.sessions.filter(
    (s) => s.title.toLowerCase().includes(kw) || s.preview.toLowerCase().includes(kw)
  )
})

// 相对时间：刚刚 / N 分钟前 / N 小时前 / 昨天 / M月D日（跨年带年份）
function fmtTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const diff = now.getTime() - d.getTime()
  const min = 60_000
  if (diff < min) return '刚刚'
  if (diff < 60 * min) return `${Math.floor(diff / min)} 分钟前`
  if (diff < 24 * 60 * min) return `${Math.floor(diff / (60 * min))} 小时前`
  const sameDay = (a: Date, b: Date): boolean =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (sameDay(d, yesterday)) return '昨天'
  const md = `${d.getMonth() + 1}月${d.getDate()}日`
  return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}年${md}`
}

async function onNew(): Promise<void> {
  if (chat.sending) return
  await chat.newSession()
  emit('close')
}

async function onSwitch(id: string): Promise<void> {
  if (chat.sending || confirmDeleteId.value || editingId.value) return
  await chat.switchSession(id)
  emit('close')
}

function startRename(id: string, title: string): void {
  editingId.value = id
  editingTitle.value = title
  confirmDeleteId.value = null
  nextTick(() => {
    const el = document.getElementById(`rename-${id}`) as HTMLInputElement | null
    el?.focus()
    el?.select()
  })
}

async function commitRename(): Promise<void> {
  const id = editingId.value
  if (!id) return
  const title = editingTitle.value.trim()
  editingId.value = null
  if (title) await chat.renameSession(id, title)
}

function cancelRename(): void {
  editingId.value = null
}

async function onDelete(id: string): Promise<void> {
  await chat.deleteSession(id)
  confirmDeleteId.value = null
  notice.value = '会话已删除'
  setTimeout(() => (notice.value = ''), 2000)
}

async function onExport(id: string): Promise<void> {
  const res = await chat.exportSession(id)
  if (res.ok) {
    notice.value = '已导出 Markdown 文件'
  } else if (!res.canceled) {
    notice.value = res.error || '导出失败'
  }
  if (res.ok || res.error) setTimeout(() => (notice.value = ''), 2500)
}

onMounted(() => searchRef.value?.focus())
</script>

<template>
  <div class="modal-overlay" @click.self="emit('close')">
    <div class="history-modal">
      <div class="history-header">
        <span class="history-title">会话历史</span>
        <div class="header-actions">
          <button class="btn-new" :disabled="chat.sending" :title="chat.sending ? 'AI 回复结束后再开新会话' : '新建会话'" @click="onNew">
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
              <path fill="currentColor" d="M8 2a.8.8 0 0 1 .8.8v4.4h4.4a.8.8 0 0 1 0 1.6H8.8v4.4a.8.8 0 0 1-1.6 0V8.8H2.8a.8.8 0 0 1 0-1.6h4.4V2.8A.8.8 0 0 1 8 2Z"/>
            </svg>
            新会话
          </button>
          <button class="btn-close" title="关闭" @click="emit('close')">✕</button>
        </div>
      </div>

      <div class="search-row">
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
          <path fill="currentColor" d="M11.4 12.6a6.5 6.5 0 1 1 1.2-1.2l2.5 2.5a.85.85 0 0 1-1.2 1.2l-2.5-2.5Zm-4.9.15a4.75 4.75 0 1 0 0-9.5 4.75 4.75 0 0 0 0 9.5Z"/>
        </svg>
        <input ref="searchRef" v-model="keyword" type="text" placeholder="搜索标题或内容…" />
      </div>

      <div class="session-list">
        <div v-if="filtered.length === 0" class="empty-hint">
          {{ keyword ? '没有匹配的会话' : '还没有历史会话，发送一条消息开始吧' }}
        </div>
        <div
          v-for="s in filtered"
          :key="s.id"
          class="session-item"
          :class="{ active: s.id === chat.currentSessionId, disabled: chat.sending }"
          @click="onSwitch(s.id)"
        >
          <template v-if="editingId === s.id">
            <input
              :id="`rename-${s.id}`"
              v-model="editingTitle"
              class="rename-input"
              maxlength="60"
              @click.stop
              @keydown.enter.prevent="commitRename"
              @keydown.esc="cancelRename"
              @blur="commitRename"
            />
          </template>
          <template v-else>
            <div class="item-top">
              <span class="item-title">{{ s.title }}</span>
              <span v-if="s.id === chat.currentSessionId" class="current-tag">当前</span>
            </div>
            <div class="item-preview">{{ s.preview || '（无内容预览）' }}</div>
            <div class="item-meta">
              <span>{{ fmtTime(s.updatedAt) }}</span>
              <span class="dot">·</span>
              <span>{{ s.messageCount }} 条消息</span>
              <span class="item-ops" @click.stop>
                <button class="op-btn" title="重命名" @click="startRename(s.id, s.title)">
                  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                    <path fill="currentColor" d="M11.3 1.7a1.7 1.7 0 0 1 2.4 0l.6.6a1.7 1.7 0 0 1 0 2.4L6 13l-3.6 1L3.4 10l7.9-8.3Zm1 .9L12 2.3a.5.5 0 0 0-.7 0L10.5 3.1l2.4 2.4.8-.8a.5.5 0 0 0 0-.7l-1.4-1.4ZM9.7 4.3 4.9 9.1l-.5 1.9 1.9-.5 4.8-4.8-1.4-1.4Z"/>
                  </svg>
                </button>
                <button class="op-btn" title="导出 Markdown" @click="onExport(s.id)">
                  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                    <path fill="currentColor" d="M8 1a.75.75 0 0 1 .75.75v6.05l1.9-1.7a.75.75 0 1 1 1 1.12l-3.2 2.85a.75.75 0 0 1-1 0L4.25 7.2a.75.75 0 1 1 1-1.12l1.9 1.7V1.75A.75.75 0 0 1 8 1ZM2.5 11a.75.75 0 0 1 .75.75v1.5c0 .14.11.25.25.25h9a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 12.5 15h-9A1.75 1.75 0 0 1 1.75 13.25v-1.5A.75.75 0 0 1 2.5 11Z"/>
                  </svg>
                </button>
                <button class="op-btn danger" title="删除" @click="confirmDeleteId = s.id; editingId = null">
                  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                    <path fill="currentColor" d="M6.5 1a.5.5 0 0 0-.5.5V2H3.2a.7.7 0 0 0 0 1.4h.4l.6 10.3A1.5 1.5 0 0 0 5.7 15h4.6a1.5 1.5 0 0 0 1.5-1.3l.6-10.3h.4a.7.7 0 0 0 0-1.4H10v-.5a.5.5 0 0 0-.5-.5h-3ZM5.5 3h5l-.6 10.5h-3.8L5.5 3Zm1 1.7a.5.5 0 0 1 .5.5v6.5a.5.5 0 0 1-1 0V5.2a.5.5 0 0 1 .5-.5Zm3 0a.5.5 0 0 1 .5.5v6.5a.5.5 0 0 1-1 0V5.2a.5.5 0 0 1 .5-.5Z"/>
                  </svg>
                </button>
              </span>
            </div>
            <!-- 删除二次确认行 -->
            <div v-if="confirmDeleteId === s.id" class="confirm-row" @click.stop>
              <span>确认删除该会话？不可恢复</span>
              <button class="btn-confirm-danger" @click="onDelete(s.id)">删除</button>
              <button class="btn-confirm-cancel" @click="confirmDeleteId = null">取消</button>
            </div>
          </template>
        </div>
      </div>

      <div v-if="chat.sending" class="sending-hint">AI 回复进行中，完成后可切换或新建会话</div>
      <Transition name="fade">
        <div v-if="notice" class="history-notice">{{ notice }}</div>
      </Transition>
    </div>
  </div>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 2000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
}
.history-modal {
  width: 560px;
  max-width: calc(100vw - 48px);
  max-height: 78vh;
  display: flex;
  flex-direction: column;
  border-radius: 10px;
  border: 1px solid var(--border-light);
  background: var(--bg-secondary);
  box-shadow: 0 0 0 1px var(--border-glow), 0 12px 40px rgba(0, 0, 0, 0.5);
  overflow: hidden;
}
.history-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
}
.history-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}
.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.btn-new {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  font-size: 12px;
  border-radius: 6px;
  color: var(--accent);
  background: var(--accent-dim);
  border: 1px solid var(--border-glow);
  cursor: pointer;
}
.btn-new:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.btn-close {
  border: none;
  background: none;
  color: var(--text-muted);
  font-size: 13px;
  cursor: pointer;
  padding: 2px 6px;
}
.btn-close:hover { color: var(--text-primary); }

.search-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 12px 16px 8px;
  padding: 7px 10px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--text-muted);
}
.search-row input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 13px;
}

.session-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 8px 12px;
}
.empty-hint {
  padding: 40px 16px;
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
}
.session-item {
  position: relative;
  margin: 4px 8px;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid transparent;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
}
.session-item:hover {
  background: var(--bg-hover);
  border-color: var(--border-light);
}
.session-item.active {
  background: var(--accent-dim);
  border-color: var(--border-glow);
}
.session-item.disabled { cursor: wait; }
.item-top {
  display: flex;
  align-items: center;
  gap: 8px;
}
.item-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.current-tag {
  flex: none;
  font-size: 10px;
  line-height: 1;
  padding: 2px 6px;
  border-radius: 8px;
  color: var(--accent);
  border: 1px solid var(--border-glow);
  background: var(--bg-panel);
}
.item-preview {
  margin-top: 3px;
  font-size: 12px;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.item-meta {
  margin-top: 5px;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-muted);
}
.dot { opacity: 0.6; }
.item-ops {
  margin-left: auto;
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.12s;
}
.session-item:hover .item-ops,
.session-item.active .item-ops { opacity: 1; }
.op-btn {
  display: inline-flex;
  padding: 3px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}
.op-btn:hover { color: var(--accent); background: var(--bg-panel); }
.op-btn.danger:hover { color: var(--danger); }

.rename-input {
  width: 100%;
  padding: 5px 8px;
  font-size: 13px;
  border-radius: 6px;
  border: 1px solid var(--accent);
  background: var(--bg-panel);
  color: var(--text-primary);
  outline: none;
}
.confirm-row {
  margin-top: 8px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: 6px;
  font-size: 12px;
  color: var(--danger);
  background: var(--bg-panel);
  border: 1px solid var(--danger);
}
.btn-confirm-danger {
  margin-left: auto;
  padding: 3px 10px;
  font-size: 12px;
  border-radius: 5px;
  color: #fff;
  background: var(--danger);
  border: none;
  cursor: pointer;
}
.btn-confirm-cancel {
  padding: 3px 10px;
  font-size: 12px;
  border-radius: 5px;
  color: var(--text-secondary);
  background: transparent;
  border: 1px solid var(--border);
  cursor: pointer;
}
.sending-hint {
  padding: 8px 16px;
  font-size: 11px;
  text-align: center;
  color: var(--text-muted);
  border-top: 1px solid var(--border);
}
.history-notice {
  position: absolute;
  bottom: 18px;
  left: 50%;
  transform: translateX(-50%);
  padding: 6px 14px;
  border-radius: 16px;
  font-size: 12px;
  color: var(--text-primary);
  background: var(--bg-panel);
  border: 1px solid var(--border-glow);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
}
.fade-enter-active, .fade-leave-active { transition: opacity 0.2s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
