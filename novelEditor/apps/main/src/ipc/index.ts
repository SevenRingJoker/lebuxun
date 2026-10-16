/** IPC 注册入口（SPEC §4.1 频道清单）
 *
 * Phase 3 接线：registerBuiltinNodes 注册核心节点，llm/sidecar 注入引擎；
 * EventBus 订阅 StreamEvent → 全部 BrowserWindow 转发
 * （频道名与 preload 的 window.nv.onStreamEvent 一致，见 stream-channel.ts）。
 */

import { BrowserWindow } from 'electron';
import type { AppDatabase } from '../db/index.js';
import { ProjectsRepository } from '../db/repositories/projects.js';
import { CandidatesRepository } from '../db/repositories/candidates.js';
import { WorkflowsRepository } from '../db/repositories/workflows.js';
import type { LLMGateway } from '../llm/gateway.js';
import type { OllamaLifecycle } from '../llm/ollama-lifecycle.js';
import { getModelRouter } from '../llm/router-instance.js';
import { registerBuiltinNodes } from '../nodes/definitions/index.js';
import { NodeRegistry } from '../nodes/registry.js';
import type { SidecarClient } from '../sidecar/client.js';
import { STREAM_EVENT_CHANNEL } from '../stream-channel.js';
import { loadDefaultWorkflow, type DefaultWorkflowGraph } from '../workflow/default-workflow.js';
import { WorkflowEngine } from '../workflow/engine.js';
import { EventBus } from '../workflow/events.js';
import { registerProjectIpc } from './project.js';
import { registerWorkflowIpc } from './workflow.js';
import { registerCandidateIpc } from './candidate.js';
import { registerStyleIpc } from './style.js';
import { registerGrowthIpc } from './growth.js';
import { registerExportIpc } from './export.js';
import { registerSettingsIpc } from './settings.js';

export interface IpcDeps {
  db: AppDatabase;
  /** Phase 3：真实节点经 NodeContext 消费；缺省时 LLM/RAG 节点执行报错或降级 */
  llm?: LLMGateway;
  sidecar?: SidecarClient;
  /** 收尾批次 3：设置面板（settings:* IPC + 启动模型检查）依赖 */
  ollama?: OllamaLifecycle;
}

export interface Repositories {
  projects: ProjectsRepository;
  candidates: CandidatesRepository;
  workflows: WorkflowsRepository;
}

export interface IpcRuntime {
  repos: Repositories;
  engine: WorkflowEngine;
  eventBus: EventBus;
}

function loadDefaultWorkflowSafe(): DefaultWorkflowGraph | undefined {
  try {
    return loadDefaultWorkflow();
  } catch (err) {
    console.warn('[novel-forge] 默认工作流加载失败，project:create 将不绑定工作流：', err);
    return undefined;
  }
}

export function registerIpcHandlers(deps: IpcDeps): IpcRuntime {
  const repos: Repositories = {
    projects: new ProjectsRepository(deps.db),
    candidates: new CandidatesRepository(deps.db),
    workflows: new WorkflowsRepository(deps.db),
  };

  // 工作流引擎：注册 Phase 3 内建节点，注入 llm/sidecar（NodeContext 可选字段）
  const eventBus = new EventBus();
  const registry = new NodeRegistry();
  registerBuiltinNodes(registry);
  const engine = new WorkflowEngine(registry, deps.db, eventBus, {
    ...(deps.llm !== undefined ? { llm: deps.llm } : {}),
    ...(deps.sidecar !== undefined ? { sidecar: deps.sidecar } : {}),
    // 收尾批次 3：注入全局 ModelRouter 单例，使设置面板运行时覆盖对全部节点生效
    router: getModelRouter(),
  });

  // 崩溃恢复：读回 paused run（内存还原，之后可 workflow:resume 继续）
  void engine.recoverRuns().catch((err) => {
    console.warn('[novel-forge] recoverRuns 失败（忽略，不影响新 run）：', err);
  });

  // StreamEvent → Renderer（§4.1 流式事件）
  eventBus.on((event) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(STREAM_EVENT_CHANNEL, event);
      }
    }
  });

  const defaultWorkflow = loadDefaultWorkflowSafe();
  registerProjectIpc({ projects: repos.projects, workflows: repos.workflows, ...(defaultWorkflow !== undefined ? { defaultWorkflow } : {}) });
  registerWorkflowIpc({ engine, workflows: repos.workflows });
  // Phase 4：candidate/growth 真实实现，注入 db/llm/emit
  // （学习闭环批次：candidate 侧另注入 sidecar，供 §10.4/§10.5 Prompt Evolver 触发）
  registerCandidateIpc({
    db: deps.db,
    ...(deps.llm !== undefined ? { llm: deps.llm } : {}),
    ...(deps.sidecar !== undefined ? { sidecar: deps.sidecar } : {}),
    emit: (e) => eventBus.emit(e),
  });
  // Phase 5：style 真实实现，注入 db/sidecar/emit（import 进度经 eventBus 推流）
  registerStyleIpc({
    db: deps.db,
    ...(deps.sidecar !== undefined ? { sidecar: deps.sidecar } : {}),
    emit: (e) => eventBus.emit(e),
  });
  // Phase 6：growth 注入 sidecar（model 段 /reward/status + 缓存降级）；export 落盘 db 旁 exports/
  registerGrowthIpc({
    db: deps.db,
    ...(deps.sidecar !== undefined ? { sidecar: deps.sidecar } : {}),
  });
  registerExportIpc({ db: deps.db });
  // 收尾批次 3：设置面板（路由读/写/恢复默认 + Ollama 模型列表/拉取）
  registerSettingsIpc({
    db: deps.db,
    ...(deps.ollama !== undefined ? { ollama: deps.ollama } : {}),
    emit: (e) => eventBus.emit(e),
  });
  return { repos, engine, eventBus };
}
