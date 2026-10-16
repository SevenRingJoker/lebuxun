/** SPEC §7.3 style.discriminator：candidates[] → scored[]
 *
 * 对每个候选调 sidecar /discriminator/score，写回 scores.styleSimilarity 并落库
 * （CandidatesRepository.updateScores）；单个候选打分失败原样保留（降级），
 * 无 styleId（params 或最近风格档案均缺）/ sidecar 不可用 → 全部原样透传。
 * 输出键名 scored（与 main-loop.json e9 边一致）。
 */

import type { Candidate } from '@novel-forge/shared';
import { CandidatesRepository } from '../../db/repositories/candidates.js';
import { StylesRepository } from '../../db/repositories/styles.js';
import type { NodeDefinition } from '../types.js';

export const styleDiscriminatorNode: NodeDefinition = {
  type: 'style.discriminator',
  title: '风格判别',
  inputs: [{ name: 'candidates', dataType: 'Candidate[]', required: true }],
  outputs: [{ name: 'scored', dataType: 'Candidate[]' }],
  params: [
    { name: 'styleId', type: 'string', default: '', description: '风格档案 id（空则取最近更新一条）' },
  ],
  async execute(ctx, input) {
    const candidates = (input['candidates'] as Candidate[] | undefined) ?? [];

    const paramStyleId = String(ctx.node.params['styleId'] ?? '');
    const styleId =
      paramStyleId !== '' ? paramStyleId : (new StylesRepository(ctx.db).latestProfile()?.id ?? '');
    if (styleId === '' || !ctx.sidecar || candidates.length === 0) {
      if (styleId === '') ctx.log('无风格档案，风格判别透传');
      return { scored: candidates };
    }

    const repo = new CandidatesRepository(ctx.db);
    const scored: Candidate[] = [];
    for (const candidate of candidates) {
      try {
        const res = await ctx.sidecar.discriminatorScore({ styleId, text: candidate.text });
        const updated: Candidate = {
          ...candidate,
          scores: { ...candidate.scores, styleSimilarity: res.score },
        };
        repo.updateScores(candidate.id, updated.scores);
        scored.push(updated);
      } catch (err) {
        ctx.log(
          `候选 ${candidate.id} 风格判别失败，保留原分：${err instanceof Error ? err.message : String(err)}`,
        );
        scored.push(candidate);
      }
    }
    ctx.log(
      `风格判别：${scored.length} 个候选（styleSimilarity：${scored.map((c) => c.scores.styleSimilarity.toFixed(2)).join(', ')}）`,
    );
    return { scored };
  },
};
