// CDP 真窗冒烟 · s48–s50 Agent 工作流可视化与可控性
// 前置：npm run dev -- --remote-debugging-port=9342
// 用法：node scripts/cdp-test-s48-50.cjs
// 覆盖：
//   s48 真实小任务（read 工具）→ 时间线步骤录制（理由/耗时/状态）
//       → 时间线抽屉渲染/展开 → 从此步重跑（rerunFromStep 快照续跑）
//   s49 真实写文件任务 → 落盘一张 doing 看板卡 → 整页刷新载入
//       → 卡片「回滚」→ 文件消失、卡片回待办
//   s50 dispatchFromCards 双角色 Agent 并行 → 两个 start 先于首个 done
//       → 各自产物正确不串扰 + 汇总裁决报告非空
const { mkdir, rm, writeFile, readFile } = require('node:fs/promises')
const { existsSync } = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const APP_ROOT = path.join(__dirname, '..')
const SMOKE_PARENT = path.join(APP_ROOT, 'scratch')
const ROOT = path.join(SMOKE_PARENT, `s4850-smoke-${Date.now()}`)
const CDP = 'http://127.0.0.1:9342'

function slash(p) {
  return p.split(path.sep).join('/')
}

async function prepareFixture() {
  try {
    for (const name of await require('node:fs/promises').readdir(SMOKE_PARENT)) {
      if (name.startsWith('s4850-smoke-')) {
        await rm(path.join(SMOKE_PARENT, name), { recursive: true, force: true })
      }
    }
  } catch { /* scratch 不存在则随 mkdir 建 */ }
  await rm(ROOT, { recursive: true, force: true })
  await mkdir(path.join(ROOT, '.trae'), { recursive: true })
  await writeFile(path.join(ROOT, 'readme.txt'), 's48 冒烟工作区：读取我来验证时间线录制。\n', 'utf-8')

  // 回滚依赖任务前检查点：初始 Git 提交作为兜底基线
  execFileSync('git', ['init'], { cwd: ROOT, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 'smoke@local'], { cwd: ROOT, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 'smoke'], { cwd: ROOT, stdio: 'ignore' })
  execFileSync('git', ['add', '.'], { cwd: ROOT, stdio: 'ignore' })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: ROOT, stdio: 'ignore' })
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

// 页面内公共片段：上报/等待/UI 发消息（禁用反引号）
const PAGE_PREAMBLE = `
  const report = { steps: [], taskId: null }
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
  // 通过真实聊天 UI 发任务：原生 setter 触发 Vue v-model，点发送并等任务跑完
  const sendChat = async (text) => {
    const ta = document.querySelector('.composer-input')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, text)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(120)
    document.querySelector('.send-square:not(.stop-square)').click()
    await waitFor(() => document.querySelector('.send-square.stop-square'), 10000)
    await waitFor(() => !document.querySelector('.send-square.stop-square'), 300000)
  }
  const headerBtn = (label) => [...document.querySelectorAll('button')]
    .find((b) => b.textContent.trim() === label)
`

// 段 1（s48）：read 小任务 → 时间线录制 → 抽屉渲染/展开 → 从此步重跑
function buildS48Code() {
  return `
(async () => {
  const ROOT = ${JSON.stringify(slash(ROOT))}
${PAGE_PREAMBLE}
  try {
    await window.api.ai.setPermissionMode('auto')
    window.__tl48 = []
    window.api.ai.onTimelineUpdate((p) => window.__tl48.push(p))

    await sendChat('请使用 read 工具读取本工作区根目录的 readme.txt 文件，然后用一句话总结内容，不要修改任何文件。')

    const filled = await waitFor(
      () => window.__tl48.filter((p) => p.steps && p.steps.length).slice(-1)[0],
      60000
    )
    report.taskId = filled ? filled.taskId : null
    log('时间线广播到达且含步骤', !!filled,
      filled ? ('taskId=' + filled.taskId + ' steps=' + filled.steps.length) : '无有效 payload')

    const readStep = filled && filled.steps.find((s) =>
      s.name === 'read' || s.name === 'read_file' || s.name === 'read_text_file')
    log('录制到 read 步骤且状态成功', !!(readStep && readStep.status === 'ok'),
      readStep ? (readStep.name + ' R' + readStep.round + ' dur=' + readStep.durationMs + 'ms') : '未找到 read 步骤')
    log('步骤字段完整（理由/标题/结果）',
      !!(readStep && typeof readStep.reason === 'string' && readStep.reason.length > 0 &&
         typeof readStep.title === 'string'),
      readStep ? ('理由=' + readStep.reason.slice(0, 60)) : '缺字段')

    headerBtn('时间线').click()
    await waitFor(() => document.querySelector('.tl-panel'), 5000)
    const rows = document.querySelectorAll('.tl-step').length
    log('时间线抽屉渲染步骤行', rows >= filled.steps.length, '面板行数=' + rows)

    document.querySelector('.tl-row').click()
    const detail = await waitFor(() => document.querySelector('.tl-detail'), 3000)
    log('点击步骤展开理由/改动/结果', !!detail,
      detail ? detail.textContent.slice(0, 80).replace(/\\n/g, ' ') : '未展开')
    document.querySelector('.tl-x').click()

    // 从此步重跑：载快照 → 从第 0 轮续跑（真实再跑一遍只读任务）
    const rr = await window.api.ai.rerunFromStep(ROOT, filled.taskId, 0)
    log('从此步重跑成功（快照续跑闭环）', !!(rr && rr.ok),
      rr ? ('ok=' + rr.ok + (rr.error ? ' err=' + rr.error : '')) : '无返回')
  } catch (e) {
    log('s48 冒烟异常', false, e.stack || e.message)
  }
  return report
})()
`
}

