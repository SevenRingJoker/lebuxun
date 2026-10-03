// 3.1 内置浏览器预览主进程层：
// WebContentsView 生命周期 + localhost 探活 + IPC 注册。
// 视图挂到主窗口 contentView，bounds 由渲染端容器观察器上报。
import { ipcMain, BrowserWindow, WebContentsView, type Rectangle } from 'electron'
import {
  normalizePreviewUrl,
  sanitizeBounds,
  isLocalhostUrl,
  type PreviewBounds
} from './previewCore'
import { buildPickerScript, parsePickedMessage } from './elementPicker'

/** 当前预览视图（单例；同窗口同时只有一个预览） */
let view: WebContentsView | null = null
/** 视图所属主窗口（bounds 上报、导航事件推送都依赖） */
let owner: BrowserWindow | null = null
/** 当前 URL（重复 open 同 URL 时可直接复用） */
let currentUrl: string | null = null

function send(channel: string, ...args: unknown[]): void {
  if (owner && !owner.isDestroyed()) owner.webContents.send(channel, ...args)
}

/** 销毁预览视图（从窗口移除 + 销毁 webContents） */
export function destroyPreview(): void {
  if (!view) return
  try {
    if (owner && !owner.isDestroyed()) owner.contentView.removeChildView(view)
  } catch {
    /* 已销毁时 removeChildView 会抛错 */
  }
  try {
    ;(view.webContents as unknown as { destroy(): void }).destroy()
  } catch {
    /* 已销毁 */
  }
  view = null
  owner = null
  currentUrl = null
}

/** 创建/复用预览视图并加载 URL；bounds 由渲染端容器位置给出 */
export function openPreview(
  win: BrowserWindow,
  url: string,
  bounds: PreviewBounds
): { ok: boolean; error?: string } {
  const normalized = normalizePreviewUrl(url)
  if (!normalized) return { ok: false, error: '仅支持 localhost 预览（http://localhost 或 http://127.0.0.1）' }
  const safe = sanitizeBounds(bounds)
  if (!safe) return { ok: false, error: 'bounds 不合法' }

  owner = win
  currentUrl = normalized
  if (!view || view.webContents.isDestroyed()) {
    view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false
        // 不注入 preload：预览页是用户项目，无需访问 window.api
      }
    })
    win.contentView.addChildView(view)
    // 导航事件推给渲染端（更新地址栏/前进后退按钮可用性）
    view.webContents.on('did-navigate', (_e, u) => send('preview:navigated', u))
    view.webContents.on('did-navigate-in-page', (_e, u) => send('preview:navigated', u))
    view.webContents.on('did-start-loading', () => send('preview:loading', true))
    view.webContents.on('did-stop-loading', () => send('preview:loading', false))
    // 预览页里点外链交给系统浏览器（仅允许 localhost 内部跳转）
    view.webContents.setWindowOpenHandler((details) => {
      if (!isLocalhostUrl(details.url)) {
        return { action: 'deny' }
      }
      return { action: 'allow' }
    })
    // 3.2 元素选择：console 消息中解析 __SCHOLAR_PICKED__ 数据并回推渲染端
    view.webContents.on('console-message', (_e, _level, message) => {
      const picked = parsePickedMessage(message)
      if (picked) {
        send('preview:picked', picked)
      }
    })
  }
  view.setBounds(safe as Rectangle)
  view.setVisible(true)
  view.webContents.loadURL(normalized).catch((err) => {
    send('preview:loadError', String(err?.message ?? err))
  })
  return { ok: true }
}

/** 仅更新 bounds（窗口缩放/分栏拖拽/布局变化时调用） */
export function setPreviewBounds(bounds: PreviewBounds): { ok: boolean } {
  if (!view || view.webContents.isDestroyed()) return { ok: false }
  const safe = sanitizeBounds(bounds)
  if (!safe) {
    // 宽高过小 → 隐藏视图但保留 webContents（容器恢复后再显示）
    view.setVisible(false)
    return { ok: true }
  }
  view.setBounds(safe as Rectangle)
  view.setVisible(true)
  return { ok: true }
}

/** 隐藏预览（切走 Tab/折叠面板时调用；不销毁 webContents） */
export function hidePreview(): void {
  if (view && !view.webContents.isDestroyed()) view.setVisible(false)
}

// ---------- 3.2 元素选择模式 ----------

