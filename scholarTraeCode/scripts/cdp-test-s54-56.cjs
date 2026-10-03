// CDP 真窗冒烟 · s54–s56 学术/报告链路
// 前置：npm run dev -- --remote-debugging-port=9342
// 用法：node scripts/cdp-test-s54-56.cjs
//
// 在系统临时目录建一次性工作区并写好 CSV，通过渲染端 IPC 走完整链路：
//   s54 renderChart(CSV→SVG 落盘)
//   s55 exportReport(markdown / latex / doc 三格式)
//   s56 saveBib + readBib（BibTeX 往返）
const { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

// 端口可通过 argv 覆盖：node cdp-test-s54-56.cjs --cdp=9343 --port=5174
const argv = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([\w-]+)=(.+)$/)
    return m ? [m[1], m[2]] : [null, null]
  }).filter((x) => x[0])
)
const CDP_PORT = argv.cdp || '9342'
const DEV_PORT = argv.port || '5173'
const CDP = `http://127.0.0.1:${CDP_PORT}`
let passed = 0
let failed = 0
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
}

async function getPageWs() {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 800)
  try {
    const res = await fetch(`${CDP}/json`, { signal: ctrl.signal })
    const targets = await res.json()
    const page = targets.find((t) => t.type === 'page' && t.url.includes(`localhost:${DEV_PORT}`))
    if (!page) throw new Error('未找到渲染进程页面')
    return page.webSocketDebuggerUrl
  } finally { clearTimeout(timer) }
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
    expression, awaitPromise: true, returnByValue: true, timeout: 20000
  })
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  }
  return r.result?.value
}

async function main() {
  console.log('s54–s56 CDP 冒烟：CSV→图表→报告→文献')

  // Node 端准备一次性工作区与数据文件
  const ws2 = join(tmpdir(), `scholar-cdp-${Date.now()}`)
  mkdirSync(join(ws2, 'results'), { recursive: true })
  writeFileSync(
    join(ws2, 'results', 'metrics.csv'),
    'epoch,acc,loss\n1,0.60,0.90\n2,0.75,0.50\n3,0.88,0.20\n4,0.92,0.12\n',
    'utf-8'
  )
  const dataFile = join(ws2, 'results', 'metrics.csv')

  let cdp
  try {
    cdp = await connect(await getPageWs())
  } catch (e) {
    rmSync(ws2, { recursive: true, force: true })
    console.log(`\n跳过渲染端冒烟：${e.message}（请先 npm run dev -- --remote-debugging-port=9342）`)
    console.log('纯函数与工具落盘链路由 vitest 覆盖（scholar.test.ts / builtinTools.chart.test.ts）')
    console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
    process.exit(0)
  }

  const WS_JSON = JSON.stringify(ws2)
  const FILE_JSON = JSON.stringify(dataFile)

  // ---- s54 图表 ----
  console.log('\n[s54] 数据→图表')
  const chart = await evaluate(cdp, `
    window.api.scholar.renderChart(${WS_JSON}, ${FILE_JSON}, {
      type: 'line', title: '训练曲线', x: 'epoch', y: ['acc', 'loss'],
      xLabel: '轮次', yLabel: '指标值'
    })
  `)
  check('renderChart 返回 ok', chart?.ok === true, JSON.stringify(chart?.error))
  check('图表落盘 .trae/charts', !!chart?.relPath && chart.relPath.includes('.trae/charts'), chart?.relPath)
  check('解析行数 = 4', chart?.rowCount === 4, String(chart?.rowCount))
  const svgPath = chart?.relPath ? join(ws2, chart.relPath) : ''
  check('SVG 文件真实存在且含折线', existsSync(svgPath) && readFileSync(svgPath, 'utf-8').includes('<polyline'))

  // ---- s55 报告三格式 ----
  console.log('\n[s55] 报告生成与导出')
  const reportInput = {
    title: 'CDP冒烟报告',
    authors: '冒烟测试',
    meta: { 数据集: 'synthetic', 随机种子: '42' },
    sections: [
      { id: 'abstract', heading: '摘要', body: '验证 **学术链路**。' },
      { id: 'results', heading: '3 结果', body: '见图 [@smith2024]。\n\n![训练曲线](chart:c1)' }
    ],
    charts: chart?.relPath ? [{ id: 'c1', caption: '训练曲线', relPath: chart.relPath }] : [],
    bibEntries: [
      { type: 'article', key: 'smith2024', fields: { author: 'Smith, J.', title: 'Deep', year: '2024', journal: 'Nature' } }
    ]
  }
  const md = await evaluate(cdp, `window.api.scholar.exportReport(${WS_JSON}, ${JSON.stringify(reportInput)}, 'markdown')`)
  check('导出 Markdown ok', md?.ok === true, JSON.stringify(md?.error))
  const mdText = md?.relPath ? readFileSync(join(ws2, md.relPath), 'utf-8') : ''
  check('Markdown 含标题', mdText.includes('# CDP冒烟报告'))
  check('Markdown 图表引用已替换为相对路径', mdText.includes(chart?.relPath || '___') && !mdText.includes('chart:c1'))
  check('Markdown 参考文献联动', mdText.includes('## 参考文献') && mdText.includes('smith2024'))

  const tex = await evaluate(cdp, `window.api.scholar.exportReport(${WS_JSON}, ${JSON.stringify(reportInput)}, 'latex')`)
  check('导出 LaTeX ok', tex?.ok === true, JSON.stringify(tex?.error))
  const texText = tex?.relPath ? readFileSync(join(ws2, tex.relPath), 'utf-8') : ''
  check('LaTeX 含 documentclass/includegraphics', texText.includes('\\documentclass') && texText.includes('\\includegraphics'))

  const doc = await evaluate(cdp, `window.api.scholar.exportReport(${WS_JSON}, ${JSON.stringify(reportInput)}, 'doc')`)
  check('导出 Word(.doc) ok', doc?.ok === true, JSON.stringify(doc?.error))
  const docText = doc?.relPath ? readFileSync(join(ws2, doc.relPath), 'utf-8') : ''
  check('doc 含 Office 命名空间', docText.includes('urn:schemas-microsoft-com:office:word'))

  // ---- s56 文献往返 ----
  console.log('\n[s56] 参考文献 BibTeX')
  const saved = await evaluate(cdp, `window.api.scholar.saveBib(${WS_JSON}, ${JSON.stringify(reportInput.bibEntries)})`)
  check('saveBib ok 且 count=1', saved?.ok === true && saved?.count === 1, JSON.stringify(saved))
  check('references.bib 落盘', existsSync(join(ws2, '.trae', 'references.bib')))
  const read = await evaluate(cdp, `window.api.scholar.readBib(${WS_JSON})`)
  check('readBib 读回 1 条且 key 正确', read?.ok === true && read?.entries?.length === 1 && read.entries[0].key === 'smith2024')

  // 清理
  rmSync(ws2, { recursive: true, force: true })

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('冒烟脚本崩溃：', e.message)
  process.exit(1)
})
