// attachments 附件存储单测（2.3 s33）：
// tmpdir 隔离，覆盖 MIME 归一化、附件目录、路径越界校验（traversal/相对路径/UNC 思路）、
// save/read/delete 全流程、坏 base64/空内容/超 10MB 上限拦截。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ATTACHMENTS_DIRNAME,
  attachmentsDir,
  normalizeMime,
  extForMime,
  isAttachmentPath,
  saveAttachment,
  readAttachment,
  deleteAttachments
} from './attachments'

/** 1x1 PNG base64 */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC'

let tmpRoot: string
/** 模拟工作区（tmpdir 下的隔离目录） */
let workspace: string

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(join(tmpdir(), 'scholar-att-'))
  workspace = join(tmpRoot, 'workspace')
  await fs.mkdir(workspace, { recursive: true })
})

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

describe('纯函数：MIME 与目录', () => {
  it('normalizeMime：trim + 小写，未知/非字符串返回 null', () => {
    expect(normalizeMime('image/PNG')).toBe('image/png')
    expect(normalizeMime(' image/jpeg ')).toBe('image/jpeg')
    expect(normalizeMime('image/svg+xml')).toBeNull()
    expect(normalizeMime(123)).toBeNull()
    expect(normalizeMime(undefined)).toBeNull()
  })

  it('extForMime：已知 MIME 给扩展名，未知给 img 兜底', () => {
    expect(extForMime('image/png')).toBe('png')
    expect(extForMime('image/jpeg')).toBe('jpg')
    expect(extForMime('image/webp')).toBe('webp')
    expect(extForMime('image/unknown')).toBe('img')
  })

  it('attachmentsDir：<workspace>/.trae/attachments', () => {
    expect(attachmentsDir(workspace)).toBe(
      join(workspace, '.trae', ATTACHMENTS_DIRNAME)
    )
  })
})

describe('isAttachmentPath 路径越界校验', () => {
  it('合法：保存产物绝对路径位于工作区附件目录内', async () => {
    const saved = await saveAttachment(workspace, 'image/png', PNG_B64)
    expect(isAttachmentPath(saved.path, workspace)).toBe(true)
  })

  it('拒绝：相对路径、空值、非字符串', () => {
    expect(isAttachmentPath('attachments/x.png', workspace)).toBe(false)
    expect(isAttachmentPath('', workspace)).toBe(false)
    expect(isAttachmentPath(null, workspace)).toBe(false)
    expect(isAttachmentPath(undefined, workspace)).toBe(false)
  })

  it('拒绝：.. 跳出附件目录到工作区其他位置', () => {
    const escaped = join(workspace, '.trae', ATTACHMENTS_DIRNAME, '..', '..', 'evil.png')
    expect(isAttachmentPath(escaped, workspace)).toBe(false)
  })

  it('拒绝：工作区外的绝对路径', () => {
    expect(isAttachmentPath(join(tmpRoot, 'other', 'x.png'), workspace)).toBe(false)
  })

  it('未指定工作区：路径段须含 .trae/attachments 标记', () => {
    const inside = join(workspace, '.trae', ATTACHMENTS_DIRNAME, 'x.png')
    expect(isAttachmentPath(inside)).toBe(true)
    expect(isAttachmentPath(join(workspace, 'x.png'))).toBe(false)
  })
})

describe('saveAttachment 保存', () => {
  it('写盘成功：文件存在、字节一致、返回 id/path/mimeType，扩展名正确', async () => {
    const saved = await saveAttachment(workspace, 'image/jpeg', 'YWJjZA==')
    expect(saved.mimeType).toBe('image/jpeg')
    expect(saved.path.endsWith('.jpg')).toBe(true)
    // id 为文件名去掉扩展名
    expect(saved.path).toBe(join(attachmentsDir(workspace), `${saved.id}.jpg`))
    const bytes = await fs.readFile(saved.path)
    expect(bytes.equals(Buffer.from('YWJjZA==', 'base64'))).toBe(true)
    expect(bytes.toString()).toBe('abcd')
  })

  it('base64 内允许空白/换行（NDJSON 传输场景）', async () => {
    const withNewlines = `${PNG_B64.slice(0, 20)}\n${PNG_B64.slice(20)}`
    const saved = await saveAttachment(workspace, 'image/png', withNewlines)
    const bytes = await fs.readFile(saved.path)
    expect(bytes.equals(Buffer.from(PNG_B64, 'base64'))).toBe(true)
  })

  it('拦截：不支持的 MIME、非法 base64、空内容、超 10MB', async () => {
    await expect(saveAttachment(workspace, 'image/svg+xml', PNG_B64)).rejects.toThrow('不支持')
    await expect(saveAttachment(workspace, 'image/png', '@@@not-base64@@@')).rejects.toThrow(
      'base64'
    )
    await expect(saveAttachment(workspace, 'image/png', '')).rejects.toThrow()
    // 11MB 零字节 → 超过 10MB 上限（base64 编码后约 14.7MB）
    const huge = Buffer.alloc(11 * 1024 * 1024, 0).toString('base64')
    await expect(saveAttachment(workspace, 'image/png', huge)).rejects.toThrow('上限')
  })
})

describe('readAttachment 读取', () => {
  it('合法附件 → ok + data URL（含 MIME 前缀）', async () => {
    const saved = await saveAttachment(workspace, 'image/png', PNG_B64)
    const r = await readAttachment(saved.path, workspace)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.mimeType).toBe('image/png')
      expect(r.dataUrl).toBe(`data:image/png;base64,${PNG_B64}`)
    }
  })

  it('路径非法 → ok:false「路径非法」', async () => {
    const r = await readAttachment(join(workspace, 'evil.png'), workspace)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('路径非法')
  })

  it('文件缺失（引用失效）→ ok:false，调用方据此渲染占位', async () => {
    const missing = join(attachmentsDir(workspace), 'ghost-id.png')
    const r = await readAttachment(missing, workspace)
    expect(r.ok).toBe(false)
  })
})

describe('deleteAttachments 删除', () => {
  it('删除已保存附件，文件不再存在', async () => {
    const saved = await saveAttachment(workspace, 'image/png', PNG_B64)
    await deleteAttachments([saved.path], workspace)
    await expect(fs.access(saved.path)).rejects.toThrow()
  })

  it('批量删除：非法路径静默跳过，不影响合法项', async () => {
    const a = await saveAttachment(workspace, 'image/png', PNG_B64)
    const b = await saveAttachment(workspace, 'image/jpeg', 'YWJjZA==')
    await deleteAttachments([
      a.path,
      b.path,
      join(workspace, 'not-attachment.png'),
      '',
      join(workspace, '.trae', ATTACHMENTS_DIRNAME, '..', '..', 'escape.png')
    ])
    await expect(fs.access(a.path)).rejects.toThrow()
    await expect(fs.access(b.path)).rejects.toThrow()
  })
})
