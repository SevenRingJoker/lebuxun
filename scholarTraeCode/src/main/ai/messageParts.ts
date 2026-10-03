// 多模态消息 Provider 转换层（2.3 图片输入）：
// 把统一 AiMessage（含 MessagePart）转换为各供应商自家的多模态线协议：
// - OpenAI 兼容：content 块数组 [{type:'text'} / {type:'image_url'}]
// - Anthropic：content blocks [{type:'text'} / {type:'image', source}]
// - Ollama：{ role, content, images:[base64] }
// 无 parts 的消息一律原样透传，保持现有工具轮次线协议不受影响。
import { readFile } from 'node:fs/promises'
import type { AiMessage, MessagePart } from './types'

/** 图片片段类型别名（image 分支） */
type ImagePart = Extract<MessagePart, { type: 'image' }>

/**
 * 取图片 base64（不含 data: 前缀）：
 * 优先内嵌 data（渲染端刚粘贴/历史会话同进程场景）；
 * 仅有 path 时读盘（附件落 .trae/attachments）。
 */
async function imageBase64(part: ImagePart): Promise<string> {
  if (part.data) return part.data
  if (part.path) {
    const buf = await readFile(part.path)
    return buf.toString('base64')
  }
  throw new Error('图片片段缺少 data/path')
}

// ===================== OpenAI 兼容 =====================

/**
 * 单条消息 → OpenAI 兼容格式：
 * 无 parts 原样返回（保留 toolCalls/name 等既有字段）；
 * 有 parts → content 转为多类型块数组。
 */
export async function toOpenAiMessage(
  m: AiMessage
): Promise<AiMessage | { role: string; content: unknown[]; name?: string }> {
  if (!m.parts || m.parts.length === 0) return m
  const content: unknown[] = []
  for (const p of m.parts) {
    if (p.type === 'text') {
      content.push({ type: 'text', text: p.text })
    } else {
      // data URL：OpenAI 视觉消息约定 image_url.url
      content.push({
        type: 'image_url',
        image_url: { url: `data:${p.mimeType};base64,${await imageBase64(p)}` }
      })
    }
  }
  return {
    role: m.role,
    content,
    ...(m.name ? { name: m.name } : {})
  }
}

/** 批量转换 OpenAI 兼容消息 */
export async function toOpenAiMessages(messages: AiMessage[]): Promise<unknown[]> {
  return Promise.all(messages.map((m) => toOpenAiMessage(m)))
}

// ===================== Anthropic =====================

/**
 * 单条消息 content → Anthropic blocks：
 * 无 parts 返回纯字符串；有 parts 返回 text/image block 数组。
 * image block 为 source.base64 形态（Anthropic 视觉协议）。
 */
export async function toAnthropicContent(m: AiMessage): Promise<string | unknown[]> {
  if (!m.parts || m.parts.length === 0) return m.content
  const blocks: unknown[] = []
  for (const p of m.parts) {
    if (p.type === 'text') {
      blocks.push({ type: 'text', text: p.text })
    } else {
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: p.mimeType,
          data: await imageBase64(p)
        }
      })
    }
  }
  return blocks
}

// ===================== Ollama =====================

/**
 * 单条消息 → Ollama /api/chat 格式：
 * 无 parts 原样返回；有 parts → content 为文本拼接，images 为 base64 数组
 * （Ollama 视觉协议：llava / qwen2-vl 读 message.images）。
 */
export async function toOllamaMessage(
  m: AiMessage
): Promise<AiMessage | { role: string; content: string; images?: string[]; name?: string }> {
  if (!m.parts || m.parts.length === 0) return m
  const texts: string[] = []
  const images: string[] = []
  for (const p of m.parts) {
    if (p.type === 'text') texts.push(p.text)
    else images.push(await imageBase64(p))
  }
  const out: { role: string; content: string; images?: string[]; name?: string } = {
    role: m.role,
    content: texts.join('\n')
  }
  if (images.length > 0) out.images = images
  if (m.name) out.name = m.name
  return out
}

/** 批量转换 Ollama 消息 */
export async function toOllamaMessages(messages: AiMessage[]): Promise<unknown[]> {
  return Promise.all(messages.map((m) => toOllamaMessage(m)))
}
