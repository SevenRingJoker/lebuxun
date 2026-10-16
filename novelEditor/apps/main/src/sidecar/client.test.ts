import { describe, expect, it } from 'vitest';
import { SidecarClient, SidecarHttpError, parseSse, type FetchLike } from './client.js';
import type { StyleAnalyzeEvent } from '@novel-forge/shared';

interface RecordedCall {
  url: string;
  method: string;
  body?: unknown;
}

function recordingFetch(responder: (url: string) => Response): {
  fetchFn: FetchLike;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return responder(url);
  };
  return { fetchFn, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('SidecarClient 请求路径构造', () => {
  it('health → GET /health', async () => {
    const { fetchFn, calls } = recordingFetch(() => jsonResponse({ status: 'ok', version: '0.1.0' }));
    const client = new SidecarClient('http://127.0.0.1:8901', fetchFn);
    const health = await client.health();
    expect(health).toEqual({ status: 'ok', version: '0.1.0' });
    expect(calls).toEqual([{ url: 'http://127.0.0.1:8901/health', method: 'GET', body: undefined }]);
  });

  it('embed → POST /embed，返回 vectors', async () => {
    const { fetchFn, calls } = recordingFetch(() => jsonResponse({ vectors: [[0.1, 0.2]] }));
    const client = new SidecarClient('http://127.0.0.1:8901', fetchFn);
    const vectors = await client.embed(['文本']);
    expect(vectors).toEqual([[0.1, 0.2]]);
    expect(calls[0]).toMatchObject({
      url: 'http://127.0.0.1:8901/embed',
      method: 'POST',
      body: { texts: ['文本'] },
    });
  });

  it('rag/index、rag/query、discriminator/score、reward/score、scene/classify 路径正确', async () => {
    const { fetchFn, calls } = recordingFetch((url) => {
      if (url.endsWith('/rag/index')) return jsonResponse({ ok: true, count: 2 });
      if (url.endsWith('/rag/query')) return jsonResponse({ results: [] });
      if (url.endsWith('/discriminator/score')) return jsonResponse({ score: 0.88, verdict: 'like' });
      if (url.endsWith('/reward/score')) return jsonResponse({ scores: [0.5] });
      if (url.endsWith('/scene/classify')) return jsonResponse({ sceneType: 'battle', confidence: 0.9 });
      return jsonResponse({}, 404);
    });
    const client = new SidecarClient('http://127.0.0.1:8901', fetchFn);

    await client.ragIndex({
      styleId: 's1',
      chunks: [{ bookId: 'b1', text: 't', sceneType: 'daily' }],
    });
    await client.ragQuery({ styleId: 's1', query: 'q', topK: 5 });
    const disc = await client.discriminatorScore({ styleId: 's1', text: 'x' });
    const reward = await client.rewardScore({ texts: ['x'] });
    const scene = await client.sceneClassify({ text: '刀光剑影' });

    expect(disc).toEqual({ score: 0.88, verdict: 'like' });
    expect(reward.scores).toEqual([0.5]);
    expect(scene.sceneType).toBe('battle');
    expect(calls.map((c) => c.url)).toEqual([
      'http://127.0.0.1:8901/rag/index',
      'http://127.0.0.1:8901/rag/query',
      'http://127.0.0.1:8901/discriminator/score',
      'http://127.0.0.1:8901/reward/score',
      'http://127.0.0.1:8901/scene/classify',
    ]);
  });

  it('style get/delete 走 /style/{styleId}', async () => {
    const { fetchFn, calls } = recordingFetch(() => jsonResponse({ ok: true }));
    const client = new SidecarClient('http://127.0.0.1:8901', fetchFn);
    await client.getStyle('风格/1');
    await client.deleteStyle('风格/1');
    expect(calls[0]).toMatchObject({
      url: `http://127.0.0.1:8901/style/${encodeURIComponent('风格/1')}`,
      method: 'GET',
    });
    expect(calls[1]).toMatchObject({ method: 'DELETE' });
  });

  it('styleAnalyze 以 SSE 流式产出进度事件', async () => {
    const sseBody =
      'data: {"type":"progress","stage":"chunking","progress":0}\n\n' +
      'data: {"type":"progress","stage":"chunking","progress":1}\n\n' +
      'data: {"type":"done","styleId":"s1","reportPath":"data/styles/s1/report.md"}\n\n';
    const { fetchFn, calls } = recordingFetch(() => new Response(sseBody, { status: 200 }));
    const client = new SidecarClient('http://127.0.0.1:8901', fetchFn);

    const events: StyleAnalyzeEvent[] = [];
    for await (const ev of client.styleAnalyze({
      authorName: '作家X',
      genre: '仙侠',
      books: [{ title: '书1', path: 'data/books/1.txt' }],
    })) {
      events.push(ev);
    }

    expect(calls[0]).toMatchObject({ url: 'http://127.0.0.1:8901/style/analyze', method: 'POST' });
    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({ type: 'progress', stage: 'chunking', progress: 0 });
    expect(events[2]).toMatchObject({ type: 'done', styleId: 's1' });
  });

  it('非 2xx 响应抛错', async () => {
    const { fetchFn } = recordingFetch(() => jsonResponse({}, 500));
    const client = new SidecarClient('http://127.0.0.1:8901', fetchFn);
    await expect(client.health()).rejects.toThrow('HTTP 500');
  });

  it('rewardStatus → GET /reward/status 并解析全可空字段', async () => {
    const body = { version: 'v3', accuracy: 0.82, kendallTau: 0.6, sampleCount: 120, trainedAt: 1700000000 };
    const { fetchFn, calls } = recordingFetch(() => jsonResponse(body));
    const client = new SidecarClient('http://127.0.0.1:8901', fetchFn);
    const status = await client.rewardStatus();
    expect(status).toEqual(body);
    expect(calls[0]).toMatchObject({ url: 'http://127.0.0.1:8901/reward/status', method: 'GET' });
  });

  it('rewardStatus 非 2xx 抛错（由调用方降级缓存）', async () => {
    const { fetchFn } = recordingFetch(() => jsonResponse({}, 503));
    const client = new SidecarClient('http://127.0.0.1:8901', fetchFn);
    await expect(client.rewardStatus()).rejects.toThrow('HTTP 503');
  });
});

describe('parseSse', () => {
  it('跨 chunk 的 data 行也能正确拼合', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"a":'));
        controller.enqueue(encoder.encode('1}\n\ndata: {"a":2}\n\n'));
        controller.close();
      },
    });
    const items: unknown[] = [];
    for await (const item of parseSse(stream)) {
      items.push(item);
    }
    expect(items).toEqual([{ a: 1 }, { a: 2 }]);
  });
});

