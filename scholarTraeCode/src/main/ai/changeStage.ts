// 变更事务暂存区纯函数层（㊝）：审阅模式下，AI 的结构化文件改动不直接落盘，
// 先进入工作区级「暂存区」，用户审阅 diff 后逐文件/批量接受才真正写磁盘。
//
// 本模块零 IO / 零 Electron 依赖：所有磁盘读取通过注入的 readDisk 回调完成，
// 规则（操作代数、工具归类、暂存覆盖视图、冲突检测）集中在此一处，便于确定性单测。
//
// 为什么需要「操作代数」：同一文件在一个任务里可能被 write/edit/delete 多次触碰，
// 暂存区必须把这些操作合并为「相对原始磁盘的最终差异」，否则用户看到的是过程噪音、
// 甚至 create 后再 delete 留下假记录。
//
// 为什么需要「暂存覆盖视图」：write 只进暂存不落盘后，AI 随后的 read/edit/grep/glob
// 若直读磁盘会拿到旧内容——Agent 会在陈旧世界观上工作。overlay 系列函数保证其世界自洽。

/** 暂存操作种类（用户视角的最终差异类型） */
export type StageOpKind = 'create' | 'modify' | 'delete' | 'move'

/**
 * 一条暂存记录。
 * - path 为目标路径（保留模型给的原始形式，含反斜杠也不改）；
 * - base* 为「首次触碰该路径时」的磁盘基线，供 diff 展示与接受时冲突检测；
 * - oldPath 仅 move 使用：来源路径（其删除效果由同源的 delete 记录承载，见操作代数）。
 */
export interface StagedChange {
  path: string
  kind: StageOpKind
  /** create/move/modify 的最终内容；delete 为 null */
  content: string | null
  /** move 来源路径；其余为 null */
  oldPath: string | null
  /** 首次暂存时的磁盘内容；新文件为 null */
  baseContent: string | null
  /** 首次暂存时磁盘上是否存在该文件 */
  baseExists: boolean
  /** baseContent 的 FNV-1a 哈希（接受时与当前磁盘哈希比对） */
  baseHash: string
  updatedAt: number
}

/** 暂存区：归一化路径键 → 记录 */
export type StageState = Map<string, StagedChange>

/** 注入的磁盘视图（调用方在 staging IO 层读盘后给出） */
export interface DiskView {
  exists: boolean
  /** exists 时为 UTF-8 内容，否则为 null */
  content: string | null
}

/** 归一化后的变更调用（由工具参数经 classifyMutationTool 提取得到） */
export type NormalizedCall =
  | { op: 'write'; path: string; content: string }
  | { op: 'edit'; path: string; oldString: string; newString: string }
  | { op: 'delete'; path: string }
  | { op: 'move'; path: string; oldPath: string }
  | { op: 'copy'; path: string; oldPath: string }

/** applyStaged 的结局：失败时 state 原样返回（错误不产生任何暂存变更） */
export type StageOutcome =
  | { ok: true; state: StageState; message: string }
  | { ok: false; state: StageState; error: string }

/** 新建空暂存区（Map 由调用方长期持有，跨多次工具调用累积） */
export function createStage(): StageState {
  return new Map()
}

/**
 * 路径键归一化：Windows 反斜杠统一为正斜杠，保证 "a\b.ts" 与 "a/b.ts" 命中同一条。
 * 不做小写化——Windows 路径大小写不敏感但小写化会破坏原始路径还原，重复键风险可接受。
 */
export function stageKey(path: string): string {
  return String(path || '').replace(/\\/g, '/')
}

/**
 * 对 UTF-8 字节做 FNV-1a 32 位哈希。TextEncoder 在 Node 与浏览器均为全局，
 * 保持纯函数；输出 8 位十六进制。用于基线/当前磁盘内容的一致性比对。
 */
