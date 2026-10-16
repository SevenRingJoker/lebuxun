/** SPEC §7.3 style.rag-retrieve：plan → fewshot[]（+ plan 透传）
 *
 * 场景分类（sidecar /scene/classify）+ 风格库向量检索（/rag/query）取 topK 例句。
 * 无 styleId（params 或最近风格档案均缺）/ sidecar 不可用 / 任一步失败 → fewshot=[]
 * 并 log warn（降级不炸，不阻断主流程）。
 *
 * main-loop 中该节点是章级同步点：plan 只入边到本节点，再由本节点透传 plan、
 * 与 fewshot 一同扇出给生成节点，保证两者同代际（避免生成节点先读到上一章旧 fewshot）。
 */

import type { ChapterPlan } from '@novel-forge/shared';
import { StylesRepository } from '../../db/repositories/styles.js';
import type { NodeDefinition } from '../types.js';

/** plan 文本化：ChapterPlan 拼关键字段；字符串直接用 */
function planToText(plan: unknown): string {
  if (typeof plan === 'string') return plan;
  if (plan !== null && typeof plan === 'object') {
    const p = plan as Partial<ChapterPlan>;
    return [p.title, p.goal, p.conflict, p.hook, ...(p.keyBeats ?? [])]
      .filter((s): s is string => typeof s === 'string' && s !== '')
      .join('\n');
  }
  return '';
}

export const styleRagRetrieveNode: NodeDefinition = {
  type: 'style.rag-retrieve',
  title: '风格检索',
  inputs: [{ name: 'plan', dataType: 'ChapterPlan', required: true }],
  outputs: [
    { name: 'fewshot', dataType: 'string[]' },
    // 透传 plan：使本节点成为章级 plan/fewshot 同步点（main-loop 扇出给 gen）
    { name: 'plan', dataType: 'ChapterPlan' },
  ],
  params: [
    { name: 'styleId', type: 'string', default: '', description: '风格档案 id（空则取最近更新一条）' },
    { name: 'topK', type: 'number', default: 3, description: '检索例句条数' },
  ],
  async execute(ctx, input) {
    const plan = input['plan'];
    const text = planToText(plan);
    const topK = Math.max(1, Number(ctx.node.params['topK'] ?? 3));

    const paramStyleId = String(ctx.node.params['styleId'] ?? '');
    const styleId =
      paramStyleId !== '' ? paramStyleId : (new StylesRepository(ctx.db).latestProfile()?.id ?? '');
    if (styleId === '' || !ctx.sidecar) {
      if (styleId === '') ctx.log('无风格档案，跳过风格检索');
      return { fewshot: [] as string[], plan };
    }

    try {
      const scene = await ctx.sidecar.sceneClassify({ text });
      const res = await ctx.sidecar.ragQuery({
        styleId,
        query: text,
        sceneType: scene.sceneType,
        topK,
      });
      const fewshot = res.results.map((r) => r.text);
      ctx.log(`风格检索：场景 ${scene.sceneType}，命中 ${fewshot.length} 条`);
      return { fewshot, plan };
    } catch (err) {
      ctx.log(`风格检索失败，降级为空例句：${err instanceof Error ? err.message : String(err)}`);
      return { fewshot: [] as string[], plan };
    }
  },
};
