/** SPEC §7.3 / §9.3 generate.paragraph-multi：plan + memory + stylePrompt → candidates[]
 *
 * 流程（§9.3）：
 * 1. 按 params.candidateCount 构建差异化策略（§9.3 温度梯度 + 风格轴，
 *    策略表见 services/candidate-strategies.ts：稳健 0.5 / 平衡 0.7 / 冒险 0.9，
 *    各配视角/节奏/对白比例轴，prompt 注入风格指令）；
 * 2. 并行调用 LLM 生成 N 个候选正文，每完成一个 emit candidate:generated；
 * 3. LLM rank 六维打分（§9.4 / §6.3 CandidateScores 六维，见 services/candidate-scoring.ts），
 *    解析失败降级为全 0.5（不阻断流程）；
 * 4. 按 avgScore（六维均值）降序；
 * 5. 候选落 candidates 表（insertMany）。
 */

import { nanoid } from 'nanoid';
import type { Candidate, ChapterPlan } from '@novel-forge/shared';
import { CandidatesRepository } from '../../db/repositories/candidates.js';
import { buildAntiPatternConstraints } from '../../growth/anti-patterns.js';
import { getModelRouter } from '../../llm/router-instance.js';
import { averageScore, rankCandidates } from '../../services/candidate-scoring.js';
import { buildStrategies, strategyDirective } from '../../services/candidate-strategies.js';
import type { CandidateStrategy } from '@novel-forge/shared';
import type { NodeDefinition, NodeContext } from '../types.js';
import type { MemoryResult } from './context-memory.js';

function buildParagraphPrompt(
  plan: ChapterPlan | undefined,
  memory: MemoryResult | undefined,
  strategy: CandidateStrategy,
  fewshot: string[],
): string {
  const sections: string[] = [];
  if (plan) {
    sections.push(
      `【本章大纲】\n标题：${plan.title}\n目标：${plan.goal}\n冲突：${plan.conflict}\n钩子：${plan.hook}\n关键节拍：${plan.keyBeats.join('；')}`,
    );
  }
  if (memory && memory.hits.length > 0) {
    sections.push(`【相关记忆】\n${memory.hits.map((h) => `- ${h.content}`).join('\n')}`);
  }
  // §11.5 L2 场景化 few-shot：风格库检索例句，仅模仿文风不得照抄内容
  if (fewshot.length > 0) {
    sections.push(
      `【文风例句】（仅供体会行文风格/节奏/语感，严禁照抄情节与文字）\n${fewshot
        .map((s, i) => `${i + 1}. ${s}`)
        .join('\n')}`,
    );
  }
  sections.push(`【写作策略】${strategy.label}${strategyDirective(strategy)}`);
  sections.push('请写出本段的正文（一个自然段，直接输出正文，不要标题或解释）。');
  return sections.join('\n\n');
}

