// chatHistory 持久化单测：tmpdir 隔离，覆盖 CRUD、索引自愈、分区隔离、标题/预览/Markdown 纯函数。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  workspaceKey,
  resolveStoreDir,
  deriveTitle,
  derivePreview,
  buildMeta,
  saveSession,
  listSessions,
  loadSession,
  deleteSession,
  toMarkdown,
  SESSION_MSG_LIMIT,
  type StoredMessage,
  type SessionData
} from './chatHistory'

let root: string
const ws1 = 'D:\\demo\\project-a'
const ws2 = 'D:\\demo\\project-b'

function msg(role: StoredMessage['role'], content: string, ts: number, toolName?: string): StoredMessage {
  return { role, content, ts, ...(toolName ? { toolName } : {}) }
}

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'scholar-chat-'))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('纯函数', () => {
  it('workspaceKey：空值固定分区，有值为 base64url 且不同路径不同 key', () => {
    expect(workspaceKey(null)).toBe('no-workspace')
    expect(workspaceKey('')).toBe('no-workspace')
    expect(workspaceKey(undefined)).toBe('no-workspace')
    const k1 = workspaceKey(ws1)
    expect(k1).not.toContain('=')
    expect(workspaceKey(ws1)).toBe(k1)
    expect(workspaceKey(ws2)).not.toBe(k1)
  })

  it('resolveStoreDir 拼出 chat-history/<key>', () => {
    const dir = resolveStoreDir(root, ws1)
    expect(dir).toBe(join(root, 'chat-history', workspaceKey(ws1)))
    expect(resolveStoreDir(root, null)).toBe(join(root, 'chat-history', 'no-workspace'))
  })

  it('deriveTitle：取首条 user、折叠空白、截断 20 字带省略号；无 user 回退', () => {
    expect(deriveTitle([msg('assistant', '你好', 1)])).toBe('未命名会话')
    expect(deriveTitle([msg('user', '  第一行\n  第二列  ', 1)])).toBe('第一行 第二列')
    const long = '这是一条超过二十个字长度的用户提问消息标题啊啊啊'
    const t = deriveTitle([msg('user', long, 1)])
    expect(t.length).toBe(21) // 20 字 + …
    expect(t.endsWith('…')).toBe(true)
  })

  it('derivePreview：跳过工具与空消息取末条，截断 60 字', () => {
    expect(derivePreview([msg('user', '问题', 1), msg('tool', '输出', 2, 'bash')])).toBe('问题')
    expect(derivePreview([msg('assistant', '  ', 1), msg('assistant', '答复', 2)])).toBe('答复')
    const longText = 'a'.repeat(80)
    const p = derivePreview([msg('assistant', longText, 1)])
    expect(p.length).toBe(61)
    expect(p.endsWith('…')).toBe(true)
  })

  it('buildMeta 摘要字段与消息数一致', () => {
    const session: SessionData = {
      id: 'x', workspace: ws1, title: 't', createdAt: 100, updatedAt: 200,
      messages: [msg('user', '问题', 100), msg('assistant', '答复', 200)]
    }
    const meta = buildMeta(session)
    expect(meta).toMatchObject({ id: 'x', title: 't', createdAt: 100, updatedAt: 200, messageCount: 2, preview: '答复' })
  })
})

