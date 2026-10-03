// 3.2 元素选择 CDP 冒烟：
// 验证预览页注入选择模式（高亮 overlay）、点击采集选择器/outerHTML/bounds、
// preview:picked 事件回推、ChatPanel 预填「修改这个元素」、元素截图。
// 依赖：应用 dev 模式已启动（--remote-debugging-port=9342）。
const http = require('node:http')
const { WebSocket } = require('ws')

const CDP_PORT = 9342
const PREVIEW_PORT = 15666 // 假 dev server（不与常见端口冲突）
const TIMEOUT = 15000

let passed = 0
let failed = 0
function check(label, ok) {
  if (ok) { passed++; console.log(`  ✅ ${label}`) }
  else { failed++; console.log(`  ❌ ${label}`) }
}

// 假页面：带 data-id 的按钮 + 无属性段落（测 CSS path 退化）
function startFakeServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(`<html><body style="margin:0">
        <button data-id="submit-btn" id="submitBtn" style="width:120px;height:40px">提交订单</button>
        <div class="card"><p>你好世界</p></div>
      </body></html>`)
    })
    server.listen(PREVIEW_PORT, () => resolve(server))
  })
}

async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl)
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
  return { call, ev, close: () => ws.close() }
}

async function getMainRenderer() {
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()
  const page = targets.find(t => t.type === 'page' && (t.url || '').includes('localhost:5173'))
  if (!page) throw new Error('主渲染进程目标未找到')
  return connectCdp(page.webSocketDebuggerUrl)
}

async function getPreviewTarget() {
  const start = Date.now()
  while (Date.now() - start < TIMEOUT) {
    const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()
    const page = targets.find(t => (t.url || '').includes(`:${PREVIEW_PORT}`))
    if (page) return connectCdp(page.webSocketDebuggerUrl)
    await new Promise(r => setTimeout(r, 300))
  }
  return null
}

;(async () => {
  console.log('===== s37-s38 元素选择 CDP 冒烟 =====')
  const server = await startFakeServer()
  const main = await getMainRenderer()

  try {
    // 安装 picked 事件收集器
    await main.ev(`
      window.__picked = [];
      window.api.preview.onPicked(d => window.__picked.push(d));
      'ok'
    `)

    // S1: 打开预览
    const url = `http://127.0.0.1:${PREVIEW_PORT}/`
    const open = await main.ev(`window.api.preview.open(${JSON.stringify(url)}, {x:300,y:150,width:700,height:500})`)
    check('S1 preview:open 成功', open.ok === true)

    // S2: 进入选择模式
    const enter = await main.ev(`window.api.preview.enterPickMode()`)
    if (enter.ok !== true) console.log('    [S2 error]', enter.error)
    check('S2 enterPickMode 成功', enter.ok === true)

    // S3: 预览页内高亮 overlay 已注入
    const view = await getPreviewTarget()
    check('S3 预览 WebContentsView 目标可见', !!view)
    let overlayOk = false
    if (view) {
      const start = Date.now()
      while (Date.now() - start < TIMEOUT) {
        overlayOk = await view.ev(`!!document.getElementById('__scholar-picker-overlay')`)
        if (overlayOk) break
        await new Promise(r => setTimeout(r, 200))
      }
    }
    check('S3b 选择模式 overlay 已注入预览页', overlayOk)

    // S4: 模拟点击按钮（捕获阶段监听，dispatch 即触发采集）
    if (view) {
      await view.ev(`
        const el = document.querySelector('[data-id="submit-btn"]');
        const r = el.getBoundingClientRect();
        el.dispatchEvent(new MouseEvent('mousemove', {bubbles:true, cancelable:true, clientX:r.x+5, clientY:r.y+5}));
        el.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true, clientX:r.x+5, clientY:r.y+5}));
        'clicked'
      `)
    }

    // S5: 主渲染端收到 picked 事件
    let picked = null
    {
      const start = Date.now()
      while (Date.now() - start < TIMEOUT) {
        const arr = await main.ev(`window.__picked`)
        if (arr.length > 0) { picked = arr[0]; break }
        await new Promise(r => setTimeout(r, 200))
      }
    }
    check('S5 preview:picked 事件回推', !!picked)
    check('S5b 选择器命中 data-id 优先', picked && picked.selector === '[data-id="submit-btn"]')
    check('S5c outerHTML 含按钮文本', picked && picked.outerHTML.includes('提交订单'))
    check('S5d bounds 有效', picked && picked.bounds.width > 0 && picked.bounds.height > 0)

    // S6: 元素截图（capturePage 按 bounds）
    if (picked) {
      const shot = await main.ev(`window.api.preview.captureElement(${JSON.stringify(picked.bounds)})`)
      if (!(shot.ok === true && typeof shot.dataUrl === 'string' && shot.dataUrl.startsWith('data:image/png'))) {
        console.log('    [S6 detail]', JSON.stringify(shot).slice(0, 200), 'bounds=', JSON.stringify(picked.bounds))
      }
      check('S6 captureElement 返回 PNG dataUrl', shot.ok === true && typeof shot.dataUrl === 'string' && shot.dataUrl.startsWith('data:image/png'))
    }

    // S7: ChatPanel 预填「修改这个元素」
    let prefill = ''
    {
      const start = Date.now()
      while (Date.now() - start < TIMEOUT) {
        prefill = await main.ev(`(document.querySelector('.composer-input') || {}).value || ''`)
        if (prefill.includes('修改这个元素')) break
        await new Promise(r => setTimeout(r, 200))
      }
    }
    check('S7 ChatPanel 预填出现（含选择器）', prefill.includes('修改这个元素') && prefill.includes('[data-id="submit-btn"]'))

    // S8: 退出选择模式 + 关闭预览
    const exit = await main.ev(`window.api.preview.exitPickMode()`)
    check('S8 exitPickMode 成功', exit.ok === true)
    await main.ev(`window.api.preview.control('close')`)

    if (view) view.close()
  } finally {
    main.close()
    server.close()
  }

  console.log(`\n结果：${passed}/${passed+failed}`)
  if (failed) process.exit(1)
})().catch(e => { console.error('冒烟异常：', e); process.exit(1) })
