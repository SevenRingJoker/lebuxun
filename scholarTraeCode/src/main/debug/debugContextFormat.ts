// AI 调试上下文格式化（纯函数层，零 electron / 零 IO，可单测）。
// 把调试会话快照（状态/断点/停驻堆栈/变量）压缩为紧凑文本块，
// 供内置工具 debug_get_context 喂给模型，避免挤占上下文窗口。

export interface DebugStackItem {
  name: string
  file: string
  line: number
}

export interface DebugVariableItem {
  name: string
  value: string
  type?: string
}

export interface DebugContextView {
  /** 活跃后端：node-cdp（Node.js）/ dap（Python debugpy / Go dlv）；无会话为 null */
  backend: 'node-cdp' | 'dap' | null
  /** 会话状态机：idle/connecting/initialized/running/stopped/terminated */
  state: string
  /** 调试目标（入口文件或程序路径） */
  program?: string
  /** 已下断点：file -> 行号数组 */
  breakpoints: Record<string, number[]>
  /** 最近一次 stopped 的上下文；未停驻为 null */
  stopped: {
    stack: DebugStackItem[]
    /** 作用域名列表（如 local/closure/global） */
    scopes: string[]
    variables: DebugVariableItem[]
  } | null
}

// 截断阈值：堆栈 10 帧、变量 30 条、单值 120 字符
const STACK_LIMIT = 10
const VAR_LIMIT = 30
const VALUE_LIMIT = 120

/** 截断单变量值，避免大对象/长字符串爆上下文 */
export function truncateValue(v: string, limit = VALUE_LIMIT): string {
  if (v.length <= limit) return v
  return `${v.slice(0, limit)}…(${v.length}字符)`
}

/** 仅保留文件末两段路径，压缩堆栈宽度（/a/b/c/d.ts → c/d.ts） */
export function shortenPath(file: string): string {
  const parts = file.split(/[\\/]/)
  return parts.length <= 2 ? file : parts.slice(-2).join('/')
}

/** 格式化调试上下文为紧凑文本块（喂模型用） */
export function formatDebugContext(ctx: DebugContextView): string {
  const lines: string[] = []
  lines.push(`后端：${ctx.backend ?? '无'} | 状态：${ctx.state}${ctx.program ? ` | 目标：${shortenPath(ctx.program)}` : ''}`)

  const bpEntries = Object.entries(ctx.breakpoints).filter(([, ls]) => ls.length > 0)
  if (bpEntries.length > 0) {
    lines.push('断点：')
    for (const [file, ls] of bpEntries) {
      lines.push(`  ${shortenPath(file)}: ${ls.join(', ')}`)
    }
  } else {
    lines.push('断点：无')
  }

  if (!ctx.stopped) {
    lines.push(ctx.state === 'stopped' ? '停驻上下文：（拉取失败）' : '当前未停驻在断点/异常处')
    return lines.join('\n')
  }

  lines.push(`停驻堆栈（前 ${STACK_LIMIT} 帧）：`)
  const stack = ctx.stopped.stack.slice(0, STACK_LIMIT)
  if (stack.length === 0) {
    lines.push('  （空）')
  } else {
    for (let i = 0; i < stack.length; i++) {
      const f = stack[i]
      lines.push(`  #${i} ${f.name} @ ${shortenPath(f.file)}:${f.line}`)
    }
  }

  if (ctx.stopped.scopes.length > 0) {
    lines.push(`作用域：${ctx.stopped.scopes.join(', ')}`)
  }

  const vars = ctx.stopped.variables.slice(0, VAR_LIMIT)
  if (vars.length > 0) {
    lines.push(`变量（前 ${VAR_LIMIT} 条）：`)
    for (const v of vars) {
      lines.push(`  ${v.name}${v.type ? `: ${v.type}` : ''} = ${truncateValue(v.value)}`)
    }
  } else {
    lines.push('变量：无')
  }

  return lines.join('\n')
}
