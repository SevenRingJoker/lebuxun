/** §10.4/§10.5 Evolution Learner + Prompt Evolver 单测
 *
 * - evolution_patterns 仓库 insert/count/findRecent
 * - pattern → 伪偏好样本映射（selected/rejected 两个方向）
 * - refineImprovePrompt 全链（mock sidecar）：提模板 → 生成新 improve 提示词 → 落 prompt_versions
 * - 阈值门禁：pattern < 30 不触发 sidecar
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type AppDatabase } from '../db/index.js';
import { EvolutionPatternsRepository } from '../db/repositories/evolution-patterns.js';
import { PromptVersionsRepository } from '../db/repositories/prompt-versions.js';
import type { SidecarClient } from '../sidecar/client.js';
import {
  EVOLUTION_TEMPLATE_THRESHOLD,
  maybeEvolveImprovePrompt,
  patternsToPseudoSamples,
  refineImprovePrompt,
} from './prompt-evolution.js';

let db: AppDatabase;
const warnings: string[] = [];

beforeEach(async () => {
  db = await openDatabase(':memory:');
  warnings.length = 0;
  db.prepare(
    "INSERT INTO projects (id, name, genre, created_at, updated_at) VALUES ('p1', '测试', '仙侠', 1, 1)",
  ).run();
});

/** mock sidecar：记录调用 + 可配置返回 */
function mockSidecar(opts: {
  templates?: unknown[];
  message?: string;
  created?: { content: string; version: number };
}) {
  const calls: { extract: number; create: number } = { extract: 0, create: 0 };
  return {
    calls,
    extractTemplates: async () => {
      calls.extract += 1;
      return { templates: opts.templates ?? [], ...(opts.message !== undefined ? { message: opts.message } : {}) };
    },
    createPromptTemplate: async () => {
      calls.create += 1;
      return {
        id: 'pt1',
        nodeType: 'improve',
        projectId: 'p1',
        version: opts.created?.version ?? 1,
        parentVersion: null,
        content: opts.created?.content ?? '新提示词',
        basedOn: null,
      };
    },
  } as unknown as SidecarClient & { calls: { extract: number; create: number } };
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise<void>((r) => setImmediate(r));
}

function seedPatterns(n: number): void {
  const repo = new EvolutionPatternsRepository(db);
  for (let i = 0; i < n; i++) {
    repo.insert({
      projectId: 'p1',
      parentText: `父${i}`,
      childText: `子${i}`,
      mode: 'improve',
      outcome: 'selected',
    });
  }
}

describe('EvolutionPatternsRepository', () => {
  it('insert selected（childText+diff）/ rejected（childTexts 数组）+ countByProject + findRecent', () => {
    const repo = new EvolutionPatternsRepository(db);
    repo.insert({
      projectId: 'p1',
      parentText: '原',
      childText: '改',
      mode: 'improve',
      outcome: 'selected',
      diff: { removed: 1, added: 2 },
    });
    repo.insert({
      projectId: 'p1',
      parentText: '原',
      childTexts: ['落选1', '落选2'],
      mode: 'improve',
      outcome: 'rejected',
    });
    expect(repo.countByProject('p1')).toBe(2);

    const recent = repo.findRecent('p1', 10);
    expect(recent).toHaveLength(2);
    expect(recent[0]!.outcome).toBe('rejected'); // 新→旧
    expect(recent[0]!.childTexts).toEqual(['落选1', '落选2']);
    expect(recent[1]!.childText).toBe('改');
    expect(recent[1]!.diff).toEqual({ removed: 1, added: 2 });
    // limit 生效 + 项目隔离
    expect(repo.findRecent('p1', 1)).toHaveLength(1);
    expect(repo.countByProject('p2')).toBe(0);
  });
});

