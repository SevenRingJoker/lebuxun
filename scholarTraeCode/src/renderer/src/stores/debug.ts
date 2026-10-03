// 调试状态管理：断点集合、会话状态、堆栈与变量快照
// 3.3 支持双后端：Node.js（CDP，api.debug.*）与 Python/Go（DAP，api.dap.*），
// 两后端事件统一走 'debug:event' 通道，handleEvent 无需区分来源。
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type {
  UiDebugState,
  UiDebugStackFrame,
  UiDebugScope,
  UiDebugVariable,
  UiDebugEvent,
  UiDapConfig
} from '../api'

/** 启动配置：node 走 CDP；dap 走通用 DAP（debugpy / dlv） */
export type DebugStartConfig =
  | ({ backend: 'node' } & ({ kind: 'launch'; entry: string; port?: number } | { kind: 'attach'; port: number }))
  | ({ backend: 'dap' } & UiDapConfig)

export const useDebugStore = defineStore('debug', () => {
  /** 当前会话状态 */
  const state = ref<UiDebugState>('idle')
  const kind = ref<'launch' | 'attach' | null>(null)
  /** 活跃后端：启动成功时记录，停止/终止时清空 */
  const activeBackend = ref<'node' | 'dap' | null>(null)
  /** 当前文件路径（用于断点同步） */
  const currentFile = ref<string | null>(null)
  /** 断点：file -> lines */
  const breakpoints = ref<Map<string, Set<number>>>(new Map())
  /** stopped 时的堆栈 */
  const stack = ref<UiDebugStackFrame[]>([])
  const scopes = ref<UiDebugScope[]>([])
  const variables = ref<UiDebugVariable[]>([])
  /** 调试输出缓冲（环形，保留最近 5000 字符） */
  const output = ref('')
  /** 当前命中行（用于编辑器高亮） */
  const hitLine = ref<{ file: string; line: number } | null>(null)
  /** s52 最近一次异常停驻的上下文（供 AI 修复对话注入） */
  const lastException = ref<{
    description: string
    stack: UiDebugStackFrame[]
    scopes: UiDebugScope[]
    variables: UiDebugVariable[]
  } | null>(null)

  const isActive = computed(() => state.value !== 'idle' && state.value !== 'terminated')
  const isStopped = computed(() => state.value === 'stopped')

  /** 按活跃后端选择 IPC 通道（node → api.debug；dap → api.dap） */
  function channel(): typeof window.api.debug | typeof window.api.dap {
    return activeBackend.value === 'dap' ? window.api.dap : window.api.debug
  }

  function toggleBreakpoint(file: string, line: number): void {
    if (!breakpoints.value.has(file)) breakpoints.value.set(file, new Set())
    const set = breakpoints.value.get(file)!
    if (set.has(line)) set.delete(line)
    else set.add(line)
    if (isActive.value) {
      void channel().setBreakpoints(file, [...set].sort((a, b) => a - b))
    }
  }

  function getBreakpoints(file: string): number[] {
    return [...(breakpoints.value.get(file) ?? [])].sort((a, b) => a - b)
  }

  async function start(cfg: DebugStartConfig): Promise<{ ok: boolean; error?: string }> {
    const r = cfg.backend === 'dap'
      ? await window.api.dap.start({
          runtime: cfg.runtime,
          request: cfg.request,
          ...(cfg.request === 'launch'
            ? { program: cfg.program, args: cfg.args, cwd: cfg.cwd, env: cfg.env, port: cfg.port }
            : { port: cfg.port, host: cfg.host })
        } as UiDapConfig)
      : await window.api.debug.start(
          cfg.kind === 'launch'
            ? { kind: 'launch', entry: cfg.entry, port: cfg.port }
            : { kind: 'attach', port: cfg.port }
        )
    if (r.ok) activeBackend.value = cfg.backend
    return r
  }

  async function stop(): Promise<void> {
    await channel().stop()
    activeBackend.value = null
    hitLine.value = null
    stack.value = []
    scopes.value = []
    variables.value = []
  }

  async function control(action: 'continue' | 'next' | 'stepIn' | 'stepOut' | 'pause'): Promise<void> {
    await channel().control(action)
  }

  /** DAP REPL 表达式求值（仅 dap 后端且 stopped 时可用） */
  async function evaluate(expression: string): Promise<{ ok: boolean; result?: string; error?: string }> {
    if (activeBackend.value !== 'dap') return { ok: false, error: '仅 Python/Go 会话支持表达式求值' }
    return window.api.dap.evaluate(expression)
  }

  function handleEvent(ev: UiDebugEvent): void {
    switch (ev.kind) {
      case 'state':
        state.value = ev.state
        break
      case 'output':
        output.value = (output.value + ev.text).slice(-5000)
        break
      case 'stopped':
        state.value = 'stopped'
        stack.value = ev.stack
        scopes.value = ev.scopes
        variables.value = ev.variables
        hitLine.value = ev.stack[0] ? { file: ev.stack[0].file, line: ev.stack[0].line } : null
        break
      case 'terminated':
        state.value = 'terminated'
        hitLine.value = null
        activeBackend.value = null
        break
      // s52 异常停驻：记录异常上下文，供 ChatPanel 自动注入修复对话
      case 'exception':
        lastException.value = {
          description: ev.description,
          stack: ev.stack,
          scopes: ev.scopes,
          variables: ev.variables
        }
        break
    }
  }

  function setCurrentFile(file: string | null): void {
    currentFile.value = file
  }

  return {
    state, kind, activeBackend, currentFile, breakpoints, stack, scopes, variables, output, hitLine,
    lastException,
    isActive, isStopped,
    toggleBreakpoint, getBreakpoints, start, stop, control, evaluate, handleEvent, setCurrentFile
  }
})
