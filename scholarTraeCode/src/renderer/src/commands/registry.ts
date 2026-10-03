// 命令注册表：集中定义应用命令、默认按键与执行体
// 纯数据 + Pinia store 依赖注入；CommandPalette / SettingsPanel / App.vue 全局分发共用
import { computed, ref } from 'vue'
import { useChatStore } from '../stores/chat'
import { useThemeStore } from '../stores/theme'
import { useWorkspaceStore } from '../stores/workspace'
import { mergeKeymap, parseAccelerator, formatAccelerator, detectConflict, matchKeyEvent, type CommandDef } from '../../../shared/keymap'

/** 命令执行上下文：打开设置页并跳转到指定 Tab、开关命令面板等 UI 动作由外部注入 */
export interface CommandContext {
  openSettings: (tab?: SettingsTab) => void
  openPalette: () => void
  toggleChatPanel: () => void
}

/** 设置页 Tab key（与 SettingsPanel 内部一致） */
export type SettingsTab = 'general' | 'models' | 'mcp' | 'rulesSkills' | 'keymap'

interface CommandRuntime extends CommandDef {
  /** 执行体；返回 false 表示当前不可用（如发送中不允许新建会话） */
  run: (ctx: CommandContext) => boolean | void
}

const KEYMAP_STORAGE_KEY = 'scholar-keymap'

