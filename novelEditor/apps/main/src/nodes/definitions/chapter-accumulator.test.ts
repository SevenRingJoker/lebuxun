/** chapter.accumulator 单测：段落追加 / 空 selected 不追加 / 新建草稿章 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Candidate, Paragraph } from '@novel-forge/shared';
import { openDatabase, type AppDatabase } from '../../db/index.js';
import { ChaptersRepository } from '../../db/repositories/chapters.js';
import { ParagraphsRepository } from '../../db/repositories/paragraphs.js';
import { chapterAccumulatorNode, type ChapterDraft } from './chapter-accumulator.js';
import { makeCtx, seedProject, seedRun } from './test-helpers.js';

let db: AppDatabase;

beforeEach(async () => {
  db = await openDatabase(':memory:');
  seedProject(db);
  seedRun(db);
});

function fakeCandidate(text: string): Candidate {
  return {
    id: 'c1',
    runId: 'run-1',
    nodeId: 'gen',
    index: 0,
    text,
    strategy: { label: '平衡', temperature: 0.7 },
    scores: {
      pacing: 0.5,
      character: 0.5,
      consistency: 0.5,
      profileFit: 0.5,
      styleSimilarity: 0.5,
      rewardScore: 0.5,
    },
    satisfaction: 'unrated',
    generationMode: 'fresh',
    generationDepth: 0,
    lineage: [],
  };
}

describe('chapter.accumulator', () => {
  it('正常路径：新建草稿章并追加 2 段，chapterDraft 正文字数正确', async () => {
    const { ctx } = makeCtx(db);

    // 第一段
    const out1 = (await chapterAccumulatorNode.execute(ctx, { selected: fakeCandidate('第一段正文。') })) as {
      chapterDraft: ChapterDraft;
    };
    expect(out1.chapterDraft.paragraphs).toHaveLength(1);
    expect(out1.chapterDraft.text).toBe('第一段正文。');

    // 第二段（复用 ctx，但 accumulator 每次从 DB 读回全量）
    const out2 = (await chapterAccumulatorNode.execute(ctx, { selected: fakeCandidate('第二段正文。') })) as {
      chapterDraft: ChapterDraft;
    };
    expect(out2.chapterDraft.paragraphs).toHaveLength(2);
    expect(out2.chapterDraft.text).toBe('第一段正文。\n\n第二段正文。');
    expect(out2.chapterDraft.chapterIndex).toBe(1);
  });

  it('边界：selected 为 null 时不追加段落，仅读回现有草稿', async () => {
    const { ctx } = makeCtx(db);
    await chapterAccumulatorNode.execute(ctx, { selected: fakeCandidate('已有的。') });

    const out = (await chapterAccumulatorNode.execute(ctx, { selected: null })) as {
      chapterDraft: ChapterDraft;
    };
    expect(out.chapterDraft.paragraphs).toHaveLength(1);
    expect(out.chapterDraft.text).toBe('已有的。');
  });

  it('DB 一致性：草稿章状态为 writing，段落 sceneType 暂为 daily', async () => {
    const { ctx } = makeCtx(db);
    await chapterAccumulatorNode.execute(ctx, { selected: fakeCandidate('正文') });
    const chapters = new ChaptersRepository(db).listByProject('p1');
    expect(chapters[0]).toMatchObject({ status: 'writing', title: '第1章' });
    const paragraphs = new ParagraphsRepository(db).listByChapter(chapters[0]!.id);
    expect(paragraphs[0]).toMatchObject({ sceneType: 'daily' } as Partial<Paragraph>);
  });
});