describe('trainReward（§10.2 奖励模型训练）', () => {
  const trainReq = {
    samples: [{ projectId: 'p1', context: 'c', chosen: 'a', rejected: 'b', reasons: [] }],
  };

  it('POST /reward/train，SSE 流消费到结束（中间进度帧不解析）', async () => {
    const sseBody =
      'data: {"type":"progress","progress":0.5}\n\n' +
      'data: {"type":"progress","progress":1}\n\n' +
      'data: {"type":"done"}\n\n';
    const { fetchFn, calls } = recordingFetch(() => new Response(sseBody, { status: 200 }));
    const client = new SidecarClient('http://127.0.0.1:8901', fetchFn);
    await expect(client.trainReward(trainReq)).resolves.toBeUndefined();
    expect(calls[0]).toMatchObject({
      url: 'http://127.0.0.1:8901/reward/train',
      method: 'POST',
      body: trainReq,
    });
  });

  it('HTTP 400 → 抛带 detail 的 SidecarHttpError（样本不足业务失败）', async () => {
    const { fetchFn } = recordingFetch(() =>
      jsonResponse({ detail: '训练样本不足：当前 10 条，需要至少 100 条' }, 400),
    );
    const client = new SidecarClient('http://127.0.0.1:8901', fetchFn);
    const err = await client.trainReward(trainReq).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SidecarHttpError);
    expect((err as SidecarHttpError).status).toBe(400);
    expect((err as SidecarHttpError).detail).toBe('训练样本不足：当前 10 条，需要至少 100 条');
    await expect(client.trainReward(trainReq)).rejects.toThrow('训练样本不足：当前 10 条，需要至少 100 条');
  });

  it('SSE error 帧 → 抛 SidecarHttpError', async () => {
    const sseBody = 'data: {"type":"error","detail":"数据损坏"}\n\n';
    const { fetchFn } = recordingFetch(() => new Response(sseBody, { status: 200 }));
    const client = new SidecarClient('http://127.0.0.1:8901', fetchFn);
    const err = await client.trainReward(trainReq).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SidecarHttpError);
    expect((err as SidecarHttpError).message).toContain('数据损坏');
  });

  it('extractTemplates / createPromptTemplate / listPromptTemplates 路径正确', async () => {
    const { fetchFn, calls } = recordingFetch((url) => {
      if (url.includes('/evolution/extract-templates')) return jsonResponse({ templates: [{ id: 't1' }], message: 'ok' });
      if (url.includes('/evolution/prompt-templates?')) return jsonResponse({ templates: [] });
      return jsonResponse({
        id: 'pt1',
        nodeType: 'improve',
        projectId: 'p1',
        version: 2,
        parentVersion: 1,
        content: '新提示词',
        basedOn: 'base',
      });
    });
    const client = new SidecarClient('http://127.0.0.1:8901', fetchFn);
    const extracted = await client.extractTemplates({ samples: [] });
    expect(extracted.templates).toHaveLength(1);
    const created = await client.createPromptTemplate({ nodeType: 'improve', baseTemplate: 'base', projectId: 'p1' });
    expect(created).toMatchObject({ nodeType: 'improve', version: 2, content: '新提示词' });
    const list = await client.listPromptTemplates('improve');
    expect(list.templates).toEqual([]);
    expect(calls.map((c) => c.url)).toEqual([
      'http://127.0.0.1:8901/evolution/extract-templates',
      'http://127.0.0.1:8901/evolution/prompt-templates',
      'http://127.0.0.1:8901/evolution/prompt-templates?nodeType=improve',
    ]);
  });
});
