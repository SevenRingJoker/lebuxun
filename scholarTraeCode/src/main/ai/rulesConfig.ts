// 规则系统纯函数/存储层：三级规则发现、就近优先合并、项目级启停状态。
// 零 electron 依赖，可被 vitest 直接测试（tmpdir 隔离）。
// 规则文件：Markdown，文件名即规则名（白名单校验）。
// 三层作用域（优先级从低到高，同名高优先级覆盖）：
//   用户级  <userRulesDir>/*.md           （通常 ~/.trae/rules/）
//   项目级  <workspace>/.trae/rules/*.md  （支持 .state.json 启停）
//   目录级  <dir>/.trae/rules/*.md        （从 currentDir 向 workspace 上溯，越近越优先）
import { promises as fs } from 'node:fs'
import { join, dirname } from 'node:path'

export type RuleScope = 'user' | 'project' | 'directory'

export interface RuleMeta {
  name: string
  scope: RuleScope
  /** 规则文件绝对路径 */
  path: string
  /** 仅项目级支持启停；其余作用域恒为 true */
  enabled: boolean
  /** 内容预览（前 200 字符） */
  contentPreview: string
  /** 目录级专用：相对 workspace 的目录深度（0=workspace 根），越大越优先 */
  depth: number
}

export interface RuleWithContent extends RuleMeta {
  content: string
}

export const RULE_NAME_RE = /^[\w\u4e00-\u9fa5-]+$/

/** 目录级规则向上追溯的最大层数 */
export const DIRECTORY_RULE_MAX_DEPTH = 5

const PREVIEW_LEN = 200

/** 规则名合法性校验（防目录穿越；隐藏文件/状态文件天然被拒） */
export function validateRuleName(name: string): { ok: true } | { ok: false; error: string } {
  if (!name || !name.trim()) return { ok: false, error: '规则名不能为空' }
  if (name.length > 60) return { ok: false, error: '规则名过长（≤60 字符）' }
  if (!RULE_NAME_RE.test(name)) return { ok: false, error: '规则名仅允许字母/数字/中文/下划线/连字符' }
  return { ok: true }
}

function preview(content: string): string {
  const t = content.trim()
  return t.length > PREVIEW_LEN ? t.slice(0, PREVIEW_LEN) + '…' : t
}

/** 读取指定目录下的全部规则文件；目录不存在返回空数组 */
async function listRulesInDir(
  dir: string,
  scope: RuleScope,
  depth: number,
  projectState?: Record<string, boolean>
): Promise<RuleMeta[]> {
  try {
    const files = await fs.readdir(dir)
    const metas: RuleMeta[] = []
    for (const f of files) {
      if (!f.toLowerCase().endsWith('.md')) continue
      const name = f.replace(/\.md$/i, '')
      if (!RULE_NAME_RE.test(name)) continue
      const path = join(dir, f)
      try {
        const raw = await fs.readFile(path, 'utf-8')
        const enabled = scope === 'project' ? projectState?.[name] !== false : true
        metas.push({ name, scope, path, enabled, contentPreview: preview(raw), depth })
      } catch {
        // 单文件读取失败跳过
      }
    }
    return metas.sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

/** 项目级启停状态文件路径（.trae/rules/.state.json） */
export function ruleStatePath(workspace: string): string {
  return join(workspace, '.trae', 'rules', '.state.json')
}

/** 读取项目级规则启停状态；不存在/损坏返回空对象（默认全部启用） */
export async function loadRuleState(workspace: string): Promise<Record<string, boolean>> {
  try {
    const raw = await fs.readFile(ruleStatePath(workspace), 'utf-8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, boolean>
    }
    return {}
  } catch {
    return {}
  }
}

/** 保存项目级规则启停状态（原子写：tmp + rename） */
export async function saveRuleState(workspace: string, state: Record<string, boolean>): Promise<void> {
  const path = ruleStatePath(workspace)
  await fs.mkdir(dirname(path), { recursive: true })
  const tmp = path + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8')
  await fs.rename(tmp, path)
}

/**
 * 发现三层规则。
 * 返回顺序即合并优先级从低到高：用户级 → 项目级 → 目录级（远 → 近）。
 */
export async function discoverRules(opts: {
  workspace?: string | null
  userRulesDir?: string | null
  /** 目录级规则起点（通常当前打开文件所在目录），向 workspace 上溯 */
  currentDir?: string | null
}): Promise<RuleMeta[]> {
  const { workspace, userRulesDir, currentDir } = opts
  const result: RuleMeta[] = []

  // 1. 用户级
  if (userRulesDir) {
    result.push(...(await listRulesInDir(userRulesDir, 'user', 0)))
  }

  // 2. 项目级（读启停状态）
  if (workspace) {
    const state = await loadRuleState(workspace)
    result.push(...(await listRulesInDir(join(workspace, '.trae', 'rules'), 'project', 0, state)))
  }

  // 3. 目录级：从 workspace 根向 currentDir 逐层向下（远 → 近），保证合并时近者优先。
  // workspace 根本身属于项目级（第 2 步已收集），此处不含。
  if (workspace && currentDir && currentDir.startsWith(workspace)) {
    const layers: string[] = []
    let dir: string | null = currentDir
    for (let i = 0; i <= DIRECTORY_RULE_MAX_DEPTH && dir && dir !== workspace && dir.startsWith(workspace); i++) {
      layers.unshift(dir)
      const parent = dirname(dir)
      dir = parent === dir ? null : parent
    }
    for (let depth = 0; depth < layers.length; depth++) {
      result.push(...(await listRulesInDir(join(layers[depth], '.trae', 'rules'), 'directory', depth)))
    }
  }

  return result
}

/**
 * 就近优先合并规则：同名规则高优先级（目录级 > 项目级 > 用户级；目录级中更近者优先）覆盖。
 * 传入数组应按优先级从低到高排序（discoverRules 的返回顺序）。
 * 禁用规则被剔除。返回按名称排序的合并结果。
 */
export function mergeRules(rules: RuleWithContent[]): RuleWithContent[] {
  const byName = new Map<string, RuleWithContent>()
  for (const rule of rules) {
    if (!rule.enabled) continue
    byName.set(rule.name, rule) // 后者覆盖前者 = 就近优先
  }
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * 把合并后的规则渲染为可注入 Prompt 的文本（无规则返回空串）。
 * 每条规则一节，标注名称与作用域。
 */
export function renderRulesText(rules: RuleWithContent[]): string {
  if (rules.length === 0) return ''
  const scopeLabel: Record<RuleScope, string> = { user: '用户级', project: '项目级', directory: '目录级' }
  return rules
    .map((r) => `### 规则「${r.name}」（${scopeLabel[r.scope]}）\n${r.content.trim()}`)
    .join('\n\n')
}
