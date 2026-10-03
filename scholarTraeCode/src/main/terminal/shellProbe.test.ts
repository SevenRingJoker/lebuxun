import { describe, it, expect } from 'vitest'
import {
  resolveShellProfile,
  classifyPosixShell,
  buildCommandLine,
  shellLineEnding,
  parseMarkerLine,
  lineMentionsMarker,
  isWithinWorkspace,
  resolveCwd
} from './shellProbe'

describe('resolveShellProfile', () => {
  it('Windows：使用 ComSpec 且固定 /V:ON /Q + GBK', () => {
    const p = resolveShellProfile('win32', { ComSpec: 'C:\\Windows\\system32\\cmd.exe' }, () => true)
    expect(p).toEqual({
      kind: 'cmd',
      command: 'C:\\Windows\\system32\\cmd.exe',
      args: ['/V:ON', '/Q'],
      encoding: 'gbk'
    })
  })

  it('Windows：无 ComSpec 回退 cmd.exe', () => {
    const p = resolveShellProfile('win32', {}, () => false)
    expect(p.command).toBe('cmd.exe')
    expect(p.kind).toBe('cmd')
  })

  it('POSIX：$SHELL 指向 fish 时识别为 fish', () => {
    const p = resolveShellProfile('darwin', { SHELL: '/opt/homebrew/bin/fish' }, () => false)
    expect(p.kind).toBe('fish')
    expect(p.command).toBe('/opt/homebrew/bin/fish')
    expect(p.encoding).toBe('utf8')
  })

  it('POSIX：$SHELL 指向 zsh/bash 归为 posix', () => {
    expect(resolveShellProfile('darwin', { SHELL: '/bin/zsh' }, () => false).kind).toBe('posix')
    expect(resolveShellProfile('linux', { SHELL: '/usr/bin/bash' }, () => false).kind).toBe('posix')
  })

  it('POSIX：无 SHELL 时取候选列表中第一个存在的', () => {
    const p = resolveShellProfile('linux', {}, (path) => path === '/bin/bash')
    expect(p.command).toBe('/bin/bash')
  })

  it('POSIX：候选都不存在时兜底 /bin/sh', () => {
    const p = resolveShellProfile('linux', {}, () => false)
    expect(p.command).toBe('/bin/sh')
  })
})

describe('classifyPosixShell', () => {
  it('识别 fish（含路径与大小写）', () => {
    expect(classifyPosixShell('/usr/local/bin/fish')).toBe('fish')
    expect(classifyPosixShell('/FISH')).toBe('fish')
  })
  it('bash/zsh/sh/dash 均归 posix', () => {
    expect(classifyPosixShell('/bin/bash')).toBe('posix')
    expect(classifyPosixShell('/bin/zsh')).toBe('posix')
    expect(classifyPosixShell('/bin/dash')).toBe('posix')
  })
})

describe('buildCommandLine - cmd', () => {
  const cmd = resolveShellProfile('win32', {}, () => false)

  it('同目录：(call ) 先清零 ERRORLEVEL，括号隔离 + !ERRORLEVEL! 延迟扩展', () => {
    const line = buildCommandLine(cmd, {
      command: 'npm run build',
      currentCwd: 'D:\\proj',
      marker: 'MK1'
    })
    expect(line).toBe('(call ) & ( npm run build ) & echo MK1=!ERRORLEVEL!')
  })

  it('切目录：cd /d 支持跨盘，成功 cd 后再清零', () => {
    const line = buildCommandLine(cmd, {
      command: 'dir',
      cwd: 'E:\\other',
      currentCwd: 'D:\\proj',
      marker: 'MK2'
    })
    expect(line).toBe('cd /d "E:\\other" & (call ) & ( dir ) & echo MK2=!ERRORLEVEL!')
  })

  it('含管道命令仍由括号隔离', () => {
    const line = buildCommandLine(cmd, {
      command: 'dir | findstr node',
      currentCwd: 'D:\\proj',
      marker: 'MK3'
    })
    expect(line).toBe('(call ) & ( dir | findstr node ) & echo MK3=!ERRORLEVEL!')
  })
})

