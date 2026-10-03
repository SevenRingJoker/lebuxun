// 在 ELECTRON_RUN_AS_NODE 模式下复刻 server-filesystem 的关键路径操作，结果写入文件（stdout 在该模式可能被吞）
const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const OUT = 'D:\\47.104.20.186\\aiProject\\scholarTreaCode\\scripts\\probe-fs-result.txt'

async function main() {
  const lines = []
  const log = (...a) => lines.push(a.join(' '))
  log('node:', process.version)
  log('cwd:', process.cwd())
  log('argv:', JSON.stringify(process.argv))

  const cases = [
    ['realpath 工作区', () => fsp.realpath('D:\\编辑器测试项目')],
    ['realpath 应用目录', () => fsp.realpath('D:\\47.104.20.186\\aiProject\\scholarTreaCode')],
    ['mkdir recursive 中文', () => fsp.mkdir('D:\\编辑器测试项目\\ep-probe1', { recursive: true })],
    ['mkdir plain 中文', () => fsp.mkdir('D:\\编辑器测试项目\\ep-probe2')],
    ['mkdir recursive 应用目录', () => fsp.mkdir('D:\\47.104.20.186\\aiProject\\scholarTreaCode\\ep-probe3', { recursive: true })]
  ]
  for (const [name, fn] of cases) {
    try {
      const r = await fn()
      log(`[${name}] OK`, r === undefined ? '' : JSON.stringify(r))
    } catch (e) {
      log(`[${name}] FAIL`, e.code, e.message)
    }
  }

  // 模拟 server 完整链路
  try {
    const currentPath = await fsp.realpath('D:\\编辑器测试项目')
    const validPath = path.join(currentPath, 'ep-probe4')
    log('[拼接路径]', JSON.stringify(validPath))
    await fsp.mkdir(validPath, { recursive: true })
    log('[server 链路模拟] OK')
  } catch (e) {
    log('[server 链路模拟] FAIL', e.code, e.message)
  }

  fs.writeFileSync(OUT, lines.join('\n'), 'utf-8')
}
main().catch((e) => {
  fs.writeFileSync(OUT, 'FATAL ' + e.message, 'utf-8')
})
