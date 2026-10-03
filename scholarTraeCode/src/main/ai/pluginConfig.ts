// 插件清单纯函数层：schema 校验、磁盘扫描、启用状态读写。
// 零 electron 依赖（pluginsRoot 由调用方注入 userData），可直接在 vitest 下测试。
// 插件目录布局：
//   <pluginsRoot>/<plugin-id>/
//     plugin.json   ← 清单（必须）
//     server.js     ← MCP server 入口（可选，mcpServers 条目的 command 可指向此文件）
//
// plugin.json schema:
// {
//   "id": "my-plugin",
//   "name": "我的插件",
//   "version": "1.0.0",
//   "description": "一句话描述",
//   "author": "作者名",
//   "enabled": true,
//   "providers": [{ "id": "my-llm", "name": "My LLM", "baseUrl": "http://...", "apiKey": "..." }],
//   "mcpServers": { "my-server": { "command": "node", "args": ["server.js"] } },
//   "commands": [{ "id": "my.cmd", "title": "My Command", "keybinding": "ctrl+shift+m" }]
// }
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** 插件 ID 白名单：小写字母数字下划线连字符，2-60 字符 */
export const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9_-]{0,59}$/

/** 插件版本号格式：semver 简化版 */
export const VERSION_RE = /^\d+\.\d+\.\d+(-[a-z0-9.]+)?$/

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string }

/** 插件贡献的 Provider 配置（与 providerRegistry addCustomProvider 对齐） */
export interface PluginProvider {
  id: string
  name: string
  baseUrl: string
  apiKey?: string
  /** 供应商类型：openai-compatible / ollama，缺省 openai-compatible */
  type?: string
}

/** 插件贡献的命令定义（与 renderer commands/registry 对齐） */
export interface PluginCommand {
  id: string
  title: string
  /** 快捷键，如 "ctrl+shift+m"，可选 */
  keybinding?: string
  /** 命令图标（Material Icon 名称），可选 */
  icon?: string
}

/** 插件清单（plugin.json 解析结果） */
export interface PluginManifest {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  enabled: boolean
  providers: PluginProvider[]
  /** 复用 McpServerConfig 结构，但不直接 import（避免循环依赖） */
  mcpServers: Record<string, {
    package?: string
    command?: string
    args?: string[]
    env?: Record<string, string>
    description?: string
  }>
  commands: PluginCommand[]
}

/** 校验插件 ID */
export function validatePluginId(id: string): ValidationResult<string> {
  const trimmed = (id ?? '').trim()
  if (!trimmed) return { ok: false, error: '插件 ID 不能为空' }
  if (!PLUGIN_ID_RE.test(trimmed)) {
    return { ok: false, error: '插件 ID 仅允许小写字母、数字、下划线、连字符，2-60 字符，且以字母或数字开头' }
  }
  return { ok: true, value: trimmed }
}

/** 校验版本号 */
export function validateVersion(version: string): ValidationResult<string> {
  const trimmed = (version ?? '').trim()
  if (!trimmed) return { ok: false, error: '版本号不能为空' }
  if (!VERSION_RE.test(trimmed)) {
    return { ok: false, error: '版本号需符合 semver 格式（如 1.0.0）' }
  }
  return { ok: true, value: trimmed }
}

/** 校验单个 Provider 配置 */
function validateProvider(input: unknown): ValidationResult<PluginProvider> {
  if (!input || typeof input !== 'object') return { ok: false, error: 'provider 配置无效' }
  const obj = input as Record<string, unknown>
  const id = typeof obj.id === 'string' ? obj.id.trim() : ''
  const name = typeof obj.name === 'string' ? obj.name.trim() : ''
  const baseUrl = typeof obj.baseUrl === 'string' ? obj.baseUrl.trim() : ''
  if (!id) return { ok: false, error: 'provider.id 不能为空' }
  if (!name) return { ok: false, error: 'provider.name 不能为空' }
  if (!baseUrl) return { ok: false, error: `provider "${id}" 的 baseUrl 不能为空` }
  return {
    ok: true,
    value: {
      id,
      name,
      baseUrl,
      apiKey: typeof obj.apiKey === 'string' ? obj.apiKey : undefined,
      type: typeof obj.type === 'string' ? obj.type : undefined
    }
  }
}

/** 校验单个命令配置 */
function validateCommand(input: unknown): ValidationResult<PluginCommand> {
  if (!input || typeof input !== 'object') return { ok: false, error: 'command 配置无效' }
  const obj = input as Record<string, unknown>
  const id = typeof obj.id === 'string' ? obj.id.trim() : ''
  const title = typeof obj.title === 'string' ? obj.title.trim() : ''
  if (!id) return { ok: false, error: 'command.id 不能为空' }
  if (!title) return { ok: false, error: `command "${id}" 的 title 不能为空` }
  return {
    ok: true,
    value: {
      id,
      title,
      keybinding: typeof obj.keybinding === 'string' ? obj.keybinding.toLowerCase().trim() : undefined,
      icon: typeof obj.icon === 'string' ? obj.icon : undefined
    }
  }
}

