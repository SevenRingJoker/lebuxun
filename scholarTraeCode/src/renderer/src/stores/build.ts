// s47 一键打包的渲染端状态：日志环形缓冲 + 结果卡片。
// 主进程事件源：build:log（逐行）、build:done（产物清单与版本号）。
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { UiBuildDone } from '../api'

const MAX_LOG_LINES = 500

export const useBuildStore = defineStore('build', () => {
  /** 卡片可见性（打包按钮唤起；进行中强制可见） */
  const visible = ref(false)
  const running = ref(false)
  /** 日志行（环形，保留尾部） */
  const logs = ref<string[]>([])
  const done = ref<UiBuildDone | null>(null)
  /** 当前模式：dir=快速验证 / dist=完整产物 */
  const mode = ref<'dir' | 'dist'>('dir')

  async function start(m: 'dir' | 'dist'): Promise<void> {
    if (running.value) return
    mode.value = m
    visible.value = true
    running.value = true
    done.value = null
    logs.value = []
    const r = await window.api.build.start(m)
    if (!r.ok) {
      running.value = false
      logs.value.push(`[错误] ${r.error || '启动失败'}`)
    }
  }

  function onLog(p: { text: string }): void {
    logs.value.push(p.text)
    if (logs.value.length > MAX_LOG_LINES) logs.value.splice(0, logs.value.length - MAX_LOG_LINES)
  }

  function onDone(r: UiBuildDone): void {
    running.value = false
    done.value = r
    visible.value = true
  }

  function openRelease(): void {
    void window.api.build.openRelease()
  }

  return { visible, running, logs, done, mode, start, onLog, onDone, openRelease }
})
