// 独立探针：不走应用，直接 spawn cmd 观察原始 stdout 字节行为
const { spawn } = require('child_process')
const iconv = require('iconv-lite')

const proc = spawn('cmd.exe', ['/V:ON', '/Q'], {
  cwd: 'D:\\编辑器测试项目',
  windowsHide: true,
  env: { ...process.env, FORCE_COLOR: '0', PROMPT: '' } // 尝试空 PROMPT 抑制提示符
})

let buf = Buffer.alloc(0)
proc.stdout.on('data', (d) => {
  buf = Buffer.concat([buf, d])
  console.log('--- STDOUT chunk @' + Date.now() % 100000 + ' ---')
  console.log(JSON.stringify(d.toString('latin1')))
})
proc.stderr.on('data', (d) => console.log('STDERR:', JSON.stringify(d.toString('latin1'))))
proc.on('exit', (c) => console.log('EXIT', c))

const send = (line, delay) => setTimeout(() => {
  console.log('\n>>> SEND: ' + JSON.stringify(line))
  proc.stdin.write(iconv.encode(line + '\r\n', 'gbk'))
}, delay)

send('( cmd /c exit 3 ) & echo MARKER3=!ERRORLEVEL!', 800)
send('echo ONLY_OK & echo MARKER4=!ERRORLEVEL!', 2500)

setTimeout(() => { proc.kill(); process.exit(0) }, 5000)