describe('saveSession / listSessions / loadSession', () => {
  it('首次保存：生成 id、写会话文件与索引，自动标题取首条 user', async () => {
    const id = await saveSession(root, ws1, {
      id: undefined, title: '', createdAt: undefined,
      messages: [msg('user', '帮我实现登录', 1), msg('assistant', '好的', 2)]
    } as unknown as Parameters<typeof saveSession>[2])
    expect(id).toBeTruthy()
    const list = await listSessions(root, ws1)
    expect(list).toHaveLength(1)
    expect(list[0].title).toBe('帮我实现登录')
    expect(list[0].messageCount).toBe(2)
    const loaded = await loadSession(root, ws1, id!)
    expect(loaded?.messages).toHaveLength(2)
    expect(loaded?.workspace).toBe(ws1)
    // index.json 与分文件均落盘
    const dir = resolveStoreDir(root, ws1)
    await expect(fs.access(join(dir, 'index.json'))).resolves.toBeUndefined()
    await expect(fs.access(join(dir, `${id}.json`))).resolves.toBeUndefined()
  })

  it('同 id 二次保存：更新而不新增，createdAt 保留、updatedAt 推进', async () => {
    const id = await saveSession(root, ws1, {
      id: 'fixed-1', title: '旧标题', createdAt: 500,
      messages: [msg('user', '问题', 1000)]
    })
    expect(id).toBe('fixed-1')
    await new Promise((r) => setTimeout(r, 5))
    const id2 = await saveSession(root, ws1, {
      id: 'fixed-1', title: '新标题', createdAt: 500,
      messages: [msg('user', '问题', 1000), msg('assistant', '完整回答内容', 2000)]
    })
    expect(id2).toBe('fixed-1')
    const list = await listSessions(root, ws1)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: 'fixed-1', title: '新标题', messageCount: 2 })
    expect(list[0].createdAt).toBe(500)
    expect(list[0].updatedAt).toBeGreaterThanOrEqual(1000)
  })

  it('空消息不落盘并返回 null', async () => {
    const id = await saveSession(root, ws1, {
      id: 'empty', title: '', createdAt: 1, messages: []
    })
    expect(id).toBeNull()
    expect(await listSessions(root, ws1)).toHaveLength(0)
  })

  it('不同工作区分区隔离；列表按 updatedAt 降序', async () => {
    await saveSession(root, ws1, { id: 'a1', title: 'A1', createdAt: 1, messages: [msg('user', 'a1', 1000)] })
    await new Promise((r) => setTimeout(r, 5))
    await saveSession(root, ws2, { id: 'b1', title: 'B1', createdAt: 2, messages: [msg('user', 'b1', 3000)] })
    await new Promise((r) => setTimeout(r, 5))
    await saveSession(root, ws1, { id: 'a2', title: 'A2', createdAt: 3, messages: [msg('user', 'a2', 5000)] })
    expect((await listSessions(root, ws1)).map((s) => s.id)).toEqual(['a2', 'a1'])
    expect((await listSessions(root, ws2)).map((s) => s.id)).toEqual(['b1'])
    expect(await loadSession(root, ws2, 'a1')).toBeNull()
  })

  it('删除会话：文件移除且索引同步，删不存在的 id 不报错', async () => {
    await saveSession(root, ws1, { id: 'd1', title: 'D', createdAt: 1, messages: [msg('user', 'x', 1)] })
    await deleteSession(root, ws1, 'd1')
    expect(await listSessions(root, ws1)).toHaveLength(0)
    expect(await loadSession(root, ws1, 'd1')).toBeNull()
    await expect(deleteSession(root, ws1, 'ghost')).resolves.toBeUndefined()
  })

  it('自愈：索引指向缺失文件时被剔除并重写', async () => {
    await saveSession(root, ws1, { id: 'keep', title: 'K', createdAt: 1, messages: [msg('user', 'k', 1)] })
    await saveSession(root, ws1, { id: 'lost', title: 'L', createdAt: 2, messages: [msg('user', 'l', 2)] })
    // 手动删掉 lost 分文件模拟崩溃在两次写之间
    await fs.rm(join(resolveStoreDir(root, ws1), 'lost.json'))
    const list = await listSessions(root, ws1)
    expect(list.map((s) => s.id)).toEqual(['keep'])
    // 再读一次索引已是健康状态
    expect((await listSessions(root, ws1)).map((s) => s.id)).toEqual(['keep'])
  })

  it('自愈：孤儿会话文件（索引丢失/损坏）被重新收录', async () => {
    await saveSession(root, ws1, { id: 'orphan', title: 'O', createdAt: 1, messages: [msg('user', 'o', 1)] })
    await fs.rm(join(resolveStoreDir(root, ws1), 'index.json'))
    const list = await listSessions(root, ws1)
    expect(list.map((s) => s.id)).toEqual(['orphan'])
  })

  it('损坏的会话文件跳过不影响其他会话', async () => {
    await saveSession(root, ws1, { id: 'good', title: 'G', createdAt: 1, messages: [msg('user', 'g', 1)] })
    const dir = resolveStoreDir(root, ws1)
    await fs.writeFile(join(dir, 'broken.json'), '{not json', 'utf-8')
    const list = await listSessions(root, ws1)
    expect(list.map((s) => s.id)).toEqual(['good'])
    expect(await loadSession(root, ws1, 'broken')).toBeNull()
  })

  it('消息超 SESSION_MSG_LIMIT 时截断最早消息', async () => {
    const many: StoredMessage[] = []
    for (let i = 0; i < SESSION_MSG_LIMIT + 50; i++) many.push(msg('user', `m${i}`, i))
    await saveSession(root, ws1, { id: 'big', title: 'big', createdAt: 1, messages: many })
    const loaded = await loadSession(root, ws1, 'big')
    expect(loaded?.messages).toHaveLength(SESSION_MSG_LIMIT)
    expect(loaded?.messages[0].content).toBe('m50')
  })

  it('工具消息超 2000 字被截断', async () => {
    await saveSession(root, ws1, {
      id: 'tool', title: 't', createdAt: 1,
      messages: [msg('tool', 'x'.repeat(5000), 1, 'bash')]
    })
    const loaded = await loadSession(root, ws1, 'tool')
    expect(loaded?.messages[0].content).toHaveLength(2000)
    expect(loaded?.messages[0].toolName).toBe('bash')
  })
})

describe('toMarkdown', () => {
  it('包含标题与各角色分段', () => {
    const session: SessionData = {
      id: 'm1', workspace: null, title: '导出测试', createdAt: 0, updatedAt: 200,
      messages: [
        msg('user', '你好', 1000),
        msg('assistant', '在的', 2000),
        msg('tool', 'ls 输出', 3000, 'bash'),
        msg('system', '完成 ✓', 4000)
      ]
    }
    const md = toMarkdown(session)
    expect(md).toContain('# 导出测试')
    expect(md).toContain('🧑 用户')
    expect(md).toContain('你好')
    expect(md).toContain('🤖 助手')
    expect(md).toContain('在的')
    expect(md).toContain('`bash`')
    expect(md.split('\n').some((l) => l.startsWith('> ls 输出'))).toBe(true)
    expect(md).toContain('完成 ✓')
  })
})
