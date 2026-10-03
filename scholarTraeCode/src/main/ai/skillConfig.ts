// 技能包配置纯函数层：frontmatter 解析/生成、名称校验、描述提取。
// 零 electron 依赖，可被 vitest 直接测试。
// 技能文件格式（.trae/skills/<name>.md 或应用内置 resources/skills/<name>.md）：
//   ---
//   name: 技能名（可选，文件名优先）
//   description: 一句话描述（可选，缺省从正文首段提取）
//   enabled: false（可选，缺省启用）
//   triggers: node, npm, express（可选，逗号分隔的触发关键词，generatePlan 据此推荐）
//   ---
//   正文 Markdown……
export const SKILL_NAME_RE = /^[\w\u4e00-\u9fa5-]+$/

export interface SkillConfigMeta {
  name: string
  description: string
  enabled: boolean
  /** 触发关键词（小写）：用户请求命中任一词时推荐加载本技能 */
  triggers: string[]
  content: string
}

/** 技能名合法性校验（防目录穿越） */
export function validateSkillName(name: string): { ok: true } | { ok: false; error: string } {
  if (!name || !name.trim()) return { ok: false, error: '技能名不能为空' }
  if (name.length > 60) return { ok: false, error: '技能名过长（≤60 字符）' }
  if (!SKILL_NAME_RE.test(name)) return { ok: false, error: '技能名仅允许字母/数字/中文/下划线/连字符' }
  return { ok: true }
}

/**
 * 从 Markdown 全文提取简短描述：
 * 跳过标题行（# 开头）与空行，取首个普通段落的前 120 字符。
 */
export function extractDescription(raw: string): string {
  // 跳过完整 frontmatter 块（--- ... ---）
  const fm = raw.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)
  const body = fm ? raw.slice(fm[0].length) : raw
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#') || t.startsWith('---')) continue
    return t.length > 120 ? t.slice(0, 120) + '…' : t
  }
  return '（无描述）'
}

/** 解析 triggers 值：按中英文逗号/顿号分隔，trim、小写、去空、去重 */
export function parseTriggers(value: string | undefined): string[] {
  if (!value) return []
  const seen = new Set<string>()
  for (const part of value.split(/[,，、]/)) {
    const t = part.trim().toLowerCase()
    if (t) seen.add(t)
  }
  return Array.from(seen)
}

/**
 * 解析技能 Markdown：识别 YAML frontmatter（支持 name/description/enabled/triggers 简单键值），
 * 无 frontmatter 时容错——描述从正文首段提取、enabled 默认 true、triggers 为空。
 * 返回的 name 字段来自 frontmatter（调用方通常以文件名为准覆盖）。
 */
export function parseSkillMarkdown(raw: string): SkillConfigMeta {
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!fm) {
    return { name: '', description: extractDescription(raw), enabled: true, triggers: [], content: raw }
  }
  const fields: Record<string, string> = {}
  for (const line of fm[1].split(/\r?\n/)) {
    const m = line.match(/^(\w+)\s*:\s*(.*)$/)
    if (m) fields[m[1].toLowerCase()] = m[2].trim()
  }
  const content = raw.slice(fm[0].length).replace(/^\s*\n/, '')
  const description = fields.description || extractDescription(content)
  return {
    name: fields.name ?? '',
    description,
    enabled: fields.enabled !== 'false',
    triggers: parseTriggers(fields.triggers),
    content
  }
}

/**
 * 生成标准技能 Markdown（带 frontmatter）。
 * name 写入 frontmatter 仅供人类阅读；加载时以文件名为准。
 */
export function renderSkillMarkdown(
  meta: { name: string; description?: string; enabled?: boolean },
  content: string
): string {
  const lines = ['---', `name: ${meta.name}`]
  if (meta.description) lines.push(`description: ${meta.description}`)
  if (meta.enabled === false) lines.push('enabled: false')
  lines.push('---', '')
  return lines.join('\n') + content.replace(/\s*$/, '') + '\n'
}
