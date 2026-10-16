/** 最小 ZIP 写入器（不引第三方依赖）
 *
 * 仅 STORED（compression=0）——导出文本类内容，体积不敏感，省去 deflate 依赖。
 * 结构：local file header × N + central directory + EOCD；文件名 UTF-8（general purpose flag bit 11）。
 * CRC32 自实现（标准 IEEE 表驱动），对齐 Node zlib.crc32 语义无外部依赖。
 */

export interface ZipEntryInput {
  name: string;
  data: Buffer;
}

// ---- CRC32（IEEE，多项式 0xEDB88320 反射表）----
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc = (CRC_TABLE[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 生成 ZIP 文件字节（全部 STORED，entry 顺序即输入顺序——epub mimetype 须放第一个） */
export function createZip(entries: ZipEntryInput[]): Buffer {
  const encoder = new TextEncoder();
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(encoder.encode(entry.name));
    const crc = crc32(entry.data);
    const size = entry.data.length;

    // local file header（30 字节定长部分）
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // 魔数 PK\x03\x04
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 文件名
    local.writeUInt16LE(0, 8); // method: STORED
    local.writeUInt16LE(0, 10); // mod time（固定 0，导出物不关心）
    local.writeUInt16LE(0, 12); // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18); // compressed size（STORED 与原始同）
    local.writeUInt32LE(size, 22); // uncompressed size
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // extra len
    localParts.push(local, nameBytes, entry.data);

    // central directory entry（46 字节定长部分）
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // 魔数 PK\x01\x02
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8); // flags
    central.writeUInt16LE(0, 10); // method
    central.writeUInt16LE(0, 12); // mod time
    central.writeUInt16LE(0, 14); // mod date
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra len
    central.writeUInt16LE(0, 32); // comment len
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // local header offset
    centralParts.push(central, nameBytes);

    offset += 30 + nameBytes.length + size;
  }

  const centralDir = Buffer.concat(centralParts);

  // EOCD（22 字节）
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // 魔数 PK\x05\x06
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // central dir disk
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16); // central dir 起始偏移
  eocd.writeUInt16LE(0, 20); // comment len

  return Buffer.concat([...localParts, centralDir, eocd]);
}
