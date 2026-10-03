// 最小复现：通过 CDP 直接调用 MCP filesystem 工具，定位 EPERM 根因
const CDP = 'http://127.0.0.1:9341'

async function getPageWs() {
  const res = await fetch(`${CDP}/json`)
  const targets = await res.json()
  const page = targets.find((t) => t.type === 'page' && t.url.includes('localhost:5173'))
  if (!page) throw new Error('未找到渲染进程页面')
  return page.webSocketDebuggerUrl
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let id = 0
    const pending = new Map()
    ws.onopen = () => resolve({
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

async function evaluate(cdp, expr, awaitPromise = false) {
  const r = await cdp.call('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true })
  if (r.exceptionDetails) throw new Error('页面内异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  return r.result?.value
}

const main = async () => {
  const cdp = await connect(await getPageWs())

  // 1) 当前 MCP 工具清单
  const tools = await evaluate(cdp, `window.api.mcp.listTools().then(r => r.map(s => s.server + ': ' + s.tools.map(t => t.name).join(',')).join('\\n'))`, true)
  console.log('[tools]\n' + tools)

  // 2) 直接调用 list_allowed_directories（如果 server 提供）
  const allowed = await evaluate(cdp, `window.api.mcp.callTool('filesystem', 'list_allowed_directories', {})`, true)
  console.log('[allowed]', JSON.stringify(allowed))

  // 3) 最小化 mkdir 复现
  const mkdir = await evaluate(cdp, `window.api.mcp.callTool('filesystem', 'create_directory', { path: 'D:\\\\编辑器测试项目\\\\cdp-probe' })`, true)
  console.log('[mkdir]', JSON.stringify(mkdir))

  // 4) 对照：在应用目录下 mkdir
  const mkdir2 = await evaluate(cdp, `window.api.mcp.callTool('filesystem', 'create_directory', { path: 'D:\\\\47.104.20.186\\\\aiProject\\\\scholarTreaCode\\\\cdp-probe' })`, true)
  console.log('[mkdir app dir]', JSON.stringify(mkdir2))

  cdp.close()
}

main().catch((e) => { console.error('失败:', e.message); process.exit(1) })
