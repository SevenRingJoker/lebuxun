/** SPEC §6.4 style.ts */

export type SceneType =
  | 'battle' | 'dialogue' | 'daily' | 'psychology'
  | 'environment' | 'transition' | 'hook' | 'climax';

export interface StyleBook {
  id: string;
  styleId?: string;
  title: string;
  wordCount?: number;
  chapterCount?: number;
  path?: string;
}

/** LLM 深度分析报告（SPEC §11.4.2），markdown 可直接作为系统提示词 */
export interface StyleReport {
  markdown?: string;
  summary?: string;
  [key: string]: unknown;
}

export interface StyleFingerprint {
  avgSentenceLength: number;
  sentenceLengthStd: number;
  shortSentenceRatio: number;
  avgParagraphLength: number;
  dialogueRatio: number;
  metaphorDensity: number;
  punctuation: Record<string, number>;
  topWords: string[];
  signatureWords: string[];
  forbiddenWords: string[];
}

export interface StyleProfile {
  id: string;
  authorName: string;
  genre: string;
  bookCount: number;
  books: StyleBook[];
  fingerprint: StyleFingerprint;
  report: StyleReport;
  ragStats: { totalChunks: number; byScene: Record<SceneType, number> };
  discriminatorVersion?: string;
  rewardModelVersion?: string;
  createdAt: number;
  updatedAt: number;
}
