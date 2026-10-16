/** SPEC §7.3 generate.chapter-plan：context + memory → plan（ChapterPlan）
 *
 * LLM 结构化输出（§7.7 ChapterPlanSchema，format=json + zod-to-json-schema，
 * 路由 chapter-plan 温度 0）。解析失败带错误回显重试 1 次，再失败抛错（chatJson）。
 */

import { ChapterPlanSchema, type ChapterPlan } from '@novel-forge/shared';
import { getModelRouter } from '../../llm/router-instance.js';
import type { NodeDefinition } from '../types.js';
import type { GenerationContext } from './input-context.js';
import type { MemoryResult } from './context-memory.js';
import { chatJson } from './llm-json.js';

const SYSTEM_PROMPT =
  '你是小说章节策划。根据用户给出的上下文，规划本章大纲，只输出符合要求的 JSON，不要输出其他内容。';

export const generateChapterPlanNode: NodeDefinition = {
  type: 'generate.chapter-plan',
  title: '章节规划',
  inputs: [
    { name: 'context', dataType: 'GenerationContext', required: true },
    { name: 'memory', dataType: 'MemoryResult' },
  ],
  outputs: [{ name: 'plan', dataType: 'ChapterPlan' }],
  params: [],
  async execute(ctx, input) {
    if (!ctx.llm) throw new Error('generate.chapter-plan 需要 LLM（NodeContext.llm 未注入）');
    const context = input['context'] as GenerationContext | undefined;
    if (!context) throw new Error('generate.chapter-plan 缺少输入 context');
    const memory = input['memory'] as MemoryResult | undefined;

    let userPrompt = context.prompt;
    if (memory && memory.hits.length > 0) {
      userPrompt += `\n\n【相关记忆】\n${memory.hits.map((h) => `- ${h.content}`).join('\n')}`;
    }
    userPrompt +=
      '\n\n请规划本章大纲，输出 JSON：{"title","goal","conflict","hook","estimatedParagraphs":3-30,"keyBeats":[]}';

    const plan = await chatJson<ChapterPlan>({
      llm: ctx.llm,
      // 取全局单例（ctx.router 优先）以支持设置面板运行时覆盖
      router: ctx.router ?? getModelRouter(),
      task: 'chapter-plan',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      schema: ChapterPlanSchema,
      log: ctx.log,
    });
    ctx.log(`章节规划完成：《${plan.title}》预计 ${plan.estimatedParagraphs} 段`);
    return { plan };
  },
};
