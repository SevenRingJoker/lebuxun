// Git 集成：仓库状态、文件差异、检查点（checkpoint 提交）与回滚。
// 直调本机 git CLI（spawn），不依赖第三方库；porcelain v1 -z 输出保证含空格/中文路径安全解析。
//
// 安全约束：
// - 不自动 git init，初始化必须由用户在前端显式触发
// - restoreCheckpoint（reset --hard）前由调用方保证用户强确认
// - commit 使用内联 -c user.name/email 兜底，不修改用户全局配置
import { spawn } from 'node:child_process'
import { ipcMain } from 'electron'
import { statSync, readFileSync, existsSync, rmSync, rmdirSync } from 'node:fs'
import { join, relative, resolve, dirname } from 'node:path'
// 复用工作区边界判定（终端域的纯函数，零 IO，不会引入循环依赖）
import { isWithinWorkspace } from '../terminal/shellProbe'

/** 工作区改动项 */
export interface GitChange {
  /** 相对仓库根的路径（rename 时为新路径） */
  path: string
  /** 改动类型 */
  status: 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed' | 'unknown'
  /** 是否存在于暂存区 */
  staged: boolean
  /** rename 时的原路径 */
  oldPath?: string
  /** 原始 porcelain 状态码（调试用） */
  rawCode: string
}

/** 检查点（提交历史）项 */
export interface GitCheckpoint {
  hash: string
  shortHash: string
  author: string
  date: string
  subject: string
  /** 是否为本应用创建的 trae-checkpoint */
  isTrae: boolean
}

/** 统一操作结果 */
export interface GitResult<T = unknown> {
  ok: boolean
  data?: T
  error?: string
}

/** 单文件 diff 结果 */
export interface FileDiff {
  path: string
  /** 统一 diff 文本（untracked 文件为 /dev/null 到全文的新增 diff） */
  patch: string
  /** HEAD/旧版本内容（供 DiffEditor 左侧；删除文件时为其历史内容） */
  oldContent: string
  /** 工作区当前内容（供右侧；删除文件为空串） */
  newContent: string
  /** 文件是否已被删除（工作区不存在） */
  deleted: boolean
}

/** 大文件阈值：超过则不向 Monaco 传输原文，防止编辑器卡死 */
const MAX_DIFF_BYTES = 200 * 1024

// ---------------- 底层 git 调用 ----------------

/**
 * 执行 git 命令，UTF-8 输出。
 * @param root 仓库根/工作目录
 * @param args git 参数（不含 "git" 本身）
 * @param withIdentity 是否注入提交身份兜底（commit 类命令用）
 */
function runGit(
  root: string,
  args: string[],
  withIdentity = false
): Promise<{ code: number; stdout: string; stderr: string }> {
  const finalArgs = [
    '-c', 'core.quotepath=false',
    ...(withIdentity ? ['-c', 'user.name=TraeCode', '-c', 'user.email=traecode@local'] : []),
    ...args
  ]
  return new Promise((resolve) => {
    const proc = spawn('git', finalArgs, { cwd: root, windowsHide: true })
    let stdout = ''
    let stderr = ''
    proc.stdout?.on('data', (c: Buffer) => { stdout += c.toString('utf-8') })
    proc.stderr?.on('data', (c: Buffer) => { stderr += c.toString('utf-8') })
    proc.on('error', (e) => resolve({ code: -1, stdout: '', stderr: e.message }))
    proc.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

/** 工作区是否为 git 仓库（含其上层目录有 .git 的情况） */
export async function isRepo(root: string): Promise<boolean> {
  if (!root) return false
  const r = await runGit(root, ['rev-parse', '--is-inside-work-tree'])
  return r.code === 0 && r.stdout.trim() === 'true'
}

/** 显式初始化仓库（用户触发） */
export async function initRepo(root: string): Promise<GitResult> {
  const r = await runGit(root, ['init'])
  return r.code === 0
    ? { ok: true }
    : { ok: false, error: r.stderr || 'git init 失败' }
}

// ---------------- porcelain 解析（纯函数，可单测） ----------------

/**
 * 解析 `git status --porcelain=v1 -z` 的 NUL 分隔输出。
 * 普通条目格式："XY path\0"；rename/copy 条目："XY newPath\0oldPath\0"。
 * X=暂存区状态，Y=工作区状态；?? 表示未跟踪。
 */
export function parsePorcelain(output: string): GitChange[] {
  const changes: GitChange[] = []
  const tokens = output.split('\0')
  // 末尾 \0 会产生一个空 token
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i]
    if (!entry || entry.length < 3) continue
    const x = entry[0]
    const y = entry[1]
    const path = entry.slice(3)
    const code = x + y

    // rename/copy：后跟原路径 token
    let oldPath: string | undefined
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      oldPath = tokens[i + 1] || undefined
      if (oldPath !== undefined) i++
    }

    changes.push({
      path,
      status: classifyStatus(x, y),
      staged: x !== ' ' && x !== '?',
      oldPath,
      rawCode: code
    })
  }
  return changes
}

