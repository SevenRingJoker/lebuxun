// 插件加载器：扫描插件目录 → 校验清单 → 将贡献注册到现有扩展点。
// 依赖 providerRegistry（addCustomProvider）、mcp handlers（注入 MCP 配置）、
// 渲染进程命令注册（经 IPC 推送），但本身只做"发现与转发"，不含业务逻辑。
import { app } from 'electron'
import { join } from 'node:path'
import { getLogger } from './logger'
import {
  scanPlugins,
  readEnabledOverrides,
  writeEnabledOverrides,
  resolveEnabled,
  type PluginManifest
} from './pluginConfig'

const log = getLogger('pluginLoader')

/** 已加载的插件运行时状态 */
export interface LoadedPlugin {
  manifest: PluginManifest
  dir: string
  enabled: boolean
  /** 注册到 providerRegistry 的 custom-N ID 列表 */
  registeredProviderIds: string[]
}

/** 上次加载结果（供 IPC 查询） */
let loadedPlugins: LoadedPlugin[] = []

/** 获取上次加载结果 */
export function getLoadedPlugins(): LoadedPlugin[] {
  return loadedPlugins
}

/**
 * 扫描并加载全部插件。
 * 在主进程启动后调用一次；后续 enable/disable 时增量调用。
 * 重复调用安全：先清空旧状态再重新注册。
 */
export async function loadPlugins(): Promise<LoadedPlugin[]> {
  const pluginsRoot = join(app.getPath('userData'), 'plugins')
  const overrides = readEnabledOverrides(pluginsRoot)
  const scanResults = scanPlugins(pluginsRoot)
  const loaded: LoadedPlugin[] = []

  // 延迟导入，避免循环依赖
  const { addCustomProvider, removeCustomProvider } = await import('./providerRegistry')

  // 先清除上次注册的 provider（custom-* 前缀的插件 provider）
  for (const old of loadedPlugins) {
    for (const pid of old.registeredProviderIds) {
      removeCustomProvider(pid)
    }
  }

  for (const result of scanResults) {
    if (!result.ok) {
      log.warn(`插件加载失败 ${result.dir}：${result.error}`)
      continue
    }
    const { manifest, dir } = result
    const enabled = resolveEnabled(manifest, overrides)
    const registeredProviderIds: string[] = []

    if (!enabled) {
      log.info(`插件已禁用：${manifest.id}（${manifest.name}）`)
      loaded.push({ manifest, dir, enabled: false, registeredProviderIds })
      continue
    }

    // 注册 Provider 贡献
    for (const p of manifest.providers) {
      try {
        const def = addCustomProvider({ name: p.name, baseUrl: p.baseUrl })
        registeredProviderIds.push(def.id)
        log.info(`插件 ${manifest.id} 注册 provider：${def.id}（${p.name}）`)
      } catch (e) {
        log.error(`插件 ${manifest.id} 注册 provider "${p.id}" 失败：${e instanceof Error ? e.message : String(e)}`)
      }
    }

    // MCP server 贡献：通过动态写入 mcp-servers.json 让现有 mcp.ts handler 感知
    // 这里只记录清单，实际连接由 mcp.ts 在 registerMcpHandlers 时处理
    const mcpCount = Object.keys(manifest.mcpServers).length
    if (mcpCount > 0) {
      log.info(`插件 ${manifest.id} 贡献 ${mcpCount} 个 MCP server`)
    }

    // 命令贡献：推送到渲染进程（通过 IPC 事件，渲染端 commands/registry 监听注册）
    // 这里只记录，实际注册由渲染端在收到 IPC 事件后完成
    if (manifest.commands.length > 0) {
      log.info(`插件 ${manifest.id} 贡献 ${manifest.commands.length} 个命令`)
    }

    loaded.push({ manifest, dir, enabled: true, registeredProviderIds })
  }

  loadedPlugins = loaded
  log.info(`插件加载完成：${loaded.length} 个（${loaded.filter((p) => p.enabled).length} 个启用）`)
  return loaded
}

/** 设置单个插件的启用/禁用状态，重新加载 */
export async function setPluginEnabled(pluginId: string, enabled: boolean): Promise<void> {
  const pluginsRoot = join(app.getPath('userData'), 'plugins')
  const overrides = readEnabledOverrides(pluginsRoot)
  overrides[pluginId] = enabled
  writeEnabledOverrides(pluginsRoot, overrides)
  log.info(`插件 ${pluginId} 启用状态改为 ${enabled}，重新加载`)
  await loadPlugins()
}

/** 获取所有插件的 MCP server 贡献（供 mcp.ts handler 合并到配置中） */
export function getPluginMcpServers(): Record<string, {
  command?: string
  args?: string[]
  env?: Record<string, string>
  description?: string
}> {
  const result: Record<string, { command?: string; args?: string[]; env?: Record<string, string>; description?: string }> = {}
  for (const plugin of loadedPlugins) {
    if (!plugin.enabled) continue
    for (const [name, cfg] of Object.entries(plugin.manifest.mcpServers)) {
      // 命名空间：plugin-id/server-name，避免冲突
      const namespaced = `${plugin.manifest.id}/${name}`
      // args 中的相对路径补全为插件目录绝对路径
      const args = cfg.args?.map((a) =>
        a.startsWith('.') || a.startsWith('server.') ? join(plugin.dir, a) : a
      )
      result[namespaced] = {
        ...cfg,
        command: cfg.command,
        args,
        description: cfg.description ?? `插件 ${plugin.manifest.name} 贡献`
      }
    }
  }
  return result
}

/** 获取所有插件的命令贡献（供渲染端注册） */
export function getPluginCommands(): Array<{
  pluginId: string
  pluginName: string
  id: string
  title: string
  keybinding?: string
  icon?: string
}> {
  const commands: Array<{ pluginId: string; pluginName: string; id: string; title: string; keybinding?: string; icon?: string }> = []
  for (const plugin of loadedPlugins) {
    if (!plugin.enabled) continue
    for (const cmd of plugin.manifest.commands) {
      commands.push({
        pluginId: plugin.manifest.id,
        pluginName: plugin.manifest.name,
        ...cmd
      })
    }
  }
  return commands
}
