/** SPEC §10.4/§10.5 Evolution Learner + Prompt Evolver（学习闭环批次）
 *
 * 数据链：candidate IPC 记录 evolution_patterns（selected/rejected）→
 * 累计达阈值后把最近 pattern 映射为伪偏好样本调 sidecar /evolution/extract-templates →
 * 模板非空再调 /evolution/prompt-templates 生成新版 improve 提示词 → 落 prompt_versions。
 * 消费点：improve 再生成（services/candidate-regeneration.ts）取 prompt_versions 最新版。
 * 整条 sidecar 链 fire-and-forget：不阻塞 IPC 响应，sidecar 不可用时 warn 跳过。
 */

import type { SidecarClient, SidecarPreferenceSample } from '../sidecar/client.js';
import { EvolutionPatternsRepository, type EvolutionPattern } from '../db/repositories/evolution-patterns.js';
import { PromptVersionsRepository } from '../db/repositories/prompt-versions.js';
import { appendAntiPattern, buildAntiPatternConstraints } from './anti-patterns.js';
import type { AppDatabase } from '../db/index.js';

/** 触发模板提炼的最小 pattern 数（对齐 sidecar extract-templates 的最小样本量 30） */
export const EVOLUTION_TEMPLATE_THRESHOLD = 30;

/** 每次提炼取最近多少条 pattern 组伪偏好样本（对齐 sidecar 训练窗口口径） */
export const EVOLUTION_REFINE_SAMPLE_LIMIT = 100;

/** improve 再生成的缺省系统提示词（无演化模板时的回退，与原实现一致） */
export const DEFAULT_IMPROVE_SYSTEM_PROMPT = '你是小说作家。';

/** prompt_versions.node_type 取值：improve 再生成消费的演化提示词类型 */
export const IMPROVE_NODE_TYPE = 'improve';

/** run → project 解析（candidates/lineage 只挂 run，反模式与提示词都按项目聚合） */
export function resolveRunProjectId(db: AppDatabase, runId: string): string | undefined {
  const row = db
    .prepare(
      `SELECT w.project_id AS projectId
       FROM runs r JOIN workflows w ON w.id = r.workflow_id
       WHERE r.id = ?`,
    )
    .get(runId) as { projectId: string } | undefined;
  return row?.projectId;
}

/** §10.5 Prompt Evolver 产物消费点：improve 系统提示词 = prompt_versions 最新版（无则缺省） */
export function getLatestImprovePrompt(db: AppDatabase, projectId: string): string {
  const latest = new PromptVersionsRepository(db).latestFor(projectId, IMPROVE_NODE_TYPE);
  return latest?.content ?? DEFAULT_IMPROVE_SYSTEM_PROMPT;
}

/** improve 再生成的完整系统提示词：演化模板（或缺省）+ 反模式库约束（§10.2/验收） */
export function buildImproveSystemPrompt(db: AppDatabase, projectId: string): string {
  const base = getLatestImprovePrompt(db, projectId);
  return appendAntiPattern(base, buildAntiPatternConstraints(db, projectId));
}

/** pattern → 伪偏好样本（sidecar 偏好样本形状，reasons 置空：反模式信号已由标签库承担）
 *
 * 口径（PENDING 登记）：selected 行 chosen=改进后 childText、rejected=原 parentText；
 * rejected 行语义相反（用户否决了全部改进、保留原文），故 chosen=parentText、
 * rejected=child_texts 逐条展开，保证样本方向与用户决策一致。
 */
export function patternsToPseudoSamples(
  patterns: EvolutionPattern[],
  projectId: string,
): SidecarPreferenceSample[] {
  const samples: SidecarPreferenceSample[] = [];
  for (const p of patterns) {
    const context = p.hint != null && p.hint !== '' ? p.hint : p.mode;
    if (p.outcome === 'selected' && p.childText != null) {
      samples.push({ projectId, context, chosen: p.childText, rejected: p.parentText, reasons: [] });
    } else if (p.outcome === 'rejected' && p.childTexts != null) {
      for (const rejected of p.childTexts) {
        samples.push({ projectId, context, chosen: p.parentText, rejected, reasons: [] });
      }
    }
  }
  return samples;
}

export interface ImproveEvolutionDeps {
  db: AppDatabase;
  sidecar?: SidecarClient;
  /** 缺省 console.warn（IPC 层 fire-and-forget，失败只留痕不抛） */
  log?: (msg: string) => void;
}

/** §10.5 refineImprovePrompt：pattern → 伪样本 → 提模板 → 生成新 improve 提示词 → 落库 */
export async function refineImprovePrompt(deps: ImproveEvolutionDeps, projectId: string): Promise<void> {
  const { db, sidecar } = deps;
  if (!sidecar) return;
  const warn = deps.log ?? ((msg: string) => console.warn(`[novel-forge] ${msg}`));
  const patterns = new EvolutionPatternsRepository(db).findRecent(
    projectId,
    EVOLUTION_REFINE_SAMPLE_LIMIT,
  );
  const samples = patternsToPseudoSamples(patterns, projectId);
  if (samples.length === 0) return;

  const extracted = await sidecar.extractTemplates({ samples });
  if (extracted.templates.length === 0) {
    warn(`演化模板提炼无产出：${extracted.message ?? '样本不足'}`);
    return;
  }

  // 基础提示词取当前生效的 improve 提示词（可能是上一代演化产物），sidecar 在其上迭代
  const baseTemplate = getLatestImprovePrompt(db, projectId);
  const created = await sidecar.createPromptTemplate({
    nodeType: IMPROVE_NODE_TYPE,
    baseTemplate,
    projectId,
  });
  const repo = new PromptVersionsRepository(db);
  repo.insert({
    projectId,
    nodeType: created.nodeType,
    content: created.content,
    version: created.version,
    parentVersion: created.parentVersion,
    basedOn: created.basedOn,
  });
}

/** 记录 pattern 后的阈值检查 + 触发提炼（fire-and-forget：调用方 void 掉，内部吞错仅 warn） */
export function maybeEvolveImprovePrompt(deps: ImproveEvolutionDeps, projectId: string): void {
  const { db, sidecar } = deps;
  if (!sidecar) return;
  try {
    const count = new EvolutionPatternsRepository(db).countByProject(projectId);
    if (count < EVOLUTION_TEMPLATE_THRESHOLD) return;
  } catch (err) {
    (deps.log ?? ((msg: string) => console.warn(`[novel-forge] ${msg}`)))(
      `evolution_patterns 计数失败，跳过 Prompt Evolver：${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  void refineImprovePrompt(deps, projectId).catch((err: unknown) => {
    // sidecar 不可用 / 接口失败：warn 跳过，不阻塞 IPC
    (deps.log ?? ((msg: string) => console.warn(`[novel-forge] ${msg}`)))(
      `Prompt Evolver 提炼失败（跳过）：${err instanceof Error ? err.message : String(err)}`,
    );
  });
}
