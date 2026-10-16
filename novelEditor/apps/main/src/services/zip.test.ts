/** zip.ts 单测：CRC32 已知向量 + ZIP 结构（魔数/entry 数/CRC 字段） */

import { describe, expect, it } from 'vitest';
import { crc32, createZip } from './zip.js';

describe('crc32', () => {
  it('标准向量 "123456789" → 0xCBF43926', () => {
    expect(crc32(Buffer.from('123456789', 'ascii'))).toBe(0xcbf43926);
  });

  it('空 buffer → 0；UTF-8 中文可算', () => {
    expect(crc32(Buffer.alloc(0))).toBe(0);
    expect(crc32(Buffer.from('中文内容', 'utf8'))).toBeTypeOf('number');
  });
});

describe('createZip', () => {
  it('local header 魔数 PK\\x03\\x04 + EOCD entry 计数', () => {
    const zip = createZip([
      { name: 'a.txt', data: Buffer.from('hello') },
      { name: 'dir/b.txt', data: Buffer.from('world!') },
    ]);
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    // EOCD 固定 22 字节在末尾（无 comment）
    const eocd = zip.length - 22;
    expect(zip.readUInt32LE(eocd)).toBe(0x06054b50);
    expect(zip.readUInt16LE(eocd + 10)).toBe(2);
  });

  it('local header CRC/尺寸字段与数据一致', () => {
    const data = Buffer.from('NovelForge 导出', 'utf8');
    const zip = createZip([{ name: 'doc.txt', data }]);
    expect(zip.readUInt32LE(14)).toBe(crc32(data)); // CRC32 字段
    expect(zip.readUInt32LE(18)).toBe(data.length); // compressed = 原始（STORED）
    expect(zip.readUInt32LE(22)).toBe(data.length);
    expect(zip.readUInt16LE(8)).toBe(0); // compression method = STORED
    // 文件名紧随其后且 UTF-8 flag 置位
    expect(zip.readUInt16LE(6) & 0x0800).toBe(0x0800);
    const nameLen = zip.readUInt16LE(26);
    expect(zip.subarray(30, 30 + nameLen).toString('utf8')).toBe('doc.txt');
    // 数据紧接文件名
    expect(zip.subarray(30 + nameLen, 30 + nameLen + data.length).equals(data)).toBe(true);
  });

  it('UTF-8 文件名（中文）正确写入', () => {
    const zip = createZip([{ name: '章节-1.xhtml', data: Buffer.from('x') }]);
    const nameLen = zip.readUInt16LE(26);
    expect(zip.subarray(30, 30 + nameLen).toString('utf8')).toBe('章节-1.xhtml');
  });

  it('entry 顺序保持输入顺序（epub mimetype 必须第一个）', () => {
    const zip = createZip([
      { name: 'mimetype', data: Buffer.from('application/epub+zip') },
      { name: 'META-INF/container.xml', data: Buffer.from('<xml/>') },
    ]);
    const nameLen = zip.readUInt16LE(26);
    expect(zip.subarray(30, 30 + nameLen).toString('utf8')).toBe('mimetype');
  });
});
