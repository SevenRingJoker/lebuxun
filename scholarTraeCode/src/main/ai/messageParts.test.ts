// messageParts 多模态转换单测（2.3 s33）：
// 覆盖三类 provider 线协议转换（OpenAI content 块 / Anthropic blocks / Ollama images）、
// 无 parts 原样透传、path 读盘、image-only 消息、缺 data/path 报错与批量转换。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AiMessage } from './types'
import {
  toOpenAiMessage,
  toOpenAiMessages,
  toAnthropicContent,
  toOllamaMessage,
  toOllamaMessages
} from './messageParts'

/** 1x1 PNG 的 base64（最小合法图片载荷），作为内嵌图片测试数据 */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
const MIME = 'image/png'

let tmpRoot: string

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(join(tmpdir(), 'scholar-parts-'))
})

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

/** 构造一条 user 消息（默认带文本 + 内嵌图片两个 part） */
function multimodalMsg(parts: AiMessage['parts']): AiMessage {
  return { role: 'user', content: '旧 content（应被 parts 取代）', parts }
}

describe('无 parts 透传', () => {
  it('OpenAI / Ollama：无 parts 或空 parts 时返回原对象引用', async () => {
    const plain: AiMessage = { role: 'user', content: '纯文本' }
    await expect(toOpenAiMessage(plain)).resolves.toBe(plain)
    await expect(toOllamaMessage(plain)).resolves.toBe(plain)
    const emptyParts: AiMessage = { role: 'user', content: '文本', parts: [] }
    await expect(toOpenAiMessage(emptyParts)).resolves.toBe(emptyParts)
    await expect(toOllamaMessage(emptyParts)).resolves.toBe(emptyParts)
  })

  it('Anthropic：无 parts 返回 content 纯字符串', async () => {
    await expect(toAnthropicContent({ role: 'user', content: '纯文本' })).resolves.toBe('纯文本')
    await expect(
      toAnthropicContent({ role: 'user', content: '文本', parts: [] })
    ).resolves.toBe('文本')
  })
})

describe('OpenAI 兼容转换', () => {
  it('文本 + 内嵌图片 → text / image_url content 块（data URL）', async () => {
    const out = (await toOpenAiMessage(
      multimodalMsg([
        { type: 'text', text: '描述这张图' },
        { type: 'image', mimeType: MIME, data: PNG_B64 }
      ])
    )) as { role: string; content: unknown[] }
    expect(out.role).toBe('user')
    expect(out.content).toEqual([
      { type: 'text', text: '描述这张图' },
      { type: 'image_url', image_url: { url: `data:${MIME};base64,${PNG_B64}` } }
    ])
  })

  it('仅有 path 的图片 → 读盘后编为 data URL', async () => {
    const imgPath = join(tmpRoot, 'shot.png')
    await fs.writeFile(imgPath, Buffer.from(PNG_B64, 'base64'))
    const out = (await toOpenAiMessage(
      multimodalMsg([{ type: 'image', mimeType: MIME, path: imgPath }])
    )) as { content: unknown[] }
    const imageBlock = out.content[0] as {
      type: string
      image_url: { url: string }
    }
    expect(imageBlock.type).toBe('image_url')
    expect(imageBlock.image_url.url).toBe(`data:${MIME};base64,${PNG_B64}`)
  })

  it('name 字段随 parts 消息保留；多图片按序输出', async () => {
    const out = (await toOpenAiMessage({
      role: 'user',
      content: '',
      name: 'tester',
      parts: [
        { type: 'image', mimeType: MIME, data: PNG_B64 },
        { type: 'image', mimeType: 'image/jpeg', data: 'abcd' }
      ]
    })) as { name?: string; content: unknown[] }
    expect(out.name).toBe('tester')
    expect(out.content).toHaveLength(2)
  })

  it('批量转换：无 parts 消息原样、parts 消息转换，顺序不变', async () => {
    const list = await toOpenAiMessages([
      { role: 'system', content: '系统提示' },
      multimodalMsg([{ type: 'image', mimeType: MIME, data: PNG_B64 }])
    ])
    expect(list).toHaveLength(2)
    expect((list[0] as AiMessage).content).toBe('系统提示')
    expect(Array.isArray((list[1] as { content: unknown }).content)).toBe(true)
  })
})

