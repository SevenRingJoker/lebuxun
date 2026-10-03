// 扩展内置工具：delete/move/copy/web_fetch/web_search/run_script/git/npm_info。
// 与核心六工具（builtinTools.ts）同级注册，经 mcpToolBridge 合并喂给模型，
// 执行前统一过 permissions.ts 权限闸与审计。零 electron 依赖，纯 Node 可单测。
import { promises as fs } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { spawn, exec } from 'node:child_process'
import iconv from 'iconv-lite'
import type { BuiltinTool } from './builtinTools'
import { DEBUG_TOOLS } from './builtinToolsDebug'

// 输出截断阈值，与核心工具保持一致，避免挤占模型上下文窗口
const OUTPUT_LIMIT = 6000
// 网络抓取限制：15s 超时、512KB 原始体、正文截断 100KB、重定向 ≤3
const FETCH_TIMEOUT = 15000
const FETCH_RAW_LIMIT = 512 * 1024
const FETCH_TEXT_LIMIT = 100 * 1024
const MAX_REDIRECTS = 3

// ---------------- 纯函数：HTML 处理 ----------------

/** HTML → 纯文本：去 script/style/注释/标签，解常用实体，压缩空白 */
export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim()
}

/** DDG 跳转链接解码：/l/?uddg=<urlencoded> → 真实 URL；直链原样返回 */
export function decodeDuckUrl(href: string): string {
  const m = /[?&]uddg=([^&]+)/.exec(href)
  if (m) {
    try { return decodeURIComponent(m[1]) } catch { return '' }
  }
  return /^https?:\/\//i.test(href) ? href : ''
}

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

/** 解析 DuckDuckGo HTML 端点结果页：标题/链接/摘要按序配对 */
export function parseSearchResults(html: string, limit = 8): SearchResult[] {
  const snippets: string[] = []
  const snipRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = snipRe.exec(html))) snippets.push(stripHtml(m[1]))
  const out: SearchResult[] = []
  const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi
  while ((m = linkRe.exec(html)) && out.length < limit) {
    const url = decodeDuckUrl(m[1])
    const title = stripHtml(m[2])
    if (!url || !title) continue
    out.push({ title, url, snippet: snippets[out.length] || '' })
  }
  return out
}

// ---------------- 纯函数：run_script 白名单 ----------------

// 允许的脚本名：test/lint/build/typecheck/check/compile 及其 :子命令（如 build:web）
const ALLOWED_SCRIPT_RE = /^(test|lint|build|typecheck|check|compile)(:[\w-]+)?$/

/** 脚本名是否在白名单内（不校验是否存在于 package.json） */
export function isAllowedScriptName(name: string): boolean {
  return ALLOWED_SCRIPT_RE.test(name)
}

/** 解析 package.json 的 scripts 字段；JSON 损坏返回 null，无 scripts 返回 {} */
export function parsePackageScripts(jsonText: string): Record<string, string> | null {
  try {
    const pkg = JSON.parse(jsonText)
    if (pkg && typeof pkg === 'object' && pkg.scripts && typeof pkg.scripts === 'object') {
      return pkg.scripts as Record<string, string>
    }
    return {}
  } catch {
    return null
  }
}

// ---------------- 纯函数：git 参数白名单 ----------------

// 允许的 git 子命令：覆盖日常读写，排除 push/reset/rebase/merge/clean/submodule 等高风险操作
const GIT_ALLOWED_SUBCOMMANDS = new Set([
  'status', 'diff', 'log', 'show', 'branch', 'add', 'commit',
  'checkout', 'restore', 'stash', 'rev-parse', 'ls-files', 'remote', 'tag'
])
// 白名单子命令下仍需禁止的破坏性旗标
const GIT_FORBIDDEN_FLAGS = /^(--hard|--force|--delete|--no-verify|--exec|--upload-pack|-f|-D)$/

