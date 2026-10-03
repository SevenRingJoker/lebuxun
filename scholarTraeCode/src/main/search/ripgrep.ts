// ripgrep 桥接纯函数层（零 electron 依赖，可单测）。
//
// 职责：
// - rg 二进制路径解析：dev 走 node_modules 平台包；打包态把 app.asar 改写为 app.asar.unpacked；
// - rg 命令行参数构造（buildRgArgs）；
// - rg --json 事件解析（parseRgEvent）与结果分组聚合（RgResultAggregator）。
//
// 注意：@vscode/ripgrep 主包是 ESM-only，而主进程构建为 CJS（Electron 33 / Node 20
// 无法 require ESM 包），因此这里复刻其平台包定位逻辑，不直接 import 主包入口。
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

// 主进程构建为 CJS，用 createRequire 解析本地 node_modules 中的平台二进制（与 handlers/mcp.ts 同款）
const localRequire = createRequire(__filename)

/** 搜索结果匹配处数上限：达到后终止 rg 并标记 truncated */
export const MAX_RESULT_MATCHES = 5000
/** 单行最大列数：超长行不参与匹配/输出截断，避免单行超大文件拖垮渲染 */
export const MAX_LINE_COLUMNS = 512

/** 搜索参数（引擎层与 UI 层共用语义） */
export interface RgSearchParams {
  /** 查询串：字面量文本或正则源码 */
  query: string
  /** 区分大小写（默认关 → rg -i） */
  caseSensitive?: boolean
  /** 全字匹配（rg -w） */
  wholeWord?: boolean
  /** 正则模式（默认关 → rg -F 按字面量搜索） */
  regexMode?: boolean
  /** 包含 glob，每个映射一个 -g 参数 */
  includes?: string[]
  /** 排除 glob，映射为 -g '!…' */
  excludes?: string[]
}

/**
 * 把 asar 归档内路径改写为 unpacked 路径。
 * 打包后 rg 二进制会被 electron-builder 解包到 app.asar.unpacked，
 * 直接 spawn app.asar 内的可执行文件会失败。
 */
export function toUnpackedPath(p: string): string {
  // 同时兼容 Windows（\）与 POSIX（/）分隔符
  return p.replace(/app\.asar([\\/])/g, 'app.asar.unpacked$1')
}

/**
 * 解析随 npm 包分发的 rg 二进制绝对路径。
 * 复刻 @vscode/ripgrep 主包逻辑：按 platform-arch 定位 optionalDependencies 中的二进制，
 * 但不 import 其 ESM-only 入口，规避 CJS 主进程的 require 互操作问题。
 * @param req 可注入的 require（测试用），默认模块级 createRequire
 */
export function resolveShippedRgPath(req: NodeRequire = localRequire): string {
  // npm_config_arch 允许安装时交叉指定架构；electron-builder 打包场景也可能注入
  const arch = process.env.npm_config_arch || process.arch
  const binaryName = process.platform === 'win32' ? 'rg.exe' : 'rg'
  const platformPkg = `@vscode/ripgrep-${process.platform}-${arch}`
  try {
    return req.resolve(`${platformPkg}/bin/${binaryName}`)
  } catch {
    throw new Error(
      `未找到 ripgrep 平台包 ${platformPkg}：请确认 @vscode/ripgrep 的 optionalDependencies 已为当前平台安装`
    )
  }
}

/** 实际使用的 rg 路径：自动完成打包态 app.asar.unpacked 改写 */
export function resolveRgPath(req?: NodeRequire): string {
  return toUnpackedPath(resolveShippedRgPath(req))
}

/**
 * 把 glob 输入串切分为数组：逗号或空白分隔，去除空白项。
 * 例如 "*.ts, *.vue" 或 "*.ts\n*.vue" → ['*.ts', '*.vue']
 */
export function splitGlobs(input: string | null | undefined): string[] {
  if (!input) return []
  return input
    .split(/[,\s]+/)
    .map(s => s.trim())
    .filter(Boolean)
}

