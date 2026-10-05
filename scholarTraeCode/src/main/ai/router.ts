// 任务分类器：
// classify() —— 用规则引擎判断请求属于哪种 TaskType（推理/补全/对话/工具）。
// 阶段三说明：原 route() 已删除（阶段二路由统一由 AdaptiveScheduler + ModelRegistry 接管）。
// 本文件仅保留任务分类职责；模型路由不再发生在这里。
import type { TaskType, AiMessage } from './types'

// 用户显式指定任务类型的前缀指令，命中后从消息内容中剥离
const PREFIX_DIRECTIVES: { re: RegExp; task: TaskType }[] = [
  { re: /^@reason(ing)?\b/i, task: 'reasoning' },
  { re: /^@fast\b/i, task: 'completion' },
  { re: /^@chat\b/i, task: 'chat' },
  { re: /^@tool\b/i, task: 'tool' }
]

// 中文/英文「需要深度思考」的关键词 → 推理任务
const REASONING_KEYWORDS =
  /(分析|推理|设计|架构|方案|优化|解释|为什么|原理|比较|评估|排查|诊断|debug|反思|review|重构|算法|性能瓶颈)/i

// 模糊/意图不明指令（帮我看看、怎么做、这个怎么回事…）→ 先用解释型模型分析意图
const VAGUE_INTENT = /^(帮我|帮忙|如何|怎么|怎样|怎么办|想想|看一下|看看|这个|为啥|为啥|能否)/

// 终端/命令行操作关键词 → 补全任务（交给代码专精模型）
const TERMINAL_KEYWORDS =
  /(终端|命令行|控制台|执行命令|运行命令|shell|bash|powershell|cmd|npm|pnpm|yarn|git|pip|docker)/i

// 「快速代码操作」关键词 → 补全任务
const COMPLETION_KEYWORDS = /(补全|生成|写一段|实现|翻译|格式化|添加|修正|fix|generate|complete|注释)/i

/** 代码类文件扩展名（命中 → 默认走 completion，便于模型快速响应） */
const CODE_EXT = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'vue', 'html', 'css', 'scss', 'less',
  'py', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs', 'php', 'rb', 'kt', 'swift',
  'sql', 'sh', 'bash', 'zsh', 'yml', 'yaml', 'toml', 'ini', 'xml', 'md', 'proto', 'tf'
])

function lastUserMessage(messages: AiMessage[]): AiMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i]
  }
  return undefined
}

/**
 * 分类任务类型。
 * 优先级：用户前缀指令 > 显式参数 > 关键词 > 文件类型 > 默认 chat
 */
export function classify(
  messages: AiMessage[],
  opts: { currentFile?: string | null; hint?: TaskType }
): { task: TaskType; strippedMessages: AiMessage[] } {
  // 1) 用户前缀指令（同时从内容中剥离，避免污染模型输入）
  const stripped = messages.map((m) => ({ ...m }))
  const lastUser = lastUserMessage(stripped)
  if (lastUser) {
    for (const { re, task } of PREFIX_DIRECTIVES) {
      if (re.test(lastUser.content)) {
        lastUser.content = lastUser.content.replace(re, '').trim()
        return { task, strippedMessages: stripped }
      }
    }
  }

  // 2) 显式 hint
  if (opts.hint) return { task: opts.hint, strippedMessages: stripped }

  const text = lastUser?.content ?? ''
  const lower = text.toLowerCase()

  // 3) 模糊意图：指令不含明确动作目标时，先由解释型模型分析/澄清需求
  if (VAGUE_INTENT.test(text.trim())) return { task: 'reasoning', strippedMessages: stripped }

  // 4) 深度推理关键词
  if (REASONING_KEYWORDS.test(text)) return { task: 'reasoning', strippedMessages: stripped }

  // 5) 终端/命令行操作 → 代码专精模型
  if (TERMINAL_KEYWORDS.test(text)) return { task: 'completion', strippedMessages: stripped }

  // 6) 快速代码操作关键词
  if (COMPLETION_KEYWORDS.test(text)) return { task: 'completion', strippedMessages: stripped }

  // 7) 文件类型：打开代码文件时，默认按 completion 处理（快速补全/修改）
  if (opts.currentFile) {
    const ext = opts.currentFile.split('.').pop()?.toLowerCase()
    if (ext && CODE_EXT.has(ext)) return { task: 'completion', strippedMessages: stripped }
  }

  // 8) 长消息（>300 字符）更可能是需要理解的需求 → reasoning
  if (lower.length > 300) return { task: 'reasoning', strippedMessages: stripped }

  return { task: 'chat', strippedMessages: stripped }
}