/** 校验 git 参数数组；stash 仅允许 list 子操作（裸 stash 会修改工作区） */
export function validateGitArgs(args: string[]): { ok: boolean; reason?: string } {
  if (args.length === 0) return { ok: false, reason: '缺少 git 子命令' }
  const sub = args[0]
  if (!GIT_ALLOWED_SUBCOMMANDS.has(sub)) {
    return { ok: false, reason: `不允许的 git 子命令：${sub}（白名单：${Array.from(GIT_ALLOWED_SUBCOMMANDS).join('/')}）` }
  }
  if (sub === 'stash' && args[1] !== 'list') {
    return { ok: false, reason: 'stash 仅允许 list 子操作' }
  }
  for (const a of args.slice(1)) {
    if (GIT_FORBIDDEN_FLAGS.test(a)) {
      return { ok: false, reason: `不允许的 git 参数：${a}` }
    }
  }
  return { ok: true }
}

// ---------------- 纯函数：npm registry ----------------

/** 构造 registry 最新版本查询 URL；非法包名返回 null（支持 @scope/pkg） */
export function npmRegistryUrl(name: string): string | null {
  if (!/^(?:@[\w.-]+\/)?[\w.-]+$/.test(name)) return null
  return 'https://registry.npmjs.org/' + name.replace('/', '%2f') + '/latest'
}

/** 解析 registry /latest 响应：版本/描述/license */
export function parseNpmRegistry(
  jsonText: string
): { version: string; description?: string; license?: string } | null {
  try {
    const j = JSON.parse(jsonText)
    if (!j || typeof j.version !== 'string') return null
    const license =
      typeof j.license === 'string' ? j.license
        : j.license && typeof j.license.type === 'string' ? j.license.type
          : undefined
    return {
      version: j.version,
      description: typeof j.description === 'string' ? j.description : undefined,
      license
    }
  } catch {
    return null
  }
}

// ---------------- 网络抓取（fetcher 可注入，便于假 fetch 单测） ----------------

export type FetchLike = (url: string, init?: any) => Promise<any>

interface RawFetchResult {
  status: number
  type: string
  text: string
}

/** 手动跟随重定向（≤3 次）抓取原始文本；失败返回错误描述字符串 */
async function fetchRaw(
  url: string,
  fetcher: FetchLike = (globalThis as any).fetch
): Promise<RawFetchResult | string> {
  if (typeof fetcher !== 'function') return '错误：当前运行环境不支持 fetch'
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT)
    let res: any
    try {
      res = await fetcher(current, {
        signal: ctrl.signal,
        redirect: 'manual',
        headers: {
          'User-Agent': 'Mozilla/5.0 ScholarTreaCode/1.0',
          Accept: 'text/html,text/plain,application/json,*/*'
        }
      })
    } catch (e: any) {
      clearTimeout(timer)
      return `错误：请求失败 ${e?.name === 'AbortError' ? '（超时 15s）' : e?.message || String(e)}`
    }
    clearTimeout(timer)
    const status = Number(res?.status) || 0
    if (status >= 300 && status < 400) {
      const loc = res.headers?.get?.('location')
      if (!loc) return `错误：HTTP ${status} 缺少 Location 头`
      try {
        current = new URL(loc, current).toString()
      } catch {
        return `错误：无效重定向地址 ${loc}`
      }
      continue
    }
    let text = ''
    try {
      text = await res.text()
    } catch (e: any) {
      return `错误：读取响应失败 ${e?.message || String(e)}`
    }
    if (text.length > FETCH_RAW_LIMIT) text = text.slice(0, FETCH_RAW_LIMIT)
    return { status, type: String(res.headers?.get?.('content-type') || ''), text }
  }
  return `错误：重定向次数过多（>${MAX_REDIRECTS}）`
}

