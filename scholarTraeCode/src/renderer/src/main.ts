// 渲染进程入口：Vue3 + Pinia + vue-i18n + 全局样式
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import i18n from './i18n'
import App from './App.vue'
import './assets/cyber.scss'

const app = createApp(App)
app.use(createPinia())
app.use(i18n)
app.mount('#app')
