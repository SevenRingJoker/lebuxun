/** SPEC §14 任务 6.6 导出成稿（export:manuscript IPC）
 *
 * 按 projectId 取全部章节（idx 升序，不问 status，全部导出）+ 每章段落（idx 升序）。
 * txt/md 直接拼文本；docx/epub 为最小 OOXML/EPUB 容器，ZIP 手写（见 zip.ts，STORED）。
 * 输出目录默认与数据库文件平级的 exports/（§5.3 data/exports/）；文件名
 * 「{项目名}-{YYYYMMDD-HHmmss}.{ext}」，非法文件名字符替换为 -。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ExportFormat } from '@novel-forge/shared';
import type { AppDatabase } from '../db/index.js';
import { ChaptersRepository } from '../db/repositories/chapters.js';
import { ParagraphsRepository } from '../db/repositories/paragraphs.js';
import { createZip, type ZipEntryInput } from './zip.js';

export interface ExportResult {
  path: string;
}

interface ProjectRow {
  name: string;
}

/** 默认导出目录：db 文件旁的 exports/；内存库（测试）退化到 cwd/exports */
export function defaultExportsDir(db: AppDatabase): string {
  const dbPath = db.name;
  const base = dbPath && dbPath !== ':memory:' ? path.dirname(dbPath) : process.cwd();
  return path.join(base, 'exports');
}

/** 文件名时间戳 YYYYMMDD-HHmmss（本地时区） */
function timestamp(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

/** 非法文件名字符（Windows 保留字符 + 控制字符）替换为 - */
function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-');
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

interface ChapterContent {
  title: string;
  paragraphs: string[];
}

function loadManuscript(db: AppDatabase, projectId: string): { projectName: string; chapters: ChapterContent[] } {
  const project = db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId) as
    | ProjectRow
    | undefined;
  if (!project) throw new Error(`项目 ${projectId} 不存在`);
  const chaptersRepo = new ChaptersRepository(db);
  const paragraphsRepo = new ParagraphsRepository(db);
  const chapters = chaptersRepo.listByProject(projectId).map((ch) => ({
    title: ch.title,
    paragraphs: paragraphsRepo.listByChapter(ch.id).map((p) => p.text),
  }));
  return { projectName: project.name, chapters };
}

// ---- txt / md ----

function renderTxt(chapters: ChapterContent[]): string {
  return chapters.map((ch) => `${ch.title}\n\n${ch.paragraphs.join('\n\n')}`).join('\n\n');
}

function renderMd(projectName: string, chapters: ChapterContent[]): string {
  const parts = [`# ${projectName}`];
  for (const ch of chapters) {
    parts.push(`## ${ch.title}\n\n${ch.paragraphs.join('\n\n')}`);
  }
  return parts.join('\n\n');
}

// ---- docx（最小 OOXML）----

const DOCX_CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '</Types>';

const DOCX_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '</Relationships>';

function docxParagraph(text: string): string {
  return `<w:p><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

function renderDocx(projectName: string, chapters: ChapterContent[]): Buffer {
  const body: string[] = [docxParagraph(projectName)];
  for (const ch of chapters) {
    body.push(docxParagraph(ch.title));
    for (const para of ch.paragraphs) body.push(docxParagraph(para));
  }
  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${body.join('')}</w:body></w:document>`;
  return createZip([
    { name: '[Content_Types].xml', data: Buffer.from(DOCX_CONTENT_TYPES, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(DOCX_RELS, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(documentXml, 'utf8') },
  ]);
}

// ---- epub（最小 EPUB 3 容器；mimetype 必须第一个 entry 且不压缩——ZIP 全程 STORED 天然满足）----

const EPUB_MIMETYPE = 'application/epub+zip';

const EPUB_CONTAINER =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
  '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>' +
  '</rootfiles></container>';

function renderEpub(projectName: string, chapters: ChapterContent[]): Buffer {
  const entries: ZipEntryInput[] = [
    { name: 'mimetype', data: Buffer.from(EPUB_MIMETYPE, 'utf8') },
    { name: 'META-INF/container.xml', data: Buffer.from(EPUB_CONTAINER, 'utf8') },
  ];

  const manifest: string[] = [];
  const spine: string[] = [];
  chapters.forEach((ch, i) => {
    const id = `chapter-${i + 1}`;
    const file = `chapter-${i + 1}.xhtml`;
    manifest.push(`<item id="${id}" href="${file}" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="${id}"/>`);
    const paras = ch.paragraphs.map((p) => `<p>${escapeXml(p)}</p>`).join('');
    const xhtml =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<!DOCTYPE html>' +
      '<html xmlns="http://www.w3.org/1999/xhtml">' +
      `<head><title>${escapeXml(ch.title)}</title></head>` +
      `<body><h1>${escapeXml(ch.title)}</h1>${paras}</body></html>`;
    entries.push({ name: `OEBPS/${file}`, data: Buffer.from(xhtml, 'utf8') });
  });

  const opf =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="3.0">' +
    '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">' +
    `<dc:identifier id="bookid">${escapeXml(projectName)}</dc:identifier>` +
    `<dc:title>${escapeXml(projectName)}</dc:title>` +
    '<dc:language>zh-CN</dc:language>' +
    '</metadata>' +
    `<manifest>${manifest.join('')}</manifest>` +
    `<spine>${spine.join('')}</spine>` +
    '</package>';
  entries.splice(2, 0, { name: 'OEBPS/content.opf', data: Buffer.from(opf, 'utf8') });

  return createZip(entries);
}

/** 导出成稿主流程：返回写出文件的绝对路径 */
export function exportManuscript(
  db: AppDatabase,
  projectId: string,
  format: ExportFormat,
  exportsDir: string = defaultExportsDir(db),
): ExportResult {
  const { projectName, chapters } = loadManuscript(db, projectId);

  let data: Buffer;
  switch (format) {
    case 'txt':
      data = Buffer.from(renderTxt(chapters), 'utf8');
      break;
    case 'md':
      data = Buffer.from(renderMd(projectName, chapters), 'utf8');
      break;
    case 'docx':
      data = renderDocx(projectName, chapters);
      break;
    case 'epub':
      data = renderEpub(projectName, chapters);
      break;
  }

  fs.mkdirSync(exportsDir, { recursive: true });
  const fileName = `${sanitizeFilename(projectName)}-${timestamp()}.${format}`;
  const outPath = path.join(exportsDir, fileName);
  fs.writeFileSync(outPath, data);
  return { path: outPath };
}
