// MCP 服务器配置纯函数层：校验、文本解析、配置合并、目录去重。
// 零 electron / 零 SDK 依赖，可直接在 vitest 下测试。
// 供 handlers/mcp.ts（主进程）与未来可能的配置导入导出复用。
import { resolve, isAbsolute } from 'node:path'

/** 服务器名称白名单：字母数字下划线连字符，最长 40 */
export const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,40}$/

/** 保留名称：进程内内置终端服务器，不允许用户配置占用 */
export const RESERVED_NAMES = new Set(['terminal'])

export function isReservedName(name: string): boolean {
  return RESERVED_NAMES.has(name)
}

/** 落盘/传输的服务器配置（与 mcp-servers.json 中的条目对应） */
export interface McpServerConfig {
  /** 本地 node_modules 包名模式（与 command 二选一） */
  package?: string
  /** 可执行命令模式 */
  command?: string
  args?: string[]
  /** 透传给子进程的环境变量 */
  env?: Record<string, string>
  description?: string
  /** 是否启用；缺省视为 true（兼容旧配置文件） */
  enabled?: boolean
}

export type McpConfigFile = { mcpServers: Record<string, McpServerConfig> }

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string }

/**
 * 校验服务器名称。
 * 注意：existingNames 查重由调用方在新增场景传入（编辑场景名称不可改，无需查重）。
 */
export function validateServerName(name: string, existingNames?: string[]): ValidationResult<string> {
  const trimmed = (name ?? '').trim()
  if (!trimmed) return { ok: false, error: '名称不能为空' }
  if (!SERVER_NAME_RE.test(trimmed)) {
    return { ok: false, error: '名称仅支持字母、数字、下划线、连字符，且不超过 40 个字符' }
  }
  if (isReservedName(trimmed)) return { ok: false, error: `"${trimmed}" 是内置保留名称，请更换` }
  if (existingNames?.includes(trimmed)) return { ok: false, error: `已存在同名服务器 "${trimmed}"` }
  return { ok: true, value: trimmed }
}

/**
 * 校验服务器配置主体：package / command 必须且只能填一个；
 * args 必须是字符串数组；env 的值必须是字符串。
 * 返回规范化后的配置（剔除空白项、args 去空白）。
 */
export function validateServerConfig(input: unknown): ValidationResult<McpServerConfig> {
  if (!input || typeof input !== 'object') return { ok: false, error: '配置格式无效' }
  const obj = input as Record<string, unknown>
  const pkg = typeof obj.package === 'string' ? obj.package.trim() : ''
  const cmd = typeof obj.command === 'string' ? obj.command.trim() : ''
  if (!pkg && !cmd) return { ok: false, error: '必须提供本地包名（package）或启动命令（command）' }
  if (pkg && cmd) return { ok: false, error: '包名与启动命令只能二选一' }

  const out: McpServerConfig = {}
  if (pkg) out.package = pkg
  else out.command = cmd

  // args：数组，逐项字符串化并去首尾空白，丢弃空项
  if (obj.args !== undefined) {
    if (!Array.isArray(obj.args)) return { ok: false, error: '参数必须是字符串数组' }
    const args = obj.args
      .map((a) => (typeof a === 'string' ? a.trim() : String(a ?? '').trim()))
      .filter((a) => a.length > 0)
    if (args.length) out.args = args
  }

  // env：键值对，键非空、值字符串化（允许空值，如 SOME_FLAG=）
  if (obj.env !== undefined) {
    if (typeof obj.env !== 'object' || obj.env === null || Array.isArray(obj.env)) {
      return { ok: false, error: '环境变量必须是键值对对象' }
    }
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(obj.env as Record<string, unknown>)) {
      const key = k.trim()
      if (!key) continue
      env[key] = typeof v === 'string' ? v : String(v ?? '')
    }
    if (Object.keys(env).length) out.env = env
  }

  if (typeof obj.description === 'string' && obj.description.trim()) {
    out.description = obj.description.trim()
  }
  if (typeof obj.enabled === 'boolean') out.enabled = obj.enabled
  return { ok: true, value: out }
}

