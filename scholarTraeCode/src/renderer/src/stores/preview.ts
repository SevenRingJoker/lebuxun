// 3.1 内置浏览器预览状态管理：
// 预览开关 / URL / loading / 导航能力（前进后退）/ bounds 上报节流
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export const usePreviewStore = defineStore('preview', () => {
  /** 预览是否激活（中栏显示预览面板） */
  const active = ref(false)
  /** 当前 URL（地址栏显示；null 表示尚未加载） */
  const url = ref<string | null>(null)
  /** 加载中（地址栏 spinner） */
  const loading = ref(false)
  /** 加载失败提示 */
  const error = ref('')
  /** 可否后退/前进（由主进程导航事件驱动） */
  const canGoBack = ref(false)
  const canGoForward = ref(false)
  /** 预览视图最近一次的容器 bounds（切走时 hide 用） */
  const lastBounds = ref<{ x: number; y: number; width: number; height: number } | null>(null)

  const isOpen = computed(() => active.value && url.value !== null)

  /** 打开预览（bounds 由 EditorPanel 容器观察器测量后传入） */
  async function open(
    targetUrl: string,
    bounds: { x: number; y: number; width: number; height: number }
  ): Promise<{ ok: boolean; error?: string }> {
    const r = await window.api.preview.open(targetUrl, bounds)
    if (r.ok) {
      active.value = true
      url.value = targetUrl
      error.value = ''
      lastBounds.value = bounds
    } else {
      error.value = r.error ?? '打开失败'
    }
    return r
  }

  /** 容器 bounds 变化时上报（ResizeObserver 回调） */
  async function reportBounds(bounds: { x: number; y: number; width: number; height: number }): Promise<void> {
    lastBounds.value = bounds
    if (isOpen.value) {
      await window.api.preview.setBounds(bounds)
    }
  }

  /** 切走预览 Tab / 折叠面板时隐藏视图（不销毁，切回时再 setBounds 恢复） */
  async function hide(): Promise<void> {
    if (isOpen.value) await window.api.preview.hide()
  }

  /** 关闭预览（销毁视图） */
  async function close(): Promise<void> {
    await window.api.preview.close()
    active.value = false
    url.value = null
    error.value = ''
    canGoBack.value = false
    canGoForward.value = false
    lastBounds.value = null
  }

  /** 导航控制 */
  async function control(action: 'reload' | 'back' | 'forward' | 'openDevTools' | 'stop'): Promise<void> {
    await window.api.preview.control(action)
  }

  /** 事件订阅（主进程推送） */
  function bindEvents(): void {
    window.api.preview.onNavigated((u) => {
      url.value = u
      error.value = ''
    })
    window.api.preview.onLoading((l) => {
      loading.value = l
    })
    window.api.preview.onLoadError((err) => {
      error.value = err
      loading.value = false
    })
  }

  /** dev server 探活：命中返回首个可用 URL */
  async function probeDevServer(ports?: number[]): Promise<string | null> {
    const r = await window.api.preview.probeDevServer(ports)
    return r.ok && r.url ? r.url : null
  }

  return {
    active,
    url,
    loading,
    error,
    canGoBack,
    canGoForward,
    lastBounds,
    isOpen,
    open,
    reportBounds,
    hide,
    close,
    control,
    bindEvents,
    probeDevServer
  }
})
