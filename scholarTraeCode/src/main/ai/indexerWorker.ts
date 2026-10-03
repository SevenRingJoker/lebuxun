// s51 索引 worker：把 ensureIndex 的耗时扫描/解析移出主进程主线程，
// 避免大项目索引构建阻塞主进程事件循环。
//
// 消息协议（父→子）：{ type: 'ensureIndex', root, opts: { force? } }
// 消息协议（子→父）：{ type: 'result', index, delta } 或 { type: 'error', message }
//
// 注意：worker 内不复用主线程的内存缓存（worker 有独立 V8 堆），
// 索引结果通过结构化克隆传回父进程，由父进程负责落盘与缓存。
import { parentPort } from 'node:worker_threads'
import { ensureIndex, type CodeIndex, type IndexDelta } from './indexer'

if (!parentPort) {
  throw new Error('indexerWorker 必须作为 worker_threads.Worker 运行')
}

parentPort.on('message', async (msg: { type: string; root: string; opts?: { force?: boolean } }) => {
  if (msg.type !== 'ensureIndex' || !msg.root) {
    parentPort!.postMessage({ type: 'error', message: '未知消息或缺少 root' })
    return
  }
  try {
    const { index, delta } = await ensureIndex(msg.root, msg.opts ?? {})
    parentPort!.postMessage({ type: 'result', index, delta })
  } catch (err) {
    parentPort!.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
})

export type { CodeIndex, IndexDelta }
