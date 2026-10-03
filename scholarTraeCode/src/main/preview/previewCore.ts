// 内置浏览器预览纯函数层（3.1 预览）：
// URL 归一化、localhost 候选端口、bounds 校验。
// 本模块不 import electron，可直接在 vitest 下测试。

/** 常见 dev server 端口（限本机段，由渲染端/主进程探活） */
export const DEV_PORTS = [5173, 3000, 8080, 4173, 5174, 8000, 9000] as const

/** 预览视图安全边距（避免贴到窗口边缘） */
export const PREVIEW_MIN_WIDTH = 100
export const PREVIEW_MIN_HEIGHT = 60

/**
 * 归一化用户输入的 URL：
 * - 已有 http(s) 协议 → 原样返回
 * - localhost:port / 127.0.0.1:port → 补 http:// 前缀
 * - 其他一律返回 null（预览仅允许 localhost，避免成为通用浏览器）
 */
export function normalizePreviewUrl(raw: string): string | null {
  const s = raw.trim()
  if (!s) return null
  // 已带协议
  if (/^https?:\/\//i.test(s)) {
    return isLocalhostUrl(s) ? s : null
  }
  // localhost[:port] 或 127.0.0.1[:port]（可选路径）
  if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/i.test(s)) {
    return `http://${s}`
  }
  return null
}

/** 判断 URL 是否为 localhost / 127.0.0.1（只允许本机段） */
export function isLocalhostUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return (
      u.protocol === 'http:' &&
      (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '0.0.0.0')
    )
  } catch {
    return false
  }
}

/** 预览视图 bounds（CSS 像素，相对主窗口 content 区域） */
export interface PreviewBounds {
  x: number
  y: number
  width: number
  height: number
}

/**
 * bounds 合法性校验与裁剪：
 * - 宽高必须 ≥ 最小值，否则返回 null（视图应隐藏而非创建 0 尺寸）
 * - 坐标允许负值（容器可能滚出可视区上方），但宽高为正数
 */
export function sanitizeBounds(b: PreviewBounds): PreviewBounds | null {
  const w = Math.round(b.width)
  const h = Math.round(b.height)
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < PREVIEW_MIN_WIDTH || h < PREVIEW_MIN_HEIGHT) {
    return null
  }
  const x = Math.round(b.x)
  const y = Math.round(b.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x, y, width: w, height: h }
}

/**
 * 构造 localhost 探活 URL 列表（dev server 端口候选）。
 * 渲染端按顺序 fetch 探测，命中即返回首个可用 URL。
 */
export function devServerCandidates(hosts: readonly string[] = ['127.0.0.1', 'localhost']): string[] {
  const out: string[] = []
  for (const host of hosts) {
    for (const port of DEV_PORTS) {
      out.push(`http://${host}:${port}/`)
    }
  }
  return out
}

/** 从终端/日志输出中提取首个 localhost URL（用于 dev server 自动识别） */
export function extractLocalhostUrl(text: string): string | null {
  // 匹配 http://localhost:3000/ 或 Local: http://127.0.0.1:5173/ 等常见格式
  const m = text.match(/https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0):\d+(\/[^\s"'<>)]*)?/i)
  if (!m) return null
  const url = m[0]
  // 0.0.0.0 不可直接访问，替换为 127.0.0.1
  return url.replace('0.0.0.0', '127.0.0.1')
}
