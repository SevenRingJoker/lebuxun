/** 内建节点汇总（SPEC §14 Phase 3 · 核心节点 + Phase 5 · 风格节点）
 *
 * 注册 13 个节点：Phase 3 任务表 3.1-3.9 的 9 个 + context.memory
 * （main-loop.json 引用，承担记忆召回 / 任务书 3.7 memory.query 职责）
 * + Phase 5 风格三节点 context.style / style.rag-retrieve / style.discriminator。
 * 至此 main-loop.json 引用的全部节点类型均已注册，默认整图可运行
 * （sidecar 不可用时 style.* 节点按各自降级策略透传/空输出，见各节点注释）。
 */

import type { NodeRegistry } from '../registry.js';
import { chapterAccumulatorNode } from './chapter-accumulator.js';
import { chapterFinalizerNode } from './chapter-finalizer.js';
import { chapterNextStarterNode } from './chapter-next-starter.js';
import { contextMemoryNode } from './context-memory.js';
import { contextStyleNode } from './context-style.js';
import { generateChapterPlanNode } from './generate-chapter-plan.js';
import { generateParagraphMultiNode } from './generate-paragraph-multi.js';
import { inputContextNode } from './input-context.js';
import { memoryUpdaterNode } from './memory-updater.js';
import { reviewCandidatePickerNode } from './review-candidate-picker.js';
import { reviewChapterEndNode } from './review-chapter-end.js';
import { styleDiscriminatorNode } from './style-discriminator.js';
import { styleRagRetrieveNode } from './style-rag-retrieve.js';

export const builtinNodes = [
  inputContextNode,
  contextMemoryNode,
  contextStyleNode,
  generateChapterPlanNode,
  generateParagraphMultiNode,
  reviewCandidatePickerNode,
  chapterAccumulatorNode,
  reviewChapterEndNode,
  chapterFinalizerNode,
  memoryUpdaterNode,
  chapterNextStarterNode,
  styleRagRetrieveNode,
  styleDiscriminatorNode,
] as const;

export function registerBuiltinNodes(registry: NodeRegistry): void {
  for (const def of builtinNodes) {
    registry.register(def);
  }
}

export {
  buildContextPrompt,
  inputContextNode,
  type GenerationContext,
} from './input-context.js';
export { contextMemoryNode, type MemoryHit, type MemoryResult } from './context-memory.js';
export {
  buildStylePrompt,
  contextStyleNode,
  DEFAULT_STYLE_PROMPT,
  fingerprintSummaryLine,
} from './context-style.js';
export { styleRagRetrieveNode } from './style-rag-retrieve.js';
export { styleDiscriminatorNode } from './style-discriminator.js';
export { generateChapterPlanNode } from './generate-chapter-plan.js';
export { generateParagraphMultiNode } from './generate-paragraph-multi.js';
export { reviewCandidatePickerNode } from './review-candidate-picker.js';
export {
  chapterAccumulatorNode,
  ensureWritingChapter,
  type ChapterDraft,
} from './chapter-accumulator.js';
export { reviewChapterEndNode, readChapterEndDecision } from './review-chapter-end.js';
export { chapterFinalizerNode, type MemoryUpdate } from './chapter-finalizer.js';
export { memoryUpdaterNode, type MemoryUpdaterOutput } from './memory-updater.js';
export { chapterNextStarterNode } from './chapter-next-starter.js';
