// Ollama 运行时健康检测 IPC：
// 负责检测/拉起本地 Ollama 服务（electron-ollama），供工作区状态灯使用。
// 聊天能力已迁移到统一调度层（ai/scheduler.ts + providers/ollamaProvider.ts）。
import { ipcMain } from 'electron'
import { ElectronOllama } from 'electron-ollama'

// 单例 Ollama 实例
let electronOllama: ElectronOllama | null = null

// 初始化 Ollama：检测本地是否已运行；若未运行则启动/下载并拉起服务
async function ensureOllama(): Promise<{ ready: boolean; version?: string }> {
  if (!electronOllama) {
    electronOllama = new ElectronOllama({
      // 将 Ollama 二进制缓存到应用 userData，避免全局安装
      basePath: require('electron').app.getPath('userData')
    })
  }
  // 已经在跑就直接返回
  if (await electronOllama.isRunning()) {
    return { ready: true }
  }
  // 解析 latest 具体版本号（serve 只接受 vX.Y.Z 形式）
  const meta = await electronOllama.getMetadata('latest')
  // 未运行时尝试启动该版本；serve 内部会自动下载缺失的二进制
  await electronOllama.serve(meta.version, {
    serverLog: (msg) => console.log('[ollama server]', msg),
    downloadLog: (percent, msg) => console.log(`[ollama download] ${percent}% ${msg}`)
  })
  return { ready: true, version: meta.version }
}

// 注册 Ollama 相关 IPC
export function registerOllamaHandlers(): void {
  // 检查 Ollama 是否可用（工作区状态灯、供应商健康探测共用）
  ipcMain.handle('ollama:health', async () => {
    try {
      const res = await ensureOllama()
      return { ok: true, version: res.version }
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) }
    }
  })
}
