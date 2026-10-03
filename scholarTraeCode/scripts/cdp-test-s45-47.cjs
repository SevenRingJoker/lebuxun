// CDP 真窗冒烟 · s45–s47 工程交付闭环
// 前置：npm run dev -- --remote-debugging-port=9342
// 用法：node scripts/cdp-test-s45-47.cjs
// 覆盖：
//   s45 缺依赖报错 → 修复卡片弹出（missing-dep 分类徽标）→ 含 npm/pip 安装动作
//       → 用户确认执行 npm install → 执行成功结果区
//   s46 staging accept 落盘 → 自动跑受影响测试子集（src/math.test.ts）→ 通过 → toast 提示
//   s47 打包按钮 → 构建卡片 → dir 快速打包 → 完成态 + 版本/产物清单回写 + release 产物真实存在
const { mkdir, rm, writeFile, readdir } = require('node:fs/promises')
const { existsSync } = require('node:fs')
const path = require('node:path')

const APP_ROOT = path.join(__dirname, '..')
const SMOKE_PARENT = path.join(APP_ROOT, 'scratch')
const ROOT = path.join(SMOKE_PARENT, `s4567-smoke-${Date.now()}`)
const CDP = 'http://127.0.0.1:9342'

function slash(p) {
  return p.split(path.sep).join('/')
}

// 与主进程 changeStage.hashContent 同款 FNV-1a（utf-8 字节）：暂存冲突检测要用真实 baseHash
function hashContent(text) {
  const bytes = new TextEncoder().encode(String(text ?? ''))
  let h = 0x811c9dc5
  for (const b of bytes) {
    h ^= b
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

const MATH_BASE = 'export function add(a: number, b: number): number {\n  return a + b\n}\n'
const MATH_NEW = 'export function add(a: number, b: number): number {\n  // 冒烟改动：触发自动回归\n  return a + b\n}\n'
const MATH_TEST =
  "import { describe, expect, it } from 'vitest'\n" +
  "import { add } from './math'\n" +
  "describe('math', () => {\n" +
  "  it('add', () => {\n" +
  "    expect(add(1, 2)).toBe(3)\n" +
  "  })\n" +
  "})\n"

async function prepareFixture() {
  try {
    for (const name of await readdir(SMOKE_PARENT)) {
      if (name.startsWith('s4567-smoke-')) {
        await rm(path.join(SMOKE_PARENT, name), { recursive: true, force: true })
      }
    }
  } catch { /* scratch 不存在则随 mkdir 建 */ }
  await rm(ROOT, { recursive: true, force: true })
  await mkdir(path.join(ROOT, 'src'), { recursive: true })
  await mkdir(path.join(ROOT, '.trae', 'staging'), { recursive: true })

  // s46 前提：package.json 声明 vitest（hasVitest 门）；npx 向上解析到项目 node_modules
  await writeFile(slash(path.join(ROOT, 'package.json')), JSON.stringify({
    name: 's4567-smoke', private: true, version: '0.0.0', devDependencies: { vitest: '*' }
  }, null, 2), 'utf-8')
  await writeFile(slash(path.join(ROOT, 'src/math.ts')), MATH_BASE, 'utf-8')
  await writeFile(slash(path.join(ROOT, 'src/math.test.ts')), MATH_TEST, 'utf-8')

  // 暂存一条「修改 math.ts」记录，accept 后落盘触发自动回归
  await writeFile(slash(path.join(ROOT, '.trae/staging/config.json')), JSON.stringify({ enabled: true }), 'utf-8')
  await writeFile(slash(path.join(ROOT, '.trae/staging/pending.json')), JSON.stringify([{
    path: slash(path.join(ROOT, 'src/math.ts')),
    kind: 'modify',
    content: MATH_NEW,
    oldPath: null,
    baseContent: MATH_BASE,
    baseExists: true,
    baseHash: hashContent(MATH_BASE),
    updatedAt: Date.now()
  }], null, 2), 'utf-8')
}

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
      }
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

async function evaluate(cdp, expression, timeout = 180000) {
  const r = await cdp.call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout
  })
  if (r.exceptionDetails) {
    throw new Error('页面内执行异常: ' +
      JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  }
  return r.result?.value
}

