// AI 调度层核心类型定义：把「模型供应商 / 模型 / 任务类型 / 消息」抽象为统一契约。
// 业务逻辑只依赖本文件的接口，不直接耦合 Ollama，新增供应商只需实现 AiProvider。

/**
 * 多模态消息片段（2.3 图片输入）：
 * - text：文本片段
 * - image：图片片段，data（base64，不含 data: 前缀）与 path（盘上附件路径）至少有一个
 */
export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data?: string; path?: string }

/** 单条对话消息 */
export interface AiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /**
   * 2.3 多模态片段（通常仅 user 消息）：存在且非空时优先于 content，
   * 由各 provider 转换为自家多模态协议；纯文本消息缺省。
   */
  parts?: MessagePart[]
  /** tool 消息所属工具名（assistant 发起 tool_call 时可选） */
  name?: string
  /** 预留：工具调用参数（渲染端通常不直接使用，由 provider 透传） */
  toolCalls?: unknown[]
}

/** 流式回调：provider 在生成过程中按 token/片段推送 */
export interface AiStreamCallbacks {
  onChunk: (delta: string) => void
  onDone: (info: { model: string }) => void
  onError: (err: string) => void
  /** 中途切换到备选模型时触发，用于 UI 提示「已回退到 xxx」 */
  onFallback?: (from: string, to: string, reason: string) => void
  /** usage 上报：provider 拿到 token 统计时回调（供用量统计记账，缺失则上层按字符数估算） */
  onUsage?: (usage: { tokensIn?: number; tokensOut?: number }) => void
}

/** 模型能力标签（用于路由匹配） */
export interface ModelCapabilities {
  /** 强推理（复杂设计/多步推理/数学） */
  reasoning: boolean
  /** 代码专精（补全/重构/解释代码） */
  code: boolean
  /** 响应速度（快=补全，慢=深度思考） */
  speed: 'fast' | 'balanced' | 'slow'
  /** 上下文窗口（token，用于上下文工程预算） */
  contextWindow: number
  /** 2.3 视觉能力：能否接收图片输入（粘贴/截图/附件） */
  vision: boolean
  /** 相对成本等级（0=最低，值越大越贵，影响默认回退顺序） */
  costTier: number
}

/** 单个模型的注册信息（跨供应商统一视图） */
export interface ModelEntry {
  /** 全局唯一 id：`providerId:modelName`，例如 `ollama:qwen3:14b` */
  id: string
  providerId: string
  /** 模型原名（供应商内的名称） */
  name: string
  /** 展示名（不带 provider 前缀） */
  displayName: string
  capabilities: ModelCapabilities
  /** 是否可用（provider health 探测结果） */
  available: boolean
}

/** 任务分类：决定路由到哪类模型 */
export type TaskType = 'reasoning' | 'completion' | 'chat' | 'tool'

/** 调度请求 */
export interface SchedulerChatParams {
  messages: AiMessage[]
  /** 显式指定模型 id（覆盖自动路由）；传 'auto' 或不传则走路由 */
  model?: string
  /** 显式指定任务类型；不传则由分类器推断 */
  taskType?: TaskType
  /** 当前打开的文件（用于分类器按扩展名判断 + 上下文选取） */
  currentFile?: string | null
  /** 工作区根目录（用于上下文工程） */
  workspace?: string | null
  /** 是否启用 MCP 工具调用 */
  useTools?: boolean
  /** 超时（毫秒），超过则触发回退；默认 30s */
  timeoutMs?: number
}

/** 统一模型供应商接口：任何新模型供应商都实现此接口 */
export interface AiProvider {
  /** 供应商唯一 id，例如 'ollama' / 'openai' / 'anthropic' */
  readonly id: string
  readonly displayName: string

  /** 探测供应商是否可用（如本地 Ollama 是否运行、API key 是否有效） */
  health(): Promise<{ ok: boolean; version?: string; error?: string }>

  /** 列出该供应商下可用的模型及其能力标签 */
  listModels(): Promise<ModelEntry[]>

  /** 非流式聊天（用于工具调用判断、短回复）；signal 触发时底层请求须真实中止 */
  chat(params: {
    model: string
    messages: AiMessage[]
    tools?: unknown[]
    /** 取消信号：abort 后返回 { ok:false, error:'已中止' } 且底层 HTTP 请求被真正断开 */
    signal?: AbortSignal
  }): Promise<{
    ok: boolean
    content?: string
    toolCalls?: unknown[]
    /** token 统计（provider 能拿到时带回，供用量统计） */
    usage?: { tokensIn?: number; tokensOut?: number }
    error?: string
  }>

  /** 流式聊天；provider 通过 callbacks 推送结果，返回最终是否成功；signal 语义同 chat */
  chatStream(
    params: { model: string; messages: AiMessage[]; signal?: AbortSignal },
    callbacks: AiStreamCallbacks
  ): Promise<{ ok: boolean; error?: string }>

  /** 终止正在进行的请求（可选实现，用于用户取消） */
  abort?(): void
}

/** 判断是否为中止产生的错误（AbortError / 库文案），统一返回「已中止」 */
export function isAbortError(err: unknown): boolean {
  const anyErr = err as { name?: string; message?: string } | null | undefined
  if (anyErr?.name === 'AbortError') return true
  const msg = (anyErr?.message ?? String(err)).toLowerCase()
  return msg.includes('abort') || msg.includes('已中止')
}
