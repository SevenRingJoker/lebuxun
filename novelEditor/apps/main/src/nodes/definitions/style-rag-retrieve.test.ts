/** style.rag-retrieve 单测：正常检索 / sidecar 异常降级 / 无 styleId 跳过 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { ChapterPlan, SceneType, StyleProfile } from '@novel-forge/shared';
import { openDatabase, type AppDatabase } from '../../db/index.js';
import { StylesRepository } from '../../db/repositories/styles.js';
import { styleRagRetrieveNode } from './style-rag-retrieve.js';
import { makeCtx, mockSidecar } from './test-helpers.js';

let db: AppDatabase;

const fakePlan: ChapterPlan = {
  title: '出山',
  goal: '引出主角',
  conflict: '宗门任务',
  hook: '山下有妖',
  estimatedParagraphs: 3,
  keyBeats: ['下山'],
};

function makeProfile(id: string, updatedAt: number): StyleProfile {
  return {
    id,
    authorName: '作家X',
    genre: '仙侠',
    bookCount: 0,
    books: [],
    fingerprint: {
      avgSentenceLength: 0,
      sentenceLengthStd: 0,
      shortSentenceRatio: 0,
      avgParagraphLength: 0,
      dialogueRatio: 0,
      metaphorDensity: 0,
      punctuation: {},
      topWords: [],
      signatureWords: [],
      forbiddenWords: [],
    },
    report: {},
    ragStats: { totalChunks: 0, byScene: {} as Record<SceneType, number> },
    createdAt: updatedAt,
    updatedAt,
  };
}

beforeEach(async () => {
  db = await openDatabase(':memory:');
});

describe('style.rag-retrieve', () => {
  it('正常路径：场景分类 + RAG 检索 → fewshot 文本数组', async () => {
    const sidecar = mockSidecar({
      sceneClassify: () => Promise.resolve({ sceneType: 'battle' as const, confidence: 0.9 }),
      ragQuery: (req: { styleId: string; query: string; sceneType?: string; topK?: number }) => {
        expect(req.styleId).toBe('s1');
        expect(req.sceneType).toBe('battle');
        expect(req.query).toContain('出山');
        return Promise.resolve({
          results: [
            { id: 'r1', text: '刀光一闪。', sceneType: 'battle' as const, score: 0.9 },
            { id: 'r2', text: '剑气纵横。', sceneType: 'battle' as const, score: 0.8 },
          ],
        });
      },
    });
    const { ctx } = makeCtx(db, { sidecar, params: { styleId: 's1', topK: 2 }, nodeType: 'style.rag-retrieve' });

    const out = (await styleRagRetrieveNode.execute(ctx, { plan: fakePlan })) as { fewshot: string[]; plan: ChapterPlan };
    expect(out.fewshot).toEqual(['刀光一闪。', '剑气纵横。']);
    // plan 透传：本节点是 main-loop 章级同步点，gen 的 plan 输入由本输出端口供给
    expect(out.plan).toBe(fakePlan);
  });

  it('params 无 styleId 时取最近风格档案', async () => {
    new StylesRepository(db).upsertProfile(makeProfile('s-latest', 200));
    const sidecar = mockSidecar({
      sceneClassify: () => Promise.resolve({ sceneType: 'daily' as const, confidence: 0.5 }),
      ragQuery: (req: { styleId: string }) => {
        expect(req.styleId).toBe('s-latest');
        return Promise.resolve({ results: [{ id: 'r1', text: '例句', sceneType: 'daily' as const, score: 0.5 }] });
      },
    });
    const { ctx } = makeCtx(db, { sidecar, params: {}, nodeType: 'style.rag-retrieve' });

    const out = (await styleRagRetrieveNode.execute(ctx, { plan: fakePlan })) as { fewshot: string[] };
    expect(out.fewshot).toEqual(['例句']);
  });

  it('降级：sceneClassify 抛错 → fewshot=[] 且 log warn', async () => {
    const sidecar = mockSidecar({
      sceneClassify: () => Promise.reject(new Error('分类服务挂了')),
    });
    const { ctx, logs } = makeCtx(db, { sidecar, params: { styleId: 's1' }, nodeType: 'style.rag-retrieve' });

    const out = (await styleRagRetrieveNode.execute(ctx, { plan: fakePlan })) as { fewshot: string[] };
    expect(out.fewshot).toEqual([]);
    expect(logs.some((l) => l.includes('风格检索失败'))).toBe(true);
  });

  it('降级：ragQuery 抛错 → fewshot=[] 且 log warn', async () => {
    const sidecar = mockSidecar({
      sceneClassify: () => Promise.resolve({ sceneType: 'battle' as const, confidence: 0.9 }),
      ragQuery: () => Promise.reject(new Error('检索超时')),
    });
    const { ctx, logs } = makeCtx(db, { sidecar, params: { styleId: 's1' }, nodeType: 'style.rag-retrieve' });

    const out = (await styleRagRetrieveNode.execute(ctx, { plan: fakePlan })) as { fewshot: string[] };
    expect(out.fewshot).toEqual([]);
    expect(logs.some((l) => l.includes('风格检索失败'))).toBe(true);
  });

  it('无 styleId 且无风格档案 → fewshot=[]，不调 sidecar', async () => {
    let called = false;
    const sidecar = mockSidecar({
      sceneClassify: () => {
        called = true;
        return Promise.resolve({ sceneType: 'daily' as const, confidence: 0.5 });
      },
    });
    const { ctx } = makeCtx(db, { sidecar, params: {}, nodeType: 'style.rag-retrieve' });

    const out = (await styleRagRetrieveNode.execute(ctx, { plan: fakePlan })) as { fewshot: string[] };
    expect(out.fewshot).toEqual([]);
    expect(called).toBe(false);
  });

  it('无 sidecar → fewshot=[]', async () => {
    const { ctx } = makeCtx(db, { params: { styleId: 's1' }, nodeType: 'style.rag-retrieve' });
    const out = (await styleRagRetrieveNode.execute(ctx, { plan: fakePlan })) as { fewshot: string[] };
    expect(out.fewshot).toEqual([]);
  });
});
