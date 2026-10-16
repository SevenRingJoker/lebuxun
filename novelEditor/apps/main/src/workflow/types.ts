/** 工作流引擎内部类型（SPEC §3 workflow/types.ts）
 *
 * RunState 本体在 shared（§6.6）；这里只放引擎持久化/挂起相关的补全结构。
 */

import type { RunState } from '@novel-forge/shared';

/** 挂起信息：pause 节点挂起（带面板 payload）或 requestPause 优雅挂起 */
export interface PausedNodeInfo {
  /** node=人工节点暂停（等 resume 注入 userAction）；requested=requestPause 在节点边界挂起 */
  kind: 'node' | 'requested';
  nodeId: string;
  /** kind === 'node' 时为 pause 节点 execute 的产出（发给 Renderer 的面板数据） */
  payload?: unknown;
}

/** runs 表 state 列的 JSON 结构（outputs + context + 挂起信息 + 错误信息） */
export interface PersistedRunState {
  outputs: RunState['outputs'];
  context: RunState['context'];
  pause?: PausedNodeInfo;
  error?: string;
}
