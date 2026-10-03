// 搜索引擎：ripgrep 内容搜索 + 可预览的批量替换。
//
// 三层能力（供 IPC handler 与 AI grep 工具共同使用）：
// - runContentSearch：spawn rg --json，按文件分组聚合，5000 处上限截断；
// - buildReplacePlan：读文件 → JS 侧替换正则 → 逐行产出 before/after 预览与计数；
// - applyReplace：写回前重读复核匹配数，不一致（文件已被改动）则跳过该文件防误伤。
//
// 替换侧计数/预览/落盘一律用 JS 正则同源计算，不直接复用 rg 的计数，
// 避免 rg 引擎与 JS 引擎细微差异导致「预览 ≠ 落盘」。
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { performance } from 'node:perf_hooks'
import {
  buildRgArgs,
  resolveRgPath,
  RgResultAggregator,
  type RgSearchParams
} from './ripgrep'

/** 搜索超时兜底（毫秒）：正常万文件秒级，60s 仅用于进程异常挂死保护 */
const SEARCH_TIMEOUT_MS = 60_000
/** 单文件替换大小上限（字节）：超过则跳过，避免大块字符串操作卡顿 */
export const MAX_REPLACE_FILE_BYTES = 5 * 1024 * 1024

/** 内容搜索入参 */
export type ContentSearchParams = RgSearchParams

/** 单处匹配（渲染端高亮自行按查询正则做，不依赖 rg 字节列） */
export interface ContentMatch {
  /** 行号（1-based） */
  lineNumber: number
  /** 去行尾的行文本 */
  preview: string
}

/** 文件分组 */
export interface ContentFileGroup {
  /** 绝对路径 */
  path: string
  /** 匹配处数（submatch 口径） */
  matchCount: number
  matches: ContentMatch[]
}

/** 搜索结果 */
export interface ContentSearchResult {
  groups: ContentFileGroup[]
  fileCount: number
  totalMatches: number
  /** 达到 5000 上限被截断 */
  truncated: boolean
  /** 耗时（毫秒） */
  elapsedMs: number
}

/**
 * 执行内容搜索。
 * @param root   搜索根目录（spawn cwd；rg 输出相对路径据此解析）
 * @param params 查询与选项
 */
export function runContentSearch(
  root: string,
  params: ContentSearchParams
): Promise<ContentSearchResult> {
  return new Promise((resolveP, rejectP) => {
    if (!params.query) {
      rejectP(new Error('搜索内容不能为空'))
      return
    }
    const startedAt = performance.now()
    let proc: ChildProcessWithoutNullStreams
    try {
      proc = spawn(resolveRgPath(), buildRgArgs(params), {
        cwd: root,
        windowsHide: true
      })
    } catch (e) {
      rejectP(e instanceof Error ? e : new Error(String(e)))
      return
    }

    const aggregator = new RgResultAggregator(root)
    let stderr = ''
    let lineBuf = ''
    let settled = false

    const guard = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        proc.kill('SIGKILL')
      } catch {}
      rejectP(new Error('搜索超时（60s），已终止'))
    }, SEARCH_TIMEOUT_MS)

    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      // chunk 可能在一行中间截断：缓冲后按 \n 切分
      lineBuf += chunk
      let nl: number
      while ((nl = lineBuf.indexOf('\n')) >= 0) {
        const line = lineBuf.slice(0, nl + 1)
        lineBuf = lineBuf.slice(nl + 1)
        aggregator.ingest(line)
        if (aggregator.reachedLimit()) {
          // 达上限：终止 rg，close 事件中以 truncated 结果正常返回
          try {
            proc.kill()
          } catch {}
          break
        }
      }
    })

    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk: string) => {
      stderr += chunk
      if (stderr.length > 4000) stderr = stderr.slice(0, 4000)
    })

    proc.on('error', err => {
      if (settled) return
      settled = true
      clearTimeout(guard)
      rejectP(err)
    })

    proc.on('close', code => {
      if (settled) return
      settled = true
      clearTimeout(guard)
      // rg 退出码：0 有匹配 / 1 无匹配（正常）/ 2 错误；
      // 截断 kill 在 Windows 上可能给出 null 或 1，均按正常（truncated）处理
      if (code === 2) {
        rejectP(new Error(stderr.trim() || `ripgrep 异常退出（code=${code}）`))
        return
      }
      const groups: ContentFileGroup[] = aggregator.getGroups().map(g => ({
        path: g.path,
        matchCount: g.matchCount,
        matches: g.matches.map(m => ({ lineNumber: m.lineNumber, preview: m.preview }))
      }))
      resolveP({
        groups,
        fileCount: groups.length,
        totalMatches: aggregator.totalMatches,
        truncated: aggregator.truncated,
        elapsedMs: Math.round(performance.now() - startedAt)
      })
    })
  })
}

