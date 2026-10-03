// skills.ts 集成单测：读真实内置 resources/skills + 临时工作区验证覆盖/回退/推荐
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  listSkills,
  loadSkill,
  recommendSkills,
  renderSkillList,
  builtinSkillsDir,
  type SkillMeta
} from './skills'

/** 临时工作区根（每个文件独立，避免并发测试串扰） */
let workspace: string

beforeAll(async () => {
  workspace = await fs.mkdtemp(join(tmpdir(), 'skills-test-'))
})

afterAll(async () => {
  await fs.rm(workspace, { recursive: true, force: true })
})

describe('内置技能发现', () => {
  it('无工作区时返回 4 个内置脚手架技能', async () => {
    const skills = await listSkills(null)
    const names = skills.map((s) => s.name).sort()
    expect(names).toEqual(['dockerize-app', 'go-scaffold', 'node-scaffold', 'python-venv'])
  })

  it('内置技能 builtin=true 且 triggers 非空', async () => {
    const skills = await listSkills(null)
    for (const s of skills) {
      expect(s.builtin).toBe(true)
      expect(s.triggers.length).toBeGreaterThan(0)
      expect(s.sourcePath).toContain(join('resources', 'skills'))
    }
  })

  it('builtinSkillsDir 指向项目 resources/skills（vitest 下 app 未打包）', () => {
    expect(builtinSkillsDir().replace(/\\/g, '/')).toContain('resources/skills')
  })
})

describe('loadSkill 内置回退', () => {
  it('无工作区时加载内置技能全文', async () => {
    const raw = await loadSkill(null, 'node-scaffold')
    expect(raw).toContain('Node.js 项目脚手架规范')
    expect(raw).toContain('package.json')
  })

  it('python-venv 含 Windows 与 macOS/Linux 双激活写法', async () => {
    const raw = await loadSkill(null, 'python-venv')
    expect(raw).toContain('Activate.ps1')
    expect(raw).toContain('source venv/bin/activate')
  })

  it('非法技能名拒绝', async () => {
    expect(await loadSkill(null, '../escape')).toContain('非法技能名')
  })

  it('不存在的技能返回未找到', async () => {
    expect(await loadSkill(null, 'nope-skill')).toContain('未找到技能')
  })

  it('工作区无同名文件时回退内置', async () => {
    const raw = await loadSkill(workspace, 'go-scaffold')
    expect(raw).toContain('Go 项目脚手架规范')
  })
})

describe('工作区技能覆盖内置', () => {
  it('同名技能：工作区版本替换内置（builtin=false）', async () => {
    const dir = join(workspace, '.trae', 'skills')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      join(dir, 'node-scaffold.md'),
      '---\ndescription: 自定义 Node 规范\ntriggers: custom-node\n---\n自定义内容',
      'utf-8'
    )
    const skills = await listSkills(workspace)
    const node = skills.find((s) => s.name === 'node-scaffold')!
    expect(node.builtin).toBe(false)
    expect(node.description).toBe('自定义 Node 规范')
    // 其余三个仍为内置
    expect(skills.filter((s) => s.builtin).length).toBe(3)
  })

  it('loadSkill 优先返回工作区版本', async () => {
    const raw = await loadSkill(workspace, 'node-scaffold')
    expect(raw).toContain('自定义内容')
    expect(raw).not.toContain('Node.js 项目脚手架规范')
  })

  it('工作区新技能与内置合并', async () => {
    const dir = join(workspace, '.trae', 'skills')
    await fs.writeFile(
      join(dir, 'my-skill.md'),
      '---\ndescription: 我的私有技能\n---\n正文',
      'utf-8'
    )
    const skills = await listSkills(workspace)
    expect(skills.some((s) => s.name === 'my-skill')).toBe(true)
    expect(skills.length).toBe(5)
  })
})

describe('recommendSkills 触发式推荐', () => {
  const skills: SkillMeta[] = [
    { name: 'node-scaffold', description: '', builtin: true, triggers: ['node', 'express'] },
    { name: 'python-venv', description: '', builtin: true, triggers: ['python', 'flask'] },
    { name: 'disabled', description: '', builtin: true, enabled: false, triggers: ['secret'] }
  ]

  it('命中英文关键词：express 请求推荐 node-scaffold', () => {
    const rec = recommendSkills(skills, '帮我用 express 写接口')
    expect(rec.has('node-scaffold')).toBe(true)
    expect(rec.size).toBe(1)
  })

  it('命中中文关键词（大小写不敏感）', () => {
    const rec = recommendSkills(skills, '用 Python 和 Flask 做网站')
    expect(rec.has('python-venv')).toBe(true)
  })

  it('禁用技能不推荐', () => {
    expect(recommendSkills(skills, 'secret task').size).toBe(0)
  })

  it('无命中/空文本返回空集合', () => {
    expect(recommendSkills(skills, '随便聊聊').size).toBe(0)
    expect(recommendSkills(skills, '').size).toBe(0)
  })
})

describe('renderSkillList 推荐标记', () => {
  const skills: SkillMeta[] = [
    { name: 'node-scaffold', description: 'Node 规范', builtin: true, triggers: [] },
    { name: 'custom', description: '工作区技能', builtin: false, triggers: [] }
  ]

  it('推荐集合中的技能加 ⭐ [推荐]', () => {
    const text = renderSkillList(skills, new Set(['node-scaffold']))
    expect(text).toContain('⭐ [推荐] node-scaffold')
    expect(text).not.toContain('⭐ [推荐] custom')
  })

  it('工作区技能标注（工作区）', () => {
    expect(renderSkillList(skills)).toContain('custom（工作区）')
  })

  it('禁用技能不渲染', () => {
    const withDisabled = [
      ...skills,
      { name: 'off', description: '', builtin: true, enabled: false, triggers: [] }
    ]
    const text = renderSkillList(withDisabled)
    expect(text).not.toContain('off')
  })
})
