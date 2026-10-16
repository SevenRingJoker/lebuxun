/** SPEC §7.8 / §15：ModelRouter 全局单例 + 路由覆盖持久化（settings 表 key='model-routes'）
 *
 * 缺陷修复：此前各节点/服务各自 `new ModelRouter()`，设置面板的运行时覆盖无法生效；
 * 统一改走 getModelRouter() 单例后，运行时 setRoute 对全部消费点立即生效。
 * 持久化格式：仅记录「被覆盖任务 → 覆盖补丁」的对象（未覆盖任务不落库，恢复默认即清空）。
 */

import { DEFAULT_ROUTES } from '@novel-forge/shared';
import type { ModelRoute } from '@novel-forge/shared';
import type { AppDatabase } from '../db/index.js';
import { SettingsRepository } from '../db/repositories/settings.js';
import { ModelRouter, type RouteTask } from './model-router.js';

/** settings 表持久化键 */
export const MODEL_ROUTES_SETTING_KEY = 'model-routes';

/** 覆盖补丁：仅记录被改动的字段 */
export type RoutePatch = Partial<Omit<ModelRoute, 'task'>>;
/** 持久化结构：task → 覆盖补丁 */
type RouteOverrides = Partial<Record<RouteTask, RoutePatch>>;

/** 全部合法任务名（用于校验从 DB 读回的历史数据） */
const ROUTE_TASKS: readonly RouteTask[] = DEFAULT_ROUTES.map((r) => r.task);

let singleton: ModelRouter | null = null;

/**
 * 取全局单例（懒建，DEFAULT_ROUTES 初值）。
 * 所有节点/服务统一取此实例，以支持设置面板运行时覆盖。
 */
export function getModelRouter(): ModelRouter {
  if (singleton === null) singleton = new ModelRouter(DEFAULT_ROUTES);
  return singleton;
}

function isRouteTask(value: string): value is RouteTask {
  return (ROUTE_TASKS as readonly string[]).includes(value);
}

/** 从完整路由对象抽取覆盖补丁（仅保留已定义字段） */
function patchFromRoute(route: ModelRoute): RoutePatch {
  return {
    model: route.model,
    temperature: route.temperature,
    ...(route.format !== undefined ? { format: route.format } : {}),
  };
}

/**
 * 读持久化覆盖项。兼容两种历史形态：
 * 1. 覆盖补丁对象 `{ task: { model?, temperature? } }`（当前写入口径）；
 * 2. 全量 `ModelRoute[]`（智力兑底，忽略非法项）。
 */
function readOverrides(db: AppDatabase): RouteOverrides {
  const raw = new SettingsRepository(db).get<unknown>(MODEL_ROUTES_SETTING_KEY);
  if (raw === undefined || raw === null) return {};

  if (Array.isArray(raw)) {
    const out: RouteOverrides = {};
    for (const item of raw as ModelRoute[]) {
      if (typeof item !== 'object' || item === null || !isRouteTask((item as ModelRoute).task)) continue;
      out[(item as ModelRoute).task] = patchFromRoute(item as ModelRoute);
    }
    return out;
  }

  if (typeof raw === 'object') {
    const out: RouteOverrides = {};
    for (const [task, patch] of Object.entries(raw as Record<string, unknown>)) {
      if (!isRouteTask(task) || typeof patch !== 'object' || patch === null) continue;
      out[task] = { ...(patch as RoutePatch) };
    }
    return out;
  }
  return {};
}

/** 启动加载：先恢复默认，再逐条把持久化覆盖应用到单例 */
export function loadRouteOverrides(db: AppDatabase): void {
  const router = getModelRouter();
  router.reset(DEFAULT_ROUTES);
  for (const [task, patch] of Object.entries(readOverrides(db))) {
    if (isRouteTask(task)) router.setRoute(task, patch);
  }
}

/** 单条覆盖落库：读回现有覆盖 → 合并本任务补丁 → 写回（upsert） */
export function persistRouteOverride(db: AppDatabase, task: RouteTask, patch: RoutePatch): void {
  const overrides = readOverrides(db);
  overrides[task] = { ...overrides[task], ...patch };
  new SettingsRepository(db).set(MODEL_ROUTES_SETTING_KEY, overrides);
}

/** 全量覆盖落库：仅保留与 DEFAULT_ROUTES 不同的任务（其余不写，等价恢复默认） */
export function saveRouteOverrides(db: AppDatabase, routes: ModelRoute[]): void {
  const overrides: RouteOverrides = {};
  for (const route of routes) {
    const def = DEFAULT_ROUTES.find((r) => r.task === route.task);
    if (!def) continue;
    const patch: RoutePatch = {};
    if (route.model !== def.model) patch.model = route.model;
    if (route.temperature !== def.temperature) patch.temperature = route.temperature;
    if (JSON.stringify(route.format ?? null) !== JSON.stringify(def.format ?? null)) {
      patch.format = route.format;
    }
    if (Object.keys(patch).length > 0) overrides[route.task] = patch;
  }
  new SettingsRepository(db).set(MODEL_ROUTES_SETTING_KEY, overrides);
}

/** 清除全部覆盖并重置单例回 DEFAULT_ROUTES（设置面板「恢复默认路由」） */
export function clearRouteOverrides(db: AppDatabase): void {
  new SettingsRepository(db).delete(MODEL_ROUTES_SETTING_KEY);
  getModelRouter().reset(DEFAULT_ROUTES);
}
