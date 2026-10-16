/** SPEC §7.3 / §9.2 review.chapter-end（pause 节点）：chapterDraft → decision
 *
 * execute：透传 chapterDraft 作为"继续/结束"判定面板 payload，引擎挂起。
 * onResume：输出 { decision: 'continue' | 'end', chapterDraft }——
 * §6.3 UserAction 联合类型无章节结束动作，调用方以扩展字段
 * `{ decision: 'continue' | 'end' }` 携带判定（SPEC-CHANGELOG 登记）；
 * 缺省按 'end' 收尾（防死循环的安全默认）。
 */

import type { UserAction } from '@novel-forge/shared';
import type { NodeDefinition } from '../types.js';
import type { ChapterDraft } from './chapter-accumulator.js';

interface ChapterEndPayload {
  chapterDraft: ChapterDraft | null;
  paragraphCount: number;
}

/** §9.2 决策读取：userAction 扩展字段 decision（非 'continue' 一律按 'end'） */
export function readChapterEndDecision(userAction: UserAction): 'continue' | 'end' {
  const decision = (userAction as unknown as { decision?: unknown }).decision;
  return decision === 'continue' ? 'continue' : 'end';
}

export const reviewChapterEndNode: NodeDefinition = {
  type: 'review.chapter-end',
  title: '章节结束判定',
  inputs: [{ name: 'chapterDraft', dataType: 'ChapterDraft', required: true }],
  outputs: [
    { name: 'decision', dataType: "'continue' | 'end'" },
    { name: 'chapterDraft', dataType: 'ChapterDraft' },
  ],
  params: [],
  pause: true,
  async execute(_ctx, input): Promise<ChapterEndPayload> {
    const chapterDraft = (input['chapterDraft'] as ChapterDraft | undefined) ?? null;
    return { chapterDraft, paragraphCount: chapterDraft?.paragraphs.length ?? 0 };
  },
  async onResume(ctx, userAction, pausedPayload) {
    const payload = (pausedPayload ?? { chapterDraft: null, paragraphCount: 0 }) as ChapterEndPayload;
    const decision = readChapterEndDecision(userAction);
    ctx.log(`章节判定：${decision === 'continue' ? '继续写' : '本章结束'}（已积累 ${payload.paragraphCount} 段）`);
    return { decision, chapterDraft: payload.chapterDraft };
  },
};
