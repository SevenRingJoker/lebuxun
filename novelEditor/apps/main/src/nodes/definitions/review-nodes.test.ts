/** review.candidate-picker + review.chapter-end 单测（pause / onResume 映射） */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Candidate } from '@novel-forge/shared';
import { openDatabase, type AppDatabase } from '../../db/index.js';
import { CandidatesRepository } from '../../db/repositories/candidates.js';
import { reviewCandidatePickerNode } from './review-candidate-picker.js';
import { readChapterEndDecision, reviewChapterEndNode } from './review-chapter-end.js';
import type { ChapterDraft } from './chapter-accumulator.js';
import { makeCtx, mockLlm, seedProject, seedRun } from './test-helpers.js';

let db: AppDatabase;

beforeEach(async () => {
  db = await openDatabase(':memory:');
  seedProject(db);
  seedRun(db);
});

function fakeCandidate(id: string, text = `${id} 正文`): Candidate {
  return {
    id,
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

describe('review.candidate-picker', () => {
  it('execute 透传候选作为面板 payload（pause=true）', async () => {
    expect(reviewCandidatePickerNode.pause).toBe(true);
    const candidates = [fakeCandidate('c1'), fakeCandidate('c2')];
    const { ctx } = makeCtx(db);
    const out = (await reviewCandidatePickerNode.execute(ctx, { candidates })) as {
      candidates: Candidate[];
    };
    expect(out.candidates).toEqual(candidates);
  });

  it('onResume select：输出 selected（支持 editedText），DB 标记 selected=1', async () => {
    const c1 = fakeCandidate('c1');
    new CandidatesRepository(db).insert(c1);
    const { ctx } = makeCtx(db);
    const payload = { candidates: [c1, fakeCandidate('c2')] };

    const out = (await reviewCandidatePickerNode.onResume!(
      ctx,
      { type: 'select', candidateId: 'c1', editedText: '改后正文' },
      payload,
    )) as { selected: Candidate };
    expect(out.selected.id).toBe('c1');
    expect(out.selected.text).toBe('改后正文');
    expect(db.prepare('SELECT selected FROM candidates WHERE id = ?').get('c1')).toEqual({
      selected: 1,
    });
  });

  it('onResume select：候选不存在抛错；reject-all 输出空 selected + 信号', async () => {
    const { ctx } = makeCtx(db);
    const payload = { candidates: [fakeCandidate('c1')] };
    await expect(
      reviewCandidatePickerNode.onResume!(ctx, { type: 'select', candidateId: 'nope' }, payload),
    ).rejects.toThrow(/候选不存在/);

    const out = (await reviewCandidatePickerNode.onResume!(
      ctx,
      { type: 'reject-all', reason: '都不行' },
      payload,
    )) as { selected: unknown; rejected: boolean };
    expect(out.selected).toBeNull();
    expect(out.rejected).toBe(true);
  });

  it('onResume satisfy/dissatisfy：满意度落库', async () => {
    const c1 = fakeCandidate('c1');
    new CandidatesRepository(db).insert(c1);
    const { ctx } = makeCtx(db);
    const payload = { candidates: [c1] };

    await reviewCandidatePickerNode.onResume!(ctx, { type: 'satisfy', candidateId: 'c1' }, payload);
    expect(new CandidatesRepository(db).get('c1')!.satisfaction).toBe('satisfied');

    await reviewCandidatePickerNode.onResume!(
      ctx,
      { type: 'dissatisfy', candidateId: 'c1', reason: '节奏太慢', reasonTags: ['节奏太慢'] },
      payload,
    );
    const stored = new CandidatesRepository(db).get('c1')!;
    expect(stored.satisfaction).toBe('unsatisfied');
    expect(stored.satisfactionReason).toBe('节奏太慢');
  });

  it('onResume regenerate-from：调用同一重生成逻辑，新候选落库 + 返回 newCandidateIds', async () => {
    const parent = fakeCandidate('c1');
    new CandidatesRepository(db).insert(parent);
    const llm = mockLlm((req) => {
      const user = req.messages[req.messages.length - 1]!.content;
      if (user.includes('六个维度')) {
        return '{"candidates":[{"pacing":0.6,"character":0.6,"consistency":0.6,"profileFit":0.6,"styleSimilarity":0.6,"rewardScore":0.6}]}';
      }
      return '重生成正文';
    });
    const { ctx, events } = makeCtx(db, { llm });
    const payload = { candidates: [parent] };

    const out = (await reviewCandidatePickerNode.onResume!(
      ctx,
      { type: 'regenerate-from', candidateId: 'c1', mode: 'improve' },
      payload,
    )) as { selected: unknown; newCandidateIds: string[] };

    expect(out.selected).toBeNull();
    expect(out.newCandidateIds).toHaveLength(1);
    const child = new CandidatesRepository(db).get(out.newCandidateIds[0]!)!;
    expect(child.parentCandidateId).toBe('c1');
    expect(child.generationMode).toBe('improve');
    expect(events.some((e) => e.type === 'candidate:generated')).toBe(true);
  });

  it('onResume mix（§15 混合选）：多源 span 合并输出 selected={text,mode,sources}', async () => {
    const repo = new CandidatesRepository(db);
    repo.insert(fakeCandidate('c1', 'ABCDEF'));
    repo.insert(fakeCandidate('c2', '123456'));
    const { ctx } = makeCtx(db);
    const payload = { candidates: [fakeCandidate('c1'), fakeCandidate('c2')] };

    const out = (await reviewCandidatePickerNode.onResume!(
      ctx,
      {
        type: 'mix',
        sources: [
          { candidateId: 'c1', span: [1, 4] },
          { candidateId: 'c2', span: [0, 3] },
        ],
      },
      payload,
    )) as { selected: { text: string; mode: string; sources: unknown[] } };
    expect(out.selected.text).toBe('BCD\n123');
    expect(out.selected.mode).toBe('mix');
    expect(out.selected.sources).toHaveLength(2);
  });

  it('onResume mix：越界片段容错忽略；空 sources 抛错', async () => {
    const repo = new CandidatesRepository(db);
    repo.insert(fakeCandidate('c1', 'ABCDEF'));
    const { ctx } = makeCtx(db);
    const payload = { candidates: [fakeCandidate('c1')] };

    const out = (await reviewCandidatePickerNode.onResume!(
      ctx,
      {
        type: 'mix',
        sources: [
          { candidateId: 'c1', span: [-5, 2] }, // 越界忽略
          { candidateId: 'c1', span: [0, 2] },
        ],
      },
      payload,
    )) as { selected: { text: string } };
    expect(out.selected.text).toBe('AB');

    await expect(
      reviewCandidatePickerNode.onResume!(ctx, { type: 'mix', sources: [] }, payload),
    ).rejects.toThrow(/sources 不能为空/);
  });

  it('onResume regenerate-from 无 LLM 抛错', async () => {
    const parent = fakeCandidate('c1');
    new CandidatesRepository(db).insert(parent);
    const { ctx } = makeCtx(db);
    await expect(
      reviewCandidatePickerNode.onResume!(
        ctx,
        { type: 'regenerate-from', candidateId: 'c1', mode: 'improve' },
        { candidates: [parent] },
      ),
    ).rejects.toThrow(/需要 LLM/);
  });
});

describe('review.chapter-end', () => {
  const draft: ChapterDraft = {
    chapterId: 'ch1',
    chapterIndex: 1,
    paragraphs: [],
    text: '正文',
  };

  it('execute 透传 chapterDraft（pause=true）', async () => {
    expect(reviewChapterEndNode.pause).toBe(true);
    const { ctx } = makeCtx(db);
    const out = (await reviewChapterEndNode.execute(ctx, { chapterDraft: draft })) as {
      chapterDraft: ChapterDraft;
      paragraphCount: number;
    };
    expect(out.chapterDraft).toEqual(draft);
    expect(out.paragraphCount).toBe(0);
  });

  it('onResume：decision=continue/end 映射；缺省按 end', async () => {
    const { ctx } = makeCtx(db);
    const payload = { chapterDraft: draft, paragraphCount: 3 };

    const cont = (await reviewChapterEndNode.onResume!(
      ctx,
      { type: 'select', candidateId: 'x', decision: 'continue' } as never,
      payload,
    )) as { decision: string; chapterDraft: ChapterDraft };
    expect(cont.decision).toBe('continue');
    expect(cont.chapterDraft).toEqual(draft);

    const end = (await reviewChapterEndNode.onResume!(
      ctx,
      { type: 'select', candidateId: 'x' },
      payload,
    )) as { decision: string };
    expect(end.decision).toBe('end'); // 无 decision 字段 → 安全默认 end
  });

  it('readChapterEndDecision：仅显式 continue 才继续', () => {
    expect(readChapterEndDecision({ type: 'select', candidateId: 'x', decision: 'continue' } as never)).toBe('continue');
    expect(readChapterEndDecision({ type: 'select', candidateId: 'x', decision: 'end' } as never)).toBe('end');
    expect(readChapterEndDecision({ type: 'select', candidateId: 'x' })).toBe('end');
  });
});
