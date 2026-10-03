// 验证终端 MCP 工具已注册并可用：列出工具 + 实跑一条命令
const CDP = 'http://127.0.0.1:9341'

async function getPageWs() {
  const res = await fetch(`${CDP}/json`)
  const targets = await res.json()
  const page = targets.find((t) => t.type === 'page' && /localhost:\d+/.test(t.url))
  if (!page) throw new Error('未找到渲染进程页面')
  return page.webSocketDebuggerUrl
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let id = 0
    const pending = new Map()
    ws.onopen = () =>
      resolve({
        call(method, params = {}) {
          return new Promise((res2, rej2) => {
            const mid = ++id
            pending.set(mid, { res2, rej2 })
            ws.send(JSON.stringify({ id: mid, method, params }))
          })
        },
        close: () => ws.close()
      })
    ws.onerror = () => reject(new Error('ws error'))
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && pending.has(msg.id)) {
        const { res2, rej2 } = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) rej2(new Error(JSON.stringify(msg.error)))
        else res2(msg.result)
      }
    }
  })
}

const main = async () => {
  const cdp = await connect(await getPageWs())
  // 1) 列出所有工具
  const list = await cdp.call('Runtime.evaluate', {
    expression:
      "window.api.mcp.listTools().then(l => l.map(s => s.server + ': ' + (s.tools||[]).map(t=>t.name).join(', ')).join('\\n'))",
    awaitPromise: true,
    returnByValue: true
  })
  console.log('=== 已注册工具 ===\n' + (list.result.value || JSON.stringify(list.exceptionDetails)))

  // 2) 实跑终端命令验证可用性
  const run = await cdp.call('Runtime.evaluate', {
    expression:
      "window.api.mcp.callTool('terminal', 'run_terminal_command', { command: 'node -v && npm -v' }).then(r => JSON.stringify(r.result?.content || r))",
    awaitPromise: true,
    returnByValue: true
  })
  console.log('=== run_terminal_command: node -v && npm -v ===\n' + (run.result.value || JSON.stringify(run.exceptionDetails)))
  cdp.close()
}

main().catch((e) => {
  console.error('失败:', e.message)
  process.exit(1)
})
