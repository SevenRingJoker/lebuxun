// 渲染进程 window.api 类型声明：与 src/preload/index.ts 暴露的 API 保持一致

// 调度层返回的模型条目（主进程 ModelEntry 的渲染端视图）
export interface UiModelEntry {
  id: string
  providerId: string
  name: string
  displayName: string
  capabilities: {
    reasoning: boolean
    code: boolean
    speed: 'fast' | 'balanced' | 'slow'
    contextWindow: number
    /** 2.3 视觉能力：能否接收图片输入 */
    vision: boolean
    costTier: number
  }
  available: boolean
}

// 调度层返回的供应商条目（健康探测列表用）
export interface UiProviderEntry {
  id: string
  name: string
  enabled: boolean
  ok: boolean
  version?: string
  error?: string
}

// 设置页供应商卡片条目（含 Key 掩码/baseUrl/内置标识）
export interface UiProviderSettingEntry {
  id: string
  name: string
  enabled: boolean
  builtin: boolean
  baseUrl: string | null
  needsKey: boolean
  hasKey: boolean
  keyMasked: string | null
  encryptionAvailable: boolean
}

// 用量统计
export interface UiModelUsage {
  calls: number
  tokensIn: number
  tokensOut: number
  cost: number
  estimatedCalls: number
}
export interface UiDayUsage {
  calls: number
  tokensIn: number
  tokensOut: number
  cost: number
}
export interface UiUsageStats {
  byModel: Record<string, UiModelUsage>
  byDay: Record<string, UiDayUsage>
  totalCalls: number
  totalCost: number
}

// 代码库持久化索引与检索
export interface UiIndexStatus {
  /** 已索引文件数 */
  files: number
  /** ISO 最近更新时间；尚未构建为 null */
  updatedAt: string | null
  /** 是否正在后台构建 */
  scanning: boolean
}
export interface UiIndexDelta {
  ok: boolean
  total?: number
  added?: number
  updated?: number
  removed?: number
  /** 是否命中文件数上限被截断 */
  truncated?: boolean
  /** 是否命中 5s 节流直接返回缓存 */
  throttled?: boolean
  error?: string
}
export interface UiSearchHit {
  /** 相对工作区根的路径 */
  relPath: string
  /** 相关性分数（BM25 或混合分） */
  score: number
  /** 命中的符号名（符号精确命中时） */
  symbol?: string
  symbolLine?: number
}

// 2.3 图片附件引用（历史只存路径，不进会话大文件）
export interface UiAttachment {
  /** 附件绝对路径（<workspace>/.trae/attachments/...） */
  path: string
  mimeType: string
}

// 2.3 多模态消息片段（随请求发送，user 消息）
export type UiMessagePart =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data?: string; path?: string }

// 聊天会话持久化（按工作区分区存 userData/chat-history/<wsKey>/）
export interface UiSessionMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  toolName?: string
  /** 2.3 图片附件引用（仅 user 消息） */
  attachments?: UiAttachment[]
  /** 毫秒时间戳 */
  ts: number
}
export interface UiSessionMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
  /** 末条非工具消息预览 */
  preview: string
}
export interface UiSessionData {
  id: string
  workspace: string | null
  title: string
  createdAt: number
  updatedAt: number
  messages: UiSessionMessage[]
}

// MCP 服务器管理（stdio）
export type UiMcpServerStatus = 'connected' | 'connecting' | 'error' | 'disabled' | 'builtin'
export interface UiMcpServerInfo {
  name: string
  description: string
  mode: 'package' | 'command' | 'builtin'
  package?: string
  command?: string
  args: string[]
  env: Record<string, string>
  enabled: boolean
  status: UiMcpServerStatus
  error: string | null
  tools: { name: string; description?: string }[]
}
/** 新增/编辑表单提交体（package 与 command 二选一） */
export interface UiMcpServerConfigInput {
  package?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  description?: string
  enabled?: boolean
}
export interface UiMcpSaveResult {
  ok: boolean
  error?: string
  status?: UiMcpServerStatus
}

// 调度聊天参数（model 传 'auto' 走自动路由，否则为 provider:model 复合 id）
export interface UiChatParams {
  model?: string
  messages: { role: string; content: string; name?: string; /** 2.3 多模态片段 */ parts?: UiMessagePart[] }[]
  taskType?: 'reasoning' | 'completion' | 'chat' | 'tool'
  currentFile?: string | null
  workspace?: string | null
  useTools?: boolean
  timeoutMs?: number
}

// Agent 自主维护的 TODO 子任务项（主进程 TodoItem 的渲染端视图）
export interface UiTodoItem {
  id: number
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  priority: 'high' | 'medium' | 'low'
}

// s48 执行时间线步骤（主进程 TimelineStep 的渲染端视图）
export interface UiTimelineStep {
  id: number
  round: number
  name: string
  title: string
  reason: string
  diffSummary: string
  startedAt: number
  durationMs?: number
  status: 'running' | 'ok' | 'fail' | 'cancelled'
  resultTail: string
}
// s48 时间线广播载荷
export interface UiTimelinePayload {
  taskId: string
  steps: UiTimelineStep[]
}

// 计划-执行偏差报告（㉚ 收尾产出、㉜ 前端卡片消费）
export type UiDriftKind = 'unfinishedTodo' | 'missingArtifact' | 'unexpectedFile'
export interface UiDriftItem {
  kind: UiDriftKind
  severity: 'block' | 'warn'
  detail: string
}
export interface UiDriftReport {
  items: UiDriftItem[]
  hasBlock: boolean
  hasWarn: boolean
  /** 工具循环中途强制中断（区别于收尾报告）：前端据此插入系统中断指令 */
  interrupted?: boolean
}

