// 逐 hunk 审阅纯函数层（㊟ changeStage 的 hunk 级扩展，s24）：
// - splitHunks：对「基线 → 最终内容」做行级 Myers diff，产出带上下文的 unified hunk；
// - parseUnifiedDiff / formatUnifiedDiff：unified diff 文本的解析与生成；
// - applyHunksToBase：只把选中 hunk 重放回基线，重叠/基线漂移一律拒绝。
//
// 与 changeStage.ts 同约定：零 IO / 零依赖 / 全纯函数，所有边角靠确定性单测锁定。
// 不引 diff 库——Myers O(ND) 对常规源文件足够，且行为完全可控可断言。

/** hunk 内一行：ctx=两边共有上下文，del=基线删除行，add=最终新增行 */
export interface HunkLine {
  kind: 'ctx' | 'del' | 'add'
  text: string
}

/**
 * 一个 hunk。坐标均 1 基（与 unified diff 一致）；
 * oldLines/newLines 为含上下文的行数（可为 0：空文件建/删）。
 * id 在同一次 split/parse 内按序稳定（h1、h2…），内容重算后才会变化。
 */
export interface Hunk {
  id: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: HunkLine[]
  /**
   * 仅当本 hunk 抵达新侧文件末尾时有意义：最终内容末尾是否有换行。
   * 行 diff 无法表达「只多了一个换行」，故显式携带；undefined = 未到 EOF（沿用基线）。
   */
  tailNewline?: boolean
}

/** hunk 重放结局 */
export type HunkApplyResult =
  | { ok: true; content: string }
  | { ok: false; error: string; code: 'id' | 'overlap' | 'context' }

// ───────────────────────── 行切分（CRLF / 末行换行安全） ─────────────────────────

interface SplitText {
  lines: string[]
  /** 原文末尾是否有换行（重放时保持） */
  finalNewline: boolean
  /** 原文是否使用 CRLF（重放输出沿用基线风格） */
  crlf: boolean
}

/**
 * 切分文本为行：CRLF/LF 统一归一化（比较只看行内容），
 * 末尾换行以 finalNewline 标记（split 产生的尾随空串不进行数组）。
 */
function splitLines(text: string): SplitText {
  const src = String(text ?? '')
  if (src === '') return { lines: [], finalNewline: false, crlf: false }
  const crlf = /\r\n/.test(src)
  const normalized = crlf ? src.replace(/\r\n/g, '\n') : src
  const all = normalized.split('\n')
  const finalNewline = all.length > 0 && all[all.length - 1] === ''
  if (finalNewline) all.pop()
  return { lines: all, finalNewline, crlf }
}

/** 按切分元信息拼回文本（应用选中 hunk 后使用） */
function joinLines(lines: string[], meta: SplitText, finalNewline?: boolean): string {
  const useNewline = finalNewline ?? meta.finalNewline
  let out = lines.join('\n')
  if (useNewline && lines.length > 0) out += '\n'
  // 空结果不造换行；CRLF 基线整体转写（新加行也跟随基线风格）
  if (meta.crlf && out !== '') out = out.replace(/\n/g, '\r\n')
  return out
}

// ───────────────────────── Myers O(ND) 行 diff ─────────────────────────

type OpType = 'eq' | 'del' | 'add'
interface DiffOp {
  type: OpType
  /** a（基线）行下标；add 不消费 a */
  a: number
  /** b（最终）行下标；del 不消费 b */
  b: number
}

/**
 * Myers diff：返回行编辑序列（按文件顺序）。
 * 经典 V/k 轨迹 + 回溯；相等行做蛇形延伸。
 */
