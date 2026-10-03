import { describe, it, expect } from 'vitest'
import { formatDuration, appendRing, buildTaskSpawnSpec, newTaskId } from './taskUtils'
import { resolveShellProfile } from './shellProbe'

describe('formatDuration', () => {
  it('秒级保留一位小数', () => {
    expect(formatDuration(0)).toBe('0.0s')
    expect(formatDuration(12_300)).toBe('12.3s')
  })
  it('分钟级 m + 两位秒', () => {
    expect(formatDuration(65_000)).toBe('1m05s')
    expect(formatDuration(600_000)).toBe('10m00s')
  })
  it('小时级', () => {
    expect(formatDuration(3_725_000)).toBe('1h02m')
  })
})

describe('appendRing', () => {
  it('未超容量直接追加并推进基准', () => {
    const r = appendRing({ text: 'ab', base: 0 }, 'cd', 10)
    expect(r).toEqual({ text: 'abcd', base: 0 })
  })
  it('超容量丢弃最旧内容并推进 base', () => {
    const r = appendRing({ text: 'abcdef', base: 0 }, 'gh', 5)
    expect(r.text).toBe('defgh')
    expect(r.base).toBe(3)
  })
  it('多次截断 base 累加', () => {
    let r = { text: '', base: 100 }
    r = appendRing(r, 'x'.repeat(10), 5)
    expect(r.base).toBe(105)
    expect(r.text.length).toBe(5)
  })
})

describe('buildTaskSpawnSpec', () => {
  it('cmd：/V:ON /Q /C + 命令单参数', () => {
    const cmd = resolveShellProfile('win32', { ComSpec: 'C:\\Windows\\system32\\cmd.exe' }, () => false)
    const spec = buildTaskSpawnSpec(cmd, 'npm run dev')
    expect(spec.command).toBe('C:\\Windows\\system32\\cmd.exe')
    expect(spec.args).toEqual(['/V:ON', '/Q', '/C', 'npm run dev'])
  })
  it('posix/fish：-c + 命令', () => {
    const bash = resolveShellProfile('linux', { SHELL: '/bin/bash' }, () => false)
    expect(buildTaskSpawnSpec(bash, 'sleep 10')).toEqual({
      command: '/bin/bash',
      args: ['-c', 'sleep 10']
    })
    const fish = resolveShellProfile('darwin', { SHELL: '/usr/local/bin/fish' }, () => false)
    expect(buildTaskSpawnSpec(fish, 'sleep 10').args).toEqual(['-c', 'sleep 10'])
  })
})

describe('newTaskId', () => {
  it('时间戳 36 进制 + 序号，序号不同 id 不同', () => {
    const a = newTaskId(1, 1_700_000_000_000)
    const b = newTaskId(2, 1_700_000_000_000)
    expect(a).toMatch(/^task-[a-z0-9]+-1$/)
    expect(a).not.toBe(b)
  })
})
