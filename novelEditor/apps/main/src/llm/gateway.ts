/** SPEC §7.4 LLM Gateway：provider 注册 / 默认路由 / 流式 chat / embed / collect 辅助 */

import type { ChatChunk, ChatRequest } from '@novel-forge/shared';

export interface LLMProvider {
  readonly name: string;
  chat(req: ChatRequest): AsyncGenerator<ChatChunk>;
  embed(texts: string[], model?: string): Promise<number[][]>;
}

/** chat() 返回值：AsyncGenerator 附加 collect()（对应 SPEC §9.3 中 `.collect()` 用法） */
export interface ChatStream extends AsyncGenerator<ChatChunk> {
  collect(): Promise<string>;
}

/** 把任意 ChatChunk 流收成完整文本 */
export async function collectStream(stream: AsyncGenerator<ChatChunk>): Promise<string> {
  let text = '';
  for await (const chunk of stream) {
    text += chunk.delta;
  }
  return text;
}

export class LLMGateway {
  private readonly providers = new Map<string, LLMProvider>();
  private defaultProviderName: string | undefined;

  registerProvider(name: string, provider: LLMProvider): void {
    this.providers.set(name, provider);
    if (this.defaultProviderName === undefined) {
      this.defaultProviderName = name;
    }
  }

  setDefault(name: string): void {
    if (!this.providers.has(name)) {
      throw new Error(`LLM provider 未注册: ${name}`);
    }
    this.defaultProviderName = name;
  }

  private resolve(name?: string): LLMProvider {
    const key = name ?? this.defaultProviderName;
    if (key === undefined) {
      throw new Error('LLMGateway 没有任何已注册 provider');
    }
    const provider = this.providers.get(key);
    if (!provider) {
      throw new Error(`LLM provider 未注册: ${key}`);
    }
    return provider;
  }

  chat(req: ChatRequest & { provider?: string }): ChatStream {
    const provider = this.resolve(req.provider);
    const inner = provider.chat(req);
    const gen = inner as ChatStream;
    gen.collect = () => collectStream(inner);
    return gen;
  }

  /** 便捷方法：直接拿到完整文本 */
  collect(req: ChatRequest & { provider?: string }): Promise<string> {
    return this.chat(req).collect();
  }

  embed(texts: string[], opts: { provider?: string; model?: string } = {}): Promise<number[][]> {
    return this.resolve(opts.provider).embed(texts, opts.model);
  }
}