function myersOps(a: string[], b: string[]): DiffOp[] {
  const n = a.length
  const m = b.length
  if (n === 0) return b.map((_, i) => ({ type: 'add' as const, a: 0, b: i }))
  if (m === 0) return a.map((_, i) => ({ type: 'del' as const, a: i, b: 0 }))

  const total = n + m
  // V 以 k+total 为索引；trace[d] 保存第 d 轮开始前的 V 快照
  let v = new Array<number>(2 * total + 1).fill(0)
  const trace: number[][] = []

  let done = false
  for (let d = 0; d <= total && !done; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && v[k - 1 + total] < v[k + 1 + total])) {
        x = v[k + 1 + total] // 向下（插入）
      } else {
        x = v[k - 1 + total] + 1 // 向右（删除）
      }
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[k + total] = x
      if (x >= n && y >= m) {
        done = true
        break
      }
    }
  }

  // 回溯生成编辑序列（逆序收集后翻转）
  const ops: DiffOp[] = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d >= 0; d--) {
    v = trace[d]
    const k = x - y
    let prevK: number
    if (k === -d || (k !== d && v[k - 1 + total] < v[k + 1 + total])) {
      prevK = k + 1
    } else {
      prevK = k - 1
    }
    const prevX = v[prevK + total]
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      ops.push({ type: 'eq', a: x - 1, b: y - 1 })
      x--
      y--
    }
    if (d > 0) {
      if (x === prevX) {
        ops.push({ type: 'add', a: x, b: y - 1 })
        y--
      } else {
        ops.push({ type: 'del', a: x - 1, b: y })
        x--
      }
    }
    x = prevX
    y = prevY
  }
  ops.reverse()
  return ops
}

// ───────────────────────── hunk 组装（上下文分组） ─────────────────────────

/** 对齐事件：带在 a/b 中的坐标（未消费侧为 -1）；type 用审阅口径（eq 已转 ctx） */
interface AlignedEvent {
  type: 'ctx' | 'del' | 'add'
  aPos: number
  bPos: number
  text: string
}

/** 编辑序列展开为带坐标的行事件流 */
function alignOps(ops: DiffOp[], a: string[], b: string[]): AlignedEvent[] {
  const events: AlignedEvent[] = []
  for (const op of ops) {
    if (op.type === 'eq') {
      events.push({ type: 'ctx', aPos: op.a, bPos: op.b, text: a[op.a] })
    } else if (op.type === 'del') {
      events.push({ type: 'del', aPos: op.a, bPos: -1, text: a[op.a] })
    } else {
      events.push({ type: 'add', aPos: -1, bPos: op.b, text: b[op.b] })
    }
  }
  return events
}

/**
 * 由行事件流切 hunk：变更点两侧各取 context 行上下文；
 * 两组变更间上下文少于 2*context 行则合并为同一 hunk（与 git 同口径）。
 */
function groupHunks(events: AlignedEvent[], context: number): Hunk[] {
  const changeIdx: number[] = []
  events.forEach((e, i) => {
    if (e.type !== 'ctx') changeIdx.push(i)
  })
  if (changeIdx.length === 0) return []

  // 分组：相邻变更之间 ctx 事件数 < 2*context 即合并
  const groups: Array<[number, number]> = []
  let start = changeIdx[0]
  let end = changeIdx[0]
  for (let i = 1; i < changeIdx.length; i++) {
    const idx = changeIdx[i]
    const gap = idx - end - 1
    if (gap < 2 * context) {
      end = idx
    } else {
      groups.push([start, end])
      start = idx
      end = idx
    }
  }
  groups.push([start, end])

  const hunks: Hunk[] = []
  let seq = 0
  for (const [gStart, gEnd] of groups) {
    // 向前/向后取上下文（不跨组：只吃 ctx 事件）
    let lo = gStart
    let taken = 0
    while (lo > 0 && taken < context && events[lo - 1].type === 'ctx') {
      lo--
      taken++
    }
    let hi = gEnd
    taken = 0
    while (hi < events.length - 1 && taken < context && events[hi + 1].type === 'ctx') {
      hi++
      taken++
    }

    const slice = events.slice(lo, hi + 1)
    // 起始坐标：优先首条消费 a/b 的事件坐标；全 add 开头（空文件/文件头插入）取已消费行数
    const before = events.slice(0, lo)
    const aBefore = before.filter((e) => e.aPos >= 0).length
    const bBefore = before.filter((e) => e.bPos >= 0).length
    const firstA = slice.find((e) => e.aPos >= 0)
    const firstB = slice.find((e) => e.bPos >= 0)
    const oldStart = firstA ? firstA.aPos + 1 : aBefore
    const newStart = firstB ? firstB.bPos + 1 : bBefore
    const oldLines = slice.filter((e) => e.aPos >= 0).length
    const newLines = slice.filter((e) => e.bPos >= 0).length

    hunks.push({
      id: `h${++seq}`,
      oldStart,
      oldLines,
      newStart,
      newLines,
      lines: slice.map((e) => ({ kind: e.type as HunkLine['kind'], text: e.text }))
    })
  }
  return hunks
}

