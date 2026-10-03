// 主进程入口：创建主窗口，注册各 IPC 处理模块（fs / lsp / mcp / ollama / ai调度 / theme）
import { app, shell, BrowserWindow, nativeTheme, ipcMain, crashReporter } from 'electron'
import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { initGlobalLogger, getLogger } from './ai/logger'
import { registerFsHandlers } from './handlers/fs'
import { registerLspHandlers } from './handlers/lsp'
import { registerMcpHandlers } from './handlers/mcp'
import { registerTerminalHandlers } from './handlers/terminal'
import { registerPtyHandlers } from './handlers/ptyManager'
import { registerOllamaHandlers } from './handlers/ollama'
import { registerAiSchedulingHandlers } from './handlers/aiScheduling'
import { registerGitHandlers } from './handlers/git'
import { registerSearchHandlers } from './handlers/search'
import { registerRulesSkillsHandlers } from './handlers/rulesSkills'
import { registerDebugHandlers } from './handlers/debug'
import { registerValidationHandlers } from './handlers/validation'
import { registerUpdaterHandlers } from './handlers/updater'
import { registerPluginHandlers } from './handlers/plugins'
import { registerStagingHandlers } from './handlers/staging'
import { registerRepairHandlers } from './handlers/repair'
import { registerBuildHandlers } from './handlers/build'
import { registerKanbanHandlers } from './handlers/kanban'
import { registerScholarHandlers } from './handlers/scholar'
import { registerPreviewHandlers } from './preview/previewView'
import { loadPlugins } from './ai/pluginLoader'

// 主题名（与渲染进程 stores/theme.ts 保持一致）
type ThemeName = 'light' | 'dark' | 'blue'

// 各主题对应的原生窗口背景色（与 cyber.scss 中 --bg-primary 单一事实来源对齐）
const THEME_WINDOW_BG: Record<ThemeName, string> = {
  light: '#F4F7FB',
  dark: '#04060A',
  blue: '#0C1322'
}

// 各主题对应的标题栏图标（最小化/最大化/关闭）颜色
const THEME_TITLEBAR_SYMBOL: Record<ThemeName, string> = {
  light: '#1B2435',
  dark: '#E6EBF2',
  blue: '#EAF0FA'
}

// 自绘标题栏高度，与渲染进程 App.vue 顶栏高度保持一致
const TITLEBAR_HEIGHT = 44

const isWindows = process.platform === 'win32'

// 主窗口引用：主题切换时需要实时修改窗口背景色与标题栏覆盖层
let mainWindow: BrowserWindow | null = null

// 主题持久化文件（主进程独立保存一份，保证渲染进程加载前标题栏颜色就已正确）
function themeFile(): string {
  return join(app.getPath('userData'), 'theme.json')
}

// 读取上次主题（主进程启动、窗口创建前调用）
function readStoredTheme(): ThemeName {
  try {
    if (existsSync(themeFile())) {
      const t = JSON.parse(readFileSync(themeFile(), 'utf-8'))?.theme
      if (t === 'light' || t === 'dark' || t === 'blue') return t
    }
  } catch {
    // 读取失败时使用默认蓝色主题
  }
  return 'blue'
}

// 将主题应用到原生窗口层：
// 1. 持久化主题，保证下次冷启动首帧颜色正确
// 2. nativeTheme 控制系统菜单/原生对话框的明暗
// 3. setBackgroundColor 同步窗口底色
// 4. Windows 下通过 setTitleBarOverlay 实时重绘标题栏（背景+按钮图标色），不依赖系统暗色开关
function applyNativeTheme(theme: ThemeName): void {
  try {
    writeFileSync(themeFile(), JSON.stringify({ theme }), 'utf-8')
  } catch {
    // 持久化失败不影响当次切换
  }
  nativeTheme.themeSource = theme === 'light' ? 'light' : 'dark'
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.setBackgroundColor(THEME_WINDOW_BG[theme])
  if (isWindows) {
    mainWindow.setTitleBarOverlay({
      color: THEME_WINDOW_BG[theme],
      symbolColor: THEME_TITLEBAR_SYMBOL[theme],
      height: TITLEBAR_HEIGHT
    })
  }
}