// 段 2（s49 前半）：真实写文件任务，返回 taskId 供 Node 落看板卡
function buildS49WriteCode() {
  return `
(async () => {
  const ROOT = ${JSON.stringify(slash(ROOT))}
${PAGE_PREAMBLE}
  try {
    window.__tl49 = []
    window.api.ai.onTimelineUpdate((p) => window.__tl49.push(p))

    await sendChat('请在工作区根目录创建文件 rollback-probe.txt，文件内容恰好为 hello，创建完成后立即结束，不要创建其他文件。')

    const filled = await waitFor(
      () => window.__tl49.filter((p) => p.steps && p.steps.some((s) => s.status === 'ok')).slice(-1)[0],
      60000
    )
    report.taskId = filled ? filled.taskId : null
    const writeStep = filled && filled.steps.find((s) =>
      ['write', 'edit', 'write_file', 'edit_file'].includes(s.name))
    log('写文件任务完成', !!writeStep,
      writeStep ? ('tool=' + writeStep.name + ' 改动=' + writeStep.diffSummary.slice(0, 60)) : '未找到写步骤')
  } catch (e) {
    log('s49 写任务冒烟异常', false, e.stack || e.message)
  }
  return report
})()
`
}

// 段 3（s49 后半）：刷新载入预置 doing 卡 → 回滚 → 卡片回待办
function buildS49RollbackCode() {
  return `
(async () => {
${PAGE_PREAMBLE}
  try {
    headerBtn('看板').click()
    await waitFor(() => document.querySelector('.kb-panel'), 5000)
    const card = await waitFor(() => document.querySelector('.col-doing .kb-card'), 5000)
    log('预置 doing 卡片载入',
      !!(card && card.querySelector('.kb-sid').textContent === 'kb-rb-1'),
      card ? card.querySelector('.kb-sid').textContent : '待办列无卡片')

    const danger = card.querySelector('button.kb-op.danger')
    danger.click()
    const back = await waitFor(
      () => [...document.querySelectorAll('.col-todo .kb-sid')].find((e) => e.textContent === 'kb-rb-1'),
      60000
    )
    log('卡片回滚成功并回到待办列', !!back, back ? '' : '卡片未回到待办')
  } catch (e) {
    log('s49 回滚冒烟异常', false, e.stack || e.message)
  }
  return report
})()
`
}

