// 单发 cwd 切换，抓完整事件流看原始 chunk
const CDP = 'http://127.0.0.1:9341'
async function getPageWs() {
  const res = await fetch(`${CDP}/json`)
  return (await res.json()).find((t) => t.type === 'page' && /localhost:\d+/.test(t.url)).webSocketDebuggerUrl
}
function connect(u) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(u)
    let id = 0
    const pending = new Map()
    ws.onopen = () =>
      resolve({
        call(m, a = {}) {
          return new Promise((r, j) => {
            const i = ++id
            pending.set(i, { r, j })
            ws.send(JSON.stringify({ id: i, method: m, params: a }))
          })
        },
        close: () => ws.close()
      })
    ws.onerror = () => reject(new Error('ws'))
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
const main = async () => {
  const cdp = await connect(await getPageWs())
  await cdp.call('Runtime.evaluate', {
    expression: `(window.__evs=[] , window.api.terminal.onEvent(e=>window.__evs.push(e)), undefined)`
  })
  await cdp.call('Runtime.evaluate', { expression: "window.api.terminal.start('D:\\\\编辑器测试项目')", awaitPromise: true })
  await new Promise((r) => setTimeout(r, 1200))
  const r = await cdp.call('Runtime.evaluate', {
    expression: `window.api.terminal.run('cd', 'D:\\\\编辑器测试项目\\\\34').then(r=>JSON.stringify(r))`,
    awaitPromise: true,
    returnByValue: true
  })
  console.log('结果:', r.result.value)
  const evs = await cdp.call('Runtime.evaluate', { expression: 'JSON.stringify(window.__evs)', returnByValue: true })
  for (const e of JSON.parse(evs.result.value)) console.log(JSON.stringify(e))
  cdp.close()
}
main().catch((e) => { console.error('失败:', e.message); process.exit(1) })
