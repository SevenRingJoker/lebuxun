// CDP 真窗冒烟 · 1.4 Vue/Volar LSP 协议层
// 前置：npm run dev -- --remote-debugging-port=9341
// 覆盖：detectVue 二选一、start+initialize(tsdk/hybridMode)、
//   .vue 模板+脚本双诊断、中文路径诊断、completion/hover/definition/rename/formatting、
//   Take Over 下 .ts 诊断
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

async function evaluate(cdp, expr, awaitPromise = false, timeoutMs = 120000) {
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

// 页面内执行体：禁用反引号，全部用单引号/字符串拼接，避免与外层模板冲突
const PAGE_CODE = `
(async () => {
  const ROOT = '__VUE_ROOT__'
  const TSONLY = '__TS_ROOT__'
  const pathUri = (p) => 'file:///' + p.replace(/\\\\/g, '/')
  // Volar 回推盘符可能小写（d%3A），统一键为小写盘符，避免大小写不匹配
  const normKey = (uri) => decodeURIComponent(uri).replace(/^file:\\/\\/\\/([a-z]):/i,
    (m, d) => 'file:///' + d.toLowerCase() + ':')
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const report = { steps: [] }
  const log = (name, ok, detail) => { report.steps.push({ name, ok: !!ok, detail: String(detail) }) }

  const APP = [
    '<script setup lang="ts">',
    "import { add } from './math'",
    "const name: string = 'abc'",
    "const value: number = 'oops'",
    'const total = add(1, 2)',
    '</script>',
    '<template>',
    '    <div :data-t="total">{{ name.toFixed(2) }}</div>',
    '</template>',
    ''
  ].join('\\n')
  const PANEL = [
    '<script setup lang="ts">',
    "const msg: number = '不是数字'",
    '</script>',
    '<template>',
    '  <div>{{ msg }}</div>',
    '</template>',
    ''
  ].join('\\n')
  const BADTS = "export const n: number = 'hello'\\n"
  const MATH = [
    'export function add(a: number, b: number) {',
    '  return a + b',
    '}',
    ''
  ].join('\\n')

  // ---- 0) 清残留，保证重复运行确定性 ----
  await window.api.lsp.stop('vue')

  // ---- 1) 工作区探测二选一 ----
  try {
    const hasVue = await window.api.lsp.detectVue(ROOT)
    const noVue = await window.api.lsp.detectVue(TSONLY)
    log('detectVue 二选一', hasVue === true && noVue === false, 'vue=' + hasVue + ' tsOnly=' + noVue)
  } catch (e) { log('detectVue 二选一', false, e.message) }

  // ---- 消息泵 ----
  let nextId = 1000
  const pending = new Map()
  const diagByUri = new Map()
  if (!window.__vueSmokeSubscribed) {
    window.__vueSmokeSubscribed = 0
  }
  window.__vueSmokeSubscribed += 1
  window.api.lsp.onMessage((kind, body) => {
      if (kind !== 'vue') return
      let msg
      try { msg = JSON.parse(body) } catch { return }
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
      if (msg.method === 'textDocument/publishDiagnostics') {
        diagByUri.set(normKey(msg.params.uri), msg.params.diagnostics)
      }
    })

  const call = (method, params, timeoutMs = 30000) => new Promise((resolve, reject) => {
    const id = ++nextId
    const to = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timeout')) }, timeoutMs)
    pending.set(id, (msg) => { clearTimeout(to); if (msg.error) reject(new Error(JSON.stringify(msg.error))); else resolve(msg.result) })
    window.api.lsp.write('vue', JSON.stringify({ jsonrpc: '2.0', id, method, params }))
  })
  const notify = (method, params) => window.api.lsp.write('vue', JSON.stringify({ jsonrpc: '2.0', method, params }))
  const openDoc = (absPath, languageId, text) => notify('textDocument/didOpen', {
    textDocument: { uri: pathUri(absPath), languageId, version: 1, text }
  })
  const posAt = (text, needle) => {
    const idx = text.indexOf(needle)
    if (idx < 0) throw new Error('needle not found: ' + needle)
    const lines = text.slice(0, idx).split('\\n')
    return { line: lines.length - 1, character: lines[lines.length - 1].length }
  }
  const waitErrorDiag = (absPath, timeoutMs = 30000) => new Promise((resolve) => {
    const key = normKey(pathUri(absPath))
    const t0 = Date.now()
    const tick = () => {
      const d = diagByUri.get(key)
      if (d && d.length > 0) return resolve(d)
      if (Date.now() - t0 > timeoutMs) return resolve(d || null)
      setTimeout(tick, 300)
    }
    tick()
  })
  // 轮询直到某条诊断匹配（模板诊断可能比脚本诊断晚数秒到十几秒推送）
  const waitDiagMatch = (absPath, regex, timeoutMs = 35000) => new Promise((resolve) => {
    const key = normKey(pathUri(absPath))
    const t0 = Date.now()
    const tick = () => {
      const d = diagByUri.get(key) || []
      if (d.some((x) => regex.test(x.message))) return resolve(d)
      if (Date.now() - t0 > timeoutMs) return resolve(d)
      setTimeout(tick, 400)
    }
    tick()
  })

  try {
    // ---- 2) 启动 + initialize ----
    const startRes = await window.api.lsp.start('vue')
    log('lsp:start vue', startRes && startRes.ok && !!startRes.tsdk, 'tsdk=' + (startRes && startRes.tsdk) + ' already=' + !!(startRes && startRes.already))
    const init = await call('initialize', {
      processId: null,
      clientInfo: { name: 'cdp-smoke' },
      locale: 'zh-CN',
      rootPath: ROOT,
      rootUri: pathUri(ROOT),
      capabilities: {
        textDocument: {
          synchronization: { didSave: true },
          completion: { completionItem: { snippetSupport: true, documentationFormat: ['markdown'] } },
          hover: { contentFormat: ['markdown'] },
          definition: {}, references: {}, rename: { prepareSupport: true },
          documentFormatting: {}, codeAction: {}
        },
        workspace: { applyEdit: true }
      },
      initializationOptions: {
        typescript: { tsdk: startRes.tsdk, disableAutoImportCache: false },
        vue: { hybridMode: false }
      }
    })
    const caps = init.capabilities || {}
    log('initialize capabilities', !!(caps.completionProvider && caps.hoverProvider && caps.definitionProvider && caps.renameProvider && caps.documentFormattingProvider),
      'completion=' + !!caps.completionProvider + ' hover=' + !!caps.hoverProvider + ' def=' + !!caps.definitionProvider + ' rename=' + !!caps.renameProvider + ' fmt=' + !!caps.documentFormattingProvider)
    await notify('initialized', {})
    await sleep(2500)

    const appUri = pathUri(ROOT + '/src/App.vue')

    // ---- 3) App.vue 诊断：模板跨块 + 脚本 ----
    await openDoc(ROOT + '/src/App.vue', 'vue', APP)
    // 等模板诊断（toFixed）出现，末次数组为该文件累计诊断；脚本诊断在同一数组
    const appDiags = await waitDiagMatch(ROOT + '/src/App.vue', /toFixed/)
    const tplErr = appDiags.some((d) => /toFixed/.test(d.message))
    const scriptErr = appDiags.some((d) => /2322|不能将类型/.test(d.message))
    log('App.vue 模板跨块诊断(toFixed)', tplErr, 'count=' + appDiags.length)
    log('App.vue 脚本诊断(value=oops)', scriptErr, appDiags.map((d) => d.message.slice(0, 60)).join(' | '))

    // ---- 4) completion ----
    try {
      const cpos = posAt(APP, 'add(1, 2)')
      cpos.character += 3 // add( 之后
      const comp = await call('textDocument/completion', { textDocument: { uri: appUri }, position: cpos, context: { triggerKind: 1 } })
      const items = Array.isArray(comp) ? comp : (comp && comp.items) || []
      log('completion 补全', items.length > 20, 'items=' + items.length)
    } catch (e) { log('completion 补全', false, e.message) }

    // ---- 5) hover ----
    try {
      const hpos = posAt(APP, 'add(1, 2)')
      const hover = await call('textDocument/hover', { textDocument: { uri: appUri }, position: hpos })
      const md = hover && hover.contents
      const text = typeof md === 'string' ? md : (md && md.value) || (Array.isArray(md) ? JSON.stringify(md) : '')
      log('hover add', /add|function/.test(text), text.slice(0, 80))
    } catch (e) { log('hover add', false, e.message) }

    // ---- 6) definition vue -> ts ----
    try {
      const dpos = posAt(APP, 'add(1, 2)')
      const def = await call('textDocument/definition', { textDocument: { uri: appUri }, position: dpos })
      const loc = Array.isArray(def) ? def[0] : def
      const target = loc ? decodeURIComponent(loc.uri) : ''
      log('definition 跳转 vue->ts', /math\\.ts/.test(target), target)
    } catch (e) { log('definition 跳转 vue->ts', false, e.message) }

    // ---- 7) rename 跨文件：从 math.ts 声明处发起 ----
    const mathUri = pathUri(ROOT + '/src/math.ts')
    await openDoc(ROOT + '/src/math.ts', 'typescript', MATH)
    const collect = (ren) => ren && (ren.changes || (ren.documentChanges
      ? ren.documentChanges.reduce((acc, dc) => { acc[dc.textDocument.uri] = dc.edits; return acc }, {}) : null))
    try {
      const rpos = posAt(MATH, 'add(a: number')
      const ren = await call('textDocument/rename', { textDocument: { uri: mathUri }, position: rpos, newName: 'addRenamed' })
      const changes = collect(ren)
      const keys = changes ? Object.keys(changes).map((k) => decodeURIComponent(k)) : []
      const cross = keys.some((k) => /App\\.vue/.test(k)) && keys.some((k) => /math\\.ts/.test(k))
      log('rename 跨文件(声明处→App.vue+math.ts)', cross, keys.join(' | '))
    } catch (e) { log('rename 跨文件(声明处→App.vue+math.ts)', false, e.message) }

    // 已知上游行为：从导入使用方 rename → 仅本地别名（TS providePrefixAndSuffixTextForRename 默认开启）
    try {
      const rpos = posAt(APP, 'add(1, 2)')
      const ren = await call('textDocument/rename', { textDocument: { uri: appUri }, position: rpos, newName: 'addAlias' })
      const changes = collect(ren)
      const keys = changes ? Object.keys(changes).map((k) => decodeURIComponent(k)) : []
      const aliasOnly = keys.some((k) => /App\\.vue/.test(k)) && !keys.some((k) => /math\\.ts/.test(k))
      log('rename 使用方仅本地别名(上游TS行为)', aliasOnly, keys.join(' | '))
    } catch (e) { log('rename 使用方仅本地别名(上游TS行为)', false, e.message) }

    // ---- 8) formatting ----
    try {
      const edits = await call('textDocument/formatting', { textDocument: { uri: appUri }, options: { tabSize: 2, insertSpaces: true } })
      log('formatting 格式化', Array.isArray(edits), 'edits=' + (edits ? edits.length : 'null'))
    } catch (e) { log('formatting 格式化', false, e.message) }

    // ---- 9) 中文路径诊断 ----
    await openDoc(ROOT + '/中文组件/Panel.vue', 'vue', PANEL)
    const cnDiags = await waitErrorDiag(ROOT + '/中文组件/Panel.vue')
    log('中文路径 Panel.vue 诊断', cnDiags && cnDiags.some((d) => /number|string|不能将/.test(d.message)),
      cnDiags ? cnDiags.map((d) => d.message.slice(0, 60)).join(' | ') : 'null')

    // ---- 10) Take Over 下 .ts 诊断 ----
    await openDoc(ROOT + '/src/bad.ts', 'typescript', BADTS)
    const tsDiags = await waitErrorDiag(ROOT + '/src/bad.ts')
    log('Take Over .ts 诊断(bad.ts)', tsDiags && tsDiags.some((d) => /hello|number|string|不能将/.test(d.message)),
      tsDiags ? tsDiags.map((d) => d.message.slice(0, 60)).join(' | ') : 'null')
  } catch (e) {
    log('vue 协议流程异常', false, e.message)
  }

  // ---- 11) 停止 vue ----
  try {
    const s = await window.api.lsp.stop('vue')
    log('lsp:stop vue', s && s.ok, JSON.stringify(s))
  } catch (e) { log('lsp:stop vue', false, e.message) }

  report.pass = report.steps.filter((s) => s.ok).length
  report.total = report.steps.length
  return report
})()
`

const VUE_ROOT = process.argv[2] || 'D:/smoke-vue-lsp'
const TS_ROOT = process.argv[3] || 'D:/smoke-ts-only'

const main = async () => {
  const wsUrl = await getPageWs()
  console.log('[1] 已定位渲染进程 vueRoot=' + VUE_ROOT)
  const cdp = await connect(wsUrl)
  const code = PAGE_CODE.replace('__VUE_ROOT__', VUE_ROOT).replace('__TS_ROOT__', TS_ROOT)
  const report = await evaluate(cdp, code, true, 120000)
  for (const s of report.steps) {
    console.log((s.ok ? 'PASS' : 'FAIL') + ' | ' + s.name + ' | ' + s.detail)
  }
  console.log('---')
  console.log(report.pass + '/' + report.total + ' 通过')
  cdp.close()
  if (report.pass !== report.total) process.exit(1)
}

main().catch((e) => { console.error('测试失败:', e.message); process.exit(1) })
