// 探针：cd /d + 括号复合命令的真实行为
const { spawn } = require('child_process')
const iconv = require('iconv-lite')

const proc = spawn('cmd.exe', ['/V:ON', '/Q'], {
  cwd: 'D:\\编辑器测试项目',
  windowsHide: true,
  env: { ...process.env, FORCE_COLOR: '0' }
})
proc.stdout.on('data', (d) => console.log('OUT:', iconv.decode(d, 'gbk')))
proc.stderr.on('data', (d) => console.log('ERR:', iconv.decode(d, 'gbk')))

const send = (line, delay) => setTimeout(() => {
  console.log('\n>>> ' + line)
  proc.stdin.write(iconv.encode(line + '\r\n', 'gbk'))
}, delay)

send('cd /d "D:\\编辑器测试项目\\34" & ( cd ) & echo M1=!ERRORLEVEL!', 600)
send('cd & echo M2=!ERRORLEVEL!', 1600)
setTimeout(() => { proc.kill(); process.exit(0) }, 2600)