/** 转义正则元字符（字面量模式） */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 构造替换侧正则（纯函数，regexMode 下非法正则抛带明确信息的错误）。
 * - 字面量模式：转义查询串；
 * - 正则模式：原样使用查询串；
 * - 全字：与 rg -w 的 \w 口径一致，两侧加 [A-Za-z0-9_] 边界环视；
 * - flags：g 全局 + i 忽略大小写 + m 行模式（rg 按行搜索，^/$ 语义需对齐）。
 */
export function buildReplaceRegExp(params: ContentSearchParams): RegExp {
  let source = params.regexMode ? params.query : escapeRegExp(params.query)
  if (params.wholeWord) {
    source = `(?<![A-Za-z0-9_])(?:${source})(?![A-Za-z0-9_])`
  }
  const flags = (params.caseSensitive ? 'g' : 'gi') + 'm'
  try {
    return new RegExp(source, flags)
  } catch (e) {
    throw new Error(`无效的搜索正则：${e instanceof Error ? e.message : String(e)}`)
  }
}

/** UTF-8 BOM 字符（U+FEFF），用转义序列书写避免不可见字符歧义 */
const BOM = String.fromCharCode(0xfeff)

/** 分离文本开头的 BOM（ripgrep 对 BOM 透明处理，替换侧同样剥离后再加回） */
function splitBom(text: string): { hasBom: boolean; body: string } {
  if (text.startsWith(BOM)) return { hasBom: true, body: text.slice(1) }
  return { hasBom: false, body: text }
}

/**
 * 统计文件正文（不含 BOM）中的匹配处数：逐行口径，与 rg 按行搜索一致。
 * String.match 全局正则不累积 lastIndex，可安全复用同一正则对象。
 */
function countBodyMatches(body: string, re: RegExp): number {
  let count = 0
  for (const line of body.split(/\r?\n/)) {
    const hits = line.match(re)
    if (hits) count += hits.length
  }
  return count
}

/** 单行变更预览 */
export interface ReplaceChange {
  /** 行号（1-based） */
  lineNumber: number
  /** 替换前行文本 */
  before: string
  /** 替换后行文本 */
  after: string
}

/** 跳过替换的原因 */
export type ReplaceSkipReason = 'too-large'

/** 单文件替换计划 */
export interface ReplaceFilePlan {
  /** 绝对路径 */
  path: string
  /** JS 正则口径匹配处数 */
  matchCount: number
  /** 实际发生变化的行（替换后文本相同的匹配不计入变更行，但仍在 matchCount 内） */
  changes: ReplaceChange[]
  /** 跳过时标注原因（如文件过大） */
  skipped?: ReplaceSkipReason
}

/** 替换计划入参：搜索参数 + 替换文本（允许空串＝删除匹配） */
export interface ReplacePlanParams extends ContentSearchParams {
  replaceText: string
}

/** 替换计划结果 */
export interface ReplacePlanResult {
  files: ReplaceFilePlan[]
  totalFiles: number
  totalMatches: number
}

/**
 * 为单个文件生成替换计划（读取 + 逐行预览）。
 * 不做 EOL split/join：行尾从行文本中天然剥离，写回时在整文上替换，EOL 原样保留。
 */
async function planFile(
  filePath: string,
  size: number,
  re: RegExp,
  replaceText: string
): Promise<ReplaceFilePlan> {
  if (size > MAX_REPLACE_FILE_BYTES) {
    // 大文件不读取，直接标注跳过（matchCount 无法计算，置 0）
    return { path: filePath, matchCount: 0, changes: [], skipped: 'too-large' }
  }
  const raw = await fs.readFile(filePath, 'utf8')
  const { body } = splitBom(raw)
  const lines = body.split(/\r?\n/)
  const changes: ReplaceChange[] = []
  let matchCount = 0
  for (let i = 0; i < lines.length; i++) {
    const before = lines[i]
    const hits = before.match(re)
    if (!hits) continue
    matchCount += hits.length
    const after = before.replace(re, replaceText)
    if (after !== before) changes.push({ lineNumber: i + 1, before, after })
  }
  return { path: filePath, matchCount, changes }
}

