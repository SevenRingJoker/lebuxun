// AI 工具权限决策引擎（纯逻辑，可单测）+ 权限模式持久化。
// 三种模式：
//   readonly —— 只允许只读工具，写/命令一律拒绝
//   ask      —— 默认模式，写/命令逐条询问用户
//   auto     —— 常规写/命令自动放行，危险命令仍需询问
// 无论哪种模式：敏感文件硬拒、工作区外写入硬拒、工作区外读取/命令目录逃逸降级询问。
import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, sep, basename } from 'node:path'
import { isInside } from '../handlers/security'

/** 权限模式 */
export type PermissionMode = 'readonly' | 'ask' | 'auto'

/** 决策结果：放行 / 硬拒 / 询问用户 */
export type Decision = 'allow' | 'deny' | 'ask'

/** 用户对一次询问的应答 */
export type UserPermissionResponse = {
  decision: 'allow_once' | 'allow_always' | 'deny'
  reason?: string
}

/** 发给前端审批条的请求体 */
export interface PermissionRequest {
  /** 工具名 */
  tool: string
  /** 操作目标（文件绝对路径或命令全文），供 UI 展示 */
  target: string
  /** 决策原因/风险说明 */
  reason: string
  /** 是否危险操作（红色高亮） */
  danger?: boolean
}

/** 关卡检查结果 */
export interface GateResult {
  allowed: boolean
  reason: string
}

export interface EvaluateContext {
  workspace?: string | null
}

export interface PermissionVerdict extends PermissionRequest {
  decision: Decision
}

/** 只读工具：任何模式下都放行（仍受敏感文件/逃逸规则约束） */
const READ_ONLY_TOOLS = new Set([
  'read',
  'read_file',
  // 新版 filesystem MCP 读取工具更名（旧 read_file 标记废弃但仍可用）
  'read_text_file',
  'grep',
  'search_files',
  'glob',
  'list_directory',
  // 新版 MCP 新增的带大小目录列表（只读）
  'list_directory_with_sizes',
  'list_allowed_directories',
  'get_file_info',
  // 网络只读工具（web_fetch/web_search/npm_info）：不修改本地状态，按只读放行
  'web_fetch',
  'web_search',
  'npm_info'
])

/** 写入类工具 */
const WRITE_TOOLS = new Set([
  'write',
  'write_file',
  'edit',
  'edit_file',
  'create_directory',
  'move_file',
  'delete_file',
  'copy_file',
  'rename_file',
  // 内置扩展文件工具
  'delete',
  'move',
  'copy'
])

/** 命令执行类工具（run_script/git 通过 commandTextOf 合成命令文本参与危险检测） */
const COMMAND_TOOLS = new Set(['bash', 'run_terminal_command', 'run_script', 'git'])

/** 敏感文件名/扩展名匹配：密钥、环境变量、凭据、审计日志自身（防提示注入） */
const SENSITIVE_PATTERNS: RegExp[] = [
  /(^|[\\/])\.env(\..*)?$/i,
  /(^|[\\/])id_(rsa|dsa|ecdsa|ed25519)$/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /(^|[\\/])credentials$/i,
  /(^|[\\/])\.git[\\/]config$/i,
  /(^|[\\/])\.trae[\\/]audit\.log$/i,
  /(^|[\\/])\.npmrc$/i,
  /(^|[\\/])\.pypirc$/i
]

/** 危险命令：破坏面大或会改变系统配置，auto 模式下也必须询问 */
const DANGEROUS_COMMAND_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive\s+--force)\b/i, label: '递归强制删除' },
  { re: /\brmdir\s+\/s\b/i, label: '递归删除目录' },
  { re: /\bdel\b[^|]*\/[sqf]/i, label: '强制/静默删除文件' },
  { re: /\bformat\s+[a-z]:/i, label: '格式化磁盘' },
  { re: /\breg\s+(add|delete|import)\b/i, label: '修改注册表' },
  { re: /\bnetsh\b/i, label: '修改防火墙/网络配置' },
  { re: /\bshutdown\b/i, label: '关机/重启系统' },
  { re: /\btaskkill\b/i, label: '强制结束进程' },
  { re: /\b(diskpart|mklink|icacls|cacls|takeown|bcdedit)\b/i, label: '磁盘/权限/链接系统操作' },
  { re: /(curl|wget)[^|]*\|\s*(iex|sh|bash|cmd|powershell)/i, label: '下载并直接执行远程脚本' },
  { re: /\bnpm\s+publish\b/i, label: '发布包到公共 registry' },
  { re: /\bSet-ExecutionPolicy\b/i, label: '修改 PowerShell 执行策略' },
  { re: />\s*\/?(dev|sys|proc)\//i, label: '写入系统设备文件' }
]

