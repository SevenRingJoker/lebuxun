// MCP 客户端管理器：
// - 配置：userData/mcp-servers.json 可写持久化（首启从随包/仓库默认配置播种），原子写
// - 连接：stdio（package 本地包模式 / command 命令模式），统一状态机
//   connected / connecting / error / disabled / builtin(terminal)
// - IPC：服务器增删改/启停/重启/列表（含工具清单），供 McpSettings.vue 管理
//
// Windows 注意：Node 的 spawn 不经 shell 无法直接启动 npx.cmd，且 npx 首次会联网下载，
// 容易触发 initialize 超时。因此优先支持「本地包」模式（package 字段）：
// 从 node_modules 解析 server 入口，用 Electron 内置 Node（ELECTRON_RUN_AS_NODE=1）启动，
// 完全离线、无 npx 依赖。
import { app, ipcMain } from 'electron'
import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createTerminalClient, setTerminalWorkspace } from './terminalServer'
import { setTerminalCwd } from './terminal'
import { setPtyDefaultCwd } from './ptyManager'
import {
  validateServerName,
  validateServerConfig,
  sanitizeConfigFile,
  isEnabled,
  dedupePaths,
  type McpServerConfig,
  type McpConfigFile
} from '../ai/mcpConfig'

// 主进程构建为 CJS，用 createRequire 解析本地 node_modules 中的 MCP server
const nodeRequire = createRequire(__filename)

// MCP initialize 超时时间（毫秒）：本地包启动很快，给到 120s 兜底慢机器
const INIT_TIMEOUT_MS = 120_000

/** 服务器运行时状态（不入库） */
export type ServerStatus = 'connected' | 'connecting' | 'error' | 'disabled' | 'builtin'

interface ServerRuntime {
  status: ServerStatus
  error: string | null
  connectedAt: number | null
  /** 最近一次拉取到的工具清单（connected/builtin 后缓存） */
  tools: { name: string; description?: string }[]
}

/** 暴露给 UI 的服务器信息（配置 + 运行时聚合） */
export interface UiMcpServerInfo {
  name: string
  description: string
  mode: 'package' | 'command' | 'builtin'
  package?: string
  command?: string
  args: string[]
  env: Record<string, string>
  enabled: boolean
  status: ServerStatus
  error: string | null
  tools: { name: string; description?: string }[]
}

// 内存中保存的已连接客户端
let _clients: Map<string, Client> = new Map()
// 运行时状态表（含未连接/禁用/内置）
const _states: Map<string, ServerRuntime> = new Map()

export function getMcpClients(): Map<string, Client> {
  return _clients
}

// ---------- 配置文件：userData 可写层 + 随包默认播种 ----------

function userConfigPath(): string {
  return join(app.getPath('userData'), 'mcp-servers.json')
}

/** 随包/仓库默认配置候选路径（仅首启播种与兜底读取用） */
function bundledConfigCandidates(): string[] {
  return [
    join(process.cwd(), 'mcp-servers.json'),
    join(app.getAppPath(), 'mcp-servers.json'),
    join(process.resourcesPath ?? '', 'mcp-servers.json')
  ]
}

async function readBundledRaw(): Promise<string | null> {
  for (const p of bundledConfigCandidates()) {
    try {
      return await fs.readFile(p, 'utf-8')
    } catch {
      // 尝试下一个候选路径
    }
  }
  return null
}

/** 临时文件 + rename 原子写 */
async function atomicWrite(file: string, payload: string): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  await fs.writeFile(tmp, payload, 'utf-8')
  await fs.rename(tmp, file)
}

/**
 * 确保 userData 配置存在：不存在则把随包默认原样播种（无默认则空骨架）。
 * 播种后 userData 成为唯一真相源；想回默认删除该文件即可。
 */
async function ensureUserConfig(): Promise<void> {
  const target = userConfigPath()
  try {
    await fs.access(target)
    return
  } catch {
    // 不存在，继续播种
  }
  const raw = await readBundledRaw()
  if (raw !== null) {
    // 原样播种（保留用户可读的 JSON 格式）；解析失败则回退空骨架
    try {
      JSON.parse(raw)
      await atomicWrite(target, raw)
      console.log(`[mcp] 已播种默认配置到: ${target}`)
      return
    } catch {
      console.warn('[mcp] 默认 mcp-servers.json 解析失败，播种空配置')
    }
  }
  await atomicWrite(target, JSON.stringify({ mcpServers: {} }, null, 2))
}

