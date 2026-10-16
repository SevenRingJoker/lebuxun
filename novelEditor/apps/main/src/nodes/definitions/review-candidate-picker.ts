/** SPEC §7.3 / §9.2 review.candidate-picker（pause 节点）：candidates[] → selected
 *
 * execute：透传候选作为面板 payload，引擎随后挂起并发 workflow:node-paused。
 * onResume：按 UserAction 映射最终输出（§6.3）——
 * - select（可带 editedText 改后选）：输出 selected: Candidate，DB 标记 selected=1
 * - satisfy / dissatisfy / unmark：更新 candidates 满意度标记，selected=null
 *   （面板停留期间标记走 candidate:* IPC；resume 携带时此处兜底持久化）
 * - reject-all：selected=null + rejected 信号（条件边可导回 generate.paragraph-multi）
 * - regenerate-from / regenerate-similar：调用 services/candidate-regeneration.ts 定向重生成
 *   （improve/variant，新候选落库 + emit candidate:generated），输出 selected=null + regenerate 信号
 * - mix（收尾批次 4 落实，SPEC §15「混合选」）：composeMixText 句级合并多候选片段，
 *   输出 selected={ text, mode:'mix', sources }（形状与 select 对齐）
 */

import type { Candidate } from '@novel-forge/shared';
import { CandidatesRepository } from '../../db/repositories/candidates.js';
import { composeMixText } from '../../services/candidate-mix.js';
import {
  regenerateFromCandidate,
  regenerateSimilarCandidates,
} from '../../services/candidate-regeneration.js';
import type { NodeDefinition } from '../types.js';

interface PickerPayload {
  candidates: Candidate[];
}

export const reviewCandidatePickerNode: NodeDefinition = {
  type: 'review.candidate-picker',
  title: '候选选择面板',
  inputs: [{ name: 'candidates', dataType: 'Candidate[]', required: true }],
  outputs: [{ name: 'selected', dataType: 'Candidate | null' }],
  params: [],
  pause: true,
  async execute(_ctx, input): Promise<PickerPayload> {
    const candidates = (input['candidates'] as Candidate[] | undefined) ?? [];
    return { candidates };
  },
  async onResume(ctx, userAction, pausedPayload) {
    const payload = (pausedPayload ?? { candidates: [] }) as PickerPayload;
    const repo = new CandidatesRepository(ctx.db);

    switch (userAction.type) {
      case 'select': {
        const found = payload.candidates.find((c) => c.id === userAction.candidateId);
        if (!found) {
          throw new Error(`候选不存在: ${userAction.candidateId}`);
        }
        // 改后选：以用户编辑文本为准（editedText 不回写候选行，选中段落以新文本入章）
        const selected: Candidate =
          userAction.editedText != null ? { ...found, text: userAction.editedText } : found;
        repo.markSelected(found.id);
        ctx.log(`选中候选 ${found.id}（${found.strategy.label}）`);
        return { selected };
      }
      case 'satisfy':
        repo.setSatisfaction(userAction.candidateId, 'satisfied');
        return { selected: null, marked: userAction.candidateId };
      case 'dissatisfy':
        repo.setSatisfaction(
          userAction.candidateId,
          'unsatisfied',
          userAction.reason,
          userAction.reasonTags,
        );
        return { selected: null, marked: userAction.candidateId };
      case 'unmark':
        repo.setSatisfaction(userAction.candidateId, 'unrated');
        return { selected: null, marked: userAction.candidateId };
      case 'reject-all':
        ctx.log(`全部候选被弃用${userAction.reason != null ? `：${userAction.reason}` : ''}`);
        return { selected: null, rejected: true };
      case 'regenerate-from': {
        // Phase 4：同一重生成逻辑（services/candidate-regeneration.ts），新候选落库 + 事件
        if (!ctx.llm) throw new Error('regenerate-from 需要 LLM（NodeContext.llm 未注入）');
        const created = await regenerateFromCandidate(
          { db: ctx.db, llm: ctx.llm, runId: ctx.runId, nodeId: ctx.nodeId, emit: ctx.emit, log: ctx.log },
          {
            candidateId: userAction.candidateId,
            mode: userAction.mode,
            ...(userAction.hint !== undefined ? { hint: userAction.hint } : {}),
          },
        );
        return { selected: null, regenerate: userAction, newCandidateIds: created.map((c) => c.id) };
      }
      case 'regenerate-similar': {
        if (!ctx.llm) throw new Error('regenerate-similar 需要 LLM（NodeContext.llm 未注入）');
        const created = await regenerateSimilarCandidates(
          { db: ctx.db, llm: ctx.llm, runId: ctx.runId, nodeId: ctx.nodeId, emit: ctx.emit, log: ctx.log },
          { candidateId: userAction.candidateId, count: userAction.count },
        );
        return { selected: null, regenerate: userAction, newCandidateIds: created.map((c) => c.id) };
      }
      case 'mix': {
        // SPEC §15「混合选」：句级合并（services/candidate-mix.ts，越界/空片段容错），
        // 合并文本作为 selected 段落输出，形状与 select 分支对齐（下游 chapter.accumulator 只取 selected.text）
        const text = composeMixText(ctx.db, userAction.sources);
        ctx.log(`混合选合并 ${userAction.sources.length} 个来源片段（${text.length} 字）`);
        return { selected: { text, mode: 'mix', sources: userAction.sources } };
      }
      default:
        // add-candidates / prune-unsatisfied 等 Phase 4 动作：透传合并
        return { ...payload, selected: null, action: userAction };
    }
  },
};
