/** SPEC §7.5 Ollama Provider（走原生 API，不用 OpenAI 兼容端点） */

import { Ollama } from 'ollama';
import type {
  ChatChunk,
  ChatRequest,
  ModelInfo,
  OllamaModel,
  PullProgress,
} from '@novel-forge/shared';
import type { LLMProvider } from '../gateway.js';

export class OllamaProvider implements LLMProvider {
  readonly name = 'ollama';
  private readonly client: Ollama;
  private readonly defaultKeepAlive: string;

  constructor(config: { host?: string; keepAlive?: string } = {}) {
    this.client = new Ollama({ host: config.host ?? 'http://localhost:11434' });
    this.defaultKeepAlive = config.keepAlive ?? '30m';
  }

  async *chat(req: ChatRequest): AsyncGenerator<ChatChunk> {
    const stream = await this.client.chat({
      model: req.model,
      messages: req.messages,
      stream: true,
      keep_alive: this.defaultKeepAlive,
      format: req.format,
      options: {
        temperature: req.temperature ?? 0.7,
        num_predict: req.maxTokens,
        stop: req.stop,
        top_p: req.topP,
        top_k: req.topK,
      },
    });

    for await (const chunk of stream) {
      yield {
        delta: chunk.message.content,
        finishReason: chunk.done ? 'stop' : undefined,
      };
    }
  }

  async embed(texts: string[], model?: string): Promise<number[][]> {
    const res = await this.client.embed({
      model: model ?? 'nomic-embed-text',
      input: texts,
    });
    return res.embeddings;
  }

  async listModels(): Promise<OllamaModel[]> {
    return (await this.client.list()).models as unknown as OllamaModel[];
  }

  async pullModel(name: string): Promise<AsyncGenerator<PullProgress>> {
    return this.client.pull({ model: name, stream: true }) as unknown as Promise<
      AsyncGenerator<PullProgress>
    >;
  }

  async deleteModel(name: string): Promise<void> {
    await this.client.delete({ model: name });
  }

  async showModel(name: string): Promise<ModelInfo> {
    return this.client.show({ model: name }) as unknown as Promise<ModelInfo>;
  }
}
