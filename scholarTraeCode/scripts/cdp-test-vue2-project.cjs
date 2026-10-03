// CDP E2E 测试：验证 AI 工具循环能完整生成 vue2 项目
// 连接 Electron 真实窗口（remoteDebuggingPort 9341），调用 window.api.ai.chatWithTools
const fs = require('fs')
const path = require('path')

const CDP = 'http://127.0.0.1:9341'
const WORKSPACE = 'D:\\编辑器测试项目'

async function getPageWs() {
  const res = await fetch(`${CDP}/json`)
  const targets = await res.json()
  const page = targets.find((t) => t.type === 'page' && /localhost:\d+/.test(t.url))
  if (!page) throw new Error('No page target found')
  return page.webSocketDebuggerUrl
}

function connect(u) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(u)
    let id = 0
    const pending = new Map()
    ws.onopen = () =>
      resolve({
        call(method, params = {}) {
          return new Promise((r, j) => {
            const i = ++id
            pending.set(i, { r, j })
            ws.send(JSON.stringify({ id: i, method, params }))
          })
        },
        close: () => ws.close()
      })
    ws.onerror = () => reject(new Error('WebSocket connect failed'))
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

const setupScript = `
window.__testResults = { toolCalls: [], toolResults: [], done: false, error: null, content: null }
window.__testEvents = { onToolCall: null, onToolResult: null }

// 订阅工具事件
window.api.ai.onToolCall((p) => {
  window.__testResults.toolCalls.push(p)
  console.log('[TOOL_CALL]', p.name, JSON.stringify(p.args).slice(0, 200))
})
window.api.ai.onToolResult((p) => {
  window.__testResults.toolResults.push(p)
  console.log('[TOOL_RESULT]', p.name, p.result.slice(0, 200))
})

// 触发 chatWithTools
window.api.ai.chatWithTools({
  messages: [{ role: 'user', content: '在当前工作区创建一个vue2项目，包含 package.json、index.html、src/main.js、src/App.vue、src/router/index.js、webpack.config.js、README.md' }],
  workspace: '${WORKSPACE.replace(/\\/g, '\\\\')}',
  useTools: true
}).then((res) => {
  window.__testResults.done = true
  window.__testResults.content = res.content
  window.__testResults.error = res.error
  console.log('[CHAT_WITH_TOOLS_DONE]', JSON.stringify(res).slice(0, 500))
}).catch((err) => {
  window.__testResults.done = true
  window.__testResults.error = err.message
  console.log('[CHAT_WITH_TOOLS_ERROR]', err.message)
})
'STARTED'
`

const pollScript = `JSON.stringify({
  done: window.__testResults.done,
  error: window.__testResults.error,
  content: (window.__testResults.content || '').slice(0, 500),
  toolCalls: window.__testResults.toolCalls.map(t => t.name),
  toolResults: window.__testResults.toolResults.length
})`

const main = async () => {
  const cdp = await connect(await getPageWs())
  await cdp.call('Page.enable')
  await cdp.call('Runtime.enable')

  // 设置控制台日志收集
  await cdp.call('Runtime.evaluate', { expression: 'console.log("=== E2E TEST START ===")' })

  // 注入测试脚本
  const r = await cdp.call('Runtime.evaluate', { expression: setupScript, returnByValue: true })
  console.log('Setup result:', r.result?.value)

  // 轮询等待完成（最多 5 分钟）
  const maxWait = 300000 // 5 min
  const interval = 5000
  const maxAttempts = maxWait / interval
  for (let i = 1; i <= maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, interval))
    const pr = await cdp.call('Runtime.evaluate', { expression: pollScript, returnByValue: true })
    const state = JSON.parse(pr.result.value)
    console.log(`[${(i * interval) / 1000}s] done=${state.done} calls=${state.toolCalls.length} results=${state.toolResults}`)

    if (state.done) {
      console.log('\n=== AI CHAT WITH TOOLS COMPLETED ===')
      console.log('Error:', state.error || 'none')
      console.log('Content:', state.content || '(empty)')
      console.log('Tool calls:', state.toolCalls.join(', '))
      console.log('Tool results count:', state.toolResults)
      break
    }
  }

  // 检查生成的文件
  const files = await cdp.call('Runtime.evaluate', {
    expression: `(async () => {
      const result = await window.api.fs.readDir('${WORKSPACE.replace(/\\/g, '\\\\')}\\\\vue2项目')
      return JSON.stringify(result)
    })()`,
    awaitPromise: true,
    returnByValue: true
  })
  console.log('\n=== GENERATED FILES ===')
  console.log(files.result?.value || 'N/A')

  // 也用 PowerShell 列文件
  cdp.close()

  // 直接从文件系统检查
  const projDir = path.join(WORKSPACE, 'vue2项目')
  if (fs.existsSync(projDir)) {
    const allFiles = []
    const walk = (dir, base = '') => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = base ? base + '/' + entry.name : entry.name
        if (entry.isDirectory()) {
          walk(path.join(dir, entry.name), rel)
        } else {
          const stat = fs.statSync(path.join(dir, entry.name))
          allFiles.push({ path: rel, size: stat.size })
        }
      }
    }
    walk(projDir)
    console.log('\n=== FILESYSTEM CHECK ===')
    console.log('Total files:', allFiles.length)
    for (const f of allFiles) {
      console.log(`  ${f.path} (${f.size} bytes)`)
    }
  } else {
    console.log('\n=== FILESYSTEM CHECK: vue2项目 directory not found ===')
  }
}

main().catch((e) => {
  console.error('Test failed:', e.message)
  process.exit(1)
})