/** porcelain XY 状态码 → 业务类型 */
export function classifyStatus(x: string, y: string): GitChange['status'] {
  if (x === '?' && y === '?') return 'untracked'
  if (x === 'R' || y === 'R' || x === 'C' || y === 'C') return 'renamed'
  // 工作区删除优先（暂存区可能同时有别的状态）
  if (y === 'D') return 'deleted'
  if (x === 'D') return 'deleted'
  if (x === 'A') return 'added'
  if (y === 'A') return 'added'
  if (x === 'M' || y === 'M') return 'modified'
  return 'unknown'
}

/** 查询工作区全部改动 */
export async function status(root: string): Promise<GitResult<GitChange[]>> {
  const r = await runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  if (r.code !== 0) return { ok: false, error: r.stderr || 'git status 失败' }
  return { ok: true, data: parsePorcelain(r.stdout) }
}

// ---------------- SCM 分组（源代码管理面板） ----------------

/** SCM 面板单条项：保留 porcelain XY 双字母，支持同一文件同现两组 */
export interface ScmItem {
  /** 相对仓库根（cwd）的路径 */
  path: string
  /** rename/copy 时的原路径 */
  oldPath?: string
  /** 暂存区状态字母 X（' ' 表示无暂存改动） */
  indexLetter: string
  /** 工作区状态字母 Y（' ' 表示无工作区改动） */
  worktreeLetter: string
  /** 原始 porcelain 双字母码 */
  rawCode: string
}

/** SCM 三分组结果 */
export interface ScmGrouped {
  /** 当前分支名（detached / unborn 时为 null） */
  currentBranch: string | null
  /** 是否存在 HEAD（刚 init、尚无提交时 false） */
  hasHead: boolean
  /** 已暂存 */
  staged: ScmItem[]
  /** 未暂存（不含未跟踪） */
  unstaged: ScmItem[]
  /** 未跟踪 */
  untracked: ScmItem[]
}

/** GitChange → ScmItem，拆出双字母 */
export function toScmItem(change: GitChange): ScmItem {
  return {
    path: change.path,
    oldPath: change.oldPath,
    indexLetter: change.rawCode[0],
    worktreeLetter: change.rawCode[1],
    rawCode: change.rawCode
  }
}

/**
 * 纯函数：把扁平改动列表拆成 SCM 三组。
 * - ?? 只进 untracked；
 * - X ≠ ' '/'?' 进 staged；Y ≠ ' '/'?' 进 unstaged；
 * - 「暂存后再改」（MM/AM/MD 等）同一文件同时进 staged 与 unstaged。
 */
export function groupChanges(
  changes: GitChange[]
): Pick<ScmGrouped, 'staged' | 'unstaged' | 'untracked'> {
  const staged: ScmItem[] = []
  const unstaged: ScmItem[] = []
  const untracked: ScmItem[] = []
  for (const c of changes) {
    if (c.status === 'untracked') {
      untracked.push(toScmItem(c))
      continue
    }
    const item = toScmItem(c)
    // 以原始字母为准（classifyStatus 会压平双端状态）
    if (c.rawCode[0] !== ' ' && c.rawCode[0] !== '?') staged.push(item)
    if (c.rawCode[1] !== ' ' && c.rawCode[1] !== '?') unstaged.push(item)
  }
  return { staged, unstaged, untracked }
}

