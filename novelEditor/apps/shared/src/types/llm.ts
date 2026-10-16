/** LLM 相关类型（SPEC §7.4 / §7.5 / §7.6 / §7.8） */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
  format?: 'json' | object;
  topP?: number;
  topK?: number;
}

export interface ChatChunk {
  delta: string;
  finishReason?: string;
}

export interface OllamaModel {
  name: string;
  model?: string;
  size: number;
  digest?: string;
  modified_at?: string;
  details?: Record<string, unknown>;
}

export interface PullProgress {
  status: string;
  digest?: string;
  total?: number;
  completed?: number;
}

export type ModelInfo = Record<string, unknown>;

export interface VramInfo {
  /** /api/ps 汇总 size_vram 得出（MB） */
  usedMB: number;
  /** 总量（MB）。Windows 下无法可靠获取真实显存时由调用方置 null 并注明来源 */
  totalMB: number | null;
  freeMB: number | null;
}

export interface ModelRoute {
  task: 'chapter-plan' | 'paragraph-gen' | 'polish'
      | 'style-analyze' | 'discriminator' | 'embedding';
  model: string;
  temperature: number;
  format?: 'json' | object;
}
