// 快捷键与命令面板纯函数层（零 electron / 零 DOM 依赖）
// 供渲染端命令注册表与全局分发器使用；单测在 node 环境直接运行

/** 一次按键组合的结构化表示（修饰键 + 主键） */
export interface KeyStroke {
  ctrl: boolean
  shift: boolean
  alt: boolean
  meta: boolean
  /** 规范化后的主键：单字符小写，其余用 KeyboardEvent.key 原值（如 F1/Enter/Escape） */
  key: string
}

/** 命令定义（注册表静态部分；执行体由渲染端注入） */
export interface CommandDef {
  id: string
  title: string
  group: string
  /** 默认按键串（如 'Ctrl+Shift+P'），缺省表示无默认绑定 */
  defaultKey?: string
}

const MODIFIER_WORDS: Record<string, 'ctrl' | 'shift' | 'alt' | 'meta'> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  shift: 'shift',
  alt: 'alt',
  option: 'alt',
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
  win: 'meta'
}

/** 规范化主键：单字符小写，其余保留原值（首字母大写形式，如 Enter/F5） */
function normalizeKey(raw: string): string {
  if (raw.length === 1) return raw.toLowerCase()
  return raw.charAt(0).toUpperCase() + raw.slice(1)
}

/**
 * 解析按键串为 KeyStroke，如 'Ctrl+Shift+P' → { ctrl:true, shift:true, key:'p' }
 * 非法输入（无主键 / 多个主键 / 未知修饰词 / 空段）返回 null
 */
export function parseAccelerator(text: string): KeyStroke | null {
  if (!text || typeof text !== 'string') return null
  const parts = text.split('+').map((p) => p.trim()).filter(Boolean)
  if (parts.length === 0) return null

  const stroke: KeyStroke = { ctrl: false, shift: false, alt: false, meta: false, key: '' }
  for (const part of parts) {
    const mod = MODIFIER_WORDS[part.toLowerCase()]
    if (mod) {
      stroke[mod] = true
      continue
    }
    // 非修饰词段作为主键：只允许一个
    if (stroke.key) return null
    stroke.key = normalizeKey(part)
  }
  return stroke.key ? stroke : null
}

/** 格式化为规范化显示串（与 parseAccelerator 往返一致），如 'Ctrl+Shift+P' */
export function formatAccelerator(s: KeyStroke): string {
  const parts: string[] = []
  if (s.ctrl) parts.push('Ctrl')
  if (s.shift) parts.push('Shift')
  if (s.alt) parts.push('Alt')
  if (s.meta) parts.push('Meta')
  parts.push(s.key.length === 1 ? s.key.toUpperCase() : s.key)
  return parts.join('+')
}

/** 结构化键盘事件接口（不依赖 DOM 类型，单测可直接构造） */
export interface KeyEventLike {
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
  key: string
}

/**
 * 事件是否命中按键组合：shift/alt 严格相等，主键大小写不敏感。
 * 跨平台：Ctrl 与 Cmd(Meta) 视为可互换的「主修饰键」——
 * - stroke 只指定 ctrl 或 meta 之一：事件侧 ctrlKey/metaKey 任一为真即命中
 *   （让 Ctrl+Shift+P 在 macOS 上匹配 Cmd+Shift+P，Windows 上匹配 Ctrl+Shift+P）
 * - stroke 同时指定 ctrl 与 meta：事件侧两者皆须为真
 * - stroke 均未指定：事件侧两者皆须为假
 */
export function matchKeyEvent(e: KeyEventLike, s: KeyStroke): boolean {
  if (!s.key) return false
  const primaryWanted = s.ctrl || s.meta
  const primaryBoth = s.ctrl && s.meta
  const primaryEvent = e.ctrlKey || e.metaKey
  let primaryMatch: boolean
  if (primaryBoth) {
    primaryMatch = e.ctrlKey && e.metaKey
  } else if (primaryWanted) {
    // 只要 ctrl/meta 任一为真即可（兼容 mac Cmd / win Ctrl 互换）
    primaryMatch = primaryEvent
  } else {
    primaryMatch = !primaryEvent
  }
  if (!primaryMatch || e.shiftKey !== s.shift || e.altKey !== s.alt) {
    return false
  }
  return normalizeKey(e.key) === s.key
}

/**
 * 模糊匹配打分：query 须为 text 的子序列（大小写不敏感），否则返回 null。
 * 连续命中每段 +8 起步并随长度递增，词首（串首/空格/连字符/冒号后）命中 +6，基础每字符 +1。
 * 分数越高匹配越好。
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase()
  if (!q) return 0
  const t = text.toLowerCase()

  let score = 0
  let ti = 0
  let runLength = 0 // 当前连续命中段长度
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi]
    const found = t.indexOf(ch, ti)
    if (found === -1) return null
    if (found === ti && runLength > 0) {
      // 延续连续段：递增奖励
      runLength++
      score += 8 + runLength
    } else {
      runLength = 1
      score += 1
      // 词首命中奖励
      if (found === 0 || /[\s\-_:：/]/.test(t[found - 1])) score += 6
    }
    ti = found + 1
  }
  // 短文本略加权，避免长标题天然劣势被放大
  return score - t.length * 0.01
}

/** 模糊搜索命令：按打分降序，同分按标题稳定排序；空查询返回原顺序 */
export function searchCommands<T extends { title: string; group?: string }>(
  query: string,
  commands: T[]
): T[] {
  const q = query.trim()
  if (!q) return [...commands]
  const scored: { cmd: T; score: number; index: number }[] = []
  commands.forEach((cmd, index) => {
    // 分组名也参与匹配（如「设置」可命中设置组全部命令）
    const titleScore = fuzzyScore(q, cmd.title)
    const groupScore = cmd.group ? fuzzyScore(q, cmd.group) : null
    const score = Math.max(titleScore ?? -Infinity, groupScore ?? -Infinity)
    if (score > -Infinity) scored.push({ cmd, score, index })
  })
  scored.sort((a, b) => b.score - a.score || a.index - b.index)
  return scored.map((s) => s.cmd)
}

/**
 * 检测按键冲突：同一按键串绑定到多个命令时返回冲突清单。
 * keymap 为「命令 id → 按键串」，空串视为解绑跳过。
 */
export function detectConflict(keymap: Record<string, string>): { key: string; commandIds: string[] }[] {
  const byKey = new Map<string, string[]>()
  for (const [id, accel] of Object.entries(keymap)) {
    if (!accel) continue
    const stroke = parseAccelerator(accel)
    if (!stroke) continue
    const norm = formatAccelerator(stroke)
    const list = byKey.get(norm) ?? []
    list.push(id)
    byKey.set(norm, list)
  }
  return [...byKey.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([key, commandIds]) => ({ key, commandIds }))
}

/**
 * 合并默认与用户 keymap：用户覆盖优先；值为空串表示显式解绑（覆盖默认键）。
 * 返回「命令 id → 按键串」的生效映射（含解绑后的空串项，便于 UI 展示「未绑定」）。
 */
export function mergeKeymap(
  commands: CommandDef[],
  userOverrides: Record<string, string>
): Record<string, string> {
  const merged: Record<string, string> = {}
  for (const cmd of commands) {
    merged[cmd.id] = cmd.defaultKey ?? ''
  }
  for (const [id, key] of Object.entries(userOverrides)) {
    if (id in merged) merged[id] = key
  }
  return merged
}
