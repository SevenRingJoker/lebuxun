/** pause 节点处理（SPEC §7.1 步骤 4、§9.2 段落循环场景）
 *
 * 挂起语义：引擎执行完 pause 节点 → 持久化 RunState（status=paused + 挂起信息）
 * → 发 workflow:node-paused → 驱动循环返回（run 挂起，直到 resume 重新驱动）。
 * 挂起信息同时落库（runs.state JSON），进程崩溃后 recoverRuns 可还原继续 resume。
 */

import type { UserAction } from '@novel-forge/shared';
import type { NodeContext, NodeDefinition } from '../nodes/types.js';
import { normalizeOutput } from './executor.js';

/**
 * resume 时把 userAction 映射为 pause 节点的最终输出。
 * 节点定义了 onResume 则用节点自己的映射（如 review.candidate-picker 输出 selected）；
 * 缺省合并：暂停 payload 与 userAction 字段平铺合并（§9.2 decision 分支场景可用）。
 */
export async function resolveResumeOutput(
  def: NodeDefinition,
  ctx: NodeContext,
  userAction: UserAction,
  pausedPayload: unknown,
): Promise<Record<string, unknown>> {
  if (def.onResume) {
    return normalizeOutput(await def.onResume(ctx, userAction, pausedPayload));
  }
  const base = normalizeOutput(pausedPayload);
  return { ...base, ...(userAction as Record<string, unknown>) };
}
