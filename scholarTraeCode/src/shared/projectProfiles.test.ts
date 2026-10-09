import { describe, it, expect } from 'vitest'
import {
  PROFILE_REGISTRY,
  NODE_GATE_PROFILE,
  MANIFEST_GATE_PROFILES,
  getProfile,
  detectProfileFromText,
  detectProfileForCommand,
  detectProfileFromArtifacts,
  formatProfileDiscipline,
  buildForcedResetPrompt,
  manifestContentOk,
  templateIdForProfile
} from './projectProfiles'

describe('PROFILE_REGISTRY 预设', () => {
  it('包含 vue/react/node/python/go/rust/java/docker/generic 画像', () => {
    for (const id of ['vue', 'react', 'node', 'python', 'go', 'rust', 'java-maven', 'java-gradle', 'docker', 'generic']) {
      expect(PROFILE_REGISTRY[id], `缺少画像 ${id}`).toBeDefined()
    }
  })

  it('每个非 generic 画像都声明依赖声明文件与初始化命令', () => {
    for (const p of Object.values(PROFILE_REGISTRY)) {
      if (p.id === 'generic') continue
      expect(p.dependencyManifest, `${p.id} 缺少 dependencyManifest`).toBeTruthy()
      expect(p.initCommands.length, `${p.id} 缺少 initCommands`).toBeGreaterThan(0)
    }
  })

  it('getProfile 未知 id 回退 generic', () => {
    expect(getProfile('nope').id).toBe('generic')
    expect(getProfile('python').dependencyManifest).toBe('requirements.txt')
  })

  it('MANIFEST_GATE_PROFILES 覆盖 python/go/rust/java/docker 且不含 node 系', () => {
    const ids = MANIFEST_GATE_PROFILES.map((p) => p.id)
    expect(ids).toEqual(['python', 'go', 'rust', 'java-maven', 'java-gradle', 'docker'])
    expect(ids).not.toContain('node')
  })
})

describe('detectProfileFromText 按用户请求识别画像', () => {
  it('vue / react / python / go / rust / docker 关键词各归其位', () => {
    expect(detectProfileFromText('帮我创建一个 Vue2 项目').id).toBe('vue')
    expect(detectProfileFromText('写一个 react 组件库').id).toBe('react')
    expect(detectProfileFromText('用 python flask 写个接口').id).toBe('python')
    expect(detectProfileFromText('用 golang 写个 CLI 工具').id).toBe('go')
    expect(detectProfileFromText('rust 实现一个解析器').id).toBe('rust')
    expect(detectProfileFromText('把服务 docker 容器化').id).toBe('docker')
  })

  it('node 关键词与无法识别时的兜底', () => {
    expect(detectProfileFromText('写一个 express 服务').id).toBe('node')
    expect(detectProfileFromText('随便聊聊').id).toBe('generic')
  })
})

describe('detectProfileForCommand 按命令识别生态', () => {
  it('npm/pip/cargo/go/docker 命令各归其位', () => {
    expect(detectProfileForCommand('npm run serve').id).toBe('node')
    expect(detectProfileForCommand('pip install -r requirements.txt').id).toBe('python')
    expect(detectProfileForCommand('cargo build').id).toBe('rust')
    expect(detectProfileForCommand('go build ./...').id).toBe('go')
    expect(detectProfileForCommand('docker compose up').id).toBe('docker')
    expect(detectProfileForCommand('ls -la').id).toBe('generic')
  })
})

describe('detectProfileFromArtifacts 按产物文件反推画像', () => {
  it('requirements.txt→python、go.mod→go、Cargo.toml→rust、docker-compose→docker', () => {
    expect(detectProfileFromArtifacts(['requirements.txt（依赖清单）']).id).toBe('python')
    expect(detectProfileFromArtifacts(['go.mod（模块声明）']).id).toBe('go')
    expect(detectProfileFromArtifacts(['Cargo.toml']).id).toBe('rust')
    expect(detectProfileFromArtifacts(['docker-compose.yml']).id).toBe('docker')
  })

  it('package.json/未知产物缺省回退 node（FORCED-RECOVERY 历史主流）', () => {
    expect(detectProfileFromArtifacts(['package.json（计划声明的产物）']).id).toBe('node')
    expect(detectProfileFromArtifacts([]).id).toBe('node')
  })
})

describe('formatProfileDiscipline 执行纪律注入文本', () => {
  it('声明 manifest→config→源码 顺序与全局安装禁令', () => {
    const text = formatProfileDiscipline(getProfile('python'))
    expect(text).toContain('当前项目类型：Python（python）')
    expect(text).toContain('必须首先创建 requirements.txt')
    expect(text).toContain('pyproject.toml')
    expect(text).toContain('pip install -r requirements.txt')
    expect(text).toContain('绝对禁止使用全局安装命令')
  })

  it('generic 画像不产出纪律文本', () => {
    expect(formatProfileDiscipline(getProfile('generic'))).toBe('')
  })
})

