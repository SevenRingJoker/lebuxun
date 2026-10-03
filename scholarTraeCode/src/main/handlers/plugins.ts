// 插件管理 IPC：列出已加载插件、启用/禁用、获取 MCP/命令贡献。
import { ipcMain } from 'electron'
import { getLoadedPlugins, setPluginEnabled, getPluginMcpServers, getPluginCommands, loadPlugins } from '../ai/pluginLoader'
import { getLogger } from '../ai/logger'

export function registerPluginHandlers(): void {
  const log = getLogger('plugins-handler')

  // 列出全部已加载插件
  ipcMain.handle('plugin:list', () => {
    return getLoadedPlugins().map((p) => ({
      id: p.manifest.id,
      name: p.manifest.name,
      version: p.manifest.version,
      description: p.manifest.description,
      author: p.manifest.author,
      enabled: p.enabled,
      providerCount: p.manifest.providers.length,
      mcpServerCount: Object.keys(p.manifest.mcpServers).length,
      commandCount: p.manifest.commands.length,
      dir: p.dir
    }))
  })

  // 启用/禁用插件
  ipcMain.handle('plugin:setEnabled', async (_e, pluginId: string, enabled: boolean) => {
    try {
      await setPluginEnabled(pluginId, enabled)
      return { ok: true }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log.error(`设置插件 ${pluginId} 启用状态失败：${msg}`)
      return { ok: false, error: msg }
    }
  })

  // 获取插件贡献的 MCP server 配置（供 mcp.ts 合并）
  ipcMain.handle('plugin:getMcpServers', () => getPluginMcpServers())

  // 获取插件贡献的命令（供渲染端注册）
  ipcMain.handle('plugin:getCommands', () => getPluginCommands())

  // 手动重新扫描加载（用户在设置页点"刷新"按钮）
  ipcMain.handle('plugin:reload', async () => {
    try {
      await loadPlugins()
      return { ok: true }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { ok: false, error: msg }
    }
  })
}
