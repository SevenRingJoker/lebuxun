/** SPEC §9.4 候选六维打分：LLM rank 一次调用输出六维 JSON → CandidateScores
 *
 * 六维（§6.3 CandidateScores 枚举）：
 * pacing 节奏 / character 人物一致性 / consistency 与章节计划一致性 /
 * profileFit 用户偏好契合 / styleSimilarity 文风一致性 / rewardScore 综合质量。
 * 解析失败/形状不符降级为全 0.5（不阻断流程）。
 * avgScore = 六维均值（averageScore）。
 */

import type { CandidateScores } from '@novel-forge/shared';
import type { LLMGateway } from '../llm/gateway.js';
// 取全局单例以支持设置面板运行时覆盖
import { getModelRouter } from '../llm/router-instance.js';
import { extractJson } from '../nodes/definitions/llm-json.js';

export const SCORE_DIMS = [
  'pacing',
  'character',
  'consistency',
  'profileFit',
  'styleSimilarity',
  'rewardScore',
] as const satisfies readonly (keyof CandidateScores)[];

export const FALLBACK_SCORE = 0.5;

/** 六维均值（候选面板/谱系展示的 avgScore） */
export function averageScore(scores: CandidateScores): number {
  const sum = SCORE_DIMS.reduce((acc, dim) => acc + scores[dim], 0);
  return sum / SCORE_DIMS.length;
}

export function defaultScores(value = FALLBACK_SCORE): CandidateScores {
  return {
    pacing: value,
    character: value,
    consistency: value,
    profileFit: value,
    styleSimilarity: value,
    rewardScore: value,
  };
}

const DIM_DESCRIPTIONS = [
  'pacing: 节奏（推进速度是否得当）',
  'character: 人物一致性（言行是否符合人设）',
  'consistency: 与章节计划/上下文的一致性',
  'profileFit: 与用户偏好画像的契合度',
  'styleSimilarity: 文风一致性（与目标风格的相似程度）',
  'rewardScore: 综合质量（钩子强度、流畅度等整体印象）',
].join('\n');

export interface ScoreDeps {
  llm?: LLMGateway;
  log?: (msg: string) => void;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function parseScoresEntry(raw: unknown): CandidateScores | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;
  const out = defaultScores();
  for (const dim of SCORE_DIMS) {
    const v = obj[dim];
    if (typeof v !== 'number' || Number.isNaN(v)) return undefined;
    out[dim] = clamp01(v);
  }
  return out;
}

/**
 * LLM rank：一次调用给全部候选打六维分。
 * 期望 JSON：{"candidates": [{"pacing":0.x, ...六维...}, ...]}（长度与 texts 一致）。
 */
export async function rankCandidates(deps: ScoreDeps, texts: string[]): Promise<CandidateScores[]> {
  const fallback = texts.map(() => defaultScores());
  if (deps.llm === undefined || texts.length === 0) return fallback;
  // 服务层无 NodeContext，直接取全局单例以支持设置面板运行时覆盖
  const route = getModelRouter().routeFor('paragraph-gen');
  const numbered = texts.map((t, i) => `--- 候选 ${i + 1} ---\n${t}`).join('\n\n');
  try {
    const raw = await deps.llm.collect({
      model: route.model,
      // rank 需要确定性，覆盖路由温度
      temperature: 0,
      format: 'json',
      messages: [
        { role: 'system', content: '你是小说质量评审。只输出 JSON，不要输出其他内容。' },
        {
          role: 'user',
          content:
            `${numbered}\n\n请为每个候选按以下六个维度打 0~1 分：\n${DIM_DESCRIPTIONS}\n` +
            `输出 JSON：{"candidates": [{"pacing": 0.0, "character": 0.0, "consistency": 0.0, "profileFit": 0.0, "styleSimilarity": 0.0, "rewardScore": 0.0}, ...]}` +
            `（长度 ${texts.length}，与候选顺序一致）。`,
        },
      ],
    });
    const parsed = JSON.parse(extractJson(raw)) as { candidates?: unknown };
    if (
      Array.isArray(parsed.candidates) &&
      parsed.candidates.length === texts.length
    ) {
      const entries = parsed.candidates.map(parseScoresEntry);
      if (entries.every((e): e is CandidateScores => e !== undefined)) {
        return entries;
      }
    }
    deps.log?.('rank 响应格式不符（六维 JSON 缺失/类型错误），降级为全 0.5');
    return fallback;
  } catch (err) {
    deps.log?.(`rank 打分失败，降级为全 0.5：${err instanceof Error ? err.message : String(err)}`);
    return fallback;
  }
}