/**
 * 计算「基线 → 当前内容」的 hunk 列表。
 * @param context 每侧上下文行数（默认 3，与 git 一致）
 */
export function splitHunks(base: string, current: string, context = 3): Hunk[] {
  const a = splitLines(base)
  const b = splitLines(current)
  const ops = myersOps(a.lines, b.lines)
  const hunks = groupHunks(alignOps(ops, a.lines, b.lines), context)
  // 末尾 hunk 若抵达新侧 EOF，显式携带末尾换行信息（行 diff 表达不了纯换行差异）
  if (hunks.length > 0) {
    const last = hunks[hunks.length - 1]
    const reachesEnd = last.newStart - 1 + last.newLines === b.lines.length
    if (reachesEnd && b.lines.length > 0) last.tailNewline = b.finalNewline
  }
  return hunks
}

// ───────────────────────── unified diff 解析 / 生成 ─────────────────────────

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/**
 * 解析 unified diff 文本为 hunk（忽略文件头 ---/+++、index、diff 等行；
 * 忽略 "\ No newline" 标记）。id 按出现顺序 h1… 分配。
 */
export function parseUnifiedDiff(patch: string): Hunk[] {
  const hunks: Hunk[] = []
  let current: Hunk | null = null
  let seq = 0

  const pushLine = (kind: HunkLine['kind'], text: string) => {
    if (current) current.lines.push({ kind, text })
  }

  for (const raw of String(patch ?? '').split(/\r?\n/)) {
    const header = raw.match(HUNK_HEADER)
    if (header) {
      current = {
        id: `h${++seq}`,
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: []
      }
      hunks.push(current)
      continue
    }
    if (!current) continue // hunk 之前的文件头一律跳过
    if (raw.startsWith('\\')) {
      // "\ No newline at end of file"：末尾 hunk 新侧无换行
      current.tailNewline = false
      continue
    }
    if (raw.startsWith(' ')) pushLine('ctx', raw.slice(1))
    else if (raw.startsWith('-')) pushLine('del', raw.slice(1))
    else if (raw.startsWith('+')) pushLine('add', raw.slice(1))
    // 空行在 unified diff 中不合法，宽容忽略
  }
  // git 约定：无标记即末尾有换行——末尾 hunk 显式补 true（其余 hunk 保持 undefined）
  if (hunks.length > 0 && hunks[hunks.length - 1].tailNewline === undefined) {
    hunks[hunks.length - 1].tailNewline = true
  }
  return hunks
}

/** 生成 hunk 头的范围表达：计数 1 省略 ,1；计数 0 显式 ,0 */
function rangeExpr(start: number, count: number): string {
  return count === 1 ? `${start}` : `${start},${count}`
}

/** 把 hunk 列表格式化为 unified diff 文本（不含文件头时由调用方补） */
export function formatUnifiedDiff(
  hunks: Hunk[],
  oldLabel = 'a/file',
  newLabel = 'b/file'
): string {
  const out: string[] = [`--- ${oldLabel}`, `+++ ${newLabel}`]
  hunks.forEach((h, idx) => {
    out.push(`@@ -${rangeExpr(h.oldStart, h.oldLines)} +${rangeExpr(h.newStart, h.newLines)} @@`)
    for (const line of h.lines) {
      const prefix = line.kind === 'ctx' ? ' ' : line.kind === 'del' ? '-' : '+'
      out.push(prefix + line.text)
    }
    // 末尾 hunk 新侧无换行时按 git 约定补标记
    if (idx === hunks.length - 1 && h.tailNewline === false) {
      out.push('\\ No newline at end of file')
    }
  })
  return out.join('\n') + '\n'
}

