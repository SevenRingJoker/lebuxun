<script setup lang="ts">
// s47 一键打包卡片：启动 dir/dist 打包，过程日志实时滚动，完成后展示产物清单与版本号。
import { ref, watch, nextTick, onMounted } from 'vue'
import { useBuildStore } from '../stores/build'

const build = useBuildStore()
const logRef = ref<HTMLDivElement | null>(null)

// 日志追加时自动滚到底
watch(
  () => build.logs.length,
  async () => {
    await nextTick()
    logRef.value?.scrollTo({ top: logRef.value.scrollHeight })
  }
)

onMounted(async () => {
  // 打开卡片时同步一次状态（打包可能在别处已启动）
  build.running = (await window.api.build.status()).running
})

function fmtMs(ms: number): string {
  const s = Math.round(ms / 1000)
  return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`
}
</script>

<template>
  <div v-if="build.visible" class="bd-card">
    <header class="bd-head">
      <span class="bd-title">📦 一键打包</span>
      <span v-if="build.running" class="bd-state run">打包中…</span>
      <span v-else-if="build.done" class="bd-state" :class="{ ok: build.done.ok, bad: !build.done.ok }">
        {{ build.done.ok ? '完成' : '失败' }}
      </span>
      <span class="bd-spacer" />
      <button class="bd-x" title="关闭" @click="build.visible = false">×</button>
    </header>

    <!-- 空闲：两个启动入口 -->
    <div v-if="!build.running && !build.done" class="bd-start">
      <button class="bd-btn" title="只产解包目录，验证打包链路" @click="build.start('dir')">
        快速验证（--dir）
      </button>
      <button class="bd-btn primary" title="NSIS 安装包 + portable exe" @click="build.start('dist')">
        完整产物（dist）
      </button>
    </div>

    <!-- 日志（任务面板可见） -->
    <div v-if="build.logs.length" ref="logRef" class="bd-log">
      <div v-for="(line, i) in build.logs" :key="i">{{ line }}</div>
    </div>

    <!-- 结果：产物路径与版本号回写 -->
    <div v-if="build.done" class="bd-done" :class="{ ok: build.done.ok }">
      <template v-if="build.done.ok">
        <div class="bd-line">✅ v{{ build.done.version }} · 耗时 {{ fmtMs(build.done.durationMs) }}</div>
        <ul class="bd-artifacts">
          <li v-for="a in build.done.artifacts" :key="a" :title="a">{{ a }}</li>
        </ul>
        <button class="bd-btn" @click="build.openRelease()">打开 release 目录</button>
        <button class="bd-btn ghost" @click="build.done = null">再次打包</button>
      </template>
      <template v-else>
        <div class="bd-line">❌ 打包失败（code={{ build.done.code }}），详见上方日志</div>
        <button class="bd-btn ghost" @click="build.done = null">重试</button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.bd-card {
  position: fixed; right: 16px; bottom: 120px; z-index: 92; width: 520px;
  background: var(--panel-bg, #10151f); border: 1px solid rgba(0, 212, 255, 0.3);
  border-radius: 10px; padding: 12px 14px; font-size: 12px; color: var(--text-secondary, #b8c2d9);
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.45);
}
.bd-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.bd-title { font-weight: 700; color: #5ff0e2; }
.bd-state { padding: 0 8px; border-radius: 4px; font-size: 11px; }
.bd-state.run { background: rgba(0, 212, 255, 0.12); color: #7fd8ff; animation: bdPulse 1.2s infinite; }
.bd-state.ok { background: rgba(46, 230, 214, 0.12); color: #5ff0e2; }
.bd-state.bad { background: rgba(255, 107, 107, 0.15); color: #ff9d9d; }
@keyframes bdPulse { 50% { opacity: 0.5; } }
.bd-spacer { flex: 1; }
.bd-x { background: none; border: none; color: var(--text-muted, #7a8499); cursor: pointer; font-size: 14px; }
.bd-x:hover { color: #fff; }

.bd-start { display: flex; gap: 8px; }
.bd-btn {
  padding: 5px 12px; border-radius: 6px; cursor: pointer;
  background: rgba(0, 212, 255, 0.08); border: 1px solid rgba(0, 212, 255, 0.3); color: #b8e6ff;
}
.bd-btn.primary { background: rgba(46, 230, 214, 0.12); border-color: rgba(46, 230, 214, 0.5); color: #5ff0e2; }
.bd-btn.ghost { background: none; color: var(--text-muted, #7a8499); }
.bd-btn:hover { border-color: rgba(46, 230, 214, 0.7); }

.bd-log {
  max-height: 200px; overflow: auto; margin: 8px 0; padding: 6px 8px;
  background: rgba(0, 0, 0, 0.35); border-radius: 6px;
  font-family: monospace; font-size: 11px; white-space: pre-wrap; word-break: break-all;
}
.bd-done { margin-top: 8px; padding-top: 8px; border-top: 1px dashed rgba(255, 255, 255, 0.1); }
.bd-line { margin-bottom: 6px; }
.bd-done.ok .bd-line { color: #5ff0e2; }
.bd-artifacts { margin: 0 0 8px; padding-left: 16px; font-family: monospace; font-size: 11px; }
.bd-artifacts li { margin: 2px 0; overflow: hidden; text-overflow: ellipsis; }
</style>