/** 进入选择模式：注入脚本到预览页（悬停高亮 + 点击采集 + Escape 退出） */
export async function enterPickMode(): Promise<{ ok: boolean; error?: string }> {
  if (!view || view.webContents.isDestroyed()) return { ok: false, error: '预览未打开' }
  try {
    await view.webContents.executeJavaScript(buildPickerScript())
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

/** 退出选择模式（触发 Escape 清理） */
export async function exitPickMode(): Promise<{ ok: boolean }> {
  if (!view || view.webContents.isDestroyed()) return { ok: false }
  await view.webContents.executeJavaScript(
    `document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'}))`
  )
  return { ok: true }
}

/** 采集元素截图（bounds 相对视口，经 capturePage）。
 *  注意：元素尺寸可小于整视图下限（如 16×16 图标），此处只做正数有限校验，
 *  不复用 sanitizeBounds 的整视图最小宽高约束。 */
export async function captureElement(bounds: PreviewBounds): Promise<{ ok: boolean; dataUrl?: string; error?: string }> {
  if (!view || view.webContents.isDestroyed()) return { ok: false, error: '预览未打开' }
  const safe = {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height)
  }
  if (![safe.x, safe.y, safe.width, safe.height].every(Number.isFinite) || safe.width <= 0 || safe.height <= 0) {
    return { ok: false, error: 'bounds 不合法' }
  }
  try {
    const img = await view.webContents.capturePage(safe as Rectangle)
    return { ok: true, dataUrl: img.toDataURL() }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

/** 导航控制：reload/back/forward/openDevTools/close */
export function previewControl(
  action: 'reload' | 'back' | 'forward' | 'openDevTools' | 'close' | 'stop'
): { ok: boolean; error?: string } {
  if (!view || view.webContents.isDestroyed()) return { ok: false, error: '预览未打开' }
  const wc = view.webContents
  switch (action) {
    case 'reload':
      wc.reload()
      break
    case 'stop':
      wc.stop()
      break
    case 'back':
      if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
      break
    case 'forward':
      if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
      break
    case 'openDevTools':
      wc.openDevTools({ mode: 'detach' })
      break
    case 'close':
      destroyPreview()
      break
  }
  return { ok: true }
}

/** 探活：主进程对 localhost 候选端口做 HTTP HEAD/GET，命中即返回 URL（避免渲染端 fetch 受 CORS 影响） */
async function probeUrl(url: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    const res = await fetch(url, { signal: ctrl.signal, method: 'GET' }).finally(() => clearTimeout(t))
    // 2xx/3xx/404 都视为存活（dev server 可能对 / 返回 404，但端口确实在监听）
    return res.status < 600
  } catch {
    return false
  }
}

export async function probeDevServer(
  ports: readonly number[]
): Promise<{ ok: boolean; url?: string }> {
  const hosts = ['127.0.0.1', 'localhost'] as const
  for (const host of hosts) {
    for (const port of ports) {
      const url = `http://${host}:${port}/`
      if (await probeUrl(url)) return { ok: true, url }
    }
  }
  return { ok: true }
}

/** 注册预览相关 IPC（与渲染端 window.api.preview.* 对应） */
export function registerPreviewHandlers(): void {
  ipcMain.handle(
    'preview:open',
    (e, url: string, bounds: PreviewBounds) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      if (!win) return { ok: false, error: '窗口不存在' }
      return openPreview(win, url, bounds)
    }
  )
  ipcMain.handle('preview:setBounds', (_e, bounds: PreviewBounds) => setPreviewBounds(bounds))
  ipcMain.handle('preview:hide', () => {
    hidePreview()
    return { ok: true }
  })
  ipcMain.handle('preview:control', (_e, action: Parameters<typeof previewControl>[0]) =>
    previewControl(action)
  )
  ipcMain.handle('preview:probeDevServer', (_e, ports?: number[]) =>
    probeDevServer(ports ?? [])
  )
  ipcMain.handle('preview:isOpen', () => ({
    ok: true,
    open: !!view && !view.webContents.isDestroyed(),
    url: currentUrl
  }))
  // 窗口关闭时销毁预览（避免 webContents 泄漏）
  ipcMain.handle('preview:close', () => {
    destroyPreview()
    return { ok: true }
  })

  // 3.2 元素选择模式
  ipcMain.handle('preview:enterPickMode', () => enterPickMode())
  ipcMain.handle('preview:exitPickMode', () => exitPickMode())
  ipcMain.handle('preview:captureElement', (_e, bounds: PreviewBounds) => captureElement(bounds))
}
