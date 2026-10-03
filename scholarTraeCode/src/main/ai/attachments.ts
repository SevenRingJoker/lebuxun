// 图片附件存储层（2.3 图片输入）：
// 附件统一落 <workspace>/.trae/attachments/<id>.<ext>，
// 会话历史只存路径引用，图片本身不进 chatHistory 大文件。
// 本模块负责目录、文件名、路径越界校验与读写清理，规则集中一处便于单测。
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, resolve, sep } from 'node:path'
import { randomBytes } from 'node:crypto'

/** 允许接收的图片 MIME → 扩展名映射（未收录类型按二进制安全扩展兜底） */
const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp'
}

/** 附件目录名（工作区 .trae 下的固定子目录） */
export const ATTACHMENTS_DIRNAME = 'attachments'

/** 单个附件大小上限 10MB（base64 前），防止误传大图撑爆工作区 */
const MAX_BYTES = 10 * 1024 * 1024

/** 计算附件目录绝对路径 */
export function attachmentsDir(workspace: string): string {
  return join(workspace, '.trae', ATTACHMENTS_DIRNAME)
}

/** MIME 归一化（小写），未知 MIME 返回 null */
export function normalizeMime(mimeType: unknown): string | null {
  if (typeof mimeType !== 'string') return null
  const m = mimeType.trim().toLowerCase()
  return MIME_EXT[m] ? m : null
}

/** MIME 对应扩展名（不含点） */
export function extForMime(mimeType: string): string {
  return MIME_EXT[mimeType] ?? 'img'
}

/**
 * 路径越界校验：给定路径必须位于某工作区的 .trae/attachments 目录内。
 * 用相对路径判定，拒绝 .. 跳出与绝对路径拼接（Windows 盘符/UNC）。
 */
export function isAttachmentPath(path: unknown, workspace?: string): path is string {
  if (typeof path !== 'string' || !path) return false
  if (!isAbsolute(path)) return false
  // 显式指定工作区：必须在其附件目录之下
  if (workspace) {
    const base = resolve(attachmentsDir(workspace)).toLowerCase()
    const target = resolve(path).toLowerCase()
    return target === base || target.startsWith(base + sep)
  }
  // 未指定工作区：路径段必须包含 .trae/<attachments>，且规范化后无 .. 残留
  const norm = resolve(path)
  const marker = `${sep}.trae${sep}${ATTACHMENTS_DIRNAME}${sep}`
  return norm.toLowerCase().includes(marker)
}

/**
 * 保存附件：base64 解码写入 <workspace>/.trae/attachments/<id>.<ext>。
 * 返回附件 id（文件名，不含扩展）与绝对路径。
 */
export async function saveAttachment(
  workspace: string,
  mimeType: string,
  /** base64 字符串（不含 data: 前缀） */
  dataB64: string
): Promise<{ id: string; path: string; mimeType: string }> {
  const mime = normalizeMime(mimeType)
  if (!mime) throw new Error(`不支持的图片类型：${mimeType}`)
  if (typeof dataB64 !== 'string' || !/^[A-Za-z0-9+/=\r\n]+$/.test(dataB64)) {
    throw new Error('附件数据不是合法 base64')
  }
  const buf = Buffer.from(dataB64.replace(/\s/g, ''), 'base64')
  if (buf.length === 0) throw new Error('附件内容为空')
  if (buf.length > MAX_BYTES) throw new Error(`附件超过 ${Math.round(MAX_BYTES / 1024 / 1024)}MB 上限`)

  const dir = attachmentsDir(workspace)
  await mkdir(dir, { recursive: true })
  // 文件名：时间戳 + 随机串，避免同名覆盖与并发碰撞
  const id = `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
  const path = join(dir, `${id}.${extForMime(mime)}`)
  await writeFile(path, buf)
  return { id, path, mimeType: mime }
}

/**
 * 读取附件为 data URL（供渲染端 <img> 显示，如重载历史会话时）。
 * 路径非法 / 文件不存在返回 ok:false，调用方渲染占位图。
 */
export async function readAttachment(
  path: string,
  workspace?: string
): Promise<{ ok: true; dataUrl: string; mimeType: string } | { ok: false; error: string }> {
  if (!isAttachmentPath(path, workspace)) return { ok: false, error: '路径非法' }
  try {
    const buf = await readFile(path)
    const ext = extname(path).slice(1).toLowerCase()
    const mimeType =
      Object.entries(MIME_EXT).find(([, e]) => e === ext)?.[0] ?? 'application/octet-stream'
    return { ok: true, dataUrl: `data:${mimeType};base64,${buf.toString('base64')}`, mimeType }
  } catch (err: any) {
    return { ok: false, error: err?.message || '附件读取失败' }
  }
}

/** 删除附件文件（尽力而为，文件不存在视为成功） */
export async function deleteAttachments(paths: string[], workspace?: string): Promise<void> {
  await Promise.all(
    paths
      .filter((p) => isAttachmentPath(p, workspace))
      .map(async (p) => {
        try {
          await rm(p, { force: true })
          // 空目录顺手清理（忽略失败）
          await rm(dirname(p), { recursive: false }).catch(() => {})
        } catch {
          /* 删除失败不影响主流程 */
        }
      })
  )
}
