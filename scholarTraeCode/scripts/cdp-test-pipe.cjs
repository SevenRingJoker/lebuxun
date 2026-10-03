// 验证：含管道的命令不再挂死、退出码准确（成功0/失败非0）、中文正常
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
const run = async (cdp, cmd) => {
  const r = await cdp.call('Runtime.evaluate', {
    expression: `window.api.terminal.run(${JSON.stringify(cmd)}).then(r => JSON.stringify({code:r.exitCode, out:r.output.replace(/\\s+/g,' ').trim().slice(0,120)}))`,
    awaitPromise: true,
    returnByValue: true
  })
  return r.result.value
}

const main = async () => {
  const cdp = await connect(await getPageWs())
  console.log('1) 管道命令 echo|find :', await run(cdp, 'echo abc-def | findstr "def"'))
  console.log('2) 失败退出码      :', await run(cdp, 'cmd /c exit 3'))
  console.log('3) 中文+管道       :', await run(cdp, 'echo 中文测试_创建项目 | findstr "项目"'))
  console.log('4) 连续第二条      :', await run(cdp, 'echo SECOND_OK'))
  cdp.close()
}
main().catch((e) => {
  console.error('失败:', e.message)
  process.exit(1)
})