/**
 * 查询 SCM 分组数据：改动三组 + 当前分支 + HEAD 是否存在。
 * currentBranch 走 symbolic-ref（detached/unborn 返回 null，属正常）。
 */
export async function statusGrouped(root: string): Promise<GitResult<ScmGrouped>> {
  const st = await status(root)
  if (!st.ok || !st.data) return { ok: false, error: st.error || 'git status 失败' }
  const groups = groupChanges(st.data)

  const [branchR, headR] = await Promise.all([
    runGit(root, ['symbolic-ref', '--short', 'HEAD']),
    runGit(root, ['rev-parse', '--verify', 'HEAD'])
  ])
  return {
    ok: true,
    data: {
      currentBranch: branchR.code === 0 ? branchR.stdout.trim() : null,
      hasHead: headR.code === 0,
      ...groups
    }
  }
}

// ---------------- 暂存 / 取消暂存 ----------------

/** 单次暂存操作的文件数上限（防超长命令行） */
export const MAX_SCM_PATHS = 2000

/**
 * 纯函数：校验并规范化 SCM 相对路径列表。
 * 规则：必须数组且 ≤2000；拒绝绝对路径 / NUL / pathspec 魔法前缀 ':' / '-' 开头；
 * 每个相对路径 join(root) 后必须落在工作区内；去重、统一正斜杠。
 * @returns 规范化后的路径数组
 */
export function validateScmPaths(root: string, paths: string[]): GitResult<string[]> {
  if (!Array.isArray(paths)) return { ok: false, error: '路径列表必须是数组' }
  if (paths.length > MAX_SCM_PATHS) {
    return { ok: false, error: `单次操作文件数超过 ${MAX_SCM_PATHS} 上限` }
  }
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of paths) {
    const p = String(raw ?? '').replaceAll('\\', '/').trim()
    if (!p) continue
    if (p.includes('\0')) return { ok: false, error: '路径包含非法字符' }
    if (p.startsWith('/') || /^[a-z]:/i.test(p)) {
      return { ok: false, error: '不支持绝对路径' }
    }
    // -- 之后 '-' 开头虽不再是选项，但统一拒绝避免歧义；':' 是 git pathspec 魔法前缀
    if (p.startsWith('-') || p.startsWith(':')) {
      return { ok: false, error: '非法路径前缀' }
    }
    // isWithinWorkspace 中段比较对分隔符敏感：root 与 abs 统一正斜杠
    const normRoot = root.replaceAll('\\', '/')
    const abs = resolve(normRoot, p).replaceAll('\\', '/')
    if (!isWithinWorkspace(abs, normRoot)) {
      return { ok: false, error: `路径超出工作区边界：${p}` }
    }
    if (!seen.has(p)) {
      seen.add(p)
      result.push(p)
    }
  }
  return { ok: true, data: result }
}

/**
 * 暂存文件：空数组（含全部为空白）= 暂存当前目录全部改动（git add -A）；
 * 否则 git add -- <paths>。
 */
export async function stagePaths(root: string, paths: string[]): Promise<GitResult> {
  const checked = validateScmPaths(root, paths)
  if (!checked.ok) return checked
  const list = checked.data ?? []
  const args = list.length === 0 ? ['add', '-A'] : ['add', '--', ...list]
  const r = await runGit(root, args)
  return r.code === 0
    ? { ok: true }
    : { ok: false, error: r.stderr || 'git add 失败' }
}

/**
 * 取消暂存：优先 git restore --staged；失败回退 git reset -q HEAD。
 * 空数组 = 取消暂存全部（restore 必须带 pathspec，用 '.' 覆盖当前目录）。
 * 注：unborn 分支下 restore --staged 同样可用；reset HEAD 不可用。
 */
