/** chapter.finalizer 单测：LLM 标题/摘要 + chapters 表更新 / LLM 失败回退 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Chapter } from '@novel-forge/shared';
import { openDatabase, type AppDatabase } from '../../db/index.js';
import { ChaptersRepository } from '../../db/repositories/chapters.js';
import { chapterFinalizerNode, type MemoryUpdate } from './chapter-finalizer.js';
import { ensureWritingChapter, type ChapterDraft } from './chapter-accumulator.js';
import { makeCtx, mockLlm, seedProject, seedRun } from './test-helpers.js';

let db: AppDatabase;

beforeEach(async () => {
  db = await openDatabase(':memory:');
  seedProject(db);
  seedRun(db);
});

function seedDraft(text: string): { draft: ChapterDraft; chapterId: string } {
  const { ctx } = makeCtx(db);
  const chapter = ensureWritingChapter(ctx);
  db.prepare(
    "INSERT INTO paragraphs (id, chapter_id, idx, text, scene_type, metadata, created_at) VALUES (?, ?, 0, ?, 'daily', '{}', ?)",
  ).run('para-1', chapter.id, text, Date.now());
  return {
    chapterId: chapter.id,
    draft: {
      chapterId: chapter.id,
      chapterIndex: chapter.index,
      paragraphs: [],
      text,
    },
  };
}

describe('chapter.finalizer', () => {
  it('正常路径：LLM 生成标题/摘要，chapters 表更新为 draft', async () => {
    const { draft, chapterId } = seedDraft('林尘下山，遇见苏瑶。两人结伴除妖。');
    const llm = mockLlm(() => JSON.stringify({ title: '初遇', summary: '林尘下山遇见苏瑶，结伴除妖。' }));
    const { ctx } = makeCtx(db, { llm });

    const out = (await chapterFinalizerNode.execute(ctx, { chapterDraft: draft })) as {
      finalChapter: Chapter;
      memoryUpdate: MemoryUpdate;
    };
    expect(out.finalChapter).toMatchObject({ title: '初遇', status: 'draft' });
    expect(out.finalChapter.summary).toBe('林尘下山遇见苏瑶，结伴除妖。');
    expect(out.finalChapter.wordCount).toBe('林尘下山，遇见苏瑶。两人结伴除妖。'.length);
    expect(out.memoryUpdate.chapterId).toBe(chapterId);
    expect(out.memoryUpdate.summary).toContain('苏瑶');

    const stored = new ChaptersRepository(db).get(chapterId)!;
    expect(stored.status).toBe('draft');
    expect(stored.title).toBe('初遇');
    expect(stored.summary).toBe('林尘下山遇见苏瑶，结伴除妖。');
  });

  it('回退路径：LLM 连续失败 → 占位标题 + 截断摘要，不抛错', async () => {
    const { draft, chapterId } = seedDraft('林尘下山。'.repeat(100)); // > 300 字
    const llm = mockLlm(() => 'LLM 不可用');
    const { ctx, logs } = makeCtx(db, { llm });

    const out = (await chapterFinalizerNode.execute(ctx, { chapterDraft: draft })) as {
      finalChapter: Chapter;
      memoryUpdate: MemoryUpdate;
    };
    expect(out.finalChapter.title).toBe('第1章');
    expect(out.finalChapter.summary).toHaveLength(300); // 截断兜底
    expect(logs.some((l) => l.includes('摘要生成失败'))).toBe(true);

    const stored = new ChaptersRepository(db).get(chapterId)!;
    expect(stored.status).toBe('draft'); // 依然定稿落库
  });

  it('失败路径：chapterDraft 缺失抛错', async () => {
    const llm = mockLlm(() => '{}');
    const { ctx } = makeCtx(db, { llm });
    await expect(chapterFinalizerNode.execute(ctx, {})).rejects.toThrow(/缺少 chapterDraft/);
  });
});
