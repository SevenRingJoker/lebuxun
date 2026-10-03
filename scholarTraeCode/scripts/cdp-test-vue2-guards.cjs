// CDP E2E：验证五大护栏（targetDir 限定 / npm init 空壳封杀 / 阶段门控 / 秒退熔断 / 防抖）
// 连接 Electron 窗口（remoteDebuggingPort 9341），驱动 window.api.ai.chatWithTools
const fs = require('fs')
const path = require('path')

const CDP = 'http://127.0.0.1:9341'
const WORKSPACE = 'D:\\编辑器测试项目'

async function getPageWs() {
  const res = await fetch(`${CDP}/json`)
  const targets = await res.json()
  const page = targets.find((t) => t.type === 'page' && /localhost:\d+/.test(t.url))
  if (!page) throw new Error('No page target found')
  return page.webSocketDebuggerUrl
}

function connect(u) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(u)
    let id = 0
    const pending = new Map()
    ws.onopen = () =>
      resolve({
        call(method, params = {}) {
          return new Promise((r, j) => {
            const i = ++id
            pending.set(i, { r, j })
            ws.send(JSON.stringify({ id: i, method, params }))
          })
        },
        close: () => ws.close()
      })
    ws.onerror = () => reject(new Error('WebSocket connect failed'))
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data)
      if (m.id && pending.has(m.id)) {
        const { r, j } = pending.get(m.id)
        pending.delete(m.id)
        m.error ? j(new Error(JSON.stringify(m.error))) : r(m.result)
      }
    }
  })
}

const setupScript = `
window.__t = { calls: [], results: [], done: false, error: null, content: null, t0: Date.now() }
window.api.ai.onToolCall((p) => {
  window.__t.calls.push({ t: Date.now() - window.__t.t0, name: p.name, args: JSON.stringify(p.args).slice(0, 300) })
})
window.api.ai.onToolResult((p) => {
  window.__t.results.push({ t: Date.now() - window.__t.t0, name: p.name, result: (p.result || '').slice(0, 300) })
})
window.api.ai.chatWithTools({
  messages: [{ role: 'user', content: '在当前工作区创建一个 vue2 项目并运行起来' }],
  workspace: '${WORKSPACE.replace(/\\/g, '\\\\')}',
  useTools: true
}).then((res) => {
  window.__t.done = true
  window.__t.content = res.content
  window.__t.error = res.error
}).catch((err) => {
  window.__t.done = true
  window.__t.error = err.message
})
'STARTED'
`

const pollScript = `JSON.stringify({
  done: window.__t.done,
  error: window.__t.error,
  contentTail: (window.__t.content || '').slice(-800),
  calls: window.__t.calls,
  results: window.__t.results
})`

const main = async () => {
  const cdp = await connect(await getPageWs())
  await cdp.call('Runtime.enable')
  const r = await cdp.call('Runtime.evaluate', { expression: setupScript, returnByValue: true })
  console.log('Setup:', r.result?.value)

  const maxWait = 600000 // 10 min
  const interval = 10000
  let lastCount = -1
  let finalState = null
  for (let i = 1; i <= maxWait / interval; i++) {
    await new Promise((r2) => setTimeout(r2, interval))
    const pr = await cdp.call('Runtime.evaluate', { expression: pollScript, returnByValue: true })
    const state = JSON.parse(pr.result.value)
    if (state.calls.length !== lastCount) {
      lastCount = state.calls.length
      console.log(`[${(i * interval) / 1000}s] toolCalls=${state.calls.length} results=${state.results.length} done=${state.done}`)
    }
    if (state.done) { finalState = state; break }
    if (i === maxWait / interval) finalState = state
  }

  console.log('\n=== TOOL CALL TIMELINE ===')
  for (const c of finalState.calls) console.log(`  [${(c.t / 1000).toFixed(1)}s] CALL ${c.name} ${c.args}`)
  console.log('\n=== TOOL RESULTS (拦截/熔断标记重点关注) ===')
  for (const rs of finalState.results) console.log(`  [${(rs.t / 1000).toFixed(1)}s] RESULT ${rs.name} :: ${rs.result.replace(/\n/g, ' | ')}`)
  console.log('\n=== DONE ===')
  console.log('error:', finalState.error || 'none')
  console.log('content tail:', finalState.contentTail || '(empty)')

  cdp.close()

  // 文件系统终态检查
  console.log('\n=== FILESYSTEM FINAL STATE ===')
  const walk = (dir, base = '') => {
    const out = []
    if (!fs.existsSync(dir)) return out
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const rel = base ? base + '/' + entry.name : entry.name
      if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel))
      else out.push(rel + ' (' + fs.statSync(path.join(dir, entry.name)).size + 'B)')
    }
    return out
  }
  for (const f of walk(WORKSPACE)) console.log('  ' + f)
}

main().catch((e) => {
  console.error('Test failed:', e.message)
  process.exit(1)
})
