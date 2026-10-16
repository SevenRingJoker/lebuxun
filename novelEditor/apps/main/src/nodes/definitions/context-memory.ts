/** SPEC §7.3 context.memory（即任务书 3.7 的 memory.query）：context → memory
 *
 * 两路记忆召回：
 * 1. DB memory_chunks（memory.updater 写入的章节摘要等，取最近 topK 条）；
 * 2. sidecar /rag/query（需 params.styleId，风格库向量检索）。
 * sidecar 不可用 / 查询失败仅降级为空命中（warn），不阻断主流程。
 */

import { MemoryChunksRepository } from '../../db/repositories/memory-chunks.js';
import type { NodeDefinition } from '../types.js';
import type { GenerationContext } from './input-context.js';

export interface MemoryHit {
  id: string;
  content: string;
  source: 'db' | 'rag';
  score?: number;
}

export interface MemoryResult {
  hits: MemoryHit[];
}

export const contextMemoryNode: NodeDefinition = {
  type: 'context.memory',
  title: '记忆召回',
  inputs: [{ name: 'context', dataType: 'GenerationContext', required: true }],
  outputs: [{ name: 'memory', dataType: 'MemoryResult' }],
  params: [
    { name: 'topK', type: 'number', default: 5, description: '召回条数上限' },
    { name: 'styleId', type: 'string', default: '', description: '风格库 id（空则跳过 RAG 检索）' },
  ],
  async execute(ctx, input) {
    const context = input['context'] as GenerationContext | undefined;
    const topK = Number(ctx.node.params['topK'] ?? 5);

    // DB 记忆：最近写入的章节摘要/笔记
    const chunks = new MemoryChunksRepository(ctx.db).listRecent(ctx.projectId, topK);
    const hits: MemoryHit[] = chunks.map((c) => ({ id: c.id, content: c.content, source: 'db' }));

    // RAG 检索：风格库例句（sidecar 不可用时降级）
    const styleId = String(ctx.node.params['styleId'] ?? '');
    if (styleId !== '' && ctx.sidecar) {
      try {
        const res = await ctx.sidecar.ragQuery({ styleId, query: context?.prompt ?? '', topK });
        for (const r of res.results) {
          hits.push({ id: r.id, content: r.text, source: 'rag', score: r.score });
        }
      } catch (err) {
        ctx.log(`RAG 检索失败，降级为仅 DB 记忆：${err instanceof Error ? err.message : String(err)}`);
      }
    }

    ctx.log(`记忆召回：${hits.length} 条（DB ${chunks.length} 条）`);
    return { memory: { hits } satisfies MemoryResult };
  },
};
