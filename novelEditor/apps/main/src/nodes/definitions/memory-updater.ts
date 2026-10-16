/** SPEC §7.3 memory.updater：memoryUpdate → memory（记忆库更新）
 *
 * 职责：
 * 1. 把 chapter.finalizer 产出（标题 / 摘要 / 正文）写入 memory_chunks 表；
 * 2. 可选（params.styleId 非空且 sidecar 在线）把摘要作为 RAG chunk fire-and-forget
 *    调 /rag/index，失败仅 warn，不阻塞主流程。
 */

import { nanoid } from 'nanoid';
import type { SceneType } from '@novel-forge/shared';
import { MemoryChunksRepository } from '../../db/repositories/memory-chunks.js';
import type { NodeDefinition } from '../types.js';
import type { MemoryUpdate } from './chapter-finalizer.js';

export interface MemoryUpdaterOutput {
  memory: {
    chunkId: string;
    kind: 'chapter-summary';
  };
}

export const memoryUpdaterNode: NodeDefinition = {
  type: 'memory.updater',
  title: '记忆更新',
  inputs: [{ name: 'memoryUpdate', dataType: 'MemoryUpdate', required: true }],
  outputs: [{ name: 'memory', dataType: '{ chunkId, kind }' }],
  params: [
    { name: 'styleId', type: 'string', default: '', description: '关联风格库 id（空则跳过 RAG）' },
    { name: 'sceneType', type: 'string', default: 'daily', description: 'RAG chunk 场景类型' },
  ],
  async execute(ctx, input) {
    const memoryUpdate = input['memoryUpdate'] as MemoryUpdate | undefined;
    if (!memoryUpdate) throw new Error('memory.updater 缺少 memoryUpdate 输入');

    const repo = new MemoryChunksRepository(ctx.db);
    const chunk = repo.insert({
      id: nanoid(),
      projectId: ctx.projectId,
      chapterId: memoryUpdate.chapterId,
      kind: 'chapter-summary',
      content: `第${memoryUpdate.chapterIndex}章 ${memoryUpdate.title}\n${memoryUpdate.summary}`,
      metadata: {
        chapterIndex: memoryUpdate.chapterIndex,
        title: memoryUpdate.title,
        runId: ctx.runId,
      },
    });

    // fire-and-forget RAG 入库（风格库已激活时）；失败仅 warn
    const styleId = String(ctx.node.params['styleId'] ?? '');
    if (styleId !== '' && ctx.sidecar) {
      const sceneType = (ctx.node.params['sceneType'] as SceneType | undefined) ?? 'daily';
      void ctx.sidecar
        .ragIndex({
          styleId,
          chunks: [
            {
              bookId: `project:${ctx.projectId}`,
              chapterIndex: memoryUpdate.chapterIndex,
              text: memoryUpdate.text,
              sceneType,
            },
          ],
        })
        .catch((err) => {
          ctx.log(
            `RAG 索引更新失败（已忽略，不影响主流程）：${err instanceof Error ? err.message : String(err)}`,
          );
        });
    }

    ctx.log(`记忆更新完成：chunk ${chunk.id}`);
    return {
      memory: { chunkId: chunk.id, kind: 'chapter-summary' } satisfies MemoryUpdaterOutput['memory'],
    };
  },
};
