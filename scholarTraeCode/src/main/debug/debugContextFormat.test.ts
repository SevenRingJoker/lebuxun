// debugContextFormat 纯函数单测：路径压缩 / 值截断 / 上下文格式化
import { describe, it, expect } from 'vitest'
import { formatDebugContext, shortenPath, truncateValue, type DebugContextView } from './debugContextFormat'

function ctx(overrides: Partial<DebugContextView> = {}): DebugContextView {
  return {
    backend: 'dap',
    state: 'stopped',
    program: '/workspace/app/main.py',
    breakpoints: { '/workspace/app/main.py': [10, 25] },
    stopped: {
      stack: [
        { name: 'main', file: '/workspace/app/main.py', line: 10 },
        { name: 'run', file: '/workspace/app/run.py', line: 42 }
      ],
      scopes: ['Locals', 'Globals'],
      variables: [
        { name: 'x', value: '42', type: 'int' },
        { name: 'name', value: "'alice'", type: 'str' }
      ]
    },
    ...overrides
  }
}

describe('shortenPath', () => {
  it('长路径只留末两段', () => {
    expect(shortenPath('/a/b/c/d.ts')).toBe('c/d.ts')
    expect(shortenPath('C:\\proj\\src\\main.go')).toBe('src/main.go')
  })
  it('短路径原样返回', () => {
    expect(shortenPath('main.py')).toBe('main.py')
    expect(shortenPath('/a.py')).toBe('/a.py')
  })
})

describe('truncateValue', () => {
  it('短值不截断', () => {
    expect(truncateValue('abc')).toBe('abc')
  })
  it('长值截断并标注原长', () => {
    const long = 'x'.repeat(200)
    const out = truncateValue(long)
    expect(out).toContain('…')
    expect(out).toContain('200字符')
    expect(out.length).toBeLessThan(200)
  })
})

describe('formatDebugContext', () => {
  it('完整 stopped 上下文：后端/状态/断点/堆栈/作用域/变量', () => {
    const out = formatDebugContext(ctx())
    expect(out).toContain('后端：dap')
    expect(out).toContain('状态：stopped')
    expect(out).toContain('目标：app/main.py')
    expect(out).toContain('断点：')
    expect(out).toContain('app/main.py: 10, 25')
    expect(out).toContain('#0 main @ app/main.py:10')
    expect(out).toContain('#1 run @ app/run.py:42')
    expect(out).toContain('作用域：Locals, Globals')
    expect(out).toContain('x: int = 42')
    expect(out).toContain("name: str = 'alice'")
  })

  it('未停驻：提示且不含堆栈段', () => {
    const out = formatDebugContext(ctx({ state: 'running', stopped: null }))
    expect(out).toContain('当前未停驻')
    expect(out).not.toContain('停驻堆栈')
  })

  it('无断点：显示 无', () => {
    const out = formatDebugContext(ctx({ breakpoints: {} }))
    expect(out).toContain('断点：无')
  })

  it('堆栈超 10 帧截断', () => {
    const stack = Array.from({ length: 20 }, (_, i) => ({ name: `f${i}`, file: `/w/m.py`, line: i + 1 }))
    const out = formatDebugContext(ctx({ stopped: { stack, scopes: [], variables: [] } }))
    expect(out).toContain('#9 f9')
    expect(out).not.toContain('#10 f10')
    expect(out).toContain('变量：无')
  })

  it('变量超 30 条截断', () => {
    const variables = Array.from({ length: 50 }, (_, i) => ({ name: `v${i}`, value: String(i) }))
    const out = formatDebugContext(ctx({ stopped: { stack: [], scopes: [], variables } }))
    expect(out).toContain('v29 = 29')
    expect(out).not.toContain('v30 = 30')
  })
})