/** 抓取 URL 并转为模型可消费文本（HTML 剥离标签）；错误以字符串返回 */
export async function webFetchText(url: string, fetcher?: FetchLike): Promise<string> {
  if (!/^https?:\/\//i.test(url)) return '错误：仅支持 http/https URL'
  const raw = await fetchRaw(url, fetcher)
  if (typeof raw === 'string') return raw
  if (raw.status < 200 || raw.status >= 300) return `错误：HTTP ${raw.status}`
  let text = raw.text
  if (text.length > FETCH_TEXT_LIMIT) text = text.slice(0, FETCH_TEXT_LIMIT) + '\n...(已截断)'
  return /html/i.test(raw.type) ? stripHtml(text) : text
}

/** DuckDuckGo 搜索（免 API Key），返回编号结果列表 */
export async function webSearch(query: string, fetcher?: FetchLike): Promise<string> {
  const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query)
  const raw = await fetchRaw(url, fetcher)
  if (typeof raw === 'string') return raw
  if (raw.status !== 200) return `错误：搜索请求失败 HTTP ${raw.status}`
  const results = parseSearchResults(raw.text)
  if (results.length === 0) return '未找到结果'
  return results
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`)
    .join('\n')
}

// ---------------- 进程执行辅助（npm/git 共用） ----------------

/** spawn 收集输出；Windows 下可选 GBK 转码（cmd 输出），git 固定 UTF-8。signal abort 时真杀进程树。 */
function spawnCollect(
  cmd: string,
  args: string[],
  cwd: string | undefined,
  timeoutMs: number,
  gbk: boolean,
  signal?: AbortSignal
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    // POSIX 下 detached 让子进程成为进程组组长，abort 时才能整组 SIGKILL
    const proc = spawn(cmd, args, { cwd, windowsHide: true, detached: process.platform !== 'win32' })
    let output = ''
    let settled = false
    const done = (code: number, text: string) => { if (!settled) { settled = true; resolve({ code, output: text }) } }
    // 2.2 用户停止 → 真杀进程树
    if (signal) {
      const onAbort = () => {
        if (settled) return
        settled = true
        try {
          if (process.platform === 'win32') {
            exec(`taskkill /pid ${proc.pid} /T /F`, () => {})
          } else {
            process.kill(-proc.pid!, 'SIGKILL')
          }
        } catch {}
        resolve({ code: -1, output: `⚠ 已被用户中止\n${output.slice(0, OUTPUT_LIMIT)}` })
      }
      if (signal.aborted) { onAbort(); return }
      signal.addEventListener('abort', onAbort, { once: true })
    }
    const useGbk = gbk && process.platform === 'win32'
    // cmd.exe 默认 GBK 代码页，decodeStream 处理跨 chunk 双字节中文
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
      done(-1, output + `\n(超时 ${Math.round(timeoutMs / 1000)}s，已终止)`)
    }, timeoutMs)
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (decoder) decoder.end()
      done(code ?? -1, output)
    })
    proc.on('error', (e) => {
      clearTimeout(timer)
      done(-1, e.message)
    })
  })
}

function clipOutput(output: string): string {
  return output.length > OUTPUT_LIMIT ? output.slice(0, OUTPUT_LIMIT) + '\n...(已截断)' : output
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}

// ---------------- 工具定义 ----------------

/** delete：移入工作区 .trae/trash/（时间戳前缀），可恢复，不硬删 */
const deleteTool: BuiltinTool = {
  name: 'delete',
  description: '删除文件或目录：移入工作区 .trae/trash/ 回收站（可恢复），不做永久删除。参数：path（绝对路径，须在工作区内）。',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string', description: '要删除的文件/目录绝对路径' } },
    required: ['path']
  },
  run: async (args, workspace) => {
    const target = String(args.path || '')
    if (!target) return '错误：缺少 path 参数'
    if (!workspace) return '错误：delete 需要已打开的工作区（回收站位于 .trae/trash）'
    try {
      if (!(await pathExists(target))) return `错误：目标不存在 ${target}`
      const trashDir = join(workspace, '.trae', 'trash')
      await fs.mkdir(trashDir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      // 防重名：同秒多次删除同名文件时追加序号
      let dest = join(trashDir, `${stamp}-${basename(target)}`)
      for (let n = 1; await pathExists(dest); n++) {
        dest = join(trashDir, `${stamp}-${basename(target)}-${n}`)
      }
      try {
        await fs.rename(target, dest)
      } catch (e: any) {
        // 跨设备回退：复制后删除
        if (e?.code !== 'EXDEV') throw e
        await fs.cp(target, dest, { recursive: true })
        await fs.rm(target, { recursive: true, force: true })
      }
      return `已删除 ${target}（移入回收站 .trae/trash/${basename(dest)}，可恢复）`
    } catch (e: any) {
      return `错误：${e?.message || String(e)}`
    }
  }
}

/** move：移动/重命名，自动建父目录，目标已存在则拒绝 */
const moveTool: BuiltinTool = {
  name: 'move',
  description: '移动或重命名文件/目录（自动创建父目录，目标已存在则拒绝）。参数：source（源绝对路径）、destination（目标绝对路径）。',
  inputSchema: {
    type: 'object',
    properties: {
      source: { type: 'string', description: '源文件/目录绝对路径' },
      destination: { type: 'string', description: '目标绝对路径' }
    },
    required: ['source', 'destination']
  },
  run: async (args) => {
    const src = String(args.source || '')
    const dst = String(args.destination || '')
    if (!src || !dst) return '错误：缺少 source 或 destination 参数'
    try {
      if (!(await pathExists(src))) return `错误：源不存在 ${src}`
      if (await pathExists(dst)) return `错误：目标已存在 ${dst}`
      await fs.mkdir(dirname(dst), { recursive: true })
      try {
        await fs.rename(src, dst)
      } catch (e: any) {
        if (e?.code !== 'EXDEV') throw e
        await fs.cp(src, dst, { recursive: true })
        await fs.rm(src, { recursive: true, force: true })
      }
      return `已移动 ${src} → ${dst}`
    } catch (e: any) {
      return `错误：${e?.message || String(e)}`
    }
  }
}

/** copy：递归复制，自动建父目录，目标已存在则拒绝 */
const copyTool: BuiltinTool = {
  name: 'copy',
  description: '复制文件或目录（递归，自动创建父目录，目标已存在则拒绝）。参数：source（源绝对路径）、destination（目标绝对路径）。',
  inputSchema: {
    type: 'object',
    properties: {
      source: { type: 'string', description: '源文件/目录绝对路径' },
      destination: { type: 'string', description: '目标绝对路径' }
    },
    required: ['source', 'destination']
  },
  run: async (args) => {
    const src = String(args.source || '')
    const dst = String(args.destination || '')
    if (!src || !dst) return '错误：缺少 source 或 destination 参数'
    try {
      if (!(await pathExists(src))) return `错误：源不存在 ${src}`
      if (await pathExists(dst)) return `错误：目标已存在 ${dst}`
      await fs.mkdir(dirname(dst), { recursive: true })
      await fs.cp(src, dst, { recursive: true })
      return `已复制 ${src} → ${dst}`
    } catch (e: any) {
      return `错误：${e?.message || String(e)}`
    }
  }
}

/** web_fetch：抓取 URL 转纯文本 */
const webFetchTool: BuiltinTool = {
  name: 'web_fetch',
  description: '抓取网页/接口内容（HTML 自动剥离为纯文本，仅 http/https，15s 超时，正文截断 100KB）。参数：url。',
  inputSchema: {
    type: 'object',
    properties: { url: { type: 'string', description: '要抓取的 http/https URL' } },
    required: ['url']
  },
  run: async (args) => {
    const url = String(args.url || '')
    if (!url) return '错误：缺少 url 参数'
    return webFetchText(url)
  }
}

/** web_search：DuckDuckGo 免 Key 搜索 */
const webSearchTool: BuiltinTool = {
  name: 'web_search',
  description: '联网搜索（DuckDuckGo，无需 API Key），返回编号结果列表（标题/链接/摘要）。参数：query。',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string', description: '搜索关键词' } },
    required: ['query']
  },
  run: async (args) => {
    const q = String(args.query || '')
    if (!q) return '错误：缺少 query 参数'
    return webSearch(q)
  }
}

/** run_script：package.json 白名单脚本（test/lint/build/typecheck/check/compile 前缀） */
const runScriptTool: BuiltinTool = {
  name: 'run_script',
  description: '运行工作区 package.json 中的白名单脚本（仅 test/lint/build/typecheck/check/compile 及其 :子命令）。参数：name（脚本名）、cwd（工作目录，默认工作区根）、timeoutMs（默认 300000，上限 600000）。',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '脚本名，如 test、build、lint:fix' },
      cwd: { type: 'string', description: '工作目录（须在工作区内），默认工作区根' },
      timeoutMs: { type: 'number', description: '超时毫秒，默认 300000' }
    },
    required: ['name']
  },
  run: async (args, workspace, signal) => {
    const name = String(args.name || '')
    const cwd = String(args.cwd || workspace || '') || undefined
    const timeoutMs = Math.min(Number(args.timeoutMs) || 300000, 600000)
    if (!name) return '错误：缺少 name 参数'
    if (!isAllowedScriptName(name)) {
      return `错误：脚本 ${name} 不在白名单（允许 test/lint/build/typecheck/check/compile 前缀）`
    }
    if (!cwd) return '错误：缺少工作区'
    let scripts: Record<string, string> | null
    try {
      scripts = parsePackageScripts(await fs.readFile(join(cwd, 'package.json'), 'utf-8'))
    } catch {
      return `错误：未找到 ${join(cwd, 'package.json')}`
    }
    if (scripts === null) return '错误：package.json 解析失败'
    if (!scripts[name]) {
      return `错误：package.json 中不存在脚本 ${name}（已有：${Object.keys(scripts).join(', ') || '无'}）`
    }
    // Windows 下 npm 是 npm.cmd，需经 cmd /c 调起；输出按 GBK 转码
    const isWin = process.platform === 'win32'
    const r = isWin
      ? await spawnCollect('cmd.exe', ['/c', 'npm', 'run', name], cwd, timeoutMs, true, signal)
      : await spawnCollect('npm', ['run', name], cwd, timeoutMs, false, signal)
    return `退出码 ${r.code}\n${clipOutput(r.output)}`
  }
}

/** git：子命令白名单（status/diff/log/show/branch/add/commit/checkout/restore/stash list 等） */
const gitTool: BuiltinTool = {
  name: 'git',
  description: '执行 git 子命令（白名单：status/diff/log/show/branch/add/commit/checkout/restore/stash list/rev-parse/ls-files/remote/tag；禁止 push/reset/rebase/clean 等破坏性操作）。参数：args（子命令数组，如 ["status","--short"]）、cwd（仓库目录，默认工作区根）。',
  inputSchema: {
    type: 'object',
    properties: {
      args: { type: 'array', items: { type: 'string' }, description: 'git 子命令及参数数组' },
      cwd: { type: 'string', description: '仓库目录（须在工作区内），默认工作区根' }
    },
    required: ['args']
  },
  run: async (args, workspace, signal) => {
    const list = Array.isArray(args.args) ? args.args.map(String) : []
    const cwd = String(args.cwd || workspace || '') || undefined
    if (list.length === 0) return '错误：缺少 args 参数（git 子命令数组，如 ["status","--short"]）'
    if (!cwd) return '错误：缺少工作区'
    const v = validateGitArgs(list)
    if (!v.ok) return `错误：${v.reason}`
    // commit 注入兜底提交身份（与 handlers/git.ts 检查点一致）
    const withIdentity = list[0] === 'commit'
    const finalArgs = [
      '-c', 'core.quotepath=false',
      ...(withIdentity ? ['-c', 'user.name=TraeCode', '-c', 'user.email=traecode@local'] : []),
      ...list
    ]
    const r = await spawnCollect('git', finalArgs, cwd, 60000, false, signal)
    const out = clipOutput(r.output)
    return r.code === 0 ? out || '(无输出)' : `退出码 ${r.code}\n${out}`
  }
}

/** npm_info：直连 registry REST 查询依赖包最新版本/描述/license */
const npmInfoTool: BuiltinTool = {
  name: 'npm_info',
  description: '查询 npm 依赖包最新版本、描述与 license（直连 registry.npmjs.org，不执行本地 npm）。参数：name（包名，支持 @scope/pkg）。',
  inputSchema: {
    type: 'object',
    properties: { name: { type: 'string', description: '包名，如 vue 或 @types/node' } },
    required: ['name']
  },
  run: async (args) => {
    const name = String(args.name || '')
    if (!name) return '错误：缺少 name 参数'
    const url = npmRegistryUrl(name)
    if (!url) return `错误：非法包名 ${name}`
    const raw = await fetchRaw(url)
    if (typeof raw === 'string') return raw
    if (raw.status === 404) return `未找到包 ${name}`
    if (raw.status !== 200) return `错误：registry 返回 HTTP ${raw.status}`
    const info = parseNpmRegistry(raw.text)
    if (!info) return '错误：registry 响应解析失败'
    return `${name}@${info.version}${info.description ? `\n${info.description}` : ''}${info.license ? `\nlicense: ${info.license}` : ''}`
  }
}

/** 扩展内置工具注册表（由 builtinTools.ts 合并进总表） */
export const EXTRA_TOOLS: BuiltinTool[] = [
  ...DEBUG_TOOLS,
  deleteTool,
  moveTool,
  copyTool,
  webFetchTool,
  webSearchTool,
  runScriptTool,
  gitTool,
  npmInfoTool
]
