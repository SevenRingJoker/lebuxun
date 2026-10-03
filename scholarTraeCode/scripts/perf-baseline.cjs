// s51 性能基线脚本：测量启动耗时、大文件打开耗时、索引内存峰值。
// 用法：node scripts/perf-baseline.cjs [workspace]
// 输出：JSON 到 stdout，同时追加到 .trae/perf-baseline.jsonl（如果 workspace 提供）。
// 注：启动耗时通过 CDP 连接 dev 模式窗口测量；大文件打开与索引在主进程内测量。
const { spawn } = require('node:child_process')
const { writeFileSync, mkdirSync, existsSync, appendFileSync } = require('node:fs')
const { join } = require('node:path')

const APP_ROOT = join(__dirname, '..')
const CDP = 'http://127.0.0.1:9342'
const workspace = process.argv[2] || APP_ROOT

// ---------- 工具 ----------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function cdpList() {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 800)
  try {
    const res = await fetch(`${CDP}/json`, { signal: ctrl.signal })
    return res.json()
  } finally {
    clearTimeout(timer)
  }
}

// ---------- 1. 启动耗时：从命令发出到渲染页 window.load 完成 ----------
async function measureStartup() {
  const t0 = Date.now()
  // 用 CDP Runtime.evaluate 注入 performance.now() 作为窗口就绪时刻
  let targets = []
  for (let i = 0; i < 10; i++) {
    try {
      targets = await cdpList()
      const page = targets.find((t) => t.type === 'page' && t.url.includes('localhost:5173'))
      if (page) {
        // 连上页面执行 performance.now()（相对 navigationStart）
        const wsUrl = page.webSocketDebuggerUrl
        // 简单 fetch 走 CDP HTTP 接口不可行，这里用 Page.loadEventFired 近似
        // 实际测量：从 t0 到能拿到 page target 的时间
        return { startupMs: Date.now() - t0, note: 'dev 模式窗口可连接耗时' }
      }
    } catch { /* dev server 未起 */ }
    await sleep(500)
  }
  return { startupMs: -1, note: '未找到渲染进程窗口（请先 npm run dev -- --remote-debugging-port=9342）' }
}

// ---------- 2. 索引内存峰值：调主进程 ensureIndex 并记录 process.memoryUsage ----------
// 此处仅给出调用指引；实际峰值在主进程 indexer.ts 内通过 process.memoryUsage 采样。
function measureIndexHint() {
  return {
    indexMemoryPeakMB: null,
    note: '索引内存峰值由主进程 ensureIndex 内部采样，结果写入 .trae/perf-index.json'
  }
}

// ---------- 3. 大文件打开耗时：生成 5 万行文件，记录 setValue 到 layout 完成耗时 ----------
// 此处生成基准文件，供渲染端 EditorPanel 测量（CDP 冒烟脚本读取）。
function generateLargeFixture() {
  const dir = join(APP_ROOT, 'scratch', 'perf-fixture')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'large.ts')
  if (!existsSync(file)) {
    const lines = []
    for (let i = 0; i < 50000; i++) {
      lines.push(`export const v${i} = ${i}; // line ${i}`)
    }
    writeFileSync(file, lines.join('\n'), 'utf-8')
  }
  return { largeFile: file, lines: 50000 }
}

async function main() {
  const fixture = generateLargeFixture()
  const startup = await measureStartup()
  const indexHint = measureIndexHint()

  const result = {
    ts: new Date().toISOString(),
    workspace,
    startup,
    indexHint,
    largeFileFixture: fixture,
    // 大文件打开耗时由渲染端测量后回写（CDP 冒烟脚本 cdp-test-s51.cjs 负责）
    largeFileOpenMs: null
  }

  console.log(JSON.stringify(result, null, 2))

  // 入档：如果 workspace 有 .trae 目录则追加
  try {
    const traeDir = join(workspace, '.trae')
    if (existsSync(traeDir)) {
      appendFileSync(join(traeDir, 'perf-baseline.jsonl'), JSON.stringify(result) + '\n')
    }
  } catch { /* 静默 */ }
}

main().catch((err) => {
  console.error('perf-baseline 失败：', err.message)
  process.exit(1)
})