/** 读取用户配置（清洗非法条目；损坏时抛错由调用方提示） */
async function readUserConfig(): Promise<McpConfigFile> {
  await ensureUserConfig()
  const raw = await fs.readFile(userConfigPath(), 'utf-8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`MCP 配置文件解析失败（${userConfigPath()}）：${(err as Error).message}`)
  }
  return sanitizeConfigFile(parsed)
}

async function writeUserConfig(cfg: McpConfigFile): Promise<void> {
  await atomicWrite(userConfigPath(), JSON.stringify(cfg, null, 2))
}

// ---------- spawn 解析 ----------

// 解析 server 配置为 spawn 参数
function resolveSpawn(cfg: McpServerConfig): {
  command: string
  args: string[]
  env: Record<string, string>
} {
  // 复制当前环境变量并剔除 undefined（spawn 的 env 要求值为 string）
  const baseEnv: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
  // 允许的目录参数中的 "." 解析为项目根目录（开发态即 scholarTreaCode 目录）
  const baseDir = app.isPackaged ? app.getAppPath() : process.cwd()
  const resolvedArgs = (cfg.args ?? []).map((a) => (a === '.' ? baseDir : a))

  if (cfg.package) {
    // 本地包模式：读取包的 package.json，取 bin 入口
    const pkgJsonPath = nodeRequire.resolve(`${cfg.package}/package.json`)
    const pkgJson = nodeRequire(pkgJsonPath) as { bin?: string | Record<string, string> }
    const binEntry =
      typeof pkgJson.bin === 'string'
        ? pkgJson.bin
        : Object.values(pkgJson.bin ?? {})[0]
    if (!binEntry) {
      throw new Error(`MCP 包 ${cfg.package} 未声明 bin 入口`)
    }
    const entryPath = resolve(pkgJsonPath, '..', binEntry)
    // 打包后该包被 asarUnpack 解包到 app.asar.unpacked，spawn 子进程需指向真实磁盘路径
    const realEntry = app.isPackaged
      ? entryPath.replace('app.asar', 'app.asar.unpacked')
      : entryPath
    return {
      // ELECTRON_RUN_AS_NODE=1 让 electron 可执行文件以纯 Node 模式运行脚本（强制位，用户 env 不可覆盖）
      command: process.execPath,
      args: [realEntry, ...resolvedArgs],
      env: { ...baseEnv, ...(cfg.env ?? {}), ELECTRON_RUN_AS_NODE: '1' }
    }
  }

  if (!cfg.command) {
    throw new Error('MCP 配置必须提供 package 或 command')
  }

  // command 模式：原样启动（PATH 中存在的真实二进制），用户 env 覆盖同名变量
  return {
    command: cfg.command,
    args: resolvedArgs,
    env: { ...baseEnv, ...(cfg.env ?? {}) }
  }
}

// ---------- 连接状态机 ----------

function setState(name: string, patch: Partial<ServerRuntime>): void {
  const prev = _states.get(name)
  _states.set(name, {
    status: patch.status ?? prev?.status ?? 'connecting',
    error: patch.error !== undefined ? patch.error : prev?.error ?? null,
    connectedAt: patch.connectedAt !== undefined ? patch.connectedAt : prev?.connectedAt ?? null,
    tools: patch.tools ?? prev?.tools ?? []
  })
}

async function disconnectServer(name: string): Promise<void> {
  const old = _clients.get(name)
  if (old) {
    try {
      await old.close()
    } catch {
      // 关闭失败可忽略
    }
    _clients.delete(name)
  }
}

/** 拉取并缓存工具清单 */
async function refreshTools(name: string, client: Client): Promise<void> {
  try {
    const res = await client.listTools()
    const tools = ((res.tools as Array<{ name: string; description?: string }>) ?? []).map((t) => ({
      name: t.name,
      ...(t.description ? { description: t.description } : {})
    }))
    setState(name, { tools })
  } catch {
    // 工具清单拉取失败保留旧缓存，不影响连接状态
  }
}

/**
 * 连接单个服务器并更新状态（不抛异常）。
 * @returns 连接后的最终状态
 */
