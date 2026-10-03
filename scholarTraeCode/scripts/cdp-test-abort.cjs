// s28–s30 冒烟（2.2 Ollama/HTTP abort + 工具内部打断）：
//   假 OpenAI 兼容服务（进程内 http）替代 Ollama：
//   - 流式 chatStream：SSE 慢速长回复 → stopChat → 验证 <1s 断开、无 onError
//   - 工具 chatWithTools：模型返回 bash 长命令 → 执行中 stopChat → 验证 inFlight 断连、
//     工具结果「已被用户中止」、最终答复含中止标记、任务快照为 aborted
// 用法：先 npm run dev -- --remote-debugging-port=9341，再 node scripts/cdp-test-abort.cjs
const http = require('node:http')

const CDP = 'http://127.0.0.1:9341'
const FAKE_PORT = 19191
const BASH_CMD =
  process.platform === 'win32' ? 'ping -n 60 127.0.0.1' : 'sleep 60'
let addedProviderId = null

// ---------------- 假 OpenAI 兼容服务 ----------------
const state = {
  streamStartedAt: null, // 流式：服务端开始推流时刻（ms）
  streamDisconnectAt: null, // 流式：客户端断开时刻（ms）
  streamChunksWritten: 0, // 流式：服务端成功写出的 chunk 数（诊断）
  toolRequests: 0, // 非流式请求计数（诊断）
  toolCallsIssued: 0, // 返回 tool_calls 的次数（诊断）
  toolDisconnectAt: null // 工具轮：客户端断开时刻（ms）
}

function sseHeaders(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  })
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'fake-model', object: 'model' }] }))
    return
  }
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      let parsed = {}
      try { parsed = JSON.parse(body) } catch { /* 忽略 */ }
      const msgs = parsed.messages || []
      const lastUser = [...msgs].reverse().find((m) => m.role === 'user')?.content || ''
      const hasToolResult = msgs.some((m) => m.role === 'tool')

      if (parsed.stream === true) {
        // 流式长回复：100ms 一个 chunk，永不主动结束
        sseHeaders(res)
        state.streamStartedAt = Date.now()
        res.write('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n')
        const timer = setInterval(() => {
          try {
            res.write('data: {"choices":[{"delta":{"content":"ABORT_SMOKE "}}]}\n\n')
            state.streamChunksWritten++
          } catch { /* 已断开 */ }
        }, 100)
        // 注意必须监听 res 的 close（连接断开）；req 的 close 在请求体读完时即触发，不是断连信号
        res.on('close', () => {
          clearInterval(timer)
          state.streamDisconnectAt = Date.now()
        })
        return
      }

      // 非流式（工具循环用）
      state.toolRequests++
      if (/RUN_LONG_CMD/.test(lastUser) && !hasToolResult) {
        state.toolCallsIssued++
        // 第一轮：发起 bash 长命令
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          choices: [{
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{
                id: 'call_abort_smoke_1',
                type: 'function',
                function: { name: 'bash', arguments: JSON.stringify({ command: BASH_CMD, timeoutMs: 60000 }) }
              }]
            },
            finish_reason: 'tool_calls'
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5 }
        }))
        return
      }
      if (hasToolResult) {
        // 工具轮：挂起直至客户端断开（abort 后 fetch 断开即触发 close）
        const timer = setInterval(() => {
          try { res.write(' ') } catch { /* 已断开 */ }
        }, 500)
        res.on('close', () => {
          clearInterval(timer)
          state.toolDisconnectAt = Date.now()
        })
        return
      }
      // 兜底：短回复
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2 }
      }))
    })
    return
  }
  res.writeHead(404)
  res.end()
})

// ---------------- CDP 工具 ----------------
async function getPageWs() {
  const res = await fetch(`${CDP}/json`)
  const targets = await res.json()
  const page = targets.find((t) => t.type === 'page' && /localhost:\d+/.test(t.url))
  if (!page) throw new Error('未找到渲染页面（dev 未就绪？）')
  return page.webSocketDebuggerUrl
}

function connect(u) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(u)
    let id = 0
    const p = new Map()
    ws.onopen = () =>
      resolve({
        call(m, a = {}) {
          return new Promise((r, j) => {
            const i = ++id
            p.set(i, { r, j })
            ws.send(JSON.stringify({ id: i, method: m, params: a }))
          })
        },
        close: () => ws.close()
      })
    ws.onerror = () => reject(new Error('ws 连接失败'))
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data)
      if (m.id && p.has(m.id)) {
        const { r, j } = p.get(m.id)
        p.delete(m.id)
        m.error ? j(new Error(JSON.stringify(m.error))) : r(m.result)
      }
    }
  })
}

