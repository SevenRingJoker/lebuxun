/** workflow 域 IPC（SPEC §4.1）：Phase 2 真实实现，替换 Phase 1 stub
 *
 * - workflow:load   读 workflows 表（不存在返回 404 错误串）
 * - workflow:run    engine.start（Promise 在 run 到达 done/error/paused 时兑现）
 * - workflow:pause  engine.requestPause（当前节点完成后优雅挂起）
 * - workflow:resume engine.resume（注入 userAction 继续推进）
 * - workflow:stop   engine.stop（协作式中断）
 */

import { ipcMain } from 'electron';
import type {
  WorkflowLoadReq,
  WorkflowLoadRes,
  WorkflowPauseReq,
  WorkflowPauseRes,
  WorkflowResumeReq,
  WorkflowResumeRes,
  WorkflowRunReq,
  WorkflowRunRes,
  WorkflowStopReq,
  WorkflowStopRes,
} from '@novel-forge/shared';
import type { WorkflowsRepository } from '../db/repositories/workflows.js';
import type { WorkflowEngine } from '../workflow/engine.js';

export interface WorkflowIpcDeps {
  engine: WorkflowEngine;
  workflows: WorkflowsRepository;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function registerWorkflowIpc(deps: WorkflowIpcDeps): void {
  ipcMain.handle('workflow:load', async (_event, req: WorkflowLoadReq): Promise<WorkflowLoadRes> => {
    try {
      const workflow = deps.workflows.get(req.workflowId);
      if (!workflow || workflow.projectId !== req.projectId) {
        return { ok: false, error: `404 workflow 不存在: ${req.workflowId}` };
      }
      return { ok: true, workflow };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  });

  ipcMain.handle('workflow:run', async (_event, req: WorkflowRunReq): Promise<WorkflowRunRes> => {
    try {
      const { runId, status } = await deps.engine.start({
        projectId: req.projectId,
        workflowId: req.workflowId,
        ...(req.fromNodeId !== undefined ? { fromNodeId: req.fromNodeId } : {}),
      });
      return { ok: true, runId, status };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  });

  ipcMain.handle('workflow:pause', async (_event, req: WorkflowPauseReq): Promise<WorkflowPauseRes> => {
    try {
      deps.engine.requestPause(req.runId);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  });

  ipcMain.handle('workflow:resume', async (_event, req: WorkflowResumeReq): Promise<WorkflowResumeRes> => {
    try {
      const status = await deps.engine.resume({
        runId: req.runId,
        nodeId: req.nodeId,
        userAction: req.userAction,
      });
      return { ok: true, status };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  });

  ipcMain.handle('workflow:stop', async (_event, req: WorkflowStopReq): Promise<WorkflowStopRes> => {
    try {
      await deps.engine.stop(req.runId);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  });
}