async function connectServer(name: string, cfg: McpServerConfig): Promise<ServerRuntime> {
  await disconnectServer(name)
  setState(name, { status: 'connecting', error: null, connectedAt: null, tools: [] })
  let transport: StdioClientTransport | null = null
  try {
    const spawnInfo = resolveSpawn(cfg)
    transport = new StdioClientTransport({
      command: spawnInfo.command,
      args: spawnInfo.args,
      env: spawnInfo.env,
      stderr: 'pipe'
    })
    // 打印 server 的 stderr，便于定位启动失败原因（正常情况下 server 很安静）
    transport.stderr?.on('data', (buf: Buffer) => {
      const text = buf.toString().trim()
      if (text) console.warn(`[mcp:${name}] ${text}`)
    })
    const client = new Client({ name: 'scholar-trea-code', version: '0.1.0' })
    await client.connect(transport, { timeout: INIT_TIMEOUT_MS })
    _clients.set(name, client)
    setState(name, { status: 'connected', error: null, connectedAt: Date.now() })
    console.log(`[mcp] 已连接服务器: ${name}`)
    await refreshTools(name, client)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    setState(name, { status: 'error', error: message, connectedAt: null, tools: [] })
    console.error(`[mcp] 连接服务器 ${name} 失败:`, message)
    try {
      await transport?.close()
    } catch {
      // 关闭失败可忽略
    }
  }
  return _states.get(name)!
}

/** 聚合单个服务器的 UI 信息 */
function buildUiInfo(name: string, cfg: McpServerConfig | undefined, builtin = false): UiMcpServerInfo {
  const state = _states.get(name)
  const enabled = cfg ? isEnabled(cfg) : true
  // 有状态记录时以记录的 error 为准（connected 时为 null，不能被兜底覆盖）；
  // 仅在完全没有状态记录且应连接却未连接时提示「未连接」
  const fallbackError = !state && !builtin && enabled ? '未连接' : null
  return {
    name,
    description: cfg?.description ?? (builtin ? '进程内内置终端工具（AI 执行命令复用用户终端会话）' : ''),
    mode: builtin ? 'builtin' : cfg?.package ? 'package' : 'command',
    ...(cfg?.package ? { package: cfg.package } : {}),
    ...(cfg?.command ? { command: cfg.command } : {}),
    args: cfg?.args ?? [],
    env: cfg?.env ?? {},
    enabled,
    status: builtin
      ? 'builtin'
      : !enabled
        ? 'disabled'
        : state?.status ?? 'error',
    error: state ? (state.error ?? null) : fallbackError,
    tools: state?.tools ?? []
  }
}

