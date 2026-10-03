// 验证终端会话：用户命令 + AI MCP 工具命令走同一持久 shell，输出实时可订阅
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
    const listeners = []
    ws.onopen = () =>
      resolve({
        call(method, params = {}) {
          return new Promise((res2, rej2) => {
            const mid = ++id
            pending.set(mid, { res2, rej2 })
            ws.send(JSON.stringify({ id: mid, method, params }))
          })
        },
        on(evt, cb) {
          listeners.push([evt, cb])
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
      if (msg.method === 'Runtime.bindingCalled') {
        for (const [evt, cb] of listeners) {
          if (evt === msg.params.name) cb(JSON.parse(msg.params.payload))
        }
      }
    }
  })
}

const main = async () => {
  const cdp = await connect(await getPageWs())

  // 收集终端事件到 window.__termEvents
  await cdp.call('Runtime.evaluate', {
    expression: `
      window.__termEvents = [];
      window.api.terminal.onEvent(ev => {
        window.__termEvents.push(ev.kind + (ev.kind === 'cmd' ? ':' + ev.source : ''));
      });
      true;`
  })

  // 1) 用户命令：cd 后看持久 cwd 是否生效
  const r1 = await cdp.call('Runtime.evaluate', {
    expression: "window.api.terminal.run('echo USER_CMD_OK').then(r => JSON.stringify(r))",
    awaitPromise: true,
    returnByValue: true
  })
  console.log('1) 用户命令结果:', r1.result.value)

  // 2) AI 工具命令（同一 shell）
  const r2 = await cdp.call('Runtime.evaluate', {
    expression:
      "window.api.mcp.callTool('terminal', 'run_terminal_command', { command: 'echo AI_CMD_OK' }).then(r => JSON.stringify(r.result?.content || r))",
    awaitPromise: true,
    returnByValue: true
  })
  console.log('2) AI 工具结果:', r2.result.value)

  // 3) 事件序列
  await new Promise((r) => setTimeout(r, 800))
  const r3 = await cdp.call('Runtime.evaluate', {
    expression: 'JSON.stringify(window.__termEvents)',
    returnByValue: true
  })
  console.log('3) 终端事件序列:', r3.result.value)

  cdp.close()
}

main().catch((e) => {
  console.error('失败:', e.message)
  process.exit(1)
})
