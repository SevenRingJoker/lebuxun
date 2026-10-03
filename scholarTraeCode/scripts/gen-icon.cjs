// 生成应用图标 PNG（512x512，主题青色 + 中央白色方形）
// 纯 Node 实现，不依赖第三方库
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

// CRC32 查表
const crcTable = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crc])
}

const W = 512, H = 512
// 主题色 #00d4ff
const R = 0x00, G = 0xd4, B = 0xff

// 构造 RGBA 原始像素（每行前加 filter byte 0）
const raw = Buffer.alloc((W * 4 + 1) * H)
for (let y = 0; y < H; y++) {
  const rowOff = y * (W * 4 + 1)
  raw[rowOff] = 0 // filter none
  for (let x = 0; x < W; x++) {
    const p = rowOff + 1 + x * 4
    // 中央 256x256 白色方块，其余青色背景
    const cx = x - W / 2, cy = y - H / 2
    const inBox = Math.abs(cx) < 128 && Math.abs(cy) < 128
    if (inBox) { raw[p] = 255; raw[p + 1] = 255; raw[p + 2] = 255 }
    else { raw[p] = R; raw[p + 1] = G; raw[p + 2] = B }
    raw[p + 3] = 255
  }
}

const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(W, 0)
ihdr.writeUInt32BE(H, 4)
ihdr[8] = 8   // bit depth
ihdr[9] = 6   // color type RGBA
ihdr[10] = 0  // compression
ihdr[11] = 0  // filter
ihdr[12] = 0  // interlace
const idat = zlib.deflateSync(raw)

const png = Buffer.concat([
  sig,
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0))
])

const outDir = path.join(__dirname, '..', 'build')
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'icon.png'), png)
console.log(`icon.png written: ${png.length} bytes (${W}x${H})`)
