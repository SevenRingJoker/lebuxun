// 变更事务暂存区 IO + IPC 层（㊝）。
// 规则全部在 ai/changeStage.ts 纯函数层；本模块负责：持久化（.trae/staging/）、
// 接受时落盘/拒绝时丢弃、bash 批量接受门的请求挂起，以及给 scheduler 用的磁盘读取与
// 只读工具结果覆盖。未开启审阅时，scheduler 完全不调用本模块，行为零变化。
//
// 持久化布局：
// - <workspace>/.trae/staging/config.json  { enabled: boolean } 工作区开关；
// - <workspace>/.trae/staging/pending.json StagedChange[]      未决变更（崩溃后仍在）。
import { ipcMain, BrowserWindow } from 'electron'
import { promises as fs, existsSync, readFileSync, statSync } from 'node:fs'
import { join, basename, dirname, relative, resolve, sep } from 'node:path'
// s44 变更集分类：锚点 + 索引引用统计 + 计划文本（规则在 ai/stagingClassify 纯函数层）
import { ensureIndex, type CodeIndex } from '../ai/indexer'
import { loadAnchors } from '../ai/anchors'
import { classifyChanges, type ChangeVerdict } from '../ai/stagingClassify'
import { parseTaskSnapshot } from '../ai/taskSnapshot'
import { runAffectedTests } from '../ai/autoTest'
import {
  applyStaged,
  buildStageNotice,
  checkConflict,
  createStage,
  deserializeStage,
  diffOf,
  hashContent,
  overlayGlob,
  overlayGrep,
  overlayRead,
  OP_LABEL,
  partitionStage,
  serializeStage,
  stageKey,
  summarize,
  type DiskView,
  type NormalizedCall,
  type StageState,
  type StageSummary,
  type StagedChange
} from '../ai/changeStage'
import { applyHunksToBase, splitHunks } from '../ai/changeStage.hunk'

/** 逐 hunk 选择：键为路径（任意形式，内部归一化），值为选中/丢弃的 hunk id 数组 */
export type HunkSelection = Record<string, string[]>

/** 工作区运行态：开关 + 暂存区（惰性从磁盘加载） */
interface Holder {
  enabled: boolean
  state: StageState
  loaded: boolean
}

/** key=resolve(workspace)，主进程单例 */
const holders = new Map<string, Holder>()

/** bash 批量接受门待决表：id → 释放函数；超时自动拒绝，避免 Agent 无限挂起 */
const pendingBash = new Map<string, (accepted: boolean) => void>()
let bashSeq = 0
const BASH_GATE_TIMEOUT_MS = 5 * 60 * 1000

function stagingDir(workspace: string): string {
  return join(workspace, '.trae', 'staging')
}
function configFile(workspace: string): string {
  return join(stagingDir(workspace), 'config.json')
}
function pendingFile(workspace: string): string {
  return join(stagingDir(workspace), 'pending.json')
}

/**
 * 惰性装载工作区 holder：config 缺省 false（本期默认关），pending 坏 JSON 安全降级为空。
 * 任何单次 IO 失败都按「关闭 + 空暂存」降级——不能让暂存设施阻断任务启动。
 */
async function ensureHolder(workspace: string): Promise<Holder> {
  const key = resolve(workspace)
  const hit = holders.get(key)
  if (hit?.loaded) return hit
  const holder: Holder = hit ?? { enabled: false, state: createStage(), loaded: false }
  try {
    const cfg = JSON.parse(await fs.readFile(configFile(workspace), 'utf-8'))
    holder.enabled = cfg?.enabled === true
  } catch {
    holder.enabled = false
  }
  try {
    holder.state = deserializeStage(JSON.parse(await fs.readFile(pendingFile(workspace), 'utf-8')))
  } catch {
    holder.state = createStage()
  }
  holder.loaded = true
  holders.set(key, holder)
  return holder
}