/**
 * 取工具参数中的文件/目录目标（可能多个，如 move 的 src+dst）。
 * 命令类返回空——命令用 cwd 做逃逸检查、用命令全文做危险检查。
 */
export function extractTargets(name: string, args: Record<string, any>): string[] {
  const a = args ?? {}
  const pick = (...keys: string[]) =>
    keys.map((k) => (typeof a[k] === 'string' ? a[k] : '')).filter(Boolean)
  switch (name) {
    case 'write':
    case 'write_file':
    case 'edit':
    case 'edit_file':
    case 'delete_file':
    case 'delete':
    case 'read':
    case 'read_file':
    case 'read_text_file':
    case 'create_directory':
      return pick('path', 'file_path', 'filePath')
    case 'list_directory':
    case 'list_directory_with_sizes':
      return pick('path', 'root', 'dir', 'cwd')
    case 'move_file':
    case 'copy_file':
    case 'rename_file':
    case 'move':
    case 'copy':
      return pick('path', 'source', 'src', 'destination', 'dest', 'destination_path', 'newPath')
    case 'grep':
    case 'search_files':
    case 'glob':
      return pick('path', 'root', 'dir', 'cwd')
    default:
      return []
  }
}

/** 敏感文件判定：任意一个目标命中即视为敏感 */
export function isSensitiveTarget(targets: string[]): boolean {
  return targets.some((t) => SENSITIVE_PATTERNS.some((p) => p.test(t.replace(/\\/g, '/'))))
}

/** 危险命令判定，返回命中的风险说明 */
export function detectDangerousCommand(cmd: string): string | null {
  for (const { re, label } of DANGEROUS_COMMAND_PATTERNS) {
    if (re.test(cmd)) return label
  }
  return null
}

/**
 * 提取命令类工具的命令全文（供危险检测与"始终允许"签名）。
 * bash/run_terminal_command 直接取 command 参数；
 * run_script 合成为 `npm run <name>`；git 合成为 `git <args...>`。
 */
export function commandTextOf(name: string, args: Record<string, any>): string {
  const a = args ?? {}
  if (typeof a.command === 'string' && a.command) return a.command
  if (name === 'run_script') return `npm run ${typeof a.name === 'string' ? a.name : ''}`
  if (name === 'git') {
    return 'git ' + (Array.isArray(a.args) ? a.args.map(String).join(' ') : String(a.args ?? ''))
  }
  return ''
}

/**
 * 核心决策函数（纯逻辑）：给定工具/参数/工作区/模式，产出 allow|deny|ask 判定。
 */
