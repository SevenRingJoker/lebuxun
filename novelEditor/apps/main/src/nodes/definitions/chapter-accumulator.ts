/** SPEC §7.3 chapter.accumulator：selected → chapterDraft（段落追加）
 *
 * NodeContext 不暴露 RunState，跨循环轮的草稿必须落库（§7.3 依赖 DB）：
 * - 选中段落立即写 paragraphs 表（章不存在则先建 status='writing' 的草稿章，
 *   章号取 chapters 表 max(idx)+1）；
 * - chapterDraft 为从 DB 读回的全量段落 + 拼接正文（段落间空行）。
 * scene_type 暂填 'daily'（场景分类是 Phase 5 /scene/classify 的职责，注释登记）。
 * selected 为 null（reject-all / 标记动作后的空 resume）时不追加，仅读回当前草稿。
 */

import { nanoid } from 'nanoid';
import type { Candidate, Chapter, Paragraph } from '@novel-forge/shared';
import type { AppDatabase } from '../../db/index.js';
import { ChaptersRepository } from '../../db/repositories/chapters.js';
import { ParagraphsRepository } from '../../db/repositories/paragraphs.js';
import type { NodeDefinition } from '../types.js';

export interface ChapterDraft {
  chapterId: string;
  chapterIndex: number;
  paragraphs: Paragraph[];
  /** 段落拼接正文（段落间空行） */
  text: string;
}

/** 取当前写作章；不存在则创建 status='writing' 草稿章 */
export function ensureWritingChapter(ctx: {
  db: AppDatabase;
  projectId: string;
  log: (msg: string) => void;
}): Chapter {
  const chapters = new ChaptersRepository(ctx.db);
  const writing = chapters.findWriting(ctx.projectId);
  if (writing) return writing;
  const index = chapters.nextIndex(ctx.projectId);
  const now = Date.now();
  const chapter: Chapter = {
    id: nanoid(),
    projectId: ctx.projectId,
    index,
    title: `第${index}章`,
    status: 'writing',
    wordCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  chapters.insert(chapter);
  ctx.log(`新建草稿章：第 ${index} 章（${chapter.id}）`);
  return chapter;
}

export function buildDraft(chapters: ChaptersRepository, paragraphsRepo: ParagraphsRepository, chapter: Chapter): ChapterDraft {
  const paragraphs = paragraphsRepo.listByChapter(chapter.id);
  return {
    chapterId: chapter.id,
    chapterIndex: chapter.index,
    paragraphs,
    text: paragraphs.map((p) => p.text).join('\n\n'),
  };
}

export const chapterAccumulatorNode: NodeDefinition = {
  type: 'chapter.accumulator',
  title: '章节累加器',
  inputs: [{ name: 'selected', dataType: 'Candidate | null', required: true }],
  outputs: [{ name: 'chapterDraft', dataType: 'ChapterDraft' }],
  params: [],
  async execute(ctx, input) {
    const selected = input['selected'] as Candidate | null | undefined;
    const chapter = ensureWritingChapter(ctx);
    const paragraphsRepo = new ParagraphsRepository(ctx.db);

    if (selected != null && selected.text.trim() !== '') {
      paragraphsRepo.insert({
        id: nanoid(),
        chapterId: chapter.id,
        index: paragraphsRepo.countByChapter(chapter.id),
        text: selected.text,
        sceneType: 'daily', // 场景分类由 Phase 5 /scene/classify 补
        metadata: { candidateId: selected.id, runId: ctx.runId, nodeId: ctx.nodeId },
      });
      ctx.log(`追加段落（候选 ${selected.id}）到第 ${chapter.index} 章`);
    } else {
      ctx.log('selected 为空，不追加段落（读回当前草稿）');
    }

    const draft = buildDraft(new ChaptersRepository(ctx.db), paragraphsRepo, chapter);
    return { chapterDraft: draft };
  },
};
