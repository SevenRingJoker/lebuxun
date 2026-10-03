<script setup lang="ts">
// s45/s46 修复确认卡片：命令失败/自动回归失败 → 分类 + 修复动作清单，用户确认后执行。
// 修复执行前主进程已打 git 检查点；失败可一键回滚。修复成功关闭卡片。
import { computed } from 'vue'
import { useRepairStore } from '../stores/repair'
import { useWorkspaceStore } from '../stores/workspace'

const repair = useRepairStore()
const ws = useWorkspaceStore()

const CAT_LABEL: Record<string, string> = {
  'missing-dep': '缺依赖',
  'version-conflict': '版本冲突',
  system: '系统差异',
  code: '代码错误',
  unknown: '未识别'
}
const RISK_LABEL: Record<string, string> = { low: '低风险', medium: '中风险', high: '高风险' }

const p = computed(() => repair.proposal)
const executable = computed(() => p.value?.actions.filter((a) => a.command) ?? [])
const advisory = computed(() => p.value?.actions.filter((a) => !a.command) ?? [])
</script>

<template>
  <!-- 自动回归轻提示（无提案卡片时展示） -->
  <div v-if="!p && repair.autoTest && repair.autoTest.ran" class="rp-toast" :class="{ bad: !repair.autoTest.ok }">
    <template v-if="repair.autoTest.ok">
      ✅ 自动回归通过（{{ repair.autoTest.tests?.length }} 个受影响测试）
    </template>
    <template v-else>
      ❌ 自动回归失败：{{ (repair.autoTest.tests || []).join('、') }}
    </template>
  </div>

  <!-- 修复确认卡片 -->
  <div v-if="p" class="rp-card">
    <header class="rp-head">
      <span class="rp-cat" :class="'cat-' + p.report.category">{{ CAT_LABEL[p.report.category] || p.report.category }}</span>
      <span class="rp-origin">{{ p.origin === 'test' ? '自动回归失败' : '命令失败' }}</span>
      <span class="rp-cmd" :title="p.command">{{ p.command }}</span>
      <button class="rp-x" title="忽略本次失败（同类不再提示）" @click="repair.dismiss()">×</button>
    </header>

    <div class="rp-summary">{{ p.report.summary }}</div>
    <ul v-if="p.report.hints.length" class="rp-hints">
      <li v-for="(h, i) in p.report.hints" :key="i">{{ h }}</li>
    </ul>

    <!-- 可执行修复动作：逐个确认执行 -->
    <div v-if="executable.length" class="rp-actions">
      <button
        v-for="a in executable"
        :key="a.id"
        class="rp-act"
        :class="{ running: repair.running && repair.activeActionId === a.id }"
        :disabled="repair.running"
        :title="a.note"
        @click="repair.run(ws.rootPath || p.cwd, a.id)"
      >
        <span class="rp-act-label">{{ repair.running && repair.activeActionId === a.id ? '执行中…' : a.label }}</span>
        <span class="rp-risk" :class="'risk-' + a.risk">{{ RISK_LABEL[a.risk] }}</span>
      </button>
    </div>
    <!-- 纯建议（无命令） -->
    <ul v-if="advisory.length" class="rp-advice">
      <li v-for="a in advisory" :key="a.id">💡 {{ a.label }}：{{ a.note }}</li>
    </ul>

    <!-- 执行结果：成功关卡片 / 失败给尾部输出与回滚 -->
    <div v-if="repair.result" class="rp-result" :class="{ ok: repair.result.ok }">
      <template v-if="repair.result.ok">
        ✅ 修复命令执行成功（exitCode=0）
        <span v-if="repair.result.checkpointHash" class="rp-cp">检查点 {{ repair.result.checkpointHash.slice(0, 8) }}</span>
        <button class="rp-btn" @click="repair.close()">完成</button>
        <button v-if="repair.result.checkpointHash" class="rp-btn ghost" title="回滚到修复前检查点"
          @click="repair.rollback(ws.rootPath || p.cwd)">回滚</button>
      </template>
      <template v-else>
        ❌ 修复未生效（exitCode={{ repair.result.exitCode }}）
        <pre class="rp-tail">{{ repair.result.tail }}</pre>
        <button v-if="repair.result.checkpointHash" class="rp-btn" title="回滚到修复前检查点"
          @click="repair.rollback(ws.rootPath || p.cwd)">回滚到修复前</button>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* 科技蓝青暗色：与 ChatPanel/StagingPanel 同色系 */
