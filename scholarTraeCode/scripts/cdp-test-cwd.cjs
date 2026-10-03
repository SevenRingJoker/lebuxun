// 补充：cwd 切换、中文目录建/查/删、连续无输出命令（prompt 粘连重灾区）
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
    void p
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
const run = async (cdp, cmd, cwd) => {
  const arg = cwd ? `, ${JSON.stringify(cwd)}` : ''
  const r = await cdp.call('Runtime.evaluate', {
    expression: `window.api.terminal.run(${JSON.stringify(cmd)}${arg}).then(r => JSON.stringify({code:r.exitCode, out:r.output.replace(/[\\r\\n]+/g,' | ').trim().slice(0,200)}))`,
    awaitPromise: true,
    returnByValue: true
  })
  return r.result.value
}

const main = async () => {
  const cdp = await connect(await getPageWs())
  await cdp.call('Runtime.evaluate', { expression: "window.api.terminal.start('D:\\\\编辑器测试项目')", awaitPromise: true })
  await new Promise((r) => setTimeout(r, 800))

  console.log('A) 连续无输出 exit1:', await run(cdp, 'cmd /c exit 1'))
  console.log('B) 连续无输出 exit2:', await run(cdp, 'cmd /c exit 2'))
  console.log('C) 连续无输出 exit5:', await run(cdp, 'cmd /c exit 5'))
  console.log('D) cwd切到子目录   :', await run(cdp, 'cd', 'D:\\编辑器测试项目\\34'))
  console.log('E) cwd下建中文目录 :', await run(cdp, 'mkdir 终端验证目录_中文'))
  console.log('F) 列出含中文      :', await run(cdp, 'dir /b | findstr 终端验证'))
  console.log('G) 删除中文目录    :', await run(cdp, 'rmdir 终端验证目录_中文'))
  console.log('H) 回根目录验证cd  :', await run(cdp, 'cd', 'D:\\编辑器测试项目'))
  console.log('I) 最终echo        :', await run(cdp, 'echo FINAL_OK'))
  cdp.close()
}
main().catch((e) => {
  console.error('失败:', e.message)
  process.exit(1)
})
