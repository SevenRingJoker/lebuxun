/** SPEC §7.8 模型路由：routeFor(task) → { model, temperature, format }，支持运行时覆盖 */

import { DEFAULT_ROUTES } from '@novel-forge/shared';
import type { ModelRoute } from '@novel-forge/shared';

export type RouteTask = ModelRoute['task'];

export class ModelRouter {
  private readonly routes = new Map<RouteTask, ModelRoute>();

  constructor(routes: ModelRoute[] = DEFAULT_ROUTES) {
    for (const route of routes) {
      this.routes.set(route.task, { ...route });
    }
  }

  routeFor(task: RouteTask): ModelRoute {
    const route = this.routes.get(task);
    if (!route) {
      throw new Error(`没有任务 ${task} 的模型路由`);
    }
    return { ...route };
  }

  /** 运行时覆盖（设置面板切换任务路由模型，SPEC §15 功能验收） */
  setRoute(task: RouteTask, patch: Partial<Omit<ModelRoute, 'task'>>): void {
    const current = this.routes.get(task);
    if (!current) {
      throw new Error(`没有任务 ${task} 的模型路由`);
    }
    this.routes.set(task, { ...current, ...patch, task });
  }

  list(): ModelRoute[] {
    return [...this.routes.values()].map((r) => ({ ...r }));
  }

  /** 清空并重灌路由（恢复默认或全量替换）；设置面板「恢复默认路由」与启动加载覆盖前调用 */
  reset(routes: ModelRoute[] = DEFAULT_ROUTES): void {
    this.routes.clear();
    for (const route of routes) {
      this.routes.set(route.task, { ...route });
    }
  }
}
