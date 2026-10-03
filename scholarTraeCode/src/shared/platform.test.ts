// platform.ts 单测：平台检测/修饰键名/字体栈分支
import { describe, it, expect } from 'vitest'
import {
  isWindows,
  isMacos,
  isLinux,
  modKeyName,
  platformDisplayName,
  platformFromNavigator,
  monospaceFontStack
} from './platform'

describe('isWindows / isMacos / isLinux', () => {
  it('win32 是 Windows', () => {
    expect(isWindows('win32')).toBe(true)
    expect(isMacos('win32')).toBe(false)
    expect(isLinux('win32')).toBe(false)
  })
  it('darwin 是 macOS', () => {
    expect(isMacos('darwin')).toBe(true)
    expect(isWindows('darwin')).toBe(false)
    expect(isLinux('darwin')).toBe(false)
  })
  it('linux 是 Linux/BSD', () => {
    expect(isLinux('linux')).toBe(true)
    expect(isLinux('freebsd')).toBe(true)
    expect(isLinux('openbsd')).toBe(true)
    expect(isMacos('linux')).toBe(false)
  })
  it('cygwin 归为 Windows 系', () => {
    expect(isWindows('cygwin')).toBe(true)
  })
})

describe('modKeyName', () => {
  it('macOS 返回 Cmd', () => {
    expect(modKeyName('darwin')).toBe('Cmd')
  })
  it('Windows/Linux 返回 Ctrl', () => {
    expect(modKeyName('win32')).toBe('Ctrl')
    expect(modKeyName('linux')).toBe('Ctrl')
    expect(modKeyName('freebsd')).toBe('Ctrl')
  })
})

describe('platformDisplayName', () => {
  it('各平台人类可读名', () => {
    expect(platformDisplayName('win32')).toBe('Windows')
    expect(platformDisplayName('darwin')).toBe('macOS')
    expect(platformDisplayName('linux')).toBe('Linux/BSD')
    expect(platformDisplayName('aix')).toBe('Linux/BSD')
    // 未知平台回退原值
    expect(platformDisplayName('haiku')).toBe('haiku')
  })
})

describe('platformFromNavigator', () => {
  it('Win32 → win32', () => {
    expect(platformFromNavigator('Win32')).toBe('win32')
    expect(platformFromNavigator('Win64')).toBe('win32')
  })
  it('MacIntel → darwin', () => {
    expect(platformFromNavigator('MacIntel')).toBe('darwin')
    expect(platformFromNavigator('MacAppleSilicon')).toBe('darwin')
  })
  it('Linux x86_64 → linux', () => {
    expect(platformFromNavigator('Linux x86_64')).toBe('linux')
    expect(platformFromNavigator('Linux armv8l')).toBe('linux')
  })
  it('FreeBSD → linux（兜底归类）', () => {
    expect(platformFromNavigator('FreeBSD amd64')).toBe('linux')
  })
  it('未知 → linux 兜底', () => {
    expect(platformFromNavigator('SunOS')).toBe('linux')
  })
})

describe('monospaceFontStack', () => {
  it('通用首选字体（用户安装的编程字体）在所有平台优先', () => {
    for (const p of ['win32', 'darwin', 'linux'] as const) {
      const stack = monospaceFontStack(p)
      expect(stack).toContain('JetBrains Mono')
      expect(stack).toContain('Fira Code')
    }
  })
  it('Windows 包含 Consolas', () => {
    expect(monospaceFontStack('win32')).toContain('Consolas')
  })
  it('macOS 包含 Menlo', () => {
    expect(monospaceFontStack('darwin')).toContain('Menlo')
  })
  it('Linux 包含 DejaVu Sans Mono', () => {
    expect(monospaceFontStack('linux')).toContain('DejaVu Sans Mono')
  })
  it('未知平台回退通用栈（含 Consolas + Menlo + DejaVu）', () => {
    const stack = monospaceFontStack('haiku')
    expect(stack).toContain('Consolas')
    expect(stack).toContain('Menlo')
    expect(stack).toContain('DejaVu Sans Mono')
  })
})
