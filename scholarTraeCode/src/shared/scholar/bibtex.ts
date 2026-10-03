// s56 参考文献：BibTeX 解析/生成 + 正文引用标注联动（纯函数层，零 IO，双端可测）。
//
// 支持：
// - 解析 @type{key, field = {value}, field = "value", field = 123} 条目；
// - 大括号嵌套（标题中的 {Protected} 词）、引号包裹、注释（% 行/块外文本）容忍；
// - 生成规范 BibTeX；
// - 正文 [@key] / @key 标注提取 → 按键顺序生成参考文献章节。

/** 单条文献 */
export interface BibEntry {
  /** 条目类型（article/book/inproceedings 等，小写） */
  type: string
  /** 引用键 */
  key: string
  /** 字段（author/title/year/journal 等，键小写，值已去外层包裹） */
  fields: Record<string, string>
}

/** 解析整条 BibTeX 文本为条目数组（无法解析的畸形条目跳过） */
export function parseBibtex(text: string): BibEntry[] {
  const entries: BibEntry[] = []
  let i = 0
  const n = text.length

  while (i < n) {
    // 找下一个 @
    const at = text.indexOf('@', i)
    if (at < 0) break
    // 读取类型
    let j = at + 1
    const typeStart = j
    while (j < n && /[a-zA-Z]/.test(text[j])) j++
    const type = text.slice(typeStart, j).trim().toLowerCase()
    if (!type || type === 'comment' || type === 'preamble' || type === 'string') {
      i = j
      // comment/preamble 也跳到下一个 @（其花括号内容整体跳过）
      if (text[j] === '{' || text[j] === '(') i = skipBraced(text, j)
      continue
    }
    // 跳过空白到 { 或 (
    while (j < n && /\s/.test(text[j])) j++
    if (text[j] !== '{' && text[j] !== '(') { i = j; continue }
    const bodyEnd = skipBraced(text, j)
    if (bodyEnd < 0) break
    const body = text.slice(j + 1, bodyEnd - 1)
    const entry = parseEntryBody(type, body)
    if (entry) entries.push(entry)
    i = bodyEnd
  }
  return entries
}

/** 跳过配对花括号/圆括号（支持嵌套），返回结束符下一个位置；不配对返回 -1 */
function skipBraced(text: string, openPos: number): number {
  const open = text[openPos]
  const close = open === '{' ? '}' : ')'
  let depth = 0
  for (let k = openPos; k < text.length; k++) {
    const ch = text[k]
    if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return k + 1
    }
  }
  return -1
}

/** 解析条目体：key, field = value, ... */
function parseEntryBody(type: string, body: string): BibEntry | null {
  // 第一个逗号前是 key
  const comma = findTopComma(body)
  if (comma < 0) return null
  const key = body.slice(0, comma).trim()
  if (!key) return null
  const fields: Record<string, string> = {}
  let rest = body.slice(comma + 1)
  while (rest.trim()) {
    // 读字段名
    const eqMatch = rest.match(/^\s*([a-zA-Z][\w-]*)\s*=\s*/)
    if (!eqMatch) break
    const fieldName = eqMatch[1].toLowerCase()
    rest = rest.slice(eqMatch[0].length)
    const { value, next } = readFieldValue(rest)
    if (value !== null) fields[fieldName] = value
    // 跳过分隔逗号
    rest = next.replace(/^\s*,?\s*/, '')
    if (value === null) {
      // 无法解析值，跳到下一个顶层逗号尝试恢复
      const c = findTopComma(rest)
      if (c < 0) break
      rest = rest.slice(c + 1)
    }
  }
  return { type, key, fields }
}

/** 找顶层（括号深度 0）逗号位置 */
function findTopComma(s: string): number {
  let depth = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '{' || ch === '(') depth++
    else if (ch === '}' || ch === ')') depth--
    else if (ch === ',' && depth === 0) return i
  }
  return -1
}