// ───────────────────────── 重叠检测与选中 hunk 重放 ─────────────────────────

/**
 * 判定两个 hunk 的旧侧区间是否冲突。
 * 半开区间 [start, end)：start=oldStart-1（0 基），end=start+oldLines；
 * oldLines=0（纯插入）为零宽锚点，同点/被对方端点触及均算冲突——语义保守。
 */
export function hunksOverlap(h1: Hunk, h2: Hunk): boolean {
  const s1 = h1.oldStart - 1
  const e1 = s1 + h1.oldLines
  const s2 = h2.oldStart - 1
  const e2 = s2 + h2.oldLines

  // 零宽锚点：相同点冲突；落在对方区间内或贴住端点也冲突
  const pointTouch = (p: number, s: number, e: number): boolean =>
    e === s ? p === s : s <= p && p <= e
  if (e1 === s1 && (pointTouch(s1, s2, e2) || e2 === s2 && s1 === s2)) return true
  if (e2 === s2 && pointTouch(s2, s1, e1)) return true
  return s1 < e2 && s2 < e1
}

/**
 * 只把选中 hunk 重放回基线，产出新内容。
 * - selectedIds 中存在未知 id → 失败（code:'id'）；
 * - 选中 hunk 旧区间重叠 → 失败（code:'overlap'）；
 * - hunk 的上下文/删除行与基线逐行不符（基线已被外部改动）→ 失败（code:'context'）。
 * 全函数：不修改入参，失败时不产出内容。
 */
export function applyHunksToBase(
  base: string,
  hunks: Hunk[],
  selectedIds: Iterable<string>
): HunkApplyResult {
  const ids = new Set(selectedIds)
  const byId = new Map(hunks.map((h) => [h.id, h]))
  for (const id of ids) {
    if (!byId.has(id)) return { ok: false, error: `未知 hunk id：${id}`, code: 'id' }
  }

  const selected = hunks.filter((h) => ids.has(h.id))
  selected.sort((p, q) => p.oldStart - q.oldStart || p.newStart - q.newStart)

  for (let i = 1; i < selected.length; i++) {
    if (hunksOverlap(selected[i - 1], selected[i])) {
      return {
        ok: false,
        error: `选中 hunk 区间重叠：${selected[i - 1].id} 与 ${selected[i].id}`,
        code: 'overlap'
      }
    }
  }

  const meta = splitLines(base)
  const src = meta.lines
  const out: string[] = []
  let pointer = 0

  for (const hunk of selected) {
    // hunk 以 add 开头（文件头插入/空文件创建）时锚点为 oldStart；否则首旧行 oldStart-1
    const startsWithAdd = hunk.lines[0]?.kind === 'add'
    const target = startsWithAdd ? hunk.oldStart : hunk.oldStart - 1

    if (target < pointer || target > src.length) {
      return {
        ok: false,
        error: `hunk ${hunk.id} 落点超出基线范围`,
        code: 'overlap'
      }
    }
    // 复制到 hunk 起点前的未触碰行
    for (; pointer < target; pointer++) out.push(src[pointer])

    let bx = target
    for (const line of hunk.lines) {
      if (line.kind === 'add') {
        out.push(line.text)
        continue
      }
      if (bx >= src.length || src[bx] !== line.text) {
        return {
          ok: false,
          error: `hunk ${hunk.id} 的上下文与基线不一致（第 ${bx + 1} 行），文件可能已被外部修改`,
          code: 'context'
        }
      }
      if (line.kind === 'ctx') out.push(src[bx])
      bx++ // del：跳过不输出
    }
    pointer = bx
  }

  for (; pointer < src.length; pointer++) out.push(src[pointer])
  // 最后一个选中 hunk 若抵达 EOF 且携带换行标记，以其为准；否则沿用基线
  const lastSel = selected.length > 0 ? selected[selected.length - 1] : null
  const tailOverride = lastSel?.tailNewline
  return { ok: true, content: joinLines(out, meta, tailOverride) }
}
