/** export-manuscript.ts 单测（§14 任务 6.6）：txt/md/docx/epub 四种格式落盘与内容结构 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type AppDatabase } from '../db/index.js';
import { exportManuscript } from './export-manuscript.js';

let db: AppDatabase;
let exportsDir: string;

beforeEach(async () => {
  db = await openDatabase(':memory:');
  exportsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-export-'));
  // 项目名含非法文件名字符 : 验证清洗
  db.prepare(
    "INSERT INTO projects (id, name, genre, created_at, updated_at) VALUES ('p1', '剑来: 外传', '仙侠', 1, 1)",
  ).run();
  db.prepare(
    "INSERT INTO chapters (id, project_id, idx, title, status, created_at, updated_at) VALUES ('ch1', 'p1', 1, '第一章 出山', 'final', 1, 1)",
  ).run();
  db.prepare(
    "INSERT INTO chapters (id, project_id, idx, title, status, created_at, updated_at) VALUES ('ch2', 'p1', 2, '第二章 入城', 'writing', 1, 1)",
  ).run();
  db.prepare(
    "INSERT INTO paragraphs (id, chapter_id, idx, text, scene_type, created_at) VALUES ('pa1', 'ch1', 0, '少年负剑出山门。', 'transition', 1)",
  ).run();
  db.prepare(
    "INSERT INTO paragraphs (id, chapter_id, idx, text, scene_type, created_at) VALUES ('pa2', 'ch1', 1, '山下炊烟袅袅。', 'environment', 1)",
  ).run();
  db.prepare(
    "INSERT INTO paragraphs (id, chapter_id, idx, text, scene_type, created_at) VALUES ('pa3', 'ch2', 0, '城门人来人往。', 'daily', 1)",
  ).run();
});

afterEach(() => {
  fs.rmSync(exportsDir, { recursive: true, force: true });
});

describe('exportManuscript', () => {
  it('txt：标题+段落，章间空行，文件名清洗非法字符', () => {
    const { path: outPath } = exportManuscript(db, 'p1', 'txt', exportsDir);
    const base = path.basename(outPath);
    expect(base).toMatch(/^剑来- 外传-\d{8}-\d{6}\.txt$/);
    const content = fs.readFileSync(outPath, 'utf8');
    expect(content).toBe('第一章 出山\n\n少年负剑出山门。\n\n山下炊烟袅袅。\n\n第二章 入城\n\n城门人来人往。');
  });

  it('md：# 项目名 + ## 章节标题', () => {
    const { path: outPath } = exportManuscript(db, 'p1', 'md', exportsDir);
    const content = fs.readFileSync(outPath, 'utf8');
    expect(content.startsWith('# 剑来: 外传\n\n## 第一章 出山')).toBe(true);
    expect(content).toContain('## 第二章 入城');
  });

  it('docx：PK 魔数 + word/document.xml 含章节文本', () => {
    const { path: outPath } = exportManuscript(db, 'p1', 'docx', exportsDir);
    const buf = fs.readFileSync(outPath);
    expect(buf.readUInt32LE(0)).toBe(0x04034b50);
    expect(buf.includes(Buffer.from('word/document.xml', 'utf8'))).toBe(true);
    // STORED：XML 原文可在 zip 内直接检索到
    expect(buf.includes(Buffer.from('少年负剑出山门。', 'utf8'))).toBe(true);
  });

  it('epub：mimetype 为第一个 entry 且不压缩（STORED）', () => {
    const { path: outPath } = exportManuscript(db, 'p1', 'epub', exportsDir);
    const buf = fs.readFileSync(outPath);
    expect(buf.readUInt32LE(0)).toBe(0x04034b50);
    expect(buf.readUInt16LE(8)).toBe(0); // method = STORED
    const nameLen = buf.readUInt16LE(26);
    expect(buf.subarray(30, 30 + nameLen).toString('utf8')).toBe('mimetype');
    expect(buf.includes(Buffer.from('OEBPS/content.opf', 'utf8'))).toBe(true);
    expect(buf.includes(Buffer.from('OEBPS/chapter-2.xhtml', 'utf8'))).toBe(true);
  });

  it('项目不存在 → 抛错；导出目录自动创建', () => {
    expect(() => exportManuscript(db, '不存在', 'txt', exportsDir)).toThrow('不存在');
    const nested = path.join(exportsDir, 'a', 'b');
    const { path: outPath } = exportManuscript(db, 'p1', 'txt', nested);
    expect(fs.existsSync(outPath)).toBe(true);
  });
});
