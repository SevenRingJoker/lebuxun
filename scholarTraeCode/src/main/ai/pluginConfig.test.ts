// pluginConfig.ts 纯函数单测：清单校验、磁盘扫描、启用覆盖
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  validatePluginId,
  validateVersion,
  validateManifest,
  loadPluginManifest,
  scanPlugins,
  readEnabledOverrides,
  writeEnabledOverrides,
  resolveEnabled,
  type PluginManifest
} from './pluginConfig'

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'scholar-plugin-'))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('validatePluginId', () => {
  it('合法 ID', () => {
    expect(validatePluginId('my-plugin').ok).toBe(true)
    expect(validatePluginId('a1b2').ok).toBe(true)
  })
  it('空值', () => {
    expect(validatePluginId('').ok).toBe(false)
  })
  it('大写不合法', () => {
    expect(validatePluginId('MyPlugin').ok).toBe(false)
  })
  it('空格不合法', () => {
    expect(validatePluginId('my plugin').ok).toBe(false)
  })
})

describe('validateVersion', () => {
  it('合法 semver', () => {
    expect(validateVersion('1.0.0').ok).toBe(true)
    expect(validateVersion('0.1.0-beta.1').ok).toBe(true)
  })
  it('非法格式', () => {
    expect(validateVersion('1.0').ok).toBe(false)
    expect(validateVersion('').ok).toBe(false)
    expect(validateVersion('v1.0.0').ok).toBe(false)
  })
})

describe('validateManifest', () => {
  const validRaw = {
    id: 'my-plugin',
    name: '我的插件',
    version: '1.0.0',
    providers: [{ id: 'my-llm', name: 'My LLM', baseUrl: 'http://localhost:8080/v1' }],
    mcpServers: { 'my-server': { command: 'node', args: ['server.js'] } },
    commands: [{ id: 'my.cmd', title: 'My Command', keybinding: 'Ctrl+Shift+M' }]
  }

  it('合法清单通过', () => {
    const r = validateManifest(validRaw)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.id).toBe('my-plugin')
      expect(r.value.name).toBe('我的插件')
      expect(r.value.enabled).toBe(true) // 缺省 true
      expect(r.value.providers).toHaveLength(1)
      expect(r.value.commands[0].keybinding).toBe('ctrl+shift+m') // 转小写
    }
  })

  it('enabled=false 被尊重', () => {
    const r = validateManifest({ ...validRaw, enabled: false })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.enabled).toBe(false)
  })

  it('缺少 id 报错', () => {
    const { id, ...rest } = validRaw
    expect(validateManifest(rest).ok).toBe(false)
  })

  it('缺少 name 报错', () => {
    const { name, ...rest } = validRaw
    expect(validateManifest(rest).ok).toBe(false)
  })

  it('缺少 version 报错', () => {
    const { version, ...rest } = validRaw
    expect(validateManifest(rest).ok).toBe(false)
  })

  it('provider 缺少 baseUrl 报错', () => {
    const r = validateManifest({ ...validRaw, providers: [{ id: 'x', name: 'X' }] })
    expect(r.ok).toBe(false)
  })

  it('command 缺少 title 报错', () => {
    const r = validateManifest({ ...validRaw, commands: [{ id: 'x' }] })
    expect(r.ok).toBe(false)
  })

  it('非对象输入报错', () => {
    expect(validateManifest(null).ok).toBe(false)
    expect(validateManifest('string').ok).toBe(false)
    expect(validateManifest(42).ok).toBe(false)
  })

  it('空 providers/mcpServers/commands 允许', () => {
    const r = validateManifest({ id: 'empty', name: '空', version: '1.0.0' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.providers).toEqual([])
      expect(r.value.mcpServers).toEqual({})
      expect(r.value.commands).toEqual([])
    }
  })
})