/** 读取一个字段值（{...} / "..." / 裸数字），返回值与剩余文本 */
function readFieldValue(s: string): { value: string | null; next: string } {
  const ch = s[0]
  if (ch === '{') {
    const end = skipBraced(s, 0)
    if (end < 0) return { value: null, next: s }
    // 去掉外层花括号；内部双层花括号保留一层（BibTeX 保护词惯例）
    let inner = s.slice(1, end - 1)
    inner = inner.replace(/\{([^{}]*)\}/g, '$1')
    return { value: normalizeSpace(inner), next: s.slice(end) }
  }
  if (ch === '"') {
    // 引号串（容忍内部花括号）
    let depth = 0
    for (let k = 1; k < s.length; k++) {
      if (s[k] === '{') depth++
      else if (s[k] === '}') depth--
      else if (s[k] === '"' && depth === 0) {
        return { value: normalizeSpace(s.slice(1, k)), next: s.slice(k + 1) }
      }
    }
    return { value: null, next: s }
  }
  // 裸值：读到顶层逗号
  const c = findTopComma(s)
  const raw = (c < 0 ? s : s.slice(0, c)).trim()
  return { value: normalizeSpace(raw), next: c < 0 ? '' : s.slice(c) }
}

function normalizeSpace(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/** 生成规范 BibTeX 文本 */
export function formatBibtex(entries: BibEntry[]): string {
  return entries.map((e) => {
    const lines = [`@${e.type}{${e.key},`]
    const keys = Object.keys(e.fields)
    keys.forEach((k, i) => {
      const comma = i < keys.length - 1 ? ',' : ''
      lines.push(`  ${k} = {${e.fields[k]}}${comma}`)
    })
    lines.push('}')
    return lines.join('\n')
  }).join('\n\n') + (entries.length ? '\n' : '')
}

/** 从正文提取引用键：支持 [@key]、[@key1; @key2]、@key 三种写法 */
export function extractCitations(markdown: string): string[] {
  const keys: string[] = []
  // [@key] 与分号组合
  const bracketRe = /\[\s*@([\w:.-]+)(?:\s*[;,]\s*@[\w:.-]+)*\s*\]/g
  let m: RegExpExecArray | null
  while ((m = bracketRe.exec(markdown))) {
    const inner = m[0].slice(1, -1)
    for (const part of inner.split(/[;,]/)) {
      const k = part.trim().replace(/^@/, '')
      if (k && !keys.includes(k)) keys.push(k)
    }
  }
  // 裸 @key（避免邮箱误判：@ 前不能是字母/点；键后要有词边界）
  const bareRe = /(^|[\s(])@([\w:.-]+)/g
  while ((m = bareRe.exec(markdown))) {
    const k = m[2]
    if (!keys.includes(k)) keys.push(k)
  }
  return keys
}

/** 姓名格式化辅助：BibTeX 的 "Last, First" / "First Last" → "First Last" */
function formatAuthorName(raw: string): string {
  const parts = raw.split(/\s+and\s+/i).map((p) => p.trim()).filter(Boolean)
  return parts.map((p) => {
    if (p.includes(',')) {
      const [last, first] = p.split(',').map((s) => s.trim())
      return `${first} ${last}`.trim()
    }
    return p
  }).join(', ')
}

/** 生成一条参考文献的纯文本展示行（APA 风格近似，用于报告参考文献章节） */
export function formatReferenceLine(entry: BibEntry): string {
  const f = entry.fields
  const authors = f.author ? formatAuthorName(f.author) : ''
  const year = f.year ? `(${f.year}).` : ''
  const title = f.title ? f.title.replace(/[{}]/g, '') : ''
  let venue = ''
  if (entry.type === 'article') {
    venue = [f.journal, f.volume, f.number ? `(${f.number})` : '', f.pages ? `: ${f.pages}` : '']
      .filter(Boolean).join(' ')
  } else if (entry.type === 'inproceedings' || entry.type === 'conference') {
    venue = f.booktitle ?? ''
  } else if (entry.type === 'book') {
    venue = f.publisher ?? ''
  } else {
    venue = f.journal ?? f.booktitle ?? f.publisher ?? ''
  }
  return [authors, year, title + '.', venue ? venue + '.' : ''].filter(Boolean).join(' ')
}

/** 按引用出现顺序生成参考文献章节（Markdown）；缺失键给出占位提示 */
export function buildReferencesSection(citedKeys: string[], entries: BibEntry[]): string {
  const byKey = new Map(entries.map((e) => [e.key, e]))
  const lines = ['## 参考文献', '']
  if (citedKeys.length === 0) {
    lines.push('（正文未检测到引用标注，使用 [@key] 或 @key 引用文献）')
    return lines.join('\n')
  }
  citedKeys.forEach((key, i) => {
    const e = byKey.get(key)
    if (e) {
      lines.push(`[${i + 1}] ${formatReferenceLine(e)}`)
    } else {
      lines.push(`[${i + 1}] ⚠ 文献库中未找到条目：${key}`)
    }
  })
  return lines.join('\n')
}
