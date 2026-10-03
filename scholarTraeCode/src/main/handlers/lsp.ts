// LSP 桥接：主进程按服务器种类（ts / vue）分别 spawn 语言服务器（stdio），
// 通过 IPC 在渲染进程 Monaco 与语言服务器之间做双向 JSON-RPC 转发。
// vue 模式为 Volar Take Over：单服务器同时处理 .vue 与 TS 全家桶，
// 因此同一时刻渲染端只会启动其中一种，两服务器不共存、不冲突。
import { ipcMain } from 'electron'
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process'
import { createRequire } from 'node:module'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
// 服务器种类类型下沉在 shared（渲染端共用）；此处 re-export 保持既有引用路径
import type { LspServerKind as SharedLspServerKind } from '../../shared/lsp/initialize'
import { isLspServerKind } from '../../shared/lsp/initialize'

/** 语言服务器种类 */
export type LspServerKind = SharedLspServerKind

/** spawn 入口 */
interface ServerEntry {
  command: string
  args: string[]
}

/** 单个服务器的运行态（进程/缓冲/回推器） */
interface ServerState {
  proc: ChildProcessWithoutNullStreams | null
  buffer: Buffer
  sender: ((msg: string) => void) | null
}

// 两种服务器各自独立的运行态
const states: Record<LspServerKind, ServerState> = {
  ts: { proc: null, buffer: Buffer.alloc(0), sender: null },
  vue: { proc: null, buffer: Buffer.alloc(0), sender: null }
}

/** 解析 typescript-language-server 可执行入口（本地 node_modules 内） */
function resolveTsEntry(): ServerEntry {
  const require = createRequire(__filename)
  try {
    // 优先用 node/electron 直接跑 lib 下的 cli.mjs，避免 .cmd 包装差异
    const pkgPath = require.resolve('typescript-language-server/package.json')
    const cliPath = pkgPath.replace(/package\.json$/, 'lib/cli.mjs')
    return { command: process.execPath, args: [cliPath, '--stdio'] }
  } catch {
    // 回退：交给 npx 找
    return { command: 'npx', args: ['typescript-language-server', '--stdio'] }
  }
}

/** 解析 @vue/language-server（Volar）可执行入口 */
function resolveVueEntry(): ServerEntry {
  const require = createRequire(__filename)
  try {
    const pkgPath = require.resolve('@vue/language-server/package.json')
    const binPath = pkgPath.replace(/package\.json$/, 'bin/vue-language-server.js')
    return { command: process.execPath, args: [binPath, '--stdio'] }
  } catch {
    return { command: 'npx', args: ['@vue/language-server', '--stdio'] }
  }
}

/** 服务器种类 → 入口解析 */
const ENTRY_RESOLVERS: Record<LspServerKind, () => ServerEntry> = {
  ts: resolveTsEntry,
  vue: resolveVueEntry
}

/**
 * 解析运行时 TypeScript 的 tsdk（typescript 包的 lib 目录，含 tsserver.js）。
 * 供 Volar initialize 的 initializationOptions.typescript.tsdk 使用。
 */
export function resolveTsdk(): string {
  const require = createRequire(__filename)
  const pkgPath = require.resolve('typescript/package.json')
  // 统一为正斜杠：Volar/loadTsdkByPath 在 Windows 下对正斜杠路径实测可用
  return pkgPath.replace(/package\.json$/, 'lib').replace(/\\/g, '/')
}

// 将一帧 LSP Content-Length 协议数据推入解析（按服务器各自缓冲）
function feedBuffer(state: ServerState): void {
  while (true) {
    const headerEnd = state.buffer.indexOf('\r\n\r\n')
    if (headerEnd === -1) return
    const header = state.buffer.subarray(0, headerEnd).toString('utf-8')
    const m = /Content-Length:\s*(\d+)/i.exec(header)
    if (!m) {
      state.buffer = state.buffer.subarray(headerEnd + 4)
      continue
    }
    const len = parseInt(m[1], 10)
    const start = headerEnd + 4
    if (state.buffer.length < start + len) return
    const body = state.buffer.subarray(start, start + len).toString('utf-8')
    state.buffer = state.buffer.subarray(start + len)
    if (state.sender) state.sender(body)
  }
}

// 包装一条 JSON-RPC 消息为 LSP 协议帧
function frame(msg: string): string {
  return `Content-Length: ${Buffer.byteLength(msg, 'utf-8')}\r\n\r\n${msg}`
}

// ==================== 扩展名路由（纯函数，可单测） ====================

/** TS 全家桶扩展名（两种模式都由 TS 语言服务处理） */
export const TS_FAMILY_EXTS = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs', 'jsx', 'tsx'] as const

/** Volar 模式额外接管的扩展名 */
export const VUE_EXTRA_EXTS = ['vue'] as const

/**
 * 在给定服务器模式下，某扩展名是否由该模式的语言服务器处理。
 * TS 模式只处理 TS 全家桶；vue 模式（Take Over）额外处理 .vue。
 */
