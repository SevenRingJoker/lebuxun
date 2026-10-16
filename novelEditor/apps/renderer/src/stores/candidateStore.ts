/** SPEC §12.6 CandidateState：Phase 4 接入真实 candidate:* IPC */

import { create } from 'zustand';
import type { Candidate } from '@novel-forge/shared';
import { invoke } from '../ipc/index.js';

/** 混合选片段来源（SPEC §15：UserAction mix 的 sources 形状） */
export interface MixSource {
  candidateId: string;
  /** 字符偏移区间 [start, end) */
  span: [number, number];
}

export interface CandidateState {
  candidates: Candidate[];
  selectedId: string | null;
  reasons: string[];
  satisfactionFilter: 'all' | 'satisfied' | 'unsatisfied' | 'unrated';
  /** 当前面板定位（load 后供各操作复用） */
  runId: string | null;
  nodeId: string | null;
  /** 最近一次候选操作失败信息（面板展示） */
  error: string | null;

  load(runId: string, nodeId: string): Promise<void>;
  select(candidateId: string, editedText?: string): Promise<void>;
  satisfy(candidateId: string): Promise<void>;
  dissatisfy(candidateId: string, reason?: string, tags?: string[]): Promise<void>;
  regenerateFrom(candidateId: string, mode: 'improve' | 'variant', hint?: string): Promise<void>;
  regenerateSimilar(candidateId: string, count: number): Promise<void>;
  pruneUnsatisfied(): Promise<void>;
  rejectAll(reason?: string): Promise<void>;
  /** 混合选（§15）：句级合并多候选片段作为选中段落恢复运行 */
  mix(sources: MixSource[]): Promise<void>;
  toggleReason(reason: string): void;
}

export const useCandidateStore = create<CandidateState>((set, get) => ({
  candidates: [],
  selectedId: null,
  reasons: [],
  satisfactionFilter: 'all',
  runId: null,
  nodeId: null,
  error: null,

  async load(runId: string, nodeId: string): Promise<void> {
    const res = await invoke('candidate:list', { runId, nodeId });
    if (res.ok && res.candidates !== undefined) {
      set({ candidates: res.candidates, runId, nodeId, error: null });
    } else {
      set({ runId, nodeId, error: res.error ?? '候选加载失败' });
    }
  },
  async select(candidateId: string, editedText?: string): Promise<void> {
    const { runId, nodeId } = get();
    if (runId === null || nodeId === null) return;
    const res = await invoke('candidate:select', {
      runId,
      nodeId,
      candidateId,
      ...(editedText !== undefined ? { editedText } : {}),
    });
    if (res.ok) {
      // 改后选成功：本地同步编辑文本（main 已回写 DB），无需整表重拉
      set((state) => ({
        selectedId: candidateId,
        error: null,
        candidates:
          editedText !== undefined
            ? state.candidates.map((c) => (c.id === candidateId ? { ...c, text: editedText } : c))
            : state.candidates,
      }));
    } else {
      set({ error: res.error ?? '选中失败' });
    }
  },
  async satisfy(candidateId: string): Promise<void> {
    const { runId, nodeId } = get();
    if (runId === null || nodeId === null) return;
    const res = await invoke('candidate:satisfy', { runId, nodeId, candidateId });
    if (res.ok) {
      set((state) => ({
        error: null,
        candidates: state.candidates.map((c) =>
          c.id === candidateId ? { ...c, satisfaction: 'satisfied' } : c,
        ),
      }));
    } else {
      set({ error: res.error ?? '标记满意失败' });
    }
  },
  async dissatisfy(candidateId: string, reason?: string, tags?: string[]): Promise<void> {
    const { runId, nodeId } = get();
    if (runId === null || nodeId === null) return;
    const res = await invoke('candidate:dissatisfy', {
      runId,
      nodeId,
      candidateId,
      ...(reason !== undefined ? { reason } : {}),
      ...(tags !== undefined ? { reasonTags: tags } : {}),
    });
    if (res.ok) {
      set((state) => ({
        error: null,
        candidates: state.candidates.map((c) =>
          c.id === candidateId
            ? {
                ...c,
                satisfaction: 'unsatisfied',
                ...(reason !== undefined ? { satisfactionReason: reason } : {}),
                ...(tags !== undefined ? { satisfactionTags: tags } : {}),
              }
            : c,
        ),
      }));
    } else {
      set({ error: res.error ?? '标记不满意失败' });
    }
  },
  async regenerateFrom(candidateId: string, mode: 'improve' | 'variant', hint?: string): Promise<void> {
    const { runId, nodeId } = get();
    if (runId === null || nodeId === null) return;
    const res = await invoke('candidate:regenerate-from', {
      runId,
      nodeId,
      candidateId,
      mode,
      ...(hint !== undefined ? { hint } : {}),
    });
    if (res.ok) {
      set({ error: null });
      await get().load(runId, nodeId);
    } else {
      set({ error: res.error ?? '定向重生成失败' });
    }
  },
  async regenerateSimilar(candidateId: string, count: number): Promise<void> {
    const { runId, nodeId } = get();
    if (runId === null || nodeId === null) return;
    const res = await invoke('candidate:regenerate-similar', { runId, nodeId, candidateId, count });
    if (res.ok) {
      set({ error: null });
      await get().load(runId, nodeId);
    } else {
      set({ error: res.error ?? '生成相似失败' });
    }
  },
  async pruneUnsatisfied(): Promise<void> {
    const { runId, nodeId } = get();
    if (runId === null || nodeId === null) return;
    const res = await invoke('candidate:prune-unsatisfied', { runId, nodeId });
    if (res.ok) {
      set({ error: null });
      await get().load(runId, nodeId);
    } else {
      set({ error: res.error ?? '清除不满意失败' });
    }
  },
  async rejectAll(reason?: string): Promise<void> {
    const { runId, nodeId } = get();
    if (runId === null || nodeId === null) return;
    const res = await invoke('candidate:reject-all', { runId, nodeId, ...(reason !== undefined ? { reason } : {}) });
    if (res.ok) {
      set({ error: null });
      await get().load(runId, nodeId);
    } else {
      set({ error: res.error ?? '全弃失败' });
    }
  },
  async mix(sources: MixSource[]): Promise<void> {
    const { runId, nodeId } = get();
    if (runId === null || nodeId === null || sources.length === 0) return;
    // 动态引入避免与 workflowStore 的模块环（workflowStore 静态引入本 store）
    const { useWorkflowStore } = await import('./workflowStore.js');
    await useWorkflowStore.getState().resume(nodeId, { type: 'mix', sources });
    set({ error: useWorkflowStore.getState().error });
  },
  toggleReason(reason: string): void {
    set((state) => ({
      reasons: state.reasons.includes(reason)
        ? state.reasons.filter((r) => r !== reason)
        : [...state.reasons, reason],
    }));
  },
}));
