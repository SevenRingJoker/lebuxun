// 终端会话管理：在主进程维护一个持久 shell（Windows cmd / POSIX bash），
// 用户手动输入与 AI 工具调用都写入同一个 shell，输出实时推送到渲染进程终端面板。
//
// 完成度检测：管道式 stdin 不是 TTY，无法知道一条命令何时结束。
// 采用「哨兵标记」：命令后追加 echo 唯一标记=退出码，读到「纯标记行」即认为命令结束。
// 多条命令排队串行执行（shell 本身也是串行处理）。
//
// Windows 编码：cmd 默认 GBK(936) 代码页，不能切 chcp 65001——
// 65001 下 cmd 按字符数读 stdin，UTF-8 中文多字节会截断命令导致括号不闭合而挂起。
// 方案：保持 GBK，用 iconv-lite 对输入编码 GBK、输出流转码 UTF-8。
import { app, ipcMain, BrowserWindow } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { isAbsolute, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import os from 'node:os'
import iconv from 'iconv-lite'
import {
  type ShellProfile,
  resolveShellProfile,
  buildCommandLine,
  shellLineEnding,
  parseMarkerLine,
  lineMentionsMarker
} from '../terminal/shellProbe'
import { analyzeCommandError, type CommandErrorInfo } from '../terminal/commandError'
import {
  classifyFailure,
  proposeRepairs,
  type RepairProposal
} from '../terminal/repairAdvisor'
import {
  registerBackgroundTaskHandlers,
  setBackgroundWorkspaceRoot,
  setTaskShellProfileProvider
} from './backgroundTasks'

// 推给渲染进程的终端事件
export type TerminalEvent =
  | { kind: 'ready'; cwd: string; shellPid: number } // shell 就绪/重启
  | { kind: 'cmd'; source: 'user' | 'ai'; command: string } // 一条命令即将执行
  | { kind: 'data'; text: string } // 原始输出
  | { kind: 'exit'; code: number | null } // shell 退出
  | { kind: 'info'; text: string } // 系统提示（清屏/重启等）

interface RunOptions {
  command: string
  /** 工作目录：相对工作区子路径或工作区内绝对路径；默认当前 shell 目录 */
  cwd?: string
  /** user = 用户在终端框输入；ai = AI 工具调用（面板加 [AI] 标记） */
  source: 'user' | 'ai'
  timeoutMs?: number
  /** 2.2 用户停止信号：abort 时销毁持久 shell 会话（下次 run 自动重建），命令以「已中止」收尾 */
  signal?: AbortSignal
}

// s45 修复提案去重：key=命令|摘要 → 上次广播时间
const recentProposals = new Map<string, number>()

interface RunResult {
  ok: boolean
  output: string
  exitCode: number | null
  error?: string
  /** 失败时的结构化诊断（零错误时省略），供前端「AI 修复」与工具结果复用 */
  diagnostic?: CommandErrorInfo
  /** s45 修复提案（有可执行修复动作时带上），供渲染端确认卡片与 AI 建议文本复用 */
  repair?: RepairProposal
}

class TerminalSession {
  private proc: ChildProcessWithoutNullStreams | null = null
  private cwd: string
  /** 当前 shell 配置（start 时探测；后台任务复用同一份） */
  private profile: ShellProfile = resolveShellProfile(process.platform, process.env, existsSync)
  /** 是否有命令正在执行（队列串行闸门） */
  private running = false
  /** 当前命令的完成解析器 */
  private current: {
    marker: string
    /** 正在执行的原始命令（失败诊断用） */
    command: string
    /** 来源（user/ai）与实际执行目录：修复提案事件用 */
    source: 'user' | 'ai'
    cwd: string
    resolve: (r: RunResult) => void
    timer: NodeJS.Timeout
    /** 已过滤哨兵的干净输出（回传给 AI） */
    chunks: string[]
    /** 摘除 abort 监听（命令正常结束后防止残留监听误杀重建后的 shell） */
    abortOff?: () => void
  } | null = null
  /** 跨 data 事件的行缓冲（结果标记行可能被分块截断） */
  private lineBuffer = ''
  /**
   * Windows 启动导流：cmd 启动会先打印 banner（版本+版权两行）和首个提示符，
   * 见到首个提示符前的内容全部丢弃；防止 banner 被计入第一条命令的输出。
   */
  private bootstrapping = process.platform === 'win32'
  private bootBuffer = ''
  private seq = 0

  constructor(cwd: string) {
    this.cwd = cwd || os.homedir()
  }

  /** 广播事件到所有渲染窗口 */
  private emit(ev: TerminalEvent): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('terminal:event', ev)
    }
  }

  /** GBK→UTF-8 流转码器（Windows；iconv decodeStream 自动维护跨块双字节状态） */
  // 运行时是带 destroy 的 Transform，iconv 类型声明偏旧，这里以 unknown 收纳后按需调用
  private decoders: unknown[] = []

  /** 启动 shell（若已存活则先销毁） */
  start(cwd?: string): void {
    if (cwd) this.cwd = cwd
    this.kill()
    // 每次启动重新探测（尊重运行期变化的 ComSpec/SHELL）
    this.profile = resolveShellProfile(process.platform, process.env, existsSync)
    const profile = this.profile
    const isWin = profile.kind === 'cmd'
    // Windows cmd：保持系统默认代码页（中文 Windows 为 GBK），不切 chcp 65001
    // （65001 下 stdin 中文多字节会截断导致括号不闭合挂起），中文编解码在 Node 侧完成。
    // /V:ON 启用延迟变量扩展（哨兵读真实退出码 !ERRORLEVEL!）；/Q 关闭回显与启动横幅。
    // POSIX：$SHELL 探测结果（bash/zsh/fish），非交互管道 + 哨兵取 $?/$status。
    this.proc = spawn(profile.command, profile.args, {
      cwd: this.cwd,
      windowsHide: true,
      env: { ...process.env, FORCE_COLOR: '0' } as NodeJS.ProcessEnv
    })
    const pid = this.proc.pid ?? -1
    this.emit({ kind: 'ready', cwd: this.cwd, shellPid: pid })

    if (profile.encoding === 'gbk') {
      // stdout/stderr 字节流经 GBK 解码后再按行解析
      const outDecoder = iconv.decodeStream('gbk')
      const errDecoder = iconv.decodeStream('gbk')
      this.proc.stdout.pipe(outDecoder)
      this.proc.stderr.pipe(errDecoder)
      outDecoder.on('data', (s: string | Buffer) => this.feed(String(s)))
      errDecoder.on('data', (s: string | Buffer) => this.feed(String(s)))
      this.decoders = [outDecoder, errDecoder]
    } else {
      this.proc.stdout.on('data', (buf: Buffer) => this.feed(buf.toString('utf8')))
      this.proc.stderr.on('data', (buf: Buffer) => this.feed(buf.toString('utf8')))
    }
    this.proc.on('exit', (code) => {
      this.emit({ kind: 'exit', code })
      this.proc = null
    })
    this.proc.on('error', (err) => {
      this.emit({ kind: 'info', text: `[shell 错误] ${err.message}` })
    })
  }

  /**
   * 解析已解码为 UTF-8 的输出：
   * - Windows 先丢弃 cmd 启动 banner，并剥离所有 shell 提示符（X:\...>）；
   *   提示符无尾随换行，会与命令输出/哨兵行粘连（如 `D:\x>MARKER=0`），不剥离会导致哨兵失配；
   * - 含哨兵名的「命令回显行」整条过滤（面板不显示技术细节）；
   * - 仅当某行整体等于 `标记=数字` 时才认定为命令的真实结束（回显行是复合长命令，不会精确相等），
   *   避免回显文本里的标记字符串提前触发完成、造成输出错位；
   * - 其余行为真实输出，推面板并累积为 AI 结果。
   */
  private feed(raw: string): void {
    let text = raw
    if (this.profile.kind === 'cmd') {
      // 1) 启动导流：首个提示符（含其前的 banner）出现前，数据只缓存不下发
      if (this.bootstrapping) {
        this.bootBuffer += text
        const m = this.bootBuffer.match(/[A-Za-z]:\\[^\r\n>]*>/)
        if (!m) {
          // 兜底：异常环境（无提示符）缓存过大时强制导流，避免输出被永久吞掉
          if (this.bootBuffer.length > 4096) {
            this.bootstrapping = false
            this.bootBuffer = ''
          }
          return
        }
        text = this.bootBuffer.slice((m.index ?? 0) + m[0].length)
        this.bootBuffer = ''
        this.bootstrapping = false
      }
      // 2) 剥离后续提示符（每条命令后都会打印，可能与输出粘连同一行）
      text = text.replace(/[A-Za-z]:\\[^\r\n>]*>/g, '')
      if (text === '') return
    }

    this.lineBuffer += text
    const parts = this.lineBuffer.split(/\r?\n/)
    this.lineBuffer = parts.pop() ?? ''

    let doneCode: number | null = null
    const keep: string[] = []
    for (const line of parts) {
      if (this.current && lineMentionsMarker(line, this.current.marker)) {
        // 精确匹配哨兵结果行（允许首尾空白/回车残留），退出码为任意数字
        const code = parseMarkerLine(line, this.current.marker)
        if (code !== null) doneCode = code
        // 回显行与结果行都不显示
        continue
      }
      keep.push(line)
    }
    if (keep.length > 0) {
      const clean = keep.join('\r\n') + '\r\n'
      this.emit({ kind: 'data', text: clean })
      if (this.current) this.current.chunks.push(clean)
    }

    if (this.current && doneCode !== null) {
      const code = doneCode
      const output = this.current.chunks.join('')
      this.finish({
        ok: code === 0,
        output,
        exitCode: code,
        diagnostic: analyzeCommandError(this.current.command, output, code) ?? undefined
      })
    }
  }

  private finish(result: RunResult): void {
    if (!this.current) return
    clearTimeout(this.current.timer)
    // 摘除 abort 监听：命令已收尾，之后到达的 abort 不得误杀（可能已重建的）新 shell
    this.current.abortOff?.()
    // s45：失败且可修复分类 → 生成修复提案，随结果返回并广播确认卡片（中止/超时例外不提案）
    if (!result.ok && result.error !== 'aborted') {
      const report = classifyFailure(this.current.command, result.output, result.exitCode)
      if (report) {
        const actions = proposeRepairs(report)
        if (actions.length > 0) {
          result.repair = {
            origin: 'bash',
            command: this.current.command,
            cwd: this.current.cwd,
            report,
            actions
          }
          // 同一失败 60s 内只广播一次（AI 重试同一命令不会连弹卡片）
          const key = `${this.current.command}|${report.summary}`
          const now = Date.now()
          if (!recentProposals.has(key) || now - recentProposals.get(key)! > 60_000) {
            recentProposals.set(key, now)
            for (const win of BrowserWindow.getAllWindows()) {
              win.webContents.send('terminal:repairProposals', result.repair)
            }
          }
        }
      }
    }
    const resolve = this.current.resolve
    this.current = null
    // 丢弃行缓冲残片（上一条命令尾部不完整行/新提示符），避免污染下一条命令的输出
    this.lineBuffer = ''
    resolve(result)
    this.running = false
    this.pump()
  }

  /** 切换工作目录：重启 shell（cwd 是进程级属性） */
  setCwd(cwd: string): void {
    if (cwd && cwd !== this.cwd) this.start(cwd)
  }

  currentCwd(): string {
    return this.cwd
  }

  /** 当前 shell 配置（后台任务派生复用） */
  currentProfile(): ShellProfile {
    return this.profile
  }

  /** 执行命令（用户/AI 统一入口，自动排队串行） */
  run(opts: RunOptions): Promise<RunResult> {
    return new Promise((resolve) => {
      this.pending.push({ opts, resolve })
      this.pump()
    })
  }

  // 携带 resolver 的内部队列
  private pending: { opts: RunOptions; resolve: (r: RunResult) => void }[] = []

  private pump(): void {
    if (this.running || this.pending.length === 0) return
    const { opts, resolve: done } = this.pending.shift()!
    // 2.2 信号在入队期间已中止：不启动/不占用 shell，直接以取消收尾
    if (opts.signal?.aborted) {
      done({ ok: false, output: '⚠ 已被用户中止', exitCode: null, error: 'aborted' })
      this.pump()
      return
    }
    if (!this.proc) this.start()
    this.running = true

    // 目录约束：AI 调用必须落在工作区内（与 MCP 工具安全模型一致）
    let dir = this.cwd
    if (opts.cwd) {
      const target = isAbsolute(opts.cwd) ? opts.cwd : resolve(this.cwd, opts.cwd)
      dir = target
    }
    // 目录与当前 shell 不一致时由 buildCommandLine 生成 cd 段（cmd 跨盘用 /d）
    const previousCwd = this.cwd
    this.cwd = dir

    const marker = `__STC_DONE_${++this.seq}_${Date.now()}__`
    const timeout = Math.min(Math.max(opts.timeoutMs ?? 300_000, 1000), 600_000)

    // 2.2 用户停止 → 中止在途命令：先销毁持久 shell（阻塞型命令再无输出渠道，
    // 哨兵行永不到达，必须立即收尾），再以「已中止」释放 await。
    // kill() 会清 current/running，故必须先存 resolver 再杀；shell 销毁后下次 run() 自动重建。
    const signal = opts.signal
    const onAbort = () => {
      const cur = this.current
      if (!cur) return
      signal!.removeEventListener('abort', onAbort)
      this.current = null
      clearTimeout(cur.timer)
      const partial = cur.chunks.join('')
      this.emit({ kind: 'info', text: '[已中止] 用户停止，终端会话重置' })
      this.kill()
      cur.resolve({ ok: false, output: partial + '\n⚠ 已被用户中止', exitCode: null, error: 'aborted' })
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true })

    // 面板显示命令行（[AI] 标记由 source 决定）
    this.emit({ kind: 'cmd', source: opts.source, command: opts.command })

    // 构建「用户命令 + 完成哨兵」整行（shellProbe 纯函数按 cmd/posix/fish 方言生成）：
    // 括号隔离管道；退出码取用户命令真实结果（cmd !ERRORLEVEL! / posix $? / fish $status）
    const full = buildCommandLine(this.profile, {
      command: opts.command,
      cwd: dir,
      currentCwd: previousCwd,
      marker
    })
    this.current = {
      marker,
      command: opts.command,
      source: opts.source,
      cwd: dir,
      resolve: done,
      abortOff: signal ? () => signal.removeEventListener('abort', onAbort) : undefined,
      timer: setTimeout(() => {
        const partial = this.current ? this.current.chunks.join('') : ''
        const output = partial + `\n[错误] 命令执行超时（${timeout}ms）`
        this.finish({
          ok: false,
          output,
          exitCode: null,
          error: 'timeout',
          diagnostic: analyzeCommandError(opts.command, output, null) ?? undefined
        })
      }, timeout),
      chunks: []
    }
    // cmd（GBK 代码页）把命令行编码为 GBK 再写入；POSIX/fish 直接 UTF-8
    const payload = full + shellLineEnding(this.profile)
    const buf = this.profile.encoding === 'gbk' ? iconv.encode(payload, 'gbk') : Buffer.from(payload, 'utf8')
    this.proc!.stdin.write(buf)
  }

  /** 向 shell 直接写入原始输入（供未来交互式应答等） */
  writeRaw(text: string): boolean {
    if (!this.proc || !this.proc.stdin.writable) return false
    this.proc.stdin.write(text)
    return true
  }

  kill(): void {
    // 销毁旧的转码流，防止重建 shell 后旧流继续推送数据
    for (const d of this.decoders) {
      try {
        ;(d as { destroy?: () => void }).destroy?.()
      } catch {
        // 忽略
      }
    }
    this.decoders = []
    if (this.proc) {
      try {
        this.proc.removeAllListeners('exit')
        this.proc.kill()
      } catch {
        // 忽略
      }
      this.proc = null
    }
    this.current = null
    this.lineBuffer = ''
    this.running = false
    // 新 shell 重新经历启动导流（仅 cmd 需要：丢弃 banner + 首个提示符）
    this.bootstrapping = this.profile.kind === 'cmd'
    this.bootBuffer = ''
  }
}

