// 内置工具系统：核心六工具 read/write/edit/bash/grep/glob + 扩展工具（builtinToolsExt.ts：
// delete/move/copy/web_fetch/web_search/run_script/git/npm_info）。
// 与 MCP 工具解耦——即使 MCP filesystem 未连接，AI 也能完成文件操作和搜索。
// 调度器在工具循环中优先匹配内置工具，未命中再回退 MCP。
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import { join, relative, sep, dirname } from 'node:path'
import { spawn, exec } from 'node:child_process'
import iconv from 'iconv-lite'
import { EXTRA_TOOLS } from './builtinToolsExt'
import { resolveShellProfile } from '../terminal/shellProbe'
import { getEnvironmentReport, formatEnvironmentReport } from './environmentProbe'
import { runContentSearch } from '../search/searchEngine'
// s42 符号导航 + s43 spec 锚点（薄封装：规则在 symbolNav/anchors 纯函数层）
import { ensureIndex } from './indexer'
import { findReferences, formatReferenceReport, symbolOutline } from './symbolNav'
import { loadAnchors, saveAnchors, formatAnchorSummary, type AnchorsFile } from './anchors'
// s46 测试骨架生成（规则在 testGen 纯函数层）
import { parseFileContent } from './codeParse'
import { buildTestSkeleton, testFileFor } from './testGen'
// s54 学术图表：实验数据 CSV/JSON → SVG（规则在 shared/scholar 纯函数层）
import { parseDataFile } from '../../shared/scholar/csv'
import { renderSvgChart, svgToDataUrl, type ChartType } from '../../shared/scholar/svgChart'
// 写入前语法预检：js/ts/vue/json 语法错误在落盘前拦截（拒绝消息以「错误：」开头，
// 调度器据此记 commandFailure 失败信号，模型能立即看到行级语法错误）
import { validateSyntaxBeforeWrite } from './syntaxGuard'

/** 内置工具统一接口：注册名 + 模型可见的说明/schema + 执行函数 */
export interface BuiltinTool {
  name: string
  description: string
  inputSchema: unknown
  run: (args: Record<string, unknown>, workspace?: string | null, signal?: AbortSignal) => Promise<string>
}

// 递归遍历时跳过的目录（与 context.ts 的索引忽略列表保持一致）
const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'out', 'build', 'release',
  '.idea', '.vscode', '.trae', '.cache'
])
// 输出截断阈值，避免单次工具结果挤占模型上下文窗口
const READ_LIMIT = 6000
const OUTPUT_LIMIT = 6000
const GREP_LIMIT = 50
const GLOB_LIMIT = 200

/** read：读取文件内容（UTF-8），超长截断 */
const readTool: BuiltinTool = {
  name: 'read',
  description: '读取文件内容（UTF-8 文本）。参数：path（绝对路径，建议在工作区内）。',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string', description: '要读取的文件绝对路径' } },
    required: ['path']
  },
  run: async (args) => {
    const path = String(args.path || '')
    if (!path) return '错误：缺少 path 参数'
    try {
      const content = await fs.readFile(path, 'utf-8')
      return content.length > READ_LIMIT
        ? content.slice(0, READ_LIMIT) + '\n...(已截断，共 ' + content.length + ' 字符)'
        : content
    } catch (e: any) {
      return `错误：${e?.message || String(e)}`
    }
  }
}

/** write：写入文件，自动创建父目录（幂等） */
const writeTool: BuiltinTool = {
  name: 'write',
  description: '写入文件（自动创建父目录，覆盖已存在内容）。写入前会做语法预检：.js/.ts/.vue/.json 等代码文件存在语法错误时将被拒绝并返回具体行号，需修复后重试。参数：path（绝对路径）、content（完整文件内容）。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件绝对路径' },
      content: { type: 'string', description: '文件完整内容' }
    },
    required: ['path', 'content']
  },
  run: async (args) => {
    const path = String(args.path || '')
    const content = String(args.content ?? '')
    if (!path) return '错误：缺少 path 参数'
    // 写入前语法预检：语法错误不落盘，把行级错误直接回给模型
    const syntaxError = await validateSyntaxBeforeWrite(path, content)
    if (syntaxError) return syntaxError
    try {
      const dir = dirname(path)
      if (dir && dir !== '.') {
        await fs.mkdir(dir, { recursive: true }).catch(() => {})
      }
      await fs.writeFile(path, content, 'utf-8')
      return `已写入 ${path}（${content.length} 字符）`
    } catch (e: any) {
      return `错误：${e?.message || String(e)}`
    }
  }
}