describe('loadPluginManifest — 磁盘', () => {
  it('合法清单文件加载成功', async () => {
    const dir = join(root, 'my-plugin')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      join(dir, 'plugin.json'),
      JSON.stringify({ id: 'my-plugin', name: '测试', version: '1.0.0' }),
      'utf-8'
    )
    const r = loadPluginManifest(dir)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.id).toBe('my-plugin')
  })

  it('清单不存在报错', () => {
    const r = loadPluginManifest(join(root, 'nonexistent'))
    expect(r.ok).toBe(false)
  })

  it('损坏 JSON 报错', async () => {
    const dir = join(root, 'bad-plugin')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, 'plugin.json'), 'not json {{{', 'utf-8')
    const r = loadPluginManifest(dir)
    expect(r.ok).toBe(false)
  })
})

describe('scanPlugins', () => {
  it('空目录返回空数组', () => {
    expect(scanPlugins(root)).toEqual([])
  })

  it('合法插件返回清单，目录名不匹配 ID 报错', async () => {
    // 合法插件
    const dir1 = join(root, 'plugin-a')
    await fs.mkdir(dir1, { recursive: true })
    await fs.writeFile(
      join(dir1, 'plugin.json'),
      JSON.stringify({ id: 'plugin-a', name: 'A', version: '1.0.0' }),
      'utf-8'
    )
    // 目录名与 ID 不匹配
    const dir2 = join(root, 'wrong-dir')
    await fs.mkdir(dir2, { recursive: true })
    await fs.writeFile(
      join(dir2, 'plugin.json'),
      JSON.stringify({ id: 'different-id', name: 'B', version: '1.0.0' }),
      'utf-8'
    )
    // 损坏清单
    const dir3 = join(root, 'broken')
    await fs.mkdir(dir3, { recursive: true })
    await fs.writeFile(join(dir3, 'plugin.json'), 'bad', 'utf-8')

    const results = scanPlugins(root)
    expect(results).toHaveLength(3)
    const ok = results.filter((r) => r.ok)
    const fail = results.filter((r) => !r.ok)
    expect(ok).toHaveLength(1)
    expect((ok[0] as any).manifest.id).toBe('plugin-a')
    expect(fail).toHaveLength(2)
  })

  it('跳过非目录文件', async () => {
    await fs.writeFile(join(root, 'readme.txt'), 'hello', 'utf-8')
    expect(scanPlugins(root)).toEqual([])
  })
})

describe('启用覆盖', () => {
  it('readEnabledOverrides 空目录返回空对象', () => {
    expect(readEnabledOverrides(root)).toEqual({})
  })

  it('write + read 往返', () => {
    writeEnabledOverrides(root, { 'plugin-a': false, 'plugin-b': true })
    const r = readEnabledOverrides(root)
    expect(r['plugin-a']).toBe(false)
    expect(r['plugin-b']).toBe(true)
  })

  it('resolveEnabled：覆盖优先于清单默认', () => {
    const manifest: PluginManifest = {
      id: 'test', name: 'T', version: '1.0.0', enabled: true,
      providers: [], mcpServers: {}, commands: []
    }
    // 无覆盖：用清单默认
    expect(resolveEnabled(manifest, {})).toBe(true)
    // 有覆盖：覆盖优先
    expect(resolveEnabled(manifest, { test: false })).toBe(false)
  })

  it('清单 enabled=false + 无覆盖 = false', () => {
    const manifest: PluginManifest = {
      id: 'test', name: 'T', version: '1.0.0', enabled: false,
      providers: [], mcpServers: {}, commands: []
    }
    expect(resolveEnabled(manifest, {})).toBe(false)
  })

  it('清单 enabled=false + 覆盖 true = true', () => {
    const manifest: PluginManifest = {
      id: 'test', name: 'T', version: '1.0.0', enabled: false,
      providers: [], mcpServers: {}, commands: []
    }
    expect(resolveEnabled(manifest, { test: true })).toBe(true)
  })
})
