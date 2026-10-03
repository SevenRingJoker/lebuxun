// vue-i18n 配置：中/英双语，默认 zh-CN，语言切换持久化到 localStorage
import { createI18n } from 'vue-i18n'
import zhCN from './locales/zh-CN'
import en from './locales/en'

export type AppLocale = 'zh-CN' | 'en'

/** 从 localStorage 读取上次选择的语言，缺省中文 */
function getDefaultLocale(): AppLocale {
  const saved = localStorage.getItem('app-locale')
  if (saved === 'en' || saved === 'zh-CN') return saved
  return 'zh-CN'
}

const i18n = createI18n({
  legacy: false, // 使用 Composition API 模式
  locale: getDefaultLocale(),
  fallbackLocale: 'zh-CN',
  messages: {
    'zh-CN': zhCN,
    en
  }
})

export default i18n

/** 切换语言并持久化 */
export function setLocale(locale: AppLocale): void {
  i18n.global.locale.value = locale
  localStorage.setItem('app-locale', locale)
}

/** 获取当前语言 */
export function getLocale(): AppLocale {
  return i18n.global.locale.value as AppLocale
}