// 段 4（s50）：双角色 Agent 并行分派 → 产物 + 汇总报告
function buildS50Code() {
  return `
(async () => {
  const ROOT = ${JSON.stringify(slash(ROOT))}
${PAGE_PREAMBLE}
  try {
    window.__subs = []
    window.api.ai.onSubagentUpdate((p) => window.__subs.push(p))

    const cards = [
      { sid: 's50-a', role: 'frontend',
        title: '在工作区根目录创建文件 agent-a.txt，文件内容只有一行：ALPHA。只创建这一个文件。' },
      { sid: 's50-b', role: 'backend',
        title: '在工作区根目录创建文件 agent-b.txt，文件内容只有一行：BETA。只创建这一个文件。' }
    ]
    const r = await window.api.ai.dispatchFromCards(ROOT, cards)
    log('双 Agent 分派返回成功', !!(r && r.ok),
      r ? ('ok=' + r.ok + (r.error ? ' err=' + r.error : '')) : '无返回')

    const starts = window.__subs.filter((p) => p.phase === 'start').length
    const firstDone = window.__subs.findIndex((p) => p.phase === 'done')
    const startsBeforeDone = window.__subs.slice(0, firstDone < 0 ? undefined : firstDone)
      .filter((p) => p.phase === 'start').length
    log('两个子代理真实并行（首个完成前已双启动）', starts >= 2 && startsBeforeDone >= 2,
      'start 总数=' + starts + '，首个 done 前 start=' + startsBeforeDone)

    log('汇总裁决/验收合并报告非空', !!(r && r.report && r.report.length > 20),
      r && r.report ? r.report.slice(0, 100).replace(/\\n/g, ' ') : '无报告')
  } catch (e) {
    log('s50 冒烟异常', false, e.stack || e.message)
  }
  return report
})()
`
}

;(async () => {
  await prepareFixture()

  const cdp = await connect(await getPageWs())

  // 工作区切到 fixture：写记忆 + 整页刷新
  await evaluate(cdp,
    'localStorage.setItem("scholar:lastWorkspace", ' + JSON.stringify(slash(ROOT)) + '); "ok"')
  await cdp.call('Page.enable')
  await cdp.call('Page.reload', { ignoreCache: true })
  await new Promise((r) => setTimeout(r, 3000))

  // 等 Vue 应用挂载
  await evaluate(cdp, `
(async () => {
  const t0 = Date.now()
  while (Date.now() - t0 < 30000) {
    if (document.querySelector('.topbar') && document.querySelector('.composer-input')) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
})()
`, 40000)

  const steps = []

  // s48
  const r48 = await evaluate(cdp, buildS48Code(), 300000)
  steps.push(...r48.steps)

  // s49 前半：真实写文件任务
  const r49a = await evaluate(cdp, buildS49WriteCode(), 300000)
  steps.push(...r49a.steps)
  const probeFile = path.join(ROOT, 'rollback-probe.txt')
  steps.push({
    name: '回滚前 rollback-probe.txt 真实存在',
    ok: existsSync(probeFile),
    detail: probeFile
  })

  // Node 侧预置一张绑定该任务的 doing 看板卡，刷新后由看板载入
  const kanbanFile = {
    schemaVersion: 1,
    workspace: slash(ROOT),
    updatedAt: Date.now(),
    cards: [{
      sid: 'kb-rb-1',
      taskId: r49a.taskId,
      title: '创建 rollback-probe.txt',
      status: 'doing',
      priority: 'P1',
      evidence: [],
      pauseRequested: false,
      rolledBack: false
    }]
  }
  await writeFile(path.join(ROOT, '.trae', 'kanban.json'), JSON.stringify(kanbanFile, null, 2), 'utf-8')
  await cdp.call('Page.reload', { ignoreCache: true })
  await new Promise((r) => setTimeout(r, 3000))
  await evaluate(cdp, `
(async () => {
  const t0 = Date.now()
  while (Date.now() - t0 < 30000) {
    if (document.querySelector('.topbar') && document.querySelector('.composer-input')) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
})()
`, 40000)

  // s49 后半：回滚
  const r49b = await evaluate(cdp, buildS49RollbackCode(), 120000)
  steps.push(...r49b.steps)
  steps.push({
    name: '回滚后 rollback-probe.txt 已消失',
    ok: !existsSync(probeFile),
    detail: probeFile
  })

  // s50：双 Agent 并行
  const r50 = await evaluate(cdp, buildS50Code(), 320000)
  steps.push(...r50.steps)
  // Node 侧真机断言：两个产物各就其位、内容互不串扰
  const aText = existsSync(path.join(ROOT, 'agent-a.txt'))
    ? (await readFile(path.join(ROOT, 'agent-a.txt'), 'utf-8')).trim() : null
  const bText = existsSync(path.join(ROOT, 'agent-b.txt'))
    ? (await readFile(path.join(ROOT, 'agent-b.txt'), 'utf-8')).trim() : null
  steps.push({
    name: 'agent-a.txt=ALPHA 且 agent-b.txt=BETA（不串扰）',
    ok: aText === 'ALPHA' && bText === 'BETA',
    detail: 'a=' + JSON.stringify(aText) + ' b=' + JSON.stringify(bText)
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