/**
 * 生成整仓替换计划：先搜索确定候选文件，再逐文件产出预览。
 * @param onlyFiles 可选路径过滤（apply 阶段只计划选中文件，避免白读）
 */
export async function buildReplacePlan(
  root: string,
  params: ReplacePlanParams,
  onlyFiles?: string[]
): Promise<ReplacePlanResult> {
  const re = buildReplaceRegExp(params)
  const allow = onlyFiles ? new Set(onlyFiles) : null
  const search = await runContentSearch(root, params)
  const files: ReplaceFilePlan[] = []
  let totalMatches = 0
  for (const group of search.groups) {
    if (allow && !allow.has(group.path)) continue
    let size: number
    try {
      size = (await fs.stat(group.path)).size
    } catch {
      continue // 文件已不存在等竞态：跳过
    }
    const plan = await planFile(group.path, size, re, params.replaceText)
    files.push(plan)
    totalMatches += plan.matchCount
  }
  return { files, totalFiles: files.length, totalMatches }
}

/** 已替换文件结果 */
export interface ReplacedFile {
  path: string
  /** 实际替换处数 */
  replacements: number
}

/** 应用替换时被跳过的文件及原因 */
export interface SkippedReplaceFile {
  path: string
  /** too-large 文件过大 / changed 复核不一致 / unreadable 读写失败 */
  reason: 'too-large' | 'changed' | 'unreadable'
}

/** 应用替换时勾选的文件及复核基准 */
export interface ApplyFileSelection {
  /** 文件绝对路径 */
  path: string
  /** 预览时刻该文件的匹配处数：落盘前重读复核必须与之相等，不等说明文件已被改动 */
  expectedCount: number
}

/** applyReplace 入参 */
export interface ApplyReplaceParams extends ReplacePlanParams {
  /** 勾选要应用替换的文件（携带预览时刻计数） */
  selections: ApplyFileSelection[]
}

/** applyReplace 结果 */
export interface ReplaceApplyResult {
  applied: ReplacedFile[]
  skipped: SkippedReplaceFile[]
}

/**
 * 应用替换：写回前重读文件并复核匹配数。
 * - 复核基准是「预览时刻」UI 传回的 expectedCount，而非重新计划——
 *   否则基准随当前文件一起变化，复核永远通过、无法拦截预览后的文件改动；
 * - 复核口径（逐行计数）与 planFile 同源，文件未变则 currentCount 必然等于 expectedCount；
 * - 在正文整体上替换：不跨行的正则不触及行尾，原 EOL（LF/CRLF）天然保留；
 * - BOM 剥离后替换、写回时加回。
 */
export async function applyReplace(
  params: ApplyReplaceParams
): Promise<ReplaceApplyResult> {
  const re = buildReplaceRegExp(params)
  const applied: ReplacedFile[] = []
  const skipped: SkippedReplaceFile[] = []

  for (const sel of params.selections) {
    let size: number
    try {
      size = (await fs.stat(sel.path)).size
    } catch {
      skipped.push({ path: sel.path, reason: 'unreadable' })
      continue
    }
    if (size > MAX_REPLACE_FILE_BYTES) {
      skipped.push({ path: sel.path, reason: 'too-large' })
      continue
    }
    let raw: string
    try {
      raw = await fs.readFile(sel.path, 'utf8')
    } catch {
      skipped.push({ path: sel.path, reason: 'unreadable' })
      continue
    }
    const { hasBom, body } = splitBom(raw)
    const currentCount = countBodyMatches(body, re)
    if (currentCount !== sel.expectedCount) {
      // 预览后文件被改动（如用户在编辑器里编辑）：跳过该文件防误伤
      skipped.push({ path: sel.path, reason: 'changed' })
      continue
    }
    const replacedBody = body.replace(re, params.replaceText)
    if (replacedBody !== body) {
      // 仅在内容确有变化时写盘，避免无谓的 mtime/监听抖动
      try {
        await fs.writeFile(sel.path, (hasBom ? BOM : '') + replacedBody, 'utf8')
      } catch {
        skipped.push({ path: sel.path, reason: 'unreadable' })
        continue
      }
    }
    applied.push({ path: sel.path, replacements: currentCount })
  }
  return { applied, skipped }
}
