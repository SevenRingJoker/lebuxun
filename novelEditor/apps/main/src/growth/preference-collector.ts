/** SPEC §10.2 Preference Collector：成对偏好样本生成
 *
 * 触发点（task 4.6）：candidate:select（choose A）与 candidate:satisfy/dissatisfy。
 * 成对规则：chosen 满意度严格高于 rejected（satisfied>unrated>unsatisfied）即构成样本；
 * 无理由标签时按 §10.2 六维分数差推断软标签（inferred=true）。
 * 样本落 preference_samples 表后立即按 §10.3 EMA 更新偏好画像（growth_stats）。
 */

import { nanoid } from 'nanoid';
import type { Candidate, PreferenceReason, PreferenceSample } from '@novel-forge/shared';
import type { AppDatabase } from '../db/index.js';
import { CandidatesRepository } from '../db/repositories/candidates.js';
import { GrowthStatsRepository } from '../db/repositories/growth-stats.js';
import { PreferenceSamplesRepository } from '../db/repositories/preference-samples.js';
import { applyReasons } from './profile-updater.js';
import { inferReasons } from './reason-inference.js';

const SAT_RANK: Record<Candidate['satisfaction'], number> = {
  satisfied: 2,
  unrated: 1,
  unsatisfied: 0,
};

function resolveProjectId(db: AppDatabase, runId: string): string | undefined {
  const row = db
    .prepare(
      `SELECT w.project_id AS projectId
       FROM runs r JOIN workflows w ON w.id = r.workflow_id
       WHERE r.id = ?`,
    )
    .get(runId) as { projectId: string } | undefined;
  return row?.projectId;
}

/** 成对样本的理由：优先用户手填标签，否则六维分数差推断（§10.2） */
function sampleReasons(chosen: Candidate, rejected: Candidate): PreferenceReason[] {
  if (rejected.satisfactionTags && rejected.satisfactionTags.length > 0) {
    return rejected.satisfactionTags.map((tag) => ({ tag, inferred: false }));
  }
  return inferReasons(chosen.scores, rejected.scores);
}

export class PreferenceCollector {
  private readonly samples: PreferenceSamplesRepository;
  private readonly growth: GrowthStatsRepository;

  constructor(private readonly db: AppDatabase) {
    this.samples = new PreferenceSamplesRepository(db);
    this.growth = new GrowthStatsRepository(db);
  }

  /** choose A：A 满意度高于 B 的每个 B 生成一条成对样本 */
  collectOnSelect(runId: string, nodeId: string, selectedId: string): PreferenceSample[] {
    const repo = new CandidatesRepository(this.db);
    const all = repo.listByRun(runId, nodeId);
    const chosen = all.find((c) => c.id === selectedId);
    if (!chosen) return [];
    const rejected = all.filter((c) => c.id !== chosen.id && SAT_RANK[c.satisfaction] < SAT_RANK[chosen.satisfaction]);
    return this.persistSamples(runId, nodeId, chosen, rejected);
  }

  /** satisfy 后：锚点为 chosen，与满意度严格更低的候选两两成对 */
  collectOnSatisfaction(runId: string, nodeId: string, candidateId: string): PreferenceSample[] {
    const repo = new CandidatesRepository(this.db);
    const all = repo.listByRun(runId, nodeId);
    const anchor = all.find((c) => c.id === candidateId);
    if (!anchor || anchor.satisfaction !== 'satisfied') return [];
    const others = all.filter((c) => c.id !== anchor.id && SAT_RANK[c.satisfaction] < SAT_RANK[anchor.satisfaction]);
    return this.persistSamples(runId, nodeId, anchor, others);
  }

  /** dissatisfy 后：锚点为 rejected，与满意度严格更高的候选两两成对（chosen=对方） */
  collectOnDissatisfy(runId: string, nodeId: string, candidateId: string): PreferenceSample[] {
    const repo = new CandidatesRepository(this.db);
    const all = repo.listByRun(runId, nodeId);
    const anchor = all.find((c) => c.id === candidateId);
    if (!anchor || anchor.satisfaction !== 'unsatisfied') return [];
    const chosenSide = all.filter(
      (c) => c.id !== anchor.id && SAT_RANK[c.satisfaction] > SAT_RANK[anchor.satisfaction],
    );
    const inserted: PreferenceSample[] = [];
    for (const chosen of chosenSide) {
      inserted.push(...this.persistSamples(runId, nodeId, chosen, [anchor]));
    }
    return inserted;
  }

  private persistSamples(
    runId: string,
    nodeId: string,
    chosen: Candidate,
    rejected: Candidate[],
  ): PreferenceSample[] {
    if (rejected.length === 0) return [];
    const projectId = resolveProjectId(this.db, runId);
    if (projectId === undefined) return [];
    const context = JSON.stringify({ runId, nodeId, chosenId: chosen.id });
    const inserted: PreferenceSample[] = [];
    for (const rej of rejected) {
      inserted.push(
        this.samples.insert({
          id: nanoid(),
          projectId,
          context,
          chosen: chosen.text,
          rejected: rej.text,
          reasons: sampleReasons(chosen, rej),
          createdAt: Date.now(),
        }),
      );
    }
    // §10.3：样本写入后 EMA 更新偏好画像
    const profile = this.growth.getProfile(projectId);
    const updated = applyReasons(profile, inserted.map((s) => s.reasons), inserted.length);
    this.growth.saveProfile(projectId, updated);
    return inserted;
  }
}