export function evaluate(
  name: string,
  args: Record<string, any>,
  ctx: EvaluateContext,
  mode: PermissionMode
): PermissionVerdict {
  const a = args ?? {}
  const isCommand = COMMAND_TOOLS.has(name)
  const isWrite = WRITE_TOOLS.has(name)
  const isRead = READ_ONLY_TOOLS.has(name)
  // 未知 MCP 工具：保守按"可能写"处理
  const kind = isCommand ? 'command' : isWrite ? 'write' : isRead ? 'read' : 'unknown'

  // ---- 命令类 ----
  if (isCommand) {
    const cmd = commandTextOf(name, a)
    const cwd = typeof a.cwd === 'string' ? a.cwd : ''
    const dangerLabel = detectDangerousCommand(cmd)

    if (mode === 'readonly') {
      return { decision: 'deny', tool: name, target: cmd, reason: '当前为只读模式，禁止执行终端命令' }
    }
    // 危险命令：任何模式都询问
    if (dangerLabel) {
      return {
        decision: 'ask',
        tool: name,
        target: cmd,
        danger: true,
        reason: `危险命令（${dangerLabel}），可能造成不可逆破坏，请仔细确认`
      }
    }
    // cwd 逃逸到工作区外
    if (ctx.workspace && cwd && !isInside(ctx.workspace, cwd)) {
      return {
        decision: 'ask',
        tool: name,
        target: cmd,
        reason: `命令将在工作区外目录执行（${resolve(cwd)}）`
      }
    }
    // 无工作区：命令一律询问
    if (!ctx.workspace) {
      return { decision: 'ask', tool: name, target: cmd, reason: '未打开工作区，命令执行需用户确认' }
    }
    return mode === 'auto'
      ? { decision: 'allow', tool: name, target: cmd, reason: 'auto 模式常规命令' }
      : { decision: 'ask', tool: name, target: cmd, reason: '终端命令执行确认' }
  }

  // ---- 文件类（读/写/未知）----
  const targets = extractTargets(name, a)
  const targetText = targets.join(' , ')

  // 敏感文件：任何模式、读或写都硬拒（防止 AI 读取密钥外泄或篡改凭据）
  if (targets.length > 0 && isSensitiveTarget(targets)) {
    return {
      decision: 'deny',
      tool: name,
      target: targetText,
      reason: '目标为敏感文件（密钥/环境变量/凭据/审计日志），已被安全策略禁止访问'
    }
  }

  if (kind === 'write') {
    if (mode === 'readonly') {
      return { decision: 'deny', tool: name, target: targetText, reason: '当前为只读模式，禁止写入/修改/删除文件' }
    }
    if (!ctx.workspace) {
      return { decision: 'ask', tool: name, target: targetText, reason: '未打开工作区，文件写入需用户确认' }
    }
    // 工作区外写入：硬拒（防止越界改系统/其他项目文件）
    const escaped = targets.filter((t) => !isInside(ctx.workspace!, t))
    if (escaped.length > 0) {
      return {
        decision: 'deny',
        tool: name,
        target: escaped.join(' , '),
        reason: `目标路径逃逸出工作区边界（${escaped.join('、')}），已禁止写入`
      }
    }
    return mode === 'auto'
      ? { decision: 'allow', tool: name, target: targetText, reason: 'auto 模式工作区内写入' }
      : { decision: 'ask', tool: name, target: targetText, reason: '文件写入/修改确认' }
  }

  if (kind === 'read') {
    // 只读操作默认放行；工作区外读取降级询问（防止读取系统文件后外泄）
    const ws = ctx.workspace
    if (ws && targets.length > 0) {
      const escaped = targets.filter((t) => !isInside(ws, t))
      if (escaped.length > 0) {
        return {
          decision: 'ask',
          tool: name,
          target: escaped.join(' , '),
          reason: `将读取工作区外文件（${escaped.join('、')}）`
        }
      }
    }
    return { decision: 'allow', tool: name, target: targetText, reason: '只读操作' }
  }

  // 未知工具：保守策略——readonly 拒绝，其余询问（auto 也不放行未登记工具）
  if (mode === 'readonly') {
    return { decision: 'deny', tool: name, target: targetText, reason: '当前为只读模式，未登记工具禁止使用' }
  }
  return { decision: 'ask', tool: name, target: targetText, reason: '未登记工具调用，需用户确认' }
}

/** "始终允许"会话规则的签名：工具名 + 归一化目标（路径 resolve，命令 trim） */
export function signatureOf(name: string, args: Record<string, any>, workspace?: string | null): string {
  const a = args ?? {}
  if (COMMAND_TOOLS.has(name)) {
    return `${name}|cmd:${commandTextOf(name, a).trim()}`
  }
  const targets = extractTargets(name, a)
    .map((t) => (workspace ? resolve(workspace, t) : resolve(t)))
    .join(',')
  return `${name}|${targets}`
}

// ---------------- 模式持久化（userData/ai-permissions.json） ----------------

