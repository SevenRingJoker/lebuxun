// CDP 探针 3：主进程 mkdir 对照实验 + 读取主进程环境差异
const CDP = 'http://127.0.0.1:9341'

async function getPageWs() {
  const res = await fetch(`${CDP}/json`)
  const page = (await res.json()).find((t) => t.type === 'page' && t.url.includes('localhost:5173'))
  if (!page) throw new Error('未找到页面')
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

  // 1) 主进程 mkdir 应用目录（预期成功——MCP server 此前成功）
  console.log('[主进程 mkdir 应用目录]',
    await evaluate(cdp, `window.api.fs.createDirectory('D:\\\\47.104.20.186\\\\aiProject\\\\scholarTreaCode', 'main-probe-en').then(r => JSON.stringify(r))`))

  // 2) 主进程 mkdir 工作区下纯英文子目录（排除中文文件名因素，父目录是中文）
  console.log('[主进程 mkdir 工作区/英文名]',
    await evaluate(cdp, `window.api.fs.createDirectory('D:\\\\编辑器测试项目', 'main-probe-en2').then(r => JSON.stringify(r))`))

  // 3) 主进程 writeFile 到工作区（区分 mkdir 与 write）
  console.log('[主进程 writeFile 工作区]',
    await evaluate(cdp, `window.api.fs.writeFile('D:\\\\编辑器测试项目\\\\probe-write.txt', 'hello').then(r => JSON.stringify(r))`))

  // 4) 主进程读工作区（已知文件树能读？验证）
  console.log('[主进程 readDirTree 工作区]',
    await evaluate(cdp, `window.api.fs.readDirTree('D:\\\\编辑器测试项目').then(r => 'ok len=' + JSON.stringify(r).length).catch(e => 'ERR ' + e.message)`))

  cdp.close()
}
main().catch((e) => { console.error('失败:', e.message); process.exit(1) })
