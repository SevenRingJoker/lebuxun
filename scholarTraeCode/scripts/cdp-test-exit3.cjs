// 单发复现：start 后等 1.5s，只跑 cmd /c exit 3，监听全部 event
const CDP = 'http://127.0.0.1:9341'
async function getPageWs() {
  const res = await fetch(`${CDP}/json`)
  return (await res.json()).find((t) => t.type === 'page' && /localhost:\d+/.test(t.url)).webSocketDebuggerUrl
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
    ws.onerror = () => reject(new Error('ws'))
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
const main = async () => {
  const cdp = await connect(await getPageWs())
  await cdp.call('Runtime.evaluate', {
    expression: `(window.__evs = [] , window.api.terminal.onEvent(e => window.__evs.push(JSON.stringify(e))), undefined)`,
    returnByValue: true
  })
  await cdp.call('Runtime.evaluate', { expression: "window.api.terminal.start('D:\\\\编辑器测试项目')", awaitPromise: true })
  await new Promise((r) => setTimeout(r, 1500))
  const t0 = Date.now()
  const r = await cdp.call('Runtime.evaluate', {
    expression: `window.api.terminal.run('cmd /c exit 3').then(r => JSON.stringify(r))`,
    awaitPromise: true,
    returnByValue: true
  })
  console.log('耗时(ms):', Date.now() - t0)
  console.log('结果:', r.result.value)
  const evs = await cdp.call('Runtime.evaluate', { expression: 'JSON.stringify(window.__evs)', returnByValue: true })
  console.log('事件流:\n' + (JSON.parse(evs.result.value) || []).join('\n'))
  cdp.close()
}
main().catch((e) => {
  console.error('失败:', e.message)
  process.exit(1)
})
