// 内置终端 MCP 服务器（进程内，无需外部进程）：
// 为 AI 提供真实命令执行能力（npm install / 构建 / 脚手架等）。
// 所有命令统一进入主进程的持久终端会话（handlers/terminal.ts），
// 在编辑器下方终端面板实时可见，用户手动输入与 AI 调用使用同一个 shell。
//
// 安全约束：工作目录必须落在当前工作区内，防止命令在任意目录执行。
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { z } from 'zod'
import { runTerminalForAi } from './terminal'
import { runInteractiveInPty } from './ptyManager'
import { formatErrorForAi, formatQuickExitAdvice, analyzeExitCode, formatFastFailBreaker } from '../terminal/commandError'
import { formatRepairForAi } from '../terminal/repairAdvisor'
import { isWithinWorkspace, resolveCwd } from '../terminal/shellProbe'
import { formatDuration as formatDurationMs } from '../terminal/taskUtils'
import {
  startBackgroundTask,
  listBackgroundTasks,
  killBackgroundTask,
  tailBackgroundTask,
  setBackgroundWorkspaceRoot
} from './backgroundTasks'

// 当前工作区根目录（由 mcp:setWorkspaceRoot 同步；未设置时回退到应用目录）
let workspaceRoot: string | null = null

/** 渲染进程切换工作区后同步终端工具的工作目录基准（持久会话 + 后台任务） */
export function setTerminalWorkspace(root: string | null): void {
  workspaceRoot = root
  setBackgroundWorkspaceRoot(root)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 截断超长输出，避免挤占模型上下文 */
function truncate(text: string, max = 6000): string {
  if (text.length <= max) return text
  return text.slice(0, max) + `\n…（输出过长已截断，共 ${text.length} 字符）`
}

/**
 * 项目开发服务器类命令（npm run dev/serve/start、yarn/pnpm、vite/vue-cli-service）。
 * 这类长驻命令必须在「文件结构完整 + 依赖安装成功」后启动，项目初始化阶段启动只会秒退。
 */
const DEV_SERVER_COMMAND_RE =
  /\bnpm\s+run\b|\bnpm\s+start\b|\byarn\s+(dev|serve|start)\b|\bpnpm\s+(dev|serve|start|run)\b|\b(vite|vue-cli-service)\b/

/**
 * 后台启动前置检查：dev server 类命令要求工作目录同时具备 package.json 与 node_modules。
 * @returns 拦截原因；放行返回 null
 */
function checkDevServerPrerequisites(command: string, dir: string): string | null {
  if (!DEV_SERVER_COMMAND_RE.test(command)) return null
  if (!existsSync(join(dir, 'package.json'))) {
    return (
      '错误：拦截：项目初始化阶段禁止启动后台开发服务器——工作目录缺少 package.json。' +
      '请先用 write 完整生成 package.json 等基础文件，再执行 npm install，成功后才可启动（三阶段顺序：生成文件 → 安装依赖 → 运行验证）。'
    )
  }
  if (!existsSync(join(dir, 'node_modules'))) {
    return (
      '错误：拦截：依赖尚未安装（工作目录不存在 node_modules），此时启动开发服务器必然秒退失败。' +
      '请先执行 npm install 并确认成功，再使用 start_background_task 启动（三阶段顺序：生成文件 → 安装依赖 → 运行验证）。'
    )
  }
  return null
}

/**
 * 后台任务命令前置检查（顺序硬锁）：
 * 1. 依赖安装类（npm/yarn/pnpm install/i/add，-g 除外）是一次性短命令，禁止走后台任务；
 *    工作目录缺 package.json 时额外点明顺序锁（先 write_file 创建，再安装）。
 * 2. dev server 类命令必须 package.json 与 node_modules 均就绪。
 * @returns 拦截原因；放行返回 null
 */
const INSTALL_COMMAND_RE = /\b(npm|cnpm|yarn|pnpm)\s+(install|i|add)\b/

function checkBackgroundCommand(command: string, dir: string): string | null {
  if (INSTALL_COMMAND_RE.test(command) && !/\s-(?:g|-global)\b/.test(command)) {
    if (!existsSync(join(dir, 'package.json'))) {
      return (
        '错误：当前目录缺少 package.json，无法执行 npm install（含 npm install <包名>）。' +
        '请先使用 write_file 创建 package.json；依赖安装是一次性命令，请改用 run_terminal_command 执行，不要使用 start_background_task。'
      )
    }
    return '错误：npm/yarn/pnpm install 是一次性安装命令，请改用 run_terminal_command 执行，不要使用 start_background_task（后台任务仅用于 dev server 等长驻进程）。'
  }
  return checkDevServerPrerequisites(command, dir)
}

/** 创建进程内终端 MCP 服务器，并返回已连接的客户端 */
export async function createTerminalClient(): Promise<Client> {
  const server = new McpServer({ name: 'terminal', version: '0.2.0' })

  server.registerTool(
    'run_terminal_command',
    {
      title: '执行终端命令',
      description:
        '在编辑器下方终端面板中真实执行命令（Windows PowerShell / POSIX shell），用户可实时看到过程。' +
        '适用于安装依赖（npm install）、运行构建（npm run build）、查看目录（dir）等一次性非交互命令。' +
        '命令的工作目录默认是工作区根目录，可用 cwd 指定工作区内子目录。' +
        '交互式程序（npm init/create、各类 REPL、脚手架、watch 长驻）必须设置 interactive:true：' +
        '命令会在真 PTY 终端启动并立即返回 terminalId，用户可继续键盘输入，不要等待其结束。' +
        '非交互的长驻命令也可改用 start_background_task。',
      inputSchema: {
        command: z.string().describe('要执行的完整命令行，例如 "npm install vue@2.7.16"'),
        // nullish 而非 optional：小模型常给省略字段显式塞 null（实测 qwen2.5:7b 发 cwd:null），
        // optional 只接受 undefined，显式 null 会被 -32602 拒绝导致命令根本没执行
        cwd: z
          .string()
          .nullish()
          .describe('命令工作目录：相对工作区的子路径或工作区内绝对路径，默认工作区根目录'),
        interactive: z
          .boolean()
          .nullish()
          .describe('true=在真 PTY 终端启动交互命令（REPL/脚手架/watch），立即返回 terminalId'),
        timeoutMs: z.number().nullish().describe('超时毫秒数，默认 300000（安装依赖等慢命令），最大 600000')
      }
    },
    async ({ command, cwd, interactive, timeoutMs }, extra) => {
      const base = workspaceRoot || process.cwd()
      const dir = resolveCwd(cwd, base)
      // 目录越界保护：只允许在工作区内执行
      if (!isWithinWorkspace(dir, base)) {
        return {
          content: [{ type: 'text' as const, text: `错误：工作目录必须在当前工作区内（${base}）` }],
          isError: true
        }
      }
      // 交互分支：真 PTY 启动，立即返回 terminalId（不回收结果、不等待退出）
      if (interactive === true) {
        try {
          const { terminalId } = runInteractiveInPty(command, dir)
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  `交互式命令已在真终端 #${terminalId} 启动（cwd ${dir}），用户可在终端面板继续输入。` +
                  '不要等待该命令结束，也不要重复调用；继续后续非依赖步骤，或询问用户。'
              }
            ]
          }
        } catch (err: any) {
          return {
            content: [{ type: 'text' as const, text: `错误：终端启动失败：${err?.message || String(err)}` }],
            isError: true
          }
        }
      }
      try {
        const t0 = Date.now()
        const r = await runTerminalForAi({
          command,
          cwd: dir === base ? undefined : dir,
          // 显式 null 归一为缺省，下游只认 undefined
          timeoutMs: timeoutMs ?? undefined,
          // 2.2 级联取消：client.callTool({signal}) 中止时 SDK 发 notifications/cancelled，
          // extra.signal 随之触发 → 持久 shell 被杀并重建，命令以「已中止」收尾
          signal: extra?.signal
        })
        // 秒退熔断器：<1000ms 且非零退出 → 致命错误标记，调度器识别后立即中止当前工具批次，
        // 禁止模型不做分析继续跑后续命令（先于 500ms 反思建议，文案更强硬）
        const durationMs = Date.now() - t0
        const breaker = r.ok ? null : formatFastFailBreaker(command, r.exitCode, durationMs)
        // 秒退检测：<500ms 且非零退出必然是前置条件缺失（无 package.json/未装依赖/脚本名错），
        // 前置「强制反思」段，防止模型把秒退误读为成功后继续盲目修改文件
        const quickExit = r.ok ? null : formatQuickExitAdvice(command, r.exitCode, durationMs)
        // 非零退出强制标记：[EXECUTION_FAILED] + 输出尾部 10 行，强迫模型停下来分析原因
        const failTag = r.ok ? '' : analyzeExitCode(r.output, r.exitCode)
        return {
          content: [
            {
              type: 'text' as const,
              text:
                (breaker ? `${breaker}\n\n` : '') +
                (quickExit ? `${quickExit}\n\n` : '') +
                (failTag ? `${failTag}\n\n` : '') +
                truncate(r.output) +
                formatErrorForAi(r.diagnostic ?? null) +
                // s45：有可执行修复动作时告知 AI——卡片已推给用户，确认后才会执行
                (r.repair ? formatRepairForAi(r.repair) : '')
            }
          ],
          isError: !r.ok
        }
      } catch (err: any) {
        return {
          content: [{ type: 'text' as const, text: `错误：${err?.message || String(err)}` }],
          isError: true
        }
      }
    }
  )

  // 启动后台长任务（dev server / watch / 监听类）：不占用终端命令队列，立即返回任务 id
  server.registerTool(
    'start_background_task',
    {
      title: '启动后台任务',
      description:
        '在后台启动长驻命令（如 npm run dev、vite --host、node server.js、监听脚本），不阻塞终端。' +
        '立即返回任务 id 与约 1 秒预热输出（用于判断是否启动成功）；后续用 list_background_tasks 查看状态、' +
        'stop_background_task 终止。不要用它跑一次性短命令（安装/构建/测试请用 run_terminal_command）。' +
        '【顺序约束】仅在项目文件结构完整、依赖安装成功（package.json 与 node_modules 均存在）后，' +
        '才可使用此工具启动长驻开发服务器（如 npm run dev）；不要在项目初始化阶段（基础文件未生成、npm install 未成功）使用，否则将被直接拦截。',
      inputSchema: {
        command: z.string().describe('长驻命令完整行，例如 "npm run dev"'),
        cwd: z.string().optional().describe('工作目录：工作区内相对/绝对路径，默认工作区根')
      }
    },
    async ({ command, cwd }) => {
      const base = workspaceRoot || process.cwd()
      const resolvedCwd = cwd ? resolveCwd(cwd, base) : undefined
      if (resolvedCwd && !isWithinWorkspace(resolvedCwd, base)) {
        return {
          content: [{ type: 'text' as const, text: `错误：工作目录必须在当前工作区内（${base}）` }],
          isError: true
        }
      }
      // 顺序硬锁：安装类一次性命令禁走后台任务；dev server 类要求 package.json + node_modules 就绪
      const prerequisiteError = checkBackgroundCommand(command, resolvedCwd ?? base)
      if (prerequisiteError) {
        return { content: [{ type: 'text' as const, text: prerequisiteError }], isError: true }
      }
      const started = startBackgroundTask({ command, cwd: resolvedCwd })
      if (!started.ok) {
        return { content: [{ type: 'text' as const, text: `错误：${started.error}` }], isError: true }
      }
      // 短暂预热：收集启动横幅/早期报错（端口占用等），帮助 AI 判断是否成功
      await sleep(1000)
      const tail = tailBackgroundTask(started.id, 0)
      const preview = tail.ok && tail.text ? `\n【预热输出】\n${tail.text.slice(-2000)}` : ''
      const exited = tail.ok && tail.status === 'exited'
      // 秒退熔断：预热窗口（1s）内即非零退出 → 致命错误标记，调度器识别后立即中止当前工具批次。
      // 典型：npm run dev 在 4ms 崩溃（文件未写完），此前模型收不到致命信号会继续盲目 read/write。
      const breaker =
        exited && tail.ok && tail.exitCode !== null && tail.exitCode !== 0
          ? `[FAST_FAIL_BREAKER]【致命错误】后台任务在 1s 预热窗口内崩溃退出（code ${tail.exitCode}）：${command}。\n` +
            '原因极大概率是文件缺失或语法错误。你被禁止继续执行任何后续命令与后台任务。\n' +
            '请立刻使用 read_file 仔细阅读报错涉及的代码文件，或使用 list_directory 检查目录结构，修复源码后才可再次运行。\n\n'
          : ''
      return {
        content: [
          {
            type: 'text' as const,
            text:
              breaker +
              `后台任务已启动：${started.id}\n命令：${command}\n状态：${exited ? `已退出（code ${tail.ok ? tail.exitCode : '?'}）——命令可能不是长驻任务或启动失败` : '运行中'}` +
              preview
          }
        ],
        isError: exited
      }
    }
  )

  // 查看后台任务（含最近已结束任务）与最新输出
  server.registerTool(
    'list_background_tasks',
    {
      title: '查看后台任务',
      description: '列出所有运行中与最近结束的后台任务（id/命令/状态/运行时长），可选追读某任务的最新输出。',
      inputSchema: {
        id: z.string().optional().describe('提供 id 时同时返回该任务的输出尾部（最近 3000 字符）')
      }
    },
    async ({ id }) => {
      const tasks = listBackgroundTasks()
      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: '当前没有后台任务。' }] }
      }
      const lines = tasks.map((t) => {
        const dur =
          t.status === 'running'
            ? `运行 ${formatDurationMs(Date.now() - t.startedAt)}`
            : `已退出 code=${t.exitCode}（耗时 ${formatDurationMs((t.endedAt ?? t.startedAt) - t.startedAt)}）`
        return `- ${t.id} [${t.status === 'running' ? '运行中' : '已结束'}] ${t.command} — ${dur}`
      })
      let extra = ''
      if (id) {
        const tail = tailBackgroundTask(id, 0)
        if (tail.ok) extra = `\n【${id} 输出尾部】\n${tail.text.slice(-3000)}`
        else extra = `\n${tail.error}`
      }
      return { content: [{ type: 'text' as const, text: lines.join('\n') + extra }] }
    }
  )

  // 终止后台任务
  server.registerTool(
    'stop_background_task',
    {
      title: '终止后台任务',
      description: '终止指定后台任务（POSIX 杀整个进程组，Windows taskkill /T 树杀），用于停掉 dev server 等。',
      inputSchema: {
        id: z.string().describe('start_background_task 返回的任务 id')
      }
    },
    async ({ id }) => {
      const r = killBackgroundTask(id)
      return {
        content: [
          {
            type: 'text' as const,
            text: r.ok ? `已请求终止任务 ${id}（进程组/进程树将被结束）。` : `终止失败：${r.error}`
          }
        ],
        isError: !r.ok
      }
    }
  )

  // 进程内直连：无需 spawn 子进程，零启动成本
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'scholar-trea-code', version: '0.1.0' })
  await client.connect(clientTransport)
  return client
}
