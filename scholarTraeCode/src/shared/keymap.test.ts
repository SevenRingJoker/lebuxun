// keymap 纯函数单测：按键解析/格式化/事件匹配/模糊搜索/冲突检测/keymap 合并
import { describe, it, expect } from 'vitest'
import {
  parseAccelerator,
  formatAccelerator,
  matchKeyEvent,
  fuzzyScore,
  searchCommands,
  detectConflict,
  mergeKeymap,
  type CommandDef
} from './keymap'

describe('parseAccelerator', () => {
  it('解析单修饰键 + 主键', () => {
    expect(parseAccelerator('Ctrl+P')).toEqual({ ctrl: true, shift: false, alt: false, meta: false, key: 'p' })
  })

  it('解析多修饰键组合', () => {
    expect(parseAccelerator('Ctrl+Shift+P')).toEqual({ ctrl: true, shift: true, alt: false, meta: false, key: 'p' })
  })

  it('修饰词大小写与别名不敏感', () => {
    expect(parseAccelerator('control+shift+p')?.ctrl).toBe(true)
    expect(parseAccelerator('Cmd+K')?.meta).toBe(true)
    expect(parseAccelerator('Command+K')?.meta).toBe(true)
    expect(parseAccelerator('Option+X')?.alt).toBe(true)
  })

  it('功能键保留原值（首字母大写）', () => {
    expect(parseAccelerator('F5')?.key).toBe('F5')
    expect(parseAccelerator('Ctrl+enter')?.key).toBe('Enter')
  })

  it('非法输入返回 null', () => {
    expect(parseAccelerator('')).toBeNull()
    expect(parseAccelerator('Ctrl+')).toBeNull() // 无主键
    expect(parseAccelerator('Ctrl+Shift')).toBeNull() // 全是修饰键
    expect(parseAccelerator('Ctrl+A+B')).toBeNull() // 多个主键
    expect(parseAccelerator(null as unknown as string)).toBeNull()
  })
})

describe('formatAccelerator', () => {
  it('与 parseAccelerator 往返一致', () => {
    const s = parseAccelerator('ctrl+shift+p')!
    expect(formatAccelerator(s)).toBe('Ctrl+Shift+P')
    expect(parseAccelerator(formatAccelerator(s))).toEqual(s)
  })

  it('功能键不转大写', () => {
    expect(formatAccelerator(parseAccelerator('Ctrl+F5')!)).toBe('Ctrl+F5')
  })
})

describe('matchKeyEvent', () => {
  const stroke = parseAccelerator('Ctrl+Shift+P')!

  it('完全匹配命中', () => {
    expect(matchKeyEvent({ ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, key: 'P' }, stroke)).toBe(true)
  })

  it('主键大小写不敏感', () => {
    expect(matchKeyEvent({ ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, key: 'p' }, stroke)).toBe(true)
  })

  it('修饰键多/少均不命中（严格相等）', () => {
    expect(matchKeyEvent({ ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, key: 'p' }, stroke)).toBe(false)
    expect(matchKeyEvent({ ctrlKey: true, shiftKey: true, altKey: true, metaKey: false, key: 'p' }, stroke)).toBe(false)
  })

  it('跨平台：Cmd（metaKey）互换命中 Ctrl 定义的组合（mac 场景）', () => {
    // macOS 用户按 Cmd+Shift+P 应命中 Ctrl+Shift+P 定义的命令
    expect(matchKeyEvent({ ctrlKey: false, shiftKey: true, altKey: false, metaKey: true, key: 'p' }, stroke)).toBe(true)
  })

  it('跨平台：ctrl+meta 同时按下仍命中（视为单一主修饰键）', () => {
    expect(matchKeyEvent({ ctrlKey: true, shiftKey: true, altKey: false, metaKey: true, key: 'p' }, stroke)).toBe(true)
  })

  it('无主修饰键的 stroke：事件含 ctrl 或 meta 均不命中', () => {
    const plain = parseAccelerator('Shift+P')!
    expect(matchKeyEvent({ ctrlKey: false, shiftKey: true, altKey: false, metaKey: false, key: 'p' }, plain)).toBe(true)
    expect(matchKeyEvent({ ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, key: 'p' }, plain)).toBe(false)
    expect(matchKeyEvent({ ctrlKey: false, shiftKey: true, altKey: false, metaKey: true, key: 'p' }, plain)).toBe(false)
  })

  it('主键不同不命中', () => {
    expect(matchKeyEvent({ ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, key: 'q' }, stroke)).toBe(false)
  })
})

