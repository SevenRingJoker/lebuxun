// 轻量 Markdown 渲染器：专为 AI 聊天气泡设计。
// 不引入第三方依赖，覆盖聊天场景常用语法：
// 标题/加粗/斜体/删除线/行内代码/代码块/有序无序列表/链接/分隔线/段落换行。
// 所有文本先转义 HTML，再在转义结果上做标记替换，保证注入安全（配合 v-html 使用）。

// 占位符使用特殊标记包裹，避免与正文内容（反引号/数字）冲突
const INLINE_MARK = '@@MDCODE_'
const BLOCK_MARK = '@@MDBLOCK_'

/** HTML 特殊字符转义 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 行内格式：行内代码、加粗、斜体、删除线、链接（输入已转义） */
function renderInline(text: string): string {
  let out = text
  // 行内代码（先处理，内部不再参与其他格式）
  const codes: string[] = []
  out = out.replace(/`([^`\n]+)`/g, (_m, code) => {
    codes.push(code)
    return `${INLINE_MARK}${codes.length - 1}${INLINE_MARK}`
  })
  // 图片 ![alt](url)：必须先于普通链接处理；放行 http(s)/data:image/相对路径
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, url) => {
    const safe =
      /^https?:\/\//i.test(url) ||
      url.startsWith('data:image/') ||
      url.startsWith('/') ||
      url.startsWith('.')
    return safe
      ? `<img class="md-img" src="${url}" alt="${alt}" title="${alt}" loading="lazy"/>`
      : alt
  })
  // 链接 [text](url)：仅放行 http/https/相对路径，防 javascript: 协议
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, url) => {
    const safe = /^https?:\/\//i.test(url) || url.startsWith('/') || url.startsWith('.') || url.startsWith('#')
    return safe
      ? `<a class="md-link" href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`
      : label
  })
  // 加粗 **text** / __text__
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong class="md-strong">$1</strong>')
  out = out.replace(/__([^_]+)__/g, '<strong class="md-strong">$1</strong>')
  // 斜体 *text*（避开已处理的 ** 残留）
  out = out.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em class="md-em">$1</em>')
  // 删除线 ~~text~~
  out = out.replace(/~~([^~]+)~~/g, '<del class="md-del">$1</del>')
  // 还原行内代码
  out = out.replace(
    new RegExp(`${INLINE_MARK}(\\d+)${INLINE_MARK}`, 'g'),
    (_m, i) => `<code class="md-inline">${codes[Number(i)]}</code>`
  )
  return out
}

/** 代码块渲染：带语言标签头部 */
function renderCodeBlock(lang: string, code: string): string {
  const langLabel = lang ? `<span class="md-code-lang">${lang}</span>` : ''
  return `<pre class="md-code"><div class="md-code-head">${langLabel}</div><code>${code}</code></pre>`
}

/**
 * 把 Markdown 文本渲染为 HTML 字符串。
 * 处理顺序：转义 → 抽取代码块 → 按行解析块级结构（标题/列表/分隔线/段落）→ 行内格式。
 */
export function renderMarkdown(raw: string): string {
  if (!raw) return ''
  const escaped = escapeHtml(raw)

  // 1) 抽取围栏代码块为占位符，避免内部内容被行级规则误处理
  const blocks: string[] = []
  const noCode = escaped.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
    blocks.push(renderCodeBlock(lang, code.replace(/\n$/, '')))
    return `${BLOCK_MARK}${blocks.length - 1}${BLOCK_MARK}`
  })

  // 2) 按行解析块级结构
  const lines = noCode.split('\n')
  const html: string[] = []
  let listType: 'ul' | 'ol' | null = null
  let para: string[] = []

  const closeList = (): void => {
    if (listType) {
      html.push(`</${listType}>`)
      listType = null
    }
  }
  const flushPara = (): void => {
    if (para.length > 0) {
      html.push(`<p class="md-p">${para.map(renderInline).join('<br>')}</p>`)
      para = []
    }
  }

  // 代码块占位行（整行匹配）
  const blockLineRe = new RegExp(`^${BLOCK_MARK}(\\d+)${BLOCK_MARK}$`)

  for (const line of lines) {
    const trimmed = line.trim()

    // 代码块占位行：原样输出
    const blockMatch = trimmed.match(blockLineRe)
    if (blockMatch) {
      flushPara()
      closeList()
      html.push(blocks[Number(blockMatch[1])])
      continue
    }
    // 空行：结束段落与列表
    if (!trimmed) {
      flushPara()
      closeList()
      continue
    }
    // 标题 # ~ ######
    const head = trimmed.match(/^(#{1,6})\s+(.*)$/)
    if (head) {
      flushPara()
      closeList()
      const level = Math.min(head[1].length, 4)
      html.push(`<h${level} class="md-h md-h${level}">${renderInline(head[2])}</h${level}>`)
      continue
    }
    // 分隔线 --- / *** / ___
    if (/^([-*_])\1{2,}$/.test(trimmed)) {
      flushPara()
      closeList()
      html.push('<hr class="md-hr">')
      continue
    }
    // 无序列表 - / * / +
    const ul = trimmed.match(/^[-*+]\s+(.*)$/)
    if (ul) {
      flushPara()
      if (listType !== 'ul') {
        closeList()
        html.push('<ul class="md-list">')
        listType = 'ul'
      }
      html.push(`<li class="md-li">${renderInline(ul[1])}</li>`)
      continue
    }
    // 有序列表 1. 2. ...
    const ol = trimmed.match(/^\d+[.)]\s+(.*)$/)
    if (ol) {
      flushPara()
      if (listType !== 'ol') {
        closeList()
        html.push('<ol class="md-list">')
        listType = 'ol'
      }
      html.push(`<li class="md-li">${renderInline(ol[1])}</li>`)
      continue
    }
    // 引用 > text（此时 > 已被转义为 &gt;）
    const quote = trimmed.match(/^&gt;\s?(.*)$/)
    if (quote) {
      flushPara()
      closeList()
      html.push(`<blockquote class="md-quote">${renderInline(quote[1])}</blockquote>`)
      continue
    }
    // 普通段落行
    closeList()
    para.push(trimmed)
  }
  flushPara()
  closeList()
  return html.join('')
}