/**
 * 校验完整配置文件结构（读取/播种时使用）。
 * 宽容策略：非法条目跳过；返回干净的 { mcpServers } 结构。
 */
export function sanitizeConfigFile(raw: unknown): McpConfigFile {
  const servers: Record<string, McpServerConfig> = {}
  const container =
    raw && typeof raw === 'object' && 'mcpServers' in (raw as object)
      ? (raw as { mcpServers: unknown }).mcpServers
      : raw // 也接受直接就是 servers map 的形态
  if (!container || typeof container !== 'object') return { mcpServers: servers }
  for (const [name, entry] of Object.entries(container as Record<string, unknown>)) {
    const nameCheck = validateServerName(name)
    const cfgCheck = validateServerConfig(entry)
    if (!nameCheck.ok || !cfgCheck.ok) continue
    servers[nameCheck.value] = cfgCheck.value
  }
  return { mcpServers: servers }
}

/** 文本域每行一个参数 → 数组（去空行/首尾空白） */
export function parseArgsLines(text: string): string[] {
  return (text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
}

/**
 * 环境变量文本（每行 KEY=VALUE）→ 对象。
 * - 忽略空行与 # 开头注释行
 * - 缺等号的行收集到错误中返回，不静默丢弃，防止用户写错却无感知
 * - 键做 trim，值保留除首尾空格外的原样（值内部空格有意义）
 */
export function parseEnvLines(text: string): { env: Record<string, string>; errors: string[] } {
  const env: Record<string, string> = {}
  const errors: string[] = []
  for (const rawLine of (text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) {
      errors.push(`无法解析的环境变量行：${line}`)
      continue
    }
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    if (!key) {
      errors.push(`环境变量名缺失：${line}`)
      continue
    }
    env[key] = value
  }
  return { env, errors }
}

/** 对象 → 环境变量文本（KEY=VALUE 每行一个），供编辑表单回填 */
export function envToLines(env: Record<string, string> | undefined): string {
  if (!env) return ''
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
}

/**
 * 配置合并：bundled 默认层 + user 用户层，按服务器名合并，user 完全覆盖同名条目。
 * 用于未来随包默认与用户自定义并存的场景；当前 userData 播种后以 user 为唯一源，
 * 此函数仍保留供测试与回滚兜底。
 */
export function mergeConfigLayers(bundled: unknown, user: unknown): McpConfigFile {
  const b = sanitizeConfigFile(bundled).mcpServers
  const u = sanitizeConfigFile(user).mcpServers
  return { mcpServers: { ...b, ...u } }
}

/**
 * 保序去重：filesystem server 的允许目录靠启动参数传入，
 * 工作区多次切换时同一目录不能重复追加。
 */
export function dedupeArgs(args: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const a of args ?? []) {
    if (seen.has(a)) continue
    seen.add(a)
    out.push(a)
  }
  return out
}

/**
 * 路径级保序去重：绝对路径先 resolve（规范化分隔符/尾斜杠/./..），
 * Windows 下再忽略大小写；非绝对路径（如 --flag、相对参数）按原文比较。
 * 解决 “.” 解析后的绝对路径与对话框返回路径仅尾斜杠/大小写不同导致的重复追加。
 */
export function dedupePaths(args: string[]): string[] {
  const keyOf = (a: string): string => {
    if (!isAbsolute(a)) return a
    const resolved = resolve(a)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  const seen = new Set<string>()
  const out: string[] = []
  for (const a of args ?? []) {
    const key = keyOf(a)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(a)
  }
  return out
}

/** 判断配置是否启用（enabled 缺省视为 true，兼容旧配置） */
export function isEnabled(cfg: McpServerConfig | undefined): boolean {
  return cfg ? cfg.enabled !== false : false
}