/** 原子写 JSON（临时文件 rename），失败抛错由调用方决定如何处理 */
async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await fs.mkdir(join(file, '..'), { recursive: true })
  const tmp = `${file}.tmp-${Date.now()}`
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8')
  await fs.rename(tmp, file)
}

/** 持久化当前暂存区到 pending.json；空区直接删文件（不留空壳） */
async function persist(workspace: string, holder: Holder): Promise<void> {
  try {
    if (holder.state.size === 0) {
      await fs.rm(pendingFile(workspace), { force: true })
    } else {
      await writeJsonAtomic(pendingFile(workspace), serializeStage(holder.state))
    }
  } catch (err) {
    // 暂存落盘失败不能静默——抛给 scheduler，让 AI 结果带错误，用户知晓未持久化
    throw new Error(`暂存区持久化失败：${(err as Error)?.message || String(err)}`)
  }
}

// ───────────────────────── 给 scheduler 的接口 ─────────────────────────

/** 审阅是否开启（未开启时 scheduler 其余逻辑全部跳过） */
export async function isStageEnabled(workspace: string): Promise<boolean> {
  return (await ensureHolder(workspace)).enabled
}

/** 真实磁盘读取（注入给纯函数 applyStaged 的 readDisk）。
 *  用同步 API：工具调用在循环里本来就串行，省去异步闭包且确定读到调用时刻内容。 */
export function readStageDisk(path: string): DiskView {
  try {
    if (!existsSync(path)) return { exists: false, content: null }
    if (!statSync(path).isFile()) return { exists: false, content: null }
    return { exists: true, content: readFileSync(path, 'utf-8') }
  } catch {
    return { exists: false, content: null }
  }
}

/** s43 锚点拦截用：取路径的「有效内容」——暂存覆盖优先（delete 视为不存在），否则读磁盘 */
export async function readEffectiveView(workspace: string, path: string): Promise<DiskView> {
  const holder = await ensureHolder(workspace)
  const hit = overlayRead(holder.state, path)
  if (hit) return hit.found ? { exists: true, content: hit.content } : { exists: false, content: null }
  return readStageDisk(path)
}

/** 执行一次暂存变更并持久化；返回给 AI 的结果消息或错误 */
export async function commitStaged(
  workspace: string,
  call: NormalizedCall
): Promise<{ ok: boolean; result: string }> {
  const holder = await ensureHolder(workspace)
  const outcome = applyStaged(holder.state, call, readStageDisk, Date.now())
  if (!outcome.ok) return { ok: false, result: `错误：${outcome.error}` }
  holder.state = outcome.state
  await persist(workspace, holder)
  return { ok: true, result: outcome.message }
}

/**
 * 只读工具结果的暂存覆盖：
 * - read/read_file：暂存命中直接返回（delete → 不存在错误），未命中保留磁盘结果；
 * - glob/list_files：把磁盘结果行（相对路径）与暂存路径合并；
 * - grep/search_content：追加暂存内容的合成匹配行。
 * 输入/输出均为工具原始文本结果。
 */