export async function unstagePaths(root: string, paths: string[]): Promise<GitResult> {
  const checked = validateScmPaths(root, paths)
  if (!checked.ok) return checked
  const list = checked.data ?? []
  const all = list.length === 0

  const restoreArgs = all
    ? ['restore', '--staged', '--', '.']
    : ['restore', '--staged', '--', ...list]
  const restore = await runGit(root, restoreArgs)
  if (restore.code === 0) return { ok: true }

  // 回退旧语法（git < 2.23）
  const resetArgs = all ? ['reset', '-q', 'HEAD'] : ['reset', '-q', 'HEAD', '--', ...list]
  const reset = await runGit(root, resetArgs)
  return reset.code === 0
    ? { ok: true }
    : { ok: false, error: restore.stderr || reset.stderr || '取消暂存失败' }
}

// ---------------- 提交（仅暂存区） ----------------

/**
 * 提交已暂存改动。与 createCheckpoint 不同：不做 add -A，只提交暂存区。
 * 空暂存 / nothing to commit 返回错误文案；成功回传新提交 hash。
 */
export async function commitStaged(
  root: string,
  message: string
): Promise<GitResult<{ hash: string }>> {
  const msg = message.replace(/[\r\n]+/g, ' ').trim().slice(0, 200) || '更新'
  const r = await runGit(root, ['commit', '-m', msg], true)
  if (r.code !== 0) {
    if (/nothing to commit|no changes added/i.test(r.stdout + r.stderr)) {
      return { ok: false, error: '暂存区没有可提交的改动' }
    }
    return { ok: false, error: r.stderr || r.stdout || 'git commit 失败' }
  }
  const hash = await runGit(root, ['rev-parse', 'HEAD'])
  return { ok: true, data: { hash: hash.stdout.trim() } }
}

// ---------------- 分支 ----------------

/** 分支信息（仅本地分支） */
export interface BranchInfo {
  name: string
  /** 是否为当前检出分支 */
  current: boolean
}

/**
 * 纯函数：解析 `git for-each-ref --format=%(refname:short) refs/heads` 输出。
 * 分支名不可能含换行（check-ref-format 禁止）；currentBranch 用于标记当前项。
 */
export function parseBranchList(output: string, currentBranch: string | null): BranchInfo[] {
  return output
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((name) => ({ name, current: name === currentBranch }))
}

/**
 * 纯函数：校验分支名（对齐 git check-ref-format 的分支命名限制）。
 * 拒绝：空串、单字符 @、开头 -//、`..`、~ ^ : ? * [ \、空白、`@{`、
 * 连续 //、结尾 /.、结尾 .lock。
 */
export function isValidBranchName(name: string): boolean {
  if (typeof name !== 'string') return false
  const n = name.trim()
  if (!n || n === '@' || n.length > 128) return false
  if (n.startsWith('-') || n.startsWith('/')) return false
  if (n.endsWith('/') || n.endsWith('.')) return false
  if (n.endsWith('.lock')) return false
  if (n.includes('..')) return false
  if (n.includes('//')) return false
  if (n.includes('@{')) return false
  // eslint-disable-next-line no-control-regex
  if (/[~^:?*[\]\\\s]/.test(n)) return false
  return true
}

