/** SPEC §12.6 WorkflowState：收尾接入真实 workflow:* IPC + 流事件驱动 run 状态
 *
 * - load：workflow:load 拿 workflow 存 store（projectId 写入，run 状态重置）；
 *   失败置 error 且 projectId 留空（App 仍渲染项目入口页，可重试/返回）
 * - run：workflow:run 拿 runId；Promise 在 run 到达稳定态（done/error/paused）才兑现，
 *   响应携带权威 status（#56），流事件负责过程态（node-start/paused/error），
 *   响应到达后以 status 兜底，消除「直达 done 无 node-start」时的状态滞留
 * - resume：同理以响应 status 为准；若期间已在其它节点重新暂停（node-paused 事件
 *   FIFO 先于响应到达），保留事件携带的 currentNodeId/pausedPayload，不清空
 * - onStreamEvent：run 维度过滤（runId 未知时以事件为准认领）；暂停在
 *   review.candidate-picker 节点时触发 candidateStore.load 拉候选面板数据
 * - close：清空 projectId 回项目入口页（paused run 留库，引擎侧可恢复）
 */

import { create } from 'zustand';
import type { StreamEvent, UserAction, Workflow } from '@novel-forge/shared';
import { invoke } from '../ipc/index.js';
import { useCandidateStore } from './candidateStore.js';

export interface WorkflowState {
  workflow: Workflow | null;
  /** 当前项目 id（Phase 6 成长仪表盘等按项目取数的入口；load 时写入） */
  projectId: string | null;
  runId: string | null;
  runStatus: 'idle' | 'running' | 'paused' | 'done' | 'error';
  currentNodeId: string | null;
  nodeOutputs: Record<string, Record<string, unknown>>;
  pausedPayload: unknown;
  /** load/run/resume 失败信息（项目入口页与顶栏展示） */
  error: string | null;
  /** token 级流式（§15）：当前节点已累计 token 数（workflow:node-token 驱动） */
  tokenCount: number;
  /** token 级流式（§15）：最新片段（尾部截断展示用） */
  tokenTail: string;
  /** 当前章节已累加段落数（chapter.accumulator 节点 done 事件驱动，新 run/新节点重置） */
  accumulatedCount: number;

  load(projectId: string, workflowId: string): Promise<void>;
  run(): Promise<void>;
  resume(nodeId: string, action: UserAction): Promise<void>;
  stop(): Promise<void>;
  close(): void;
  onStreamEvent(event: StreamEvent): void;
}

