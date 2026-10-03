// s54 实验数据解析：CSV / JSON → 统一表格结构（纯函数层，零 IO，双端可测）。
//
// CSV 支持：逗号/分号/制表符分隔、双引号包裹、引号内换行与转义（""）、
// 首行表头（无表头时生成 col1..colN）、数值列自动识别。
// JSON 支持：对象数组（每行一条记录）或 { columns, rows } 结构。

/** 统一表格：列名 + 行（值均为字符串或数字；null 表示缺失） */
export interface DataTable {
  columns: string[]
  rows: Array<Record<string, string | number | null>>
}

/** 尝试把字符串识别为数字（整数/小数/科学计数/负号），失败原样返回 */
export function parseCell(raw: string): string | number | null {
  if (raw === undefined || raw === null) return null
  const s = String(raw).trim()
  if (s === '' || s.toUpperCase() === 'NA' || s.toUpperCase() === 'NULL') return null
  // 前导零的多位编号（007、0012）按字符串保留，避免被数值化丢零
  if (/^-?0\d+$/.test(s)) return s
  // 排除误判：含字母单位
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)) {
    const n = Number(s)
    if (Number.isFinite(n)) return n
  }
  return s
}

/**
 * RFC4180 风格 CSV 行解析（状态机，支持引号内逗号/换行/双引号转义）。
 * 返回二维字符串数组（不含换行拆分，输入必须是已切分前的整段文本）。
 */
export function parseCsvText(text: string, delimiter?: string): string[][] {
  // 自动探测分隔符：首行中逗号/分号/制表符出现次数最多者
  const firstLineEnd = text.search(/\r?\n/)
  const firstLine = firstLineEnd >= 0 ? text.slice(0, firstLineEnd) : text
  let sep = delimiter
  if (!sep) {
    const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 }
    for (const ch of firstLine) if (ch in counts) counts[ch]++
    sep = (Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0]) as string
    if (!counts[sep]) sep = ','
  }

  const records: string[][] = []
  let field = ''
  let row: string[] = []
  let inQuotes = false
  const pushField = (): void => { row.push(field); field = '' }
  const pushRow = (): void => { records.push(row); row = [] }

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ }
        else inQuotes = false
      } else {
        field += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === sep) {
      pushField()
    } else if (ch === '\r') {
      // CRLF：跳过 \r，由 \n 收尾
      if (text[i + 1] === '\n') continue
      pushField(); pushRow()
    } else if (ch === '\n') {
      pushField(); pushRow()
    } else {
      field += ch
    }
  }
  // 末行无换行收尾
  if (field.length > 0 || row.length > 0) {
    pushField(); pushRow()
  }
  // 丢弃纯空尾行（字段全空的单行）
  return records.filter((r) => r.some((c) => c.trim() !== ''))
}

/** CSV 文本 → DataTable（首行作表头，单元格自动识别数字） */
export function csvToTable(text: string, delimiter?: string): DataTable {
  const records = parseCsvText(text, delimiter)
  if (records.length === 0) return { columns: [], rows: [] }
  const header = records[0].map((h, i) => h.trim() || `col${i + 1}`)
  // 表头去重（重名追加序号）
  const seen = new Map<string, number>()
  const columns = header.map((h) => {
    const n = seen.get(h) ?? 0
    seen.set(h, n + 1)
    return n > 0 ? `${h}_${n + 1}` : h
  })
  const rows: DataTable['rows'] = records.slice(1).map((cells) => {
    const obj: DataTable['rows'][number] = {}
    columns.forEach((col, i) => {
      obj[col] = parseCell(cells[i] ?? '')
    })
    return obj
  })
  return { columns, rows }
}

/** JSON 文本 → DataTable：接受对象数组或 { columns, rows } */
export function jsonToTable(text: string): DataTable {
  const data = JSON.parse(text)
  if (Array.isArray(data)) {
    if (data.length === 0) return { columns: [], rows: [] }
    const colSet: string[] = []
    for (const item of data) {
      if (item && typeof item === 'object') {
        for (const k of Object.keys(item)) if (!colSet.includes(k)) colSet.push(k)
      }
    }
    return {
      columns: colSet,
      rows: data.map((item) => {
        const obj: DataTable['rows'][number] = {}
        for (const c of colSet) {
          const v = item?.[c]
          obj[c] = typeof v === 'number' ? v : v == null ? null : String(v)
        }
        return obj
      })
    }
  }
  if (data && typeof data === 'object' && Array.isArray(data.columns) && Array.isArray(data.rows)) {
    const columns: string[] = data.columns.map((c: unknown) => String(c))
    return {
      columns,
      rows: data.rows.map((r: unknown) => {
        const obj: DataTable['rows'][number] = {}
        if (Array.isArray(r)) {
          columns.forEach((c, i) => {
            const v = r[i]
            obj[c] = typeof v === 'number' ? v : v == null ? null : String(v)
          })
        } else if (r && typeof r === 'object') {
          for (const c of columns) {
            const v = (r as Record<string, unknown>)[c]
            obj[c] = typeof v === 'number' ? v : v == null ? null : String(v)
          }
        }
        return obj
      })
    }
  }
  throw new Error('JSON 必须是对象数组或 { columns, rows } 结构')
}

/** 按扩展名/内容统一入口：.csv/.tsv → CSV 解析，.json → JSON 解析 */
export function parseDataFile(fileName: string, text: string): DataTable {
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.json')) return jsonToTable(text)
  if (lower.endsWith('.tsv')) return csvToTable(text, '\t')
  return csvToTable(text)
}

/** 提取数值列名（该列存在至少一个数字值） */
export function numericColumns(table: DataTable): string[] {
  return table.columns.filter((c) => table.rows.some((r) => typeof r[c] === 'number'))
}
