// rulesConfig 纯函数层单测：tmpdir 隔离，覆盖发现/合并/状态/渲染。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  validateRuleName,
  loadRuleState,
  saveRuleState,
  discoverRules,
  mergeRules,
  renderRulesText,
  type RuleWithContent
} from './rulesConfig'

let root: string

async function writeRule(dir: string, name: string, content: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true })
  const path = join(dir, `${name}.md`)
  await fs.writeFile(path, content, 'utf-8')
  return path
}

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'scholar-rules-'))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('validateRuleName', () => {
  it('合法名 ok', () => {
    expect(validateRuleName('coding-style')).toEqual({ ok: true })
  })
  it('非法名拒绝', () => {
    expect(validateRuleName('')).toEqual({ ok: false, error: '规则名不能为空' })
    expect(validateRuleName('../x')).toEqual({ ok: false, error: '规则名仅允许字母/数字/中文/下划线/连字符' })
  })
})

describe('loadRuleState/saveRuleState', () => {
  it('不存在时返回空对象', async () => {
    expect(await loadRuleState(root)).toEqual({})
  })
  it('原子写后可读回', async () => {
    const state = { 'rule-a': false, 'rule-b': true }
    await saveRuleState(root, state)
    expect(await loadRuleState(root)).toEqual(state)
  })
  it('损坏 JSON 返回空对象', async () => {
    await fs.mkdir(join(root, '.trae', 'rules'), { recursive: true })
    await fs.writeFile(join(root, '.trae', 'rules', '.state.json'), 'not-json', 'utf-8')
    expect(await loadRuleState(root)).toEqual({})
  })
})

describe('discoverRules', () => {
  it('三层发现顺序：用户级 → 项目级 → 目录级（远 → 近）', async () => {
    const userDir = join(root, 'user')
    const ws = join(root, 'ws')
    const subDir = join(ws, 'src', 'components')
    await writeRule(join(userDir), 'user-rule', '用户级内容')
    await writeRule(join(ws, '.trae', 'rules'), 'proj-rule', '项目级内容')
    await writeRule(join(ws, 'src', '.trae', 'rules'), 'dir-src', 'src 目录级')
    await writeRule(join(subDir, '.trae', 'rules'), 'dir-comp', 'components 目录级')

    const rules = await discoverRules({ workspace: ws, userRulesDir: userDir, currentDir: subDir })
    expect(rules.map((r) => `${r.name}:${r.scope}`)).toEqual([
      'user-rule:user',
      'proj-rule:project',
      'dir-src:directory',
      'dir-comp:directory'
    ])
  })

  it('目录级规则按深度排序（近者优先）', async () => {
    const ws = join(root, 'ws')
    const deep = join(ws, 'a', 'b', 'c')
    await writeRule(join(ws, 'a', '.trae', 'rules'), 'r1', 'a 级')
    await writeRule(join(ws, 'a', 'b', '.trae', 'rules'), 'r2', 'b 级')

    const rules = await discoverRules({ workspace: ws, currentDir: deep })
    const dirRules = rules.filter((r) => r.scope === 'directory')
    expect(dirRules.map((r) => r.depth)).toEqual([0, 1]) // a 层 depth=0，b 层 depth=1
  })

  it('项目级规则按 .state.json 标记启停', async () => {
    const ws = join(root, 'ws')
    await writeRule(join(ws, '.trae', 'rules'), 'enabled-rule', '启用')
    await writeRule(join(ws, '.trae', 'rules'), 'disabled-rule', '禁用')
    await saveRuleState(ws, { 'disabled-rule': false })

    const rules = await discoverRules({ workspace: ws })
    const enabled = rules.find((r) => r.name === 'enabled-rule')
    const disabled = rules.find((r) => r.name === 'disabled-rule')
    expect(enabled?.enabled).toBe(true)
    expect(disabled?.enabled).toBe(false)
  })

  it('用户级路径不存在时返回空', async () => {
    const rules = await discoverRules({ userRulesDir: join(root, 'nonexistent') })
    expect(rules).toEqual([])
  })

  it('currentDir 超出 workspace 时忽略目录级', async () => {
    const ws = join(root, 'ws')
    await writeRule(join(ws, '.trae', 'rules'), 'p', '项目级')
    const rules = await discoverRules({ workspace: ws, currentDir: join(root, 'other') })
    expect(rules.filter((r) => r.scope === 'directory')).toEqual([])
  })
})

describe('mergeRules', () => {
  const mk = (name: string, scope: RuleWithContent['scope'], depth: number, enabled = true): RuleWithContent => ({
    name, scope, path: `/${scope}/${name}`, enabled, contentPreview: name, depth, content: `${scope}-${name} 内容`
  })

  it('同名规则高优先级覆盖', () => {
    const rules = [
      mk('rule', 'user', 0),
      mk('rule', 'project', 0),
      mk('rule', 'directory', 0)
    ]
    const merged = mergeRules(rules)
    expect(merged).toHaveLength(1)
    expect(merged[0].scope).toBe('directory')
  })

  it('目录级同名：近者优先', () => {
    const rules = [
      mk('rule', 'directory', 0),
      mk('rule', 'directory', 1)
    ]
    const merged = mergeRules(rules)
    expect(merged).toHaveLength(1)
    expect(merged[0].depth).toBe(1)
  })

  it('禁用规则被剔除', () => {
    const rules = [
      mk('a', 'user', 0),
      mk('b', 'project', 0, false),
      mk('c', 'directory', 0)
    ]
    const merged = mergeRules(rules)
    expect(merged.map((r) => r.name)).toEqual(['a', 'c'])
  })

  it('合并后按名称排序', () => {
    const rules = [mk('z', 'user', 0), mk('a', 'project', 0)]
    const merged = mergeRules(rules)
    expect(merged.map((r) => r.name)).toEqual(['a', 'z'])
  })
})

describe('renderRulesText', () => {
  it('空数组返回空串', () => {
    expect(renderRulesText([])).toBe('')
  })
  it('生成带作用域标注的 Markdown', () => {
    const rules: RuleWithContent[] = [
      { name: 'style', scope: 'project', path: '/p/style', enabled: true, contentPreview: 's', depth: 0, content: '缩进 2 空格' },
      { name: 'api', scope: 'directory', path: '/d/api', enabled: true, contentPreview: 'a', depth: 1, content: 'REST 规范' }
    ]
    const text = renderRulesText(rules)
    expect(text).toContain('### 规则「style」（项目级）')
    expect(text).toContain('### 规则「api」（目录级）')
    expect(text).toContain('缩进 2 空格')
    expect(text).toContain('REST 规范')
  })
})
