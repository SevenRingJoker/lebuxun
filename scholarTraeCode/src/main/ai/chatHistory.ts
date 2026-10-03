// 聊天会话持久化：多会话、按工作区隔离、index + 分文件存储。
// 目录布局（根为注入的 userDataRoot，测试传 tmp 目录）：
//   <root>/chat-history/<wsKey>/index.json     会话元数据索引
//   <root>/chat-history/<wsKey>/<id>.json      单会话完整内容
// wsKey：工作区绝对路径的 base64url；无工作区为 'no-workspace'。
// 本模块不 import electron（userDataRoot 由调用方注入），可直接在 vitest 下测试。
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

/** 索引文件结构版本 */
const INDEX_VERSION = 1
/** 自动标题最大长度 */
const TITLE_MAX = 20
/** 列表预览最大长度 */
const PREVIEW_MAX = 60
/** 单条工具消息落盘上限（防止命令输出把会话文件撑爆） */
const TOOL_MSG_MAX = 2000
/** 单会话消息条数硬上限，超出丢弃最早消息 */
export const SESSION_MSG_LIMIT = 2000

/** 附件引用（2.3 图片输入）：历史只存路径引用，图片本身不进会话大文件 */
export interface StoredAttachment {
  /** 附件绝对路径（<workspace>/.trae/attachments/...） */
  path: string
  mimeType: string
}

/** 落盘的单条消息 */
export interface StoredMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  toolName?: string
  /** 2.3 图片附件引用（仅 user 消息；可与文本同时存在，也可仅有图片） */
  attachments?: StoredAttachment[]
  /** 毫秒时间戳 */
  ts: number
}

/** 完整会话（分文件内容） */
export interface SessionData {
  id: string
  /** 所属工作区绝对路径；null 表示无工作区分区 */
  workspace: string | null
  title: string
  createdAt: number
  updatedAt: number
  messages: StoredMessage[]
}

/** 索引中的会话摘要 */
export interface SessionMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
  /** 末条非工具消息预览 */
  preview: string
}

/** index.json 结构 */
interface SessionIndex {
  version: number
  sessions: SessionMeta[]
}

/** saveSession 入参：updatedAt 由存储层生成，id/createdAt 缺省时新建 */
export interface SessionSaveInput {
  id?: string
  title?: string
  createdAt?: number
  messages: StoredMessage[]
}

/** 工作区 → 分区 key：base64url，空值用固定名 */
export function workspaceKey(workspace: string | null | undefined): string {
  if (!workspace) return 'no-workspace'
  return Buffer.from(workspace, 'utf-8').toString('base64url')
}

/** 分区目录绝对路径 */
export function resolveStoreDir(userDataRoot: string, workspace: string | null | undefined): string {
  return join(userDataRoot, 'chat-history', workspaceKey(workspace))
}

function indexPath(dir: string): string {
  return join(dir, 'index.json')
}
function sessionPath(dir: string, id: string): string {
  return join(dir, `${id}.json`)
}

/**
 * 自动标题：第一条 user 消息，折叠空白、去首尾换行后截 TITLE_MAX 字；
 * 没有 user 消息时回退「未命名会话」。
 */
export function deriveTitle(messages: Array<{ role: string; content: string }>): string {
  const first = messages.find((m) => m.role === 'user' && m.content.trim())
  if (!first) return '未命名会话'
  const flat = first.content.replace(/\s+/g, ' ').trim()
  return flat.length > TITLE_MAX ? flat.slice(0, TITLE_MAX) + '…' : flat
}

/** 列表预览：末条非工具非空消息，折叠空白截 PREVIEW_MAX 字 */
export function derivePreview(messages: StoredMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'tool') continue
    const flat = m.content.replace(/\s+/g, ' ').trim()
    if (!flat) continue
    return flat.length > PREVIEW_MAX ? flat.slice(0, PREVIEW_MAX) + '…' : flat
  }
  return ''
}

/** 由完整会话生成索引摘要（纯函数） */
export function buildMeta(session: SessionData): SessionMeta {
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
    preview: derivePreview(session.messages)
  }
}

/** 读取索引；不存在/损坏返回 null（调用方触发自愈重扫） */
async function readIndex(dir: string): Promise<SessionIndex | null> {
  try {
    const raw = await fs.readFile(indexPath(dir), 'utf-8')
    const parsed = JSON.parse(raw) as SessionIndex
    if (!parsed || parsed.version !== INDEX_VERSION || !Array.isArray(parsed.sessions)) return null
    return parsed
  } catch {
    return null
  }
}

/** 临时文件 + rename 原子写，防止崩溃留下半截 JSON */
async function atomicWrite(file: string, payload: string): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  await fs.writeFile(tmp, payload, 'utf-8')
  await fs.rename(tmp, file)
}

async function writeIndex(dir: string, sessions: SessionMeta[]): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
  const index: SessionIndex = { version: INDEX_VERSION, sessions }
  await atomicWrite(indexPath(dir), JSON.stringify(index))
}

