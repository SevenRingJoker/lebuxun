/** input.context 单测：上下文拼接 + 章节序号推导 + 项目不存在 */

import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type AppDatabase } from '../../db/index.js';
import { ChaptersRepository } from '../../db/repositories/chapters.js';
import { inputContextNode, type GenerationContext } from './input-context.js';
import { makeCtx, seedProject } from './test-helpers.js';

let db: AppDatabase;

beforeEach(async () => {
  db = await openDatabase(':memory:');
  seedProject(db);
});

describe('input.context', () => {
  it('正常路径：params + DB 前情摘要拼成四段式 prompt', async () => {
    new ChaptersRepository(db).insert({
      id: 'ch1',
      projectId: 'p1',
      index: 1,
      title: '出山',
      status: 'final',
      wordCount: 2000,
      summary: '少年下山历练。',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const { ctx } = makeCtx(db, {
      params: {
        worldSetting: '九州大陆，修仙者林立',
        characters: ['林尘：主角，筑基期', '苏瑶：女主'],
        userInput: '本章写林尘初遇苏瑶',
      },
    });
    const out = (await inputContextNode.execute(ctx, {})) as { context: GenerationContext };
    const { context } = out;

    expect(context.chapterIndex).toBe(2); // 已有第 1 章，自动取下一章
    expect(context.previousSummaries).toHaveLength(1);
    expect(context.previousSummaries[0]).toContain('出山');
    expect(context.prompt).toContain('【世界观】\n九州大陆');
    expect(context.prompt).toContain('【人物卡】\n- 林尘：主角，筑基期');
    expect(context.prompt).toContain('【前情摘要】\n第1章 出山：少年下山历练。');
    expect(context.prompt).toContain('【用户指令】\n本章写林尘初遇苏瑶');
    expect(context.prompt).toContain('第 2 章');
  });

  it('边界：无章节时 chapterIndex=1，前情为开篇占位', async () => {
    const { ctx } = makeCtx(db, { params: {} });
    const out = (await inputContextNode.execute(ctx, {})) as { context: GenerationContext };
    expect(out.context.chapterIndex).toBe(1);
    expect(out.context.previousSummaries).toEqual([]);
    expect(out.context.prompt).toContain('（开篇，无前情）');
    expect(out.context.prompt).toContain('（未设定）');
  });

  it('失败路径：项目不存在抛错', async () => {
    const { ctx } = makeCtx(db, { projectId: 'no-such' });
    await expect(inputContextNode.execute(ctx, {})).rejects.toThrow(/项目不存在/);
  });
});