describe('patternsToPseudoSamples', () => {
  it('selected：chosen=childText、rejected=parentText；rejected：方向相反、child_texts 展开', () => {
    const repo = new EvolutionPatternsRepository(db);
    repo.insert({ projectId: 'p1', parentText: '原', childText: '改', mode: 'improve', hint: '加强钩子', outcome: 'selected' });
    repo.insert({ projectId: 'p1', parentText: '原', childTexts: ['落选A', '落选B'], mode: 'variant', outcome: 'rejected' });

    const samples = patternsToPseudoSamples(repo.findRecent('p1', 100), 'p1');
    expect(samples).toHaveLength(3);
    // findRecent 新→旧：rejected pattern（后插入）先展开为 2 条，方向=原文优于落选候选
    expect(samples[0]).toEqual({ projectId: 'p1', context: 'variant', chosen: '原', rejected: '落选A', reasons: [] });
    expect(samples[1]!.rejected).toBe('落选B');
    // selected：chosen=childText、rejected=parentText，context 优先 hint
    expect(samples[2]).toEqual({ projectId: 'p1', context: '加强钩子', chosen: '改', rejected: '原', reasons: [] });
  });
});

describe('refineImprovePrompt / maybeEvolveImprovePrompt', () => {
  it('全链：提模板非空 → createPromptTemplate → prompt_versions 落库', async () => {
    seedPatterns(2);
    const sidecar = mockSidecar({ templates: [{ id: 't1' }], created: { content: '演化新提示词', version: 1 } });
    await refineImprovePrompt({ db, sidecar, log: (m) => warnings.push(m) }, 'p1');
    expect(sidecar.calls.extract).toBe(1);
    expect(sidecar.calls.create).toBe(1);
    const versions = new PromptVersionsRepository(db).latestFor('p1', 'improve');
    expect(versions?.content).toBe('演化新提示词');
  });

  it('模板为空（样本不足）→ 不调 createPromptTemplate、不落库，warn 留痕', async () => {
    seedPatterns(2);
    const sidecar = mockSidecar({ templates: [], message: '训练样本不足' });
    await refineImprovePrompt({ db, sidecar, log: (m) => warnings.push(m) }, 'p1');
    expect(sidecar.calls.create).toBe(0);
    expect(new PromptVersionsRepository(db).latestFor('p1', 'improve')).toBeUndefined();
    expect(warnings.join('\n')).toContain('训练样本不足');
  });

  it('sidecar 挂掉 → 抛错给调用方（fire-and-forget 场景由 maybeEvolve 捕获）', async () => {
    seedPatterns(1);
    const sidecar = {
      extractTemplates: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    } as unknown as SidecarClient;
    await expect(refineImprovePrompt({ db, sidecar }, 'p1')).rejects.toThrow('ECONNREFUSED');
  });

  it('阈值门禁：pattern < EVOLUTION_TEMPLATE_THRESHOLD 不触发 sidecar', async () => {
    seedPatterns(EVOLUTION_TEMPLATE_THRESHOLD - 1);
    const sidecar = mockSidecar({ templates: [] });
    maybeEvolveImprovePrompt({ db, sidecar, log: (m) => warnings.push(m) }, 'p1');
    await flushAsync();
    expect(sidecar.calls.extract).toBe(0);
  });

  it('pattern ≥ 阈值 → fire-and-forget 触发全链；sidecar 失败仅 warn 不抛', async () => {
    seedPatterns(EVOLUTION_TEMPLATE_THRESHOLD);
    const badSidecar = {
      extractTemplates: async () => {
        throw new Error('sidecar 不可用');
      },
    } as unknown as SidecarClient;
    maybeEvolveImprovePrompt({ db, sidecar: badSidecar, log: (m) => warnings.push(m) }, 'p1');
    await flushAsync();
    expect(warnings.join('\n')).toContain('sidecar 不可用');

    // 正常路径：达阈值后落 prompt_versions
    const goodSidecar = mockSidecar({ templates: [{ id: 't1' }], created: { content: '新代提示词', version: 2 } });
    maybeEvolveImprovePrompt({ db, sidecar: goodSidecar, log: (m) => warnings.push(m) }, 'p1');
    await flushAsync();
    expect(goodSidecar.calls.extract).toBe(1);
    expect(new PromptVersionsRepository(db).latestFor('p1', 'improve')?.content).toBe('新代提示词');
  });

  it('sidecar 未注入 → 直接跳过', async () => {
    seedPatterns(EVOLUTION_TEMPLATE_THRESHOLD + 5);
    maybeEvolveImprovePrompt({ db, log: (m) => warnings.push(m) }, 'p1');
    await flushAsync();
    expect(new PromptVersionsRepository(db).latestFor('p1', 'improve')).toBeUndefined();
  });
});