const CONFIG_FILE = (): string => join(app.getPath('userData'), 'ai-permissions.json')
const DEFAULT_MODE: PermissionMode = 'ask'

let cachedMode: PermissionMode | null = null

/** 读取当前权限模式（失败回落到默认 ask） */
export function getPermissionMode(): PermissionMode {
  if (cachedMode) return cachedMode
  try {
    if (existsSync(CONFIG_FILE())) {
      const raw = JSON.parse(readFileSync(CONFIG_FILE(), 'utf-8'))
      if (raw.mode === 'readonly' || raw.mode === 'ask' || raw.mode === 'auto') {
        cachedMode = raw.mode as PermissionMode
        return raw.mode as PermissionMode
      }
    }
  } catch {
    // 配置损坏则回落默认
  }
  cachedMode = DEFAULT_MODE
  return cachedMode
}

/** 持久化权限模式 */
export function setPermissionMode(mode: PermissionMode): void {
  cachedMode = mode
  try {
    writeFileSync(CONFIG_FILE(), JSON.stringify({ mode }, null, 2), 'utf-8')
  } catch {
    // 持久化失败不影响本次运行
  }
}

// ---------------- 运行时关卡（一次 Agent 运行一个实例） ----------------

/** 询问用户回调：由 IPC 层实现，弹审批条并等待应答 */
export type AskUserFn = (req: PermissionRequest) => Promise<UserPermissionResponse>

/**
 * 权限关卡：scheduler/subagents 在真正执行工具前统一过闸。
 * 会话级"始终允许"规则保存在内存中，随 Agent 运行结束而失效。
 */
export class PermissionGate {
  private alwaysAllow = new Set<string>()

  constructor(
    private readonly workspace: string | null | undefined,
    private readonly askUser: AskUserFn,
    private readonly resolveMode: () => PermissionMode = getPermissionMode
  ) {}

  /**
   * 检查一次工具调用。
   * @param audit 审计回调（由主进程注入，写 .trae/audit.log）
   */
  async check(
    name: string,
    args: Record<string, any>,
    audit?: (entry: { tool: string; target: string; mode: PermissionMode; decision: string; reason: string }) => void
  ): Promise<GateResult> {
    const mode = this.resolveMode()
    const verdict = evaluate(name, args, { workspace: this.workspace }, mode)

    if (verdict.decision === 'allow') {
      audit?.({ tool: name, target: verdict.target, mode, decision: 'allow', reason: verdict.reason })
      return { allowed: true, reason: verdict.reason }
    }
    if (verdict.decision === 'deny') {
      audit?.({ tool: name, target: verdict.target, mode, decision: 'deny', reason: verdict.reason })
      return { allowed: false, reason: verdict.reason }
    }

    // ask：先查会话级"始终允许"
    const sig = signatureOf(name, args, this.workspace)
    if (this.alwaysAllow.has(sig)) {
      audit?.({ tool: name, target: verdict.target, mode, decision: 'allow', reason: '会话始终允许规则命中' })
      return { allowed: true, reason: '会话始终允许规则命中' }
    }

    // 推送审批条并等待用户应答
    let resp: UserPermissionResponse
    try {
      resp = await this.askUser({
        tool: name,
        target: verdict.target,
        reason: verdict.reason,
        danger: verdict.danger
      })
    } catch {
      resp = { decision: 'deny', reason: '审批请求失败' }
    }

    if (resp.decision === 'deny') {
      const reason = resp.reason || '用户拒绝了该操作'
      audit?.({ tool: name, target: verdict.target, mode, decision: 'deny', reason })
      return { allowed: false, reason }
    }
    if (resp.decision === 'allow_always' && !verdict.danger) {
      // 危险操作不登记始终允许，强制逐次确认
      this.alwaysAllow.add(sig)
    }
    audit?.({
      tool: name,
      target: verdict.target,
      mode,
      decision: resp.decision === 'allow_always' ? 'allow_always' : 'allow',
      reason: '用户批准'
    })
    return { allowed: true, reason: '用户批准' }
  }
}

// 便于单测构造跨平台路径
export const _internal = { sep, basename }