describe('buildForcedResetPrompt 系统强制重置话术', () => {
  it('保留 FORCED-RECOVERY 标签并按画像生成三阶段指令', () => {
    const text = buildForcedResetPrompt(getProfile('python'), '- requirements.txt（依赖清单）')
    expect(text).toContain('【FORCED-RECOVERY】')
    expect(text).toContain('【系统强制重置】')
    // 不再写死项目类型：类型由 scheduler 从原始用户请求重新判定
    expect(text).not.toContain('当前项目类型是')
    expect(text).toContain('必须首先创建 requirements.txt')
    expect(text).toContain('pip install -r requirements.txt')
    expect(text).toContain('python main.py')
    expect(text).toContain('sudo pip install')
    expect(text).toContain('requirements.txt（依赖清单）')
  })

  it('node 画像话术含 npm 命令与全局安装禁令', () => {
    const text = buildForcedResetPrompt(NODE_GATE_PROFILE, '')
    expect(text).toContain('npm install')
    expect(text).toContain('npm run serve')
    expect(text).toContain('npm install -g')
    expect(text).toContain('（见上方偏差报告中的全部缺失文件）')
  })
})

describe('manifestContentOk 内容级校验', () => {
  it('node：空文件 / npm init -y 空壳 / 空 dependencies 均判无效', () => {
    expect(manifestContentOk(NODE_GATE_PROFILE, '')).toBe(false)
    expect(manifestContentOk(NODE_GATE_PROFILE, '  \n ')).toBe(false)
    expect(manifestContentOk(NODE_GATE_PROFILE, '{"name":"x","version":"1.0.0"}')).toBe(false)
    expect(manifestContentOk(NODE_GATE_PROFILE, '{"name":"x","dependencies":{}}')).toBe(false)
    expect(manifestContentOk(NODE_GATE_PROFILE, '{"name":"x","devDependencies":{}}')).toBe(false)
  })

  it('node：dependencies 或 devDependencies 任一非空即有效', () => {
    expect(manifestContentOk(NODE_GATE_PROFILE, '{"name":"x","dependencies":{"vue":"^2.6.14"}}')).toBe(true)
    expect(manifestContentOk(NODE_GATE_PROFILE, '{"name":"x","devDependencies":{"vite":"^5.0.0"}}')).toBe(true)
  })

  it('node：非法 JSON 判无效（不写崩调用方）', () => {
    expect(manifestContentOk(NODE_GATE_PROFILE, '{not json')).toBe(false)
  })

  it('非 node 生态：内容非空白即有效（requirements.txt 有一行依赖即可）', () => {
    const py = getProfile('python')
    expect(manifestContentOk(py, '')).toBe(false)
    expect(manifestContentOk(py, '   ')).toBe(false)
    expect(manifestContentOk(py, 'flask==3.0.0\nrequests')).toBe(true)
  })
})

describe('templateIdForProfile 画像→模板映射', () => {
  it('vue/node/python/go/rust/docker 均有对应验证模板', () => {
    expect(templateIdForProfile('vue')).toBe('vue-scaffold')
    expect(templateIdForProfile('node')).toBe('node-service')
    expect(templateIdForProfile('python')).toBe('python-project')
    expect(templateIdForProfile('go')).toBe('go-project')
    expect(templateIdForProfile('rust')).toBe('rust-project')
    expect(templateIdForProfile('docker')).toBe('docker-service')
  })

  it('无映射画像返回 null（回退宽松口径）', () => {
    expect(templateIdForProfile('generic')).toBeNull()
    expect(templateIdForProfile('java-maven')).toBeNull()
  })
})

describe('NODE_GATE_PROFILE.banManifestGen 清单生成器禁令', () => {
  it('npm init / npm init -y / npm init --yes 命中禁令', () => {
    const re = NODE_GATE_PROFILE.banManifestGen!.re
    expect(re.test('npm init')).toBe(true)
    expect(re.test('npm init -y')).toBe(true)
    expect(re.test('npm init --yes')).toBe(true)
  })

  it('禁令文案指向 write_file 完整 package.json（含 name/scripts/dependencies）', () => {
    const hint = NODE_GATE_PROFILE.banManifestGen!.hint
    expect(hint).toContain('npm init')
    expect(hint).toContain('write_file')
    expect(hint).toContain('dependencies')
  })

  it('npm init vue@latest 脚手架形态不命中（留给交互式分类处理）', () => {
    expect(NODE_GATE_PROFILE.banManifestGen!.re.test('npm init vue@latest')).toBe(false)
  })

  it('manifestEmptyHint 明确点名 npm init -y 空壳与 dependencies 缺失', () => {
    const hint = NODE_GATE_PROFILE.manifestEmptyHint!
    expect(hint).toContain('npm init -y')
    expect(hint).toContain('dependencies')
    expect(hint).toContain('write_file')
  })
})
