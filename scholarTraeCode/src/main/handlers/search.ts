// 全局搜索/替换 IPC：search:query / search:replacePreview / search:replaceApply。
//
// 安全与校验：
// - 所有通道首参为工作区根 root（与 git 域一致，由渲染端显式传入）；
// - 替换勾选的文件路径必须位于 root 之内（isWithinWorkspace），防路径穿越；
// - 入参做类型规整：布尔选项强制 Boolean、glob 数组过滤为非空字符串；
// - 返回统一 {ok, data | error}，错误信息为可直接展示的中文文案。
import { ipcMain } from 'electron'
import { isWithinWorkspace } from '../terminal/shellProbe'
import {
  runContentSearch,
  buildReplacePlan,
  applyReplace,
  type ContentSearchParams
} from '../search/searchEngine'

/** 统一通道返回 */
type SearchChannelResult<T> = { ok: true; data: T } | { ok: false; error: string }

/** 规整后的 UI 搜索入参 */
interface UiSearchInput {
  query: string
  caseSensitive: boolean
  wholeWord: boolean
  regexMode: boolean
  includes: string[]
  excludes: string[]
}

/** 把 unknown 规整为字符串数组（只保留非空字符串，去首尾空白） */
function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v
    .filter((x): x is string => typeof x === 'string')
    .map(x => x.trim())
    .filter(Boolean)
}

/**
 * 校验并规整搜索入参。
 * @returns 规整后的参数；校验失败返回错误文案
 */
function parseSearchInput(raw: unknown): UiSearchInput | string {
  if (typeof raw !== 'object' || raw === null) return '搜索参数无效'
  const o = raw as Record<string, unknown>
  if (typeof o.query !== 'string' || !o.query) return '搜索内容不能为空'
  // 查询串长度限制：正则模式下防止超长模式造成引擎卡顿
  if (o.query.length > 10000) return '搜索内容过长（上限 10000 字符）'
  return {
    query: o.query,
    caseSensitive: Boolean(o.caseSensitive),
    wholeWord: Boolean(o.wholeWord),
    regexMode: Boolean(o.regexMode),
    includes: toStringArray(o.includes),
    excludes: toStringArray(o.excludes)
  }
}

/** 校验 root 工作区根 */
function parseRoot(root: unknown): string | null {
  return typeof root === 'string' && root.trim() ? root : null
}

/** 替换预览/应用入参：搜索入参 + replaceText */
interface UiReplaceInput extends UiSearchInput {
  replaceText: string
}

/** 校验替换入参（replaceText 允许空串＝删除匹配） */
function parseReplaceInput(raw: unknown): UiReplaceInput | string {
  const base = parseSearchInput(raw)
  if (typeof base === 'string') return base
  const replaceText = (raw as Record<string, unknown>).replaceText
  if (typeof replaceText !== 'string') return '替换内容无效'
  if (replaceText.length > 10000) return '替换内容过长（上限 10000 字符）'
  return { ...base, replaceText }
}

export function registerSearchHandlers(): void {
  // 内容搜索
  ipcMain.handle(
    'search:query',
    async (_e, root: unknown, raw: unknown): Promise<SearchChannelResult<Awaited<ReturnType<typeof runContentSearch>>>> => {
      const rootDir = parseRoot(root)
      if (!rootDir) return { ok: false, error: '工作区未打开，无法搜索' }
      const input = parseSearchInput(raw)
      if (typeof input === 'string') return { ok: false, error: input }
      try {
        const params: ContentSearchParams = {
          query: input.query,
          caseSensitive: input.caseSensitive,
          wholeWord: input.wholeWord,
          regexMode: input.regexMode,
          includes: input.includes,
          excludes: input.excludes
        }
        return { ok: true, data: await runContentSearch(rootDir, params) }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // 替换预览
  ipcMain.handle(
    'search:replacePreview',
    async (_e, root: unknown, raw: unknown): Promise<SearchChannelResult<Awaited<ReturnType<typeof buildReplacePlan>>>> => {
      const rootDir = parseRoot(root)
      if (!rootDir) return { ok: false, error: '工作区未打开，无法替换' }
      const input = parseReplaceInput(raw)
      if (typeof input === 'string') return { ok: false, error: input }
      try {
        const data = await buildReplacePlan(rootDir, {
          query: input.query,
          caseSensitive: input.caseSensitive,
          wholeWord: input.wholeWord,
          regexMode: input.regexMode,
          includes: input.includes,
          excludes: input.excludes,
          replaceText: input.replaceText
        })
        return { ok: true, data }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // 应用替换
  ipcMain.handle(
    'search:replaceApply',
    async (_e, root: unknown, raw: unknown): Promise<SearchChannelResult<Awaited<ReturnType<typeof applyReplace>>>> => {
      const rootDir = parseRoot(root)
      if (!rootDir) return { ok: false, error: '工作区未打开，无法替换' }
      const input = parseReplaceInput(raw)
      if (typeof input === 'string') return { ok: false, error: input }

      // 校验 selections：必须是数组、每项 path 为工作区内字符串、expectedCount 为非负整数
      const selectionsRaw = (raw as Record<string, unknown>).selections
      if (!Array.isArray(selectionsRaw) || selectionsRaw.length === 0) {
        return { ok: false, error: '未选择任何替换文件' }
      }
      const selections: { path: string; expectedCount: number }[] = []
      for (const item of selectionsRaw) {
        if (typeof item !== 'object' || item === null) {
          return { ok: false, error: '替换选择项无效' }
        }
        const { path: filePath, expectedCount } = item as Record<string, unknown>
        if (typeof filePath !== 'string' || !filePath) {
          return { ok: false, error: '替换文件路径无效' }
        }
        // 边界检查：替换目标必须位于工作区内
        if (!isWithinWorkspace(filePath, rootDir)) {
          return { ok: false, error: `文件位于工作区之外，已拒绝：${filePath}` }
        }
        if (typeof expectedCount !== 'number' || !Number.isInteger(expectedCount) || expectedCount < 0) {
          return { ok: false, error: '替换校验基准无效' }
        }
        // 同一文件重复勾选去重
        if (!selections.some(s => s.path === filePath)) {
          selections.push({ path: filePath, expectedCount })
        }
      }

      try {
        const data = await applyReplace({
          query: input.query,
          caseSensitive: input.caseSensitive,
          wholeWord: input.wholeWord,
          regexMode: input.regexMode,
          includes: input.includes,
          excludes: input.excludes,
          replaceText: input.replaceText,
          selections
        })
        return { ok: true, data }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )
}