export async function overlayToolResult(
  workspace: string,
  name: string,
  args: Record<string, unknown>,
  diskResult: string
): Promise<string> {
  const holder = await ensureHolder(workspace)
  const path = String(
    (args as any).path ?? (args as any).file_path ?? (args as any).filePath ?? ''
  )
  // read 覆盖。read_text_file 虽在 STAGE_READ_NAMES 中由 scheduler 放行到这里，
  // 但漏写分支会直接落回磁盘结果——必须显式包含（冒烟曾抓到该缺口）。
  if (name === 'read' || name === 'read_file' || name === 'read_text_file') {
    const hit = overlayRead(holder.state, path)
    if (hit) {
      return hit.found
        ? hit.content
        : `错误：文件不存在（${path}）【该文件在待审阅变更中被删除】`
    }
    return diskResult
  }
  // glob 覆盖：磁盘输出含说明行，只取「纯路径行」（相对路径）。
  // 把暂存记录映射为「相对路径形式」的临时 state 后直接用纯函数 overlayGlob——
  // 磁盘行与暂存路径在同一命名空间，剔除/并入逻辑不在这里重写。
  if (name === 'glob' || name === 'list_files') {
    const relOf = (p: string): string => relative(workspace, p).split('\\').join('/')
    const relState: StageState = new Map()
    for (const [, ch] of holder.state) {
      relState.set(stageKey(relOf(ch.path)), {
        ...ch,
        path: relOf(ch.path),
        oldPath: ch.oldPath ? relOf(ch.oldPath) : null
      })
    }
    const pathLines = diskResult
      .split(/\r?\n/)
      .filter((ln) => ln && !/上限|未找到|找到 \d+/.test(ln))
    const display = overlayGlob(relState, pathLines)
    return [`找到 ${display.length} 个文件：`, ...display].join('\n')
  }
  // grep 覆盖：追加暂存匹配
  if (name === 'grep' || name === 'search_content') {
    const pattern = String((args as any).pattern ?? '')
    const extra = overlayGrep(holder.state, pattern, (abs) =>
      relative(workspace, abs).split('\\').join('/')
    )
    if (extra.length === 0) return diskResult
    // 去掉磁盘尾部截断说明之外直接追加；AI 按行消费
    return `${diskResult}\n${extra.join('\n')}`
  }
  return diskResult
}

// ───────────────────────── 接受 / 拒绝（面板用） ─────────────────────────

/** 接受选中变更：冲突检测 → 落盘 → 持久化剩余。
 *  支持两种粒度：
 *  - 整文件（hunkIds 中未列该路径）：与既有行为一致，接受=整条移除；
 *  - 逐 hunk（hunkIds[path]=选中 id 数组，仅 create/modify）：选中 hunk 落盘，
 *    未选 hunk 以「落盘后内容」为新基线继续留在 pending。
 *  move 的源头删除即便同源 delete 记录未在选中集也必须确认未被改动。
 *  任何一条冲突/重放失败则整批不落盘。 */