// 子代理并行编排进度事件
export interface UiSubagentUpdate {
  current: number
  total: number
  phase: 'start' | 'round' | 'done' | string
  detail: string
}

/** ㊜ 可恢复任务摘要（恢复条展示用） */
export interface UiRecoverableTask {
  taskId: string
  /** 可恢复态：interrupted（崩溃中断）/ paused（用户软暂停） */
  status: 'interrupted' | 'paused'
  /** 原始用户请求（恢复条显示摘要） */
  userRequest: string
  /** 中断时所在轮次（续跑从下一轮开始） */
  startRound: number
  /** 任务期间新建产物数 */
  createdCount: number
  updatedAt: number
  /** 原模型 id：续跑强制回到原模型，不做隐式回退 */
  modelId: string
  /** 任务前检查点（放弃时可回滚） */
  preTaskCheckpoint: { hash: string; label: string } | null
}

/** ㊜ 1b 运行门事件（live 任务态：started → pausing → paused → running） */
export interface UiTaskControl {
  taskId: string
  phase: 'started' | 'pausing' | 'paused' | 'running'
  /** 仅 started 携带：任务前检查点，放弃确认面板据此决定回滚勾选 */
  preTaskCheckpoint?: { hash: string; label: string } | null
}

/** 工具权限模式：只读 / 询问（默认）/ 自动 */
export type UiPermissionMode = 'readonly' | 'ask' | 'auto'

/** 主进程推送的工具审批请求 */
export interface UiPermissionRequest {
  id: string
  tool: string
  /** 文件路径或命令全文 */
  target: string
  /** 风险/原因说明 */
  reason: string
  /** 危险操作（红色警示） */
  danger?: boolean
}

/** 用户对审批请求的应答 */
export interface UiPermissionResponse {
  decision: 'allow_once' | 'allow_always' | 'deny'
  reason?: string
}

// ㊝ 变更事务暂存（AI 改动先入暂存，接受后落盘）
export type UiStageKind = 'create' | 'modify' | 'delete' | 'move'
export interface UiStageItem {
  path: string
  kind: UiStageKind
  /** move 时的原路径（相对工作区） */
  oldPath?: string | null
}
export interface UiStageSummary {
  total: number
  counts: { create: number; modify: number; delete: number; move: number }
  items: UiStageItem[]
}
export interface UiStageHunkLine {
  kind: 'ctx' | 'del' | 'add'
  text: string
}
export interface UiStageHunk {
  id: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: UiStageHunkLine[]
  tailNewline?: boolean
}
export interface UiStageDiff {
  original: string
  modified: string
  title: string
  /** create/modify 携带 hunk 列表；delete/move 为空数组（仅支持整文件操作） */
  hunks: UiStageHunk[]
}
/** bash 接受门弹层事件（门 id + 当前摘要） */
export interface UiBashAcceptRequest {
  id: string
  summary: UiStageSummary
}

// ===== s45 环境诊断与修复卡片 =====
export type UiFailureCategory = 'missing-dep' | 'version-conflict' | 'system' | 'code' | 'unknown'
export interface UiFailureReport {
  category: UiFailureCategory
  subject: string | null
  summary: string
  hints: string[]
  severity: 'auto' | 'manual'
}
export interface UiRepairAction {
  id: string
  kind: 'install-dep' | 'pin-version' | 'switch-mirror' | 'downgrade' | 'manual-step'
  label: string
  command: string | null
  note: string
  risk: 'low' | 'medium' | 'high'
}
export interface UiRepairProposal {
  origin: 'bash' | 'test'
  command: string
  cwd: string
  report: UiFailureReport
  actions: UiRepairAction[]
}
export interface UiRepairRunResult {
  ok: boolean
  exitCode: number | null
  tail: string
  checkpointHash: string | null
  error?: string
}

// ===== s46 自动回归结果 =====
export interface UiAutoTestResult {
  ran: boolean
  reason?: string
  tests?: string[]
  ok?: boolean
  tail?: string
  durationMs?: number
}

// ===== s47 打包产物 =====
export interface UiBuildDone {
  ok: boolean
  code: number | null
  artifacts: string[]
  version: string
  durationMs: number
}

// s44 变更集三档分类：direct 需求直接相关 / incidental 顺带改动 / risky 高风险触碰
export type UiChangeClass = 'direct' | 'incidental' | 'risky'
export interface UiChangeVerdict {
  cls: UiChangeClass
  /** 中文原因（徽标 title 提示） */
  reason: string
}

// ---------- 规则 / 技能 / 笔记管理 ----------
/** 技能元信息（.trae/skills/<name>.md，frontmatter 存 enabled） */
export interface UiSkillMeta {
  name: string
  description: string
  enabled?: boolean
  /** 触发关键词（小写） */
  triggers?: string[]
  /** 是否为应用内置技能 */
  builtin?: boolean
  /** 技能文件绝对路径 */
  sourcePath?: string
}

/** 规则作用域：用户级 → 项目级 → 目录级，就近优先（同名高优先级覆盖） */
export type UiRuleScope = 'user' | 'project' | 'directory'

/** 规则元信息 */
export interface UiRuleMeta {
  name: string
  scope: UiRuleScope
  /** 规则文件绝对路径 */
  path: string
  /** 仅项目级支持启停；其余作用域恒为 true */
  enabled: boolean
  /** 内容预览（前 200 字符） */
  contentPreview: string
  /** 目录级专用：相对 workspace 的目录深度，越大越优先 */
  depth: number
}

/** Agent 持久化笔记（.trae/agent-notes.json 结构化视图） */
export interface UiAgentNote {
  projectStructure?: string
  commonErrors?: { error: string; fix: string; count: number; lastSeen?: string }[]
  userPreferences?: string
  lastTask?: string
  lastTaskResult?: string
  updatedAt?: string
}

