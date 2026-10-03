// 直接验证中文 echo 与含中文名目录的 dir 输出
const CDP = 'http://127.0.0.1:9341'
async function getPageWs() {
  const res = await fetch(`${CDP}/json`)
  const t = (await res.json()).find((x) => x.type === 'page' && /localhost:\d+/.test(x.url))
  return t.webSocketDebuggerUrl
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
  const r = await cdp.call('Runtime.evaluate', {
    expression:
      "window.api.terminal.run('echo 中文测试_创建项目_编辑器 && dir /b \"D:\\\\\" | findstr /c:\"编辑器\"').then(r => r.output)",
    awaitPromise: true,
    returnByValue: true
  })
  console.log('=== 输出 ===')
  console.log(JSON.stringify(r.result.value))
  console.log(r.result.value.includes('\uFFFD') ? '!!! 有菱形乱码' : 'OK: 中文正常')
  cdp.close()
}
main().catch((e) => {
  console.error('失败:', e.message)
  process.exit(1)
})
