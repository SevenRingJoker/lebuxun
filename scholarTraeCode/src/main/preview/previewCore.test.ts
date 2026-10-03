import { describe, it, expect } from 'vitest'
import {
  normalizePreviewUrl,
  isLocalhostUrl,
  sanitizeBounds,
  devServerCandidates,
  extractLocalhostUrl,
  DEV_PORTS,
  PREVIEW_MIN_WIDTH,
  PREVIEW_MIN_HEIGHT
} from './previewCore'

describe('normalizePreviewUrl', () => {
  it('带协议的 localhost URL 原样返回', () => {
    expect(normalizePreviewUrl('http://localhost:5173/')).toBe('http://localhost:5173/')
    expect(normalizePreviewUrl('http://127.0.0.1:8080/app')).toBe('http://127.0.0.1:8080/app')
  })

  it('无协议的 localhost:port 补 http://', () => {
    expect(normalizePreviewUrl('localhost:3000')).toBe('http://localhost:3000')
    expect(normalizePreviewUrl('127.0.0.1:8080/foo')).toBe('http://127.0.0.1:8080/foo')
    expect(normalizePreviewUrl('localhost')).toBe('http://localhost')
  })

  it('空白输入返回 null', () => {
    expect(normalizePreviewUrl('')).toBeNull()
    expect(normalizePreviewUrl('   ')).toBeNull()
  })

  it('非 localhost 一律拒绝（预览不是通用浏览器）', () => {
    expect(normalizePreviewUrl('https://google.com')).toBeNull()
    expect(normalizePreviewUrl('http://example.com')).toBeNull()
    expect(normalizePreviewUrl('google.com')).toBeNull()
  })

  it('其他协议拒绝', () => {
    expect(normalizePreviewUrl('file:///c/foo')).toBeNull()
    expect(normalizePreviewUrl('ftp://localhost:21')).toBeNull()
  })

  it('首尾空白被 trim', () => {
    expect(normalizePreviewUrl('  localhost:5173  ')).toBe('http://localhost:5173')
  })
})

describe('isLocalhostUrl', () => {
  it('localhost/127.0.0.1/0.0.0.0 均视为本机', () => {
    expect(isLocalhostUrl('http://localhost:3000')).toBe(true)
    expect(isLocalhostUrl('http://127.0.0.1:8080')).toBe(true)
    expect(isLocalhostUrl('http://0.0.0.0:5173')).toBe(true)
  })

  it('https 与 非 localhost 拒绝', () => {
    expect(isLocalhostUrl('https://localhost:3000')).toBe(false)
    expect(isLocalhostUrl('http://example.com')).toBe(false)
  })

  it('非法 URL 返回 false', () => {
    expect(isLocalhostUrl('not a url')).toBe(false)
    expect(isLocalhostUrl('')).toBe(false)
  })
})

describe('sanitizeBounds', () => {
  it('合法 bounds 原样返回', () => {
    const r = sanitizeBounds({ x: 10, y: 20, width: 800, height: 600 })
    expect(r).toEqual({ x: 10, y: 20, width: 800, height: 600 })
  })

  it('宽高小于最小值返回 null（应隐藏视图）', () => {
    expect(sanitizeBounds({ x: 0, y: 0, width: PREVIEW_MIN_WIDTH - 1, height: 600 })).toBeNull()
    expect(sanitizeBounds({ x: 0, y: 0, width: 800, height: PREVIEW_MIN_HEIGHT - 1 })).toBeNull()
    expect(sanitizeBounds({ x: 0, y: 0, width: 0, height: 0 })).toBeNull()
  })

  it('坐标允许负值（容器滚出可视区）', () => {
    const r = sanitizeBounds({ x: -50, y: -10, width: 500, height: 300 })
    expect(r).not.toBeNull()
    expect(r!.x).toBe(-50)
    expect(r!.y).toBe(-10)
  })

  it('小数取整', () => {
    const r = sanitizeBounds({ x: 10.6, y: 20.4, width: 800.7, height: 600.2 })
    expect(r).toEqual({ x: 11, y: 20, width: 801, height: 600 })
  })

  it('非有限值返回 null', () => {
    expect(sanitizeBounds({ x: NaN, y: 0, width: 500, height: 300 })).toBeNull()
    expect(sanitizeBounds({ x: 0, y: 0, width: Infinity, height: 300 })).toBeNull()
  })
})

describe('devServerCandidates', () => {
  it('默认产出 2 hosts × N ports 个 URL', () => {
    const urls = devServerCandidates()
    expect(urls.length).toBe(2 * DEV_PORTS.length)
    expect(urls[0]).toBe('http://127.0.0.1:5173/')
    expect(urls[DEV_PORTS.length]).toBe('http://localhost:5173/')
  })

  it('自定义 hosts', () => {
    const urls = devServerCandidates(['localhost'])
    expect(urls.length).toBe(DEV_PORTS.length)
    expect(urls.every((u) => u.startsWith('http://localhost:'))).toBe(true)
  })
})

describe('extractLocalhostUrl', () => {
  it('提取 vite 输出的 Local URL', () => {
    const text = '  ➜  Local:   http://localhost:5173/\n  ➜  Network: use --host to expose'
    expect(extractLocalhostUrl(text)).toBe('http://localhost:5173/')
  })

  it('提取 127.0.0.1 地址', () => {
    expect(extractLocalhostUrl('ready on http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000')
  })

  it('0.0.0.0 替换为 127.0.0.1（0.0.0.0 不可直接访问）', () => {
    expect(extractLocalhostUrl('listening on http://0.0.0.0:8080/')).toBe('http://127.0.0.1:8080/')
  })

  it('带路径保留', () => {
    expect(extractLocalhostUrl('open http://localhost:3000/app/index.html')).toBe(
      'http://localhost:3000/app/index.html'
    )
  })

  it('无 localhost 返回 null', () => {
    expect(extractLocalhostUrl('server ready on http://example.com')).toBeNull()
    expect(extractLocalhostUrl('plain text')).toBeNull()
  })

  it('大小写不敏感', () => {
    expect(extractLocalhostUrl('HTTP://LOCALHOST:9000')).toBe('HTTP://LOCALHOST:9000')
  })
})