async function accept(
  workspace: string,
  paths: string[] | 'all',
  hunkIds?: HunkSelection
): Promise<{ ok: boolean; applied: number; partial?: boolean; error?: string }> {
  const holder = await ensureHolder(workspace)
  const { selected, rest } = partitionStage(holder.state, paths)

  const hunkSel = new Map<string, string[]>()
  if (hunkIds) {
    for (const [k, v] of Object.entries(hunkIds)) {
      hunkSel.set(stageKey(k), Array.isArray(v) ? v : [])
    }
  }

  // 落盘计划（冲突检测全部通过后才执行）
  const writePlans = new Map<string, { path: string; content: string }>()
  const deletePlans: string[] = []
  /** hunk 级部分接受后、需重基线留在 pending 的记录 */
  const kept: StagedChange[] = []
  // 基线查找表：路径键 → 记录（含同源 delete 与 move 源头路径）
  const byPath = new Map<string, StagedChange>()

  const addWrite = (path: string, content: string) => {
    writePlans.set(stageKey(path), { path, content })
  }
  const addDelete = (path: string) => {
    if (!deletePlans.some((p) => stageKey(p) === stageKey(path))) deletePlans.push(path)
  }

  let fileCount = 0
  let hunkCount = 0
  let partial = false

  for (const ch of selected) {
    byPath.set(stageKey(ch.path), ch)
    const ids = hunkSel.get(stageKey(ch.path))

    if (ids !== undefined) {
      // —— 逐 hunk 接受：仅 create/modify ——
      if (ch.kind === 'delete' || ch.kind === 'move') {
        return {
          ok: false,
          applied: 0,
          error: `「${OP_LABEL[ch.kind]}」类型不支持逐 hunk 接受：${ch.path}`
        }
      }
      if (ids.length === 0) continue
      const base = ch.baseContent ?? ''
      const hunks = splitHunks(base, ch.content ?? '')
      if (hunks.length === 0) continue

      const appliedR = applyHunksToBase(base, hunks, ids)
      if (!appliedR.ok) {
        return { ok: false, applied: 0, error: `${appliedR.error}（${ch.path}）` }
      }
      const restIds = hunks.map((h) => h.id).filter((id) => !ids.includes(id))
      addWrite(ch.path, appliedR.content)
      hunkCount += ids.length
      partial = true

      if (restIds.length > 0) {
        // 内容保持完整最终内容（已接受块与新基线相同，diff 只呈现剩余块）；
        // 基线前进到落盘内容——下轮 diff = splitHunks(新基线, 完整内容) 恰为剩余 hunk。
        kept.push({
          ...ch,
          kind: 'modify',
          content: ch.content,
          baseContent: appliedR.content,
          baseExists: true,
          baseHash: hashContent(appliedR.content),
          updatedAt: Date.now()
        })
      }
    } else {
      // —— 整文件接受（既有语义） ——
      fileCount++
      if (ch.kind === 'delete') {
        addDelete(ch.path)
      } else {
        addWrite(ch.path, ch.content ?? '')
        if (ch.kind === 'move' && ch.oldPath) {
          const srcRec = holder.state.get(stageKey(ch.oldPath))
          if (srcRec) byPath.set(stageKey(ch.oldPath), srcRec)
          addDelete(ch.oldPath)
        }
      }
    }
  }

  // 冲突检测：write 按记录基线判定；delete 要求文件仍在且哈希一致。任一冲突整批中止。
  for (const wp of writePlans.values()) {
    const base = byPath.get(stageKey(wp.path))
    const disk = readStageDisk(wp.path)
    if (
      base &&
      checkConflict(base, disk.exists, disk.exists ? hashContent(disk.content ?? '') : null)
    ) {
      return { ok: false, applied: 0, error: `文件已被外部修改，接受已阻断：${wp.path}` }
    }
  }
  for (const p of deletePlans) {
    const disk = readStageDisk(p)
    const base = byPath.get(stageKey(p))
    if (!disk.exists) return { ok: false, applied: 0, error: `文件已不存在：${p}` }
    if (base && hashContent(disk.content ?? '') !== base.baseHash) {
      return { ok: false, applied: 0, error: `文件已被外部修改，接受已阻断：${p}` }
    }
  }

  // 全部通过后执行落盘
  for (const wp of writePlans.values()) {
    await fs.mkdir(dirname(wp.path), { recursive: true })
    await fs.writeFile(wp.path, wp.content, 'utf-8')
  }
  for (const p of deletePlans) {
    await trashToWorkspace(workspace, p)
  }

  // 新状态 = 未选中记录 + 重基线的剩余 hunk 记录
  const nextState: StageState = new Map(rest)
  for (const kRec of kept) nextState.set(stageKey(kRec.path), kRec)
  holder.state = nextState
  await persist(workspace, holder)
  // s46：变更落盘后自动回归受影响测试子集（异步触发，不阻塞 accept 返回）
  if (fileCount + hunkCount > 0) {
    const changed = [...writePlans.values()].map((w) => w.path).concat(deletePlans)
    void runAffectedTests(workspace, changed)
  }
  return { ok: true, applied: fileCount + hunkCount, partial }
}

/**
 * 落盘删除：与内置 delete 工具一致——移入 .trae/trash 可恢复，不硬删。
 * 跨设备/失败回退 rm（回收站本身在工作区内，EXDEV 罕见）。
 */