// 注册 MCP 相关 IPC
export async function registerMcpHandlers(): Promise<void> {
  // 读取配置（userData 可写层，首启播种）并连接所有已启用服务器
  let configFile: McpConfigFile = { mcpServers: {} }
  try {
    configFile = await readUserConfig()
  } catch (err) {
    console.error('[mcp]', (err as Error).message)
  }

  for (const [name, cfg] of Object.entries(configFile.mcpServers)) {
    if (!isEnabled(cfg)) {
      setState(name, { status: 'disabled', error: null, connectedAt: null, tools: [] })
      continue
    }
    await connectServer(name, cfg)
  }

  // 注册进程内终端 MCP 客户端（run_terminal_command 工具）
  try {
    const termClient = await createTerminalClient()
    _clients.set('terminal', termClient)
    setState('terminal', { status: 'builtin', error: null, connectedAt: Date.now(), tools: [] })
    await refreshTools('terminal', termClient)
    console.log('[mcp] 内置终端服务器已注册')
  } catch (err) {
    console.error('[mcp] 内置终端服务器注册失败:', err)
  }

  // 把某个 MCP 服务器以「追加允许目录」的方式重启（用于 filesystem 跟随用户工作区）。
  // filesystem server 的 allowed directories 只能在启动参数中指定（客户端不支持 Roots 协议），
  // 因此工作区切换时需要断开旧连接、用新目录重新拉起；目录保序去重避免重复追加。
  async function restartServerWithArgs(name: string, extraArgs: string[]): Promise<boolean> {
    const cfg = (await readUserConfig().catch((): McpConfigFile => ({ mcpServers: {} }))).mcpServers[name]
    if (!cfg) return false
    // 把 "." 规范成子进程 cwd 的绝对路径，再与新增目录做保序去重
    // （否则 “.” 解析后与绝对路径等价但字符串不同，filesystem 允许列表会重复）
    const normalizedArgs = (cfg.args ?? []).map((a) => (a === '.' ? resolve('.') : a))
    const merged: McpServerConfig = { ...cfg, args: dedupePaths([...normalizedArgs, ...extraArgs]) }
    const state = await connectServer(name, merged)
    return state.status === 'connected'
  }

  // 渲染进程选择/恢复工作区后调用：filesystem 服务器重启，允许目录追加该工作区
  ipcMain.handle('mcp:setWorkspaceRoot', async (_e, root: string) => {
    if (!root) return { ok: false, error: 'root 为空' }
    // 同步终端工具的工作目录基准，使 run_terminal_command 默认在工作区执行
    setTerminalWorkspace(root)
    // 持久终端 shell 跟随切换到新工作区（重启 shell）
    setTerminalCwd(root)
    // 真 PTY：后续新建终端默认落在新工作区（已有会话不强杀）
    setPtyDefaultCwd(root)
    const ok = await restartServerWithArgs('filesystem', [root])
    return { ok }
  })

  // 列出所有已连接服务器的 tools 清单（旧通道，AI 桥接/调试用）
  ipcMain.handle('mcp:listTools', async () => {
    const all: { server: string; tools: unknown[] }[] = []
    for (const [server, client] of _clients) {
      try {
        const res = await client.listTools()
        all.push({ server, tools: (res.tools as unknown[]) ?? [] })
      } catch (err) {
        console.error(`[mcp] listTools 失败 (${server}):`, err)
      }
    }
    return all
  })

  // 调用某个服务器上的指定 tool
  ipcMain.handle(
    'mcp:callTool',
    async (_e, server: string, name: string, args: Record<string, unknown>) => {
      const client = _clients.get(server)
      if (!client) return { ok: false, error: `未找到 MCP 服务器: ${server}` }
      try {
        const res = await client.callTool({ name, arguments: args })
        return { ok: true, result: res }
      } catch (err: unknown) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // ---------- 服务器管理（McpSettings UI） ----------

  // 服务器列表：配置全量（含禁用/未连接）+ 运行时状态 + 工具清单；
  // connected 服务器顺手刷新一次工具清单（失败用缓存，不拖慢列表）
  ipcMain.handle('mcp:listServers', async (): Promise<UiMcpServerInfo[]> => {
    let cfg: McpConfigFile = { mcpServers: {} }
    try {
      cfg = await readUserConfig()
    } catch (err) {
      console.error('[mcp]', (err as Error).message)
    }
    const infos = Object.entries(cfg.mcpServers).map(([name, c]) => buildUiInfo(name, c))
    // 内置终端追加在末尾（不在配置文件中）
    if (_clients.has('terminal')) infos.push(buildUiInfo('terminal', undefined, true))

    await Promise.all(
      infos
        .filter((i) => i.status === 'connected')
        .map(async (i) => {
          const client = _clients.get(i.name)
          if (client) await refreshTools(i.name, client)
        })
    )
    // refreshTools 更新的是状态表，重新组装一次带出最新工具
    return infos.map((i) =>
      i.name === 'terminal' ? buildUiInfo('terminal', undefined, true) : buildUiInfo(i.name, cfg.mcpServers[i.name])
    )
  })

  // 新增服务器：名称查重 + 配置校验 → 落盘 → 后台连接（立即返回 connecting，不阻塞 UI）
  ipcMain.handle(
    'mcp:addServer',
    async (
      _e,
      name: string,
      input: unknown
    ): Promise<{ ok: boolean; error?: string; status?: ServerStatus }> => {
      let cfgFile: McpConfigFile
      try {
        cfgFile = await readUserConfig()
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
      const nameCheck = validateServerName(name, Object.keys(cfgFile.mcpServers))
      if (!nameCheck.ok) return { ok: false, error: nameCheck.error }
      const cfgCheck = validateServerConfig(input)
      if (!cfgCheck.ok) return { ok: false, error: cfgCheck.error }
      const finalName = nameCheck.value
      cfgFile.mcpServers[finalName] = cfgCheck.value
      await writeUserConfig(cfgFile)
      // 后台连接（慢服务器最长 120s，不卡住保存响应）
      if (isEnabled(cfgCheck.value)) {
        setState(finalName, { status: 'connecting', error: null, connectedAt: null, tools: [] })
        void connectServer(finalName, cfgCheck.value)
        return { ok: true, status: 'connecting' }
      }
      setState(finalName, { status: 'disabled', error: null, connectedAt: null, tools: [] })
      return { ok: true, status: 'disabled' }
    }
  )

  // 更新服务器（不可改名；改名=删除后新增）
  ipcMain.handle(
    'mcp:updateServer',
    async (
      _e,
      name: string,
      input: unknown
    ): Promise<{ ok: boolean; error?: string; status?: ServerStatus }> => {
      let cfgFile: McpConfigFile
      try {
        cfgFile = await readUserConfig()
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
      const prev = cfgFile.mcpServers[name]
      if (!prev) return { ok: false, error: `服务器 "${name}" 不存在` }
      const cfgCheck = validateServerConfig(input)
      if (!cfgCheck.ok) return { ok: false, error: cfgCheck.error }
      // 保留启用位（启停由 toggle 专门管理；表单不传 enabled）
      const next: McpServerConfig = { ...cfgCheck.value, enabled: prev.enabled }
      cfgFile.mcpServers[name] = next
      await writeUserConfig(cfgFile)
      if (isEnabled(next)) {
        const state = await connectServer(name, next)
        return { ok: true, status: state.status }
      }
      await disconnectServer(name)
      setState(name, { status: 'disabled', error: null, connectedAt: null })
      return { ok: true, status: 'disabled' }
    }
  )

  // 删除服务器（内置 terminal 拒绝）
  ipcMain.handle(
    'mcp:removeServer',
    async (_e, name: string): Promise<{ ok: boolean; error?: string }> => {
      if (name === 'terminal') return { ok: false, error: '内置服务器不可删除' }
      let cfgFile: McpConfigFile
      try {
        cfgFile = await readUserConfig()
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
      if (!(name in cfgFile.mcpServers)) return { ok: false, error: `服务器 "${name}" 不存在` }
      await disconnectServer(name)
      delete cfgFile.mcpServers[name]
      _states.delete(name)
      await writeUserConfig(cfgFile)
      return { ok: true }
    }
  )

  // 启用/禁用
  ipcMain.handle(
    'mcp:toggleServer',
    async (
      _e,
      name: string,
      enabled: boolean
    ): Promise<{ ok: boolean; error?: string; status?: ServerStatus }> => {
      // 内置 terminal 不在配置文件中，拒绝时给出与删除一致的语义提示
      if (name === 'terminal') return { ok: false, error: '内置服务器不可停用' }
      let cfgFile: McpConfigFile
      try {
        cfgFile = await readUserConfig()
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
      const cfg = cfgFile.mcpServers[name]
      if (!cfg) return { ok: false, error: `服务器 "${name}" 不存在` }
      cfgFile.mcpServers[name] = { ...cfg, enabled }
      await writeUserConfig(cfgFile)
      if (enabled) {
        setState(name, { status: 'connecting', error: null, connectedAt: null, tools: [] })
        void connectServer(name, cfgFile.mcpServers[name])
        return { ok: true, status: 'connecting' }
      }
      await disconnectServer(name)
      setState(name, { status: 'disabled', error: null, connectedAt: null, tools: [] })
      return { ok: true, status: 'disabled' }
    }
  )

  // 手动重连（等待最终结果返回，便于 UI 直接展示错误）
  ipcMain.handle(
    'mcp:restartServer',
    async (
      _e,
      name: string
    ): Promise<{ ok: boolean; error?: string; status?: ServerStatus }> => {
      if (name === 'terminal') return { ok: false, error: '内置服务器无需重连' }
      let cfgFile: McpConfigFile
      try {
        cfgFile = await readUserConfig()
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
      const cfg = cfgFile.mcpServers[name]
      if (!cfg) return { ok: false, error: `服务器 "${name}" 不存在` }
      const state = await connectServer(name, cfg)
      return { ok: state.status === 'connected', status: state.status, error: state.error ?? undefined }
    }
  )
}
