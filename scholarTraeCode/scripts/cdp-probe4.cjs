// CDP 探针 4：主进程 mkdir 三组对照（中文目录A / 英文目录 / 中文目录B）
const CDP = 'http://127.0.0.1:9341'
async function getPageWs() {
  const res = await fetch(`${CDP}/json`)
  const page = (await res.json()).find((t) => t.type === 'page' && t.url.includes('localhost:5173'))
  return page.webSocketDebuggerUrl
}
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let id = 0
    const pending = new Map()
    ws.onopen = () => resolve({
      call: (method, params = {}) => new Promise((res2, rej2) => {
        const mid = ++id
        pending.set(mid, { res2, rej2 })
        ws.send(JSON.stringify({ id: mid, method, params }))
      }),
      close: () => ws.close()
    })
    ws.onerror = () => reject(new Error('ws error'))
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && pending.has(msg.id)) {
        const { res2, rej2 } = pending.get(msg.id)
        pending.delete(msg.id)
        msg.error ? rej2(new Error(JSON.stringify(msg.error))) : res2(msg.result)
      }
    }
  })
}
async function evaluate(cdp, expr) {
  const r = await cdp.call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  return r.result?.value
}
const main = async () => {
  const cdp = await connect(await getPageWs())
  console.log('[A 编辑器测试项目]', await evaluate(cdp, `window.api.fs.createDirectory('D:\\\\编辑器测试项目', 'sub-a').then(r => JSON.stringify(r))`))
  console.log('[B 中文测试目录]', await evaluate(cdp, `window.api.fs.createDirectory('D:\\\\中文测试目录', 'sub-b').then(r => JSON.stringify(r))`))
  console.log('[C entest 英文]', await evaluate(cdp, `window.api.fs.createDirectory('D:\\\\entest', 'sub-c').then(r => JSON.stringify(r))`))
  cdp.close()
}
main().catch((e) => { console.error('失败:', e.message); process.exit(1) })
