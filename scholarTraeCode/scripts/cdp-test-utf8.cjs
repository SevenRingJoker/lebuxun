// 验证 UTF-8 代码页下中文输出正常（dir 含中文目录名）
const CDP = 'http://127.0.0.1:9341'

async function getPageWs() {
  const res = await fetch(`${CDP}/json`)
  const targets = await res.json()
  return targets.find((t) => t.type === 'page' && /localhost:\d+/.test(t.url)).webSocketDebuggerUrl
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let id = 0
    const pending = new Map()
    ws.onopen = () =>
      resolve({
        call(m, p = {}) {
          return new Promise((res2, rej2) => {
            const mid = ++id
            pending.set(mid, { res2, rej2 })
            ws.send(JSON.stringify({ id: mid, method: m, params: p }))
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
        msg.error ? rej2(new Error(JSON.stringify(msg.error))) : res2(msg.result)
      }
    }
  })
}

const main = async () => {
  const cdp = await connect(await getPageWs())
  // 重启 shell 确保 UTF-8 代码页生效，然后 dir
  await cdp.call('Runtime.evaluate', {
    expression: "window.api.terminal.start('D:\\\\编辑器测试项目')",
    awaitPromise: true
  })
  const r = await cdp.call('Runtime.evaluate', {
    expression: "window.api.terminal.run('dir /b').then(r => r.output)",
    awaitPromise: true,
    returnByValue: true
  })
  console.log('=== dir /b 输出 ===')
  console.log(r.result.value)
  const hasReplacement = r.result.value.includes('\uFFFD')
  console.log(hasReplacement ? '!!! 仍有菱形乱码' : 'OK: 无乱码')
  cdp.close()
}

main().catch((e) => {
  console.error('失败:', e.message)
  process.exit(1)
})
