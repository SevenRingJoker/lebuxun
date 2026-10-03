// 主题状态：白（light）/ 黑（dark）/ 蓝（blue，赛博蓝暗色）
// 通过在 <html> 上切换 data-theme 属性，驱动 cyber.scss 中的三套 CSS 变量
import { defineStore } from 'pinia'
import { ref, watch } from 'vue'

export type ThemeName = 'light' | 'dark' | 'blue'

const STORAGE_KEY = 'scholar-theme'

// 从 localStorage 读取上次选择，非法值回退到蓝色主题
function readStored(): ThemeName {
  const v = localStorage.getItem(STORAGE_KEY)
  return v === 'light' || v === 'dark' || v === 'blue' ? v : 'blue'
}

export const useThemeStore = defineStore('theme', () => {
  const theme = ref<ThemeName>(readStored())

  // 将主题名应用到根节点
  function apply(t: ThemeName): void {
    document.documentElement.setAttribute('data-theme', t)
    // 同步给主进程：驱动原生窗口标题栏/边框/底色跟随主题
    window.api?.theme?.apply(t)
  }

  // 切换主题
  function setTheme(t: ThemeName): void {
    theme.value = t
  }

  // 立即应用一次，并在变化时持久化 + 重新应用
  watch(
    theme,
    (t) => {
      localStorage.setItem(STORAGE_KEY, t)
      apply(t)
    },
    { immediate: true }
  )

  return { theme, setTheme }
})
