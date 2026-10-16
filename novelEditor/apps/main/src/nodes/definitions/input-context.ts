/** SPEC §7.3 input.context：无输入 → 输出 context（生成上下文 + 拼接好的 prompt）
 *
 * 上下文来源：projects 表（项目/题材）+ chapters 表（前情摘要）+ node.params
 * （worldSetting / characters / userInput / chapterIndex 覆盖）。
 * prompt 模板为本文件常量（世界观 / 人物卡 / 前情摘要 / 用户指令 四段式），
 * chapter.next-starter 复用 buildContextPrompt 拼下一章上下文。
 */

import { ProjectsRepository } from '../../db/repositories/projects.js';
import { ChaptersRepository } from '../../db/repositories/chapters.js';
import type { NodeDefinition } from '../types.js';

/** 生成上下文（input.context 输出 / chapter.next-starter 回环输出共用结构） */
export interface GenerationContext {
  projectId: string;
  projectName: string;
  genre: string;
  /** 本章序号（1 起） */
  chapterIndex: number;
  worldSetting: string;
  characters: string[];
  userInput: string;
  /** 既往章节摘要（按章节序号升序） */
  previousSummaries: string[];
  /** 按固定模板拼接的完整生成 prompt */
  prompt: string;
}

/** 四段式 prompt 模板（SPEC 未给模板文本，按任务约定补全，SPEC-CHANGELOG 登记） */
export function buildContextPrompt(ctx: Omit<GenerationContext, 'prompt'>): string {
  const sections: string[] = [];
  sections.push(`【作品】《${ctx.projectName}》（${ctx.genre}）第 ${ctx.chapterIndex} 章`);
  sections.push(`【世界观】\n${ctx.worldSetting || '（未设定）'}`);
  sections.push(
    `【人物卡】\n${ctx.characters.length > 0 ? ctx.characters.map((c) => `- ${c}`).join('\n') : '（未设定）'}`,
  );
  sections.push(
    `【前情摘要】\n${ctx.previousSummaries.length > 0 ? ctx.previousSummaries.join('\n') : '（开篇，无前情）'}`,
  );
  sections.push(`【用户指令】\n${ctx.userInput || '（无额外指令，按大纲自由发挥）'}`);
  return sections.join('\n\n');
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string' && value.trim() !== '') return [value];
  return [];
}

export const inputContextNode: NodeDefinition = {
  type: 'input.context',
  title: '输入上下文',
  inputs: [],
  outputs: [{ name: 'context', dataType: 'GenerationContext', description: '生成上下文 + prompt' }],
  params: [
    { name: 'worldSetting', type: 'string', default: '', description: '世界观设定' },
    { name: 'characters', type: 'json', default: [], description: '人物卡（字符串数组）' },
    { name: 'userInput', type: 'string', default: '', description: '本章用户指令' },
    { name: 'chapterIndex', type: 'number', default: 0, description: '章节序号覆盖（0=自动取下一章）' },
  ],
  async execute(ctx) {
    const project = new ProjectsRepository(ctx.db).get(ctx.projectId);
    if (!project) {
      throw new Error(`项目不存在: ${ctx.projectId}`);
    }
    const chapters = new ChaptersRepository(ctx.db).listByProject(ctx.projectId);
    const previousSummaries = chapters
      .filter((c) => c.summary != null && c.summary !== '')
      .map((c) => `第${c.index}章 ${c.title}：${c.summary}`);

    const paramIndex = Number(ctx.node.params['chapterIndex'] ?? 0);
    const chapterIndex = paramIndex > 0 ? paramIndex : (chapters[chapters.length - 1]?.index ?? 0) + 1;

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
    ctx.log(`上下文就绪：第 ${chapterIndex} 章，前情摘要 ${previousSummaries.length} 条`);
    return { context };
  },
};