/** 「生成中…」状态区最新片段的尾部保留长度（字符数，UI 展示口径） */
const TOKEN_TAIL_LENGTH = 40;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const useWorkflowStore = create<WorkflowState>((set, get) => ({
  workflow: null,
  projectId: null,
  runId: null,
  runStatus: 'idle',
  currentNodeId: null,
  nodeOutputs: {},
  pausedPayload: null,
  error: null,
  tokenCount: 0,
  tokenTail: '',
  accumulatedCount: 0,

  async load(projectId: string, workflowId: string): Promise<void> {
    try {
      const res = await invoke('workflow:load', { projectId, workflowId });
      if (res.ok && res.workflow !== undefined) {
        set({
          workflow: res.workflow,
          projectId,
          runId: null,
          runStatus: 'idle',
          currentNodeId: null,
          nodeOutputs: {},
          pausedPayload: null,
          error: null,
          tokenCount: 0,
          tokenTail: '',
          accumulatedCount: 0,
        });
      } else {
        // 失败不写 projectId：入口页保持渲染，错误经 error 字段展示
        set({ runStatus: 'error', error: res.error ?? '工作流加载失败' });
      }
    } catch (err) {
      set({ runStatus: 'error', error: errMsg(err) });
    }
  },

  async run(): Promise<void> {
    const { workflow, projectId, runStatus } = get();
    if (workflow === null || projectId === null || runStatus === 'running') return;
    try {
      const res = await invoke('workflow:run', { projectId, workflowId: workflow.id });
      if (res.ok && res.runId !== undefined) {
        set({ runId: res.runId });
        if (res.status === 'done') {
          set({ runStatus: 'done', error: null });
        } else if (res.status === 'error' || res.status === 'paused') {
          // paused 的 currentNodeId/payload 已由先行到达的 node-paused 事件写入
          set({ runStatus: res.status });
        } else if (get().runStatus === 'idle' || get().runStatus === 'running') {
          // 旧 Main 无 status 字段时的兼容启发：兑现时未置 paused/error 即 run 已跑到底
          set({ runStatus: 'done', error: null });
        }
      } else {
        set({ runStatus: 'error', error: res.error ?? '运行失败' });
      }
    } catch (err) {
      set({ runStatus: 'error', error: errMsg(err) });
    }
  },

  async resume(nodeId: string, action: UserAction): Promise<void> {
    const { runId } = get();
    if (runId === null) return;
    try {
      const res = await invoke('workflow:resume', { runId, nodeId, userAction: action });
      if (!res.ok) {
        set({ runStatus: 'error', error: res.error ?? '恢复运行失败' });
        return;
      }
      // 流事件 FIFO 先于响应：若已在「其它节点」重新暂停，事件写入的
      // currentNodeId/pausedPayload 必须保留（#56：原实现无条件清空会抹掉新暂停面板）
      const rePausedElsewhere =
        get().runStatus === 'paused' && get().currentNodeId !== nodeId;
      if (res.status === 'done') {
        set({ runStatus: 'done', pausedPayload: null, error: null });
      } else if (res.status === 'error') {
        set({ runStatus: 'error', pausedPayload: null });
      } else if (res.status === 'paused') {
        if (!rePausedElsewhere) set({ runStatus: 'paused' });
      } else if (!rePausedElsewhere) {
        // 旧 Main 无 status 字段时的兼容启发：仍在 running 即直达 done
        set({ pausedPayload: null });
        if (get().runStatus === 'running') set({ runStatus: 'done' });
      }
    } catch (err) {
      set({ runStatus: 'error', error: errMsg(err) });
    }
  },

  async stop(): Promise<void> {
    const { runId } = get();
    if (runId === null) return;
    try {
      await invoke('workflow:stop', { runId });
    } catch (err) {
      set({ error: errMsg(err) });
    }
  },

  close(): void {
    set({
      workflow: null,
      projectId: null,
      runId: null,
      runStatus: 'idle',
      currentNodeId: null,
      nodeOutputs: {},
      pausedPayload: null,
      error: null,
      tokenCount: 0,
      tokenTail: '',
      accumulatedCount: 0,
    });
    useCandidateStore.setState({ candidates: [], selectedId: null, runId: null, nodeId: null, error: null });
  },

  onStreamEvent(event: StreamEvent): void {
    // run 维度事件过滤：已认领 runId 后忽略其它 run；未认领时以事件为准
    if ('runId' in event) {
      const known = get().runId;
      if (known !== null && event.runId !== known) return;
    }
    switch (event.type) {
      case 'workflow:node-start':
        set({ runId: event.runId, runStatus: 'running', currentNodeId: event.nodeId, tokenCount: 0, tokenTail: '', accumulatedCount: 0 });
        break;
      case 'workflow:node-token':
        // token 级流式（§15）：累计计数 + 尾部片段（面板「生成中…」状态区）
        set((state) => ({
          tokenCount: state.tokenCount + 1,
          tokenTail: (state.tokenTail + event.token).slice(-TOKEN_TAIL_LENGTH),
        }));
        break;
      case 'workflow:node-paused': {
        set({
          runId: event.runId,
          runStatus: 'paused',
          currentNodeId: event.nodeId,
          pausedPayload: event.payload,
        });
        // 候选选择面板节点暂停：拉候选列表驱动 CandidatePanel
        const node = get().workflow?.nodes.find((n) => n.id === event.nodeId);
        if (node?.type === 'review.candidate-picker') {
          void useCandidateStore.getState().load(event.runId, event.nodeId);
        }
        break;
      }
      case 'workflow:node-done': {
        set((state) => ({
          nodeOutputs: {
            ...state.nodeOutputs,
            [event.nodeId]: (event.output ?? {}) as Record<string, unknown>,
          },
        }));
        // 章节累加器完成：output.chapterDraft.paragraphs 即当前章全部段落（按章覆盖）
        const doneNode = get().workflow?.nodes.find((n) => n.id === event.nodeId);
        if (doneNode?.type === 'chapter.accumulator') {
          const draft = (event.output as { chapterDraft?: { paragraphs?: unknown[] } } | null)
            ?.chapterDraft;
          if (Array.isArray(draft?.paragraphs)) {
            set({ accumulatedCount: draft.paragraphs.length });
          }
        }
        break;
      }
      case 'workflow:node-error':
        set({ runId: event.runId, runStatus: 'error', error: event.error });
        break;
      case 'candidate:generated': {
        // 面板打开期间定向重生成的新候选实时入列
        const cs = useCandidateStore.getState();
        if (cs.runId === event.runId && cs.nodeId === event.nodeId) {
          useCandidateStore.setState({ candidates: [...cs.candidates, event.candidate] });
        }
        break;
      }
      case 'candidate:marked': {
        // 满意度标记（IPC 或 resume 兜底）同步面板内候选状态
        const cs = useCandidateStore.getState();
        if (cs.runId === event.runId) {
          useCandidateStore.setState({
            candidates: cs.candidates.map((c) =>
              c.id === event.candidateId ? { ...c, satisfaction: event.satisfaction } : c,
            ),
          });
        }
        break;
      }
      default:
        break;
    }
  },
}));
