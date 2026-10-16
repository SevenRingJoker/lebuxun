/** Channel B · Main ↔ Python Sidecar 请求/响应类型（SPEC §4.2） */

import type { SceneType, StyleProfile } from './style.js';

export interface SidecarHealth {
  status: string;
  version: string;
}

export interface StyleAnalyzeBookInput {
  title: string;
  path: string;
}

export interface StyleAnalyzeRequest {
  authorName: string;
  genre: string;
  styleId?: string;
  books: StyleAnalyzeBookInput[];
}

export type StyleAnalyzeEvent =
  | { type: 'progress'; stage: string; progress: number }
  // done 帧可携带完整档案（SPEC §4.2 未给字段细节，SPEC-CHANGELOG 登记）；
  // 缺省时 Main 回退 GET /style/{styleId}
  | { type: 'done'; styleId: string; reportPath?: string; profile?: StyleProfile }
  | { type: 'error'; error: string };

export type StyleGetResponse = StyleProfile;

export interface EmbedRequest {
  texts: string[];
}
export interface EmbedResponse {
  vectors: number[][];
}

export interface RagChunkInput {
  id?: string;
  bookId: string;
  chapterIndex?: number;
  text: string;
  sceneType: SceneType;
}
export interface RagIndexRequest {
  styleId: string;
  chunks: RagChunkInput[];
}
export interface RagIndexResponse {
  ok: boolean;
  count: number;
}

export interface RagQueryRequest {
  styleId: string;
  query: string;
  sceneType?: SceneType;
  topK?: number;
}
export interface RagQueryResult {
  id: string;
  text: string;
  sceneType: SceneType;
  score: number;
}
export interface RagQueryResponse {
  results: RagQueryResult[];
}

export interface DiscriminatorScoreRequest {
  styleId: string;
  text: string;
}
export interface DiscriminatorScoreResponse {
  score: number;
  verdict: string;
}

export interface RewardScoreRequest {
  styleId?: string;
  texts: string[];
}
export interface RewardScoreResponse {
  scores: number[];
  /** 已训练奖励模型版本（如 "v3"）；未训练走启发式 baseline 时为 null（§9.4 模型分仅在此时采信） */
  modelVersion?: string | null;
}

/** Phase 6：GET /reward/status（SPEC §4.2 未列，SPEC-CHANGELOG 登记）：校准 UI 与成长仪表盘模型段 */
export interface RewardStatusResponse {
  /** 模型版本（如 "v3"），未训练为 null */
  version: string | null;
  /** 最近一次训练留出集成对准确率，未训练/未知为 null */
  accuracy: number | null;
  kendallTau: number | null;
  /** 最近训练样本数与完成时间戳（秒），未训练为 null */
  sampleCount: number | null;
  trainedAt: number | null;
}

export interface SceneClassifyRequest {
  text: string;
}
export interface SceneClassifyResponse {
  sceneType: SceneType;
  confidence: number;
}
