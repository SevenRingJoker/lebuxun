/** generate.paragraph-multi 单测（Phase 4：§9.3 策略差异化 + §9.4 六维打分）
 *
 * - 4.1：N=3 时三次 chat 调用 temperature 各不相同（0.5/0.7/0.9）且 prompt 含风格轴指令
 * - 4.2：LLM rank 六维 JSON → CandidateScores 结构 + avgScore 计算 + 解析失败降级全 0.5
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Candidate, ChatRequest, ChapterPlan, RunState, StreamEvent, Workflow } from '@novel-forge/shared';
import { openDatabase, type AppDatabase } from '../../db/index.js';
import { CandidatesRepository } from '../../db/repositories/candidates.js';
import { SatisfactionTagsRepository } from '../../db/repositories/satisfaction-tags.js';
import { averageScore, defaultScores } from '../../services/candidate-scoring.js';
import { CANDIDATE_STRATEGIES } from '../../services/candidate-strategies.js';
import { executeNode } from '../../workflow/executor.js';
import { EventBus } from '../../workflow/events.js';
import { generateParagraphMultiNode } from './generate-paragraph-multi.js';
import { makeCtx, mockLlm, mockSidecar, runNode, seedProject, seedRun } from './test-helpers.js';

let db: AppDatabase;

beforeEach(async () => {
  db = await openDatabase(':memory:');
  seedProject(db);
  seedRun(db);
});

const plan: ChapterPlan = {
  title: '出山',
  goal: '引出主角',
  conflict: '宗门任务',
  hook: '山下有妖',
  estimatedParagraphs: 5,
  keyBeats: ['下山', '遇妖'],
};

function sixDim(v: number) {
  return { pacing: v, character: v, consistency: v, profileFit: v, styleSimilarity: v, rewardScore: v };
}

/** 区分生成与 rank 调用：rank prompt 含"六个维度" */
function paragraphLlm(texts: string[], rankResponse: string, capture?: ChatRequest[]) {
  return mockLlm((req) => {
    capture?.push(req);
    const user = req.messages[req.messages.length - 1]!.content;
    if (user.includes('六个维度')) return rankResponse;
    const strategy = /【写作策略】(.+?)（/.exec(user)?.[1] ?? '';
    const idx = ['稳健', '平衡', '冒险'].indexOf(strategy);
    return texts[idx >= 0 ? idx : 0]!;
  });
}