async function trashToWorkspace(workspace: string, target: string): Promise<void> {
  const trashDir = join(workspace, '.trae', 'trash')
  await fs.mkdir(trashDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  let dest = join(trashDir, `${stamp}-${basename(target)}`)
  for (let n = 1; ; n++) {
    try {
      await fs.access(dest)
      dest = join(trashDir, `${stamp}-${basename(target)}-${n}`)
    } catch {
      break
    }
  }
  try {
    await fs.rename(target, dest)
  } catch (e: any) {
    if (e?.code !== 'EXDEV') throw e
    await fs.cp(target, dest, { recursive: true })
    await fs.rm(target, { recursive: true, force: true })
  }
}

/** 拒绝选中变更（磁盘从未被修改）：
 *  - 整文件：从暂存区移除；
 *  - 逐 hunk（hunkIds[path]=丢弃 id 数组，仅 create/modify）：重算未丢弃 hunk 的内容后保留记录，
 *    全部丢弃才移除。delete/move 不支持 hunk 级。 */
async function reject(
  workspace: string,
  paths: string[] | 'all',
  hunkIds?: HunkSelection
): Promise<{ ok: boolean; dropped: number; error?: string }> {
  const holder = await ensureHolder(workspace)
  const { selected, rest } = partitionStage(holder.state, paths)

  const hunkSel = new Map<string, string[]>()
  if (hunkIds) {
    for (const [k, v] of Object.entries(hunkIds)) {
      hunkSel.set(stageKey(k), Array.isArray(v) ? v : [])
    }
  }

  const nextState: StageState = new Map(rest)
  let dropped = 0

  for (const ch of selected) {
    const ids = hunkSel.get(stageKey(ch.path))
    if (ids !== undefined) {
      if (ch.kind === 'delete' || ch.kind === 'move') {
        return {
          ok: false,
          dropped: 0,
          error: `「${OP_LABEL[ch.kind]}」类型不支持逐 hunk 拒绝：${ch.path}`
        }
      }
      if (ids.length === 0) {
        nextState.set(stageKey(ch.path), ch)
        continue
      }
      const base = ch.baseContent ?? ''
      const hunks = splitHunks(base, ch.content ?? '')
      const keepIds = hunks.map((h) => h.id).filter((id) => !ids.includes(id))
      dropped += ids.length
      if (keepIds.length === 0) continue // 全部丢弃 = 移除记录
      const r = applyHunksToBase(base, hunks, keepIds)
      if (!r.ok) return { ok: false, dropped: 0, error: `${r.error}（${ch.path}）` }
      nextState.set(stageKey(ch.path), { ...ch, content: r.content, updatedAt: Date.now() })
    } else {
      dropped++ // 整文件丢弃
    }
  }

  holder.state = nextState
  await persist(workspace, holder)
  return { ok: true, dropped }
}

// ───────────────────────── bash 批量接受门 ─────────────────────────

/**
 * 开启一次 bash 接受门：返回 id（随事件给前端）与 Promise。
 * 前端回 staging:bashAcceptResponse；超时 5 分钟自动按拒绝处理。
 */
export function beginBashAccept(workspace: string): { id: string; promise: Promise<boolean> } {
  const id = `bash-${++bashSeq}`
  const promise = new Promise<boolean>((resolvePromise) => {
    const timer = setTimeout(() => {
      if (pendingBash.delete(id)) resolvePromise(false)
    }, BASH_GATE_TIMEOUT_MS)
    pendingBash.set(id, (accepted) => {
      clearTimeout(timer)
      resolvePromise(accepted)
    })
  })
  void workspace
  return { id, promise }
}

/** 取当前暂存摘要（bash 门事件 payload 与面板共用） */
export async function getStageSummary(workspace: string): Promise<StageSummary> {
  const holder = await ensureHolder(workspace)
  return summarize(holder.state)
}

/**
 * bash 门应答：accept 时全部接受落盘（含冲突检测，冲突则视为失败）。
 * @returns 最终是否放行 bash
 */
export async function resolveBashAccept(
  workspace: string,
  id: string,
  decision: 'accept' | 'reject'
): Promise<boolean> {
  const resolveFn = pendingBash.get(id)
  if (!resolveFn) return false
  if (decision === 'accept') {
    const r = await accept(workspace, 'all')
    if (!r.ok) {
      // 冲突：不放行，也不删等待项（让用户去面板处理）；保持 false
      pendingBash.set(id, resolveFn)
      return false
    }
  }
  pendingBash.delete(id)
  resolveFn(decision === 'accept')
  return decision === 'accept'
}

// ───────────────────────── ㊜ 任务快照联动 ─────────────────────────

/** 暂停/中断时取暂存快照（并入任务快照文件）；空区给 null */
export async function takeStageSnapshot(workspace: string): Promise<StagedChange[] | null> {
  const holder = await ensureHolder(workspace)
  return holder.state.size === 0 ? null : serializeStage(holder.state)
}

/** 恢复任务时把快照写回 holder（pending.json 与快照取并集：快照优先） */
export async function restoreStageSnapshot(
  workspace: string,
  changes: StagedChange[] | null
): Promise<void> {
  if (!changes) return
  const holder = await ensureHolder(workspace)
  const merged = createStage()
  for (const [k, v] of deserializeStage(changes)) merged.set(k, v)
  for (const [k, v] of holder.state) if (!merged.has(k)) merged.set(k, v)
  holder.state = merged
  await persist(workspace, holder)
}

/** 放弃任务：清空未决暂存（开关保留） */
export async function clearStaging(workspace: string): Promise<void> {
  const holder = await ensureHolder(workspace)
  holder.state = createStage()
  await persist(workspace, holder)
}

/** 审阅提示词（promptBuilder 注入） */
export function getStageNotice(): string {
  return buildStageNotice()
}

// ───────────────────────── s44 变更集分类 ─────────────────────────

/**
 * 被引用面统计：某文件的 basename（去扩展名）出现在其他文件 imports 说明符中的文件数。
 * 说明符口径宽松（子串匹配）：./types、@/core/types、../shared/types.ts 均能命中 types。
 */
function computeRefCounts(index: CodeIndex, rels: string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const rel of rels) {
    const base = basename(rel).replace(/\.[^.]+$/, '').toLowerCase()
    if (!base) {
      counts[rel] = 0
      continue
    }
    let n = 0
    for (const [otherRel, f] of Object.entries(index.files)) {
      if (otherRel === rel) continue
      if (f.imports.some((spec) => spec.toLowerCase().includes(base))) n++
    }
    counts[rel] = n
  }
  return counts
}

