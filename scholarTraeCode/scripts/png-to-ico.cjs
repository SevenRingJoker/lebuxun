// 将 PNG 转换为 ICO（现代 ICO 可直接嵌入 PNG 数据）
const fs = require('node:fs')
const path = require('node:path')

const pngPath = path.join(__dirname, '..', 'build', 'icon.png')
const icoPath = path.join(__dirname, '..', 'build', 'icon.ico')
const png = fs.readFileSync(pngPath)

// ICO header: reserved(2)=0, type(2)=1(icon), count(2)=1
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(1, 4)

// ICONDIRENTRY: width(1)=0(>=256), height(1)=0, colors(1)=0, reserved(1)=0,
// planes(2)=1, bpp(2)=32, size(4)=png.length, offset(4)=22
const entry = Buffer.alloc(16)
entry[0] = 0  // width 0 => 256 (PNG 内记录真实尺寸 512)
entry[1] = 0  // height 0
entry[2] = 0  // colors
entry[3] = 0  // reserved
entry.writeUInt16LE(1, 4)   // planes
entry.writeUInt16LE(32, 6)  // bpp
entry.writeUInt32LE(png.length, 8)
entry.writeUInt32LE(22, 12) // offset = header(6) + entry(16)

const ico = Buffer.concat([header, entry, png])
fs.writeFileSync(icoPath, ico)
console.log(`icon.ico written: ${ico.length} bytes`)