// 在渲染进程执行表达式（awaitPromise），返回 value
async function ev(cdp, expression) {
  const r = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error('页面内执行失败: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  return r.result.value
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`✓ ${name}${detail ? ' — ' + detail : ''}`) }
  else { fail++; console.log(`✗ ${name}${detail ? ' — ' + detail : ''}`) }
}

// ---------------- 主流程 ----------------
async function main() {
  await new Promise((r) => server.listen(FAKE_PORT, '127.0.0.1', r))
  const cdp = await connect(await getPageWs())

  // 0) 清理上次可能残留的同名假 provider，再注册新的（默认启用；model 指定为 custom-N:fake-model）
  const existing = await ev(cdp, `window.api.ai.listProviders()`).catch(() => [])
  for (const p of existing || []) {
    const pname = p?.name || p?.displayName || ''
    if (pname === 'abort-smoke' && String(p?.id || '').startsWith('custom-')) {
      await ev(cdp, `window.api.ai.removeCustomProvider(${JSON.stringify(p.id)})`).catch(() => {})
    }
  }
  const added = await ev(cdp, `window.api.ai.addCustomProvider({ name: 'abort-smoke', baseUrl: 'http://127.0.0.1:${FAKE_PORT}/v1' })`)
  addedProviderId = added?.provider?.id || added?.id
  check('注册假 OpenAI 兼容 provider', !!addedProviderId, `id=${addedProviderId}`)
  const MODEL = `${addedProviderId}:fake-model`

  // ========== 测 A：流式 chatStream 真中断 ==========
  await ev(cdp, `window.__abortChunks = 0; window.__abortErrors = 0;
    window.api.ai.onChatChunk(() => window.__abortChunks++);
    window.api.ai.onChatError(() => window.__abortErrors++);
    'ok'`)

  // 防卡死保护：8s 内未完成则注入脚本侧不等待，直接判失败
  const streamRace = Promise.race([
    ev(cdp, `(async () => {
      const t0 = Date.now();
      const p = window.api.ai.chatStream({ model: ${JSON.stringify(MODEL)}, messages: [{ role: 'user', content: '写一篇很长的文章' }] });
      await new Promise(r => setTimeout(r, 1200));
      await window.api.ai.stopChat();
      await p;
      return { ms: Date.now() - t0, stopAt: Date.now(), chunks: window.__abortChunks, errors: window.__abortErrors };
    })()`),
    sleep(8000).then(() => ({ timeout: true }))
  ])
  const a = await streamRace
  // 断连延迟：以「服务端开始推流」为锚（stop 在推流后 1200ms 发起），减去该固定等待即得近似断连耗时
  const lagMs =
    state.streamDisconnectAt != null && state.streamStartedAt != null
      ? state.streamDisconnectAt - state.streamStartedAt - 1200
      : null
  check('A1 流式生成已收到增量 chunk', !a.timeout && a.chunks > 3, `chunks=${a.chunks}`)
  check('A2 stopChat 后流式请求 <1s 断开', !a.timeout && lagMs !== null && lagMs < 1000,
    lagMs !== null ? `断连约 ${Math.max(lagMs, 0)}ms` : '服务端未观测到断连')
  check('A3 中断未触发 onError（不走错误回退）', !a.timeout && a.errors === 0, `errors=${a.errors}`)
  console.log(`  [诊断] 服务端流式写出 chunk=${state.streamChunksWritten}，页面收到=${a.chunks}`)

  // ========== 测 B：工具执行中中断（bash 长命令）==========
  await ev(cdp, `window.api.ai.setPermissionMode('auto')`)
  await ev(cdp, `window.__toolCalls = []; window.__toolResults = [];
    window.api.ai.onToolCall((p) => window.__toolCalls.push(p.name));
    window.api.ai.onToolResult((p) => window.__toolResults.push({ name: p.name, result: p.result }));
    'ok'`)

  const wsDir = process.cwd().replace(/\\/g, '\\\\')
  const toolRace = Promise.race([
    ev(cdp, `(async () => {
      const t0 = Date.now();
      const p = window.api.ai.chatWithTools({
        model: ${JSON.stringify(MODEL)},
        workspace: '${wsDir}',
        messages: [{ role: 'user', content: 'RUN_LONG_CMD 请执行一个长时间运行的命令' }]
      });
      // 等 bash 工具真正开始执行（git 检查点等前置可能耗时数秒，不能按固定时长估计）；
      // 最多等 25s，若始终未出现 bash 则照常 stopChat（后续断言会反映出来）
      let bashStarted = false;
      for (let i = 0; i < 250; i++) {
        if (window.__toolCalls.includes('bash')) { bashStarted = true; break }
        await new Promise(r => setTimeout(r, 100));
      }
      if (bashStarted) await new Promise(r => setTimeout(r, 300));
      const stopAt = Date.now();
      await window.api.ai.stopChat();
      const ret = await p;
      return { ms: Date.now() - t0, bashStarted, stopAt, ret, toolCalls: window.__toolCalls, toolResults: window.__toolResults };
    })()`),
    sleep(40000).then(() => ({ timeout: true }))
  ])
  const b = await toolRace
  if (!b.timeout) console.log(`  [诊断] toolCalls=${JSON.stringify(b.toolCalls)} 非流式请求=${state.toolRequests} toolCalls下发=${state.toolCallsIssued} bashStarted=${b.bashStarted}`)
  check('B1 工具任务 40s 内完成（未被长命令拖死）', !b.timeout, b.timeout ? '' : `耗时 ${b.ms}ms`)
  const bashResult = b.timeout ? null : b.toolResults.find((t) => t.name === 'bash')
  check('B2 在途 bash 被取消并回填「已被用户中止」', !!bashResult && bashResult.result.includes('已被用户中止'),
    bashResult ? bashResult.result.slice(0, 60).replace(/\n/g, ' ') : '未找到 bash 工具结果')
  // 快速收尾语义：在途工具被中止后不再发起工具轮模型请求（非流式请求数保持 1），直接以 aborted 落账
  check('B3 中止后快速收尾（未发起工具轮模型请求）', state.toolRequests === 1, `非流式请求=${state.toolRequests}`)
  const finalContent = b.timeout ? '' : (b.ret?.content ?? '')
  check('B4 最终答复含中止标记', finalContent.includes('已被用户中止') || finalContent.includes('任务已被用户中止'),
    finalContent.slice(0, 60).replace(/\n/g, ' '))

  // B5 任务快照为 aborted：aborted 按设计不进「可恢复列表」（classifyRecoverable 只收
  // running/paused/interrupted），故直接读 .trae/tasks/*.json 落盘文件断言。
  // persist 是 fire-and-forget 异步落盘，先稍等再读。
  await sleep(800)
  const fs = require('node:fs')
  const path = require('node:path')
  const tasksDir = path.join(process.cwd(), '.trae', 'tasks')
  let abortedSnap = null
  try {
    const files = fs.readdirSync(tasksDir).filter((f) => f.endsWith('.json'))
    for (const f of files) {
      try {
        const snap = JSON.parse(fs.readFileSync(path.join(tasksDir, f), 'utf-8'))
        if (snap.status === 'aborted' && /RUN_LONG_CMD/.test(snap.userRequest || '')) {
          if (!abortedSnap || snap.updatedAt > abortedSnap.updatedAt) abortedSnap = snap
        }
      } catch { /* 跳过坏文件 */ }
    }
  } catch { /* 目录不存在 */ }
  check('B5 任务快照落盘为 aborted', !!abortedSnap, abortedSnap ? `taskId=${abortedSnap.taskId}` : '未找到 aborted 快照')
  // 清理本次冒烟产生的 aborted 快照（避免污染用户任务列表）
  if (abortedSnap) {
    try { fs.unlinkSync(path.join(tasksDir, `${abortedSnap.taskId}.json`)) } catch { /* 忽略 */ }
  }

  // 收尾：权限模式还原 ask、移除假 provider
  await ev(cdp, `window.api.ai.setPermissionMode('ask')`)
  if (addedProviderId) await ev(cdp, `window.api.ai.removeCustomProvider(${JSON.stringify(addedProviderId)})`)

  cdp.close()
  server.close()
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch(async (e) => {
  console.error('冒烟失败:', e.message)
  if (addedProviderId) {
    try {
      const cdp = await connect(await getPageWs())
      await ev(cdp, `window.api.ai.setPermissionMode('ask'); window.api.ai.removeCustomProvider(${JSON.stringify(addedProviderId)})`)
      cdp.close()
    } catch { /* 尽力清理 */ }
  }
  server.close()
  process.exit(1)
})
