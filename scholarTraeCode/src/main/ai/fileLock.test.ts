// s50 文件锁单测：互斥/FIFO/重入/超时/异常释放/路径归一/单例
import { afterEach, describe, expect, it, vi } from 'vitest'
import path from 'path'
import {
  FileLockOwnerError,
  FileLockTable,
  FileLockTimeoutError,
  getGlobalFileLockTable,
  resetGlobalFileLockTable
} from './fileLock'

afterEach(() => {
  vi.useRealTimers()
})

describe('s50 文件锁互斥', () => {
  it('tryAcquire：同文件互斥，不同文件不串扰', () => {
    const t = new FileLockTable()
    expect(t.tryAcquire('a.ts', 'agent-前端')).toBe(true)
    expect(t.tryAcquire('a.ts', 'agent-后端')).toBe(false)
    expect(t.tryAcquire('b.ts', 'agent-后端')).toBe(true)
    expect(t.isLocked('a.ts')).toBe(true)
    expect(t.isLocked('c.ts')).toBe(false)
  })

  it('同 owner 可重入，释放需配对', () => {
    const t = new FileLockTable()
    expect(t.tryAcquire('a.ts', 'A')).toBe(true)
    expect(t.tryAcquire('a.ts', 'A')).toBe(true)
    t.release('a.ts', 'A')
    // 仍持有（计数 1）
    expect(t.isLocked('a.ts')).toBe(true)
    t.release('a.ts', 'A')
    expect(t.isLocked('a.ts')).toBe(false)
  })

  it('等待者在释放后按 FIFO 获得锁', async () => {
    const t = new FileLockTable()
    t.tryAcquire('a.ts', 'A')
    const bDone = vi.fn()
    const pB = t.acquire('a.ts', 'B').then(bDone)
    const pC = t.acquire('a.ts', 'C').then(() => undefined)
    // 等待中 B 未拿到
    expect(bDone).not.toHaveBeenCalled()
    t.release('a.ts', 'A')
    await pB
    expect(bDone).toHaveBeenCalledOnce()
    expect(t.isLocked('a.ts', 'B')).toBe(true)
    // B 释放后 C 拿到
    t.release('a.ts', 'B')
    await pC
    expect(t.isLocked('a.ts', 'C')).toBe(true)
  })

  it('超时未拿到锁 → FileLockTimeoutError', async () => {
    vi.useFakeTimers()
    const t = new FileLockTable()
    t.tryAcquire('a.ts', 'A')
    let err: unknown = null
    const p = t.acquire('a.ts', 'B', 100).catch((e) => { err = e })
    await vi.advanceTimersByTimeAsync(150)
    expect(err).toBeInstanceOf(FileLockTimeoutError)
    // 超时者已从队列摘除：A 释放后没有等待者，锁直接清空
    t.release('a.ts', 'A')
    expect(t.isLocked('a.ts')).toBe(false)
    await p
  })

  it('非持有者释放抛 FileLockOwnerError', () => {
    const t = new FileLockTable()
    t.tryAcquire('a.ts', 'A')
    expect(() => t.release('a.ts', 'B')).toThrow(FileLockOwnerError)
    expect(() => t.release('never.ts', 'A')).toThrow(FileLockOwnerError)
  })

  it('withLock：正常执行后释放', async () => {
    const t = new FileLockTable()
    const r = await t.withLock('a.ts', 'A', async () => 42)
    expect(r).toBe(42)
    expect(t.isLocked('a.ts')).toBe(false)
  })

  it('withLock：fn 抛错也释放锁', async () => {
    const t = new FileLockTable()
    await expect(
      t.withLock('a.ts', 'A', async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(t.isLocked('a.ts')).toBe(false)
  })

  it('路径归一：相对路径与绝对路径/大小写视为同一把锁', () => {
    const t = new FileLockTable()
    const abs = path.resolve('x.ts')
    expect(t.tryAcquire('./x.ts', 'A')).toBe(true)
    expect(t.tryAcquire(abs, 'B')).toBe(false)
    if (process.platform === 'win32') {
      expect(t.tryAcquire('X.TS', 'B')).toBe(false)
    }
  })

  it('heldBy 列出持有者全部锁', () => {
    const t = new FileLockTable()
    t.tryAcquire('a.ts', 'A')
    t.tryAcquire('b.ts', 'A')
    t.tryAcquire('c.ts', 'B')
    expect(t.heldBy('A')).toHaveLength(2)
    expect(t.heldBy('B')).toHaveLength(1)
  })

  it('全局表单例可重置', () => {
    const g1 = getGlobalFileLockTable()
    const g2 = getGlobalFileLockTable()
    expect(g1).toBe(g2)
    resetGlobalFileLockTable()
    const g3 = getGlobalFileLockTable()
    expect(g3).not.toBe(g1)
  })
})
