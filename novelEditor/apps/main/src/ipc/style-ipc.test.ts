/** style 域 IPC 单测（Phase 5）：import 全流程（SSE 进度事件序列）/ get / list / delete / pick-files
 *
 * electron 的 ipcMain / dialog 被 vi.mock 为内存实现，不启动真实 Electron；
 * sidecar 全部 mock（styleAnalyze 为异步生成器），不起真实 Python 进程。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SceneType, StreamEvent, StyleAnalyzeEvent, StyleProfile } from '@novel-forge/shared';

const { handlers, showOpenDialog } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, req: unknown) => Promise<unknown>>(),
  showOpenDialog: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (event: unknown, req: unknown) => Promise<unknown>) => {
      handlers.set(ch, fn);
    },
  },
  dialog: { showOpenDialog },
}));

import { openDatabase, type AppDatabase } from '../db/index.js';
import { StylesRepository } from '../db/repositories/styles.js';
import type { SidecarClient } from '../sidecar/client.js';
import { registerStyleIpc } from './style.js';

let db: AppDatabase;
let tmpDir: string;
let bookPath: string;
let events: StreamEvent[];

function makeProfile(id: string): StyleProfile {
  const now = Date.now();
  return {
    id,
    authorName: '作家X',
    genre: '仙侠',
    bookCount: 1,
    books: [{ id: `b-${id}`, styleId: id, title: path.basename(bookPath), wordCount: 1000, path: bookPath }],
    fingerprint: {
      avgSentenceLength: 14.5,
      sentenceLengthStd: 6.2,
      shortSentenceRatio: 0.31,
      avgParagraphLength: 88,
      dialogueRatio: 0.42,
      metaphorDensity: 3.5,
      punctuation: {},
      topWords: ['剑'],
      signatureWords: ['蓦地'],
      forbiddenWords: [],
    },
    report: { markdown: '# 风格报告' },
    ragStats: { totalChunks: 10, byScene: { battle: 10 } as Record<SceneType, number> },
    createdAt: now,
    updatedAt: now,
  };
}

/** mock sidecar：styleAnalyze 产出两条 progress + done（可带 profile） */
function mockStyleSidecar(opts: { withProfile?: boolean; failAt?: 'analyze' | 'delete' } = {}): SidecarClient {
  const profile = makeProfile('style-1');
  return {
    styleAnalyze: async function* (): AsyncGenerator<StyleAnalyzeEvent> {
      yield { type: 'progress', stage: 'chunking', progress: 0.2 };
      yield { type: 'progress', stage: 'stylometry', progress: 0.7 };
      if (opts.failAt === 'analyze') {
        yield { type: 'error', error: 'sidecar 分析失败' };
        return;
      }
      yield {
        type: 'done',
        styleId: 'style-1',
        reportPath: 'data/styles/style-1/report.md',
        ...(opts.withProfile === false ? {} : { profile }),
      };
    },
    getStyle: (styleId: string) => Promise.resolve(makeProfile(styleId)),
    deleteStyle: () =>
      opts.failAt === 'delete' ? Promise.reject(new Error('sidecar 删除失败')) : Promise.resolve({ ok: true }),
  } as unknown as SidecarClient;
}

function call<T = unknown>(channel: string, req?: unknown): Promise<T> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`handler ${channel} 未注册`);
  return fn(null, req) as Promise<T>;
}

