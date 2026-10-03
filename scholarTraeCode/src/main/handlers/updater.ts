// 自动更新处理器：封装 electron-updater，提供检查/下载/安装 IPC 通道
// 采用通用 generic provider（package.json publish.url），支持手动触发更新
import { app, ipcMain } from 'electron'
import { autoUpdater } from 'electron-updater'

// 生产环境才启用自动更新；开发态 autoUpdater 无意义且会报错
const isDev = !app.isPackaged

// 更新状态推送给渲染进程的事件名
const EVT = {
  checking: 'updater:checking',
  available: 'updater:available',
  notAvailable: 'updater:not-available',
  downloading: 'updater:downloading',
  downloaded: 'updater:downloaded',
  error: 'updater:error'
}

/**
 * 注册自动更新相关 IPC 通道
 * - updater:check       手动检查更新
 * - updater:download    下载已发现的更新包
 * - updater:install     安装并重启（下载完成后调用）
 * - updater:getStatus   获取当前版本号
 */
export function registerUpdaterHandlers(): void {
  // 生产环境才配置 autoUpdater，开发态直接返回版本号不做真实检查
  if (isDev) {
    ipcMain.handle('updater:getStatus', () => ({
      version: app.getVersion(),
      isPackaged: false
    }))
    ipcMain.handle('updater:check', async () => ({ ok: false, message: '开发环境不检查更新' }))
    ipcMain.handle('updater:download', async () => ({ ok: false, message: '开发环境不下载更新' }))
    ipcMain.handle('updater:install', async () => ({ ok: false, message: '开发环境不能安装更新' }))
    return
  }

  // 不自动下载，等用户确认后再下载（避免静默消耗带宽）
  autoUpdater.autoDownload = false
  // 下载完成后不自动退出安装，由用户点击触发
  autoUpdater.autoInstallOnAppQuit = false

  // 事件转发到渲染进程
  autoUpdater.on('checking-for-update', () => broadcast(EVT.checking, {}))
  autoUpdater.on('update-available', (info) => broadcast(EVT.available, { version: info.version, releaseNotes: info.releaseNotes }))
  autoUpdater.on('update-not-available', (info) => broadcast(EVT.notAvailable, { version: info.version }))
  autoUpdater.on('download-progress', (progress) =>
    broadcast(EVT.downloading, {
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      total: progress.total,
      transferred: progress.transferred
    })
  )
  autoUpdater.on('update-downloaded', (info) => broadcast(EVT.downloaded, { version: info.version }))
  autoUpdater.on('error', (err) => broadcast(EVT.error, { message: err?.message ?? String(err) }))

  ipcMain.handle('updater:getStatus', () => ({
    version: app.getVersion(),
    isPackaged: true
  }))

  ipcMain.handle('updater:check', async () => {
    try {
      await autoUpdater.checkForUpdates()
      return { ok: true }
    } catch (e) {
      return { ok: false, message: (e as Error)?.message ?? String(e) }
    }
  })

  ipcMain.handle('updater:download', async () => {
    try {
      await autoUpdater.downloadUpdate()
      return { ok: true }
    } catch (e) {
      return { ok: false, message: (e as Error)?.message ?? String(e) }
    }
  })

  ipcMain.handle('updater:install', async () => {
    // 退出并安装更新，isSilent=false 会弹安装向导
    autoUpdater.quitAndInstall(false, true)
    return { ok: true }
  })
}

// 向所有窗口广播更新事件
function broadcast(event: string, payload: unknown): void {
  for (const win of require('electron').BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(event, payload)
    }
  }
}
