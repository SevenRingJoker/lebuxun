/** memory.updater + chapter.next-starter 单测 */

import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type AppDatabase } from '../../db/index.js';
import { ChaptersRepository } from '../../db/repositories/chapters.js';
import { MemoryChunksRepository } from '../../db/repositories/memory-chunks.js';
import type { MemoryUpdate } from './chapter-finalizer.js';
import type { GenerationContext } from './input-context.js';
import { chapterNextStarterNode } from './chapter-next-starter.js';
import { memoryUpdaterNode, type MemoryUpdaterOutput } from './memory-updater.js';
import { makeCtx, mockSidecar, seedProject, seedRun } from './test-helpers.js';

let db: AppDatabase;

beforeEach(async () => {
  db = await openDatabase(':memory:');
  seedProject(db);
  seedRun(db);
});

const memoryUpdate: MemoryUpdate = {
  chapterId: 'ch1',
  chapterIndex: 1,
  title: '初遇',
  summary: '林尘下山遇见苏瑶。',
  text: '林尘下山，遇见苏瑶。',
};

function seedChapter(db: AppDatabase): void {
  db.prepare(
    "INSERT INTO chapters (id, project_id, idx, title, status, word_count, summary, created_at, updated_at) VALUES (?, ?, 1, ?, 'draft', ?, ?, ?, ?)"
  ).run('ch1', 'p1', '初遇', 100, '摘要', Date.now(), Date.now());
}

describe('memory.updater', () => {
  beforeEach(() => seedChapter(db));

  it('正常路径：memory_chunks 落库 + sidecar ragIndex fire-and-forget 被调', async () => {
    let indexed = 0;
    const sidecar = mockSidecar({
      ragIndex: () => {
        indexed += 1;
        return Promise.resolve({ ok: true, count: 1 });
      },
    });
    const { ctx } = makeCtx(db, { sidecar, params: { styleId: 's1' } });

    const out = (await memoryUpdaterNode.execute(ctx, { memoryUpdate })) as MemoryUpdaterOutput;
    expect(out.memory.kind).toBe('chapter-summary');

    const chunks = new MemoryChunksRepository(db).listRecent('p1', 10);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.content).toContain('初遇');
    expect(indexed).toBe(1);
  });

  it('降级路径：sidecar ragIndex 抛错仅 warn；无 styleId 跳过 RAG', async () => {
    const sidecar = mockSidecar({ ragIndex: () => Promise.reject(new Error('sidecar 挂了')) });
    const { ctx, logs } = makeCtx(db, { sidecar, params: { styleId: 's1' } });
    await memoryUpdaterNode.execute(ctx, { memoryUpdate });
    // fire-and-forget：等待微任务让 catch 执行
    await new Promise((r) => setImmediate(r));
    expect(logs.some((l) => l.includes('RAG 索引更新失败'))).toBe(true);

    let indexed = 0;
    const sidecar2 = mockSidecar({
      ragIndex: () => {
        indexed += 1;
        return Promise.resolve({ ok: true, count: 1 });
      },
    });
    const { ctx: ctx2 } = makeCtx(db, { sidecar: sidecar2, params: {} });
    await memoryUpdaterNode.execute(ctx2, { memoryUpdate });
    expect(indexed).toBe(0);
  });
});

describe('chapter.next-starter', () => {
  it('正常路径：已有章节摘要进 context，chapterIndex 递增', async () => {
    new ChaptersRepository(db).insert({
      id: 'ch1',
      projectId: 'p1',
      index: 1,
      title: '初遇',
      status: 'draft',
      wordCount: 10,
      summary: '林尘下山遇见苏瑶。',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const { ctx } = makeCtx(db, { params: { worldSetting: '九州大陆' } });

    const out = (await chapterNextStarterNode.execute(ctx, {
      memory: { chunkId: 'mc1', kind: 'chapter-summary' },
    })) as { context: GenerationContext };
    expect(out.context.chapterIndex).toBe(2);
    expect(out.context.previousSummaries[0]).toContain('初遇');
    expect(out.context.prompt).toContain('【前情摘要】\n第1章 初遇：林尘下山遇见苏瑶。');
    expect(out.context.prompt).toContain('第 2 章');
  });

  it('失败路径：memory 输入缺失抛错', async () => {
    const { ctx } = makeCtx(db);
    await expect(chapterNextStarterNode.execute(ctx, {})).rejects.toThrow(/缺少 memory/);
  });
});
