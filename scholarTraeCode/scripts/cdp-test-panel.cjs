// 验证终端面板 DOM 挂载情况
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
  const r = await cdp.call('Runtime.evaluate', {
    expression: `JSON.stringify({
      panel: !!document.querySelector('.terminal-panel'),
      lines: document.querySelectorAll('.term-line').length,
      input: !!document.querySelector('.term-input'),
      btns: [...document.querySelectorAll('.term-btn')].map(b => b.textContent),
      cwd: document.querySelector('.term-cwd')?.textContent || ''
    })`,
    returnByValue: true
  })
  console.log(r.result.value || JSON.stringify(r.exceptionDetails))
  cdp.close()
}

main().catch((e) => {
  console.error('失败:', e.message)
  process.exit(1)
})