// 创建主浏览器窗口
function createWindow(): void {
  const initialTheme = readStoredTheme()
  nativeTheme.themeSource = initialTheme === 'light' ? 'light' : 'dark'

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    // 窗口底色按上次主题设置，避免冷启动白闪
    backgroundColor: THEME_WINDOW_BG[initialTheme],
    autoHideMenuBar: true,
    // Windows：隐藏原生标题栏并启用覆盖层，标题栏背景由我们的页面顶栏接管，
    // 仅保留右上角原生最小化/最大化/关闭按钮（颜色随主题）
    ...(isWindows
      ? {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: {
            color: THEME_WINDOW_BG[initialTheme],
            symbolColor: THEME_TITLEBAR_SYMBOL[initialTheme],
            height: TITLEBAR_HEIGHT
          }
        }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    // show 后必须显式 focus：从终端/IDE 启动时，终端会占着前台，
    // 仅 show() 的窗口在 Windows（尤其远程桌面）下可能只显示而拿不到键盘焦点，
    // 表现为能点按钮但输入框、编辑器敲字无反应
    mainWindow?.show()
    mainWindow?.focus()
    mainWindow?.moveTop()
    // 二次兜底：首帧布局完成后再抢一次焦点
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.focus()
        mainWindow.moveTop()
      }
    }, 200)
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // 外链一律交给系统浏览器，避免在编辑器内打开
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // 开发态加载 vite dev server，生产态加载构建产物
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Electron 初始化完成后：注册全部 IPC 处理器，再创建窗口
app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.scholar.treacode')

  // 崩溃报告：本地保存 minidump 到 userData/crashes，不上传服务器
  crashReporter.start({ uploadToServer: false })

  // 分级日志：写入 userData/logs，开发态同时输出到 console
  initGlobalLogger({
    logDir: join(app.getPath('userData'), 'logs'),
    level: is.dev ? 'debug' : 'info',
    retentionDays: 7,
    console: is.dev
  })
  const log = getLogger('main')
  log.info(`应用启动 version=${app.getVersion()} platform=${process.platform}`)

  // 渲染进程上报当前主题（启动时一次 + 每次切换时）
  ipcMain.on('theme:apply', (_e, theme: ThemeName) => {
    if (theme === 'light' || theme === 'dark' || theme === 'blue') {
      applyNativeTheme(theme)
    }
  })

  // F12 调试快捷键（开发/生产均可用）
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerFsHandlers()
  registerLspHandlers()
  registerTerminalHandlers()
  // 真 PTY 终端 IPC（多会话；与旧哨兵管道并存）
  registerPtyHandlers()
  registerMcpHandlers()
  registerOllamaHandlers()
  registerAiSchedulingHandlers()
  registerGitHandlers()
  // 全局搜索/替换（ripgrep 引擎 + 可预览批量替换）
  registerSearchHandlers()
  registerRulesSkillsHandlers()
  registerDebugHandlers()
  registerValidationHandlers()
  registerUpdaterHandlers()
  // ㊝ 变更事务暂存 IPC（必须在 plugin 之前无要求，位置随既定顺序）
  registerStagingHandlers()
  // s45 修复执行/回滚 + s47 一键打包流水线
  registerRepairHandlers()
  registerBuildHandlers()
  // s49 卡片式任务看板落盘
  registerKanbanHandlers()
  // s54–s56 学术/报告链路（图表/报告/文献）
  registerScholarHandlers()
  registerPluginHandlers()
  // 3.1 内置浏览器预览（WebContentsView）
  registerPreviewHandlers()

  // 加载插件（异步，不阻塞窗口创建）
  loadPlugins().catch((e) => log.error(`插件加载失败：${e instanceof Error ? e.message : String(e)}`))

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// 全窗口关闭后退出（macOS 除外）
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