/** edit：精确编辑——把唯一出现的 old_string 替换为 new_string */
const editTool: BuiltinTool = {
  name: 'edit',
  description: '精确编辑文件：将文件中唯一出现的 old_string 替换为 new_string。要求 old_string 在文件中只出现一次。替换后的整文件会做语法预检（.js/.ts/.vue/.json），语法错误将被拒绝。参数：path（文件绝对路径）、old_string（要替换的原文，必须唯一）、new_string（替换后的内容）。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件绝对路径' },
      old_string: { type: 'string', description: '要替换的原文（必须唯一）' },
      new_string: { type: 'string', description: '替换后的内容' }
    },
    required: ['path', 'old_string', 'new_string']
  },
  run: async (args) => {
    const path = String(args.path || '')
    const oldStr = String(args.old_string ?? '')
    const newStr = String(args.new_string ?? '')
    if (!path || !oldStr) return '错误：缺少 path 或 old_string 参数'
    try {
      const content = await fs.readFile(path, 'utf-8')
      const count = content.split(oldStr).length - 1
      if (count === 0) return `错误：未在文件中找到指定文本（前 40 字符："${oldStr.slice(0, 40)}"）`
      if (count > 1) return `错误：找到 ${count} 处匹配，old_string 必须唯一。请提供更长的上下文以唯一定位。`
      const updated = content.replace(oldStr, newStr)
      // 编辑后整文件语法预检：防止一次替换引入语法错误
      const syntaxError = await validateSyntaxBeforeWrite(path, updated)
      if (syntaxError) return syntaxError
      await fs.writeFile(path, updated, 'utf-8')
      return `已编辑 ${path}`
    } catch (e: any) {
      return `错误：${e?.message || String(e)}`
    }
  }
}

