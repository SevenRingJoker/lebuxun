// s50 多 Agent 并行编排——文件写锁管理器（进程内互斥量）：
// 冲突文件写前取锁，同一文件同一时刻只允许一个 owner（角色 Agent/任务）写入；
// FIFO 等待队列 + 超时 + 同 owner 可重入，避免并行 Agent 互相覆盖。
// 纯内存、无 IO，便于确定性单测（用假定时器）。
import path from 'path'

/** 取锁超时：等待超过此时长仍未拿到则拒绝 */
export const DEFAULT_LOCK_TIMEOUT_MS = 15_000

/** 锁等待超时错误 */
export class FileLockTimeoutError extends Error {
  constructor(p: string, owner: string) {
    super(`取锁超时：${p}（等待方 ${owner}）`)
    this.name = 'FileLockTimeoutError'
  }
}

/** 释放非自己持有的锁 */
export class FileLockOwnerError extends Error {
  constructor(p: string) {
    super(`锁不属于当前 owner，不能释放：${p}`)
    this.name = 'FileLockOwnerError'
  }
}

interface Waiter {
  owner: string
  resolve: () => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout> | null
}

interface Entry {
  /** 当前持有者；null 表示空闲（仍有 waiter 时条目保留） */
  owner: string | null
  /** 重入计数 */
  depth: number
  waiters: Waiter[]
}

/** 归一化键：绝对路径 + 平台大小写归一（Windows 卷标大小写不敏感） */
function normKey(p: string): string {
  const abs = path.resolve(p)
  return process.platform === 'win32' ? abs.toLowerCase() : abs
}

export class FileLockTable {
  private entries = new Map<string, Entry>()

  /** 是否被持有（可指定 owner 查询是否为其持有） */
  isLocked(p: string, owner?: string): boolean {
    const e = this.entries.get(normKey(p))
    if (!e || e.owner === null) return false
    return owner === undefined ? true : e.owner === owner
  }

  /** 非阻塞尝试取锁：成功 true，已被他人持有 false */
  tryAcquire(p: string, owner: string): boolean {
    const key = normKey(p)
    let e = this.entries.get(key)
    if (!e) {
      e = { owner: null, depth: 0, waiters: [] }
      this.entries.set(key, e)
    }
    if (e.owner === null) {
      e.owner = owner
      e.depth = 1
      return true
    }
    if (e.owner === owner) {
      e.depth++
      return true
    }
    return false
  }

  /**
   * 取锁（可等待）：他人持有时进入 FIFO 队列；超时即从队列移除并 reject。
   * 同一 owner 重入立即成功（计数）。
   */
  acquire(p: string, owner: string, timeoutMs: number = DEFAULT_LOCK_TIMEOUT_MS): Promise<void> {
    if (this.tryAcquire(p, owner)) return Promise.resolve()
    const key = normKey(p)
    return new Promise<void>((resolve, reject) => {
      const entry = this.entries.get(key)!
      const waiter: Waiter = {
        owner,
        resolve,
        reject,
        timer: setTimeout(() => {
          // 超时：摘除自己，拒绝等待
          const idx = entry.waiters.indexOf(waiter)
          if (idx >= 0) entry.waiters.splice(idx, 1)
          reject(new FileLockTimeoutError(p, owner))
        }, timeoutMs)
      }
      entry.waiters.push(waiter)
    })
  }

  /**
   * 释放锁：仅持有者可释放；重入计数归零后交给 FIFO 队首，
   * 无等待者则清空条目。错误释放抛 FileLockOwnerError。
   */
  release(p: string, owner: string): void {
    const key = normKey(p)
    const e = this.entries.get(key)
    if (!e || e.owner !== owner) throw new FileLockOwnerError(p)
    e.depth--
    if (e.depth > 0) return
    // 交给队首
    const next = e.waiters.shift()
    if (next) {
      if (next.timer) clearTimeout(next.timer)
      e.owner = next.owner
      e.depth = 1
      next.resolve()
    } else {
      this.entries.delete(key)
    }
  }

  /** withLock 包装：取锁 → 执行 → 释放（异常也释放） */
  async withLock<T>(p: string, owner: string, fn: () => Promise<T>, timeoutMs?: number): Promise<T> {
    await this.acquire(p, owner, timeoutMs)
    try {
      return await fn()
    } finally {
      // fn 内部若已自行释放，忽略二次释放错误
      if (this.isLocked(p, owner)) this.release(p, owner)
    }
  }

  /** 列出某 owner 当前持有的全部路径（调试/中止后清理用） */
  heldBy(owner: string): string[] {
    const out: string[] = []
    for (const [key, e] of this.entries) {
      if (e.owner === owner) out.push(key)
    }
    return out
  }
}

/** 全局单例：主任务与全部子代理共用一张锁表 */
let globalTable: FileLockTable | null = null
export function getGlobalFileLockTable(): FileLockTable {
  if (!globalTable) globalTable = new FileLockTable()
  return globalTable
}

/** 测试/重启环境用：重置全局表 */
export function resetGlobalFileLockTable(): void {
  globalTable = null
}
