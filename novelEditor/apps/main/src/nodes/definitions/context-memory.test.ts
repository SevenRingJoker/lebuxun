/** context.memory 单测：DB 记忆 + RAG 命中合并；sidecar 失败降级 */

import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type AppDatabase } from '../../db/index.js';
import { MemoryChunksRepository } from '../../db/repositories/memory-chunks.js';
import { contextMemoryNode, type MemoryResult } from './context-memory.js';
import { makeCtx, mockSidecar, seedProject } from './test-helpers.js';
import type { GenerationContext } from './input-context.js';

let db: AppDatabase;

beforeEach(async () => {
  db = await openDatabase(':memory:');
  seedProject(db);
});

const fakeContext = { prompt: '查询文本' } as GenerationContext;

describe('context.memory', () => {
  it('正常路径：DB 记忆 + RAG 命中合并输出', async () => {
    new MemoryChunksRepository(db).insert({
      id: 'mc1',
      projectId: 'p1',
      kind: 'chapter-summary',
      content: '第1章摘要',
      metadata: {},
    });
    const sidecar = mockSidecar({
      ragQuery: () =>
        Promise.resolve({
          results: [{ id: 'r1', text: '风格例句', sceneType: 'daily' as const, score: 0.88 }],
        }),
    });
    const { ctx } = makeCtx(db, { sidecar, params: { styleId: 's1', topK: 5 } });

    const out = (await contextMemoryNode.execute(ctx, { context: fakeContext })) as {
      memory: MemoryResult;
    };
    expect(out.memory.hits).toHaveLength(2);
    expect(out.memory.hits[0]).toMatchObject({ id: 'mc1', source: 'db' });
    expect(out.memory.hits[1]).toMatchObject({ id: 'r1', source: 'rag', score: 0.88 });
  });

  it('降级路径：sidecar ragQuery 抛错仅 warn，输出仅 DB 记忆', async () => {
    new MemoryChunksRepository(db).insert({
      id: 'mc1',
      projectId: 'p1',
      kind: 'chapter-summary',
      content: '第1章摘要',
      metadata: {},
    });
    const sidecar = mockSidecar({
      ragQuery: () => Promise.reject(new Error('sidecar 挂了')),
    });
    const { ctx, logs } = makeCtx(db, { sidecar, params: { styleId: 's1' } });

    const out = (await contextMemoryNode.execute(ctx, { context: fakeContext })) as {
      memory: MemoryResult;
    };
    expect(out.memory.hits).toHaveLength(1);
    expect(out.memory.hits[0]!.source).toBe('db');
    expect(logs.some((l) => l.includes('RAG 检索失败'))).toBe(true);
  });

  it('边界：无 styleId / 无 sidecar 时跳过 RAG，仅返回 DB 记忆', async () => {
    const { ctx } = makeCtx(db, { params: {} });
    const out = (await contextMemoryNode.execute(ctx, { context: fakeContext })) as {
      memory: MemoryResult;
    };
    expect(out.memory.hits).toEqual([]);
  });
});
