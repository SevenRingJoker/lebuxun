/** SPEC §9.3 候选策略差异化：温度梯度 + 风格轴（视角/节奏/对白比例）
 *
 * N 个候选各自不同策略；N > 3 时循环取值。策略表为常量（§9.3 表）：
 * 稳健 0.5 / 平衡 0.7 / 冒险 0.9，各配不同风格轴，prompt 注入风格指令。
 * generate.paragraph-multi 与定向重生成（variant 换轴）共用。
 */

import type { CandidateStrategy } from '@novel-forge/shared';

/** §9.3 差异化策略表 */
export const CANDIDATE_STRATEGIES: readonly CandidateStrategy[] = [
  { label: '稳健', temperature: 0.5, perspective: '内聚焦', pacing: '快', dialogueRatio: '少' },
  { label: '平衡', temperature: 0.7, perspective: '外聚焦', pacing: '中', dialogueRatio: '中' },
  { label: '冒险', temperature: 0.9, perspective: '全知', pacing: '慢', dialogueRatio: '多' },
];

/** 取 count 个差异化策略（循环取值，保证相邻候选策略不同） */
export function buildStrategies(count: number): CandidateStrategy[] {
  return Array.from({ length: count }, (_, i) => ({
    ...CANDIDATE_STRATEGIES[i % CANDIDATE_STRATEGIES.length]!,
  }));
}

/** variant 模式换风格轴：选一个与父候选不同的策略（§9.3 风格轴变体） */
export function pickVariantStrategy(parent: CandidateStrategy, offset = 0): CandidateStrategy {
  const idx = CANDIDATE_STRATEGIES.findIndex((s) => s.label === parent.label);
  const next = CANDIDATE_STRATEGIES[(idx + 1 + offset) % CANDIDATE_STRATEGIES.length]!;
  return { ...next };
}

/** 风格轴指令文本（注入生成 prompt） */
export function strategyDirective(strategy: CandidateStrategy): string {
  const axes: string[] = [];
  if (strategy.perspective !== undefined) axes.push(`视角：${strategy.perspective}`);
  if (strategy.pacing !== undefined) axes.push(`节奏：${strategy.pacing}`);
  if (strategy.dialogueRatio !== undefined) axes.push(`对白比例：${strategy.dialogueRatio}`);
  return axes.length > 0 ? `（${axes.join('；')}）` : '';
}
