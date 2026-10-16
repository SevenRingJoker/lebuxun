/** SPEC §7.3 chapter.finalizer：chapterDraft → finalChapter + memoryUpdate
 *
 * 职责：
 * 1. 调用 LLM（chapter-plan 路由温度 0）为章节正文生成 title + summary（≤300 字），
 *    format=json 结构化输出（本地 zod schema，重试 1 次后回退）；
 * 2. 更新 chapters 表（title / summary / word_count / status='draft'）；
 * 3. 输出 finalChapter（Chapter）与 memoryUpdate（memory.updater 的输入）。
 */

import { nanoid } from 'nanoid';
import { z } from 'zod';
import type { Chapter } from '@novel-forge/shared';
import { ChaptersRepository } from '../../db/repositories/chapters.js';
import { getModelRouter } from '../../llm/router-instance.js';
import type { NodeDefinition } from '../types.js';
import type { ChapterDraft } from './chapter-accumulator.js';
import { chatJson } from './llm-json.js';

const FinalizeSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1).max(1000),
});

export interface MemoryUpdate {
  chapterId: string;
  chapterIndex: number;
  title: string;
  summary: string;
  text: string;
}

function fallbackTitle(chapterIndex: number): string {
  return `第${chapterIndex}章`;
}

function fallbackSummary(text: string): string {
  return text.replace(/\s+/g, '').slice(0, 300);
}

const SYSTEM_PROMPT =
  '你是小说编辑。根据章节正文，给出标题和不超过 300 字的摘要。只输出 JSON，不要输出其他内容。';

export const chapterFinalizerNode: NodeDefinition = {
  type: 'chapter.finalizer',
  title: '章节定稿',
  inputs: [{ name: 'chapterDraft', dataType: 'ChapterDraft', required: true }],
  outputs: [
    { name: 'finalChapter', dataType: 'Chapter' },
    { name: 'memoryUpdate', dataType: 'MemoryUpdate' },
  ],
  params: [],
  async execute(ctx, input) {
    if (!ctx.llm) throw new Error('chapter.finalizer 需要 LLM（NodeContext.llm 未注入）');
    const draft = input['chapterDraft'] as ChapterDraft | undefined;
    if (!draft) throw new Error('chapter.finalizer 缺少 chapterDraft 输入');

    const chaptersRepo = new ChaptersRepository(ctx.db);
    const chapter = chaptersRepo.get(draft.chapterId);
    if (!chapter) throw new Error(`草稿章不存在: ${draft.chapterId}`);

    let title = chapter.title;
    let summary = '';
    try {
      const result = await chatJson<z.infer<typeof FinalizeSchema>>({
        llm: ctx.llm,
        // 取全局单例（ctx.router 优先）以支持设置面板运行时覆盖
        router: ctx.router ?? getModelRouter(),
        task: 'chapter-plan',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: `【章节正文】\n${draft.text}\n\n请给出 JSON：{"title", "summary"}`
          },
        ],
        schema: FinalizeSchema,
        log: ctx.log,
      });
      title = result.title;
      summary = result.summary;
    } catch (err) {
      // 最终节点不应因 LLM 故障直接崩溃：回退到占位值，并 log 告警
      title = fallbackTitle(chapter.index);
      summary = fallbackSummary(draft.text);
      ctx.log(
        `摘要生成失败，已回退到占位值：${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const wordCount = draft.text.replace(/\s+/g, '').length;
    const now = Date.now();
    const finalChapter: Chapter = {
      ...chapter,
      title,
      status: 'draft',
      wordCount,
      summary,
      updatedAt: now,
    };
    chaptersRepo.update(finalChapter);

    const memoryUpdate: MemoryUpdate = {
      chapterId: finalChapter.id,
      chapterIndex: finalChapter.index,
      title: finalChapter.title,
      summary,
      text: draft.text,
    };
    ctx.log(`章节定稿：${title}（${wordCount} 字）`);
    return { finalChapter, memoryUpdate };
  },
};