/** 规则/技能操作统一返回 */
export interface UiRsResult {
  ok: boolean
  error?: string
}

// Git / 检查点 / 差异
export type UiGitChangeStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'untracked'
  | 'renamed'
  | 'unknown'

export interface UiGitChange {
  path: string
  status: UiGitChangeStatus
  staged: boolean
  oldPath?: string
  rawCode: string
}

export interface UiGitCheckpoint {
  hash: string
  shortHash: string
  author: string
  date: string
  subject: string
  isTrae: boolean
}

export interface UiFileDiff {
  path: string
  patch: string
  oldContent: string
  newContent: string
  deleted: boolean
}

export interface UiGitResult<T = unknown> {
  ok: boolean
  data?: T
  error?: string
}

// SCM 源代码管理面板
/** SCM 单条项：保留 porcelain XY 双字母，同文件可同现两组 */
export interface UiScmItem {
  path: string
  oldPath?: string
  /** 暂存区字母 X（' '=无） */
  indexLetter: string
  /** 工作区字母 Y（' '=无） */
  worktreeLetter: string
  rawCode: string
}

/** SCM 三分组 + 分支/HEAD 状态 */
export interface UiScmGrouped {
  currentBranch: string | null
  hasHead: boolean
  staged: UiScmItem[]
  unstaged: UiScmItem[]
  untracked: UiScmItem[]
}

/** 本地分支信息 */
export interface UiBranchInfo {
  name: string
  current: boolean
}

// ---------- 全局搜索/替换（ripgrep 引擎） ----------
/** 搜索参数：与主进程 RgSearchParams 镜像 */
export interface UiSearchParams {
  /** 查询串：字面量文本或正则源码（regexMode） */
  query: string
  /** 区分大小写（默认关 → rg -i） */
  caseSensitive?: boolean
  /** 全字匹配（rg -w） */
  wholeWord?: boolean
  /** 正则模式（默认关 → rg -F 字面量） */
  regexMode?: boolean
  /** 包含 glob */
  includes?: string[]
  /** 排除 glob */
  excludes?: string[]
}

/** 单处匹配（行号 + 去行尾预览；高亮由渲染端按查询正则做） */
export interface UiSearchMatch {
  /** 行号（1-based） */
  lineNumber: number
  preview: string
}

/** 搜索结果文件分组 */
export interface UiSearchFileGroup {
  /** 绝对路径 */
  path: string
  /** 匹配处数（submatch 口径） */
  matchCount: number
  matches: UiSearchMatch[]
}

/** 内容搜索结果 */
export interface UiSearchResult {
  groups: UiSearchFileGroup[]
  fileCount: number
  totalMatches: number
  /** 命中 5000 上限被截断 */
  truncated: boolean
  /** 耗时（毫秒） */
  elapsedMs: number
}

/** 单行替换变更（before/after 用于红绿着色） */
export interface UiReplaceChange {
  /** 行号（1-based） */
  lineNumber: number
  before: string
  after: string
}

/** 单文件替换计划 */
export interface UiReplaceFilePlan {
  /** 绝对路径 */
  path: string
  /** JS 正则口径匹配处数 */
  matchCount: number
  /** 发生变化的行（替换后相同的匹配计入 matchCount 但不在此列） */
  changes: UiReplaceChange[]
  /** 跳过时标注原因（文件过大等） */
  skipped?: 'too-large'
}

/** 替换预览结果 */
export interface UiReplacePreview {
  files: UiReplaceFilePlan[]
  totalFiles: number
  totalMatches: number
}

/** 应用替换时勾选的文件及复核基准 */
export interface UiApplyFileSelection {
  /** 文件绝对路径 */
  path: string
  /** 预览时刻匹配处数：落盘前重读复核，不等则跳过该文件 */
  expectedCount: number
}

/** 已替换文件 */
export interface UiReplacedFile {
  path: string
  /** 实际替换处数 */
  replacements: number
}

/** 应用替换时被跳过的文件及原因 */
export interface UiSkippedReplaceFile {
  path: string
  /** too-large 文件过大 / changed 复核不一致 / unreadable 读写失败 */
  reason: 'too-large' | 'changed' | 'unreadable'
}

/** 应用替换结果 */
export interface UiReplaceResult {
  applied: UiReplacedFile[]
  skipped: UiSkippedReplaceFile[]
}

/** 搜索/替换通道统一返回 */
export type UiSearchChannel<T> = { ok: true; data: T } | { ok: false; error: string }

// 终端会话事件（主进程 terminal.ts 推送）
export type TerminalEvent =
  | { kind: 'ready'; cwd: string; shellPid: number }
  | { kind: 'cmd'; source: 'user' | 'ai'; command: string }
  | { kind: 'data'; text: string }
  | { kind: 'exit'; code: number | null }
  | { kind: 'info'; text: string }

// 真 PTY 会话摘要（主进程 ptyManager 推送）
export interface UiPtyInfo {
  id: string
  /** shell 类别：pwsh/powershell/cmd/posix/fish */
  shell: string
  command: string
  alive: boolean
  exitCode: number | null
  /** 来源：user 用户手动新建；ai AI 交互命令启动 */
  origin: 'user' | 'ai'
}

/** 创建 PTY 会话参数 */
export interface UiPtyCreateInput {
  cwd?: string
  shell?: { kind: string; command: string; args: string[] }
  origin?: 'user' | 'ai'
  cols?: number
  rows?: number
}

/** 创建 PTY 会话结果 */
export type UiPtyCreateResult =
  | { ok: true; info: UiPtyInfo }
  | { ok: false; error: string }

/** PTY 输出事件载荷 */
export interface UiPtyDataPayload {
  id: string
  data: string
}

/** PTY 退出事件载荷 */
export interface UiPtyExitPayload {
  id: string
  code: number | null
}