/** 生成会话 id（时间 + 随机，避免额外依赖 uuid） */
function newSessionId(): string {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 保存会话（upsert）：
 * - 无 id / 索引中不存在 → 新建（生成 id、createdAt）
 * - 消息为空 → 拒绝写入（空会话不落盘）
 * - 超过消息上限 → 丢弃最早消息
 * - 先写会话文件，成功后再更新索引，避免索引指向未写好的文件
 * @returns 保存后的会话 id；空消息返回 null
 */
export async function saveSession(
  userDataRoot: string,
  workspace: string | null,
  data: SessionSaveInput
): Promise<string | null> {
  const cleanMessages = sanitizeMessages(data.messages)
  if (cleanMessages.length === 0) return null

  const dir = resolveStoreDir(userDataRoot, workspace)
  const existing = (await readIndex(dir))?.sessions ?? []
  const known = new Set(existing.map((s) => s.id))
  const id = data.id && known.has(data.id) ? data.id : data.id && !data.id.startsWith('tmp-') ? data.id : newSessionId()
  const now = Date.now()
  const prevMeta = existing.find((s) => s.id === id)
  const session: SessionData = {
    id,
    workspace,
    title: data.title?.trim() || deriveTitle(cleanMessages),
    createdAt: prevMeta?.createdAt ?? data.createdAt ?? now,
    updatedAt: now,
    messages: cleanMessages
  }

  await fs.mkdir(dir, { recursive: true })
  await atomicWrite(sessionPath(dir, id), JSON.stringify(session))

  const meta = buildMeta(session)
  const next = [meta, ...existing.filter((s) => s.id !== id)]
  await writeIndex(dir, next)
  return id
}

/** 消息清洗：丢弃无 ts 的由调用方补；工具消息截断；超上限硬截断最早消息 */
function sanitizeMessages(messages: StoredMessage[]): StoredMessage[] {
  const now = Date.now()
  const cleaned = messages
    // 允许「仅有图片、无文本」的用户消息
    .filter((m) =>
      m &&
      typeof m.content === 'string' &&
      (m.content.length > 0 || (Array.isArray(m.attachments) && m.attachments.length > 0))
    )
    .map((m) => {
      const out: StoredMessage = {
        role: m.role,
        content: m.role === 'tool' ? m.content.slice(0, TOOL_MSG_MAX) : m.content,
        ...(m.toolName ? { toolName: m.toolName } : {}),
        ts: typeof m.ts === 'number' ? m.ts : now
      }
      // 附件只保留 path/mimeType 合法条目（丢弃坏引用，防止脏数据落盘）
      if (Array.isArray(m.attachments) && m.attachments.length > 0) {
        const att = m.attachments.filter(
          (a) => a && typeof a.path === 'string' && typeof a.mimeType === 'string' && a.path
        )
        if (att.length > 0) out.attachments = att
      }
      return out
    })
  if (cleaned.length > SESSION_MSG_LIMIT) {
    return cleaned.slice(cleaned.length - SESSION_MSG_LIMIT)
  }
  return cleaned
}

/**
 * 列出会话（updatedAt 降序）。
 * 自愈：以磁盘分文件为准——孤儿文件补进索引，索引指向缺失文件则剔除，
 * 发现不一致时重写 index.json。
 */
export async function listSessions(
  userDataRoot: string,
  workspace: string | null
): Promise<SessionMeta[]> {
  const dir = resolveStoreDir(userDataRoot, workspace)
  let files: string[] = []
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json') && f !== 'index.json')
  } catch {
    return []
  }
  const metasFromDisk: SessionMeta[] = []
  for (const f of files) {
    try {
      const raw = await fs.readFile(join(dir, f), 'utf-8')
      const session = JSON.parse(raw) as SessionData
      if (!session?.id || !Array.isArray(session.messages)) continue
      metasFromDisk.push(buildMeta(session))
    } catch {
      // 损坏的会话文件跳过（不删除用户数据，仅在列表中不可见）
    }
  }
  const diskIds = new Set(metasFromDisk.map((m) => m.id))
  const indexed = (await readIndex(dir))?.sessions ?? []
  const indexHealthy = indexed.every((m) => diskIds.has(m.id)) && metasFromDisk.every((m) => indexed.some((x) => x.id === m.id))
  if (!indexHealthy) {
    metasFromDisk.sort((a, b) => b.updatedAt - a.updatedAt)
    await writeIndex(dir, metasFromDisk).catch(() => {})
    return metasFromDisk
  }
  return indexed.sort((a, b) => b.updatedAt - a.updatedAt)
}

/** 加载单个完整会话；不存在/损坏返回 null */
export async function loadSession(
  userDataRoot: string,
  workspace: string | null,
  id: string
): Promise<SessionData | null> {
  try {
    const raw = await fs.readFile(sessionPath(resolveStoreDir(userDataRoot, workspace), id), 'utf-8')
    const session = JSON.parse(raw) as SessionData
    if (!session?.id || !Array.isArray(session.messages)) return null
    return session
  } catch {
    return null
  }
}

/** 删除会话文件；随后重建索引（缺失文件会被自然剔除） */
export async function deleteSession(
  userDataRoot: string,
  workspace: string | null,
  id: string
): Promise<void> {
  const dir = resolveStoreDir(userDataRoot, workspace)
  await fs.rm(sessionPath(dir, id), { force: true })
  await listSessions(userDataRoot, workspace) // 触发索引自愈重写
}

/**
 * 会话导出为 Markdown：标题 + 时间 + 角色分段。
 * 内容不做 HTML 转义（纯 .md 阅读场景）。
 */
export function toMarkdown(session: SessionData): string {
  const fmt = (ts: number): string => {
    const d = new Date(ts)
    const p = (n: number): string => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  }
  const lines: string[] = [`# ${session.title}`, '', `> 导出时间：${fmt(Date.now())}；消息数：${session.messages.length}`, '']
  for (const m of session.messages) {
    const time = fmt(m.ts)
    if (m.role === 'user') {
      lines.push(`## 🧑 用户 · ${time}`, '', m.content, '')
    } else if (m.role === 'assistant') {
      lines.push(`## 🤖 助手 · ${time}`, '', m.content, '')
    } else if (m.role === 'tool') {
      lines.push(`> 🔧 工具 \`${m.toolName || 'unknown'}\` · ${time}`, '', ...m.content.split('\n').map((l) => `> ${l}`), '')
    } else {
      lines.push(`---  ${m.content}  · ${time} ---`, '')
    }
  }
  return lines.join('\n')
}
