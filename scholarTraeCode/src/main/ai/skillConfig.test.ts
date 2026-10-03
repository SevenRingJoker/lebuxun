// skillConfig 纯函数层单测
import { describe, it, expect } from 'vitest'
import {
  validateSkillName,
  extractDescription,
  parseTriggers,
  parseSkillMarkdown,
  renderSkillMarkdown
} from './skillConfig'

describe('validateSkillName', () => {
  it('合法名返回 ok', () => {
    expect(validateSkillName('vue-convention')).toEqual({ ok: true })
    expect(validateSkillName('组件设计规范')).toEqual({ ok: true })
  })
  it('空名被拒', () => {
    expect(validateSkillName('')).toEqual({ ok: false, error: '技能名不能为空' })
    expect(validateSkillName('   ')).toEqual({ ok: false, error: '技能名不能为空' })
  })
  it('非法字符被拒', () => {
    expect(validateSkillName('../escape')).toEqual({ ok: false, error: '技能名仅允许字母/数字/中文/下划线/连字符' })
  })
  it('过长被拒', () => {
    expect(validateSkillName('a'.repeat(61))).toEqual({ ok: false, error: '技能名过长（≤60 字符）' })
  })
})

describe('extractDescription', () => {
  it('从首段提取', () => {
    expect(extractDescription('# 标题\n\n这是描述\n第二行')).toBe('这是描述')
  })
  it('跳过 frontmatter', () => {
    expect(extractDescription('---\nname: x\n---\n\n描述内容')).toBe('描述内容')
  })
  it('超长截断', () => {
    const long = 'x'.repeat(200)
    expect(extractDescription(long)).toBe('x'.repeat(120) + '…')
  })
  it('无内容兜底', () => {
    expect(extractDescription('')).toBe('（无描述）')
    expect(extractDescription('---\n---')).toBe('（无描述）')
  })
})

describe('parseTriggers', () => {
  it('英文逗号分隔：trim/小写/去空', () => {
    expect(parseTriggers('Node, NPM , Express')).toEqual(['node', 'npm', 'express'])
  })
  it('支持中文逗号与顿号、中文关键词', () => {
    expect(parseTriggers('服务端，后端、接口')).toEqual(['服务端', '后端', '接口'])
  })
  it('去重', () => {
    expect(parseTriggers('node, Node, NODE')).toEqual(['node'])
  })
  it('空值/缺省返回空数组', () => {
    expect(parseTriggers('')).toEqual([])
    expect(parseTriggers(undefined)).toEqual([])
    expect(parseTriggers(' , ')).toEqual([])
  })
})

describe('parseSkillMarkdown', () => {
  it('无 frontmatter 时描述从正文提取', () => {
    const raw = '这是一个 Vue 项目组件设计规范。\n正文。'
    const r = parseSkillMarkdown(raw)
    expect(r.name).toBe('')
    expect(r.description).toBe('这是一个 Vue 项目组件设计规范。')
    expect(r.enabled).toBe(true)
    expect(r.triggers).toEqual([])
    expect(r.content).toBe(raw)
  })
  it('解析 frontmatter 键值', () => {
    const raw = '---\nname: vue-style\ndescription: Vue 组件风格指南\nenabled: false\ntriggers: vue, 组件规范\n---\n正文内容'
    const r = parseSkillMarkdown(raw)
    expect(r.name).toBe('vue-style')
    expect(r.description).toBe('Vue 组件风格指南')
    expect(r.enabled).toBe(false)
    expect(r.triggers).toEqual(['vue', '组件规范'])
    expect(r.content).toBe('正文内容')
  })
  it('frontmatter 缺 description 时正文提取', () => {
    const raw = '---\nenabled: false\n---\n正文段落。'
    const r = parseSkillMarkdown(raw)
    expect(r.description).toBe('正文段落。')
    expect(r.enabled).toBe(false)
  })
})

describe('renderSkillMarkdown', () => {
  it('生成标准 frontmatter', () => {
    const md = renderSkillMarkdown({ name: 'api-design', description: 'REST API 规范' }, '# 正文\n内容')
    expect(md).toContain('name: api-design')
    expect(md).toContain('description: REST API 规范')
    expect(md).not.toContain('enabled')
    expect(md).toContain('# 正文')
  })
  it('禁用标记写入 frontmatter', () => {
    const md = renderSkillMarkdown({ name: 'x', enabled: false }, '正文')
    expect(md).toContain('enabled: false')
  })
  it('无 description 时不输出该字段', () => {
    const md = renderSkillMarkdown({ name: 'x' }, '正文')
    expect(md).not.toContain('description:')
  })
})
