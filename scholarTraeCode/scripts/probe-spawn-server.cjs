// 用与 mcp.ts 完全相同的 spawn 方式手动启动 filesystem server，
// 通过 stdio JSON-RPC 直接调 create_directory，观察真实行为
const { spawn } = require('child_process')
const path = require('path')

const serverEntry = path.join(
  __dirname, '..', 'node_modules', '@modelcontextprotocol', 'server-filesystem', 'dist', 'index.js'
)
const electronBin = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe')

const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }

const child = spawn(electronBin, [serverEntry, 'D:\\47.104.20.186\\aiProject\\scholarTreaCode', 'D:\\编辑器测试项目'], {
  env,
  stdio: ['pipe', 'pipe', 'pipe']
})

child.stderr.on('data', (d) => process.stdout.write('[stderr] ' + d.toString()))

let buf = ''
const pending = new Map()
let idSeq = 0
child.stdout.on('data', (d) => {
  buf += d.toString()
  let idx
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim()
    buf = buf.slice(idx + 1)
    if (!line) continue
    try {
      const msg = JSON.parse(line)
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg)
        pending.delete(msg.id)
      }
    } catch { /* 忽略非 JSON 行 */ }
  }
})

function rpc(method, params) {
  return new Promise((resolve) => {
    const id = ++idSeq
    pending.set(id, resolve)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}

async function main() {
  // initialize
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'probe', version: '0.0.1' }
  })
  console.log('[initialize]', init.error ? JSON.stringify(init.error) : 'ok')
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')

  // 允许目录
  const allowed = await rpc('tools/call', { name: 'list_allowed_directories', arguments: {} })
  console.log('[allowed]', JSON.stringify(allowed.result?.content))

  // 中文目录 mkdir
  const r1 = await rpc('tools/call', { name: 'create_directory', arguments: { path: 'D:\\编辑器测试项目\\spawn-probe' } })
  console.log('[mkdir 中文]', JSON.stringify(r1.result?.content))

  // 应用目录 mkdir 对照
  const r2 = await rpc('tools/call', { name: 'create_directory', arguments: { path: 'D:\\47.104.20.186\\aiProject\\scholarTreaCode\\spawn-probe' } })
  console.log('[mkdir 应用]', JSON.stringify(r2.result?.content))

  child.kill()
  process.exit(0)
}
main().catch((e) => { console.error('FATAL', e); child.kill(); process.exit(1) })