export function isHandledExt(ext: string, mode: LspServerKind): boolean {
  const e = ext.toLowerCase().replace(/^\./, '')
  if ((TS_FAMILY_EXTS as readonly string[]).includes(e)) return true
  return mode === 'vue' && (VUE_EXTRA_EXTS as readonly string[]).includes(e)
}

/**
 * 工作区默认服务器选择：含 .vue 文件 → vue（Take Over），否则 ts。
 * @param hasVue 工作区是否探测到 .vue 源文件
 */
export function chooseServerKind(hasVue: boolean): LspServerKind {
  return hasVue ? 'vue' : 'ts'
}

// ==================== Vue 工作区探测 ====================

/** 探测时跳过的目录（依赖/产物/元数据，非用户源码区） */
const SKIP_SCAN_DIRS = new Set([
  'node_modules', '.git', 'dist', 'out', 'release', '.trae', '.idea', '.vscode'
])

/** 探测参数上限（防止超大工作区长时间遍历） */
export const VUE_SCAN_MAX_ENTRIES = 5000
export const VUE_SCAN_MAX_DEPTH = 8

export interface VueScanOptions {
  maxEntries?: number
  maxDepth?: number
}

/**
 * 受限深度遍历工作区，判断是否存在 .vue 源文件。
 * 任何 IO 异常都安全回落为 false（由 typescript-language-server 提供服务，
 * 用户打开 .vue 时渲染端仍可显式升级到 vue 模式）。
 */
export function detectVueWorkspace(root: string, options: VueScanOptions = {}): boolean {
  const maxEntries = options.maxEntries ?? VUE_SCAN_MAX_ENTRIES
  const maxDepth = options.maxDepth ?? VUE_SCAN_MAX_DEPTH
  let entries = 0
  // 栈项：目录绝对路径 + 相对工作区深度（root 自身为 0）
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
  try {
    while (stack.length > 0) {
      const { dir, depth } = stack.pop()!
      if (depth > maxDepth || entries >= maxEntries) continue
      let names: string[]
      try {
        names = readdirSync(dir)
      } catch {
        continue // 无权限/已删除目录：跳过
      }
      for (const name of names) {
        entries += 1
        if (entries >= maxEntries) return false
        let st
        try {
          st = statSync(join(dir, name))
        } catch {
          continue
        }
        if (st.isDirectory()) {
          if (!SKIP_SCAN_DIRS.has(name)) {
            stack.push({ dir: join(dir, name), depth: depth + 1 })
          }
        } else if (st.isFile() && name.toLowerCase().endsWith('.vue')) {
          return true
        }
      }
    }
  } catch {
    return false
  }
  return false
}

// ==================== IPC 注册 ====================

/** 注册 LSP 相关 IPC */
export function registerLspHandlers(): void {
  // 探测工作区是否含 .vue（渲染端据此选择默认服务器）
  ipcMain.handle('lsp:detectVue', async (_e, root: string | null) => {
    if (!root) return false
    return detectVueWorkspace(root)
  })

  // 启动指定语言服务器；返回 tsdk 供 Volar initialize 使用
  ipcMain.handle('lsp:start', async (event, kind: unknown) => {
    if (!isLspServerKind(kind)) {
      return { ok: false, error: `unknown lsp kind: ${String(kind)}` }
    }
    const state = states[kind]
    if (state.proc) return { ok: true, already: true, tsdk: resolveTsdk() }
    const { command, args } = ENTRY_RESOLVERS[kind]()
    state.proc = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      // process.execPath 是 electron.exe，须以纯 Node 模式运行语言服务器
      // （否则 Volar 在 Electron 主进程环境中静默退出码 1；与 mcp.ts 同一约定）
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    })
    state.buffer = Buffer.alloc(0)
    state.sender = (msg: string) => {
      event.sender.send('lsp:message', kind, msg)
    }
    state.proc.stdout.on('data', (chunk: Buffer) => {
      state.buffer = Buffer.concat([state.buffer, chunk])
      feedBuffer(state)
    })
    state.proc.stderr.on('data', (chunk: Buffer) => {
      // 语言服务器告警打印到主进程控制台，不上抛
      console.error(`[lsp:${kind} stderr]`, chunk.toString())
    })
    state.proc.on('exit', () => {
      state.proc = null
      state.sender = null
      state.buffer = Buffer.alloc(0)
    })
    return { ok: true, tsdk: resolveTsdk() }
  })

  // 渲染进程 -> 指定语言服务器 的单向写
  ipcMain.on('lsp:write', (_e, kind: unknown, msg: string) => {
    if (!isLspServerKind(kind)) return
    const state = states[kind]
    if (state.proc && state.proc.stdin.writable) {
      state.proc.stdin.write(frame(msg), 'utf-8')
    }
  })

  // 停止指定语言服务器
  ipcMain.handle('lsp:stop', async (_e, kind: unknown) => {
    if (!isLspServerKind(kind)) return { ok: false }
    const state = states[kind]
    if (state?.proc) {
      state.proc.kill()
      state.proc = null
    }
    if (state) {
      state.sender = null
      state.buffer = Buffer.alloc(0)
    }
    return { ok: true }
  })
}