describe('fuzzyScore', () => {
  it('空查询返回 0 分（全命中）', () => {
    expect(fuzzyScore('', '任意文本')).toBe(0)
    expect(fuzzyScore('   ', '任意文本')).toBe(0)
  })

  it('非子序列返回 null', () => {
    expect(fuzzyScore('xyz', '打开设置')).toBeNull()
    expect(fuzzyScore('ab', 'ba')).toBeNull() // 顺序不符
  })

  it('子序列命中且大小写不敏感', () => {
    expect(fuzzyScore('se', '模型 Settings')).not.toBeNull()
    expect(fuzzyScore('ctrl', 'Ctrl+Shift+P')).not.toBeNull()
  })

  it('连续命中优于分散命中', () => {
    const contiguous = fuzzyScore('abc', 'abc xyz')!
    const scattered = fuzzyScore('abc', 'a x b x c')!
    expect(contiguous).toBeGreaterThan(scattered)
  })

  it('词首命中优于词中命中', () => {
    const wordHead = fuzzyScore('s', 'open settings')! // 空格后词首
    const midWord = fuzzyScore('s', 'past open')! // 'past' 词中
    expect(wordHead).toBeGreaterThan(midWord)
  })
})

describe('searchCommands', () => {
  const commands = [
    { title: '打开设置', group: '设置' },
    { title: '新建会话', group: '会话' },
    { title: '会话历史', group: '会话' },
    { title: '切换主题', group: '外观' }
  ]

  it('空查询返回原顺序', () => {
    expect(searchCommands('', commands).map((c) => c.title)).toEqual(commands.map((c) => c.title))
  })

  it('按匹配度排序并过滤不命中项', () => {
    const r = searchCommands('会话', commands)
    expect(r).toHaveLength(2)
    expect(r.map((c) => c.title)).toContain('新建会话')
    expect(r.map((c) => c.title)).toContain('会话历史')
  })

  it('分组名参与匹配', () => {
    const r = searchCommands('外观', commands)
    expect(r.map((c) => c.title)).toEqual(['切换主题'])
  })

  it('同分保持原相对顺序（稳定排序）', () => {
    const r = searchCommands('会话', commands)
    expect(r[0].title).toBe('新建会话') // 原列表中先于「会话历史」
  })
})

describe('detectConflict', () => {
  it('无冲突返回空', () => {
    expect(detectConflict({ a: 'Ctrl+P', b: 'Ctrl+Q' })).toEqual([])
  })

  it('同键多命令报冲突（规范化后比较）', () => {
    const r = detectConflict({ a: 'Ctrl+Shift+P', b: 'ctrl+shift+p', c: 'Ctrl+Q' })
    expect(r).toEqual([{ key: 'Ctrl+Shift+P', commandIds: ['a', 'b'] }])
  })

  it('空串（解绑）不参与冲突', () => {
    expect(detectConflict({ a: '', b: '' })).toEqual([])
  })
})

describe('mergeKeymap', () => {
  const defs: CommandDef[] = [
    { id: 'palette', title: '命令面板', group: '通用', defaultKey: 'Ctrl+Shift+P' },
    { id: 'settings', title: '打开设置', group: '设置', defaultKey: 'Ctrl+,' },
    { id: 'newSession', title: '新建会话', group: '会话' }
  ]

  it('无覆盖时返回默认键', () => {
    expect(mergeKeymap(defs, {})).toEqual({
      palette: 'Ctrl+Shift+P',
      settings: 'Ctrl+,',
      newSession: ''
    })
  })

  it('用户覆盖优先于默认键', () => {
    expect(mergeKeymap(defs, { settings: 'Ctrl+.' }).settings).toBe('Ctrl+.')
  })

  it('空串显式解绑默认键', () => {
    expect(mergeKeymap(defs, { palette: '' }).palette).toBe('')
  })

  it('未知命令 id 的覆盖被忽略', () => {
    const merged = mergeKeymap(defs, { ghost: 'Ctrl+G' })
    expect('ghost' in merged).toBe(false)
  })
})
