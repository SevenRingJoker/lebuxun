// 3.3 AI 调试集成：暴露调试上下文给 Agent 的内置工具。
// 三个工具：debug_get_context（读状态/堆栈/变量）/ debug_apply_breakpoint（应用断点）/
// debug_evaluate（DAP 会话 REPL 求值）。自动路由到活跃后端（Node CDP 或 DAP）。
import type { BuiltinTool } from './builtinTools'
import {
  getDebugSnapshot,
  getDebugStoppedContext,
  getDebugLastException,
  getDebugBreakpoints,
  setDebugBreakpoints
} from '../debug/debugSession'
import {
  getDapSnapshot,
  getDapStoppedContext,
  getDapBreakpoints,
  setDapBreakpoints,
  dapEvaluate
} from '../debug/genericDapSession'
import { formatDebugContext, type DebugContextView } from '../debug/debugContextFormat'

/** 汇总双后端上下文为统一视图；无活跃会话返回 null */
function collectContext(): DebugContextView | null {
  const nodeSnap = getDebugSnapshot()
  const dapSnap = getDapSnapshot()
  const nodeActive = nodeSnap.state !== 'idle' && nodeSnap.state !== 'terminated'
  const dapActive = dapSnap.state !== 'idle' && dapSnap.state !== 'terminated'

  if (dapActive) {
    const stopped = getDapStoppedContext()
    return {
      backend: 'dap',
      state: dapSnap.state,
      program: dapSnap.program,
      breakpoints: Object.fromEntries(getDapBreakpoints()),
      stopped: stopped
        ? {
            stack: stopped.stack.map((f) => ({ name: f.name, file: f.file, line: f.line })),
            scopes: stopped.scopes.map((s) => s.name),
            variables: stopped.variables.map((v) => ({ name: v.name, value: v.value, type: v.type }))
          }
        : null
    }
  }
  if (nodeActive) {
    const stopped = getDebugStoppedContext()
    return {
      backend: 'node-cdp',
      state: nodeSnap.state,
      program: nodeSnap.entry,
      breakpoints: Object.fromEntries(getDebugBreakpoints()),
      stopped: stopped
        ? {
            stack: stopped.stack.map((f) => ({ name: f.name, file: f.file, line: f.line })),
            scopes: stopped.scopes.map((s) => s.name),
            variables: stopped.variables.map((v) => ({ name: v.name, value: v.value, type: v.type }))
          }
        : null
    }
  }
  return null
}

/** debug_get_context：读取当前调试会话状态、停驻堆栈与变量 */
const debugGetContextTool: BuiltinTool = {
  name: 'debug_get_context',
  description:
    '读取当前调试会话上下文：后端（Node/ Python/ Go）、状态、断点、停驻堆栈与变量。' +
    '用于分析程序为何停在某处、变量取值是否符合预期。无参数。',
  inputSchema: { type: 'object', properties: {} },
  run: async () => {
    const ctx = collectContext()
    if (!ctx) return '当前无活跃调试会话。请先在调试面板启动 Node.js / Python / Go 调试。'
    let text = formatDebugContext(ctx)
    const exc = getDebugLastException()
    if (exc) text += `\n最近异常：${exc}`
    return text
  }
}

/** debug_apply_breakpoint：在指定文件行号下断点（覆盖该文件原有断点） */
const debugApplyBreakpointTool: BuiltinTool = {
  name: 'debug_apply_breakpoint',
  description:
    '在指定文件的若干行应用断点（覆盖式：该文件未列出的原有断点被移除）。' +
    '参数：path（文件绝对路径）、lines（行号数组，1-based）。需要已有活跃调试会话。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件绝对路径' },
      lines: { type: 'array', items: { type: 'number' }, description: '行号数组（1-based）' }
    },
    required: ['path', 'lines']
  },
  run: async (args) => {
    const path = String(args.path || '')
    const lines = Array.isArray(args.lines)
      ? args.lines.filter((n): n is number => typeof n === 'number' && n > 0)
      : []
    if (!path) return '错误：缺少 path 参数'
    if (lines.length === 0) return '错误：lines 为空（如需清空该文件断点，传空数组以外的至少一行；或在调试面板手动移除）'

    const dapActive = getDapSnapshot().state !== 'idle' && getDapSnapshot().state !== 'terminated'
    const nodeActive = getDebugSnapshot().state !== 'idle' && getDebugSnapshot().state !== 'terminated'

    if (dapActive) {
      const r = await setDapBreakpoints(path, lines)
      return r.ok ? `已在 ${path} 设置断点：${lines.join(', ')}（DAP 会话）` : `错误：${r.error}`
    }
    if (nodeActive) {
      const r = await setDebugBreakpoints(path, lines)
      return r.ok ? `已在 ${path} 设置断点：${lines.join(', ')}（Node CDP 会话）` : `错误：${r.error}`
    }
    return '错误：无活跃调试会话，请先启动调试'
  }
}

/** debug_evaluate：在停驻位置求值表达式（仅 DAP 会话：Python / Go） */
const debugEvaluateTool: BuiltinTool = {
  name: 'debug_evaluate',
  description:
    '在调试停驻位置求值表达式（REPL 语义，仅 Python/Go DAP 会话支持）。' +
    '参数：expression（表达式文本）。需要会话处于 stopped 状态。',
  inputSchema: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: '要求值的表达式' }
    },
    required: ['expression']
  },
  run: async (args) => {
    const expression = String(args.expression || '').trim()
    if (!expression) return '错误：缺少 expression 参数'
    const dapActive = getDapSnapshot().state !== 'idle' && getDapSnapshot().state !== 'terminated'
    if (!dapActive) return '错误：表达式求值仅支持 Python/Go（DAP）会话，且需在停驻状态'
    const r = await dapEvaluate(expression)
    return r.ok ? `${expression} = ${r.result || '(无返回值)'}` : `错误：${r.error}`
  }
}

/** 调试工具注册表（由 builtinTools.ts 合并进总表） */
export const DEBUG_TOOLS: BuiltinTool[] = [
  debugGetContextTool,
  debugApplyBreakpointTool,
  debugEvaluateTool
]
