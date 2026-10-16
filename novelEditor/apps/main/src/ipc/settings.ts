/** settings 域 IPC（收尾批次 3：设置面板与模型路由，SPEC §7.8 / §15 功能验收）
 *
 * settings:get：当前全部任务路由（含运行时覆盖）+ Ollama 状态（已安装模型名）。
 * settings:set-route：单例 setRoute 后覆盖落库（settings 表 key='model-routes'），返回全量 routes。
 * settings:reset-routes：清除持久化覆盖 + 单例 reset(DEFAULT_ROUTES)，返回全量 routes。
 * settings:list-models：GET /api/tags 原样返回 OllamaModel[]。
 * settings:pull-model：ensureModel（缺失才拉），NDJSON 进度经 eventBus 推 settings:pull-progress。
 */

import { randomUUID } from 'node:crypto';
import { ipcMain } from 'electron';
import type {
  ModelRoute,
  SettingsGetRes,
  SettingsListModelsRes,
  SettingsPullModelReq,
  SettingsPullModelRes,
  SettingsResetRoutesRes,
  SettingsSetRouteReq,
  SettingsSetRouteRes,
  StreamEvent,
} from '@novel-forge/shared';
import type { AppDatabase } from '../db/index.js';
import type { OllamaLifecycle } from '../llm/ollama-lifecycle.js';
import {
  clearRouteOverrides,
  getModelRouter,
  persistRouteOverride,
  type RoutePatch,
} from '../llm/router-instance.js';

export interface SettingsIpcDeps {
  db: AppDatabase;
  /** 缺省时 settings:get 的 ollama 段与 list/pull 返回降级结果 */
  ollama?: OllamaLifecycle;
  emit: (event: StreamEvent) => void;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function registerSettingsIpc(deps: SettingsIpcDeps): void {
  ipcMain.handle('settings:get', async (): Promise<SettingsGetRes> => {
    try {
      const routes: ModelRoute[] = getModelRouter().list();
      if (!deps.ollama) {
        return { ok: true, routes, ollama: { running: false, models: [], detail: 'Ollama 未初始化' } };
      }
      const status = await deps.ollama.listModels();
      return {
        ok: true,
        routes,
        ollama: {
          running: status.running,
          models: status.models.map((m) => m.name),
          ...(status.detail !== undefined ? { detail: status.detail } : {}),
        },
      };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  });

  ipcMain.handle(
    'settings:set-route',
    async (_event, req: SettingsSetRouteReq): Promise<SettingsSetRouteRes> => {
      try {
        // 只把显式给出的字段作为覆盖补丁（undefined 不改动）
        const patch: RoutePatch = {
          ...(req.model !== undefined ? { model: req.model } : {}),
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        };
        getModelRouter().setRoute(req.task, patch);
        persistRouteOverride(deps.db, req.task, patch);
        return { ok: true, routes: getModelRouter().list() };
      } catch (err) {
        return { ok: false, error: errMsg(err) };
      }
    },
  );

  ipcMain.handle('settings:reset-routes', async (): Promise<SettingsResetRoutesRes> => {
    try {
      clearRouteOverrides(deps.db); // 内联 reset 单例回 DEFAULT_ROUTES
      return { ok: true, routes: getModelRouter().list() };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  });

  ipcMain.handle('settings:list-models', async (): Promise<SettingsListModelsRes> => {
    try {
      if (!deps.ollama) return { ok: false, error: 'Ollama 未初始化' };
      const status = await deps.ollama.listModels();
      return { ok: true, models: status.models };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  });

  ipcMain.handle(
    'settings:pull-model',
    async (_event, req: SettingsPullModelReq): Promise<SettingsPullModelRes> => {
      if (!deps.ollama) return { ok: false, error: 'Ollama 未初始化' };
      // jobId 关联本次拉取；进度经 eventBus 推给 Renderer（拉取可能长时间，整条 await）
      const jobId = randomUUID();
      try {
        const name = req.name;
        const available = await deps.ollama.ensureModel(name, (p) => {
          deps.emit({
            type: 'settings:pull-progress',
            jobId,
            model: name,
            status: p.status,
            ...(p.completed !== undefined ? { completed: p.completed } : {}),
            ...(p.total !== undefined ? { total: p.total } : {}),
          });
        });
        return { ok: true, available };
      } catch (err) {
        return { ok: false, error: errMsg(err) };
      }
    },
  );
}