/**
 * 构造 rg 命令行参数（纯函数）。
 * 输出约定：--json 事件流、尊重 .gitignore/.ignore（rg 默认）、限制行宽。
 * spawn 时 cwd 应为搜索根目录，路径参数固定 '.' 以拿到相对路径再自行解析
 * （rg 直接输出绝对路径时在 Windows 上可能是 8.3 短路径）。
 */
export function buildRgArgs(params: RgSearchParams): string[] {
  const args: string[] = [
    '--json',
    // 非 git 目录下也允许应用 .gitignore 规则
    '--no-require-git',
    `--max-columns=${MAX_LINE_COLUMNS}`,
    '--max-columns-preview'
  ]
  if (!params.caseSensitive) args.push('-i')
  if (params.wholeWord) args.push('-w')
  if (!params.regexMode) args.push('-F')
  for (const g of params.includes ?? []) args.push('-g', g)
  for (const g of params.excludes ?? []) args.push('-g', `!${g}`)
  // -e 显式声明 pattern：字面量查询以 '-' 开头时不会被误识别为选项
  args.push('-e', params.query, '.')
  return args
}

/** rg --json 事件名 */
export type RgEventName = 'begin' | 'match' | 'context' | 'end' | 'summary'

/** 非 match 事件白名单（begin/context/end/summary 均识别但不聚合） */
const NON_MATCH_EVENTS: readonly string[] = ['begin', 'context', 'end', 'summary']

/** 单个 submatch（一行内可能有多处匹配） */
export interface RgSubmatch {
  /** 匹配文本 */
  text: string
  /** rg 报告的 UTF-8 字节起始偏移（非 JS 字符位置，CJK 下需转换） */
  byteStart: number
  /** rg 报告的 UTF-8 字节结束偏移（不含） */
  byteEnd: number
}

/** rg match 事件（结构化提取后） */
export interface RgMatchEvent {
  kind: 'match'
  /** rg 报告的文件路径（cwd=root + '.' 时为相对路径，形如 .\src\a.ts） */
  path: string
  /** 行号（1-based） */
  lineNumber: number
  /** 原始行文本，可能带 \n 或 \r\n 行尾 */
  lineText: string
  /** 该行内的所有匹配 */
  submatches: RgSubmatch[]
}

/** begin/context/end/summary 事件：仅保留种类，聚合层不使用其载荷 */
export interface RgPlainEvent {
  kind: Exclude<RgEventName, 'match'>
}

export type RgEvent = RgMatchEvent | RgPlainEvent

/** 窄化 unknown 为普通对象记录 */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/** 从 submatches 原始数组中提取合法项；个别畸形项跳过，不抛错 */
function extractSubmatches(v: unknown): RgSubmatch[] {
  if (!Array.isArray(v)) return []
  const out: RgSubmatch[] = []
  for (const item of v) {
    if (!isRecord(item)) continue
    const text = isRecord(item.match) ? item.match.text : undefined
    const { start, end } = item
    if (typeof text !== 'string' || typeof start !== 'number' || typeof end !== 'number') continue
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue
    out.push({ text, byteStart: start, byteEnd: end })
  }
  return out
}

/**
 * 解析一行 rg --json 输出（纯函数，畸形输入一律返回 null，绝不抛错）。
 * 覆盖：非法 JSON、缺少 type、match 事件缺 path/line_number/lines、submatch 字段异常等。
 */
export function parseRgEvent(raw: string): RgEvent | null {
  const line = raw.trim()
  if (!line) return null
  let evt: unknown
  try {
    evt = JSON.parse(line)
  } catch {
    return null // 畸形 JSON：容错跳过
  }
  if (!isRecord(evt) || typeof evt.type !== 'string') return null

  if (evt.type === 'match') {
    const d = evt.data
    if (!isRecord(d)) return null
    const path = isRecord(d.path) ? d.path.text : undefined
    const lineNumber = d.line_number
    const lineText = isRecord(d.lines) ? d.lines.text : undefined
    // 关键字段缺失/类型不符：安全跳过该事件
    if (
      typeof path !== 'string' ||
      typeof lineNumber !== 'number' ||
      !Number.isFinite(lineNumber) ||
      typeof lineText !== 'string'
    ) {
      return null
    }
    return {
      kind: 'match',
      path,
      lineNumber,
      lineText,
      submatches: extractSubmatches(d.submatches)
    }
  }

  return NON_MATCH_EVENTS.includes(evt.type)
    ? { kind: evt.type as Exclude<RgEventName, 'match'> }
    : null
}

