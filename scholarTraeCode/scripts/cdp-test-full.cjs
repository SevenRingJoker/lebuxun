// 全量验证：管道不挂死、退出码准确、输出不串位、中文 echo/dir 正常、连续命令隔离
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
const run = async (cdp, cmd, cwd) => {
  const arg = cwd ? `, ${JSON.stringify(cwd)}` : ''
  const r = await cdp.call('Runtime.evaluate', {
    expression: `window.api.terminal.run(${JSON.stringify(cmd)}${arg}).then(r => JSON.stringify({code:r.exitCode, out:r.output.replace(/[\\r\\n]+/g,' | ').trim().slice(0,150)}))`,
    awaitPromise: true,
    returnByValue: true
  })
  return r.result.value
}

const main = async () => {
  const cdp = await connect(await getPageWs())
  await cdp.call('Runtime.evaluate', { expression: "window.api.terminal.start('D:\\\\编辑器测试项目')", awaitPromise: true })
  console.log('1) 成功+管道   :', await run(cdp, 'echo abc-def | findstr "def"'))
  console.log('2) 失败退出码3 :', await run(cdp, 'cmd /c exit 3'))
  console.log('3) 中文echo    :', await run(cdp, 'echo 中文测试_创建项目'))
  console.log('4) 中文+管道   :', await run(cdp, 'echo 中文项目测试 | findstr "项目"'))
  console.log('5) dir系统中文 :', await run(cdp, 'dir'))
  console.log('6) 连续隔离    :', await run(cdp, 'echo ONLY_SIX'))
  cdp.close()
}
main().catch((e) => {
  console.error('失败:', e.message)
  process.exit(1)
})
