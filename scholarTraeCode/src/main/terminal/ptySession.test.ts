import { describe, it, expect } from 'vitest'
import {
  resolvePtyShell,
  findInPath,
  ptyEnter,
  type PtyShell
} from './ptySession'

// 构造一个基于「存在路径集合」的假 exists 谓词
function fakeExists(set: string[]): (p: string) => boolean {
  const norm = (p: string) => p.replace(/[\\/]+/g, '/').toLowerCase()
  const pool = new Set(set.map(norm))
  return (p: string) => pool.has(norm(p))
}

describe('resolvePtyShell · Windows', () => {
  const baseEnv = {
    ProgramFiles: 'C:\\Program Files',
    SystemRoot: 'C:\\Windows',
    ComSpec: 'C:\\Windows\\system32\\cmd.exe',
    PATH: 'C:\\Windows\\System32'
  }

  it('PowerShell 7 固定安装目录存在 → pwsh（最高优先级）', () => {
    const exists = fakeExists([
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    ])
    const shell = resolvePtyShell('win32', baseEnv, exists)
    expect(shell.kind).toBe('pwsh')
    expect(shell.command).toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe')
    expect(shell.args).toEqual([])
  })

  it('7 不存在但 7-preview 存在 → pwsh preview', () => {
    const exists = fakeExists([
      'C:\\Program Files\\PowerShell\\7-preview\\pwsh.exe',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    ])
    expect(resolvePtyShell('win32', baseEnv, exists).command).toBe(
      'C:\\Program Files\\PowerShell\\7-preview\\pwsh.exe'
    )
  })

  it('固定目录无 pwsh 但 PATH 中存在 → 取 PATH 中路径', () => {
    const env = { ...baseEnv, PATH: 'C:\\Windows\\System32;D:\\scoop\\shims' }
    const exists = fakeExists([
      'D:\\scoop\\shims\\pwsh.exe',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    ])
    const shell = resolvePtyShell('win32', env, exists)
    expect(shell.kind).toBe('pwsh')
    expect(shell.command).toBe('D:/scoop/shims/pwsh.exe')
  })

  it('无任何 pwsh → 回退 Windows PowerShell 5.1', () => {
    const exists = fakeExists([
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    ])
    const shell = resolvePtyShell('win32', baseEnv, exists)
    expect(shell.kind).toBe('powershell')
    expect(shell.command).toBe(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    )
  })

  it('PowerShell 5.1 也不存在 → 回退 cmd（ComSpec）', () => {
    const shell = resolvePtyShell('win32', baseEnv, fakeExists([]))
    expect(shell.kind).toBe('cmd')
    expect(shell.command).toBe('C:\\Windows\\system32\\cmd.exe')
  })

  it('无 ComSpec 时 cmd 回退文件名 cmd.exe', () => {
    const shell = resolvePtyShell(
      'win32',
      { ProgramFiles: 'C:\\Program Files', PATH: '', SystemRoot: 'C:\\Windows' },
      fakeExists([])
    )
    expect(shell.command).toBe('cmd.exe')
  })
})

describe('resolvePtyShell · POSIX', () => {
  it('$SHELL=bash → posix', () => {
    const shell: PtyShell = resolvePtyShell('linux', { SHELL: '/bin/bash' }, () => false)
    expect(shell).toEqual({ kind: 'posix', command: '/bin/bash', args: [] })
  })

  it('$SHELL=fish → fish', () => {
    const shell = resolvePtyShell('darwin', { SHELL: '/opt/homebrew/bin/fish' }, () => false)
    expect(shell.kind).toBe('fish')
  })

  it('无 $SHELL 且候选 /bin/bash 存在 → bash', () => {
    const exists = fakeExists(['/bin/bash'])
    const shell = resolvePtyShell('linux', {}, exists)
    expect(shell.command).toBe('/bin/bash')
  })
})

describe('findInPath', () => {
  it('Windows 分号分隔，命中返回绝对路径', () => {
    const exists = fakeExists(['D:\\tools\\node.exe'])
    expect(findInPath('node.exe', 'C:\\Windows;D:\\tools', ';', exists)).toBe(
      'D:/tools/node.exe'
    )
  })

  it('POSIX 冒号分隔命中', () => {
    const exists = fakeExists(['/usr/local/bin/fish'])
    expect(findInPath('fish', '/usr/bin:/usr/local/bin', ':', exists)).toBe(
      '/usr/local/bin/fish'
    )
  })

  it('未命中返回 null', () => {
    expect(findInPath('pwsh.exe', 'C:\\Windows', ';', fakeExists([]))).toBeNull()
  })

  it('PATH 为空/undefined 返回 null', () => {
    expect(findInPath('a', '', ';', fakeExists([]))).toBeNull()
    expect(findInPath('a', undefined, ':', fakeExists([]))).toBeNull()
  })

  it('跳过空段与尾部带分隔符的目录', () => {
    const exists = fakeExists(['/bin/x'])
    expect(findInPath('x', ':/bin/:', ':', exists)).toBe('/bin/x')
  })
})

describe('ptyEnter', () => {
  it('Windows 返回 \\r，POSIX 返回 \\n', () => {
    expect(ptyEnter('win32')).toBe('\r')
    expect(ptyEnter('linux')).toBe('\n')
    expect(ptyEnter('darwin')).toBe('\n')
  })
})
