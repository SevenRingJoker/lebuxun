import { describe, it, expect } from 'vitest'
import { buildAdapterCommand } from './genericDapSession'

describe('buildAdapterCommand', () => {
  it('debugpy launch：python -m debugpy.adapter（stdio DAP）', () => {
    const cmd = buildAdapterCommand({
      runtime: 'debugpy',
      request: 'launch',
      program: 'main.py',
      args: ['--foo', 'bar'],
      cwd: '/workspace',
      env: { DEBUG: '1' }
    })
    expect(cmd.command).toBe('python')
    expect(cmd.args).toEqual(['-m', 'debugpy.adapter'])
    expect(cmd.cwd).toBe('/workspace')
    expect(cmd.env).toEqual({ DEBUG: '1' })
  })

  it('debugpy attach：同一 adapter 命令，无 cwd/env', () => {
    const cmd = buildAdapterCommand({
      runtime: 'debugpy',
      request: 'attach',
      port: 5679
    })
    expect(cmd.command).toBe('python')
    expect(cmd.args).toEqual(['-m', 'debugpy.adapter'])
    expect(cmd.cwd).toBeUndefined()
    expect(cmd.env).toBeUndefined()
  })

  it('dlv launch：dlv dap（stdio 模式）', () => {
    const cmd = buildAdapterCommand({
      runtime: 'dlv',
      request: 'launch',
      program: './cmd/app',
      args: ['--config', 'dev.yaml'],
      cwd: '/go/project'
    })
    expect(cmd.command).toBe('dlv')
    expect(cmd.args).toEqual(['dap'])
    expect(cmd.cwd).toBe('/go/project')
  })

  it('dlv attach：同一 adapter 命令', () => {
    const cmd = buildAdapterCommand({
      runtime: 'dlv',
      request: 'attach',
      port: 2346
    })
    expect(cmd.command).toBe('dlv')
    expect(cmd.args).toEqual(['dap'])
    expect(cmd.cwd).toBeUndefined()
  })

  it('port 字段不再进入命令行（stdio 模式，attach 端口走 DAP 请求参数）', () => {
    const py = buildAdapterCommand({ runtime: 'debugpy', request: 'launch', program: 'x.py', port: 9999 })
    expect(py.args.join(' ')).not.toContain('9999')
    const go = buildAdapterCommand({ runtime: 'dlv', request: 'launch', program: './main', port: 8888 })
    expect(go.args.join(' ')).not.toContain('8888')
  })
})
