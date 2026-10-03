// 将 PNG 转换为 ICNS（macOS 图标，嵌入 512x512 PNG 数据）
const fs = require('node:fs')
const path = require('node:path')

const pngPath = path.join(__dirname, '..', 'build', 'icon.png')
const icnsPath = path.join(__dirname, '..', 'build', 'icon.icns')
const png = fs.readFileSync(pngPath)

// ICNS 条目: 'ic09' = 512x512 PNG
const entryType = Buffer.from('ic09', 'ascii')
const entryLen = 8 + png.length
const entry = Buffer.alloc(8)
entryType.copy(entry, 0)
entry.writeUInt32BE(entryLen, 4)

// ICNS 文件头: 'icns' + 总长度
const totalLen = 8 + entryLen
const header = Buffer.alloc(8)
Buffer.from('icns', 'ascii').copy(header, 0)
header.writeUInt32BE(totalLen, 4)

const icns = Buffer.concat([header, entry, png])
fs.writeFileSync(icnsPath, icns)
console.log(`icon.icns written: ${icns.length} bytes`)
