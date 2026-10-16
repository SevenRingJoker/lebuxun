/** 收尾批次 3 设置面板状态（SPEC §7.8 / §15）：路由覆盖 + Ollama 状态 + 模型拉取进度
 *
 * - load：settings:get 拉全量路由与 Ollama 状态
 * - setRoute / resetRoutes：逐条覆盖 / 恢复默认，成功后回写 routes
 * - pullModel：settings:pull-model（整条 await），进度经 settings:pull-progress 流事件驱动
 * - onStreamEvent：按 jobId 过滤本次拉取进度（首个匹配事件认领 jobId，后续以该 id 过滤）
 */

import { create } from 'zustand';
import type { ModelRoute, SettingsOllamaStatus, StreamEvent } from '@novel-forge/shared';
import { settingsApi } from '../ipc/index.js';

export interface PullState {
  model: string;
  /** 首个匹配的流事件认领，后续进度按它过滤 */
  jobId: string | null;
  status: string;
  completed?: number;
  total?: number;
}

export interface SettingsState {
  routes: ModelRoute[];
  ollama: SettingsOllamaStatus | null;
  loading: boolean;
  /** 最近一次操作失败信息 */
  error: string | null;
  pulling: PullState | null;
  /** 拉取完成提示（模型名），非 null 时面板展示 */
  pullDone: string | null;

  load(): Promise<void>;
  setRoute(task: ModelRoute['task'], patch: { model?: string; temperature?: number }): Promise<void>;
  resetRoutes(): Promise<void>;
  pullModel(name: string): Promise<void>;
  onStreamEvent(event: StreamEvent): void;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  routes: [],
  ollama: null,
  loading: false,
  error: null,
  pulling: null,
  pullDone: null,

  async load(): Promise<void> {
    set({ loading: true });
    try {
      const res = await settingsApi.get();
      if (res.ok) {
        set({
          routes: res.routes ?? [],
          ollama: res.ollama ?? null,
          loading: false,
          error: null,
        });
      } else {
        set({ loading: false, error: res.error ?? '设置加载失败' });
      }
    } catch (err) {
      set({ loading: false, error: errMsg(err) });
    }
  },

  async setRoute(task, patch): Promise<void> {
    try {
      const res = await settingsApi.setRoute(task, patch);
      if (res.ok) {
        set({ routes: res.routes ?? get().routes, error: null });
      } else {
        set({ error: res.error ?? '保存路由失败' });
      }
    } catch (err) {
      set({ error: errMsg(err) });
    }
  },

  async resetRoutes(): Promise<void> {
    try {
      const res = await settingsApi.resetRoutes();
      if (res.ok) {
        set({ routes: res.routes ?? [], error: null });
      } else {
        set({ error: res.error ?? '恢复默认路由失败' });
      }
    } catch (err) {
      set({ error: errMsg(err) });
    }
  },

  async pullModel(name): Promise<void> {
    set({ pulling: { model: name, jobId: null, status: 'starting' }, pullDone: null, error: null });
    try {
      const res = await settingsApi.pullModel(name);
      if (res.ok && res.available === true) {
        set({ pullDone: name });
      } else if (!res.ok) {
        set({ error: res.error ?? '拉取模型失败' });
      } else {
        set({ error: `模型 ${name} 拉取后仍不可用` });
      }
    } catch (err) {
      set({ error: errMsg(err) });
    } finally {
      set({ pulling: null });
      // 拉取后刷新已安装模型列表
      void get().load();
    }
  },

  onStreamEvent(event: StreamEvent): void {
    if (event.type !== 'settings:pull-progress') return;
    const pulling = get().pulling;
    if (pulling === null || pulling.model !== event.model) return;
    // 按 jobId 过滤：首个匹配事件认领 jobId，后续只接受同一 job
    if (pulling.jobId !== null && pulling.jobId !== event.jobId) return;
    set({
      pulling: {
        model: event.model,
        jobId: event.jobId,
        status: event.status,
        ...(event.completed !== undefined ? { completed: event.completed } : {}),
        ...(event.total !== undefined ? { total: event.total } : {}),
      },
    });
  },
}));
