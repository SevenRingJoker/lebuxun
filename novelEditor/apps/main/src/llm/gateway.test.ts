import { describe, expect, it } from 'vitest';
import type { ChatChunk, ChatRequest } from '@novel-forge/shared';
import { LLMGateway, collectStream, type LLMProvider } from './gateway.js';
import { OllamaProvider } from './providers/ollama.js';
import { ModelRouter } from './model-router.js';
import { DEFAULT_ROUTES } from '@novel-forge/shared';

function mockProvider(name: string, reply = '你好世界'): LLMProvider & { calls: ChatRequest[] } {
  const calls: ChatRequest[] = [];
  return {
    name,
    calls,
    async *chat(req: ChatRequest): AsyncGenerator<ChatChunk> {
      calls.push(req);
      for (const ch of reply) {
        yield { delta: ch };
      }
      yield { delta: '', finishReason: 'stop' };
    },
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((_, i) => [i, 0.5]);
    },
  };
}

describe('LLMGateway', () => {
  it('注册 provider，首个自动成为默认，setDefault 可切换', async () => {
    const gw = new LLMGateway();
    const a = mockProvider('a', 'AAA');
    const b = mockProvider('b', 'BBB');
    gw.registerProvider('a', a);
    gw.registerProvider('b', b);

    const text1 = await gw.collect({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    expect(text1).toBe('AAA');

    gw.setDefault('b');
    const text2 = await gw.collect({ model: 'm', messages: [] });
    expect(text2).toBe('BBB');

    expect(() => gw.setDefault('missing')).toThrow();
  });

  it('chat 可按 provider 覆盖路由，并以流式逐块产出', async () => {
    const gw = new LLMGateway();
    const a = mockProvider('a', 'AAA');
    const b = mockProvider('b', 'xyz');
    gw.registerProvider('a', a);
    gw.registerProvider('b', b);

    const chunks: string[] = [];
    for await (const c of gw.chat({ provider: 'b', model: 'm', messages: [] })) {
      chunks.push(c.delta);
    }
    expect(chunks.join('')).toBe('xyz');
    expect(a.calls).toHaveLength(0);
    expect(b.calls).toHaveLength(1);
  });

  it('chat(...).collect() 与 collectStream 收成完整文本', async () => {
    const gw = new LLMGateway();
    gw.registerProvider('mock', mockProvider('mock', '逐字输出'));

    const viaMethod = await gw.chat({ model: 'm', messages: [] }).collect();
    expect(viaMethod).toBe('逐字输出');

    const viaHelper = await collectStream(gw.chat({ model: 'm', messages: [] }));
    expect(viaHelper).toBe('逐字输出');
  });

  it('embed 走默认 provider', async () => {
    const gw = new LLMGateway();
    gw.registerProvider('mock', mockProvider('mock'));
    const vectors = await gw.embed(['x', 'y'], { model: 'nomic-embed-text' });
    expect(vectors).toEqual([[0, 0.5], [1, 0.5]]);
  });

  it('无 provider 时抛错', () => {
    const gw = new LLMGateway();
    expect(() => gw.chat({ model: 'm', messages: [] })).toThrow();
  });
});

describe('OllamaProvider（类型级构造，不连真实服务）', () => {
  it('可构造且 name 为 ollama', () => {
    const provider = new OllamaProvider({ host: 'http://localhost:11434', keepAlive: '30m' });
    expect(provider.name).toBe('ollama');
    expect(typeof provider.chat).toBe('function');
    expect(typeof provider.embed).toBe('function');
    expect(typeof provider.listModels).toBe('function');
    expect(typeof provider.pullModel).toBe('function');
    expect(typeof provider.deleteModel).toBe('function');
    expect(typeof provider.showModel).toBe('function');
  });
});

describe('ModelRouter', () => {
  it('默认路由与 SPEC §7.8 一致', () => {
    const router = new ModelRouter();
    expect(router.routeFor('chapter-plan')).toEqual({
      task: 'chapter-plan', model: 'qwen3:8b', temperature: 0,
    });
    expect(router.routeFor('paragraph-gen').temperature).toBe(0.7);
    expect(router.routeFor('embedding').model).toBe('nomic-embed-text');
    expect(router.list()).toHaveLength(DEFAULT_ROUTES.length);
  });

  it('setRoute 运行时覆盖', () => {
    const router = new ModelRouter();
    router.setRoute('polish', { model: 'qwen3:32b', temperature: 0.1 });
    expect(router.routeFor('polish')).toEqual({
      task: 'polish', model: 'qwen3:32b', temperature: 0.1,
    });
    // 不影响其他路由
    expect(router.routeFor('chapter-plan').model).toBe('qwen3:8b');
  });
});