/** bash：执行终端命令。跨平台：Windows 走 cmd（GBK），POSIX 尊重 $SHELL（bash/zsh/fish，UTF-8）。 */
const bashTool: BuiltinTool = {
  name: 'bash',
  description: '执行终端命令并返回输出。Windows 使用 cmd.exe，macOS/Linux 使用 $SHELL 探测的 shell（bash/zsh/fish）。参数：command（命令字符串）、cwd（工作目录，默认工作区根）、timeoutMs（超时毫秒，默认 300000）。',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的命令' },
      cwd: { type: 'string', description: '工作目录（建议在工作区内）' },
      timeoutMs: { type: 'number', description: '超时毫秒，默认 300000' }
    },
    required: ['command']
  },
  run: (args, workspace, signal) => new Promise((resolve) => {
    const command = String(args.command || '')
    const cwd = String(args.cwd || workspace || '') || undefined
    const timeoutMs = Number(args.timeoutMs) || 300000
    if (!command) { resolve('错误：缺少 command 参数'); return }
    // 复用 shellProbe：尊重 $SHELL/ComSpec，POSIX 下用 zsh 也能跑
    const profile = resolveShellProfile(process.platform, process.env, (p) => existsSync(p))
    // 一次性执行：cmd 用 /c，POSIX/fish 用 -c（fish 同样支持 -c）
    const args2 = profile.kind === 'cmd' ? ['/c', command] : ['-c', command]
    // POSIX 下 detached 让子进程成为进程组组长，便于 abort 时整组 SIGKILL
    const proc = spawn(profile.command, args2, {
      cwd,
      windowsHide: true,
      detached: process.platform !== 'win32'
    })
    let output = ''
    let settled = false
    const done = (text: string) => { if (!settled) { settled = true; resolve(text) } }
    // 2.2 用户停止 → 真杀进程树（Windows taskkill /T /F；POSIX 进程组）
    const killTree = () => {
      if (settled) return
      settled = true
      try {
        if (process.platform === 'win32') {
          exec(`taskkill /pid ${proc.pid} /T /F`, () => {})
        } else {
          process.kill(-proc.pid!, 'SIGKILL')
        }
      } catch { /* 进程已退出 */ }
      resolve(`⚠ 已被用户中止\n${output.slice(0, OUTPUT_LIMIT)}`)
    }
    if (signal) {
      if (signal.aborted) { killTree(); return }
      signal.addEventListener('abort', killTree, { once: true })
    }
    // cmd 走 GBK 转码（中文 Windows 默认代码页）；其余 UTF-8
    const useGbk = profile.encoding === 'gbk'
    const decoder = useGbk ? iconv.decodeStream('gbk') : null
    if (decoder) decoder.on('data', (s: string) => { output += s })
    proc.stdout?.on('data', (c: Buffer) => {
      if (decoder) decoder.write(c)
      else output += c.toString('utf-8')
    })
    proc.stderr?.on('data', (c: Buffer) => {
      output += useGbk ? iconv.decode(c, 'gbk') : c.toString('utf-8')
    })
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL') } catch {}
      done(`错误：命令超时（${timeoutMs / 1000}s）\n已输出：\n${output.slice(0, OUTPUT_LIMIT)}`)
    }, timeoutMs)
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (decoder) decoder.end()
      const tail = output.length > OUTPUT_LIMIT
        ? output.slice(0, OUTPUT_LIMIT) + '\n...(已截断)'
        : output
      done(`退出码 ${code}\n${tail}`)
    })
    proc.on('error', (e) => {
      clearTimeout(timer)
      done(`错误：${e.message}`)
    })
  })
}

/** 递归遍历目录，跳过 IGNORE_DIRS 和隐藏目录 */
async function* walk(dir: string): AsyncGenerator<string> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true }) as import('node:fs').Dirent[]
  } catch {
    return
  }
  for (const e of entries) {
    const name = String(e.name)
    const full = join(dir, name)
    if (e.isDirectory()) {
      if (IGNORE_DIRS.has(name) || name.startsWith('.')) continue
      yield* walk(full)
    } else {
      yield full
    }
  }
}

/** 把搜索结果行格式化为工具返回文本 */
function formatGrepResults(lines: string[]): string {
  return lines.length === 0
    ? '未找到匹配'
    : `找到 ${lines.length} 处匹配（上限 ${GREP_LIMIT}）：\n${lines.join('\n')}`
}

/**
 * grep 的 ripgrep 实现：委托 runContentSearch（与全局搜索面板同引擎）。
 * @returns 结果文本；rg 缺失或启动失败时返回 null，由调用方回退 walk
 */
async function grepWithRg(root: string, pattern: string, globFilter: string): Promise<string | null> {
  try {
    // grep 工具口径：正则模式、忽略大小写；旧 glob 参数是「文件名包含」语义，
    // 映射为 rg 的 include glob：*片段*
    const search = await runContentSearch(root, {
      query: pattern,
      caseSensitive: false,
      wholeWord: false,
      regexMode: true,
      includes: globFilter ? [`*${globFilter}*`] : [],
      excludes: []
    })
    const lines: string[] = []
    for (const group of search.groups) {
      const rel = relative(root, group.path).split(sep).join('/')
      for (const m of group.matches) {
        lines.push(`${rel}:${m.lineNumber}: ${m.preview.trim().slice(0, 200)}`)
        if (lines.length >= GREP_LIMIT) break
      }
      if (lines.length >= GREP_LIMIT) break
    }
    return formatGrepResults(lines)
  } catch {
    // rg 不可用（二进制缺失/启动失败等）：交给 walk 回退
    return null
  }
}

