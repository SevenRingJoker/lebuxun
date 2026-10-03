<script setup lang="ts">
// s49 卡片式任务看板：待办/进行中/待验收/完成 四列；
// 卡片显示 s 编号、优先级、验收证据；进行中卡片支持暂停与回滚，
// 待验收卡片可通过/退回；优先级可人工改派。
import { useKanbanStore } from '../stores/kanban'
import { useChatStore } from '../stores/chat'
import type { KanbanColumn, KanbanPriority } from '../../../shared/kanban/kanban'

const kb = useKanbanStore()
const chat = useChatStore()

const COLUMNS: KanbanColumn[] = ['todo', 'doing', 'review', 'done']
const COLUMN_HEAD: Record<KanbanColumn, string> = {
  todo: '待办',
  doing: '进行中',
  review: '待验收',
  done: '完成'
}
const PRIORITIES: KanbanPriority[] = ['high', 'medium', 'low']
const PRIORITY_LABEL: Record<KanbanPriority, string> = {
  high: '高',
  medium: '中',
  low: '低'
}

// s50 角色循环（含「未指定」）
const ROLE_CYCLE = ['', 'frontend', 'backend', 'test']
const ROLE_LABEL: Record<string, string> = {
  frontend: '前端',
  backend: '后端',
  test: '测试'
}

async function onCycleRole(sid: string, current?: string): Promise<void> {
  const next = ROLE_CYCLE[(ROLE_CYCLE.indexOf(current ?? '') + 1) % ROLE_CYCLE.length]
  await kb.changeRole(sid, next)
}

async function onDispatch(sid?: string): Promise<void> {
  await kb.dispatchTodo(sid ? [sid] : undefined)
}

async function onPause(sid: string): Promise<void> {
  await kb.pause(sid, async () => {
    await chat.pauseRunning()
  })
}

async function onRollback(sid: string, taskId: string | null): Promise<void> {
  await kb.rollback(sid, taskId)
}

async function cyclePriority(sid: string, current: KanbanPriority): Promise<void> {
  const next = PRIORITIES[(PRIORITIES.indexOf(current) + 1) % PRIORITIES.length]
  await kb.changePriority(sid, next)
}
</script>

<template>
  <div v-if="kb.visible" class="kb-overlay" @click.self="kb.close()">
    <div class="kb-panel cp-glass">
      <header class="kb-head">
        <span class="kb-title">▦ 任务看板</span>
        <span class="kb-count">{{ kb.total }} 卡片</span>
        <button
          class="kb-dispatch-all"
          :disabled="kb.groups.todo.length === 0"
          title="把待办列全部卡片派给角色 Agent 并行执行"
          @click="onDispatch()"
        >↻ 派发待办</button>
        <span class="kb-spacer"></span>
        <button class="kb-x" title="关闭" @click="kb.close()">×</button>
      </header>

      <div class="kb-cols">
        <section v-for="col in COLUMNS" :key="col" class="kb-col" :class="'col-' + col">
          <div class="kb-col-head">
            {{ COLUMN_HEAD[col] }}
            <span class="kb-col-count">{{ kb.groups[col].length }}</span>
          </div>

          <div class="kb-cards">
            <div v-for="c in kb.groups[col]" :key="c.sid" class="kb-card">
              <div class="kb-card-top">
                <span class="kb-sid">{{ c.sid }}</span>
                <button
                  class="kb-prio"
                  :class="'p-' + c.priority"
                  title="点击改派优先级"
                  @click="cyclePriority(c.sid, c.priority)"
                >{{ PRIORITY_LABEL[c.priority] }}</button>
              </div>
              <div class="kb-card-title" :title="c.title">{{ c.title }}</div>

              <!-- 验收证据 -->
              <ul v-if="c.evidence.length" class="kb-evidence">
                <li v-for="(e, i) in c.evidence" :key="i">{{ e }}</li>
              </ul>

              <!-- 暂停标记 -->
              <div v-if="c.pauseRequested" class="kb-pause-tag">暂停请求中…</div>

              <!-- 操作区 -->
              <div class="kb-ops">
                <template v-if="col === 'todo'">
                  <button class="kb-op role" title="点击切换分派角色（前端/后端/测试）"
                    @click="onCycleRole(c.sid, c.role)">
                    {{ c.role ? ROLE_LABEL[c.role] : '角色' }}
                  </button>
                  <button class="kb-op ok" title="派给角色 Agent 执行" @click="onDispatch(c.sid)">派发</button>
                </template>
                <template v-else-if="col === 'doing'">
                  <button class="kb-op" title="暂停该卡片任务" @click="onPause(c.sid)">暂停</button>
                  <button class="kb-op danger" title="回滚到任务前检查点" @click="onRollback(c.sid, c.taskId)">
                    回滚
                  </button>
                </template>
                <template v-else-if="col === 'review'">
                  <button class="kb-op ok" title="验收通过" @click="kb.accept(c.sid)">通过</button>
                  <button class="kb-op" title="退回返工" @click="kb.manualMove(c.sid, 'doing')">退回</button>
                </template>
                <template v-else-if="col === 'done'">
                  <button class="kb-op" title="重新打开" @click="kb.manualMove(c.sid, 'todo')">重开</button>
                </template>
              </div>
            </div>

            <div v-if="kb.groups[col].length === 0" class="kb-col-empty">—</div>
          </div>
        </section>
      </div>

      <!-- s50 汇总 Agent 裁决报告 -->
      <div v-if="kb.lastReport" class="kb-report">
        <div class="kb-report-head">汇总裁决</div>
        <pre class="kb-report-pre">{{ kb.lastReport }}</pre>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 科技蓝青暗色看板 */
