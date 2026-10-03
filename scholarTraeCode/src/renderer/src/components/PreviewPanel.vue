<script setup lang="ts">
// 3.1 内置浏览器预览面板：
// 地址栏 + 导航按钮 + 容器（真实页面由主进程 WebContentsView 承载，bounds 经 ResizeObserver 上报）
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { usePreviewStore } from '../stores/preview'

const preview = usePreviewStore()

// 地址栏输入（与 store.url 分离：用户输入不立即生效，Enter/按钮才提交）
const urlInput = ref('')
// 预览容器（测量位置用于 WebContentsView bounds）
const hostRef = ref<HTMLDivElement | null>(null)
// ResizeObserver：容器尺寸/位置变化 → 上报主进程
let resizeObserver: ResizeObserver | null = null
// window resize 兜底（窗口缩放时容器位置变化但自身尺寸可能不变）
let windowResizeHandler: (() => void) | null = null

const showError = computed(() => preview.error)

/** 测量容器位置并上报（相对窗口 content 区的 CSS 像素） */
async function syncBounds(): Promise<void> {
  const el = hostRef.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  await preview.reportBounds({
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height
  })
}

/** 提交 URL（Enter 或「打开」按钮） */
async function submit(): Promise<void> {
  const target = urlInput.value.trim()
  if (!target) return
  // 先激活面板再 open，保证容器已经有尺寸
  preview.active = true
  await nextTick()
  await syncBounds()
  const b = preview.lastBounds
  if (b) {
    const r = await preview.open(target, b)
    if (!r.ok) preview.error = r.error ?? '打开失败'
  }
}

/** dev server 一键探活 */
async function probeAndOpen(): Promise<void> {
  const found = await preview.probeDevServer()
  if (found) {
    urlInput.value = found
    await submit()
  } else {
    preview.error = '未检测到 localhost dev server（5173/3000/8080 等端口均无响应）'
  }
}

/** 关闭预览（销毁视图） */
async function closePreview(): Promise<void> {
  await preview.close()
}

/** 3.2 进入元素选择模式：注入脚本到预览页 */
async function enterPickMode(): Promise<void> {
  const r = await window.api.preview.enterPickMode()
  if (!r.ok) preview.error = r.error ?? '注入失败'
}

watch(
  () => preview.url,
  (u) => {
    if (u) urlInput.value = u
  }
)

onMounted(() => {
  preview.bindEvents()
  // 若已有打开中的预览（热重载/刷新后），恢复 bounds
  void window.api.preview.isOpen().then(async (r) => {
    if (r.open && r.url) {
      preview.active = true
      preview.url = r.url
      urlInput.value = r.url
      await nextTick()
      await syncBounds()
    }
  })
  resizeObserver = new ResizeObserver(() => {
    void syncBounds()
  })
  if (hostRef.value) resizeObserver.observe(hostRef.value)
  windowResizeHandler = () => {
    void syncBounds()
  }
  window.addEventListener('resize', windowResizeHandler)
})

onBeforeUnmount(async () => {
  resizeObserver?.disconnect()
  resizeObserver = null
  if (windowResizeHandler) window.removeEventListener('resize', windowResizeHandler)
  // 组件卸载时隐藏视图但保留（避免销毁后重开丢失会话）
  await preview.hide()
})
</script>

<template>
  <div class="preview-panel">
    <!-- 工具栏：导航三键 + 地址栏 + DevTools + 探活 + 关闭 -->
    <div class="preview-toolbar">
      <button
        class="pv-btn"
        title="后退"
        :disabled="!preview.canGoBack"
        @click="preview.control('back')"
      >←</button>
      <button
        class="pv-btn"
        title="前进"
        :disabled="!preview.canGoForward"
        @click="preview.control('forward')"
      >→</button>
      <button
        class="pv-btn"
        :title="preview.loading ? '停止加载' : '刷新'"
        @click="preview.control(preview.loading ? 'stop' : 'reload')"
      >{{ preview.loading ? '⊘' : '⟳' }}</button>
      <input
        v-model="urlInput"
        class="pv-url"
        type="text"
        placeholder="http://localhost:5173"
        spellcheck="false"
        @keydown.enter="submit"
      />
      <button class="pv-btn pv-primary" title="打开" @click="submit">打开</button>
      <button class="pv-btn" title="探测 dev server（5173/3000/8080...）" @click="probeAndOpen">探活</button>
      <button class="pv-btn" title="DevTools" @click="preview.control('openDevTools')">⚙</button>
      <button class="pv-btn" title="元素选择模式：悬停高亮 + 点击采集" @click="enterPickMode">🔍</button>
      <button class="pv-btn" title="关闭预览" @click="closePreview">×</button>
    </div>

    <!-- 错误提示 -->
    <div v-if="showError" class="pv-error">⚠ {{ preview.error }}</div>

    <!-- 预览容器：WebContentsView 经 bounds 精确覆盖在此元素上 -->
    <div ref="hostRef" class="preview-host">
      <div v-if="!preview.url" class="preview-empty">
        <div class="empty-title">内置浏览器预览</div>
        <div class="empty-hint">输入 localhost URL 或点击「探活」自动检测 dev server</div>
        <div class="empty-hint muted">支持 vite/webpack/next dev server（5173/3000/8080 等端口）</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.preview-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-primary);
}

.preview-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-secondary);
}

.pv-btn {
  padding: 4px 10px;
  font-size: 12px;
  border: 1px solid var(--border);
  background: var(--bg-tertiary);
  color: var(--text-primary);
  border-radius: 4px;
  cursor: pointer;
  transition: background 0.15s;
}

.pv-btn:hover:not(:disabled) {
  background: var(--bg-hover);
}

.pv-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.pv-btn.pv-primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

.pv-url {
  flex: 1;
  padding: 4px 10px;
  font-size: 12px;
  font-family: var(--font-mono);
  background: var(--bg-tertiary);
  color: var(--text-primary);
  border: 1px solid var(--border);
  border-radius: 4px;
  outline: none;
}

.pv-url:focus {
  border-color: var(--accent);
}

.pv-error {
  padding: 6px 12px;
  font-size: 12px;
  color: var(--warning);
  background: rgba(255, 180, 0, 0.1);
  border-bottom: 1px solid var(--border);
}

.preview-host {
  flex: 1;
  position: relative;
  background: var(--bg-primary);
  overflow: hidden;
}

.preview-empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--text-secondary);
}

.empty-title {
  font-size: 16px;
  font-weight: 500;
  color: var(--text-primary);
}

.empty-hint {
  font-size: 13px;
}

.empty-hint.muted {
  opacity: 0.6;
  font-size: 12px;
}
</style>