/** 列出本地分支（for-each-ref，git branch 没有 --porcelain 选项） */
export async function listBranches(root: string): Promise<GitResult<BranchInfo[]>> {
  const [ls, cur] = await Promise.all([
    runGit(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
    runGit(root, ['symbolic-ref', '--short', 'HEAD'])
  ])
  if (ls.code !== 0) return { ok: false, error: ls.stderr || '分支查询失败' }
  const current = cur.code === 0 ? cur.stdout.trim() : null
  return { ok: true, data: parseBranchList(ls.stdout, current) }
}

/** 切换到已存在的本地分支：git switch -- <name> */
export async function switchBranch(root: string, name: string): Promise<GitResult> {
  if (!isValidBranchName(name)) return { ok: false, error: '非法分支名' }
  const r = await runGit(root, ['switch', '--', name])
  return r.code === 0
    ? { ok: true }
    : { ok: false, error: r.stderr || '分支切换失败' }
}

/** 新建并切换分支：git switch -c <name>；重名/非法由 git 或校验拦截 */
export async function createBranch(root: string, name: string): Promise<GitResult> {
  if (!isValidBranchName(name)) return { ok: false, error: '非法分支名' }
  const r = await runGit(root, ['switch', '-c', name])
  return r.code === 0
    ? { ok: true }
    : { ok: false, error: r.stderr || '分支创建失败' }
}

// ---------------- 文件差异 ----------------

/** 读取某路径在 HEAD 中的内容（新文件返回空串） */
async function headContent(root: string, path: string): Promise<string> {
  const r = await runGit(root, ['show', `HEAD:${path}`])
  return r.code === 0 ? r.stdout : ''
}

/**
 * 获取单文件 diff：统一 patch + 新旧两侧全文（供 Monaco DiffEditor）。
 * untracked 文件用 git diff --no-index /dev/null 比对（退出码 1 表示有差异，属正常）。
 */
export async function diffFile(root: string, change: GitChange): Promise<GitResult<FileDiff>> {
  const abs = join(root, change.path)
  let deleted = false
  let newContent = ''
  try {
    const st = statSync(abs)
    if (st.size > MAX_DIFF_BYTES) {
      return { ok: false, error: `文件过大（${Math.round(st.size / 1024)}KB），超过 200KB 差异预览上限` }
    }
    newContent = readFileSync(abs, 'utf-8')
  } catch {
    deleted = true
  }

  let patch: string
  if (change.status === 'untracked') {
    // /dev/null 在 Windows git 下同样可用；退出码 1 = 存在差异
    const r = await runGit(root, ['diff', '--no-index', '--', '/dev/null', change.path])
    patch = r.stdout || `新建文件：${change.path}`
  } else {
    const r = await runGit(root, ['diff', 'HEAD', '--', change.path])
    if (r.code !== 0) return { ok: false, error: r.stderr || 'git diff 失败' }
    patch = r.stdout
  }

  const oldContent = change.status === 'untracked' ? '' : await headContent(root, change.path)
  return {
    ok: true,
    data: { path: change.path, patch, oldContent, newContent, deleted }
  }
}

// ---------------- 检查点 ----------------

/** 清洗提交信息：去除换行（防多行注入）、限制长度 */
export function sanitizeCommitMessage(label: string): string {
  return label.replace(/[\r\n]+/g, ' ').trim().slice(0, 200) || '检查点'
}

/**
 * 创建检查点：git add -A 后提交。
 * 无任何变更时不产生空提交，返回 {created:false}。
 */
export async function createCheckpoint(
  root: string,
  label: string
): Promise<GitResult<{ created: boolean; hash?: string; reason?: string }>> {
  const add = await runGit(root, ['add', '-A'])
  if (add.code !== 0) return { ok: false, error: add.stderr || 'git add 失败' }

  const msg = `trae-checkpoint: ${sanitizeCommitMessage(label)}`
  const commit = await runGit(root, ['commit', '-m', msg], true)
  if (commit.code !== 0) {
    // nothing to commit 属正常情况
    if (/nothing to commit|no changes added/i.test(commit.stdout + commit.stderr)) {
      return { ok: true, data: { created: false, reason: '工作区没有变更，未创建检查点' } }
    }
    return { ok: false, error: commit.stderr || commit.stdout || 'git commit 失败' }
  }
  const hash = await runGit(root, ['rev-parse', 'HEAD'])
  return {
    ok: true,
    data: { created: true, hash: hash.stdout.trim() || undefined }
  }
}

/** 解析 git log 自定义分隔输出（纯函数） */
export function parseLog(output: string): GitCheckpoint[] {
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, shortHash, author, date, ...rest] = line.split('\x1f')
      const subject = rest.join('\x1f')
      return {
        hash,
        shortHash,
        author,
        date,
        subject,
        isTrae: subject.startsWith('trae-checkpoint:')
      }
    })
    .filter((c) => c.hash)
}

/** 列出最近的检查点/提交（默认 30 条） */
export async function listCheckpoints(root: string, limit = 30): Promise<GitResult<GitCheckpoint[]>> {
  const fmt = '%H%x1f%h%x1f%an%x1f%ad%x1f%s'
  const r = await runGit(root, ['log', `-${limit}`, `--format=${fmt}`, '--date=format:%Y-%m-%d %H:%M'])
  if (r.code !== 0) {
    // 尚无提交（刚 init）返回空列表而非错误
    if (/does not have any commits|bad default revision/i.test(r.stderr)) {
      return { ok: true, data: [] }
    }
    return { ok: false, error: r.stderr || 'git log 失败' }
  }
  return { ok: true, data: parseLog(r.stdout) }
}