.kb-overlay {
  position: fixed; inset: 0; z-index: 89;
  background: rgba(2, 6, 12, 0.55);
  display: flex; align-items: center; justify-content: center;
}
.kb-panel {
  width: 1080px; max-width: 96vw; height: 86vh;
  display: flex; flex-direction: column;
  border: 1px solid rgba(0, 212, 255, 0.3);
  border-radius: 10px;
}
.kb-head {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid rgba(0, 212, 255, 0.2);
}
.kb-title { font-weight: 700; color: #5ff0e2; letter-spacing: 1px; }
.kb-count { font-size: 11px; color: #7a8499; }
.kb-spacer { flex: 1; }
.kb-x { background: none; border: none; color: #7a8499; cursor: pointer; font-size: 16px; }
.kb-x:hover { color: #fff; }

.kb-cols {
  flex: 1; display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px; padding: 12px; min-height: 0;
}
.kb-col {
  display: flex; flex-direction: column; min-height: 0;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.05);
}
.kb-col-head {
  padding: 8px 12px; font-size: 12px; font-weight: 700;
  color: #b8e6ff; letter-spacing: 1px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}
.col-review .kb-col-head { color: #ffd98a; }
.col-done .kb-col-head { color: #5ff0e2; }
.kb-col-count {
  margin-left: 6px; font-size: 10px; color: #7a8499; font-weight: 400;
}
.kb-cards { flex: 1; overflow: auto; padding: 8px; }
.kb-col-empty { text-align: center; color: #46506a; padding: 20px 0; font-size: 12px; }

.kb-card {
  margin-bottom: 8px; padding: 8px 10px; border-radius: 7px;
  background: rgba(6, 12, 22, 0.7);
  border: 1px solid rgba(0, 212, 255, 0.15);
}
.kb-card-top { display: flex; justify-content: space-between; align-items: center; }
.kb-sid { font-size: 10px; color: #5ff0e2; font-family: monospace; }
.kb-prio {
  font-size: 10px; padding: 0 7px; border-radius: 3px; cursor: pointer;
  background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(255, 255, 255, 0.1);
  color: #b8c2d9;
}
.kb-prio.p-high { background: rgba(255, 107, 107, 0.15); color: #ff9d9d; border-color: rgba(255, 107, 107, 0.4); }
.kb-prio.p-low { background: rgba(122, 132, 153, 0.12); color: #8b95ab; }
.kb-card-title {
  margin: 6px 0; font-size: 12px; color: #d3dcea; line-height: 1.4;
}
.kb-evidence {
  margin: 4px 0 0; padding-left: 14px;
  font-size: 10px; color: #7a8499;
}
.kb-evidence li { margin: 1px 0; word-break: break-all; }
.kb-pause-tag { font-size: 10px; color: #ffd98a; margin: 4px 0; }

.kb-ops { margin-top: 6px; display: flex; gap: 6px; }
.kb-op {
  font-size: 10px; padding: 2px 10px; border-radius: 4px; cursor: pointer;
  background: rgba(0, 212, 255, 0.08); border: 1px solid rgba(0, 212, 255, 0.3);
  color: #b8e6ff;
}
.kb-op:hover { background: rgba(0, 212, 255, 0.18); }
.kb-op.ok { color: #5ff0e2; border-color: rgba(95, 240, 226, 0.4); }
.kb-op.danger {
  background: rgba(255, 107, 107, 0.1); border-color: rgba(255, 107, 107, 0.4); color: #ff9d9d;
}
.kb-op.danger:hover { background: rgba(255, 107, 107, 0.2); }

/* 派发全部按钮 */
.kb-dispatch-all {
  font-size: 11px; padding: 3px 12px; border-radius: 5px; cursor: pointer;
  background: rgba(0, 212, 255, 0.1); border: 1px solid rgba(0, 212, 255, 0.35);
  color: #b8e6ff;
}
.kb-dispatch-all:hover:not(:disabled) { background: rgba(0, 212, 255, 0.22); }
.kb-dispatch-all:disabled { opacity: 0.4; cursor: not-allowed; }
.kb-op.role { background: rgba(255, 217, 138, 0.08); border-color: rgba(255, 217, 138, 0.35); color: #ffd98a; }

/* 汇总裁决报告区 */
.kb-report {
  border-top: 1px solid rgba(0, 212, 255, 0.2);
  max-height: 30%; display: flex; flex-direction: column; min-height: 0;
}
.kb-report-head {
  padding: 6px 14px; font-size: 11px; color: #5ff0e2; letter-spacing: 1px;
}
.kb-report-pre {
  margin: 0; padding: 0 14px 10px; overflow: auto;
  font-size: 10px; color: #b8c2d9; white-space: pre-wrap; word-break: break-all;
  font-family: inherit;
}
</style>