function readStoredKeymap(): Record<string, string> {
  try {
    const raw = localStorage.getItem(KEYMAP_STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function writeStoredKeymap(map: Record<string, string>): void {
  localStorage.setItem(KEYMAP_STORAGE_KEY, JSON.stringify(map))
}

/** 应用命令清单（静态部分） */
function buildCommandDefs(): CommandRuntime[] {
  const chat = useChatStore()
  const theme = useThemeStore()
  const ws = useWorkspaceStore()

  return [
    // 面板与导航
    {
      id: 'palette',
      title: '打开命令面板',
      group: '通用',
      defaultKey: 'Ctrl+Shift+P',
      run: (ctx) => ctx.openPalette()
    },
    {
      id: 'settings.general',
      title: '打开设置',
      group: '设置',
      defaultKey: 'Ctrl+,',
      run: (ctx) => ctx.openSettings('general')
    },
    {
      id: 'settings.models',
      title: '设置：模型管理',
      group: '设置',
      run: (ctx) => ctx.openSettings('models')
    },
    {
      id: 'settings.mcp',
      title: '设置：MCP 服务器',
      group: '设置',
      run: (ctx) => ctx.openSettings('mcp')
    },
    {
      id: 'settings.rulesSkills',
      title: '设置：规则与技能',
      group: '设置',
      run: (ctx) => ctx.openSettings('rulesSkills')
    },
    {
      id: 'settings.keymap',
      title: '设置：快捷键',
      group: '设置',
      run: (ctx) => ctx.openSettings('keymap')
    },
    // 会话
    {
      id: 'chat.newSession',
      title: '新建会话',
      group: '会话',
      run: () => {
        if (chat.sending) return false
        void chat.newSession()
      }
    },
    {
      id: 'chat.history',
      title: '会话历史',
      group: '会话',
      run: () => {
        if (chat.sending) return false
        chat.showHistory = true
      }
    },
    {
      id: 'chat.focus',
      title: '聚焦输入框',
      group: '会话',
      run: () => {
        const el = document.querySelector<HTMLTextAreaElement>('.composer-input')
        el?.focus()
      }
    },
    {
      id: 'chat.toggleTools',
      title: '切换工具调用模式',
      group: '会话',
      run: () => {
        // useTools 是 ChatPanel 本地状态，通过自定义事件桥接
        window.dispatchEvent(new CustomEvent('scholar:toggle-tools'))
      }
    },
    {
      id: 'chat.stop',
      title: '停止当前任务',
      group: '会话',
      run: () => {
        if (chat.sending) void chat.stopSending()
      }
    },
    // 外观与行为
    {
      id: 'theme.next',
      title: '切换主题（白/黑/蓝）',
      group: '外观',
      run: () => {
        const order: Array<'light' | 'dark' | 'blue'> = ['light', 'dark', 'blue']
        const idx = order.indexOf(theme.theme)
        theme.setTheme(order[(idx + 1) % order.length])
      }
    },
    {
      id: 'perm.readonly',
      title: '权限模式：只读',
      group: '权限',
      run: () => void chat.setPermissionMode('readonly')
    },
    {
      id: 'perm.ask',
      title: '权限模式：询问',
      group: '权限',
      run: () => void chat.setPermissionMode('ask')
    },
    {
      id: 'perm.auto',
      title: '权限模式：自动',
      group: '权限',
      run: () => void chat.setPermissionMode('auto')
    },
    {
      id: 'checkpoint.toggle',
      title: '切换自动检查点',
      group: '权限',
      run: () => chat.toggleAutoCheckpoint(!chat.autoCheckpoint)
    },
    // 布局
    {
      id: 'layout.toggleChat',
      title: '切换 AI 面板显隐',
      group: '布局',
      run: (ctx) => ctx.toggleChatPanel()
    },
    // 工作区
    {
      id: 'workspace.open',
      title: '切换工作区目录',
      group: '工作区',
      run: () => void ws.selectWorkspace()
    }
  ]
}

/** 命令注册表（内部创建，经 useCommandRegistry 惰性单例暴露） */
function createRegistry() {
  const commands = buildCommandDefs()
  const userKeymap = ref<Record<string, string>>(readStoredKeymap())

  const keymap = computed(() => mergeKeymap(commands, userKeymap.value))

  /** 生效按键表：命令 id → 规范化按键串（空串 = 未绑定） */
  const effectiveKeys = computed(() => {
    const map: Record<string, string> = {}
    for (const [id, raw] of Object.entries(keymap.value)) {
      if (!raw) {
        map[id] = ''
        continue
      }
      const stroke = parseAccelerator(raw)
      map[id] = stroke ? formatAccelerator(stroke) : ''
    }
    return map
  })

  /** 按键冲突清单 */
  const conflicts = computed(() => detectConflict(effectiveKeys.value))

  function rebind(id: string, key: string): void {
    if (!(id in keymap.value)) return
    userKeymap.value = { ...userKeymap.value, [id]: key }
    writeStoredKeymap(userKeymap.value)
  }

  function resetKeymap(): void {
    userKeymap.value = {}
    writeStoredKeymap(userKeymap.value)
  }

  /** 根据按键事件查找命中的命令 */
  function matchCommand(e: { ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean; key: string }): CommandRuntime | null {
    for (const cmd of commands) {
      const accel = effectiveKeys.value[cmd.id]
      if (!accel) continue
      const stroke = parseAccelerator(accel)
      if (stroke && matchKeyEvent(e, stroke)) return cmd
    }
    return null
  }

  return {
    commands,
    keymap,
    effectiveKeys,
    conflicts,
    rebind,
    resetKeymap,
    matchCommand
  }
}

// 从 shared/keymap 重新导出，供组件便捷引用
export { parseAccelerator, formatAccelerator, matchKeyEvent, fuzzyScore, searchCommands } from '../../../shared/keymap'
export type { CommandDef, KeyStroke } from '../../../shared/keymap'

// 模块级惰性单例：保证设置页改键、命令面板展示、App.vue 全局分发共享同一份 keymap 状态
// 首次调用须在 Pinia 激活后（setup 或事件回调内）
let registryInstance: ReturnType<typeof createRegistry> | null = null

/** 命令注册表单例 */
export function useCommandRegistry(): ReturnType<typeof createRegistry> {
  if (!registryInstance) registryInstance = createRegistry()
  return registryInstance
}
