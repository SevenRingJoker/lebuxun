/** SPEC §7.7 结构化输出（Zod → JSON Schema）。Zod 锁定 3.x（4.x 与 Ollama 不兼容） */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

export const ChapterPlanSchema = z.object({
  title: z.string(),
  goal: z.string(),
  conflict: z.string(),
  hook: z.string(),
  estimatedParagraphs: z.number().int().min(3).max(30),
  keyBeats: z.array(z.string()),
});
export type ChapterPlan = z.infer<typeof ChapterPlanSchema>;

export const ParagraphCandidatesSchema = z.object({
  candidates: z.array(z.object({
    text: z.string(),
    strategy: z.enum(['稳健', '平衡', '冒险']),
    pacing: z.number().min(0).max(1),
  })).min(1).max(7),
});
export type ParagraphCandidates = z.infer<typeof ParagraphCandidatesSchema>;

/** 转成 Ollama /api/chat `format` 参数接受的 JSON Schema */
export function toOllamaFormat<T extends z.ZodType>(schema: T): Record<string, unknown> {
  return zodToJsonSchema(schema, { target: 'openApi3' }) as Record<string, unknown>;
}
