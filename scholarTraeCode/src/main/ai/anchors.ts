// s43 spec 锚点与漂移拦截：
// 开工时把「不可改文件 / 不可删符号」落到 .trae/anchors.json，工具调用逐次比对——
// 命中禁改路径或删除受保护符号即阻断回填错误，防长任务中途漂移改掉核心逻辑。
//
// 本模块分两层：
// - 纯函数层（matchProtectedPath / removedProtectedSymbols / formatAnchorBlock）：零 IO，可单测；
// - IO 层（loadAnchors / saveAnchors）：读写 <workspace>/.trae/anchors.json，坏 JSON 安全降级为空锚点。
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { extractSymbolDefs } from './codeParse'
import { extname } from 'node:path'

/** 受保护符号条目：name 必填；path 限定作用文件（缺省 = 全仓任意文件） */
export interface ProtectedSymbol {
  name: string
  /** 相对工作区根路径（正斜杠），缺省表示任意文件中的同名符号都受保护 */
  path?: string
}

/** 锚点文件结构 */
export interface AnchorsFile {
  /** 禁改路径模式清单（后缀段匹配，如 src/core/engine.ts 或 core/） */
  protectedPaths?: string[]
  /** 不可删除的符号清单 */
  protectedSymbols?: ProtectedSymbol[]
  /** 人工备注（提示词注入时原文展示） */
  notes?: string
}

/** 锚点文件绝对路径 */
export function anchorsFilePath(workspace: string): string {
  return join(workspace, '.trae', 'anchors.json')
}

/** 读取锚点；文件缺失/坏 JSON 一律返回空锚点（不阻断任务启动） */
export async function loadAnchors(workspace: string): Promise<AnchorsFile> {
  try {
    const raw = await fs.readFile(anchorsFilePath(workspace), 'utf-8')
    const parsed = JSON.parse(raw) as AnchorsFile
    if (!parsed || typeof parsed !== 'object') return {}
    return {
      protectedPaths: Array.isArray(parsed.protectedPaths)
        ? parsed.protectedPaths.filter((p): p is string => typeof p === 'string' && p.length > 0)
        : undefined,
      protectedSymbols: Array.isArray(parsed.protectedSymbols)
        ? parsed.protectedSymbols.filter(
            (s): s is ProtectedSymbol => !!s && typeof s === 'object' && typeof (s as any).name === 'string'
          )
        : undefined,
      notes: typeof parsed.notes === 'string' ? parsed.notes : undefined
    }
  } catch {
    return {}
  }
}

/** 写入锚点（自动建 .trae 目录；原子写防半文件） */
export async function saveAnchors(workspace: string, anchors: AnchorsFile): Promise<void> {
  const file = anchorsFilePath(workspace)
  await fs.mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${Date.now()}`
  await fs.writeFile(tmp, JSON.stringify(anchors, null, 2), 'utf-8')
  await fs.rename(tmp, file)
}

/** 路径归一：反斜杠转正斜杠、去开头 ./、小写 */
function normPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\/+/, '').toLowerCase()
}

/**
 * 判断路径是否命中禁改清单，命中返回命中的模式原文，否则 null。
 * 匹配规则（宁严勿滥，误判由人工编辑清单解除）：
 * - 完全相等；
 * - 模式以 / 结尾（目录前缀）：路径以该前缀开头；
 * - 否则按路径后缀段双向匹配：路径等于模式、路径以 /模式 结尾，或模式以 /路径 结尾
 *   （后者覆盖 AI 传短路径如 core/engine.ts 而清单写全路径的情形）。
 */
export function matchProtectedPath(anchors: AnchorsFile, relPath: string): string | null {
  const target = normPath(relPath)
  for (const raw of anchors.protectedPaths ?? []) {
    const pat = normPath(raw)
    if (!pat) continue
    if (pat.endsWith('/')) {
      if (target.startsWith(pat)) return raw
      continue
    }
    if (target === pat || target.endsWith('/' + pat) || pat.endsWith('/' + target)) return raw
  }
  return null
}

/**
 * 找出「本次改动会删除的受保护符号」：
 * 对比旧/新内容的符号定义，旧有新无且受保护（path 缺省或匹配本文件）的符号名清单。
 * @param relPath 被改文件相对路径（用于符号条目的 path 限定匹配）
 */
export function removedProtectedSymbols(
  anchors: AnchorsFile,
  relPath: string,
  oldContent: string,
  newContent: string
): string[] {
  const list = anchors.protectedSymbols ?? []
  if (list.length === 0) return []
  const target = normPath(relPath)
  const ext = extname(relPath).toLowerCase()
  const before = extractSymbolDefs(oldContent, ext)
  const afterNames = new Set(extractSymbolDefs(newContent, ext).map((s) => s.name))
  const removed = new Set(before.filter((s) => !afterNames.has(s.name)).map((s) => s.name))
  if (removed.size === 0) return []
  const hits: string[] = []
  for (const ps of list) {
    if (!removed.has(ps.name)) continue
    if (!ps.path) {
      hits.push(ps.name)
      continue
    }
    const pp = normPath(ps.path)
    if (target === pp || target.endsWith('/' + pp)) hits.push(ps.name)
  }
  return hits
}

/** 提示词注入文本：有锚点时列出清单；无锚点返回空串（不注入） */
export function formatAnchorBlock(anchors: AnchorsFile): string {
  const paths = anchors.protectedPaths ?? []
  const symbols = anchors.protectedSymbols ?? []
  if (paths.length === 0 && symbols.length === 0 && !anchors.notes) return ''
  const lines: string[] = ['【spec 锚点（禁改约束，务必遵守）】']
  if (paths.length > 0) {
    lines.push('禁改路径：')
    for (const p of paths) lines.push(`- ${p}`)
  }
  if (symbols.length > 0) {
    lines.push('不可删除的符号：')
    for (const s of symbols) lines.push(`- ${s.name}${s.path ? `（${s.path}）` : ''}`)
  }
  if (anchors.notes) lines.push(`备注：${anchors.notes}`)
  lines.push('对被阻断的路径/符号不要修改；确需调整时先向用户说明原因并请求确认。')
  return lines.join('\n')
}

/** check_alignment 工具用的锚点清单摘要（含受保护路径在磁盘上的存在性） */
export function formatAnchorSummary(anchors: AnchorsFile, existsSync: (relPath: string) => boolean): string {
  const block = formatAnchorBlock(anchors)
  if (!block) return '当前工作区未配置 spec 锚点（.trae/anchors.json 不存在或为空）。可用 set_anchors 工具设置。'
  const lines: string[] = [block, '', '受保护路径存在性检查：']
  for (const p of anchors.protectedPaths ?? []) {
    lines.push(`- ${p}：${existsSync(p) ? '存在' : '⚠ 磁盘上不存在'}`)
  }
  return lines.join('\n')
}