.rp-toast {
  position: fixed; right: 16px; bottom: 120px; z-index: 90;
  padding: 8px 12px; border-radius: 8px; font-size: 12px;
  background: rgba(46, 230, 214, 0.08); border: 1px solid rgba(46, 230, 214, 0.35);
  color: #5ff0e2; max-width: 420px;
}
.rp-toast.bad { background: rgba(255, 107, 107, 0.08); border-color: rgba(255, 107, 107, 0.4); color: #ff9d9d; }

.rp-card {
  position: fixed; right: 16px; bottom: 120px; z-index: 91; width: 460px;
  background: var(--panel-bg, #10151f); border: 1px solid rgba(0, 212, 255, 0.3);
  border-radius: 10px; padding: 12px 14px; font-size: 12px; color: var(--text-secondary, #b8c2d9);
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.45);
}
.rp-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.rp-cat { padding: 1px 8px; border-radius: 4px; font-weight: 700; font-size: 11px; }
.cat-missing-dep { background: rgba(255, 171, 64, 0.15); color: #ffcc80; }
.cat-version-conflict { background: rgba(255, 107, 107, 0.15); color: #ff9d9d; }
.cat-system { background: rgba(186, 104, 200, 0.15); color: #ce93d8; }
.cat-code, .cat-unknown { background: rgba(120, 144, 156, 0.15); color: #b0bec5; }
.rp-origin { color: var(--text-muted, #7a8499); }
.rp-cmd { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #5ff0e2; font-family: monospace; }
.rp-x { background: none; border: none; color: var(--text-muted, #7a8499); cursor: pointer; font-size: 14px; }
.rp-x:hover { color: #fff; }

.rp-summary { margin-bottom: 6px; word-break: break-all; }
.rp-hints { margin: 0 0 8px; padding-left: 16px; color: var(--text-muted, #7a8499); }
.rp-hints li { margin: 2px 0; }

.rp-actions { display: flex; flex-direction: column; gap: 6px; margin-bottom: 6px; }
.rp-act {
  display: flex; justify-content: space-between; align-items: center; gap: 8px;
  padding: 6px 10px; border-radius: 6px; cursor: pointer; text-align: left;
  background: rgba(0, 212, 255, 0.06); border: 1px solid rgba(0, 212, 255, 0.25); color: #b8e6ff;
}
.rp-act:hover:not(:disabled) { border-color: rgba(46, 230, 214, 0.6); }
.rp-act:disabled { opacity: 0.6; cursor: wait; }
.rp-act-label { font-family: monospace; }
.rp-risk { font-size: 10px; padding: 0 6px; border-radius: 3px; }
.risk-low { background: rgba(46, 230, 214, 0.12); color: #5ff0e2; }
.risk-medium { background: rgba(255, 171, 64, 0.15); color: #ffcc80; }
.risk-high { background: rgba(255, 107, 107, 0.18); color: #ff9d9d; }

.rp-advice { margin: 0 0 6px; padding-left: 4px; list-style: none; color: var(--text-muted, #7a8499); }
.rp-result { margin-top: 8px; padding-top: 8px; border-top: 1px dashed rgba(255, 255, 255, 0.1); }
.rp-result.ok { color: #5ff0e2; }
.rp-cp { margin: 0 6px; color: var(--text-muted, #7a8499); font-family: monospace; }
.rp-tail {
  max-height: 120px; overflow: auto; margin: 6px 0; padding: 6px;
  background: rgba(0, 0, 0, 0.3); border-radius: 6px; font-size: 11px; white-space: pre-wrap;
}
.rp-btn {
  margin-right: 6px; padding: 3px 10px; border-radius: 5px; cursor: pointer;
  background: rgba(46, 230, 214, 0.12); border: 1px solid rgba(46, 230, 214, 0.4); color: #5ff0e2;
}
.rp-btn.ghost { background: none; color: var(--text-muted, #7a8499); }
</style>