describe('Anthropic 转换', () => {
  it('文本 + 图片 → text block + image block（source.base64 + media_type）', async () => {
    const blocks = (await toAnthropicContent(
      multimodalMsg([
        { type: 'text', text: '看截图' },
        { type: 'image', mimeType: MIME, data: PNG_B64 }
      ])
    )) as unknown[]
    expect(blocks).toEqual([
      { type: 'text', text: '看截图' },
      { type: 'image', source: { type: 'base64', media_type: MIME, data: PNG_B64 } }
    ])
  })

  it('path 图片读盘后填入 source.data', async () => {
    const imgPath = join(tmpRoot, 'a.png')
    await fs.writeFile(imgPath, Buffer.from(PNG_B64, 'base64'))
    const blocks = (await toAnthropicContent(
      multimodalMsg([{ type: 'image', mimeType: MIME, path: imgPath }])
    )) as any[]
    expect(blocks[0].type).toBe('image')
    expect(blocks[0].source).toMatchObject({ type: 'base64', media_type: MIME, data: PNG_B64 })
  })
})

describe('Ollama 转换', () => {
  it('文本 + 图片 → content 文本拼接 + images base64 数组', async () => {
    const out = (await toOllamaMessage(
      multimodalMsg([
        { type: 'text', text: '第一行' },
        { type: 'image', mimeType: MIME, data: PNG_B64 },
        { type: 'text', text: '第二行' }
      ])
    )) as { role: string; content: string; images: string[] }
    expect(out.role).toBe('user')
    expect(out.content).toBe('第一行\n第二行')
    expect(out.images).toEqual([PNG_B64])
  })

  it('image-only 消息：content 为空串，images 仍携带；多图按序', async () => {
    const out = (await toOllamaMessage(
      multimodalMsg([
        { type: 'image', mimeType: MIME, data: PNG_B64 },
        { type: 'image', mimeType: 'image/jpeg', data: 'YWJjZA==' }
      ])
    )) as { content: string; images: string[] }
    expect(out.content).toBe('')
    expect(out.images).toHaveLength(2)
  })

  it('批量转换与无图时不带 images 字段', async () => {
    const list = (await toOllamaMessages([
      { role: 'assistant', content: '好的' },
      multimodalMsg([
        { type: 'text', text: '问题' },
        { type: 'image', mimeType: MIME, data: PNG_B64 }
      ])
    ])) as Array<{ content: string; images?: string[] }>
    expect(list[0].images).toBeUndefined()
    expect(list[1].images).toEqual([PNG_B64])
  })
})

describe('异常路径', () => {
  it('图片片段既无 data 也无 path → 抛「图片片段缺少 data/path」，三类转换均 reject', async () => {
    const bad = multimodalMsg([{ type: 'image', mimeType: MIME }])
    await expect(toOpenAiMessage(bad)).rejects.toThrow('图片片段缺少 data/path')
    await expect(toAnthropicContent(bad)).rejects.toThrow('图片片段缺少 data/path')
    await expect(toOllamaMessage(bad)).rejects.toThrow('图片片段缺少 data/path')
  })

  it('批量转换中任一条读盘失败 → 整批 reject（Promise.all 语义）', async () => {
    const missing = join(tmpRoot, 'not-exist.png')
    await expect(
      toOpenAiMessages([
        { role: 'user', content: '正常' },
        multimodalMsg([{ type: 'image', mimeType: MIME, path: missing }])
      ])
    ).rejects.toThrow()
    await expect(
      toOllamaMessages([multimodalMsg([{ type: 'image', mimeType: MIME, path: missing }])])
    ).rejects.toThrow()
  })
})