/** 校验并解析完整清单 JSON */
export function validateManifest(raw: unknown): ValidationResult<PluginManifest> {
  if (!raw || typeof raw !== 'object') return { ok: false, error: '清单格式无效：期望 JSON 对象' }
  const obj = raw as Record<string, unknown>

  const idResult = validatePluginId(String(obj.id ?? ''))
  if (!idResult.ok) return { ok: false, error: `插件 ID 校验失败：${idResult.error}` }

  const name = typeof obj.name === 'string' ? obj.name.trim() : ''
  if (!name) return { ok: false, error: '插件名称不能为空' }

  const versionResult = validateVersion(String(obj.version ?? ''))
  if (!versionResult.ok) return { ok: false, error: `版本号校验失败：${versionResult.error}` }

  // providers 数组校验
  const providers: PluginProvider[] = []
  const rawProviders = Array.isArray(obj.providers) ? obj.providers : []
  for (const p of rawProviders) {
    const pr = validateProvider(p)
    if (!pr.ok) return { ok: false, error: pr.error }
    providers.push(pr.value)
  }

  // mcpServers 对象校验
  const mcpServers: PluginManifest['mcpServers'] = {}
  if (obj.mcpServers && typeof obj.mcpServers === 'object') {
    for (const [serverName, serverCfg] of Object.entries(obj.mcpServers)) {
      if (!serverCfg || typeof serverCfg !== 'object') {
        return { ok: false, error: `mcpServers."${serverName}" 配置无效` }
      }
      const sc = serverCfg as Record<string, unknown>
      mcpServers[serverName] = {
        package: typeof sc.package === 'string' ? sc.package.trim() : undefined,
        command: typeof sc.command === 'string' ? sc.command.trim() : undefined,
        args: Array.isArray(sc.args) ? sc.args.filter((a) => typeof a === 'string') : undefined,
        env: sc.env && typeof sc.env === 'object' ? sc.env as Record<string, string> : undefined,
        description: typeof sc.description === 'string' ? sc.description : undefined
      }
    }
  }

  // commands 数组校验
  const commands: PluginCommand[] = []
  const rawCommands = Array.isArray(obj.commands) ? obj.commands : []
  for (const c of rawCommands) {
    const cr = validateCommand(c)
    if (!cr.ok) return { ok: false, error: cr.error }
    commands.push(cr.value)
  }

  return {
    ok: true,
    value: {
      id: idResult.value,
      name,
      version: versionResult.value,
      description: typeof obj.description === 'string' ? obj.description.trim() : undefined,
      author: typeof obj.author === 'string' ? obj.author.trim() : undefined,
      enabled: obj.enabled !== false, // 缺省 true
      providers,
      mcpServers,
      commands
    }
  }
}

/** 从磁盘读取并校验单个插件清单 */
export function loadPluginManifest(pluginDir: string): ValidationResult<PluginManifest> {
  const manifestPath = join(pluginDir, 'plugin.json')
  if (!existsSync(manifestPath)) {
    return { ok: false, error: `清单文件不存在：${manifestPath}` }
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf-8'))
  } catch {
    return { ok: false, error: `清单 JSON 解析失败：${manifestPath}` }
  }
  const result = validateManifest(raw)
  if (!result.ok) return result
  // 注入插件目录路径信息（供 loader 组装 MCP command 为绝对路径）
  return result
}

/** 扫描插件根目录，返回所有已发现插件清单（含失败的） */
export function scanPlugins(pluginsRoot: string): Array<
  | { ok: true; manifest: PluginManifest; dir: string }
  | { ok: false; dir: string; error: string }
> {
  if (!existsSync(pluginsRoot)) return []
  const results: Array<
    | { ok: true; manifest: PluginManifest; dir: string }
    | { ok: false; dir: string; error: string }
  > = []
  for (const name of readdirSync(pluginsRoot)) {
    const dir = join(pluginsRoot, name)
    if (!statSync(dir).isDirectory()) continue
    // 插件目录名必须与清单 ID 一致
    const result = loadPluginManifest(dir)
    if (result.ok) {
      if (result.value.id !== name) {
        results.push({ ok: false, dir, error: `目录名 "${name}" 与清单 ID "${result.value.id}" 不一致` })
      } else {
        results.push({ ok: true, manifest: result.value, dir })
      }
    } else {
      results.push({ ok: false, dir, error: result.error })
    }
  }
  return results
}

/** 启用状态文件路径：pluginsRoot/.enabled.json */
function enabledFilePath(pluginsRoot: string): string {
  return join(pluginsRoot, '.enabled.json')
}

/** 读取启用覆盖状态（用户可手动禁用某插件，覆盖清单中的 enabled） */
export function readEnabledOverrides(pluginsRoot: string): Record<string, boolean> {
  const path = enabledFilePath(pluginsRoot)
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return {}
  }
}

/** 写入启用覆盖状态 */
export function writeEnabledOverrides(pluginsRoot: string, overrides: Record<string, boolean>): void {
  if (!existsSync(pluginsRoot)) mkdirSync(pluginsRoot, { recursive: true })
  writeFileSync(enabledFilePath(pluginsRoot), JSON.stringify(overrides, null, 2), 'utf-8')
}

/** 合并清单 enabled 与用户覆盖：用户覆盖优先 */
export function resolveEnabled(manifest: PluginManifest, overrides: Record<string, boolean>): boolean {
  if (manifest.id in overrides) return overrides[manifest.id]
  return manifest.enabled
}
