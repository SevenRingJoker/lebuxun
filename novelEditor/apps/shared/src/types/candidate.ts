/** SPEC §6.3 candidate.ts */

export type Satisfaction = 'satisfied' | 'unsatisfied' | 'unrated';
export type GenerationMode = 'fresh' | 'improve' | 'variant' | 'mix';

export interface CandidateStrategy {
  label: string;
  temperature: number;
  perspective?: string;
  pacing?: string;
  dialogueRatio?: string;
}

export interface CandidateScores {
  pacing: number;
  character: number;
  consistency: number;
  profileFit: number;
  styleSimilarity: number;
  rewardScore: number;
}

export interface Candidate {
  id: string;
  runId: string;
  nodeId: string;
  index: number;
  text: string;
  strategy: CandidateStrategy;
  scores: CandidateScores;

  satisfaction: Satisfaction;
  satisfactionReason?: string;
  satisfactionTags?: string[];
  parentCandidateId?: string;
  generationMode: GenerationMode;
  generationDepth: number;
  lineage: string[];
}

/** 谱系树节点（candidate:lineage IPC；SPEC §4.1 未定义该频道，SPEC-CHANGELOG 登记） */
export interface CandidateLineageNode {
  candidate: Candidate;
  /** 六维分数均值（§9.4） */
  avgScore: number;
  children: CandidateLineageNode[];
}

export type UserAction =
  | { type: 'select'; candidateId: string; editedText?: string }
  | { type: 'mix'; sources: { candidateId: string; span: [number, number] }[] }
  | { type: 'satisfy'; candidateId: string }
  | { type: 'dissatisfy'; candidateId: string; reason?: string; reasonTags?: string[] }
  | { type: 'unmark'; candidateId: string }
  | { type: 'regenerate-from'; candidateId: string; mode: 'improve' | 'variant'; hint?: string }
  | { type: 'regenerate-similar'; candidateId: string; count: number }
  | { type: 'reject-all'; reason?: string }
  | { type: 'add-candidates'; count: number }
  | { type: 'prune-unsatisfied' }
  /** 章节结束判定（review.chapter-end 暂停节点的 resume 动作；原 #16 扩展字段正式入契约） */
  | { type: 'chapter-end'; decision: 'continue' | 'end' };
