// mcpConfig 纯函数单测：名称/配置校验、文本解析、合并、目录去重、启用判断。
import { describe, it, expect } from 'vitest'
import {
  isReservedName,
  validateServerName,
  validateServerConfig,
  sanitizeConfigFile,
  parseArgsLines,
  parseEnvLines,
  envToLines,
  mergeConfigLayers,
  dedupeArgs,
  dedupePaths,
  isEnabled
} from './mcpConfig'

describe('名称校验', () => {
  it('合法名称通过并 trim', () => {
    expect(validateServerName('  fs_server-1 ')).toEqual({ ok: true, value: 'fs_server-1' })
  })
  it('空名称拒绝', () => {
    expect(validateServerName('   ').ok).toBe(false)
  })
  it('非法字符/超长拒绝', () => {
    expect(validateServerName('a b').ok).toBe(false)
    expect(validateServerName('a/b').ok).toBe(false)
    expect(validateServerName('中文').ok).toBe(false)
    expect(validateServerName('a'.repeat(41)).ok).toBe(false)
  })
  it('保留字 terminal 拒绝', () => {
    expect(isReservedName('terminal')).toBe(true)
    expect(validateServerName('terminal').ok).toBe(false)
  })
  it('新增场景重名拒绝', () => {
    const r = validateServerName('fs', ['fs', 'web'])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('同名')
  })
})

describe('配置主体校验', () => {
  it('package 模式通过并规范化 args', () => {
    const r = validateServerConfig({ package: '  @scope/server-filesystem ', args: [' . ', '', '  --x '] })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.package).toBe('@scope/server-filesystem')
      expect(r.value.args).toEqual(['.', '--x'])
    }
  })
  it('command 模式通过', () => {
    const r = validateServerConfig({ command: 'uvx', args: ['mcp-server'] })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.command).toBe('uvx')
  })
  it('package 与 command 都缺/都填均拒绝', () => {
    expect(validateServerConfig({ args: [] }).ok).toBe(false)
    expect(validateServerConfig({ package: 'a', command: 'b' }).ok).toBe(false)
  })
  it('非数组 args 拒绝；非对象 env 拒绝', () => {
    expect(validateServerConfig({ command: 'x', args: '--bad' }).ok).toBe(false)
    expect(validateServerConfig({ command: 'x', env: 'BAD' }).ok).toBe(false)
  })
  it('env 键值规范化（空键剔除、值字符串化）', () => {
    const r = validateServerConfig({ command: 'x', env: { ' K ': 1, EMPTY: '' } })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.env).toEqual({ K: '1', EMPTY: '' })
  })
  it('description trim、enabled 保留', () => {
    const r = validateServerConfig({ command: 'x', description: ' 说明 ', enabled: false })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toMatchObject({ description: '说明', enabled: false })
  })
  it('非对象输入拒绝', () => {
    expect(validateServerConfig(null).ok).toBe(false)
    expect(validateServerConfig('x').ok).toBe(false)
  })
})

describe('配置文件清洗', () => {
  it('合法条目保留、非法名称/配置跳过', () => {
    const out = sanitizeConfigFile({
      mcpServers: {
        good: { command: 'x' },
        'bad name': { command: 'y' },
        nocmd: { args: [] }
      }
    })
    expect(Object.keys(out.mcpServers)).toEqual(['good'])
  })
  it('顶层直接是 servers map 也能识别', () => {
    const out = sanitizeConfigFile({ a: { package: 'p' } })
    expect(out.mcpServers.a?.package).toBe('p')
  })
  it('null/数组等异常输入返回空骨架', () => {
    expect(sanitizeConfigFile(null).mcpServers).toEqual({})
    expect(sanitizeConfigFile([1, 2]).mcpServers).toEqual({})
  })
})

describe('文本解析', () => {
  it('parseArgsLines 按行拆分去空行去空白（不识别注释，# 是普通参数）', () => {
    expect(parseArgsLines(' a\n\n  b  \n# c')).toEqual(['a', 'b', '# c'])
  })
  it('parseEnvLines 合法行/注释/空值', () => {
    const { env, errors } = parseEnvLines('# 注释\nA=1\n B = x y \n\nFLAG=')
    expect(env).toEqual({ A: '1', B: 'x y', FLAG: '' })
    expect(errors).toHaveLength(0)
  })
  it('parseEnvLines 缺等号行报错', () => {
    const { env, errors } = parseEnvLines('GOOD=1\nNOEQUAL\n=onlyval')
    expect(env).toEqual({ GOOD: '1' })
    expect(errors).toHaveLength(2)
  })
  it('envToLines 回填', () => {
    expect(envToLines({ A: '1', B: 'x' })).toBe('A=1\nB=x')
    expect(envToLines(undefined)).toBe('')
  })
})

describe('合并与去重', () => {
  it('mergeConfigLayers：user 覆盖 bundled 同名，非法条目清洗', () => {
    const merged = mergeConfigLayers(
      { fs: { package: 'p1' }, old: { command: 'c1' } },
      { fs: { package: 'p2' }, neu: { command: 'c2' } }
    )
    expect(Object.keys(merged.mcpServers).sort()).toEqual(['fs', 'neu', 'old'])
    expect(merged.mcpServers.fs.package).toBe('p2')
  })
  it('dedupeArgs 保序去重', () => {
    expect(dedupeArgs(['a', 'b', 'a', 'c', 'b'])).toEqual(['a', 'b', 'c'])
    expect(dedupeArgs([])).toEqual([])
  })
  it('dedupePaths：尾斜杠/./.. 规范化后去重', () => {
    expect(dedupePaths(['D:\\ws\\proj', 'D:\\ws\\proj\\', 'D:\\ws\\sub\\..\\proj'])).toEqual(['D:\\ws\\proj'])
  })
  it.runIf(process.platform === 'win32')('dedupePaths：Windows 盘符大小写不敏感，保留首次出现形式', () => {
    expect(dedupePaths(['D:\\ws\\Proj', 'd:\\ws\\proj'])).toEqual(['D:\\ws\\Proj'])
  })
  it('dedupePaths：非绝对参数（flag/相对路径）按原文比较，不误伤', () => {
    expect(dedupePaths(['--readonly', '.', '.', 'rel/p'])).toEqual(['--readonly', '.', 'rel/p'])
  })
  it('isEnabled：缺省为 true，显式 false 才关闭', () => {
    expect(isEnabled({ command: 'x' })).toBe(true)
    expect(isEnabled({ command: 'x', enabled: true })).toBe(true)
    expect(isEnabled({ command: 'x', enabled: false })).toBe(false)
    expect(isEnabled(undefined)).toBe(false)
  })
})