// 终端命令失败诊断（主进程 commandError.ts）
export interface UiCommandDiagnostic {
  summary: string
  hints: string[]
  tail: string
  /** 处理分级：auto=AI 可自修，manual=需用户介入 */
  severity: 'auto' | 'manual'
}

// terminal.run 返回结构
export interface UiTerminalRunResult {
  ok: boolean
  output: string
  exitCode: number | null
  error?: string
  diagnostic?: UiCommandDiagnostic
}

// 后台任务快照（主进程 backgroundTasks.ts）
export interface UiTaskSnapshot {
  id: string
  command: string
  cwd: string
  pid: number
  status: 'running' | 'exited'
  exitCode: number | null
  startedAt: number
  endedAt: number | null
  bytes: number
}

export type BackgroundTaskEvent =
  | { kind: 'task-start'; task: UiTaskSnapshot }
  | { kind: 'task-data'; id: string; text: string }
  | { kind: 'task-exit'; id: string; exitCode: number | null }

// ---------- 调试 ----------
// 3.3 通用 DAP 配置（Python debugpy / Go dlv）
export type UiDapRuntime = 'debugpy' | 'dlv'
export type UiDapConfig =
  | {
      runtime: UiDapRuntime
      request: 'launch'
      /** 入口脚本（Python: .py；Go: 程序目录或 main.go） */
      program: string
      args?: string[]
      cwd?: string
      env?: Record<string, string | null>
      /** debugpy 默认 5678；dlv 默认 2345 */
      port?: number
    }
  | {
      runtime: UiDapRuntime
      request: 'attach'
      port: number
      host?: string
    }

export type UiDebugState = 'idle' | 'connecting' | 'initialized' | 'running' | 'stopped' | 'terminated'
export interface UiDebugSnapshot {
  state: UiDebugState
  kind: 'launch' | 'attach' | null
  entry?: string
  port?: number
  pid?: number
}
export interface UiDebugStackFrame { id: string; name: string; file: string; line: number; column: number }
export interface UiDebugScope { name: string; variablesReference: string | number }
export interface UiDebugVariable { name: string; value: string; type?: string; variablesReference: string | number }
export type UiDebugEvent =
  | { kind: 'state'; state: UiDebugState }
  | { kind: 'output'; text: string; source: 'stdout' | 'stderr' }
  | { kind: 'stopped'; stack: UiDebugStackFrame[]; scopes: UiDebugScope[]; variables: UiDebugVariable[] }
  | { kind: 'terminated'; exitCode: number | null }
  // s52 异常停驻：携带异常描述与堆栈/变量，供 AI 自动修复对话注入
  | {
      kind: 'exception'
      description: string
      stack: UiDebugStackFrame[]
      scopes: UiDebugScope[]
      variables: UiDebugVariable[]
    }

export type UiTaskTailResult =
  | {
      ok: true
      text: string
      base: number
      next: number
      status: UiTaskSnapshot['status']
      exitCode: number | null
      truncated: boolean
    }
  | { ok: false; error: string }

// ---------- 验证锁（manifest 编辑与手动触发） ----------
/** 验证规则种类：四类预置 + 自定义回调 */
export type UiValidationKind = 'fileExists' | 'contentMatch' | 'commandExecuted' | 'custom'
/** 严重级别：block 阻止收尾，warn 仅记录不阻止 */
export type UiSeverity = 'block' | 'warn'
/**
 * 验证规则（渲染端可编辑视图）。
 * 注意：command/pattern 一律为 string（RegExp 无法跨 IPC 序列化），
 * runRule 对 string command 走子串匹配、对 string pattern 走字符串包含。
 * custom kind 的 check 回调无法跨 IPC，前端编辑器不支持新建 custom 规则。
 */
export interface UiValidationRule {
  id: string
  description: string
  kind: UiValidationKind
  severity?: UiSeverity
  /** fileExists / contentMatch：相对工作区路径或后缀匹配模式 */
  path?: string
  /** contentMatch：内容正则或字符串（前端编辑用 string） */
  pattern?: string
  /** commandExecuted：命令文本（前端编辑用 string 子串匹配） */
  command?: string
}
/** 产物清单：一组规则的容器 */
export interface UiArtifactManifest {
  id: string
  rules: UiValidationRule[]
}
/** 验证 ctx 快照（Set/Map 序列化为数组/对象，供前端展示与跨 IPC 传递） */
export interface UiValidationCtxSnap {
  createdFiles: string[]
  executedCommands: Record<string, string>
  workspace?: string
}
/** 单条验证结果 */
export interface UiValidationResult {
  ruleId: string
  passed: boolean
  message: string
  severity: UiSeverity
}
/** 聚合结果 */
export interface UiValidationSummary {
  allPassed: boolean
  /** 仅未通过项（按声明顺序） */
  failed: UiValidationResult[]
  /** 给模型的强制继续消息；allPassed 时为 null */
  message: string | null
  /** manifest id（用于 format 时识别 vueScaffold 等预置模板） */
  manifestId: string | null
}
/** getCurrent 返回结构：当前会话的 manifest + ctx 快照 */
export interface UiValidationCurrentState {
  manifest: UiArtifactManifest | null
  ctx: UiValidationCtxSnap | null
}

