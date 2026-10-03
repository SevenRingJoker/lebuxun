// 技能系统：把特定领域知识（设计规范、API 用法、项目约定）封装为可渐进加载的技能包。
// 技能来源两类：
//   1. 应用内置：resources/skills/<name>.md（随安装包分发，node/python/go/docker 四个脚手架）
//   2. 工作区自定义：<workspace>/.trae/skills/<name>.md（同名覆盖内置）
// 每个技能文件：
//   文件名 = 技能名（仅允许字母数字/中文/下划线/连字符）
//   frontmatter description = 简短描述（常驻 S8 层，供 Agent 判断是否需要）
//   frontmatter triggers = 触发关键词（generatePlan 据此推荐）
//   完整内容 = 通过 use_skill 工具按需加载，避免一次性占满上下文窗口。
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { SKILL_NAME_RE, parseSkillMarkdown } from './skillConfig'

/** 技能元信息（轻量，常驻 Prompt） */
export interface SkillMeta {
  name: string
  description: string
  /** 是否启用（frontmatter enabled 字段，缺省 true）；禁用的技能不注入 S8 */
  enabled?: boolean
  /** 触发关键词（小写）：用户请求命中时推荐 */
  triggers: string[]
  /** 是否为应用内置技能（工作区覆盖时为 false） */
  builtin: boolean
  /** 技能文件绝对路径（管理 UI 编辑/删除用） */
  sourcePath?: string
}

/** 技能名白名单校验，防止目录穿越 */
const NAME_RE = SKILL_NAME_RE

/** 工作区技能目录绝对路径 */
function skillsDir(workspace: string): string {
  return join(workspace, '.trae', 'skills')
}

/**
 * 应用内置技能目录绝对路径。
 * - 打包后：resources/** 打入 app.asar，app.getAppPath() 返回 asar 路径，Electron fs 可直接读 asar 内文件。
 * - dev（electron-vite）与 vitest：cwd 即项目根，直接用 process.cwd()/resources/skills。
 * 注意：vitest 下 electron 的 app 为 undefined，故必须先判断 app?.isPackaged。
 */
export function builtinSkillsDir(): string {
  if (app && app.isPackaged) {
    return join(app.getAppPath(), 'resources', 'skills')
  }
  return join(process.cwd(), 'resources', 'skills')
}

/**
 * 读取单个目录下全部技能（内置/工作区共用逻辑）。
 * 目录不存在时返回空数组——技能是可选增强，不阻断主流程。单个文件失败跳过。
 */
async function readSkillsDir(dir: string, builtin: boolean): Promise<SkillMeta[]> {
  const metas: SkillMeta[] = []
  let files: string[]
  try {
    files = await fs.readdir(dir)
  } catch {
    return []
  }
  for (const f of files) {
    if (!f.toLowerCase().endsWith('.md')) continue
    const name = f.replace(/\.md$/i, '')
    if (!NAME_RE.test(name)) continue
    try {
      const raw = await fs.readFile(join(dir, f), 'utf-8')
      const parsed = parseSkillMarkdown(raw)
      metas.push({
        name,
        description: parsed.description,
        enabled: parsed.enabled,
        triggers: parsed.triggers,
        builtin,
        sourcePath: join(dir, f)
      })
    } catch {
      // 单个文件读取失败跳过
    }
  }
  return metas
}

/**
 * 列出全部技能：应用内置 + 工作区自定义，同名时工作区覆盖内置。
 * 无工作区（workspace 为空）时只返回内置技能。
 */
export async function listSkills(workspace: string | null | undefined): Promise<SkillMeta[]> {
  const builtin = await readSkillsDir(builtinSkillsDir(), true)
  const custom = workspace ? await readSkillsDir(skillsDir(workspace), false) : []
  // 工作区同名覆盖内置：以内置为底，custom 命中同名时替换
  const byName = new Map<string, SkillMeta>()
  for (const m of builtin) byName.set(m.name, m)
  for (const m of custom) byName.set(m.name, m)
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * 按需加载技能全文（use_skill 工具调用）。
 * 工作区文件优先；不存在时回退内置技能。
 */
export async function loadSkill(workspace: string | null | undefined, name: string): Promise<string> {
  if (!NAME_RE.test(name)) return `错误：非法技能名 ${name}`
  // 1) 工作区自定义
  if (workspace) {
    try {
      const raw = await fs.readFile(join(skillsDir(workspace), `${name}.md`), 'utf-8')
      return truncate(raw)
    } catch {
      // 落到内置回退
    }
  }
  // 2) 应用内置
  try {
    const raw = await fs.readFile(join(builtinSkillsDir(), `${name}.md`), 'utf-8')
    return truncate(raw)
  } catch {
    return `错误：未找到技能 ${name}（用 list_skills 查看可用技能）`
  }
}

/** 技能全文上限，避免单篇占满上下文 */
function truncate(raw: string): string {
  return raw.length > 12000 ? raw.slice(0, 12000) + '\n...(技能内容过长已截断)' : raw
}

/**
 * 按用户请求文本匹配触发关键词，返回推荐技能名集合。
 * 命中规则：请求文本（小写）包含任一 trigger 词；禁用技能不推荐。
 */
export function recommendSkills(skills: SkillMeta[], requestText: string): Set<string> {
  const text = (requestText || '').toLowerCase()
  const result = new Set<string>()
  if (!text) return result
  for (const s of skills) {
    if (s.enabled === false) continue
    if (s.triggers.some((t) => t && text.includes(t))) result.add(s.name)
  }
  return result
}

/**
 * 把技能清单渲染为 S8 层注入文本（无启用技能返回空串）。
 * 仅注入「名字 + 一句话描述」，全文由 Agent 按需 use_skill 加载。
 * 禁用的技能（enabled === false）不注入。recommended 集合中的技能加 ⭐ 推荐标记。
 */
export function renderSkillList(skills: SkillMeta[], recommended?: Set<string>): string {
  const active = skills.filter((s) => s.enabled !== false)
  if (active.length === 0) return ''
  const lines = active.map((s) => {
    const rec = recommended?.has(s.name) ? '⭐ [推荐] ' : ''
    const src = s.builtin ? '' : '（工作区）'
    return `- ${rec}${s.name}${src}: ${s.description}`
  })
  return (
    '可用技能包（需要详细内容时调用 use_skill 工具按需加载，不要凭空猜测技能内容；⭐ 标记的技能与当前任务高度匹配，建议先加载）：\n' +
    lines.join('\n')
  )
}
