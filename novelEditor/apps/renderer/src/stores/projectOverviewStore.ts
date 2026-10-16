/** 项目概要 store：章节列表 + 成长指数（TopBar / SidePanel 共用，避免重复拉取）
 *
 * - load(projectId)：并行 project:get（chapters）+ growth:stats（growthIndex）
 * - onStreamEvent：
 *   - growth:updated（projectId 匹配）→ 直接采用事件携带的 stats.growthIndex
 *   - workflow:node-done 且节点类型为 chapter.finalizer → 重新拉章节（新章定稿）
 * - clear()：关闭项目时复位
 */

import { create } from 'zustand';
import type { Chapter, StreamEvent } from '@novel-forge/shared';
import { growthApi, projectApi } from '../ipc/index.js';
import { useWorkflowStore } from './workflowStore.js';

export interface ProjectOverviewState {
  projectId: string | null;
  chapters: Chapter[];
  growthIndex: number | null;

  load(projectId: string): Promise<void>;
  /** 流事件增量刷新（由 App 顶层转发） */
  onStreamEvent(event: StreamEvent): void;
  clear(): void;
}

export const useProjectOverviewStore = create<ProjectOverviewState>((set, get) => ({
  projectId: null,
  chapters: [],
  growthIndex: null,

  async load(projectId: string): Promise<void> {
    try {
      const [projectRes, statsRes] = await Promise.all([
        projectApi.get(projectId),
        growthApi.stats(projectId),
      ]);
      set({
        projectId,
        chapters: projectRes.ok ? (projectRes.chapters ?? []) : [],
        growthIndex: statsRes.ok && statsRes.stats ? statsRes.stats.growthIndex : null,
      });
    } catch {
      // 非 Electron 环境（纯 vite 预览）：保持空态
      set({ projectId, chapters: [], growthIndex: null });
    }
  },

  onStreamEvent(event: StreamEvent): void {
    const pid = get().projectId;
    if (pid === null) return;
    if (event.type === 'growth:updated' && event.projectId === pid) {
      set({ growthIndex: event.stats.growthIndex });
      return;
    }
    if (event.type === 'workflow:node-done') {
      // 是否为章节定稿节点：查当前工作流节点类型（不额外引依赖，从 workflowStore 读快照）
      const node = useWorkflowStore
        .getState()
        .workflow?.nodes.find((n) => n.id === event.nodeId);
      if (node?.type === 'chapter.finalizer') {
        void get().load(pid);
      }
    }
  },

  clear(): void {
    set({ projectId: null, chapters: [], growthIndex: null });
  },
}));
