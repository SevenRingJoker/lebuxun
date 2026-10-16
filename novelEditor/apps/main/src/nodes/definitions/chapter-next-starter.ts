/** SPEC §7.3 chapter.next-starter：memory → context（下一章起始上下文）
 *
 * 在 memory.updater 之后运行：读 DB 中最新章节摘要，组装下一章 GenerationContext，
 * 回环到 generate.chapter-plan（主循环最后一环）。
 * worldSetting / characters / userInput 从 node.params 透传（与 input.context 参数语义一致）。
 */

import { ChaptersRepository } from '../../db/repositories/chapters.js';
import { ProjectsRepository } from '../../db/repositories/projects.js';
import type { NodeDefinition } from '../types.js';
import { buildContextPrompt, type GenerationContext } from './input-context.js';
import type { MemoryUpdaterOutput } from './memory-updater.js';

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string' && value.trim() !== '') return [value];
  return [];
}

export const chapterNextStarterNode: NodeDefinition = {
  type: 'chapter.next-starter',
  title: '下一章起始',
  inputs: [{ name: 'memory', dataType: '{ chunkId, kind }', required: true }],
  outputs: [{ name: 'context', dataType: 'GenerationContext' }],
  params: [
    { name: 'worldSetting', type: 'string', default: '', description: '世界观设定' },
    { name: 'characters', type: 'json', default: [], description: '人物卡（字符串数组）' },
    { name: 'userInput', type: 'string', default: '', description: '用户指令' },
  ],
  async execute(ctx, input) {
    const memory = input['memory'] as MemoryUpdaterOutput['memory'] | undefined;
    if (!memory) throw new Error('chapter.next-starter 缺少 memory 输入');

    const project = new ProjectsRepository(ctx.db).get(ctx.projectId);
    if (!project) throw new Error(`项目不存在: ${ctx.projectId}`);

    const chapters = new ChaptersRepository(ctx.db).listByProject(ctx.projectId);
    const previousSummaries = chapters
      .filter((c) => c.summary != null && c.summary !== '')
      .map((c) => `第${c.index}章 ${c.title}：${c.summary}`);

    const chapterIndex = (chapters[chapters.length - 1]?.index ?? 0) + 1;
    const base = {
      projectId: project.id,
      projectName: project.name,
      genre: project.genre,
      chapterIndex,
      worldSetting: String(ctx.node.params['worldSetting'] ?? ''),
      characters: asStringArray(ctx.node.params['characters']),
      userInput: String(ctx.node.params['userInput'] ?? ''),
      previousSummaries,
    };
    const context: GenerationContext = { ...base, prompt: buildContextPrompt(base) };
    ctx.log(`下一章起始上下文就绪：第 ${chapterIndex} 章，前情摘要 ${previousSummaries.length} 条`);
    return { context };
  },
};
