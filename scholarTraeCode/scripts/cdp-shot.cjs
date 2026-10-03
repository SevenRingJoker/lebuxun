// 直连 Electron 真实窗口：跑 dir + 中文 echo 后对终端面板截图
const fs = require('fs')
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
  await cdp.call('Page.enable')
  // 重启干净会话并执行两条命令
  await cdp.call('Runtime.evaluate', { expression: "window.api.terminal.start('D:\\\\编辑器测试项目')", awaitPromise: true })
  await new Promise((r) => setTimeout(r, 1000))
  await cdp.call('Runtime.evaluate', { expression: "window.api.terminal.run('dir')", awaitPromise: true })
  await cdp.call('Runtime.evaluate', { expression: "window.api.terminal.run('echo 中文显示验证_创建项目成功')", awaitPromise: true })
  await new Promise((r) => setTimeout(r, 800))
  // 取终端面板区域坐标，裁剪截图
  const rect = await cdp.call('Runtime.evaluate', {
    expression: `(()=>{const el=document.querySelector('.terminal-panel');const r=el.getBoundingClientRect();return JSON.stringify({x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)})})()`,
    returnByValue: true
  })
  const box = JSON.parse(rect.result.value)
  console.log('终端面板区域:', JSON.stringify(box))
  const shot = await cdp.call('Page.captureScreenshot', { format: 'png', clip: { x: box.x, y: box.y, width: box.w, height: box.h, scale: 1 } })
  fs.writeFileSync(__dirname + '/shot-terminal.png', Buffer.from(shot.data, 'base64'))
  // 同时取全部终端行文本
  const lines = await cdp.call('Runtime.evaluate', {
    expression: `JSON.stringify([...document.querySelectorAll('.terminal-panel .term-line')].map(e=>e.innerText))`,
    returnByValue: true
  })
  console.log('终端行文本:\n' + lines.result.value)
  console.log('截图已保存: scripts/shot-terminal.png')
  cdp.close()
}
main().catch((e) => { console.error('失败:', e.message); process.exit(1) })
