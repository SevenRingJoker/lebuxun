/** Phase 6 IPC 单测：growth:calibration / growth:stats model 段缓存降级 /
 * growth:profile history / candidate:diff / candidate:reject-all 计数 / export:manuscript
 *
 * electron 的 ipcMain 被 vi.mock 为内存 handler 表；sidecar 全部 mock。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CalibrationPair,
  Candidate,
  DiffSegment,
  GrowthStats,
  PreferenceProfile,
  ProfileSnapshot,
  StreamEvent,
} from '@novel-forge/shared';

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, req: unknown) => Promise<unknown>>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (event: unknown, req: unknown) => Promise<unknown>) => {
      handlers.set(ch, fn);
    },
  },
}));

import { openDatabase, type AppDatabase } from '../db/index.js';
import { CandidatesRepository } from '../db/repositories/candidates.js';
import type { SidecarClient } from '../sidecar/client.js';
import { registerCandidateIpc } from './candidate.js';
import { registerExportIpc } from './export.js';
import { registerGrowthIpc } from './growth.js';

let db: AppDatabase;
let exportsDir: string;

function sixDim(v: number) {
  return { pacing: v, character: v, consistency: v, profileFit: v, styleSimilarity: v, rewardScore: v };
}

function insertCandidate(overrides: Partial<Candidate> = {}): void {
  new CandidatesRepository(db).insert({
    id: 'c1',
    runId: 'run-1',
    nodeId: 'n1',
    index: 0,
    text: '正文',
    strategy: { label: '稳健', temperature: 0.5 },
    scores: sixDim(0.5),
    satisfaction: 'unrated',
    generationMode: 'fresh',
    generationDepth: 0,
    lineage: [],
    ...overrides,
  });
}

function call<T = unknown>(channel: string, req: unknown): Promise<T> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`handler ${channel} 未注册`);
  return fn(null, req) as Promise<T>;
}

interface StatsRes {
  ok: boolean;
  error?: string;
  stats?: GrowthStats;
}

beforeEach(async () => {
  db = await openDatabase(':memory:');
  handlers.clear();
  exportsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-ipc-export-'));
  db.prepare(
    "INSERT INTO projects (id, name, genre, created_at, updated_at) VALUES ('p1', '测试', '仙侠', 1, 1)",
  ).run();
  db.prepare(
    "INSERT INTO workflows (id, project_id, name, graph, version, updated_at) VALUES ('w1', 'p1', 'wf', '{}', 1, 1)",
  ).run();
  db.prepare(
    "INSERT INTO runs (id, workflow_id, status, created_at, updated_at) VALUES ('run-1', 'w1', 'running', 1, 1)",
  ).run();
});

afterEach(() => {
  fs.rmSync(exportsDir, { recursive: true, force: true });
});

describe('growth:stats model 段（sidecar + 缓存降级）', () => {
  it('sidecar 正常 → model 段为解析值；sidecar 挂 → 用缓存；无缓存 → 全 0', async () => {
    const okSidecar = {
      rewardStatus: async () => ({
        version: 'v3',
        accuracy: 0.82,
        kendallTau: null,
        sampleCount: 50,
        trainedAt: 1,
      }),
    } as unknown as SidecarClient;

    handlers.clear();
    registerGrowthIpc({ db, sidecar: okSidecar });
    let res = await call<StatsRes>('growth:stats', { projectId: 'p1' });
    expect(res.stats!.model).toMatchObject({ rewardVersion: 3, rewardAccuracy: 0.82 });

    // sidecar 挂掉 → 缓存降级
    const deadSidecar = {
      rewardStatus: async () => {
        throw new Error('timeout');
      },
    } as unknown as SidecarClient;
    handlers.clear();
    registerGrowthIpc({ db, sidecar: deadSidecar });
    res = await call<StatsRes>('growth:stats', { projectId: 'p1' });
    expect(res.stats!.model).toMatchObject({ rewardVersion: 3, rewardAccuracy: 0.82 });

    // 另一项目无缓存 → 全 0
    res = await call<StatsRes>('growth:stats', { projectId: 'p1' });
    handlers.clear();
    registerGrowthIpc({ db: db, sidecar: deadSidecar });
    db.prepare(
      "INSERT INTO projects (id, name, genre, created_at, updated_at) VALUES ('p2', '新', '都市', 1, 1)",
    ).run();
    res = await call<StatsRes>('growth:stats', { projectId: 'p2' });
    expect(res.stats!.model).toMatchObject({ rewardVersion: 0, rewardAccuracy: 0 });
  });

  it('evaluatorAlignment 注入 model 段', async () => {
    insertCandidate({ id: 'S', satisfaction: 'satisfied', scores: { ...sixDim(0.5), rewardScore: 0.9 } });
    insertCandidate({ id: 'U', index: 1, satisfaction: 'unsatisfied', scores: { ...sixDim(0.5), rewardScore: 0.1 } });
    handlers.clear();
    registerGrowthIpc({ db });
    const res = await call<StatsRes>('growth:stats', { projectId: 'p1' });
    expect(res.stats!.model.evaluatorAlignment).toBe(1);
  });
});

describe('growth:calibration', () => {
  it('返回 alignment + pairs + reward 版本', async () => {
    insertCandidate({ id: 'S', satisfaction: 'satisfied', scores: { ...sixDim(0.6), rewardScore: 0.9 } });
    insertCandidate({ id: 'U', index: 1, satisfaction: 'unsatisfied', scores: { ...sixDim(0.4), rewardScore: 0.2 } });
    const sidecar = {
      rewardStatus: async () => ({ version: 'v1', accuracy: 0.5, kendallTau: null, sampleCount: null, trainedAt: null }),
    } as unknown as SidecarClient;
    registerGrowthIpc({ db, sidecar });

    const res = await call<{
      ok: boolean;
      alignment?: number;
      rewardVersion?: number;
      rewardAccuracy?: number;
      pairs?: CalibrationPair[];
    }>('growth:calibration', { projectId: 'p1' });
    expect(res.ok).toBe(true);
    expect(res.alignment).toBe(1);
    expect(res.rewardVersion).toBe(1);
    expect(res.rewardAccuracy).toBe(0.5);
    expect(res.pairs).toHaveLength(2);
    expect(res.pairs!.map((p) => p.candidateId).sort()).toEqual(['S', 'U']);
  });
});

describe('growth:profile history', () => {
  it('画像更新后 history 追加快照（candidate:select 触发采集）', async () => {
    registerCandidateIpc({ db, emit: () => {} });
    registerGrowthIpc({ db });
    insertCandidate({ id: 'A', text: 'A', satisfaction: 'satisfied' });
    insertCandidate({ id: 'B', index: 1, text: 'B', satisfaction: 'unsatisfied', satisfactionTags: ['缺冲突'] });
    await call('candidate:select', { runId: 'run-1', nodeId: 'n1', candidateId: 'A' });

    const res = await call<{ ok: boolean; profile?: PreferenceProfile; history?: ProfileSnapshot[] }>(
      'growth:profile',
      { projectId: 'p1' },
    );
    expect(res.ok).toBe(true);
    expect(res.history).toHaveLength(1);
    expect(res.history![0]!.dimensions['tension']).toBeGreaterThan(0.5);
  });
});

describe('candidate:diff', () => {
  it('两候选文本 → 句级 segments', async () => {
    registerCandidateIpc({ db, emit: () => {} });
    insertCandidate({ id: 'A', text: '甲。乙。丙。' });
    insertCandidate({ id: 'B', index: 1, text: '甲。丙。丁。' });
    const res = await call<{ ok: boolean; segments?: DiffSegment[] }>('candidate:diff', {
      candidateIdA: 'A',
      candidateIdB: 'B',
    });
    expect(res.ok).toBe(true);
    expect(res.segments).toEqual([
      { type: 'same', text: '甲。' },
      { type: 'del', text: '乙。' },
      { type: 'same', text: '丙。' },
      { type: 'add', text: '丁。' },
    ]);
  });

  it('候选不存在 → ok:false', async () => {
    registerCandidateIpc({ db, emit: () => {} });
    const res = await call<{ ok: boolean; error?: string }>('candidate:diff', {
      candidateIdA: 'x',
      candidateIdB: 'y',
    });
    expect(res.ok).toBe(false);
  });
});

describe('candidate:reject-all 计数 → rejectAllRate', () => {
  it('reject-all 后 growth:stats 反映拒全弃率', async () => {
    registerCandidateIpc({ db, emit: () => {} });
    registerGrowthIpc({ db });
    insertCandidate({ id: 'A' });
    insertCandidate({ id: 'B', index: 1 });
    await call('candidate:reject-all', { runId: 'run-1', nodeId: 'n1' });

    const res = await call<StatsRes>('growth:stats', { projectId: 'p1' });
    // 1 个面板，拒全弃 1 次 → 率 1
    expect(res.stats!.candidate.rejectAllRate).toBe(1);
  });
});

describe('export:manuscript', () => {
  it('txt 导出到指定目录并返回路径', async () => {
    registerExportIpc({ db, exportsDir });
    db.prepare(
      "INSERT INTO chapters (id, project_id, idx, title, status, created_at, updated_at) VALUES ('ch1', 'p1', 1, '第一章', 'final', 1, 1)",
    ).run();
    db.prepare(
      "INSERT INTO paragraphs (id, chapter_id, idx, text, scene_type, created_at) VALUES ('pa1', 'ch1', 0, '正文一段。', 'daily', 1)",
    ).run();

    const res = await call<{ ok: boolean; path?: string; error?: string }>('export:manuscript', {
      projectId: 'p1',
      format: 'txt',
    });
    expect(res.ok).toBe(true);
    expect(res.path!.startsWith(exportsDir)).toBe(true);
    expect(fs.readFileSync(res.path!, 'utf8')).toBe('第一章\n\n正文一段。');
  });

  it('项目不存在 → ok:false', async () => {
    registerExportIpc({ db, exportsDir });
    const res = await call<{ ok: boolean; error?: string }>('export:manuscript', {
      projectId: 'nope',
      format: 'md',
    });
    expect(res.ok).toBe(false);
  });
});