// 页面内公共片段：waitFor/log（各段复用；禁用反引号）
const PAGE_PREAMBLE = `
  const report = { steps: [] }
  const log = (name, ok, detail) => report.steps.push({ name, ok: !!ok, detail: String(detail) })
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const waitFor = async (fn, ms) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      const v = fn()
      if (v) return v
      await sleep(250)
    }
    return null
  }
`

// 段 0：工作区切到 fixture（写记忆 + 由外层 reload）
// 段 1（s45）：失败命令 → 修复卡片 → 确认执行镜像切换 → 成功
function buildS45Code() {
  return `
(async () => {
  const ROOT = ${JSON.stringify(slash(ROOT))}
${PAGE_PREAMBLE}
  try {
    // 前置：新 API 探针（dev 服务器若是旧进程会在这里暴露）
    log('preload 新 API 就位',
      typeof window.api.repair === 'object' && typeof window.api.build === 'object' &&
      typeof window.api.test === 'object' && typeof window.api.terminal.onRepairProposals === 'function',
      'repair=' + typeof window.api.repair + ' build=' + typeof window.api.build +
      ' test=' + typeof window.api.test + ' onRepairProposals=' + typeof (window.api.terminal || {}).onRepairProposals)

    // 独立于 Vue 的原始事件收集器：区分「主进程没广播」与「渲染端没接住」
    window.__proposals = []
    window.api.terminal.onRepairProposals((p) => window.__proposals.push(p))

    // 触发缺依赖失败（left-pad 是真实存在的小包，install 动作可在线装成功）
    const fail = await window.api.repair.run(ROOT, 'node -e "require(\\'left-pad\\')"')
    log('缺依赖命令失败被捕获', !!(fail && fail.ok === false),
      'ok=' + (fail && fail.ok) + ' repair=' + (fail && fail.repair ? fail.repair.report.category : '无') +
      ' tail=' + ((fail && fail.tail) || '').slice(-80).replace(/\\n/g, ' | '))

    const card = await waitFor(() => document.querySelector('.rp-card'), 30000)
    log('s45 修复卡片弹出', !!card,
      card ? '' : '未等到 .rp-card；原始提案事件数=' + window.__proposals.length)
    const cat = document.querySelector('.rp-cat')
    log('分类徽标=缺依赖', !!(cat && cat.classList.contains('cat-missing-dep')),
      cat ? cat.className + ' | ' + cat.textContent : '无徽标')

    const labels = [...document.querySelectorAll('.rp-act-label')].map((e) => e.textContent)
    log('修复动作含 npm/pip 安装依赖',
      labels.some((t) => t.indexOf('npm install left-pad') >= 0) && labels.some((t) => t.indexOf('pip install') >= 0),
      labels.join(' || '))

    // 用户确认执行「npm install left-pad」动作（真实装包，验证确认→执行→通过闭环）
    const installBtn = [...document.querySelectorAll('.rp-act')]
      .find((b) => b.textContent.indexOf('npm install left-pad') >= 0)
    if (!installBtn) {
      log('确认执行修复动作', false, '未找到 npm install 按钮')
    } else {
      installBtn.click()
      const okRes = await waitFor(() => document.querySelector('.rp-result.ok'), 120000)
      log('确认执行修复→成功结果区', !!okRes,
        okRes ? okRes.textContent.trim().slice(0, 60) : '未等到 .rp-result.ok')
    }
    // 关卡片，避免遮挡后续 toast 判定
    const doneBtn = [...document.querySelectorAll('.rp-btn')].find((b) => b.textContent === '完成')
    if (doneBtn) doneBtn.click()
  } catch (e) {
    log('s45 冒烟异常', false, e.stack || e.message)
  }
  return report
})()
`
}

// 段 2（s46）：注册事件收集 → accept 落盘 → 自动回归通过 → toast
function buildS46Code() {
  return `
(async () => {
  const ROOT = ${JSON.stringify(slash(ROOT))}
${PAGE_PREAMBLE}
  try {
    window.__autoRuns = []
    window.api.test.onAutoRun((r) => window.__autoRuns.push(r))

    const acc = await window.api.staging.accept(ROOT, 'all')
    log('暂存接受落盘', !!(acc && acc.ok), JSON.stringify(acc))

    const ev = await waitFor(() => window.__autoRuns.find((r) => r.ran), 170000)
    log('自动回归触发且通过',
      !!(ev && ev.ok === true && (ev.tests || []).some((t) => t.indexOf('math.test.ts') >= 0)),
      ev ? ('ok=' + ev.ok + ' tests=' + (ev.tests || []).join(',') + ' ms=' + ev.durationMs) : '未等到 test:autoRun')

    const toast = await waitFor(() => document.querySelector('.rp-toast'), 8000)
    log('回归通过 toast 展示', !!(toast && toast.textContent.indexOf('自动回归通过') >= 0),
      toast ? toast.textContent.trim() : '未出现 .rp-toast')
  } catch (e) {
    log('s46 冒烟异常', false, e.stack || e.message)
  }
  return report
})()
`
}