/** 最近一次任务快照的计划文本（direct 判定的需求来源）；无快照返回空串 */
async function latestPlanText(workspace: string): Promise<string> {
  try {
    const dir = join(workspace, '.trae', 'tasks')
    const names = await fs.readdir(dir)
    let best: { file: string; mtime: number } | null = null
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const full = join(dir, name)
      try {
        const st = await fs.stat(full)
        if (!best || st.mtimeMs > best.mtime) best = { file: full, mtime: st.mtimeMs }
      } catch {
        // 单文件 stat 失败跳过
      }
    }
    if (!best) return ''
    const snap = parseTaskSnapshot(await fs.readFile(best.file, 'utf-8'))
    return snap ? (snap.ctx.plan ?? snap.userRequest ?? '') : ''
  } catch {
    return ''
  }
}

/** 分类入口（staging:classify IPC）：返回 原始暂存路径 → 三档判定 */
async function classifyStaged(workspace: string): Promise<Record<string, ChangeVerdict>> {
  const holder = await ensureHolder(workspace)
  const summary = summarize(holder.state)
  if (summary.total === 0) return {}
  const relOf = (p: string): string => relative(workspace, p).split(sep).join('/')
  const relItems = summary.items.map((i) => ({ orig: i.path, rel: relOf(i.path), kind: i.kind }))
  // 三类输入各自独立降级：索引/锚点/计划任一不可用都不影响其余判定
  let refCounts: Record<string, number> = {}
  try {
    const { index } = await ensureIndex(workspace)
    refCounts = computeRefCounts(index, relItems.map((r) => r.rel))
  } catch {
    refCounts = {}
  }
  const anchors = await loadAnchors(workspace)
  const planText = await latestPlanText(workspace)
  const verdicts = classifyChanges(
    relItems.map((r) => ({ path: r.rel, kind: r.kind })),
    anchors,
    refCounts,
    planText
  )
  // 键还原为暂存原始路径（面板 item.path 原样查找）
  const out: Record<string, ChangeVerdict> = {}
  for (const r of relItems) out[r.orig] = verdicts[r.rel]
  return out
}

