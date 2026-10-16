/** SPEC §6.1 project.ts */

import type { SceneType } from './style.js';

export interface Project {
  id: string;
  name: string;
  genre: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
}

export interface Chapter {
  id: string;
  projectId: string;
  index: number;
  title: string;
  status: 'planned' | 'writing' | 'draft' | 'final';
  wordCount: number;
  summary?: string;
  createdAt: number;
  updatedAt: number;
}

export type ParagraphMetadata = Record<string, unknown>;

export interface Paragraph {
  id: string;
  chapterId: string;
  index: number;
  text: string;
  sceneType: SceneType;
  metadata: ParagraphMetadata;
}