beforeEach(async () => {
  db = await openDatabase(':memory:');
  handlers.clear();
  events = [];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-style-ipc-'));
  bookPath = path.join(tmpDir, '书一.txt');
  fs.writeFileSync(bookPath, '正文内容');
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function register(sidecar?: SidecarClient): void {
  registerStyleIpc({
    db,
    ...(sidecar !== undefined ? { sidecar } : {}),
    emit: (e: StreamEvent) => events.push(e),
  });
}

describe('style:import', () => {
  it('全流程：SSE 进度事件序列 → 落库 → 返回 { ok, jobId: styleId }', async () => {
    register(mockStyleSidecar());

    const res = await call<{ ok: boolean; jobId?: string }>('style:import', {
      authorName: '作家X',
      genre: '仙侠',
      bookPaths: [bookPath],
    });

    expect(res).toEqual({ ok: true, jobId: 'style-1' });
    // 进度事件：两条 stage 事件 + 一条带 styleId 的 done；jobId 为同一预生成值
    const progress = events.filter(
      (e): e is Extract<StreamEvent, { type: 'style:import-progress' }> => e.type === 'style:import-progress',
    );
    expect(progress).toHaveLength(3);
    const jobId = progress[0]!.jobId;
    expect(jobId).not.toBe('');
    expect(progress.every((e) => e.jobId === jobId)).toBe(true);
    expect(progress[0]).toMatchObject({ stage: 'chunking', progress: 0.2 });
    expect(progress[1]).toMatchObject({ stage: 'stylometry', progress: 0.7 });
    expect(progress[2]).toMatchObject({ stage: 'done', progress: 1, styleId: 'style-1' });
    // 落库
    const profile = new StylesRepository(db).getProfile('style-1');
    expect(profile?.authorName).toBe('作家X');
    expect(profile?.ragStats.totalChunks).toBe(10);
    expect(profile?.books.map((b) => b.title)).toEqual(['书一.txt']);
  });

  it('Done 帧无 profile 时回退 getStyle', async () => {
    register(mockStyleSidecar({ withProfile: false }));

    const res = await call<{ ok: boolean; jobId?: string }>('style:import', {
      authorName: '作家X',
      genre: '仙侠',
      bookPaths: [bookPath],
    });
    expect(res).toEqual({ ok: true, jobId: 'style-1' });
    expect(new StylesRepository(db).getProfile('style-1')?.authorName).toBe('作家X');
  });

  it('bookPaths 为空 / 文件不存在 / sidecar 未配置 / sidecar error 帧 → ok:false', async () => {
    // bookPaths 为空
    register(mockStyleSidecar());
    const empty = await call<{ ok: boolean; error?: string }>('style:import', {
      authorName: '作家X',
      genre: '仙侠',
      bookPaths: [],
    });
    expect(empty.ok).toBe(false);

    // 文件不存在
    const missing = await call<{ ok: boolean; error?: string }>('style:import', {
      authorName: '作家X',
      genre: '仙侠',
      bookPaths: [path.join(tmpDir, '不存在.txt')],
    });
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain('文件不存在');

    // sidecar error 帧
    handlers.clear();
    register(mockStyleSidecar({ failAt: 'analyze' }));
    const failed = await call<{ ok: boolean; error?: string }>('style:import', {
      authorName: '作家X',
      genre: '仙侠',
      bookPaths: [bookPath],
    });
    expect(failed).toEqual({ ok: false, error: 'sidecar 分析失败' });

    // sidecar 未配置
    handlers.clear();
    register(undefined);
    const noSidecar = await call<{ ok: boolean; error?: string }>('style:import', {
      authorName: '作家X',
      genre: '仙侠',
      bookPaths: [bookPath],
    });
    expect(noSidecar.ok).toBe(false);
  });
});

describe('style:get / style:list / style:delete', () => {
  beforeEach(() => {
    register(mockStyleSidecar());
    new StylesRepository(db).upsertProfile(makeProfile('s1'));
    new StylesRepository(db).upsertProfile(makeProfile('s2'));
  });

  it('style:get 存在返回 profile，不存在 ok:false', async () => {
    const got = await call<{ ok: boolean; profile?: { id: string } }>('style:get', { styleId: 's1' });
    expect(got.ok).toBe(true);
    expect(got.profile?.id).toBe('s1');

    const missing = await call<{ ok: boolean; error?: string }>('style:get', { styleId: 'ghost' });
    expect(missing).toEqual({ ok: false, error: 'style not found' });
  });

  it('style:list 返回全部档案', async () => {
    const res = await call<{ ok: boolean; styles?: { id: string }[] }>('style:list', {});
    expect(res.ok).toBe(true);
    expect(res.styles?.map((s) => s.id).sort()).toEqual(['s1', 's2']);
  });

  it('style:delete 删 DB 并通知 sidecar；sidecar 失败仍 ok', async () => {
    const res = await call<{ ok: boolean }>('style:delete', { styleId: 's1' });
    expect(res).toEqual({ ok: true });
    expect(new StylesRepository(db).getProfile('s1')).toBeUndefined();

    // sidecar 删除失败仅 warn
    handlers.clear();
    register(mockStyleSidecar({ failAt: 'delete' }));
    const res2 = await call<{ ok: boolean }>('style:delete', { styleId: 's2' });
    expect(res2).toEqual({ ok: true });
    expect(new StylesRepository(db).getProfile('s2')).toBeUndefined();
  });
});

describe('style:self-check（收尾批次 4，SPEC §15 N 分档阈值）', () => {
  /** 直接播种 styles + style_books（n 条） */
  function seedStyle(styleId: string, bookCount: number): void {
    db.prepare(
      'INSERT INTO styles (id, author_name, genre, book_count, fingerprint, report, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(styleId, '作家X', '仙侠', bookCount, '{}', '{}', Date.now(), Date.now());
    for (let i = 0; i < bookCount; i++) {
      db.prepare('INSERT INTO style_books (id, style_id, title) VALUES (?, ?, ?)').run(
        `${styleId}-b${i}`,
        styleId,
        `书${i}`,
      );
    }
  }

  /** 播种风格库语料（rag_chunks.text 为自测样本来源） */
  function seedChunks(styleId: string, texts: string[]): void {
    texts.forEach((text, i) => {
      db.prepare(
        'INSERT INTO rag_chunks (id, style_id, book_id, chapter_index, text, scene_type) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(`${styleId}-ch${i}`, styleId, `${styleId}-b0`, i, text, 'daily');
    });
  }

  function mockScoreSidecar(opts: { score?: number; fail?: boolean } = {}): SidecarClient {
    return {
      discriminatorScore: () =>
        opts.fail === true
          ? Promise.reject(new Error('POST /discriminator/score → HTTP 400'))
          : Promise.resolve({ score: opts.score ?? 0.8, verdict: 'match' }),
    } as unknown as SidecarClient;
  }

  it('N=1 → band one / 阈值 0.55；语料均分为 score', async () => {
    register(mockScoreSidecar({ score: 0.8 }));
    seedStyle('s-one', 1);
    seedChunks('s-one', ['片段一', '片段二']);

    const res = await call<{ ok: boolean; score?: number; n?: number; band?: string; threshold?: number }>(
      'style:self-check',
      { styleId: 's-one' },
    );
    expect(res).toEqual({ ok: true, score: 0.8, n: 1, band: 'one', threshold: 0.55 });
  });

  it('N 分档：2..4 → few（0.65）；≥5 → many（0.75）', async () => {
    register(mockScoreSidecar({ score: 0.7 }));
    seedStyle('s-few', 3);
    seedChunks('s-few', ['片段']);
    seedStyle('s-many', 5);
    seedChunks('s-many', ['片段']);

    const few = await call<{ band?: string; threshold?: number }>('style:self-check', { styleId: 's-few' });
    expect(few).toMatchObject({ band: 'few', threshold: 0.65 });
    const many = await call<{ band?: string; threshold?: number; n?: number }>('style:self-check', {
      styleId: 's-many',
    });
    expect(many).toMatchObject({ band: 'many', threshold: 0.75, n: 5 });
  });

  it('风格库无样本：n=0 或有作品无语料 → skipped 原因「风格库无样本」', async () => {
    register(mockScoreSidecar());
    seedStyle('s-empty', 0);
    seedStyle('s-nocorpus', 2); // 有 style_books 但 rag_chunks 为空

    const empty = await call<{ ok: boolean; skipped?: boolean; reason?: string; n?: number }>(
      'style:self-check',
      { styleId: 's-empty' },
    );
    expect(empty).toEqual({ ok: true, skipped: true, reason: '风格库无样本', n: 0 });
    const noCorpus = await call<{ ok: boolean; skipped?: boolean; reason?: string; n?: number }>(
      'style:self-check',
      { styleId: 's-nocorpus' },
    );
    expect(noCorpus).toEqual({ ok: true, skipped: true, reason: '风格库无样本', n: 2 });
  });

  it('判别器未训练/调用失败 → skipped「判别器未训练或不可用」；sidecar 未配置 → ok:false', async () => {
    register(mockScoreSidecar({ fail: true }));
    seedStyle('s-untrained', 1);
    seedChunks('s-untrained', ['片段']);

    const res = await call<{ ok: boolean; skipped?: boolean; reason?: string }>('style:self-check', {
      styleId: 's-untrained',
    });
    expect(res).toEqual({ ok: true, skipped: true, reason: '判别器未训练或不可用', n: 1 });

    handlers.clear();
    register(undefined);
    const noSidecar = await call<{ ok: boolean; error?: string }>('style:self-check', { styleId: 's-untrained' });
    expect(noSidecar.ok).toBe(false);
  });
});

describe('style:pick-files', () => {
  it('返回选中路径；取消时 canceled=true', async () => {
    register(mockStyleSidecar());

    showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['a.txt', 'b.epub'] });
    const res = await call<{ ok: boolean; paths: string[]; canceled?: boolean }>('style:pick-files', {});
    expect(res).toEqual({ ok: true, paths: ['a.txt', 'b.epub'] });

    showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    const canceled = await call<{ ok: boolean; paths: string[]; canceled?: boolean }>('style:pick-files', {});
    expect(canceled).toEqual({ ok: true, paths: [], canceled: true });
  });
});
