// 快速验证 markdown.ts 渲染输出：CDP 直连页面，动态 import vite 模块并渲染样例
const CDP = 'http://127.0.0.1:9341'

async function getPageWs() {
  const res = await fetch(`${CDP}/json`)
  const targets = await res.json()
  const page = targets.find((t) => t.type === 'page' && /localhost:\d+/.test(t.url))
  if (!page) throw new Error('未找到渲染进程页面')
  return page.webSocketDebuggerUrl
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let id = 0
    const pending = new Map()
    ws.onopen = () => resolve({
      call(method, params = {}) {
        return new Promise((res2, rej2) => {
          const mid = ++id
          pending.set(mid, { res2, rej2 })
          ws.send(JSON.stringify({ id: mid, method, params }))
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
        if (msg.error) rej2(new Error(JSON.stringify(msg.error)))
        else res2(msg.result)
      }
    }
  })
}

const main = async () => {
  const cdp = await connect(await getPageWs())
  const sample = [
    '### 测试结果标题',
    '',
    '**最终结果：** 已生成 `src/main.js`，共 3 个文件。',
    '',
    '- 第一项 *斜体*',
    '- 第二项 ~~删除线~~',
    '',
    '1. 有序一',
    '2. 有序二',
    '',
    '> 引用：注意安全 <script>alert(1)</script>',
    '',
    '```js',
    'const a = "<b>转义</b>"',
    'console.log(a)',
    '```',
    '',
    '详见 [官网](https://example.com) 与 [恶意](javascript:alert(1))'
  ].join('\n')
  const expr = `import('/src/utils/markdown.ts?t=' + Date.now()).then(m => m.renderMarkdown(${JSON.stringify(sample)}))`
  const r = await cdp.call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) {
    console.error('执行异常:', JSON.stringify(r.exceptionDetails).slice(0, 500))
    process.exit(1)
  }
  console.log(r.result.value)
  cdp.close()
}

main().catch((e) => { console.error('失败:', e.message); process.exit(1) })
