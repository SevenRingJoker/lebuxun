// 3.3 多语言 DAP CDP 冒烟：
// 验证 dap:start（真实 debugpy launch）→ setBreakpoints → 停驻事件 → evaluate → stop 全链路，
// 经渲染进程 window.api.dap 桥（IPC + preload 真实通路）。
// 依赖：应用 dev 模式已启动（--remote-debugging-port=9342）；本机 python + debugpy 可用。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { WebSocket } = require('ws')

const CDP_PORT = 9342
const TIMEOUT = 20000

let passed = 0
let failed = 0
function check(label, ok) {
  if (ok) { passed++; console.log(`  ✅ ${label}`) }
  else { failed++; console.log(`  ❌ ${label}`) }
}

// 探测 python+debugpy（Windows 无 python 时回退 py 解析真实路径并补 PATH）
function resolvePython() {
  const { execFileSync } = require('node:child_process')
  try {
    execFileSync('python', ['-c', 'import debugpy'], { stdio: 'ignore' })
    return true
  } catch { /* 继续 */ }
  try {
    const exe = execFileSync('py', ['-c', 'import debugpy, sys; print(sys.executable)'], { encoding: 'utf-8' }).trim()
    if (exe) {
      process.env.PATH = `${path.dirname(exe)};${process.env.PATH}`
      return true
    }
  } catch { /* 无 */ }
  return false
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
  async function waitForEvent(condFn, timeout = TIMEOUT) {
    const start = Date.now()
    while (Date.now() - start < timeout) {
      const events = await ev('window.__dapEvents || []')
      const idx = events.findIndex(condFn)
      if (idx >= 0) return events[idx]
      await new Promise(r => setTimeout(r, 150))
    }
    return null
  }
  return { call, ev, waitForEvent, close: () => ws.close() }
}

;(async () => {
  console.log('===== s39-s41 多语言 DAP CDP 冒烟 =====')

  // S0: 本机 debugpy 可用性（不可用则仅验证 IPC 存在性后跳过真机会话）
  const pyOk = resolvePython()
  console.log(`  [env] python+debugpy: ${pyOk ? '可用' : '不可用（真机项跳过）'}`)

  const cdp = await getCdp()

  // 临时 Python 脚本（第 2 行断点）
  const script = path.join(os.tmpdir(), `scholar-dap-cdp-${Date.now()}.py`)
  fs.writeFileSync(script, 'x = 1\ny = x + 41\nprint(y)\n', 'utf-8')

  try {
    // 安装事件收集器（debug:event 统一通道）
    await cdp.ev(`
      window.__dapEvents = [];
      window.api.debug.onEvent(ev => window.__dapEvents.push({ ...ev, ts: Date.now() }));
      'ok'
    `)

    // S1: dap IPC 桥存在
    const apiShape = await cdp.ev(`typeof window.api.dap === 'object' && ['start','stop','setBreakpoints','control','state','evaluate'].every(k => typeof window.api.dap[k] === 'function')`)
    check('S1 window.api.dap 六方法齐备', apiShape === true)

    if (pyOk) {
      // S2: 启动 debugpy launch 会话
      const start = await cdp.ev(`window.api.dap.start({ runtime: 'debugpy', request: 'launch', program: ${JSON.stringify(script)} })`)
      check('S2 dap:start launch 成功', start.ok === true)

      // S3: 状态事件流（connecting → ... → running）
      const st = await cdp.waitForEvent(e => e.kind === 'state' && e.state === 'running')
      check('S3 收到 state:running 事件', !!st)

      // S4: 下断点（第 2 行）
      const bp = await cdp.ev(`window.api.dap.setBreakpoints(${JSON.stringify(script)}, [2])`)
      check('S4 dap:setBreakpoints 成功', bp.ok === true)

      // S5: 停驻事件（堆栈 + 变量）
      const stopped = await cdp.waitForEvent(e => e.kind === 'stopped' && e.stack && e.stack.length > 0)
      check('S5 收到 stopped 事件（含堆栈）', !!stopped)
      const lineOk = stopped && stopped.stack[0] && stopped.stack[0].line === 2
      check('S5b 首帧停驻在第 2 行', !!lineOk)
      const varOk = stopped && (stopped.variables || []).some(v => v.name === 'x' && v.value === '1')
      check('S5c 变量 x = 1 已可见', !!varOk)

      // S6: REPL evaluate
      const ev1 = await cdp.ev(`window.api.dap.evaluate('x + 1')`)
      check('S6 dap:evaluate x+1=2', ev1.ok === true && ev1.result === '2')

      // S7: 停止会话
      const stop = await cdp.ev(`window.api.dap.stop()`)
      check('S7 dap:stop 成功', stop.ok === true)
      const term = await cdp.waitForEvent(e => e.kind === 'terminated', 8000)
      check('S7b 收到 terminated 事件', !!term)
    } else {
      console.log('  ⏭ S2-S7 真机会话跳过（python/debugpy 未安装）')
    }

    // S8: AI 调试工具已注册（经 ai:listTools 可见内置工具）
    const tools = await cdp.ev(`window.api.ai.listTools()`)
    const names = (tools || []).map(t => t.name)
    check('S8 debug_get_context/apply_breakpoint/evaluate 已注册',
      names.includes('debug_get_context') && names.includes('debug_apply_breakpoint') && names.includes('debug_evaluate'))

  } finally {
    // 兜底停会话（避免残留 python 进程）
    await cdp.ev(`window.api.dap.stop()`).catch(() => {})
    cdp.close()
    fs.unlinkSync(script)
  }

  console.log(`\n结果：${passed}/${passed + failed}`)
  if (failed) process.exit(1)
})().catch(e => { console.error('冒烟异常：', e); process.exit(1) })
