// CDP 真窗冒烟 · 2.1 逐 hunk 审阅（s27）
// 前置：npm run dev -- --remote-debugging-port=9341
// 用法：node scripts/cdp-test-hunk.cjs [fixture目录]
// 覆盖：多 hunk 拆分、选中 hunk 部分接受（磁盘核验）、剩余 hunk 重基线留 pending、
//   逐 hunk 拒绝、外部修改冲突整批阻断、中文路径、空 pending 时 pending.json 删除
const { mkdir, rm, writeFile, readdir } = require('node:fs/promises')
const path = require('node:path')

// 每轮唯一目录（app 内存 holder 按路径缓存，复用上轮目录会拿到陈旧暂存态）
const SMOKE_PARENT = path.join(__dirname, '..', 'scratch')
const ROOT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(SMOKE_PARENT, `hunk-smoke-${Date.now()}`)
const CDP = 'http://127.0.0.1:9341'

// ── FNV-1a（与 changeStage.hashContent 同算法），供 pending.json 的 baseHash ──
function hashContent(text) {
  let h = 0x811c9dc5
  for (const b of Buffer.from(String(text ?? ''), 'utf-8')) {
    h ^= b
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

function lines(prefix, n) {
  return Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`).join('\n') + '\n'
}

function mark(text, lineNo, suffix) {
  const arr = text.split('\n')
  arr[lineNo - 1] = arr[lineNo - 1] + suffix
  // 保持末尾换行（split 尾空串）
  return arr.join('\n')
}

async function prepareFixture() {
  // 清理历史 smoke 目录（保持 scratch 整洁）
  try {
    for (const name of await readdir(SMOKE_PARENT)) {
      if (name.startsWith('hunk-smoke-')) {
        await rm(path.join(SMOKE_PARENT, name), { recursive: true, force: true })
      }
    }
  } catch { /* scratch 不存在则随 mkdir 建 */ }
  await rm(ROOT, { recursive: true, force: true })
  await mkdir(ROOT, { recursive: true })

  const slash = (p) => p.split(path.sep).join('/')
  const bigPath = slash(path.join(ROOT, 'big.txt'))
  const conflictPath = slash(path.join(ROOT, 'conflict.txt'))
  const zhDir = path.join(ROOT, '中文')
  await mkdir(zhDir, { recursive: true })
  const zhPath = slash(path.join(zhDir, '面板.txt'))

  const bigBase = lines('B', 200)
  const bigFinal = [2, 60, 120, 190].reduce((t, n) => mark(t, n, '-MARK'), bigBase)

  const zhBase = lines('C', 20)
  const zhFinal = [3, 18].reduce((t, n) => mark(t, n, '-改'), zhBase)

  const conflictBase = 'CONFLICT-BASE\n'

  const rec = (p, base, final) => ({
    path: p,
    kind: 'modify',
    content: final,
    oldPath: null,
    baseContent: base,
    baseExists: true,
    baseHash: hashContent(base),
    updatedAt: 1759400000000
  })

  await writeFile(bigPath, bigBase, 'utf-8')
  await writeFile(conflictPath, conflictBase, 'utf-8')
  await writeFile(zhPath, zhBase, 'utf-8')

  const stagingDir = path.join(ROOT, '.trae', 'staging')
  await mkdir(stagingDir, { recursive: true })
  await writeFile(path.join(stagingDir, 'config.json'), JSON.stringify({ enabled: true }))
  await writeFile(
    path.join(stagingDir, 'pending.json'),
    JSON.stringify([
      rec(bigPath, bigBase, bigFinal),
      rec(conflictPath, conflictBase, 'CONFLICT-NEW\n'),
      rec(zhPath, zhBase, zhFinal)
    ], null, 2)
  )

  return { bigPath, conflictPath, zhPath }
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
  // 页面内禁用反引号；换行用 \\n 转义
  return `
(async () => {
  const ROOT = ${JSON.stringify(slashLocal(ROOT))}
  const BIG = ${JSON.stringify(paths.bigPath)}
  const CONFLICT = ${JSON.stringify(paths.conflictPath)}
  const ZH = ${JSON.stringify(paths.zhPath)}
  const report = { steps: [] }
  const log = (name, ok, detail) => report.steps.push({ name, ok: !!ok, detail: String(detail) })
  const readDisk = async (p) => {
    try { return await window.api.fs.readFile(p) } catch (e) { return null }
  }

  try {
    // ---- 0) 初始 3 条记录 ----
    const s0 = await window.api.staging.get(ROOT)
    log('初始 pending=3', s0.summary.total === 3, 'total=' + s0.summary.total)

    // ---- 1) big.txt 4 个 hunk ----
    const d0 = await window.api.staging.diff(ROOT, BIG)
    log('big hunk=4', d0.hunks.length === 4, 'hunks=' + d0.hunks.map((h) => h.id).join(','))

    // ---- 2) 外部修改 → 冲突整批阻断；复原 → 通过 ----
    await window.api.fs.writeFile(CONFLICT, 'TAMPERED\\n')
    const cBad = await window.api.staging.accept(ROOT, [CONFLICT])
    await window.api.fs.writeFile(CONFLICT, 'CONFLICT-BASE\\n')
    log('外部修改冲突阻断', cBad.ok === false, cBad.error || '')
    const cOk = await window.api.staging.accept(ROOT, [CONFLICT])
    log('复原后接受通过', cOk.ok === true, JSON.stringify(cOk))

    // ---- 3) big 只接受 h1+h3（第 2、120 行）----
    const a1 = await window.api.staging.accept(ROOT, [BIG], (function () {
      const o = {}; o[BIG] = ['h1', 'h3']; return o
    })())
    log('部分接受 2 hunk', a1.ok === true && a1.partial === true, JSON.stringify(a1))

    const disk1 = await readDisk(BIG)
    const dl = disk1.split('\\n')
    const okDisk = dl[1] === 'B2-MARK' && dl[119] === 'B120-MARK' &&
      dl[59] === 'B60' && dl[189] === 'B190'
    log('磁盘仅落选中块', okDisk, 'L2=' + dl[1] + ' L60=' + dl[59] + ' L120=' + dl[119] + ' L190=' + dl[189])

    // ---- 4) 剩余 hunk 重基线：pending 仍有 big（2 hunk）----
    const s1 = await window.api.staging.get(ROOT)
    const d1 = await window.api.staging.diff(ROOT, BIG)
    log('剩余 hunk 重基线留 pending', s1.summary.total === 2 && d1.hunks.length === 2,
      'total=' + s1.summary.total + ' hunks=' + d1.hunks.length)

    // ---- 5) 中文路径：接受 h1，磁盘核验，再拒绝 h2 ----
    const dz0 = await window.api.staging.diff(ROOT, ZH)
    const az = await window.api.staging.accept(ROOT, [ZH], (function () {
      const o = {}; o[ZH] = [dz0.hunks[0].id]; return o
    })())
    const zhDisk = await readDisk(ZH)
    const zhLines = zhDisk.split('\\n')
    const zhOk = az.ok === true && zhLines[2] === 'C3-改' && zhLines[17] === 'C18'
    log('中文路径逐块接受', zhOk, 'L3=' + zhLines[2] + ' L18=' + zhLines[17])
    const dz1 = await window.api.staging.diff(ROOT, ZH)
    const rz = await window.api.staging.reject(ROOT, [ZH], (function () {
      const o = {}; o[ZH] = [dz1.hunks[0].id]; return o
    })())
    log('中文剩余块拒绝', rz.ok === true, JSON.stringify(rz))

    // ---- 6) big 剩余两块逐块拒绝，最终 pending=0 ----
    const d2 = await window.api.staging.diff(ROOT, BIG)
    await window.api.staging.reject(ROOT, [BIG], (function () {
      const o = {}; o[BIG] = [d2.hunks[0].id]; return o
    })())
    const d3 = await window.api.staging.diff(ROOT, BIG)
    const rLast = await window.api.staging.reject(ROOT, [BIG], (function () {
      const o = {}; o[BIG] = [d3.hunks[0].id]; return o
    })())
    const s2 = await window.api.staging.get(ROOT)
    log('全部拒绝后 pending=0', rLast.ok === true && s2.summary.total === 0, 'total=' + s2.summary.total)

    // ---- 7) 最终磁盘 = 仅 h1/h3 落盘；pending.json 已删 ----
    const disk2 = await readDisk(BIG)
    const dl2 = disk2.split('\\n')
    const finalDisk = dl2[1] === 'B2-MARK' && dl2[119] === 'B120-MARK' &&
      dl2[59] === 'B60' && dl2[189] === 'B190'
    let pendingGone = false
    try {
      await window.api.fs.readFile(ROOT + '/.trae/staging/pending.json')
    } catch { pendingGone = true }
    log('终态磁盘与 pending.json 清理', finalDisk && pendingGone,
      'finalDisk=' + finalDisk + ' pendingGone=' + pendingGone)
  } catch (e) {
    log('冒烟异常', false, e.stack || e.message)
  }
  return report
})()
`
}

function slashLocal(p) {
  return p.split(path.sep).join('/')
}

;(async () => {
  const paths = await prepareFixture()
  const cdp = await connect(await getPageWs())
  const report = await evaluate(cdp, buildPageCode(paths))
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
