/** SPEC §4.1 流式事件（Main → Renderer） */

import type { Candidate, Satisfaction } from './candidate.js';
import type { GrowthStats } from './growth.js';

export type StreamEvent =
  | { type: 'workflow:node-start'; runId: string; nodeId: string }
  | { type: 'workflow:node-token'; runId: string; nodeId: string; token: string }
  | { type: 'workflow:node-paused'; runId: string; nodeId: string; payload: unknown }
  | { type: 'workflow:node-done'; runId: string; nodeId: string; output: unknown }
  | { type: 'workflow:node-error'; runId: string; nodeId: string; error: string }
  | { type: 'candidate:marked'; runId: string; candidateId: string; satisfaction: Satisfaction }
  | { type: 'candidate:generated'; runId: string; nodeId: string; candidate: Candidate }
  | { type: 'candidate:pruned'; runId: string; removedIds: string[] }
  // styleId 为 Phase 5 扩展（完成态事件携带档案 id，SPEC-CHANGELOG 登记）
  | { type: 'style:import-progress'; jobId: string; stage: string; progress: number; styleId?: string }
  | { type: 'growth:updated'; projectId: string; stats: GrowthStats }
  // 收尾批次 3：Ollama 模型拉取进度（设置面板「拉取模型」，jobId 关联本次拉取）
  | {
      type: 'settings:pull-progress';
      jobId: string;
      model: string;
      status: string;
      completed?: number;
      total?: number;
    };
