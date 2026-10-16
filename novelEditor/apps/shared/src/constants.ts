/** 共享常量：SPEC §7.8 模型路由 / §7.9 性能配置 / §12.2 不满意理由标签 */

import type { ModelRoute } from './types/llm.js';

/** SPEC §7.8 默认模型路由 */
export const DEFAULT_ROUTES: ModelRoute[] = [
  { task: 'chapter-plan',  model: 'qwen3:8b',         temperature: 0 },
  { task: 'paragraph-gen', model: 'qwen3:8b',         temperature: 0.7 },
  { task: 'polish',        model: 'qwen3:8b',         temperature: 0.3 },
  { task: 'style-analyze', model: 'qwen3:32b',        temperature: 0 },
  { task: 'discriminator', model: 'qwen3:8b',         temperature: 0 },
  { task: 'embedding',     model: 'nomic-embed-text', temperature: 0 },
];

/** SPEC §7.9 性能配置 */
export const OLLAMA_CONFIG = {
  keepAlive: '30m',
  keepAliveBatch: '-1',
  numCtx: 8192,
  numCtxAnalysis: 32768,
  numParallel: 3,
} as const;

/** SPEC §12.2 不满意理由快速标签 */
export const REASON_TAGS = [
  '节奏太快', '节奏太慢',
  '对白生硬', '描写过多',
  '出戏', '人设崩',
  '用词不贴', '信息密度不合适',
  '缺冲突', '缺留白',
] as const;

export type ReasonTag = (typeof REASON_TAGS)[number];

/** SPEC §12.2 选择理由（满意方向）快速标签 */
export const POSITIVE_REASON_TAGS = [
  '节奏好', '人设准', '用词贴', '冲突强', '留白好', '对白自然', '氛围对', '信息密度合适',
] as const;
