/** window.nv.invoke 类型化封装（Renderer 侧唯一 IPC 入口） */

import type {
  ExportFormat,
  IpcChannel,
  IpcRequestMap,
  IpcResponseMap,
  ModelRoute,
  ProjectCreateReq,
  StreamEvent,
  StyleImportReq,
} from '@novel-forge/shared';

interface NvBridge {
  invoke(channel: string, req?: unknown): Promise<unknown>;
  onStreamEvent(cb: (event: unknown) => void): () => void;
}

declare global {
  interface Window {
    nv?: NvBridge;
  }
}

function bridge(): NvBridge {
  if (!window.nv) {
    throw new Error('window.nv 不可用（非 Electron 环境或 preload 未加载）');
  }
  return window.nv;
}

export async function invoke<C extends IpcChannel>(
  channel: C,
  req: IpcRequestMap[C],
): Promise<IpcResponseMap[C]> {
  return (await bridge().invoke(channel, req)) as IpcResponseMap[C];
}

export function onStreamEvent(cb: (event: StreamEvent) => void): () => void {
  return bridge().onStreamEvent((event) => cb(event as StreamEvent));
}

/** 收尾新增：项目入口页（project:* 频道封装） */
export const projectApi = {
  list: () => invoke('project:list', {}),
  create: (req: ProjectCreateReq) => invoke('project:create', req),
  get: (id: string) => invoke('project:get', { id }),
};

/** Phase 5 风格库（§12.4）频道封装 */
export const styleApi = {
  list: () => invoke('style:list', {}),
  import: (req: StyleImportReq) => invoke('style:import', req),
  get: (styleId: string) => invoke('style:get', { styleId }),
  remove: (styleId: string) => invoke('style:delete', { styleId }),
  pickFiles: () => invoke('style:pick-files', {}),
  /** 收尾批次 4：风格相似度自测（SPEC §15 N 分档阈值 + §12.4 面板） */
  selfCheck: (styleId: string) => invoke('style:self-check', { styleId }),
};

/** Phase 6 成长仪表盘（§12.5）频道封装 */
export const growthApi = {
  stats: (projectId: string) => invoke('growth:stats', { projectId }),
  profile: (projectId: string) => invoke('growth:profile', { projectId }),
  calibration: (projectId: string) => invoke('growth:calibration', { projectId }),
  /** §10.2：手动触发奖励模型训练（学习闭环批次） */
  trainReward: (projectId: string) => invoke('growth:train-reward', { projectId }),
};

/** Phase 6 候选操作扩展（任务 6.4 版本对比） */
export const candidateApi = {
  diff: (candidateIdA: string, candidateIdB: string) =>
    invoke('candidate:diff', { candidateIdA, candidateIdB }),
};

/** Phase 6 成稿导出（任务 6.6，§5.3 data/exports/） */
export const exportApi = {
  manuscript: (projectId: string, format: ExportFormat) =>
    invoke('export:manuscript', { projectId, format }),
};

/** 收尾批次 3 设置面板（SPEC §7.8 / §15）频道封装 */
export const settingsApi = {
  get: () => invoke('settings:get', {}),
  setRoute: (task: ModelRoute['task'], patch: { model?: string; temperature?: number }) =>
    invoke('settings:set-route', { task, ...patch }),
  resetRoutes: () => invoke('settings:reset-routes', {}),
  listModels: () => invoke('settings:list-models', {}),
  pullModel: (name: string) => invoke('settings:pull-model', { name }),
};