// 单例会话（工作区切换时 setCwd 重启）
let session: TerminalSession | null = null

function getSession(): TerminalSession {
  if (!session) session = new TerminalSession(app.isPackaged ? app.getPath('home') : process.cwd())
  return session
}

/** AI MCP 工具调用入口：命令在终端面板可见地执行，返回完整输出 */
export async function runTerminalForAi(opts: {
  command: string
  cwd?: string
  timeoutMs?: number
  signal?: AbortSignal
  /** s45 修复卡片确认的修复命令以 user 身份入面板（用户已确认，不再过 bash 接受门） */
  source?: 'ai' | 'user'
}): Promise<RunResult> {
  return await getSession().run({
    command: opts.command,
    cwd: opts.cwd,
    source: opts.source ?? 'ai',
    timeoutMs: opts.timeoutMs,
    signal: opts.signal
  })
}

/** 工作区切换：终端 shell 跟随到新目录 */
export function setTerminalCwd(cwd: string): void {
  getSession().setCwd(cwd)
}

/** 注册终端相关 IPC */
export function registerTerminalHandlers(): void {
  // 渲染进程请求启动/重启 shell（挂载时、切换工作区后）
  ipcMain.handle('terminal:start', (_e, cwd?: string) => {
    getSession().start(cwd)
    return { ok: true, cwd: getSession().currentCwd() }
  })

  // 用户在终端框输入命令
  ipcMain.handle('terminal:run', async (_e, command: string) => {
    return await getSession().run({ command, source: 'user' })
  })

  // 清屏仅清渲染端显示（主进程无需动作）
  ipcMain.handle('terminal:cwd', () => getSession().currentCwd())

  // 后台任务：shell 配置复用当前会话探测结果（同一平台方言）
  setTaskShellProfileProvider(() => getSession().currentProfile())
  registerBackgroundTaskHandlers()
}