/** diff 数据（面板 IPC）：create/modify 附带 hunk 列表（s24），delete/move 无 hunk */
export async function getStageDiff(
  workspace: string,
  path: string
): Promise<(ReturnType<typeof diffOf> & { hunks: ReturnType<typeof splitHunks> }) | null> {
  const holder = await ensureHolder(workspace)
  const rec = holder.state.get(stageKey(path))
  if (!rec) return null
  const d = diffOf(rec)
  const hunks =
    rec.kind === 'create' || rec.kind === 'modify' ? splitHunks(d.original, d.modified) : []
  return { ...d, hunks }
}

// ───────────────────────── IPC 注册 ─────────────────────────

/** 推 staging:changed 给触发请求的窗口（面板自动刷新） */
function notifyChanged(workspace: string, win: BrowserWindow | null): void {
  if (win && !win.isDestroyed()) win.webContents.send('staging:changed', { workspace })
}

export function registerStagingHandlers(): void {
  // 取开关 + 摘要（面板初始化一次拿到全部列表数据）
  ipcMain.handle('staging:get', async (_e, workspace: string) => {
    if (!workspace) return { enabled: false, summary: summarize(createStage()) }
    const holder = await ensureHolder(workspace)
    return { enabled: holder.enabled, summary: summarize(holder.state) }
  })

  ipcMain.handle('staging:diff', async (_e, workspace: string, path: string) =>
    getStageDiff(workspace, path)
  )

  // s44 三档分类（需求/顺带/高风险），面板刷新后拉取
  ipcMain.handle('staging:classify', async (_e, workspace: string) => {
    if (!workspace) return {}
    return classifyStaged(workspace)
  })

  ipcMain.handle(
    'staging:accept',
    async (
      event,
      workspace: string,
      paths: string[] | 'all',
      hunkIds?: HunkSelection
    ) => {
      const r = await accept(workspace, paths, hunkIds)
      notifyChanged(workspace, BrowserWindow.fromWebContents(event.sender))
      return r
    }
  )

  ipcMain.handle(
    'staging:reject',
    async (
      event,
      workspace: string,
      paths: string[] | 'all',
      hunkIds?: HunkSelection
    ) => {
      const r = await reject(workspace, paths, hunkIds)
      notifyChanged(workspace, BrowserWindow.fromWebContents(event.sender))
      return r
    }
  )

  ipcMain.handle('staging:getEnabled', async (_e, workspace: string): Promise<boolean> =>
    workspace ? isStageEnabled(workspace) : false
  )

  ipcMain.handle(
    'staging:setEnabled',
    async (event, workspace: string, enabled: boolean) => {
      if (!workspace) return { ok: false }
      const holder = await ensureHolder(workspace)
      holder.enabled = enabled
      try {
        await writeJsonAtomic(configFile(workspace), { enabled })
      } catch (e) {
        return { ok: false, error: String(e) }
      }
      notifyChanged(workspace, BrowserWindow.fromWebContents(event.sender))
      return { ok: true }
    }
  )

  // bash 门应答（beginBashAccept 的 promise 在本通道释放）
  ipcMain.handle(
    'staging:bashAcceptResponse',
    async (_e, workspace: string, id: string, decision: 'accept' | 'reject') => {
      const released = await resolveBashAccept(workspace, id, decision)
      return { ok: true, released }
    }
  )
}