/**
 * 回滚到指定检查点：git reset --hard <hash>。
 * 调用方必须先取得用户强确认。
 * 注意：reset --hard 不删未跟踪文件；任务放弃链路在回滚后由 cleanupTaskCreatedFiles 精确清理。
 */
export async function restoreCheckpoint(root: string, hash: string): Promise<GitResult> {
  // 仅接受完整/短 hash（十六进制），防参数注入
  if (!/^[0-9a-f]{7,40}$/i.test(hash)) {
    return { ok: false, error: '非法的检查点 hash' }
  }
  const r = await runGit(root, ['reset', '--hard', hash])
  return r.code === 0
    ? { ok: true, data: r.stdout.trim() }
    : { ok: false, error: r.stderr || 'git reset 失败' }
}

/** 解析当前 HEAD hash（工作区无变更时，HEAD 本身就是合法的任务前回滚目标） */
export async function resolveHead(root: string): Promise<string | null> {
  const r = await runGit(root, ['rev-parse', 'HEAD'])
  return r.code === 0 ? r.stdout.trim() || null : null
}

/**
 * 纯判定：回滚后，任务登记的 createdFiles 中哪些应删除。
 * 判据（缺一不可）：位于工作区内 + 回滚后不被 git 跟踪。
 * 被 git 跟踪的文件在检查点中已固化，reset 已恢复其任务前内容，绝不能删。
 * @param root            工作区根
 * @param absPaths        任务快照登记的 createdFiles（绝对路径）
 * @param trackedRelative 回滚后 git ls-files 结果（仓库相对路径，正斜杠）
 * @returns 应删除的绝对路径（去重、规范化）
 */
export function planCreatedFileCleanup(
  root: string,
  absPaths: string[],
  trackedRelative: Set<string>
): string[] {
  const toDelete = new Set<string>()
  // 先统一斜杠：工作区根可能来自快照（正斜杠）或系统路径（反斜杠），
  // isWithinWorkspace 不做内部归一，混斜杠会误判越界
  const normRoot = root.replaceAll('\\', '/')
  for (const raw of absPaths) {
    const abs = raw?.trim()
    if (!abs || !isWithinWorkspace(abs.replaceAll('\\', '/'), normRoot)) continue
    const normAbs = resolve(abs)
    if (normAbs === resolve(root)) continue
    const rel = relative(root, normAbs).replaceAll('\\', '/')
    // 理论上边界检查已排除 ../，双保险
    if (!rel || rel.startsWith('../')) continue
    if (trackedRelative.has(rel)) continue
    toDelete.add(normAbs)
  }
  return [...toDelete]
}

/**
 * 任务放弃回滚后的残留清理：删除任务新建、reset --hard 保留下来的未跟踪文件，
 * 并顺带移除因此变空的目录（止步于工作区根）。
 * 不做 `git clean -fdx`——那会误删与任务无关的未跟踪文件；只认快照登记名单。
 */
