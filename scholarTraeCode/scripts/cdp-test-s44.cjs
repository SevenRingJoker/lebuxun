// CDP 真窗冒烟 · s42–s44 代码库理解（工具注册 + 变更集三档分类）
// 前置：npm run dev -- --remote-debugging-port=9342
// 用法：node scripts/cdp-test-s44.cjs [fixture目录]
// 覆盖：
//   s42 find_references / symbol_outline 工具注册进模型可见清单（ai:listTools）
//   s43 set_anchors / check_alignment 工具注册；anchors.json 被分类链路消费
//   s44 staging:classify —— 锚点命中→高风险、删除→高风险、引用面≥10→高风险、
//       计划点名→需求、其余→顺带（索引/锚点/计划三路输入真机走通）
const { mkdir, rm, writeFile, readdir } = require('node:fs/promises')
const path = require('node:path')

const SMOKE_PARENT = path.join(__dirname, '..', 'scratch')
const ROOT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(SMOKE_PARENT, `s44-smoke-${Date.now()}`)
const CDP = 'http://127.0.0.1:9342'

function slash(p) {
  return p.split(path.sep).join('/')
}

async function prepareFixture() {
  try {
    for (const name of await readdir(SMOKE_PARENT)) {
      if (name.startsWith('s44-smoke-')) {
        await rm(path.join(SMOKE_PARENT, name), { recursive: true, force: true })
      }
    }
  } catch { /* scratch 不存在则随 mkdir 建 */ }
  await rm(ROOT, { recursive: true, force: true })
  await mkdir(path.join(ROOT, 'src', 'core'), { recursive: true })
  await mkdir(path.join(ROOT, 'src', 'shared'), { recursive: true })

  // 源码：核心模块 + 引用方 + 高引用类型文件（10 个引用方触发 risky 阈值）
  await writeFile(slash(path.join(ROOT, 'src/core/engine.ts')),
    'export function engine() { return 1 }\nexport function helper() { return 2 }\n', 'utf-8')
  await writeFile(slash(path.join(ROOT, 'src/a.ts')),
    "import { engine } from './core/engine'\nengine()\n", 'utf-8')
  await writeFile(slash(path.join(ROOT, 'src/shared/types.ts')),
    'export type ID = string\n', 'utf-8')
  for (let i = 1; i <= 10; i++) {
    const n = String(i).padStart(2, '0')
    await writeFile(slash(path.join(ROOT, `src/f${n}.ts`)),
      `import type { ID } from './shared/types'\nexport const v${n}: ID = 'x'\n`, 'utf-8')
  }
  await writeFile(slash(path.join(ROOT, 'src/App.vue')), '<template><div /></template>\n', 'utf-8')

  // s43 锚点：禁改 engine.ts + 不可删符号 engine
  await mkdir(path.join(ROOT, '.trae', 'staging'), { recursive: true })
  await mkdir(path.join(ROOT, '.trae', 'tasks'), { recursive: true })
  await writeFile(slash(path.join(ROOT, '.trae/anchors.json')), JSON.stringify({
    protectedPaths: ['src/core/engine.ts'],
    protectedSymbols: [{ name: 'engine' }],
    notes: '核心模块冻结'
  }, null, 2), 'utf-8')

  // 暂存 4 条：删除锚点文件 / 修改高引用文件 / 修改计划点名文件 / 新建计划外文件
  await writeFile(slash(path.join(ROOT, '.trae/staging/config.json')), JSON.stringify({ enabled: true }), 'utf-8')
  const engineAbs = slash(path.join(ROOT, 'src/core/engine.ts'))
  const typesAbs = slash(path.join(ROOT, 'src/shared/types.ts'))
  const appAbs = slash(path.join(ROOT, 'src/App.vue'))
  const noteAbs = slash(path.join(ROOT, 'src/misc/note.md'))
  const rec = (p, kind, content, base) => ({
    path: p, kind, content, oldPath: null,
    baseContent: base, baseExists: base !== null, baseHash: '', updatedAt: 1790900000000
  })
  await writeFile(slash(path.join(ROOT, '.trae/staging/pending.json')), JSON.stringify([
    rec(engineAbs, 'delete', null, 'export function engine() { return 1 }\n'),
    rec(typesAbs, 'modify', 'export type ID = string | number\n', 'export type ID = string\n'),
    rec(appAbs, 'modify', '<template><div>改</div></template>\n', '<template><div /></template>\n'),
    rec(noteAbs, 'create', '# 笔记\n', null)
  ], null, 2), 'utf-8')

  // 最近任务快照：计划点名 App.vue（direct 判定来源）
  await writeFile(slash(path.join(ROOT, '.trae/tasks/task-smoke.json')), JSON.stringify({
    schemaVersion: 1,
    taskId: 'task-smoke',
    workspace: ROOT,
    modelId: 'smoke:model',
    sessionId: null,
    status: 'completed',
    userRequest: '修改 src/App.vue 布局',
    startRound: 0,
    convo: [{ role: 'user', content: '修改 src/App.vue 布局' }],
    ctx: { plan: '修改 src/App.vue 布局与样式', createdFiles: [] },
    todoSeq: 0,
    todos: [],
    replan: { consecutiveFailures: 0, replanCount: 0, signals: [] },
    executed: [],
    counters: { stallCount: 0, stallRestarts: 0, dedupStallCount: 0 },
    preTaskCheckpoint: null,
    stagedChanges: null,
    startedAt: 1790900000000,
    updatedAt: 1790900000000
  }), 'utf-8')

  return { engineAbs, typesAbs, appAbs, noteAbs }
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

async function evaluate(cdp, expression) {
  const r = await cdp.call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout: 120000
  })
  if (r.exceptionDetails) {
    throw new Error('页面内执行异常: ' +
      JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  }
  return r.result?.value
}

