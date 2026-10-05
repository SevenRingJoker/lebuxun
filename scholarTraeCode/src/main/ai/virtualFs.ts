// 虚拟工作区：路径劫持 + 按角色定制 S1 环境层。
// 纯函数零 IO，调用方负责传入 workspace 与 targetDir。

import { resolve, isAbsolute, normalize, sep } from 'node:path'

/**
 * 路径劫持：把 AI 传入的路径解析为工作区内的安全绝对路径。
 * - 绝对路径：必须在 workspace 内，否则返回 ok:false
 * - 相对路径：若 targetDir 存在则解析到 workspace/targetDir 下，否则解析到 workspace 下
 * - '..' 上跳后越出 workspace → ok:false
 */
export function resolveVfsPath(
  rawPath: string,
  workspace: string,
  targetDir?: string | null
): { ok: true; absPath: string } | { ok: false; error: string } {
  const trimmed = (rawPath ?? '').trim()
  if (!trimmed) return { ok: false, error: '路径为空' }
  if (!workspace) return { ok: false, error: 'workspace 未指定' }

  const ws = normalize(workspace)
  const tdAbs = targetDir ? normalize(resolve(ws, targetDir)) : null

  let abs: string
  if (isAbsolute(trimmed)) {
    abs = normalize(trimmed)
    // 必须在工作区内
    if (!abs.startsWith(ws + sep) && abs !== ws) {
      return { ok: false, error: `绝对路径 ${trimmed} 越出工作区 ${ws}` }
    }
    // ✅ 若指定了 targetDir，把指向工作区根/其它子目录的绝对路径重映射到 targetDir 下
    // （AI 常把 plan 中的相对路径误传为绝对路径，如 D:\ws\package.json，应写入 D:\ws\targetDir\package.json）
    if (tdAbs && !abs.startsWith(tdAbs + sep) && abs !== tdAbs) {
      const rel = abs.slice(ws.length).replace(/^[\\/]+/, '')
      abs = normalize(resolve(tdAbs, rel))
    }
  } else {
    const base = tdAbs ?? ws
    abs = normalize(resolve(base, trimmed))
    if (!abs.startsWith(ws + sep) && abs !== ws) {
      return { ok: false, error: `路径 ${trimmed} 上跳后越出工作区` }
    }
  }
  return { ok: true, absPath: abs }
}

/** 按角色返回 S1 环境层附加段（拼进 buildAgentPrompt 的 S1 之后） */
export function roleEnvironmentHint(
  role: 'planner' | 'executor' | 'coder',
  targetDir: string | null
): string {
  const dir = targetDir ?? '.'
  switch (role) {
    case 'planner':
      return (
        `【三模型模式】你是规划器。目标子目录为 ${dir}；你只输出 DAG JSON（\`\`\`dag 代码块），不直接操作文件。` +
        `每个节点需声明 id、action、args、dependencies、complexity（low|high）。`
      )
    case 'executor':
      return (
        `【三模型模式】你是执行器。虚拟根目录是 /，禁止输出绝对路径；所有文件路径必须以 ${dir}/ 开头。` +
        `你只执行当前就绪（ready）的 DAG 节点，越序调用会被系统拦截。`
      )
    case 'coder':
      return (
        `【三模型模式】你是代码修复器。只允许修改已失败节点涉及的文件，逐文件输出完整内容（不使用 diff）。` +
        `输出格式：每个文件用 \`\`\`patch {"file":"相对路径","content":"完整内容"}\`\`\` 代码块包裹。`
      )
  }
}

/**
 * 三模型模式开关（自适应版）：
 * 历史实现是硬编码清单（qwen3:14b/qwen3:8b/deepseek-coder-v2:lite 三者齐备才为 true），
 * 现在改为「Ollama 任意可用模型 ≥ 1」即视为可进入 DAG 分时复用流程——
 * 具体用哪个模型由 adaptiveScheduler.selectModelForRole 在切换瞬间按画像+显存动态决定。
 * 参数仍保留 availableModelIds 形态，调度层无需变更。
 */
export function isThreeModelMode(availableModelIds: string[]): boolean {
  return availableModelIds.length > 0
}