describe('generate.paragraph-multi', () => {
  it('4.1 策略差异化：N=3 温度梯度 0.5/0.7/0.9 且 prompt 含风格轴指令', async () => {
    const calls: ChatRequest[] = [];
    const llm = paragraphLlm(['稳健版', '平衡版', '冒险版'], JSON.stringify({ candidates: [sixDim(0.5), sixDim(0.5), sixDim(0.5)] }), calls);
    const { ctx } = makeCtx(db, { llm, params: { candidateCount: 3 } });

    await runNode(generateParagraphMultiNode.execute(ctx, { plan }));

    const genCalls = calls.filter((c) => !c.messages[c.messages.length - 1]!.content.includes('六个维度'));
    expect(genCalls).toHaveLength(3);
    // 温度梯度：三次调用温度各不相同
    expect(genCalls.map((c) => c.temperature)).toEqual([0.5, 0.7, 0.9]);
    // prompt 含风格轴指令（视角/节奏/对白比例）
    const prompts = genCalls.map((c) => c.messages[c.messages.length - 1]!.content);
    expect(prompts[0]).toContain('视角：内聚焦');
    expect(prompts[0]).toContain('对白比例：少');
    expect(prompts[1]).toContain('视角：外聚焦');
    expect(prompts[2]).toContain('视角：全知');
    expect(prompts[2]).toContain('对白比例：多');
    // 策略表与 SPEC §9.3 一致
    expect(CANDIDATE_STRATEGIES.map((s) => s.temperature)).toEqual([0.5, 0.7, 0.9]);
  });

  it('4.2 六维打分：scores 结构完整 + avgScore=六维均值 + 按 avgScore 降序落库', async () => {
    const llm = paragraphLlm(
      ['稳健版本正文', '平衡版本正文'],
      JSON.stringify({ candidates: [sixDim(0.4), sixDim(0.9)] }),
    );
    const { ctx, events } = makeCtx(db, { llm, params: { candidateCount: 2 } });

    const { output: out } = await runNode<{ candidates: Candidate[] }>(
      generateParagraphMultiNode.execute(ctx, { plan }),
    );
    expect(out.candidates).toHaveLength(2);
    // 按 avgScore 降序：平衡（0.9）在前
    expect(out.candidates[0]).toMatchObject({
      text: '平衡版本正文',
      strategy: { label: '平衡', temperature: 0.7 },
    });
    expect(out.candidates[0]!.scores).toEqual(sixDim(0.9));
    expect(out.candidates[0]!.scores.rewardScore).toBe(0.9);
    expect(averageScore(out.candidates[0]!.scores)).toBeCloseTo(0.9);
    expect(out.candidates[1]!.scores).toEqual(sixDim(0.4));
    // 策略带风格轴字段
    expect(out.candidates[0]!.strategy.perspective).toBe('外聚焦');
    // 落库（按 idx 顺序存储，分数与候选对应正确）
    const stored = new CandidatesRepository(db).listByRun('run-1');
    expect(stored).toHaveLength(2);
    expect(stored.find((c) => c.text === '平衡版本正文')!.scores).toEqual(sixDim(0.9));
    expect(stored.find((c) => c.text === '稳健版本正文')!.scores).toEqual(sixDim(0.4));
    // 事件
    const genEvents = events.filter((e) => e.type === 'candidate:generated');
    expect(genEvents).toHaveLength(2);
  });

  it('4.2 降级路径：rank 返回垃圾 → 六维全 0.5，候选仍正常产出', async () => {
    const llm = paragraphLlm(['A 版', 'B 版'], '评分结果：都挺好');
    const { ctx, logs } = makeCtx(db, { llm, params: { candidateCount: 2 } });
    const { output: out } = await runNode<{ candidates: Candidate[] }>(
      generateParagraphMultiNode.execute(ctx, { plan }),
    );
    expect(out.candidates).toHaveLength(2);
    expect(out.candidates.every((c) => averageScore(c.scores) === 0.5)).toBe(true);
    expect(out.candidates.every((c) => c.scores.rewardScore === 0.5)).toBe(true);
    expect(logs.some((l) => l.includes('降级为全 0.5'))).toBe(true);
  });

  it('4.2 降级路径：六维字段缺失 → 全 0.5', async () => {
    const llm = paragraphLlm(['A 版', 'B 版'], '{"candidates": [{"pacing": 0.9}, {"pacing": 0.1}]}');
    const { ctx } = makeCtx(db, { llm, params: { candidateCount: 2 } });
    const { output: out } = await runNode<{ candidates: Candidate[] }>(
      generateParagraphMultiNode.execute(ctx, { plan }),
    );
    expect(out.candidates.every((c) => averageScore(c.scores) === 0.5)).toBe(true);
  });

  // §9.4 奖励模型预排序闭环：已训练模型覆写 rewardScore 并影响排序
  it('奖励模型已训练：modelVersion 非空 → rewardScore 维被模型分覆写且按其重排序', async () => {
    const llm = paragraphLlm(['甲正文', '乙正文'], JSON.stringify({ candidates: [sixDim(0.5), sixDim(0.5)] }));
    // 甲（texts[0]）模型分 0.9，乙 0.1；其余五维保持 LLM 的 0.5
    const sidecar = mockSidecar({
      rewardScore: async (req) => {
        expect(req.texts).toEqual(['甲正文', '乙正文']);
        return { scores: [0.9, 0.1], modelVersion: 'v1' };
      },
    });
    const { ctx, logs } = makeCtx(db, { llm, sidecar, params: { candidateCount: 2 } });

    const { output: out } = await runNode<{ candidates: Candidate[] }>(
      generateParagraphMultiNode.execute(ctx, { plan }),
    );
    expect(out.candidates[0]!.text).toBe('甲正文');
    expect(out.candidates[0]!.scores.rewardScore).toBeCloseTo(0.9);
    // 其余五维仍是 LLM rank 的 0.5
    expect(out.candidates[0]!.scores.pacing).toBe(0.5);
    expect(out.candidates[1]!.scores.rewardScore).toBeCloseTo(0.1);
    expect(logs.some((l) => l.includes('奖励模型 v1 已覆写'))).toBe(true);
    // 落库分同步覆写
    const stored = new CandidatesRepository(db).listByRun('run-1');
    expect(stored.find((c) => c.text === '甲正文')!.scores.rewardScore).toBeCloseTo(0.9);
  });

  it('奖励模型未训练：modelVersion 为 null → 保留 LLM rank 分（启发式 baseline 不采信）', async () => {
    const llm = paragraphLlm(['甲正文', '乙正文'], JSON.stringify({ candidates: [sixDim(0.7), sixDim(0.4)] }));
    const sidecar = mockSidecar({
      rewardScore: async () => ({ scores: [0.1, 0.9], modelVersion: null }),
    });
    const { ctx } = makeCtx(db, { llm, sidecar, params: { candidateCount: 2 } });

    const { output: out } = await runNode<{ candidates: Candidate[] }>(
      generateParagraphMultiNode.execute(ctx, { plan }),
    );
    expect(out.candidates[0]!.text).toBe('甲正文');
    expect(out.candidates[0]!.scores).toEqual(sixDim(0.7));
    expect(out.candidates[1]!.scores).toEqual(sixDim(0.4));
  });

  it('奖励模型调用异常：保留 LLM rank 分且不阻断生成', async () => {
    const llm = paragraphLlm(['甲正文', '乙正文'], JSON.stringify({ candidates: [sixDim(0.7), sixDim(0.4)] }));
    const sidecar = mockSidecar({
      rewardScore: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    const { ctx, logs } = makeCtx(db, { llm, sidecar, params: { candidateCount: 2 } });

    const { output: out } = await runNode<{ candidates: Candidate[] }>(
      generateParagraphMultiNode.execute(ctx, { plan }),
    );
    expect(out.candidates).toHaveLength(2);
    expect(out.candidates[0]!.scores).toEqual(sixDim(0.7));
    expect(logs.some((l) => l.includes('奖励模型打分不可用'))).toBe(true);
  });

  it('averageScore/defaultScores：六维均值计算', () => {
    expect(averageScore(sixDim(0.6))).toBeCloseTo(0.6);
    expect(averageScore(defaultScores())).toBeCloseTo(0.5);
    const mixed = { pacing: 1, character: 0.5, consistency: 0.5, profileFit: 0, styleSimilarity: 0.5, rewardScore: 0.5 };
    expect(averageScore(mixed)).toBeCloseTo(0.5);
  });

  it('fewshot 注入：输入文风例句 → prompt 含【文风例句】段且标注禁止照抄', async () => {
    const calls: ChatRequest[] = [];
    const llm = paragraphLlm(['例句版甲', '例句版乙'], JSON.stringify({ candidates: [sixDim(0.5), sixDim(0.5)] }), calls);
    const { ctx } = makeCtx(db, { llm, params: { candidateCount: 2 } });

    await runNode(generateParagraphMultiNode.execute(ctx, { plan, fewshot: ['暮色四合，山风卷着松涛拍崖。', '他眯眼一笑，杯中酒晃出寒光。'] }));

    const genCalls = calls.filter((c) => !c.messages[c.messages.length - 1]!.content.includes('六个维度'));
    expect(genCalls).toHaveLength(2);
    for (const call of genCalls) {
      const user = call.messages[call.messages.length - 1]!.content;
      expect(user).toContain('【文风例句】');
      expect(user).toContain('1. 暮色四合，山风卷着松涛拍崖。');
      expect(user).toContain('严禁照抄情节与文字');
    }
  });

  it('fewshot 缺失/非数组：容错为空，不注入例句段', async () => {
    const calls: ChatRequest[] = [];
    const llm = paragraphLlm(['甲', '乙'], JSON.stringify({ candidates: [sixDim(0.5), sixDim(0.5)] }), calls);
    const { ctx } = makeCtx(db, { llm, params: { candidateCount: 2 } });

    await runNode(generateParagraphMultiNode.execute(ctx, { plan }));

    const genCalls = calls.filter((c) => !c.messages[c.messages.length - 1]!.content.includes('六个维度'));
    expect(genCalls[0]!.messages[genCalls[0]!.messages.length - 1]!.content).not.toContain('【文风例句】');
  });

  it('失败路径：无 LLM 注入抛错', async () => {
    const { ctx } = makeCtx(db, { params: { candidateCount: 2 } });
    // async generator：首次 next() 时才抛错，经 runNode 驱动断言
    await expect(runNode(generateParagraphMultiNode.execute(ctx, { plan }))).rejects.toThrow(/需要 LLM/);
  });

  // 反模式库（§10.2/验收）：高频不满意标签自动进入反模式库，影响后续生成
  it('反模式库：negative 标签 count≥2 → system prompt 追加约束段', async () => {
    const tags = new SatisfactionTagsRepository(db);
    tags.increment('p1', '节奏太快', 'negative');
    tags.increment('p1', '节奏太快', 'negative');
    const calls: ChatRequest[] = [];
    const llm = paragraphLlm(['A', 'B'], JSON.stringify({ candidates: [sixDim(0.5), sixDim(0.5)] }), calls);
    const { ctx } = makeCtx(db, { llm, params: { candidateCount: 2 } });

    await runNode(generateParagraphMultiNode.execute(ctx, { plan }));

    const genCalls = calls.filter((c) => !c.messages[c.messages.length - 1]!.content.includes('六个维度'));
    for (const call of genCalls) {
      const system = call.messages[0]!.content;
      expect(system).toContain('以下问题被用户多次标记为不满意，生成时务必避免：');
      expect(system).toContain('- 节奏太快（出现 2 次）');
    }
  });

  it('反模式库：无达标 negative 标签 → system prompt 不追加约束段', async () => {
    const calls: ChatRequest[] = [];
    const llm = paragraphLlm(['A', 'B'], JSON.stringify({ candidates: [sixDim(0.5), sixDim(0.5)] }), calls);
    const { ctx } = makeCtx(db, { llm, params: { candidateCount: 2 } });

    await runNode(generateParagraphMultiNode.execute(ctx, { plan }));

    const genCalls = calls.filter((c) => !c.messages[c.messages.length - 1]!.content.includes('六个维度'));
    expect(genCalls.length).toBeGreaterThan(0);
    for (const call of genCalls) {
      expect(call.messages[0]!.content).not.toContain('务必避免');
    }
  });

  // token 级流式（§15「流式生成不卡 UI」）：execute 改 async generator 后，
  // 每个 chunk.delta 经 executor 转 workflow:node-token，最终 return 的 candidates 与拼接一致
  it('token 流式：executeNode 产出 node-token 事件，return candidates 与 delta 拼接一致', async () => {
    const llm = paragraphLlm(
      ['甲乙丙', '丁戊'],
      JSON.stringify({ candidates: [sixDim(0.6), sixDim(0.4)] }),
    );
    const { ctx } = makeCtx(db, { llm, params: { candidateCount: 2 } });
    const bus = new EventBus();
    const events: StreamEvent[] = [];
    bus.on((e) => events.push(e));
    const workflow = {
      nodes: [{ id: 'node-1', type: 'generate.paragraph-multi', position: { x: 0, y: 0 }, params: {} }],
      edges: [],
    } as unknown as Workflow;
    const run: RunState = {
      runId: 'run-1',
      workflowId: 'wf-run-1',
      status: 'running',
      outputs: {},
      context: { projectId: 'p1', accumulatedParagraphs: [] },
    };

    const output = await executeNode({ ctx, def: generateParagraphMultiNode, workflow, run, eventBus: bus });

    // 事件序列：node-start → node-token×5（两候选 delta 交错，同属 node-1）→ 收尾
    const tokenEvents = events.filter(
      (e): e is Extract<StreamEvent, { type: 'workflow:node-token' }> => e.type === 'workflow:node-token',
    );
    expect(tokenEvents).toHaveLength(5);
    expect(tokenEvents.every((e) => e.nodeId === 'node-1' && e.runId === 'run-1')).toBe(true);
    // delta 拼接（多重集）与两候选全文一致
    const joined = tokenEvents.map((e) => e.token).join('');
    expect(joined.split('').sort().join('')).toBe('甲乙丙丁戊'.split('').sort().join(''));

    // return 值即节点输出：candidates 结构不变，文本与流式收齐的全文一致
    const candidates = output['candidates'] as Candidate[];
    expect(candidates).toHaveLength(2);
    expect(candidates.map((c) => c.text).sort()).toEqual(['丁戊', '甲乙丙']);
    expect(run.outputs['node-1']).toBe(output);
  });

  it('token 流式：runNode 直接驱动 generator，tokens 与候选全文一致', async () => {
    const llm = paragraphLlm(['流式甲', '流式乙'], JSON.stringify({ candidates: [sixDim(0.5), sixDim(0.5)] }));
    const { ctx } = makeCtx(db, { llm, params: { candidateCount: 2 } });

    const { output, tokens } = await runNode<{ candidates: Candidate[] }>(
      generateParagraphMultiNode.execute(ctx, { plan }),
    );

    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.join('').split('').sort().join('')).toBe('流式甲流式乙'.split('').sort().join(''));
    expect(output.candidates.map((c) => c.text).sort()).toEqual(['流式乙', '流式甲']);
  });
});