export function hashContent(text: string): string {
  const bytes = new TextEncoder().encode(String(text ?? ''))
  let h = 0x811c9dc5
  for (const b of bytes) {
    h ^= b
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

// ───────────────────────── 工具名归类与参数提取 ─────────────────────────

/** 归类结果：null 表示工具名未识别（不拦截，直走原通道） */
export type ClassifiedTool =
  | { ok: true; call: NormalizedCall }
  | { ok: false; error: string }

// 各操作的工具名集合（内置 + 常见 MCP filesystem/server 命名，表驱动可扩展）
const WRITE_NAMES = new Set(['write', 'write_file', 'create_file'])
const EDIT_NAMES = new Set(['edit', 'edit_file', 'str_replace', 'string_replace'])
const DELETE_NAMES = new Set(['delete', 'delete_file', 'remove_file', 'remove'])
const MOVE_NAMES = new Set(['move', 'move_file', 'rename', 'rename_file'])
const COPY_NAMES = new Set(['copy', 'copy_file'])

/** read 类工具名（暂存覆盖读需要拦截） */
export const STAGE_READ_NAMES = new Set(['read', 'read_file', 'read_text_file'])
/** grep 类工具名（结果需追加暂存内容匹配） */
export const STAGE_GREP_NAMES = new Set(['grep', 'search_content'])
/** glob 类工具名（结果需并入新增、剔除删除） */
export const STAGE_GLOB_NAMES = new Set(['glob', 'list_files'])
/** bash 类工具名（bash 接受门使用） */
export const STAGE_BASH_NAMES = new Set(['bash', 'run_terminal_command'])

/** 按候选键名依次取值，跳过 null/undefined/非字符串（模型常塞 cwd:null 这类显式空值） */
function pick(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = args[k]
    if (typeof v === 'string' && v !== '') return v
  }
  return undefined
}

const PATH_KEYS = ['path', 'file_path', 'filePath', 'filename', 'file_name']
const CONTENT_KEYS = ['content', 'contents', 'text', 'file_text', 'new_content']
const OLD_STR_KEYS = ['old_string', 'oldString', 'old_str', 'oldText', 'search_string', 'search']
const NEW_STR_KEYS = ['new_string', 'newString', 'new_str', 'newText', 'replace_string', 'replacement']
const SOURCE_KEYS = ['oldPath', 'old_path', 'source', 'src', 'from', 'from_path', 'source_path']
const TARGET_KEYS = ['destination', 'dest', 'target', 'to', 'to_path', 'newPath', 'new_path']

/**
 * 把工具名+参数归类为暂存调用。
 * @returns null 未识别工具名（调用方应直走原通道）；否则为归一化调用或参数错误
 */
export function classifyMutationTool(
  name: string,
  args: Record<string, unknown>
): ClassifiedTool | null {
  const a = args ?? {}
  if (WRITE_NAMES.has(name)) {
    const path = pick(a, PATH_KEYS)
    if (!path) return { ok: false, error: '缺少 path 参数' }
    // write 的内容缺省按空串（模型偶发省略 content 语义即清空文件）
    const content = pick(a, CONTENT_KEYS) ?? ''
    return { ok: true, call: { op: 'write', path, content } }
  }
  if (EDIT_NAMES.has(name)) {
    const path = pick(a, PATH_KEYS)
    const oldString = pick(a, OLD_STR_KEYS)
    const newString = pick(a, NEW_STR_KEYS)
    if (!path) return { ok: false, error: '缺少 path 参数' }
    if (oldString === undefined) return { ok: false, error: '缺少 old_string 参数' }
    if (newString === undefined) return { ok: false, error: '缺少 new_string 参数' }
    return { ok: true, call: { op: 'edit', path, oldString, newString } }
  }
  if (DELETE_NAMES.has(name)) {
    const path = pick(a, PATH_KEYS)
    if (!path) return { ok: false, error: '缺少 path 参数' }
    return { ok: true, call: { op: 'delete', path } }
  }
  if (MOVE_NAMES.has(name)) {
    const path = pick(a, TARGET_KEYS) ?? pick(a, PATH_KEYS)
    const oldPath = pick(a, SOURCE_KEYS)
    if (!oldPath) return { ok: false, error: '缺少来源路径参数（source/oldPath）' }
    if (!path) return { ok: false, error: '缺少目标路径参数（destination/newPath）' }
    return { ok: true, call: { op: 'move', path, oldPath } }
  }
  if (COPY_NAMES.has(name)) {
    const path = pick(a, TARGET_KEYS) ?? pick(a, PATH_KEYS)
    const oldPath = pick(a, SOURCE_KEYS)
    if (!oldPath) return { ok: false, error: '缺少来源路径参数（source/oldPath）' }
    if (!path) return { ok: false, error: '缺少目标路径参数（destination/newPath）' }
    return { ok: true, call: { op: 'copy', path, oldPath } }
  }
  return null
}

// ───────────────────────── 操作代数（核心合并规则） ─────────────────────────

/** 组装一条新记录 */
function makeChange(
  path: string,
  kind: StageOpKind,
  content: string | null,
  baseView: DiskView,
  now: number,
  oldPath: string | null = null
): StagedChange {
  return {
    path,
    kind,
    content,
    oldPath,
    baseContent: baseView.exists ? baseView.content : null,
    baseExists: baseView.exists,
    baseHash: baseView.exists ? hashContent(baseView.content ?? '') : '',
    updatedAt: now
  }
}

/** 操作种类的中文标签（回填给 AI 的消息使用） */
export const OP_LABEL: Record<StageOpKind, string> = {
  create: '新增',
  modify: '修改',
  delete: '删除',
  move: '移动'
}

/**
 * 执行一次归一化变更调用，返回新暂存态与给 AI 的结果消息。
 * 纯函数：不修改传入 state（返回新 Map），失败时不产生任何变更。
 *
 * @param state    当前暂存区
 * @param call     归一化调用
 * @param readDisk 磁盘读取回调（IO 层注入；同一调用内可能读多个路径）
 * @param now      时间戳
 */
export function applyStaged(
  state: StageState,
  call: NormalizedCall,
  readDisk: (path: string) => DiskView,
  now: number
): StageOutcome {
  const key = stageKey(call.path)
  const existing = state.get(key)
  // 所有分支都在 next 上操作，保证入参 state 不被原地修改
  const next: StageState = new Map(state)

  /** 失败快捷返回（state 原样） */
  const fail = (error: string): StageOutcome => ({ ok: false, state, error })

  if (call.op === 'write') {
    if (!existing) {
      const disk = readDisk(call.path)
      // 磁盘已有 → 最终差异是修改；不存在 → 新增
      next.set(key, makeChange(call.path, disk.exists ? 'modify' : 'create', call.content, disk, now))
    } else if (existing.kind === 'delete') {
      // 删了又写：复活为「修改」，基线沿用删除记录保存的原始磁盘内容
      next.set(key, { ...existing, kind: 'modify', content: call.content, oldPath: null, updatedAt: now })
    } else {
      // create/modify/move 后再写：差异类型不变（move 保留 oldPath），内容覆盖
      next.set(key, { ...existing, content: call.content, updatedAt: now })
    }
    return stagedOk(next, call.path)
  }

  if (call.op === 'edit') {
    // 有效内容 = 暂存内容（delete 报错）或磁盘内容
    let effective: string
    if (existing) {
      if (existing.kind === 'delete') return fail('该文件已在待审阅变更中被删除，无法编辑；如需保留请先写入完整内容')
      effective = existing.content ?? ''
    } else {
      const disk = readDisk(call.path)
      if (!disk.exists) return fail(`未在文件中找到指定文本：文件不存在（${call.path}）`)
      effective = disk.content ?? ''
    }
    const editError = checkEdit(effective, call.oldString)
    if (editError) return fail(editError)
    const replaced = effective.replace(call.oldString, call.newString)
    if (!existing) {
      const disk = readDisk(call.path)
      next.set(key, makeChange(call.path, 'modify', replaced, disk, now))
    } else {
      next.set(key, { ...existing, content: replaced, updatedAt: now })
    }
    return stagedOk(next, call.path)
  }

  if (call.op === 'delete') {
    if (!existing) {
      const disk = readDisk(call.path)
      if (!disk.exists) return fail(`文件不存在：${call.path}`)
      next.set(key, makeChange(call.path, 'delete', null, disk, now))
    } else if (existing.kind === 'create') {
      // 新建后删除 = 回到「什么都没发生」，记录直接消失
      next.delete(key)
    } else if (existing.kind === 'delete') {
      return fail(`文件已在待审阅变更中被删除：${call.path}`)
    } else if (existing.kind === 'move') {
      // move 目标再删除：目标撤销，源头保持「删除」（move 已让源文件待删）。
      // 目标是随 move 新建的（baseExists=false）→ 净效果即源头删除：移除目标，
      // 源头 delete 记录已在 move 时写入；若目标基线本来存在（罕见），补一条目标 delete。
      next.delete(key)
      if (existing.oldPath) {
        const srcKey = stageKey(existing.oldPath)
        if (!next.has(srcKey)) {
          const srcDisk = readDisk(existing.oldPath)
          if (srcDisk.exists) next.set(srcKey, makeChange(existing.oldPath, 'delete', null, srcDisk, now))
        }
      }
    } else {
      // modify 后删除
      next.set(key, { ...existing, kind: 'delete', content: null, updatedAt: now })
    }
    return stagedOk(next, call.path)
  }

  if (call.op === 'move') {
    return stageMove(next, state, call, readDisk, now)
  }

  // copy：源内容复制到新目标，源记录保持不动
  const source = resolveSource(state, call.oldPath, readDisk)
  if (!source.found) return fail(`来源文件不存在：${call.oldPath}`)
  // 目标必须干净：无暂存记录且磁盘不存在（避免静默覆盖）
  if (state.has(key)) return fail(`目标路径已存在待审阅变更，请先处理：${call.path}`)
  if (readDisk(call.path).exists) return fail(`目标文件已存在：${call.path}`)
  next.set(key, {
    path: call.path,
    kind: 'create',
    content: source.content,
    oldPath: null,
    baseContent: null,
    baseExists: false,
    baseHash: '',
    updatedAt: now
  })
  return stagedOk(next, call.path)
}

/** edit 前置校验：与内置 edit 工具一致——未找到/多处匹配都拒绝 */
function checkEdit(content: string, oldString: string): string | null {
  if (!oldString) return 'old_string 不能为空'
  const count = content.split(oldString).length - 1
  if (count === 0) return `未在文件中找到指定文本（前 40 字符："${oldString.slice(0, 40)}"）`
  if (count > 1) return `找到 ${count} 处匹配，old_string 必须唯一。请提供更长的上下文以唯一定位。`
  return null
}

/** 源头解析：暂存记录优先（delete 视为不存在），否则读磁盘 */
function resolveSource(
  state: StageState,
  path: string,
  readDisk: (path: string) => DiskView
): { found: boolean; content: string } {
  const rec = state.get(stageKey(path))
  if (rec) {
    if (rec.kind === 'delete') return { found: false, content: '' }
    return { found: true, content: rec.content ?? '' }
  }
  const disk = readDisk(path)
  return disk.exists ? { found: true, content: disk.content ?? '' } : { found: false, content: '' }
}

/**
 * move 操作代数。语义：源头删除 + 目标创建。
 * 目标必须干净（无暂存记录、磁盘不存在）；源头按其当前暂存状态分四种合并：
 * 1. 无记录（磁盘文件）       → 源头补 delete（基线=磁盘），目标 move；
 * 2. create 记录（新建文件）   → 源头记录移除（本就不存在），目标 create；
 * 3. modify 记录              → 源头转 delete（基线保留），目标 move；
 * 4. move 记录（连续移动）     → 目标继承最初源头 oldPath，移除中间记录，源头 delete 已存在。
 */
function stageMove(
  next: StageState,
  state: StageState,
  call: { path: string; oldPath: string },
  readDisk: (path: string) => DiskView,
  now: number
): StageOutcome {
  const targetKey = stageKey(call.path)
  if (state.has(targetKey)) {
    return { ok: false, state, error: `目标路径已存在待审阅变更，请先处理：${call.path}` }
  }
  if (readDisk(call.path).exists) {
    return { ok: false, state, error: `目标文件已存在：${call.path}` }
  }
  const srcKey = stageKey(call.oldPath)
  const srcRec = state.get(srcKey)

  /** 在目标键写入新记录 */
  const putTarget = (kind: StageOpKind, oldPath: string | null, base: StagedChange | DiskView | null) => {
    const isDisk = base !== null && 'exists' in base
    next.set(targetKey, {
      path: call.path,
      kind,
      content: sourceContent,
      oldPath,
      baseContent: base === null ? null : isDisk ? ((base as DiskView).exists ? (base as DiskView).content : null) : (base as StagedChange).baseContent,
      baseExists: base === null ? false : isDisk ? (base as DiskView).exists : (base as StagedChange).baseExists,
      baseHash: base === null ? '' : isDisk ? hashContent((base as DiskView).content ?? '') : (base as StagedChange).baseHash,
      updatedAt: now
    })
  }

  // 先解析源头有效内容
  if (srcRec?.kind === 'delete') {
    return { ok: false, state, error: `来源文件不存在：${call.oldPath}` }
  }
  let sourceContent: string
  if (srcRec) {
    sourceContent = srcRec.content ?? ''
  } else {
    const srcDisk = readDisk(call.oldPath)
    if (!srcDisk.exists) return { ok: false, state, error: `来源文件不存在：${call.oldPath}` }
    sourceContent = srcDisk.content ?? ''
  }

  if (!srcRec) {
    // 1. 干净磁盘文件：源头补 delete（基线为磁盘内容），目标 move
    const srcDisk = readDisk(call.oldPath)
    next.set(srcKey, makeChange(call.oldPath, 'delete', null, srcDisk, now))
    putTarget('move', call.oldPath, srcDisk)
  } else if (srcRec.kind === 'create') {
    // 2. 新建文件改名：源头消失，目标仍为 create
    next.delete(srcKey)
    putTarget('create', null, null)
  } else if (srcRec.kind === 'modify') {
    // 3. 修改过的文件移动：源头转 delete（基线沿用），目标 move
    next.set(srcKey, { ...srcRec, kind: 'delete', content: null, updatedAt: now })
    putTarget('move', call.oldPath, srcRec)
  } else {
    // 4. 连续 move：继承最初源头，移除中间路径；源头 delete 记录保持不变
    const originPath = srcRec.oldPath ?? call.oldPath
    next.delete(srcKey)
    const originRec = next.get(stageKey(originPath))
    putTarget('move', originPath, originRec ?? readDisk(originPath))
  }
  return stagedOk(next, call.path)
}

/** 成功结局：附带给 AI 的「已加入待审阅变更」消息 */
function stagedOk(state: StageState, path: string): StageOutcome {
  const total = state.size
  const rec = state.get(stageKey(path))
  const label = rec ? OP_LABEL[rec.kind] : '删除'
  return {
    ok: true,
    state,
    message:
      `已将 ${path} 的${label}加入待审阅变更（当前 ${total} 个文件待用户接受，` +
      '接受前不会写入磁盘；你后续的读取会自动看到该变更）。'
  }
}

// ───────────────────────── 暂存覆盖视图 ─────────────────────────

/** read 覆盖：返回 null 表示暂存区对该路径无意见，调用方读磁盘 */
export function overlayRead(state: StageState, path: string): { found: boolean; content: string } | null {
  const rec = state.get(stageKey(path))
  if (!rec) return null
  if (rec.kind === 'delete') return { found: false, content: '' }
  return { found: true, content: rec.content ?? '' }
}

/** 存在性覆盖：null 表示无暂存意见，调用方自行查磁盘（验证锁 fileExists 判定用） */
export function overlayExists(state: StageState, path: string): boolean | null {
  const r = overlayRead(state, path)
  return r === null ? null : r.found
}

/** 暂存中「新增/移入目标」的路径键（glob 覆盖时并入） */
export function stagedNewPaths(state: StageState): string[] {
  const out: string[] = []
  for (const rec of state.values()) {
    if (rec.kind === 'create' || rec.kind === 'move') out.push(stageKey(rec.path))
  }
  return out
}

/** 暂存中「删除/移走」的路径键（glob 覆盖时从磁盘结果剔除） */
export function stagedDeletedPaths(state: StageState): string[] {
  const out: string[] = []
  for (const rec of state.values()) {
    if (rec.kind === 'delete') out.push(stageKey(rec.path))
    if (rec.kind === 'move' && rec.oldPath) out.push(stageKey(rec.oldPath))
  }
  return out
}

/**
 * glob 结果覆盖：从磁盘结果剔除被删路径，并入新增路径。
 * 输入/输出均为「同一种路径形式」（相对或绝对，由调用方保证与暂存键可比对），
 * 因此调用方需先把磁盘结果与暂存路径转换到同一形式后调用。
 */
export function overlayGlob(state: StageState, diskPaths: string[]): string[] {
  const deleted = new Set(stagedDeletedPaths(state))
  const kept = diskPaths.filter((p) => !deleted.has(stageKey(p)))
  const existing = new Set(kept.map(stageKey))
  for (const np of stagedNewPaths(state)) {
    if (!existing.has(np)) {
      kept.push(np)
      existing.add(np)
    }
  }
  return kept
}

/**
 * grep 覆盖：对暂存中 create/modify/move 的内容补扫（delete 记录跳过），
 * 返回与内置 grep 同格式的合成行 `相对路径:行号: 内容`。
 * @param relOf 把暂存绝对路径转成与磁盘 grep 输出一致的相对路径
 * @param pattern 正则字符串（与磁盘工具一致，忽略大小写）
 */
export function overlayGrep(
  state: StageState,
  pattern: string,
  relOf: (absPath: string) => string
): string[] {
  let re: RegExp
  try {
    re = new RegExp(pattern, 'i')
  } catch {
    return []
  }
  const out: string[] = []
  for (const rec of state.values()) {
    if (rec.kind === 'delete' || rec.content === null) continue
    const rel = relOf(rec.path)
    const lines = rec.content.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        out.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`)
      }
    }
  }
  return out
}

// ───────────────────────── 审阅辅助 / 冲突检测 ─────────────────────────

/** 暂存摘要：分类计数 + 文件清单（面板列表与完成提示用） */
export interface StageSummary {
  total: number
  counts: Record<StageOpKind, number>
  items: Array<{ path: string; kind: StageOpKind; chars: number; updatedAt: number }>
}

export function summarize(state: StageState): StageSummary {
  const counts: Record<StageOpKind, number> = { create: 0, modify: 0, delete: 0, move: 0 }
  const items: StageSummary['items'] = []
  for (const rec of state.values()) {
    counts[rec.kind]++
    items.push({ path: rec.path, kind: rec.kind, chars: rec.content?.length ?? 0, updatedAt: rec.updatedAt })
  }
  items.sort((a, b) => a.path.localeCompare(b.path))
  return { total: state.size, counts, items }
}

/**
 * diff 输入（供 Monaco DiffEditor）：
 * - create：左空右新内容；modify：左基线右新内容；
 * - delete：左基线右空；move：左空右新内容（源头删除由同源 delete 记录单独展示）。
 */
export function diffOf(change: StagedChange): { original: string; modified: string; title: string } {
  const original = change.kind === 'create' || change.kind === 'move' ? '' : change.baseContent ?? ''
  const modified = change.kind === 'delete' ? '' : change.content ?? ''
  return { original, modified, title: `${OP_LABEL[change.kind]} ${change.path}` }
}

/**
 * 接受前冲突检测：
 * - modify/delete：磁盘当前内容哈希必须等于基线哈希（别人改过则阻断，不覆盖）；
 * - create/move 目标：基线不存在，故磁盘现在必须仍不存在；
 * - move 源头（oldPath）：当前磁盘内容须仍等于源头基线——调用方对同源 delete 记录
 *   的检测已覆盖此情形，这里仅返回目标路径的判定。
 *
 * @param currentExists 接受时目标路径是否存在（IO 层查盘）
 * @param currentHash   存在时当前磁盘内容哈希
 */
export function checkConflict(
  change: StagedChange,
  currentExists: boolean,
  currentHash: string | null
): boolean {
  if (change.kind === 'create' || change.kind === 'move') {
    return currentExists // 现在冒出来了 = 冲突
  }
  if (!currentExists) return true // 要改/删的文件反而没了 = 冲突
  return currentHash !== change.baseHash
}

// ───────────────────────── 序列化 / 接受落盘规划 ─────────────────────────

/** 序列化为可 JSON 化数组（落 pending.json 或并入任务快照） */
export function serializeStage(state: StageState): StagedChange[] {
  return Array.from(state.values())
}

/**
 * 反序列化：逐条校验结构，坏条目跳过（不拖垮整区），重复键后者覆盖。
 * 宽容非法输入——null/非数组/缺字段一律安全降级。
 */
export function deserializeStage(raw: unknown): StageState {
  const state = createStage()
  if (!Array.isArray(raw)) return state
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    if (typeof r.path !== 'string' || !r.path) continue
    const kind = r.kind as StageOpKind
    if (!['create', 'modify', 'delete', 'move'].includes(kind)) continue
    const baseExists = r.baseExists === true
    const change: StagedChange = {
      path: r.path,
      kind,
      content: typeof r.content === 'string' ? r.content : null,
      oldPath: typeof r.oldPath === 'string' ? r.oldPath : null,
      baseContent: typeof r.baseContent === 'string' ? r.baseContent : null,
      baseExists,
      baseHash: typeof r.baseHash === 'string' ? r.baseHash : '',
      updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : 0
    }
    state.set(stageKey(change.path), change)
  }
  return state
}

/** 落盘操作（接受时执行）：mkdir/write 由 IO 层补父目录，delete/move 语义见各字段 */
export interface ApplyOp {
  type: 'write' | 'delete'
  path: string
  content?: string
}

/**
 * 把选中的暂存记录转为落盘操作序列：
 * - create/modify → write；delete → delete；
 * - move → 目标 write + 源头 delete（oldPath 为空的链式 create 情形无源头删除）。
 * 同路径操作去重（move 与同源 delete 同批接受时避免重复删）。
 */
export function buildApplyOps(selected: StagedChange[]): ApplyOp[] {
  const ops: ApplyOp[] = []
  const seen = new Set<string>()
  const push = (op: ApplyOp) => {
    const k = `${op.type}:${stageKey(op.path)}`
    if (seen.has(k)) return
    seen.add(k)
    ops.push(op)
  }
  for (const ch of selected) {
    if (ch.kind === 'delete') {
      push({ type: 'delete', path: ch.path })
    } else {
      push({ type: 'write', path: ch.path, content: ch.content ?? '' })
      if (ch.kind === 'move' && ch.oldPath) {
        push({ type: 'delete', path: ch.oldPath })
      }
    }
  }
  return ops
}

/**
 * 按路径集合把暂存区划分为「选中 / 剩余」（接受与拒绝共用）。
 * @param paths 归一化路径数组；'all' 表示全选
 */
export function partitionStage(
  state: StageState,
  paths: string[] | 'all'
): { selected: StagedChange[]; rest: StageState } {
  const wanted = paths === 'all' ? null : new Set(paths.map(stageKey))
  const selected: StagedChange[] = []
  const rest = createStage()
  for (const [k, rec] of state) {
    const hit = wanted === null || wanted.has(k)
    if (hit) selected.push(rec)
    else rest.set(k, rec)
  }
  return { selected, rest }
}

// ───────────────────────── 提示词约定 ─────────────────────────

/** 审阅模式注入系统提示词的说明（让模型理解暂存语义，避免因 read 正常而困惑） */
export function buildStageNotice(): string {
  return [
    '【变更审阅模式已开启】',
    '- 你通过 write/edit/delete/move/copy 等结构化工具做的文件改动，会先进入「待审阅暂存区」，用户接受前不会真正写入磁盘；',
    '- 你对文件的读取、编辑、搜索会自动基于暂存后的内容（你写的新文件立刻能读到），按正常方式使用即可；',
    '- 当你需要执行 bash 命令（如 npm install / 构建验证）时，系统会先请用户接受当前暂存变更、文件落盘后命令才执行；',
    '- 因此：完成全部文件编辑后即可结束本轮，不必反复读取确认；构建/运行类验证在用户接受变更后进行。'
  ].join('\n')
}