export async function cleanupTaskCreatedFiles(
  root: string,
  absPaths: string[]
): Promise<string[]> {
  // 先按工作区边界过滤并转仓库相对 pathspec（ls-files 不认越界路径）
  const candidates: { abs: string; rel: string }[] = []
  // 同 planCreatedFileCleanup：统一斜杠后再做边界判定
  const normRoot = root.replaceAll('\\', '/')
  for (const raw of absPaths) {
    const abs = raw?.trim()
    if (!abs || !isWithinWorkspace(abs.replaceAll('\\', '/'), normRoot)) continue
    const normAbs = resolve(abs)
    if (normAbs === resolve(root)) continue
    const rel = relative(root, normAbs).replaceAll('\\', '/')
    if (!rel || rel.startsWith('../')) continue
    candidates.push({ abs: normAbs, rel })
  }
  if (candidates.length === 0) return []

  // 回滚后仍跟踪的 = 预存文件（检查点固化），保留
  const tracked = new Set<string>()
  const ls = await runGit(root, ['ls-files', '--', ...candidates.map((c) => c.rel)])
  if (ls.code === 0) {
    for (const line of ls.stdout.split('\n').filter(Boolean)) {
      tracked.add(line.replace(/\\/g, '/'))
    }
  }
  const willDelete = planCreatedFileCleanup(
    root,
    candidates.map((c) => c.abs),
    tracked
  )

  const deleted: string[] = []
  for (const abs of willDelete) {
    try {
      if (!existsSync(abs)) continue
      rmSync(abs, { force: true })
      deleted.push(abs)
      // 文件删掉后父目录可能已空（AI 新建目录场景），逐层尝试删，遇非空立即停止
      let dir = dirname(abs)
      const rootNorm = resolve(root)
      while (resolve(dir) !== rootNorm && isWithinWorkspace(dir, root)) {
        try {
          rmdirSync(dir)
          dir = dirname(dir)
        } catch {
          break
        }
      }
    } catch {
      // 单个文件删除失败不阻断其余清理
    }
  }
  return deleted
}

/**
 * 还原单个 tracked 文件到 HEAD（放弃改动/恢复删除）。
 * untracked 新文件不在此处删除——由前端确认后走 fs:trash 回收站。
 */
export async function restoreTrackedFile(root: string, change: GitChange): Promise<GitResult> {
  if (change.status === 'untracked') {
    return { ok: false, error: '未跟踪文件请通过删除操作移除' }
  }
  const r = await runGit(root, ['checkout', 'HEAD', '--', change.path])
  return r.code === 0
    ? { ok: true }
    : { ok: false, error: r.stderr || '还原失败' }
}

// ---------------- IPC 注册 ----------------

export function registerGitHandlers(): void {
  ipcMain.handle('git:isRepo', async (_e, root: string) => isRepo(root))

  ipcMain.handle('git:init', async (_e, root: string): Promise<GitResult> => initRepo(root))

  ipcMain.handle('git:status', async (_e, root: string): Promise<GitResult<GitChange[]>> =>
    status(root)
  )

  ipcMain.handle(
    'git:diffFile',
    async (_e, root: string, change: GitChange): Promise<GitResult<FileDiff>> =>
      diffFile(root, change)
  )

  ipcMain.handle(
    'git:checkpointCreate',
    async (_e, root: string, label: string) => createCheckpoint(root, label)
  )

  ipcMain.handle(
    'git:checkpointList',
    async (_e, root: string): Promise<GitResult<GitCheckpoint[]>> => listCheckpoints(root)
  )

  ipcMain.handle(
    'git:checkpointRestore',
    async (_e, root: string, hash: string): Promise<GitResult> => restoreCheckpoint(root, hash)
  )

  ipcMain.handle(
    'git:fileRestore',
    async (_e, root: string, change: GitChange): Promise<GitResult> =>
      restoreTrackedFile(root, change)
  )

  // SCM 源代码管理面板七通道
  ipcMain.handle(
    'git:statusGrouped',
    async (_e, root: string): Promise<GitResult<ScmGrouped>> => statusGrouped(root)
  )

  ipcMain.handle(
    'git:stage',
    async (_e, root: string, paths: string[]): Promise<GitResult> => stagePaths(root, paths)
  )

  ipcMain.handle(
    'git:unstage',
    async (_e, root: string, paths: string[]): Promise<GitResult> => unstagePaths(root, paths)
  )

  ipcMain.handle(
    'git:commit',
    async (_e, root: string, message: string) => commitStaged(root, message)
  )

  ipcMain.handle(
    'git:branchList',
    async (_e, root: string): Promise<GitResult<BranchInfo[]>> => listBranches(root)
  )

  ipcMain.handle(
    'git:checkoutBranch',
    async (_e, root: string, name: string): Promise<GitResult> => switchBranch(root, name)
  )

  ipcMain.handle(
    'git:createBranch',
    async (_e, root: string, name: string): Promise<GitResult> => createBranch(root, name)
  )
}