/** grep 的 walk 回退实现：逐文件读取 + JS 正则（rg 不可用时兜底） */
async function grepWithWalk(root: string, re: RegExp, globFilter: string): Promise<string> {
  const results: string[] = []
  for await (const file of walk(root)) {
    if (globFilter && !file.toLowerCase().includes(globFilter.toLowerCase())) continue
    try {
      const content = await fs.readFile(file, 'utf-8')
      const lines = content.split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          const rel = relative(root, file).split(sep).join('/')
          results.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`)
          if (results.length >= GREP_LIMIT) break
        }
      }
    } catch {
      // 二进制或无权限文件，跳过
    }
    if (results.length >= GREP_LIMIT) break
  }
  return formatGrepResults(results)
}

/** grep：按正则搜索文件内容，返回匹配行（含文件路径和行号） */
const grepTool: BuiltinTool = {
  name: 'grep',
  description: '内容搜索：在工作区递归搜索匹配正则的文件内容行。参数：pattern（正则字符串）、path（搜索根，默认工作区）、glob（文件名过滤，可选）。',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '正则表达式' },
      path: { type: 'string', description: '搜索根目录，默认工作区' },
      glob: { type: 'string', description: '文件名过滤（包含匹配），可选' }
    },
    required: ['pattern']
  },
  run: async (args, workspace) => {
    const pattern = String(args.pattern || '')
    const root = String(args.path || workspace || '')
    const globFilter = String(args.glob || '')
    if (!pattern) return '错误：缺少 pattern 参数'
    if (!root) return '错误：缺少 path 参数且无工作区'
    let re: RegExp
    try { re = new RegExp(pattern, 'i') } catch { return `错误：无效正则 ${pattern}` }
    // 优先 ripgrep（快、与搜索面板同源）；不可用时回退 walk
    const rgResult = await grepWithRg(root, pattern, globFilter)
    if (rgResult !== null) return rgResult
    return grepWithWalk(root, re, globFilter)
  }
}

/** glob：按 glob 模式搜索文件路径 */
const globTool: BuiltinTool = {
  name: 'glob',
  description: '文件搜索：按 glob 模式匹配工作区文件路径。参数：pattern（如 **/*.vue 或 src/**/*.ts）、path（搜索根，默认工作区）。',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'glob 模式，如 **/*.vue' },
      path: { type: 'string', description: '搜索根目录，默认工作区' }
    },
    required: ['pattern']
  },
  run: async (args, workspace) => {
    const pattern = String(args.pattern || '')
    const root = String(args.path || workspace || '')
    if (!pattern) return '错误：缺少 pattern 参数'
    if (!root) return '错误：缺少 path 参数且无工作区'
    // 简易 glob→正则：** 匹配任意路径，* 匹配非分隔符，? 匹配单字符
    const regexStr = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '{{REC}}')
      .replace(/\*/g, '[^/\\\\]*')
      .replace(/\?/g, '[^/\\\\]')
      .replace(/\{\{REC\}\}/g, '.*')
    let re: RegExp
    try { re = new RegExp(`^${regexStr}$`, 'i') } catch { return `错误：无效 pattern ${pattern}` }
    const results: string[] = []
    for await (const file of walk(root)) {
      const rel = relative(root, file).split(sep).join('/')
      if (re.test(rel)) {
        results.push(rel)
        if (results.length >= GLOB_LIMIT) break
      }
    }
    return results.length === 0
      ? '未找到文件'
      : `找到 ${results.length} 个文件（上限 ${GLOB_LIMIT}）：\n${results.join('\n')}`
  }
}

/** probe_environment：探测本机可用运行时（python/node/go/rustc/docker/git/java 版本）。
 *  有会话级缓存（10 分钟），AI 主动刷新可传 refresh=true。返回结构化 JSON + 中文摘要。
 *  规划阶段系统提示词已自动注入环境摘要，本工具主要供 AI 运行中确认或刷新。 */
const probeEnvironmentTool: BuiltinTool = {
  name: 'probe_environment',
  description:
    '探测本机已安装的运行时及其版本（Python、Node.js、Go、Rust、Docker、Git、Java）。' +
    '参数：refresh（可选，true 时强制重新探测，忽略缓存）。返回 JSON：可用运行时+版本、未安装清单。' +
    '规划前系统已自动注入环境摘要，本工具用于运行中刷新或确认特定运行时。',
  inputSchema: {
    type: 'object',
    properties: {
      refresh: { type: 'boolean', description: '是否强制重新探测（忽略缓存），默认 false' }
    }
  },
  run: async (args) => {
    const refresh = args.refresh === true
    try {
      const report = await getEnvironmentReport(refresh)
      // 返回结构化 JSON（易解析）+ 中文摘要（易读）
      return JSON.stringify(report, null, 2) + '\n\n' + formatEnvironmentReport(report)
    } catch (e: any) {
      return `错误：环境探测失败 ${e?.message || String(e)}`
    }
  }
}

/** s42 find_references：查符号定义与全仓引用（改既有函数/类前必须先调用） */
const findReferencesTool: BuiltinTool = {
  name: 'find_references',
  description:
    '查找符号（函数/类/常量等）的定义位置与全仓引用清单。修改或删除既有符号前必须先调用本工具，确认所有调用方。参数：symbol（符号名）、path（搜索根，默认工作区）。',
  inputSchema: {
    type: 'object',
    properties: {
      symbol: { type: 'string', description: '符号名（函数/类/常量等）' },
      path: { type: 'string', description: '搜索根目录，默认工作区' }
    },
    required: ['symbol']
  },
  run: async (args, workspace) => {
    const symbol = String(args.symbol || '')
    const root = String(args.path || workspace || '')
    if (!symbol) return '错误：缺少 symbol 参数'
    if (!root) return '错误：缺少 path 参数且无工作区'
    try {
      const { index } = await ensureIndex(root)
      const { defs, refs } = await findReferences(root, index, symbol)
      return formatReferenceReport(symbol, defs, refs)
    } catch (e: any) {
      return `错误：${e?.message || String(e)}`
    }
  }
}

/** s42 symbol_outline：单文件符号大纲（函数/类/常量清单 + 行号） */
const symbolOutlineTool: BuiltinTool = {
  name: 'symbol_outline',
  description:
    '输出单文件的符号大纲（函数/类/常量清单及行号），快速了解文件结构。参数：path（相对工作区的文件路径）。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对工作区的文件路径，如 src/main.ts' }
    },
    required: ['path']
  },
  run: async (args, workspace) => {
    const rel = String(args.path || '')
    if (!rel) return '错误：缺少 path 参数'
    if (!workspace) return '错误：无工作区'
    try {
      const { index } = await ensureIndex(workspace)
      return symbolOutline(index, rel)
    } catch (e: any) {
      return `错误：${e?.message || String(e)}`
    }
  }
}

/** s43 set_anchors：设置 spec 锚点（禁改路径/不可删符号），写盘 .trae/anchors.json */
const setAnchorsTool: BuiltinTool = {
  name: 'set_anchors',
  description:
    '设置本任务的 spec 锚点约束：禁改路径清单与不可删除符号清单，设置后系统会阻断违反约束的文件改动。参数：protectedPaths（字符串数组，路径后缀或目录前缀，如 ["src/core/engine.ts","config/"]）、protectedSymbols（对象数组 [{name, path?}]）、notes（备注，可选）。传空数组清除对应清单。',
  inputSchema: {
    type: 'object',
    properties: {
      protectedPaths: {
        type: 'array',
        items: { type: 'string' },
        description: '禁改路径清单（后缀段或目录前缀匹配）'
      },
      protectedSymbols: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            path: { type: 'string', description: '限定文件（缺省=任意文件同名符号）' }
          },
          required: ['name']
        },
        description: '不可删除的符号清单'
      },
      notes: { type: 'string', description: '人工备注（可选）' }
    }
  },
  run: async (args, workspace) => {
    if (!workspace) return '错误：无工作区'
    const anchors: AnchorsFile = {}
    if (Array.isArray(args.protectedPaths)) {
      anchors.protectedPaths = args.protectedPaths.filter((p): p is string => typeof p === 'string' && p.length > 0)
    }
    if (Array.isArray(args.protectedSymbols)) {
      anchors.protectedSymbols = args.protectedSymbols.filter(
        (s): s is { name: string; path?: string } => !!s && typeof s === 'object' && typeof (s as any).name === 'string'
      )
    }
    if (typeof args.notes === 'string' && args.notes) anchors.notes = args.notes
    try {
      await saveAnchors(workspace, anchors)
      const n = (anchors.protectedPaths?.length ?? 0) + (anchors.protectedSymbols?.length ?? 0)
      return `已设置 spec 锚点（${n} 条约束），将阻断违反约束的改动。${n === 0 ? '当前为空清单（等于清除锚点）。' : ''}`
    } catch (e: any) {
      return `错误：锚点写入失败 ${e?.message || String(e)}`
    }
  }
}

/** s43 check_alignment：对齐检查——输出当前锚点清单与受保护路径存在性 */
const checkAlignmentTool: BuiltinTool = {
  name: 'check_alignment',
  description:
    '对齐检查：输出当前 spec 锚点清单（禁改路径/不可删符号）及各受保护路径在磁盘上的存在性。长任务中途可随时调用本工具自查是否偏离约束。无参数。',
  inputSchema: { type: 'object', properties: {} },
  run: async (_args, workspace) => {
    if (!workspace) return '错误：无工作区'
    try {
      const anchors = await loadAnchors(workspace)
      return formatAnchorSummary(anchors, (rel) => existsSync(join(workspace, rel)))
    } catch (e: any) {
      return `错误：${e?.message || String(e)}`
    }
  }
}

/** s46 gen_test_skeleton：按源码导出函数生成 vitest 用例骨架（AI 填断言后用 write 落盘入暂存） */
const genTestSkeletonTool: BuiltinTool = {
  name: 'gen_test_skeleton',
  description:
    '为指定源码文件生成 vitest 测试骨架（describe + it.todo 占位），覆盖其导出函数。' +
    '「为改动补测试」时使用：拿到骨架后填充断言，再用 write 工具写入返回中建议的测试路径。' +
    '参数：path（相对工作区的源码文件路径，如 src/util.ts）。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对工作区的源码文件路径' }
    },
    required: ['path']
  },
  run: async (args, workspace) => {
    const rel = String(args.path || '')
    if (!rel) return '错误：缺少 path 参数'
    if (!workspace) return '错误：无工作区'
    const abs = join(workspace, rel)
    try {
      const content = await fs.readFile(abs, 'utf-8')
      const parsed = parseFileContent(rel, content)
      const skel = buildTestSkeleton(rel, parsed.symbols)
      if (!skel) return `文件 ${rel} 没有可生成骨架的导出函数（类/接口/类型请人工设计用例）`
      const testRel = testFileFor(rel)
      return (
        `测试骨架已生成。请填充断言后用 write 工具写入：${testRel}\n` +
        `（该文件将先进入暂存区，由用户审阅后落盘）\n\n` +
        skel
      )
    } catch (e: any) {
      return `错误：${e?.message || String(e)}`
    }
  }
}

/** s54 make_chart：读实验数据(CSV/TSV/JSON) → 学术 SVG 图表，落盘并内联回对话 */
const makeChartTool: BuiltinTool = {
  name: 'make_chart',
  description:
    '把实验输出的数据文件（.csv/.tsv/.json）渲染为学术规范图表（折线/柱状/散点），' +
    '图表自动落盘到 .trae/charts/ 并内联显示在对话中，可在生成报告时引用。' +
    '参数：dataFile（相对工作区路径）、type（line/bar/scatter）、title、x（X 轴列名）、' +
    'y（Y 轴列名数组，可多系列）、xLabel/yLabel/seriesNames（可选）。',
  inputSchema: {
    type: 'object',
    properties: {
      dataFile: { type: 'string', description: '相对工作区的数据文件路径，如 results/acc.csv' },
      type: { type: 'string', enum: ['line', 'bar', 'scatter'], description: '图表类型' },
      title: { type: 'string', description: '图表标题' },
      x: { type: 'string', description: 'X 轴数据列名' },
      y: {
        type: 'array',
        items: { type: 'string' },
        description: 'Y 轴数据列名，多系列给多个'
      },
      xLabel: { type: 'string', description: 'X 轴标题（缺省用列名）' },
      yLabel: { type: 'string', description: 'Y 轴标题（缺省用列名）' },
      seriesNames: { type: 'array', items: { type: 'string' }, description: '系列显示名' }
    },
    required: ['dataFile', 'type', 'title', 'x', 'y']
  },
  run: async (args, workspace) => {
    const rel = String(args.dataFile || '')
    const type = String(args.type || '') as ChartType
    const title = String(args.title || '')
    const x = String(args.x || '')
    const y = Array.isArray(args.y) ? args.y.map(String) : []
    if (!rel || !type || !title || !x || y.length === 0) {
      return '错误：缺少必填参数（dataFile/type/title/x/y）'
    }
    if (!workspace) return '错误：无工作区'
    if (!['line', 'bar', 'scatter'].includes(type)) return `错误：未知图表类型 ${type}`
    // 路径越界校验
    const abs = join(workspace, rel)
    if (relative(workspace, abs).startsWith('..') || sep === '/' && rel.startsWith('/')) {
      return '错误：数据文件路径越出工作区'
    }
    try {
      const text = await fs.readFile(abs, 'utf-8')
      const table = parseDataFile(rel, text)
      const svg = renderSvgChart(table, {
        type, title, x, y,
        xLabel: args.xLabel ? String(args.xLabel) : undefined,
        yLabel: args.yLabel ? String(args.yLabel) : undefined,
        seriesNames: Array.isArray(args.seriesNames) ? args.seriesNames.map(String) : undefined
      })
      // 落盘 .trae/charts（供报告引用）
      const stamp = Date.now().toString(36)
      const slug = title.replace(/[^\w一-龥-]+/g, '_').slice(0, 40) || 'chart'
      const outRel = `.trae/charts/${slug}-${stamp}.svg`
      const outAbs = join(workspace, outRel)
      await fs.mkdir(dirname(outAbs), { recursive: true })
      await fs.writeFile(outAbs, svg, 'utf-8')
      // 内联 data URL 让对话直接渲染（SVG 体积可控）+ 附落盘路径
      return (
        `图表「${title}」已生成（${table.rows.length} 行数据），保存于 ${outRel}。\n\n` +
        `![${title}](${svgToDataUrl(svg)})`
      )
    } catch (e: any) {
      const colHint = /列不存在/.test(e?.message || '')
        ? '（请先用 read 查看数据表头，确认 x/y 列名）'
        : ''
      return `错误：图表生成失败 ${e?.message || String(e)}${colHint}`
    }
  }
}

/** 全部内置工具注册表：核心六工具 + 符号导航/锚点 + 测试骨架 + 扩展工具 */
const BUILTIN_TOOLS: BuiltinTool[] = [
  readTool, writeTool, editTool, bashTool, grepTool, globTool, probeEnvironmentTool,
  findReferencesTool, symbolOutlineTool, setAnchorsTool, checkAlignmentTool, genTestSkeletonTool,
  makeChartTool,
  ...EXTRA_TOOLS
]

/** 返回全部内置工具（供调度器与 MCP 工具合并后喂给模型） */
export function collectBuiltinTools(): BuiltinTool[] {
  return BUILTIN_TOOLS
}

/** 判断是否为内置工具名（调度器据此决定优先走内置还是 MCP） */
export function isBuiltinTool(name: string): boolean {
  return BUILTIN_TOOLS.some((t) => t.name === name)
}

/** 调用内置工具，返回字符串结果 */
export async function callBuiltinTool(
  name: string,
  args: Record<string, unknown>,
  workspace?: string | null,
  signal?: AbortSignal
): Promise<string> {
  const tool = BUILTIN_TOOLS.find((t) => t.name === name)
  if (!tool) return `错误：未知内置工具 ${name}`
  try {
    return await tool.run(args, workspace, signal)
  } catch (e: any) {
    return `错误：${e?.message || String(e)}`
  }
}