/**
 * 将 rg 报告的 UTF-8 字节偏移转换为 JS 字符串索引（UTF-16 码元）。
 * rg 的 start/end 是字节偏移，CJK/emoji 等多字节字符下与 JS 位置不一致；
 * 需要精确定位（如点击跳转列号）时用本函数转换。普通高亮建议渲染端直接按匹配正则做。
 */
export function utf8ByteOffsetToCharIndex(text: string, byteOffset: number): number {
  let bytes = 0
  let chars = 0
  // for...of 按 code point 迭代，避免代理对字符（emoji）被拆成半个字符
  for (const ch of text) {
    if (bytes >= byteOffset) return chars
    bytes += Buffer.byteLength(ch, 'utf8')
    chars += ch.length
  }
  return chars
}

/** 聚合后的单行匹配 */
export interface RgAggregatedMatch {
  /** 行号（1-based） */
  lineNumber: number
  /** 去掉行尾的行文本，用于结果预览 */
  preview: string
  submatches: RgSubmatch[]
}

/** 聚合后的单文件分组 */
export interface RgAggregatedGroup {
  /** 文件绝对路径 */
  path: string
  matches: RgAggregatedMatch[]
  /** 该文件匹配处数（submatch 口径，与 rg stats.matches 一致） */
  matchCount: number
}

/** 去掉 rg 行文本尾部的行尾分隔（\n 或 \r\n） */
export function stripEol(text: string): string {
  return text.replace(/\r?\n$/, '')
}

/**
 * rg --json 事件流聚合器：按文件分组、统计匹配总数、执行 5000 处上限截断。
 * 典型用法：逐行 stdout 调用 ingest()，reachedLimit() 为真后 kill rg 进程。
 */
export class RgResultAggregator {
  private groupMap = new Map<string, RgAggregatedGroup>()
  private groupOrder: string[] = []
  private _totalMatches = 0
  private _truncated = false

  /**
   * @param root  搜索根目录（相对路径据此解析为绝对路径）
   * @param limit 匹配处数上限，默认 MAX_RESULT_MATCHES
   */
  constructor(
    private readonly root: string,
    private readonly limit: number = MAX_RESULT_MATCHES
  ) {}

  get totalMatches(): number {
    return this._totalMatches
  }

  get truncated(): boolean {
    return this._truncated
  }

  /**
   * 消费一行 rg 输出。
   * @returns 本行新增匹配处数（非 match 事件/截断后均为 0）
   */
  ingest(rawLine: string): number {
    const evt = parseRgEvent(rawLine)
    if (!evt || evt.kind !== 'match') return 0
    if (this._truncated) return 0

    const absPath = resolve(this.root, evt.path)
    let group = this.groupMap.get(absPath)
    if (!group) {
      group = { path: absPath, matches: [], matchCount: 0 }
      this.groupMap.set(absPath, group)
      this.groupOrder.push(absPath)
    }
    group.matches.push({
      lineNumber: evt.lineNumber,
      preview: stripEol(evt.lineText),
      submatches: evt.submatches
    })
    // 正常 match 事件至少一处匹配；submatches 异常为空时按 1 计（与"该行被命中"事实一致）
    const n = evt.submatches.length || 1
    group.matchCount += n
    this._totalMatches += n
    if (this._totalMatches >= this.limit) this._truncated = true
    return n
  }

  /** 是否已达上限：调用方应据此停止读取并 kill rg */
  reachedLimit(): boolean {
    return this._truncated
  }

  /** 按首次出现顺序输出文件分组 */
  getGroups(): RgAggregatedGroup[] {
    return this.groupOrder.map(p => this.groupMap.get(p)!)
  }
}