function buildPageCode(paths) {
  // 页面内禁用反引号；换行用 \n 转义
  return `
(async () => {
  const ROOT = ${JSON.stringify(slash(ROOT))}
  const report = { steps: [] }
  const log = (name, ok, detail) => report.steps.push({ name, ok: !!ok, detail: String(detail) })

  try {
    // ---- 1) s42/s43 四个工具注册进模型可见清单 ----
    const tools = await window.api.ai.listTools()
    const names = new Set(tools.map((t) => t.name))
    const want = ['find_references', 'symbol_outline', 'set_anchors', 'check_alignment']
    log('四工具注册', want.every((n) => names.has(n)), 'missing=' + want.filter((n) => !names.has(n)).join(','))

    // ---- 2) 索引构建（强制重建，分类链路依赖） ----
    const idx = await window.api.ai.ensureIndex(ROOT, true)
    log('索引构建', idx.ok === true && idx.total >= 13, 'total=' + idx.total)

    // ---- 3) s44 三档分类 ----
    const cls = await window.api.staging.classify(ROOT)
    const pick = (suffix) => {
      const k = Object.keys(cls).find((p) => p.split('\\\\').join('/').endsWith(suffix))
      return k ? cls[k] : null
    }
    const vEngine = pick('src/core/engine.ts')
    const vTypes = pick('src/shared/types.ts')
    const vApp = pick('src/App.vue')
    const vNote = pick('src/misc/note.md')
    log('锚点命中→高风险', vEngine && vEngine.cls === 'risky' && vEngine.reason.indexOf('锚点') >= 0,
      vEngine ? vEngine.cls + ' | ' + vEngine.reason : 'missing')
    log('高引用→高风险', vTypes && vTypes.cls === 'risky' && vTypes.reason.indexOf('10') >= 0,
      vTypes ? vTypes.cls + ' | ' + vTypes.reason : 'missing')
    log('计划点名→需求', vApp && vApp.cls === 'direct',
      vApp ? vApp.cls + ' | ' + vApp.reason : 'missing')
    log('计划外新建→顺带', vNote && vNote.cls === 'incidental',
      vNote ? vNote.cls + ' | ' + vNote.reason : 'missing')
  } catch (e) {
    log('冒烟异常', false, e.stack || e.message)
  }
  return report
})()
`
}

// 第 4 段 UI 渲染验证单独一轮：先写工作区记忆 + 刷新页面，
// 应用重启后经 restoreWorkspace 打开 fixture，再点暂存按钮数徽标
function buildUiCode() {
  // 页面内禁用反引号
  return `
(async () => {
  const report = { steps: [] }
  const log = (name, ok, detail) => report.steps.push({ name, ok: !!ok, detail: String(detail) })
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const waitFor = async (fn, ms) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      const v = fn()
      if (v) return v
      await sleep(200)
    }
    return null
  }
  try {
    const btn = await waitFor(() => document.querySelector('.stage-btn'), 20000)
    log('暂存按钮存在', !!btn, btn ? '' : '未找到 .stage-btn')
    if (btn) {
      btn.click()
      await waitFor(() => document.querySelectorAll('.sp-item').length >= 4, 15000)
      await waitFor(() => document.querySelectorAll('.sp-cls').length >= 4, 15000)
      const direct = document.querySelectorAll('.sp-cls.c-direct').length
      const incidental = document.querySelectorAll('.sp-cls.c-incidental').length
      const risky = document.querySelectorAll('.sp-cls.c-risky').length
      log('徽标渲染 direct=1 incidental=1 risky=2',
        direct === 1 && incidental === 1 && risky === 2,
        'direct=' + direct + ' incidental=' + incidental + ' risky=' + risky)
      const dimmed = document.querySelectorAll('.sp-item.cls-incidental').length
      const riskyRow = document.querySelectorAll('.sp-item.cls-risky').length
      log('顺带淡化/高风险描边行样式', dimmed === 1 && riskyRow === 2, 'dimmed=' + dimmed + ' riskyRow=' + riskyRow)
    }
  } catch (e) {
    log('UI 冒烟异常', false, e.stack || e.message)
  }
  return report
})()
`
}

;(async () => {
  await prepareFixture()
  const cdp = await connect(await getPageWs())
  // 数据层：工具注册 / 索引 / 三档分类
  const report = await evaluate(cdp, buildPageCode())
  // UI 层：写入工作区记忆后整页刷新，restoreWorkspace 自动打开 fixture
  await evaluate(cdp,
    'localStorage.setItem("scholar:lastWorkspace", ' + JSON.stringify(slash(ROOT)) + '); "ok"')
  await cdp.call('Page.enable')
  await cdp.call('Page.reload', { ignoreCache: true })
  await new Promise((r) => setTimeout(r, 2500))
  const uiReport = await evaluate(cdp, buildUiCode())
  report.steps.push(...uiReport.steps)
  let passed = 0
  for (const s of report.steps) {
    const tag = s.ok ? 'PASS' : 'FAIL'
    if (s.ok) passed++
    console.log(`${tag}  ${s.name}${s.ok ? '' : '  → ' + s.detail}`)
  }
  console.log(`\n${passed}/${report.steps.length}`)
  process.exit(passed === report.steps.length ? 0 : 1)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
