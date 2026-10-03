// CDP 直连 Electron 渲染进程，验证 AI 调度层 + MCP 工具链路：
// 1) 检查 window.api.ai 是否注入
// 2) 调用 ai:chatWithTools 让 AI 在工作区创建 vue2-demo 项目
// 3) 输出工具调用过程与最终结果
const CDP = 'http://127.0.0.1:9341'

async function getPageWs() {
  const res = await fetch(`${CDP}/json`)
  const targets = await res.json()
  const page = targets.find((t) => t.type === 'page' && t.url.includes('localhost:5173'))
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
    ws.onerror = (e) => reject(new Error('ws error'))
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

async function evaluate(cdp, expr, awaitPromise = false, timeoutMs = 300000) {
  const r = await cdp.call('Runtime.evaluate', {
    expression: expr,
    awaitPromise,
    returnByValue: true,
    timeout: timeoutMs
  })
  if (r.exceptionDetails) {
    throw new Error('页面内执行异常: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  }
  return r.result?.value
}

const main = async () => {
  const wsUrl = await getPageWs()
  console.log('[1] 已定位渲染进程:', wsUrl)
  const cdp = await connect(wsUrl)

  // 1) 验证 preload 注入完整
  const apiKeys = await evaluate(cdp, `Object.keys(window.api || {}).join(',')`)
  console.log('[2] window.api keys =', apiKeys)
  const hasAi = await evaluate(cdp, `typeof window.api?.ai?.chatWithTools`)
  console.log('[3] window.api.ai.chatWithTools 类型 =', hasAi)

  // 2) 列模型（验证调度层模型清单）
  const models = await evaluate(cdp, `window.api.ai.listModels().then(ms => ms.map(m => m.id + (m.available ? '' : '(不可用)')).join(' | '))`, true)
  console.log('[4] 可用模型 =', models)

  // 3) 订阅工具调用事件（挂到 window 上便于后续读取；防止重复运行导致监听器累积）
  await evaluate(cdp, `
    window.__toolLog = []
    if (!window.__aiTestSubscribed) {
      window.__aiTestSubscribed = true
      window.api.ai.onToolCall(p => window.__toolLog.push('CALL ' + p.name + ' ' + JSON.stringify(p.args)))
      window.api.ai.onToolResult(p => window.__toolLog.push('RESULT ' + p.name + ' -> ' + String(p.result).slice(0, 200)))
    }
    'ok'
  `)

  // 4) 发起工具调用聊天：创建 Vue2 项目
  // 注意：消息通过 JSON.stringify 注入页面，避免模板字符串转义问题
  console.log('[5] 发送创建 Vue2 项目请求（本地模型，可能需要几分钟）...')
  const params = {
    model: process.argv[2] || 'auto',
    messages: [
      { role: 'system', content: '你是项目脚手架助手。用户要求创建文件/目录时，必须使用提供的工具实际创建，不要只输出说明。严格按用户给出的步骤顺序执行，每步一次工具调用，全部 5 步做完才能结束。工作区根目录：D:\\编辑器测试项目' },
      { role: 'user', content: [
        '在工作区根目录下创建 Vue2 项目 vue2-demo，严格按以下 5 步执行：',
        '1. create_directory 创建 D:\\编辑器测试项目\\vue2-demo',
        '2. write_file 创建 D:\\编辑器测试项目\\vue2-demo\\package.json（name 为 vue2-demo，dependencies 含 vue ^2.7.0）',
        '3. write_file 创建 D:\\编辑器测试项目\\vue2-demo\\index.html（含一个 id 为 app 的 div）',
        '4. create_directory 创建 D:\\编辑器测试项目\\vue2-demo\\src',
        '5. write_file 创建 D:\\编辑器测试项目\\vue2-demo\\src\\main.js（内容为 new Vue 挂载到 id 为 app 的元素）',
        '做完 5 步后用一句话总结。'
      ].join('\n') }
    ],
    workspace: 'D:\\编辑器测试项目',
    timeoutMs: 60000
  }
  const result = await evaluate(cdp, `window.api.ai.chatWithTools(JSON.parse(${JSON.stringify(JSON.stringify(params))}))`, true, 600000)
  console.log('[6] chatWithTools 返回 =', JSON.stringify(result))

  // 5) 读取工具调用日志
  const toolLog = await evaluate(cdp, `window.__toolLog.join('\\n')`)
  console.log('[7] 工具调用日志:\n' + (toolLog || '(无)'))

  cdp.close()
}

main().catch((e) => { console.error('测试失败:', e.message); process.exit(1) })