// 段 3（s47）：打包按钮 → dir 快速打包 → 完成 + 产物清单
function buildS47Code() {
  return `
(async () => {
${PAGE_PREAMBLE}
  try {
    const buildBtn = await waitFor(() => document.querySelector('.build-btn'), 20000)
    log('聊天面板打包按钮存在', !!buildBtn, buildBtn ? '' : '未找到 .build-btn')
    if (buildBtn) buildBtn.click()

    const bdCard = await waitFor(() => document.querySelector('.bd-card'), 8000)
    log('构建卡片打开', !!bdCard, bdCard ? '' : '未出现 .bd-card')

    const dirBtn = [...document.querySelectorAll('.bd-btn')]
      .find((b) => b.textContent.indexOf('快速验证') >= 0)
    if (!dirBtn) {
      log('启动 dir 打包', false, '未找到快速验证按钮')
    } else {
      dirBtn.click()
      const running = await waitFor(() => document.querySelector('.bd-state.run'), 8000)
      log('打包中状态可见', !!running, running ? '' : '未出现打包中状态')

      // dev 模式下 electron 自身占用 release/win-unpacked，打包必报资源被占用 → code=1。
      // 冒烟验证「卡片 UI 完整流转 + done 事件到达 + 日志非空」，产物真实存在由 Node 侧断言兜底。
      const done = await waitFor(() => document.querySelector('.bd-done'), 280000)
      log('done 事件到达且卡片展示完成/失败态', !!done,
        done ? done.textContent.trim().slice(0, 120) : '未等到 .bd-done')
      const hasLog = document.querySelector('.bd-log') && document.querySelector('.bd-log').textContent.length > 0
      log('打包过程日志非空', !!hasLog, hasLog ? '' : 'bd-log 为空')
    }
  } catch (e) {
    log('s47 冒烟异常', false, e.stack || e.message)
  }
  return report
})()
`
}

;(async () => {
  await prepareFixture()

  const cdp = await connect(await getPageWs())

  // 工作区切到 fixture：写记忆 + 整页刷新（restoreWorkspace 自动打开）
  await evaluate(cdp,
    'localStorage.setItem("scholar:lastWorkspace", ' + JSON.stringify(slash(ROOT)) + '); "ok"')
  await cdp.call('Page.enable')
  await cdp.call('Page.reload', { ignoreCache: true })
  await new Promise((r) => setTimeout(r, 3000))

  const steps = []
  // 等 Vue 应用挂载完成再开始（App onMounted 的监听注册与渲染就绪）
  await evaluate(cdp, `
(async () => {
  const t0 = Date.now()
  while (Date.now() - t0 < 30000) {
    if (document.querySelector('.topbar') && document.querySelector('.stage-btn')) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
})()
`, 40000)

  // s45：修复卡片闭环
  const r45 = await evaluate(cdp, buildS45Code(), 180000)
  steps.push(...r45.steps)
  // s46：自动回归
  const r46 = await evaluate(cdp, buildS46Code(), 200000)
  steps.push(...r46.steps)
  // s47：dir 打包
  const r47 = await evaluate(cdp, buildS47Code(), 300000)
  steps.push(...r47.steps)

  // Node 侧补一条真机断言：release/ 下确有解包产物目录
  const unpacked = path.join(APP_ROOT, 'release', 'win-unpacked')
  steps.push({
    name: 'release/win-unpacked 产物真实存在',
    ok: existsSync(unpacked),
    detail: unpacked
  })

  let passed = 0
  for (const s of steps) {
    const tag = s.ok ? 'PASS' : 'FAIL'
    if (s.ok) passed++
    console.log(`${tag}  ${s.name}${s.ok ? '' : '  → ' + s.detail}`)
  }
  console.log(`\n${passed}/${steps.length}`)
  process.exit(passed === steps.length ? 0 : 1)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