declare global {
  interface Window {
    api: {
      platform: string
      fs: {
        selectWorkspace: () => Promise<string | null>
        isDirectory: (path: string) => Promise<boolean>
        saveDialog: (defaultName?: string) => Promise<{ ok: boolean; path?: string; canceled?: boolean }>
        readDirTree: (root: string) => Promise<unknown>
        readFile: (path: string) => Promise<string>
        writeFile: (path: string, content: string) => Promise<boolean>
        createFile: (parentDir: string, relName: string) => Promise<{ ok: boolean; path?: string; error?: string }>
        createDirectory: (parentDir: string, relName: string) => Promise<{ ok: boolean; path?: string; error?: string }>
        rename: (oldPath: string, newName: string) => Promise<{ ok: boolean; path?: string; error?: string }>
        trash: (path: string) => Promise<{ ok: boolean; error?: string }>
        showItem: (path: string) => Promise<boolean>
        move: (root: string, srcPath: string, destDir: string) => Promise<{ ok: boolean; path?: string; error?: string }>
      }
      lsp: {
        detectVue: (root: string) => Promise<boolean>
        start: (kind: 'ts' | 'vue') => Promise<{ ok: boolean; already?: boolean; tsdk?: string; error?: string }>
        write: (kind: 'ts' | 'vue', msg: string) => void
        onMessage: (cb: (kind: 'ts' | 'vue', msg: string) => void) => void
        stop: (kind: 'ts' | 'vue') => Promise<{ ok: boolean }>
      }
      mcp: {
        listTools: () => Promise<{ server: string; tools: unknown[] }[]>
        callTool: (server: string, name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; result?: unknown; error?: string }>
        setWorkspaceRoot: (root: string) => Promise<{ ok: boolean; error?: string }>
        // MCP 服务器管理
        listServers: () => Promise<UiMcpServerInfo[]>
        addServer: (name: string, config: UiMcpServerConfigInput) => Promise<UiMcpSaveResult>
        updateServer: (name: string, config: UiMcpServerConfigInput) => Promise<UiMcpSaveResult>
        removeServer: (name: string) => Promise<{ ok: boolean; error?: string }>
        toggleServer: (name: string, enabled: boolean) => Promise<UiMcpSaveResult>
        restartServer: (name: string) => Promise<UiMcpSaveResult>
      }
      // 规则管理（用户级 / 项目级 / 目录级三层）
      rules: {
        list: (workspace?: string | null, currentDir?: string | null) => Promise<UiRuleMeta[]>
        read: (workspace: string | null, path: string) => Promise<UiRsResult & { data?: string }>
        write: (
          workspace: string | null,
          scope: UiRuleScope,
          name: string,
          content: string,
          dirPath?: string | null
        ) => Promise<UiRsResult & { data?: string }>
        delete: (workspace: string | null, path: string) => Promise<UiRsResult>
        toggle: (workspace: string | null, name: string, enabled: boolean) => Promise<UiRsResult>
      }
      // 技能管理（.trae/skills/*.md，frontmatter 存 enabled）
      skills: {
        list: (workspace?: string | null) => Promise<UiSkillMeta[]>
        read: (workspace: string | null, name: string) => Promise<UiRsResult & { data?: string }>
        write: (
          workspace: string | null,
          name: string,
          description: string,
          enabled: boolean,
          content: string
        ) => Promise<UiRsResult>
        delete: (workspace: string | null, name: string) => Promise<UiRsResult>
        toggle: (workspace: string | null, name: string, enabled: boolean) => Promise<UiRsResult>
      }
      // 笔记管理（agent-notes.json 只读查看 + 清空备份）
      notes: {
        load: (workspace?: string | null) => Promise<UiAgentNote | null>
        clear: (workspace: string | null) => Promise<UiRsResult>
      }
      // Git / 检查点 / 差异
      git: {
        isRepo: (root: string) => Promise<boolean>
        init: (root: string) => Promise<UiGitResult>
        status: (root: string) => Promise<UiGitResult<UiGitChange[]>>
        diffFile: (root: string, change: UiGitChange) => Promise<UiGitResult<UiFileDiff>>
        checkpointCreate: (
          root: string,
          label: string
        ) => Promise<UiGitResult<{ created: boolean; hash?: string; reason?: string }>>
        checkpointList: (root: string) => Promise<UiGitResult<UiGitCheckpoint[]>>
        checkpointRestore: (root: string, hash: string) => Promise<UiGitResult>
        fileRestore: (root: string, change: UiGitChange) => Promise<UiGitResult>
        // SCM 源代码管理面板
        statusGrouped: (root: string) => Promise<UiGitResult<UiScmGrouped>>
        stage: (root: string, paths: string[]) => Promise<UiGitResult>
        unstage: (root: string, paths: string[]) => Promise<UiGitResult>
        commit: (
          root: string,
          message: string
        ) => Promise<UiGitResult<{ hash: string }>>
        branchList: (root: string) => Promise<UiGitResult<UiBranchInfo[]>>
        checkoutBranch: (root: string, name: string) => Promise<UiGitResult>
        createBranch: (root: string, name: string) => Promise<UiGitResult>
      }
      // 全局搜索/替换（ripgrep 引擎 + 可预览批量替换）
      search: {
        query: (root: string, params: UiSearchParams) => Promise<UiSearchChannel<UiSearchResult>>
        replacePreview: (
          root: string,
          params: UiSearchParams & { replaceText: string }
        ) => Promise<UiSearchChannel<UiReplacePreview>>
        replaceApply: (
          root: string,
          params: UiSearchParams & {
            replaceText: string
            selections: UiApplyFileSelection[]
          }
        ) => Promise<UiSearchChannel<UiReplaceResult>>
      }
      // 持久终端（用户手动输入与 AI 工具调用共用同一 shell）
      terminal: {
        start: (cwd?: string) => Promise<{ ok: boolean; cwd: string }>
        run: (command: string) => Promise<UiTerminalRunResult>
        cwd: () => Promise<string>
        onEvent: (cb: (ev: TerminalEvent) => void) => void
        // 后台任务（长驻命令并行运行，不占终端队列）
        taskStart: (
          command: string,
          cwd?: string
        ) => Promise<{ ok: true; id: string } | { ok: false; error: string }>
        taskList: () => Promise<UiTaskSnapshot[]>
        taskKill: (id: string) => Promise<{ ok: boolean; error?: string }>
        taskTail: (id: string, offset?: number) => Promise<UiTaskTailResult>
        onTaskEvent: (cb: (ev: BackgroundTaskEvent) => void) => void
        // 真 PTY 终端（多会话 + xterm.js）
        ptyCreate: (input?: UiPtyCreateInput) => Promise<UiPtyCreateResult>
        ptyWrite: (id: string, data: string) => Promise<boolean>
        ptyResize: (id: string, cols: number, rows: number) => Promise<boolean>
        ptyKill: (id: string) => Promise<boolean>
        ptyList: () => Promise<UiPtyInfo[]>
        onPtyData: (cb: (payload: UiPtyDataPayload) => void) => void
        onPtyExit: (cb: (payload: UiPtyExitPayload) => void) => void
        /** s45 修复提案事件：命令失败且有可执行修复动作时推送 */
        onRepairProposals: (cb: (p: UiRepairProposal) => void) => void
      }
      // s45 修复动作执行/回滚（确认卡片后调用）
      repair: {
        run: (workspace: string, command: string) => Promise<UiRepairRunResult>
        rollback: (workspace: string, hash: string) => Promise<{ ok: boolean; error?: string }>
      }
      // s46 改动落盘后的自动回归结果事件
  test: {
    onAutoRun: (cb: (r: UiAutoTestResult) => void) => void
  }
  // s47 一键打包流水线
  build: {
    start: (mode: 'dir' | 'dist') => Promise<{ ok: boolean; error?: string }>
    status: () => Promise<{ running: boolean }>
    openRelease: () => Promise<{ ok: boolean; error?: string }>
    onLog: (cb: (p: { text: string }) => void) => void
    onDone: (cb: (r: UiBuildDone) => void) => void
  }
      // Ollama 健康检测（聊天走统一调度层）
      ollama: {
        health: () => Promise<{ ok: boolean; version?: string; error?: string }>
      }
      // 调试（Node.js，CDP）
      debug: {
        start: (
          cfg: { kind: 'launch'; entry: string; port?: number } | { kind: 'attach'; port: number; host?: string }
        ) => Promise<{ ok: boolean; error?: string }>
        stop: () => Promise<{ ok: boolean }>
        setBreakpoints: (file: string, lines: number[]) => Promise<{ ok: boolean; error?: string }>
        control: (action: 'continue' | 'next' | 'stepIn' | 'stepOut' | 'pause') => Promise<{ ok: boolean; error?: string }>
        state: () => Promise<UiDebugSnapshot>
        onEvent: (cb: (ev: UiDebugEvent) => void) => void
      }
      // 3.3 通用 DAP（Python debugpy / Go dlv；事件复用 debug:event 通道）
      dap: {
        start: (cfg: UiDapConfig) => Promise<{ ok: boolean; error?: string }>
        stop: () => Promise<{ ok: boolean }>
        setBreakpoints: (file: string, lines: number[]) => Promise<{ ok: boolean; error?: string }>
        control: (action: 'continue' | 'next' | 'stepIn' | 'stepOut' | 'pause') => Promise<{ ok: boolean; error?: string }>
        state: () => Promise<unknown>
        evaluate: (expression: string) => Promise<{ ok: boolean; result?: string; error?: string }>
      }
      // 验证锁（manifest 编辑与手动触发）
      validation: {
        runRule: (
          rule: UiValidationRule,
          ctx?: UiValidationCtxSnap | null
        ) => Promise<UiValidationResult>
        runValidation: (
          manifest: UiArtifactManifest | null,
          ctx?: UiValidationCtxSnap | null
        ) => Promise<UiValidationSummary>
        parseManifest: (raw: unknown) => Promise<UiArtifactManifest | null>
        formatMessage: (
          summary: UiValidationSummary,
          ctx?: UiValidationCtxSnap | null
        ) => Promise<string | null>
        getCurrent: () => Promise<UiValidationCurrentState>
        setCurrent: (manifest: UiArtifactManifest | null) => Promise<{ ok: boolean }>
      }
      // 插件系统
      plugin: {
        list: () => Promise<Array<{
          id: string
          name: string
          version: string
          description?: string
          author?: string
          enabled: boolean
          providerCount: number
          mcpServerCount: number
          commandCount: number
          dir: string
        }>>
        setEnabled: (pluginId: string, enabled: boolean) => Promise<{ ok: boolean; error?: string }>
        getMcpServers: () => Promise<Record<string, unknown>>
        getCommands: () => Promise<Array<{
          pluginId: string
          pluginName: string
          id: string
          title: string
          keybinding?: string
          icon?: string
        }>>
        reload: () => Promise<{ ok: boolean; error?: string }>
      }
      // 自动更新（electron-updater）
      updater: {
        getStatus: () => Promise<{ version: string; isPackaged: boolean }>
        check: () => Promise<{ ok: boolean; message?: string }>
        download: () => Promise<{ ok: boolean; message?: string }>
        install: () => Promise<{ ok: boolean }>
        onChecking: (cb: () => void) => void
        onAvailable: (cb: (info: { version: string; releaseNotes?: unknown }) => void) => void
        onNotAvailable: (cb: (info: { version: string }) => void) => void
        onDownloading: (cb: (p: { percent: number; bytesPerSecond: number; total: number; transferred: number }) => void) => void
        onDownloaded: (cb: (info: { version: string }) => void) => void
        onError: (cb: (e: { message: string }) => void) => void
      }
      theme: {
        apply: (theme: 'light' | 'dark' | 'blue') => void
      }
      // AI 统一调度层（多供应商 / 自动路由 / 超时回退 / 上下文工程）
      ai: {
        listProviders: () => Promise<UiProviderEntry[]>
        listModels: () => Promise<UiModelEntry[]>
        refreshModels: () => Promise<UiModelEntry[]>
        setProviderEnabled: (providerId: string, enabled: boolean) => Promise<boolean>
        getProviderSettings: () => Promise<UiProviderSettingEntry[]>
        setProviderKey: (providerId: string, key: string) => Promise<{ ok: boolean; error?: string }>
        addCustomProvider: (def: { name: string; baseUrl: string }) => Promise<{ ok: boolean; provider?: { id: string; name: string; baseUrl: string }; error?: string }>
        removeCustomProvider: (providerId: string) => Promise<{ ok: boolean; error?: string }>
        testProvider: (providerId: string) => Promise<{ ok: boolean; version?: string; error?: string }>
        getUsageStats: () => Promise<UiUsageStats>
        resetUsageStats: () => Promise<boolean>
        chatStream: (params: UiChatParams) => Promise<{ ok: boolean; error?: string }>
        chatWithTools: (params: UiChatParams) => Promise<{ ok: boolean; content?: string; error?: string; model?: string; blocked?: boolean }>
        // 停止当前 AI 任务（主循环 + 子代理级联中止）
        stopChat: () => Promise<{ ok: boolean; stopped?: boolean }>
        // ---- ㊜ 断点续跑 ----
        listRecoverableTasks: (workspace: string) => Promise<UiRecoverableTask[]>
        resumeTask: (workspace: string, taskId: string) => Promise<{
          ok: boolean
          content?: string
          error?: string
          model?: string
          blocked?: boolean
        }>
        abandonTask: (
          workspace: string,
          taskId: string,
          rollback: boolean
        ) => Promise<{ ok: boolean; error?: string }>
        // ---- ㊜ 1b 运行门：暂停 / 进程内继续 / 放弃（放弃时可选回滚）----
        pauseTask: () => Promise<{ ok: boolean; phase: string }>
        resumePausedTask: () => Promise<{ ok: boolean; phase: string }>
        abortRunningTask: (
          workspace: string | null,
          taskId: string,
          rollback: boolean
        ) => Promise<{ ok: boolean; error?: string }>
        // s48 从此步重跑：按步骤所属轮次恢复任务
        rerunFromStep: (
          workspace: string,
          taskId: string,
          round: number
        ) => Promise<{ ok: boolean; content?: string; error?: string }>
        // s49 单卡片回滚：中止运行并恢复任务前检查点（保留快照）
        rollbackCard: (
          workspace: string,
          taskId: string
        ) => Promise<{ ok: boolean; error?: string }>
        // s50 按看板卡片分派角色 Agent（并行执行 + 写锁 + 汇总裁决）
        dispatchFromCards: (
          workspace: string,
          cards: Array<{ sid: string; title: string; role?: string }>
        ) => Promise<{ ok: boolean; report?: string; error?: string }>
        // ---- 内联 AI（Tab 补全 / Cmd+K 改写）----
        // 与 ai:chatStream 隔离的事件通道：所有事件 payload 携带 requestId 供过滤
        inlineStream: (params: {
          requestId: string
          model?: string
          messages: { role: string; content: string; name?: string }[]
          taskType?: 'reasoning' | 'completion' | 'chat' | 'tool'
          currentFile?: string | null
          workspace?: string | null
          timeoutMs?: number
        }) => Promise<{ ok: boolean; error?: string }>
        stopInline: () => Promise<{ ok: boolean }>
        onInlineChunk: (cb: (p: { requestId: string; delta: string }) => void) => () => void
        onInlineDone: (cb: (p: { requestId: string; model: string }) => void) => () => void
        onInlineError: (cb: (p: { requestId: string; err: string }) => void) => () => void
        onInlineFallback: (
          cb: (p: { requestId: string; from: string; to: string; reason: string }) => void
        ) => () => void
        // 代码库持久化索引与检索
        // 模型可见工具清单（内置 + 已连接 MCP）
        listTools: () => Promise<Array<{ server: string; name: string; description: string }>>
        indexStatus: (root: string) => Promise<UiIndexStatus>
        ensureIndex: (root: string, force?: boolean) => Promise<UiIndexDelta>
        searchIndex: (params: { root: string; query: string; limit?: number }) => Promise<UiSearchHit[]>
        getContext: (params: {
          root: string
          query: string
          currentFile?: string | null
          maxChars?: number
        }) => Promise<string>
        // 持久化笔记（跨会话知识记忆）
        loadNotes: (workspace: string) => Promise<any>
        saveNotes: (workspace: string, note: any) => Promise<boolean>
        // 聊天会话持久化（多会话；workspace=null 走无工作区分区）
        listSessions: (workspace: string | null) => Promise<UiSessionMeta[]>
        loadSession: (workspace: string | null, id: string) => Promise<UiSessionData | null>
        saveSession: (
          workspace: string | null,
          data: { id?: string; title?: string; createdAt?: number; messages: UiSessionMessage[] }
        ) => Promise<{ ok: boolean; id: string | null }>
        deleteSession: (workspace: string | null, id: string) => Promise<{ ok: boolean }>
        sessionToMarkdown: (workspace: string | null, id: string) => Promise<string>
        // 2.3 图片附件
        saveAttachment: (input: { workspace: string; mimeType: string; data: string }) =>
          Promise<{ ok: boolean; path?: string; error?: string }>
        readAttachment: (path: string, workspace?: string) =>
          Promise<{ ok: boolean; dataUrl?: string; error?: string }>
        listTraces: () => Promise<Array<{
          file: string
          taskId: string
          startTime: string
          model: string
          status: 'running' | 'completed' | 'aborted' | 'error'
          rounds: number
        }>>
        loadTrace: (file: string) => Promise<any>
        onChatChunk: (cb: (chunk: string) => void) => void
        onChatDone: (cb: (info: { model: string }) => void) => void
        onChatError: (cb: (err: string) => void) => void
        onChatFallback: (cb: (p: { from: string; to: string; reason: string }) => void) => void
        onToolCall: (cb: (p: { name: string; args: Record<string, unknown> }) => void) => void
        onToolResult: (cb: (p: { name: string; result: string }) => void) => void
        onModelCall: (cb: (p: { model: string; phase: string }) => void) => void
        onTodoUpdate: (cb: (todos: UiTodoItem[]) => void) => void
        onSubagentUpdate: (cb: (p: UiSubagentUpdate) => void) => void
        // 任务收尾：计划-执行偏差报告（仅当前会话实时有效）
        onPlanDrift: (cb: (report: UiDriftReport) => void) => void
        // ㊜ 1b 运行门相位事件
        onTaskControl: (cb: (payload: UiTaskControl) => void) => void
        // s48 执行时间线广播
        onTimelineUpdate: (cb: (payload: UiTimelinePayload) => void) => void
        // ---- 工具权限模式与审批 ----
        getPermissionMode: () => Promise<UiPermissionMode>
        setPermissionMode: (mode: UiPermissionMode) => Promise<boolean>
        onPermissionRequest: (cb: (req: UiPermissionRequest) => void) => void
        respondPermission: (id: string, response: UiPermissionResponse) => Promise<boolean>
        // ㊝ bash 批量接受门弹层（应答走 api.staging.bashAcceptResponse）
        onBashAcceptRequest: (cb: (payload: UiBashAcceptRequest) => void) => void
      }
      // ㊝ 变更事务暂存
      staging: {
        /** 返回 {enabled, summary} 包络：开关态与摘要同源，避免两次 IPC 漂移 */
        get: (workspace: string) => Promise<{ enabled: boolean; summary: UiStageSummary }>
        diff: (workspace: string, path: string) => Promise<UiStageDiff>
        /** s44 三档分类（需求/顺带/高风险），键为暂存原始路径 */
        classify: (workspace: string) => Promise<Record<string, UiChangeVerdict>>
        accept: (
          workspace: string,
          paths: string[] | 'all',
          hunkIds?: Record<string, string[]>
        ) => Promise<{ ok: boolean; applied?: number; partial?: boolean; error?: string }>
        reject: (
          workspace: string,
          paths: string[] | 'all',
          hunkIds?: Record<string, string[]>
        ) => Promise<{ ok: boolean; dropped?: number; error?: string }>
        getEnabled: (workspace: string) => Promise<boolean>
        setEnabled: (workspace: string, enabled: boolean) => Promise<boolean>
        bashAcceptResponse: (
          workspace: string,
          id: string,
          decision: 'accept' | 'reject'
        ) => Promise<{ ok: boolean; released: boolean }>
        onChanged: (cb: () => void) => void
      }
      // s49 卡片式任务看板持久化
      kanban: {
        get: (workspace: string) => Promise<import('../../shared/kanban/kanban').KanbanState>
        save: (
          workspace: string,
          cards: import('../../shared/kanban/kanban').KanbanState
        ) => Promise<{ ok: boolean; error?: string }>
        reset: (workspace: string) => Promise<{ ok: boolean; error?: string }>
      }
      // s54–s56 学术/报告链路
      scholar: {
        renderChart: (
          workspace: string,
          dataFile: string,
          spec: import('../../shared/scholar/svgChart').ChartSpec
        ) => Promise<{
          ok: boolean
          path?: string
          relPath?: string
          rowCount?: number
          columns?: string[]
          error?: string
        }>
        saveChart: (
          workspace: string,
          title: string,
          svg: string
        ) => Promise<{ ok: boolean; path?: string; relPath?: string; error?: string }>
        exportReport: (
          workspace: string,
          input: import('../../shared/scholar/report').ReportInput,
          format: import('../../shared/scholar/report').ReportFormat
        ) => Promise<{ ok: boolean; path?: string; relPath?: string; error?: string }>
        readBib: (workspace: string) => Promise<{
          ok: boolean
          entries?: import('../../shared/scholar/bibtex').BibEntry[]
          text?: string
          error?: string
        }>
        saveBib: (
          workspace: string,
          entries: import('../../shared/scholar/bibtex').BibEntry[]
        ) => Promise<{ ok: boolean; path?: string; count?: number; error?: string }>
      }
      // 3.1 内置浏览器预览
      preview: {
        open: (
          url: string,
          bounds: { x: number; y: number; width: number; height: number }
        ) => Promise<{ ok: boolean; error?: string }>
        setBounds: (bounds: { x: number; y: number; width: number; height: number }) => Promise<{ ok: boolean }>
        hide: () => Promise<{ ok: boolean }>
        control: (
          action: 'reload' | 'back' | 'forward' | 'openDevTools' | 'stop' | 'close'
        ) => Promise<{ ok: boolean; error?: string }>
        probeDevServer: (ports?: number[]) => Promise<{ ok: boolean; url?: string }>
        isOpen: () => Promise<{ ok: boolean; open: boolean; url: string | null }>
        close: () => Promise<{ ok: boolean }>
        onNavigated: (cb: (url: string) => void) => void
        onLoading: (cb: (loading: boolean) => void) => void
        onLoadError: (cb: (error: string) => void) => void
        enterPickMode: () => Promise<{ ok: boolean; error?: string }>
        exitPickMode: () => Promise<{ ok: boolean }>
        captureElement: (bounds: { x: number; y: number; width: number; height: number }) => Promise<{ ok: boolean; dataUrl?: string; error?: string }>
        onPicked: (cb: (data: { selector: string; outerHTML: string; bounds: { x: number; y: number; width: number; height: number }; tagName: string; text: string }) => void) => void
      }
    }
  }
}

export {}
