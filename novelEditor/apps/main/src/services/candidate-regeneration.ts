/** SPEC §9.4 定向重生成：improve / variant / similar 三种模式复用入口
 *
 * improve：保留原段骨架，prompt 带「在保持情节不变的前提下改进以下方面：reasonTags」重新生成 1 个候选。
 * variant：同段落设定下换风格轴重新生成（§9.3 策略表取不同轴），默认 3 个。
 * similar（regenerate-similar）：相同风格、节奏、氛围，内容和表达不同，count 由调用方决定。
 * 公共：parent_candidate_id = 原候选，generationDepth+1，谱系追加，写入 candidate_lineage 表。
 */

import { nanoid } from 'nanoid';
import type { Candidate, StreamEvent } from '@novel-forge/shared';
import type { AppDatabase } from '../db/index.js';
import { CandidatesRepository } from '../db/repositories/candidates.js';
import {
  DEFAULT_IMPROVE_SYSTEM_PROMPT,
  buildImproveSystemPrompt,
  resolveRunProjectId,
} from '../growth/prompt-evolution.js';
import type { LLMGateway } from '../llm/gateway.js';
// 服务层无 NodeContext，直接取全局单例以支持设置面板运行时覆盖
import { getModelRouter } from '../llm/router-instance.js';
import { defaultScores, rankCandidates } from './candidate-scoring.js';
import { pickVariantStrategy, strategyDirective } from './candidate-strategies.js';

export interface RegenerateDeps {
  db: AppDatabase;
  llm: LLMGateway;
  runId: string;
  nodeId: string;
  emit: (event: StreamEvent) => void;
  log: (msg: string) => void;
}

