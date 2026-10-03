// 后台任务纯函数工具（零 IO / 零 electron，可单测）。
import type { ShellProfile } from './shellProbe'

/** 单任务环形输出缓冲；base 为已丢弃字符数（追读偏移基准） */
export interface RingBuffer {
  text: string
  base: number
}

/** 运行时长格式化：秒 / 分秒 / 时分秒 */
export function formatDuration(ms: number): string {
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const totalSec = Math.floor(s)
  const m = Math.floor(totalSec / 60)
  const rest = totalSec % 60
  if (m < 60) return `${m}m${String(rest).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  return `${h}h${String(m % 60).padStart(2, '0')}m`
}

/** 环形追加：超出 maxChars 时丢弃最旧内容（纯函数，返回新对象） */
export function appendRing(ring: RingBuffer, chunk: string, maxChars: number): RingBuffer {
  let text = ring.text + chunk
  let base = ring.base
  if (text.length > maxChars) {
    const drop = text.length - maxChars
    text = text.slice(drop)
    base += drop
  }
  return { text, base }
}

/**
 * 构造后台任务 spawn 规格：
 * - cmd 走 /C（执行完即退），命令作为单个参数，CreateProcess 引号由 Node 处理；
 * - POSIX/fish 统一 -c。
 */
export function buildTaskSpawnSpec(
  profile: ShellProfile,
  command: string
): { command: string; args: string[] } {
  if (profile.kind === 'cmd') {
    return { command: profile.command, args: ['/V:ON', '/Q', '/C', command] }
  }
  return { command: profile.command, args: ['-c', command] }
}

/** 任务 id：时间戳 + 自增序号，避免并发碰撞 */
export function newTaskId(seq: number, now: number): string {
  return `task-${now.toString(36)}-${seq}`
}
