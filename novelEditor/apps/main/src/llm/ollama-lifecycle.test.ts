import { describe, expect, it } from 'vitest';
import { OllamaLifecycle, type FetchLike } from './ollama-lifecycle.js';

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

/** 构造可编程的 fetch：healthy=true 时 /api/version 返回 ok */
function makeFetch(opts: { healthy: () => boolean }): FetchLike {
  return async (url: string) => {
    if (url.endsWith('/api/version')) {
      return opts.healthy() ? okResponse({ version: '0.0.0' }) : new Response('down', { status: 503 });
    }
    if (url.endsWith('/api/tags')) return okResponse({ models: [{ name: 'qwen3:8b' }] });
    if (url.endsWith('/api/ps')) return okResponse({ models: [{ size_vram: 6 * 1024 ** 3 }] });
    return new Response('not found', { status: 404 });
  };
}

function fakeSpawn(): {
  spawnFn: (command: string, args: string[]) => { unref(): void };
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    spawnFn: (command: string, args: string[]) => {
      calls.push([command, ...args]);
      return { unref: () => {} };
    },
  };
}

describe('OllamaLifecycle.ensureRunning 三分支', () => {
  it('已运行 → running，不 spawn', async () => {
    const { spawnFn, calls } = fakeSpawn();
    const lifecycle = new OllamaLifecycle(
      { host: 'http://localhost:11434', autoStart: true },
      { fetchFn: makeFetch({ healthy: () => true }), spawnFn: spawnFn as never },
    );
    const res = await lifecycle.ensureRunning();
    expect(res.status).toBe('running');
    expect(calls).toHaveLength(0);
  });

  it('未运行 → spawn ollama serve → 健康检查通过 → started', async () => {
    let healthy = false;
    const { spawnFn, calls } = fakeSpawn();
    const lifecycle = new OllamaLifecycle(
      { host: 'http://localhost:11434', autoStart: true, pollIntervalMs: 5, healthTimeoutMs: 2_000 },
      {
        fetchFn: makeFetch({ healthy: () => healthy }),
        spawnFn: ((command: string, args: string[]) => {
          healthy = true; // 模拟 serve 启动成功
          return spawnFn(command, args);
        }) as never,
      },
    );
    const res = await lifecycle.ensureRunning();
    expect(res.status).toBe('started');
    expect(calls).toEqual([['ollama', 'serve']]);
  });

  it('未运行且启动后仍不健康 → failed（30s 超时逻辑，测试用短超时）', async () => {
    const { spawnFn, calls } = fakeSpawn();
    const lifecycle = new OllamaLifecycle(
      { host: 'http://localhost:11434', autoStart: true, pollIntervalMs: 5, healthTimeoutMs: 50 },
      { fetchFn: makeFetch({ healthy: () => false }), spawnFn: spawnFn as never },
    );
    const res = await lifecycle.ensureRunning();
    expect(res.status).toBe('failed');
    expect(calls).toEqual([['ollama', 'serve']]);
  });

  it('autoStart=false 且未运行 → 直接 failed，不 spawn', async () => {
    const { spawnFn, calls } = fakeSpawn();
    const lifecycle = new OllamaLifecycle(
      { host: 'http://localhost:11434', autoStart: false },
      { fetchFn: makeFetch({ healthy: () => false }), spawnFn: spawnFn as never },
    );
    expect((await lifecycle.ensureRunning()).status).toBe('failed');
    expect(calls).toHaveLength(0);
  });
});

describe('OllamaLifecycle.listModels', () => {
  it('成功：running=true 且原样返回 /api/tags 的 models', async () => {
    const lifecycle = new OllamaLifecycle(
      { host: 'http://localhost:11434', autoStart: false },
      {
        fetchFn: async (url: string) =>
          url.endsWith('/api/tags')
            ? okResponse({ models: [{ name: 'qwen3:8b', size: 123 }] })
            : new Response('x', { status: 404 }),
      },
    );
    const res = await lifecycle.listModels();
    expect(res.running).toBe(true);
    expect(res.models).toEqual([{ name: 'qwen3:8b', size: 123 }]);
    expect(res.detail).toBeUndefined();
  });

  it('失败：running=false、models=[] 且带 detail', async () => {
    const lifecycle = new OllamaLifecycle(
      { host: 'http://localhost:11434', autoStart: false },
      {
        fetchFn: async () => {
          throw new Error('connect ECONNREFUSED');
        },
      },
    );
    const res = await lifecycle.listModels();
    expect(res.running).toBe(false);
    expect(res.models).toEqual([]);
    expect(res.detail).toContain('ECONNREFUSED');
  });
});

describe('OllamaLifecycle 模型与显存', () => {
  it('ensureModel：已安装则直接 true，不触发 pull', async () => {
    const lifecycle = new OllamaLifecycle(
      { host: 'http://localhost:11434', autoStart: false },
      { fetchFn: makeFetch({ healthy: () => true }) },
    );
    expect(await lifecycle.ensureModel('qwen3:8b')).toBe(true);
  });

  it('ensureModel：未安装则走 /api/pull 并回报进度', async () => {
    const ndjson = '{"status":"pulling","total":100,"completed":50}\n{"status":"success"}\n';
    const fetchFn: FetchLike = async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/tags')) return okResponse({ models: [] });
      if (url.endsWith('/api/pull')) {
        expect(init?.method).toBe('POST');
        return new Response(ndjson, { status: 200 });
      }
      return new Response('x', { status: 404 });
    };
    const lifecycle = new OllamaLifecycle(
      { host: 'http://localhost:11434', autoStart: false },
      { fetchFn },
    );
    const progress: string[] = [];
    const ok = await lifecycle.ensureModel('qwen3:32b', (p) => progress.push(p.status));
    expect(ok).toBe(true);
    expect(progress).toEqual(['pulling', 'success']);
  });

  it('getVramUsage 汇总 size_vram', async () => {
    const lifecycle = new OllamaLifecycle(
      { host: 'http://localhost:11434', autoStart: false },
      { fetchFn: makeFetch({ healthy: () => true }) },
    );
    const info = await lifecycle.getVramUsage();
    expect(info.usedMB).toBe(6 * 1024);
    expect(info.totalMB).toBeNull();
  });
});