async function persistAndEmit(
  deps: RegenerateDeps,
  repo: CandidatesRepository,
  candidates: Candidate[],
  lineage: { parentId: string; mode: 'improve' | 'variant'; hint?: string },
) {
  repo.insertMany(candidates);
  for (const c of candidates) {
    deps.emit({ type: 'candidate:generated', runId: deps.runId, nodeId: deps.nodeId, candidate: c });
  }
  // candidate_lineage（§5.1）
  deps.db
    .prepare(
      `INSERT INTO candidate_lineage (id, parent_id, child_ids, mode, hint, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      nanoid(),
      lineage.parentId,
      JSON.stringify(candidates.map((c) => c.id)),
      lineage.mode,
      lineage.hint ?? null,
      Date.now(),
    );
}

/** improve / variant（§9.4.2 regenerateFrom） */
export async function regenerateFromCandidate(
  deps: RegenerateDeps,
  opts: { candidateId: string; mode: 'improve' | 'variant'; hint?: string },
): Promise<Candidate[]> {
  const repo = new CandidatesRepository(deps.db);
  const parent = repo.get(opts.candidateId);
  if (!parent) throw new Error(`父候选不存在: ${opts.candidateId}`);

  // 服务层无 NodeContext，直接取全局单例以支持设置面板运行时覆盖
  const route = getModelRouter().routeFor('paragraph-gen');
  const count = opts.mode === 'improve' ? 1 : 3;
  const newCandidates: Candidate[] = [];

  // 反模式库（§10.2/验收）+ §10.5 Prompt Evolver 产物消费点：
  // improve 模式系统提示词优先用 prompt_versions 中 project+node_type='improve' 的最新版本
  //（在其后仍追加反模式段），无演化产物时回退缺省；查询为单行 SQL，轻量。
  let improveSystemPrompt: string | undefined;
  if (opts.mode === 'improve') {
    const projectId = resolveRunProjectId(deps.db, deps.runId);
    improveSystemPrompt = projectId ? buildImproveSystemPrompt(deps.db, projectId) : DEFAULT_IMPROVE_SYSTEM_PROMPT;
  }

  for (let i = 0; i < count; i++) {
    const strategy = opts.mode === 'improve' ? parent.strategy : pickVariantStrategy(parent.strategy, i);
    const temp = opts.mode === 'improve' ? 0.5 : 0.8;

    let userPrompt: string;
    if (opts.mode === 'improve') {
      const tagsText =
        parent.satisfactionTags && parent.satisfactionTags.length > 0
          ? `在保持情节不变的前提下改进以下方面：${parent.satisfactionTags.join('、')}`
          : opts.hint ?? '请改进这个候选的不足，保持其他优点。';
      userPrompt = `原候选：\n${parent.text}\n\n改进要求：\n${tagsText}`;
    } else {
      // variant：换风格轴重新生成
      userPrompt =
        `参考候选：\n${parent.text}\n\n` +
        `请换一种写作风格重新生成同一段落：${strategyDirective(strategy)}`;
    }

    const text = await deps.llm.collect({
      model: route.model,
      temperature: temp,
      messages: [
        { role: 'system', content: improveSystemPrompt ?? '你是小说作家。' },
        { role: 'user', content: userPrompt },
      ],
    });

    const scores = (await rankCandidates({ llm: deps.llm, log: deps.log }, [text]))[0] ?? defaultScores();

    const candidate: Candidate = {
      id: nanoid(),
      runId: deps.runId,
      nodeId: deps.nodeId,
      index: repo.nextIndex(deps.runId, deps.nodeId) + i,
      text,
      strategy: { ...strategy, label: `${parent.strategy.label}+` },
      scores,
      satisfaction: 'unrated',
      generationMode: opts.mode,
      generationDepth: parent.generationDepth + 1,
      lineage: [...parent.lineage, parent.id],
      parentCandidateId: parent.id,
    };
    newCandidates.push(candidate);
  }

  await persistAndEmit(deps, repo, newCandidates, {
    parentId: parent.id,
    mode: opts.mode,
    ...(opts.hint !== undefined ? { hint: opts.hint } : {}),
  });
  deps.log(
    `${opts.mode} 重生成 ${newCandidates.length} 个候选（parent=${parent.id}，depth=${parent.generationDepth + 1}）`,
  );
  return newCandidates;
}

/** similar 模式（§9.4.3 regenerateSimilar） */
export async function regenerateSimilarCandidates(
  deps: RegenerateDeps,
  opts: { candidateId: string; count: number },
): Promise<Candidate[]> {
  const repo = new CandidatesRepository(deps.db);
  const seed = repo.get(opts.candidateId);
  if (!seed) throw new Error(`种子候选不存在: ${opts.candidateId}`);

  // 服务层无 NodeContext，直接取全局单例以支持设置面板运行时覆盖
  const route = getModelRouter().routeFor('paragraph-gen');
  const newCandidates: Candidate[] = [];

  for (let i = 0; i < opts.count; i++) {
    const text = await deps.llm.collect({
      model: route.model,
      temperature: 0.75 + i * 0.05,
      messages: [
        { role: 'system', content: '你是小说作家。' },
        {
          role: 'user',
          content:
            `以下是用户满意的段落：\n\n${seed.text}\n\n` +
            `请生成一个保持相同风格、节奏、氛围，但内容和表达不同的新版本。`,
        },
      ],
    });

    const scores = (await rankCandidates({ llm: deps.llm, log: deps.log }, [text]))[0] ?? defaultScores();

    const candidate: Candidate = {
      id: nanoid(),
      runId: deps.runId,
      nodeId: deps.nodeId,
      index: repo.nextIndex(deps.runId, deps.nodeId) + i,
      text,
      strategy: { ...seed.strategy, label: `${seed.strategy.label}·相似${i + 1}` },
      scores,
      satisfaction: 'unrated',
      generationMode: 'variant',
      generationDepth: seed.generationDepth + 1,
      lineage: [...seed.lineage, seed.id],
      parentCandidateId: seed.id,
    };
    newCandidates.push(candidate);
  }

  await persistAndEmit(deps, repo, newCandidates, { parentId: seed.id, mode: 'variant' });
  deps.log(
    `similar 重生成 ${newCandidates.length} 个候选（seed=${seed.id}，depth=${seed.generationDepth + 1}）`,
  );
  return newCandidates;
}
