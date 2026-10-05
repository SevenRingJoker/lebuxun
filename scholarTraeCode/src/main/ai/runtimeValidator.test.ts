// runtimeValidator 单元测试：端口推断 + dev server 探测 + 诊断文本打包。
import { describe, it, expect } from 'vitest'
import { inferPort, probeDevServer, buildRuntimeDiagnosis } from './runtimeValidator'

describe('inferPort', () => {
  it('命令行 --port 空格形式最高优先', () => {
    expect(inferPort('npm run serve -- --port 3000', 'module.exports={devServer:{port:9000}}')).toBe(3000)
  })

  it('命令行 --port=NNN 等号形式', () => {
    expect(inferPort('vite --port=4173')).toBe(4173)
  })

  it('vue.config.js devServer.port 次优先', () => {
    const cfg = `module.exports = { devServer: { port: 9000, proxy: {} } }`
    expect(inferPort('npm run serve', cfg)).toBe(9000)
  })

  it('vue.config.js 无 port 字段时落到缺省 8080', () => {
    const cfg = `module.exports = { devServer: { proxy: {} } }`
    expect(inferPort('npm run serve', cfg)).toBe(8080)
  })

  it('vite 命令缺省 5173', () => {
    expect(inferPort('npm run dev', null)).toBe(8080) // 无 vite 字样
    expect(inferPort('vite', null)).toBe(5173)
    expect(inferPort('npx vite serve', null)).toBe(5173)
  })

  it('vue-cli 缺省 8080', () => {
    expect(inferPort('npm run serve')).toBe(8080)
  })

  it('非法端口（>65535 / 非数字）回退缺省', () => {
    expect(inferPort('npm run serve -- --port 99999', null)).toBe(8080)
    expect(inferPort('npm run serve -- --port abc', null)).toBe(8080)
  })
})

describe('probeDevServer', () => {
  it('首次即 200 → ok，attempts=1', async () => {
    const fetchImpl = async () => new Response('ok', { status: 200 })
    const r = await probeDevServer({ port: 8080, timeoutMs: 3000, intervalMs: 10, fetchImpl: fetchImpl as typeof fetch })
    expect(r.ok).toBe(true)
    expect(r.attempts).toBe(1)
    expect(r.lastStatus).toBe(200)
    expect(r.port).toBe(8080)
  })

  it('前两次连接拒绝、第三次 200 → ok，attempts=3', async () => {
    let n = 0
    const fetchImpl = async () => {
      n += 1
      if (n < 3) throw new Error('connect ECONNREFUSED 127.0.0.1:8080')
      return new Response('ok', { status: 200 })
    }
    const r = await probeDevServer({ port: 8080, timeoutMs: 5000, intervalMs: 10, fetchImpl: fetchImpl as typeof fetch })
    expect(r.ok).toBe(true)
    expect(r.attempts).toBe(3)
  })

  it('持续连接拒绝 → 超时失败，error 含超时说明', async () => {
    const fetchImpl = async () => {
      throw new Error('connect ECONNREFUSED')
    }
    const r = await probeDevServer({ port: 8080, timeoutMs: 100, intervalMs: 20, fetchImpl: fetchImpl as typeof fetch })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('探测超时')
    expect(r.lastStatus).toBeNull()
    expect(r.attempts).toBeGreaterThanOrEqual(2)
  })

  it('持续 500（编译中）→ 记录 lastStatus，最终超时', async () => {
    const fetchImpl = async () => new Response('err', { status: 500 })
    const r = await probeDevServer({ port: 8080, timeoutMs: 100, intervalMs: 20, fetchImpl: fetchImpl as typeof fetch })
    expect(r.ok).toBe(false)
    expect(r.lastStatus).toBe(500)
  })

  it('204 也算就绪（2xx 即通过）', async () => {
    const fetchImpl = async () => new Response(null, { status: 204 })
    const r = await probeDevServer({ port: 5173, timeoutMs: 1000, intervalMs: 10, fetchImpl: fetchImpl as typeof fetch })
    expect(r.ok).toBe(true)
  })

  it('signal 中止 → 立即返回失败', async () => {
    const ac = new AbortController()
    const fetchImpl = async () => {
      ac.abort()
      throw new Error('aborted')
    }
    const r = await probeDevServer({
      port: 8080,
      timeoutMs: 5000,
      intervalMs: 10,
      signal: ac.signal,
      fetchImpl: fetchImpl as typeof fetch
    })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('中止')
  })
})

describe('buildRuntimeDiagnosis', () => {
  it('打包端口/尝试次数/错误/输出尾部/文件清单', () => {
    const probe = { ok: false, port: 8080, attempts: 30, lastStatus: null, error: '探测超时：ECONNREFUSED' }
    const text = buildRuntimeDiagnosis(probe, 'npm run serve', 'webpack compiling...\nERROR in src/main.js', ['package.json', 'src/main.js'])
    expect(text).toContain('8080')
    expect(text).toContain('30')
    expect(text).toContain('ECONNREFUSED')
    expect(text).toContain('npm run serve')
    expect(text).toContain('ERROR in src/main.js')
    expect(text).toContain('package.json')
    expect(text).toContain('"kind"')
    expect(text).toContain('codefix')
  })

  it('超长输出只保留尾部 2000 字符', () => {
    const probe = { ok: false, port: 8080, attempts: 1, lastStatus: 500, error: 'x' }
    const longOutput = 'A'.repeat(5000) + 'TAIL_MARKER'
    const text = buildRuntimeDiagnosis(probe, 'npm run serve', longOutput, [])
    expect(text).toContain('TAIL_MARKER')
    expect(text).toContain('(前略)')
    expect(text.length).toBeLessThan(longOutput.length)
  })

  it('空输出与空文件清单有占位', () => {
    const probe = { ok: false, port: 5173, attempts: 5, lastStatus: null, error: '超时' }
    const text = buildRuntimeDiagnosis(probe, 'vite', '', [])
    expect(text).toContain('(无输出)')
    expect(text).toContain('(无)')
  })
})