describe('buildCommandLine - posix', () => {
  const bash = resolveShellProfile('linux', { SHELL: '/bin/bash' }, () => false)

  it('同目录：括号 + $? 哨兵', () => {
    expect(
      buildCommandLine(bash, { command: 'npm test', currentCwd: '/home/u/p', marker: 'M' })
    ).toBe('( npm test ); echo M=$?')
  })

  it('切目录：cd && 保证失败不执行', () => {
    expect(
      buildCommandLine(bash, { command: 'ls', cwd: '/opt/x', currentCwd: '/home/u/p', marker: 'M' })
    ).toBe('cd "/opt/x" && ( ls ); echo M=$?')
  })
})

describe('buildCommandLine - fish', () => {
  const fish = resolveShellProfile('darwin', { SHELL: '/usr/local/bin/fish' }, () => false)

  it('同目录：begin/end + $status', () => {
    expect(
      buildCommandLine(fish, { command: 'npm test', currentCwd: '/u/p', marker: 'M' })
    ).toBe('begin npm test; end; echo M=$status')
  })

  it('切目录：cd; and begin', () => {
    expect(
      buildCommandLine(fish, { command: 'ls', cwd: '/opt', currentCwd: '/u/p', marker: 'M' })
    ).toBe('cd "/opt"; and begin ls; end; echo M=$status')
  })
})

describe('shellLineEnding', () => {
  it('cmd 用 CRLF，其余 LF', () => {
    const cmd = resolveShellProfile('win32', {}, () => false)
    const posix = resolveShellProfile('linux', { SHELL: '/bin/bash' }, () => false)
    expect(shellLineEnding(cmd)).toBe('\r\n')
    expect(shellLineEnding(posix)).toBe('\n')
  })
})

describe('parseMarkerLine / lineMentionsMarker', () => {
  it('精确结果行返回退出码（允许空白与回车残留）', () => {
    expect(parseMarkerLine('MK1=0', 'MK1')).toBe(0)
    expect(parseMarkerLine('  MK1=12\r', 'MK1')).toBe(12)
  })
  it('回显长行/复合行不匹配', () => {
    expect(parseMarkerLine('( npm test ); echo MK1=$?', 'MK1')).toBeNull()
    expect(parseMarkerLine('D:\\x>MK1=0', 'MK1')).toBeNull()
    expect(parseMarkerLine('MK1=0 extra', 'MK1')).toBeNull()
    expect(parseMarkerLine('OTHER=1', 'MK1')).toBeNull()
  })
  it('lineMentionsMarker 识别回显行', () => {
    expect(lineMentionsMarker('echo MK1=$?', 'MK1')).toBe(true)
    expect(lineMentionsMarker('real output', 'MK1')).toBe(false)
  })
})

describe('isWithinWorkspace', () => {
  it('等于根目录或位于其下均合法（含尾部分隔符与大小写）', () => {
    expect(isWithinWorkspace('D:\\proj', 'D:\\proj\\')).toBe(true)
    expect(isWithinWorkspace('D:\\proj\\src', 'D:\\proj')).toBe(true)
    expect(isWithinWorkspace('d:\\PROJ\\src', 'D:\\proj')).toBe(true)
    expect(isWithinWorkspace('/home/u/proj/src', '/home/u/proj')).toBe(true)
  })
  it('前缀同名兄弟目录不合法（防 D:\\proj-evil 绕过）', () => {
    expect(isWithinWorkspace('D:\\proj-evil', 'D:\\proj')).toBe(false)
    expect(isWithinWorkspace('/home/u/proj-x', '/home/u/proj')).toBe(false)
  })
})

describe('resolveCwd', () => {
  it('相对路径基于 base 解析，绝对路径原样返回', () => {
    expect(resolveCwd('src/a', 'D:\\proj')).toBe('D:\\proj\\src\\a')
    expect(resolveCwd('E:\\x', 'D:\\proj')).toBe('E:\\x')
    expect(resolveCwd(undefined, 'D:\\proj')).toBe('D:\\proj')
  })
})