export const generateParagraphMultiNode: NodeDefinition = {
  type: 'generate.paragraph-multi',
  title: '多候选段落生成',
  inputs: [
    { name: 'plan', dataType: 'ChapterPlan', required: true },
    { name: 'memory', dataType: 'MemoryResult' },
    { name: 'stylePrompt', dataType: 'string' },
    // required：引擎汇聚门控保证每章 style.rag-retrieve 先完成（无风格档案时该节点输出空数组）
    { name: 'fewshot', dataType: 'string[]', required: true, description: '风格库场景化例句（§11.5 L2，可为空数组）' },
  ],
  outputs: [{ name: 'candidates', dataType: 'Candidate[]' }],
  params: [
    { name: 'candidateCount', type: 'number', default: 3, description: '候选数量 N' },
    { name: 'strategyMode', type: 'select', default: 'gradient', options: ['gradient'], description: '策略模式（§9.3）' },
  ],
  async *execute(ctx, input) {
    if (!ctx.llm) throw new Error('generate.paragraph-multi 需要 LLM（NodeContext.llm 未注入）');
    const llm = ctx.llm;
    const plan = input['plan'] as ChapterPlan | undefined;
    const memory = input['memory'] as MemoryResult | undefined;
    const stylePrompt = (input['stylePrompt'] as string | undefined) ?? '你是小说作家。';
    const fewshot = Array.isArray(input['fewshot']) ? (input['fewshot'] as unknown[]).filter((s): s is string => typeof s === 'string') : [];
    const count = Math.max(1, Number(ctx.node.params['candidateCount'] ?? 3));

    // 取全局单例（ctx.router 优先）以支持设置面板运行时覆盖
    const route = (ctx.router ?? getModelRouter()).routeFor('paragraph-gen');
    const strategies = buildStrategies(count);

    // 反模式库（§10.2/验收）：高频不满意标签自动进入反模式库，影响后续生成。
    // 空串不追加，system prompt 保持原样。
    const stylePromptWithAntiPatterns = (() => {
      const constraints = buildAntiPatternConstraints(ctx.db, ctx.projectId);
      return constraints === '' ? stylePrompt : `${stylePrompt}\n\n${constraints}`;
    })();

    // 并行生成 N 个候选（温度梯度 + 风格轴差异化，§9.3，并发为硬要求）。
    // token 级流式（§15）：每策略边流边收，chunk.delta 进共享队列，
    // 外层逐个 yield 由 executor 转 workflow:node-token（多候选 token 交错属同一 nodeId，
    // 按既有 executor 机制无需额外区分）；收完的全文参与后续打分/落库。
    const tokenQueue: string[] = [];
    let wake: (() => void) | undefined;
    const wakeUp = (): void => {
      const fn = wake;
      wake = undefined;
      fn?.();
    };

    /** 消费单策略 ChatStream：delta 边收边入队，返回该候选全文 */
    const generateOne = async (strategy: CandidateStrategy): Promise<string> => {
      let text = '';
      const stream = llm.chat({
        model: route.model,
        temperature: strategy.temperature,
        messages: [
          { role: 'system', content: stylePromptWithAntiPatterns },
          { role: 'user', content: buildParagraphPrompt(plan, memory, strategy, fewshot) },
        ],
      });
      for await (const chunk of stream) {
        text += chunk.delta;
        tokenQueue.push(chunk.delta);
        wakeUp();
      }
      return text;
    };

    let texts: string[] = [];
    let genError: unknown;
    let genDone = false;
    void Promise.all(strategies.map(generateOne)).then(
      (t) => {
        texts = t;
        genDone = true;
        wakeUp();
      },
      (err: unknown) => {
        genError = err;
        genDone = true;
        wakeUp();
      },
    );

    // 排干 token 队列：生成未结束且队空时挂起等唤醒
    while (!genDone || tokenQueue.length > 0) {
      const token = tokenQueue.shift();
      if (token === undefined) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        continue;
      }
      yield token;
    }
    if (genError !== undefined) throw genError;

    // §9.4 六维打分（LLM rank 一次调用；失败降级全 0.5）
    const scoresList = await rankCandidates({ llm: ctx.llm, log: ctx.log }, texts);

    // §9.4 奖励模型预排序闭环：sidecar 奖励模型已训练（modelVersion 非空）时，
    // 用模型分覆写 rewardScore 维（训练样本来自真实偏好，比 LLM rank 更贴合用户）。
    // 未训练（null，启发式 baseline）/ sidecar 缺失 / 调用失败 / 长度不符 → 保留 LLM 分，不阻断。
    if (ctx.sidecar) {
      try {
        const reward = await ctx.sidecar.rewardScore({ texts });
        if (
          reward.modelVersion &&
          Array.isArray(reward.scores) &&
          reward.scores.length === scoresList.length
        ) {
          reward.scores.forEach((s, i) => {
            const clamped = Number.isFinite(s) ? Math.min(1, Math.max(0, s)) : scoresList[i]!.rewardScore;
            scoresList[i] = { ...scoresList[i]!, rewardScore: clamped };
          });
          ctx.log(`奖励模型 ${reward.modelVersion} 已覆写 rewardScore 维预排序分`);
        }
      } catch (err) {
        ctx.log(`奖励模型打分不可用，保留 LLM rank 分：${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const candidates: Candidate[] = texts.map((text, i) => ({
      id: nanoid(),
      runId: ctx.runId,
      nodeId: ctx.nodeId,
      index: i,
      text,
      strategy: strategies[i]!,
      scores: scoresList[i]!,
      satisfaction: 'unrated',
      generationMode: 'fresh',
      generationDepth: 0,
      lineage: [],
    }));
    candidates.sort((a, b) => averageScore(b.scores) - averageScore(a.scores));

    new CandidatesRepository(ctx.db).insertMany(candidates);
    for (const candidate of candidates) {
      ctx.emit({ type: 'candidate:generated', runId: ctx.runId, nodeId: ctx.nodeId, candidate });
    }
    ctx.log(
      `生成 ${candidates.length} 个候选（avgScore：${candidates.map((c) => averageScore(c.scores).toFixed(2)).join(', ')}）`,
    );
    return { candidates };
  },
};
