/** generate.chapter-plan 单测：结构化输出解析 / 重试 / 重试耗尽抛错 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { ChapterPlan } from '@novel-forge/shared';
import { openDatabase, type AppDatabase } from '../../db/index.js';
import { generateChapterPlanNode } from './generate-chapter-plan.js';
import type { GenerationContext } from './input-context.js';
import { makeCtx, mockLlm, seedProject } from './test-helpers.js';

let db: AppDatabase;

beforeEach(async () => {
  db = await openDatabase(':memory:');
  seedProject(db);
});

const context: GenerationContext = {
  projectId: 'p1',
  projectName: '测试项目',
  genre: '仙侠',
  chapterIndex: 1,
  worldSetting: '九州大陆',
  characters: ['林尘'],
  userInput: '',
  previousSummaries: [],
  prompt: '【作品】《测试项目》',
};

const validPlan: ChapterPlan = {
  title: '出山',
  goal: '引出主角',
  conflict: '宗门任务',
  hook: '山下有妖',
  estimatedParagraphs: 5,
  keyBeats: ['下山', '遇妖'],
};

describe('generate.chapter-plan', () => {
  it('正常路径：合法 JSON 解析为 ChapterPlan', async () => {
    const llm = mockLlm(() => JSON.stringify(validPlan));
    const { ctx } = makeCtx(db, { llm });
    const out = (await generateChapterPlanNode.execute(ctx, { context })) as { plan: ChapterPlan };
    expect(out.plan).toEqual(validPlan);
  });

  it('重试路径：首次返回垃圾，错误回显后第二次返回合法 JSON', async () => {
    const seen: string[] = [];
    const llm = mockLlm((req) => {
      const last = req.messages[req.messages.length - 1]!;
      seen.push(last.content);
      if (seen.length === 1) return '这不是 JSON';
      return JSON.stringify(validPlan);
    });
    const { ctx, logs } = makeCtx(db, { llm });
    const out = (await generateChapterPlanNode.execute(ctx, { context })) as { plan: ChapterPlan };
    expect(out.plan.title).toBe('出山');
    expect(seen).toHaveLength(2);
    expect(seen[1]).toContain('不是合法 JSON'); // 错误回显
    expect(logs.some((l) => l.includes('解析失败'))).toBe(true);
  });

  it('失败路径：两次均非法则抛错；无 LLM 注入抛错', async () => {
    const llm = mockLlm(() => '仍然是垃圾');
    const { ctx } = makeCtx(db, { llm });
    await expect(generateChapterPlanNode.execute(ctx, { context })).rejects.toThrow(
      /重试 2 次均失败/,
    );

    const { ctx: noLlm } = makeCtx(db);
    await expect(generateChapterPlanNode.execute(noLlm, { context })).rejects.toThrow(/需要 LLM/);
  });

  it('容错：模型包裹 ```json 代码块也能解析', async () => {
    const llm = mockLlm(() => `好的，大纲如下：\n\`\`\`json\n${JSON.stringify(validPlan)}\n\`\`\``);
    const { ctx } = makeCtx(db, { llm });
    const out = (await generateChapterPlanNode.execute(ctx, { context })) as { plan: ChapterPlan };
    expect(out.plan.estimatedParagraphs).toBe(5);
  });
});
