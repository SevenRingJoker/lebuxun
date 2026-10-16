/** growth:train-reward IPC 单测（§10.2 学习闭环）：成功回读指标 / 400 detail / 连接失败 / 无 sidecar
 *
 * electron 的 ipcMain 被 vi.mock 为内存 handler 表；sidecar 全部 mock。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

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
import { PreferenceSamplesRepository } from '../db/repositories/preference-samples.js';
import type { SidecarClient } from '../sidecar/client.js';
import { SidecarHttpError } from '../sidecar/client.js';
import { registerGrowthIpc } from './growth.js';

let db: AppDatabase;

function call<T = unknown>(channel: string, req: unknown): Promise<T> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`handler ${channel} 未注册`);
  return fn(null, req) as Promise<T>;
}

function seedSamples(n: number): void {
  const repo = new PreferenceSamplesRepository(db);
  for (let i = 0; i < n; i++) {
    repo.insert({
      id: `s${i}`,
      projectId: 'p1',
      context: `ctx${i}`,
      chosen: `好${i}`,
      rejected: `差${i}`,
      reasons: [
        { tag: '节奏太快', inferred: false },
        { tag: '张力足', inferred: true },
      ],
      createdAt: Date.now() + i,
    });
  }
}

beforeEach(async () => {
  db = await openDatabase(':memory:');
  handlers.clear();
  db.prepare(
    "INSERT INTO projects (id, name, genre, created_at, updated_at) VALUES ('p1', '测试', '仙侠', 1, 1)",
  ).run();
});

describe('growth:train-reward', () => {
  it('成功：全量样本发 train（reasons 转 string[]）→ 回读 /reward/status 组装 metrics', async () => {
    seedSamples(2);
    const captured: unknown[] = [];
    const sidecar = {
      trainReward: async (req: { samples: unknown[] }) => {
        captured.push(req);
      },
      rewardStatus: async () => ({ version: 'v2', accuracy: 0.81, kendallTau: 0.55, sampleCount: 120, trainedAt: 1700000000 }),
    } as unknown as SidecarClient;
    registerGrowthIpc({ db, sidecar });

    const res = await call<{ ok: boolean; metrics?: Record<string, unknown> }>('growth:train-reward', {
      projectId: 'p1',
    });
    expect(res.ok).toBe(true);
    expect(res.metrics).toEqual({
      version: 'v2',
      accuracy: 0.81,
      kendallTau: 0.55,
      sampleCount: 120,
      trainedAt: 1700000000,
    });
    // 样本形状：reasons 已从 {tag,inferred}[] 摊平为 string[]
    const req = captured[0] as { samples: { projectId: string; reasons: string[] }[] };
    expect(req.samples).toHaveLength(2);
    expect(req.samples[0]).toMatchObject({ projectId: 'p1', reasons: ['节奏太快', '张力足'] });
  });

  it('sidecar 400（样本不足）→ {ok:false, detail}（detail 原文透传）', async () => {
    seedSamples(1);
    const sidecar = {
      trainReward: async () => {
        throw new SidecarHttpError('POST /reward/train → HTTP 400', 400, '训练样本不足：当前 1 条，需要至少 100 条');
      },
    } as unknown as SidecarClient;
    registerGrowthIpc({ db, sidecar });

    const res = await call<{ ok: boolean; detail?: string; error?: string }>('growth:train-reward', {
      projectId: 'p1',
    });
    expect(res.ok).toBe(false);
    expect(res.detail).toBe('训练样本不足：当前 1 条，需要至少 100 条');
    expect(res.error).toBeUndefined();
  });

  it('连接失败 → {ok:false, error}', async () => {
    const sidecar = {
      trainReward: async () => {
        throw new Error('fetch failed');
      },
    } as unknown as SidecarClient;
    registerGrowthIpc({ db, sidecar });

    const res = await call<{ ok: boolean; error?: string }>('growth:train-reward', { projectId: 'p1' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('fetch failed');
  });

  it('sidecar 未注入 → {ok:false, error}', async () => {
    registerGrowthIpc({ db });
    const res = await call<{ ok: boolean; error?: string }>('growth:train-reward', { projectId: 'p1' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('sidecar 未就绪');
  });
});
