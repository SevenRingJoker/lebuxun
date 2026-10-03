// 3.1 预览 CDP 冒烟：
// 验证 WebContentsView 创建/导航/bounds/销毁全链路。
// 依赖：应用 dev 模式已启动（--remote-debugging-port=9342）。
const http = require('node:http')
const { WebSocket } = require('ws')

const CDP_PORT = 9342
const PREVIEW_PORT = 15555 // 假 dev server（不与常见端口冲突）
const TIMEOUT = 15000

let passed = 0
let failed = 0
function check(label, ok) {
  if (ok) { passed++; console.log(`  ✅ ${label}`) }
  else { failed++; console.log(`  ❌ ${label}`) }
}

// 启动假 HTTP 服务（两页：page1 自动跳 page2，page2 含返回链接）
function startFakeServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      if (req.url === '/' || req.url === '/page1') {
        res.end(`<html><body><h1>Page1</h1><script>setTimeout(()=>location.href='/page2',600)</script></body></html>`)
      } else if (req.url === '/page2') {
        res.end(`<html><body><h1>Page2</h1><a href="/page1">Back</a></body></html>`)
      } else {
        res.writeHead(404); res.end('404')
      }
    })
    server.listen(PREVIEW_PORT, () => resolve(server))
  })
}

async function getCdp() {
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()
  const page = targets.find(t => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  ws.onmessage = e => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id)
      pending.delete(m.id)
      m.error ? p.j(m.error) : p.r(m.result)
    }
  }
  await new Promise(r => ws.onopen = r)
  function call(method, params = {}) {
    return new Promise((r, j) => {
      const i = ++id
      pending.set(i, { r, j })
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  }
  async function ev(expr) {
    const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails))
    return r.result.value
  }
  // 等待 window.__previewEvents 数组中出现满足条件的项
  async function waitForEvent(condFn, timeout = TIMEOUT) {
    const start = Date.now()
    while (Date.now() - start < timeout) {
      const events = await ev('window.__previewEvents || []')
      const idx = events.findIndex(condFn)
      if (idx >= 0) return events[idx]
      await new Promise(r => setTimeout(r, 120))
    }
    return null
  }
  return { call, ev, waitForEvent, close: () => ws.close() }
}

;(async () => {
  console.log('===== s34-s36 预览 CDP 冒烟 =====')
  const server = await startFakeServer()
  const cdp = await getCdp()

  try {
    // 安装事件收集器
    await cdp.ev(`
      window.__previewEvents = [];
      window.api.preview.onNavigated(u => window.__previewEvents.push({t:'nav',u,ts:Date.now()}));
      window.api.preview.onLoading(l => window.__previewEvents.push({t:'load',l,ts:Date.now()}));
      window.api.preview.onLoadError(e => window.__previewEvents.push({t:'err',e,ts:Date.now()}));
      'ok'
    `)

    // S1: probeDevServer 命中假服务
    const probe = await cdp.ev(`window.api.preview.probeDevServer([${PREVIEW_PORT}])`)
    check('S1 probeDevServer 命中假服务', probe.ok === true && probe.url && probe.url.includes(`:${PREVIEW_PORT}`))

    // S2: 打开预览（模拟有容器尺寸）
    const baseUrl = `http://127.0.0.1:${PREVIEW_PORT}/page1`
    const open = await cdp.ev(`window.api.preview.open(${JSON.stringify(baseUrl)}, {x:200,y:200,width:800,height:600})`)
    check('S2 preview:open 成功', open.ok === true)

    // S3: 等待 onNavigated Page1
    const nav1 = await cdp.waitForEvent(e => e.t === 'nav' && e.u && e.u.includes('/page1'))
    check('S3 onNavigated 收到 Page1', !!nav1)

    // S4: Page1 自动跳 Page2
    const nav2 = await cdp.waitForEvent(e => e.t === 'nav' && e.u && e.u.includes('/page2'))
    check('S4 Page1 自动跳转后 onNavigated 收到 Page2', !!nav2)

    // S5: back 回到 Page1
    await cdp.ev(`window.api.preview.control('back')`)
    const nav3 = await cdp.waitForEvent(e => e.t === 'nav' && e.u && e.u.includes('/page1'))
    check('S5 back 后 onNavigated 收到 Page1', !!nav3)

    // S6: reload 触发 loading 事件
    await cdp.ev(`window.__previewEvents = window.__previewEvents.filter(e => !(e.t==='load' && e.l===false))`)
    await cdp.ev(`window.api.preview.control('reload')`)
    const loadEvent = await cdp.waitForEvent(e => e.t === 'load' && e.l === false)
    check('S6 reload 后 onLoading false 事件', !!loadEvent)

    // S7: setBounds 更新尺寸
    const bounds = await cdp.ev(`window.api.preview.setBounds({x:0,y:0,width:600,height:400})`)
    check('S7 setBounds 成功', bounds.ok === true)

    // S8: close 销毁视图
    await cdp.ev(`window.api.preview.control('close')`)
    const state = await cdp.ev(`window.api.preview.isOpen()`)
    check('S8 close 后 isOpen 返回 false', state.open === false)

  } finally {
    cdp.close()
    server.close()
  }

  console.log(`\n结果：${passed}/${passed+failed}`)
  if (failed) process.exit(1)
})().catch(e => { console.error('冒烟异常：', e); process.exit(1) })
