/** candidate 域 IPC：Phase 4 真实实现（SPEC §4.1 全部 candidate:* 频道 + candidate:lineage）
 *
 * list/choose/set-satisfaction/reroll/feedback 按 §4.1 契约；满意度持久化 + 偏好采集 + 谱系。
 */

import { ipcMain } from 'electron';
import type {
  Candidate,
  CandidateDiffReq,
  CandidateDiffRes,
  CandidateLineageReq,
  CandidateLineageRes,
  CandidateListReq,
  CandidateListRes,
  CandidateRegenerateFromReq,
  CandidateRegenerateFromRes,
  CandidateRegenerateSimilarReq,
  CandidateRegenerateSimilarRes,
  CandidateRejectAllReq,
  CandidateRejectAllRes,
  CandidateSelectReq,
  CandidateSelectRes,
  CandidateDissatisfyReq,
  CandidateDissatisfyRes,
  CandidateSatisfyReq,
  CandidateSatisfyRes,
  CandidateUnmarkReq,
  CandidateUnmarkRes,
  CandidatePruneUnsatisfiedReq,
  CandidatePruneUnsatisfiedRes,
  StreamEvent,
} from '@novel-forge/shared';
import { REASON_TAGS } from '@novel-forge/shared';
import type { AppDatabase } from '../db/index.js';
import { CandidatesRepository } from '../db/repositories/candidates.js';
import { EvolutionPatternsRepository } from '../db/repositories/evolution-patterns.js';
import { GrowthStatsRepository } from '../db/repositories/growth-stats.js';
import { SatisfactionTagsRepository } from '../db/repositories/satisfaction-tags.js';
import { PreferenceCollector } from '../growth/preference-collector.js';
import { maybeEvolveImprovePrompt, type ImproveEvolutionDeps } from '../growth/prompt-evolution.js';
import { aggregateGrowthStats } from '../growth/stats.js';
import type { LLMGateway } from '../llm/gateway.js';
import { buildLineageFromDb } from '../services/candidate-lineage.js';
import { regenerateFromCandidate, regenerateSimilarCandidates } from '../services/candidate-regeneration.js';
import { diffTexts } from '../services/text-diff.js';
import type { SidecarClient } from '../sidecar/client.js';

export interface CandidateIpcDeps {
  db: AppDatabase;
  llm?: LLMGateway;
  /** §10.4/§10.5：pattern 达阈值后触发 Prompt Evolver（缺省跳过整条演化链） */
  sidecar?: SidecarClient;
  emit: (event: StreamEvent) => void;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function resolveProjectId(db: AppDatabase, runId: string): string {
  const row = db
    .prepare(
      `SELECT w.project_id AS pid
       FROM runs r JOIN workflows w ON w.id = r.workflow_id
       WHERE r.id = ?`,
    )
    .get(runId) as { pid: string } | undefined;
  if (!row) throw new Error(`run ${runId} 找不到对应项目`);
  return row.pid;
}

/** 从 candidate_lineage 反查本次重生成的 hint（candidates 表无 hint 列，生成参数记在 lineage 行） */
function latestHintForParent(db: AppDatabase, parentId: string): string | undefined {
  const row = db
    .prepare('SELECT hint FROM candidate_lineage WHERE parent_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(parentId) as { hint: string | null } | undefined;
  return row?.hint ?? undefined;
}

/** 句级 diff 近似统计（口径：diffTexts 合并后 del/add 段条数，非逐句精确计数） */
function diffSummary(parentText: string, childText: string): { removed: number; added: number } {
  const segments = diffTexts(parentText, childText);
  return {
    removed: segments.filter((s) => s.type === 'del').length,
    added: segments.filter((s) => s.type === 'add').length,
  };
}

export function registerCandidateIpc(deps: CandidateIpcDeps): void {
  const repo = new CandidatesRepository(deps.db);
  const tagsRepo = new SatisfactionTagsRepository(deps.db);
  const growthRepo = new GrowthStatsRepository(deps.db);
  const collector = new PreferenceCollector(deps.db);
  const evolutionRepo = new EvolutionPatternsRepository(deps.db);
  // §10.4/§10.5 Prompt Evolver 依赖（sidecar 缺省时 maybeEvolve 内部直接跳过）
  const evolutionDeps: ImproveEvolutionDeps = {
    db: deps.db,
    ...(deps.sidecar !== undefined ? { sidecar: deps.sidecar } : {}),
  };

  ipcMain.handle('candidate:list', async (_event, req: CandidateListReq): Promise<CandidateListRes> => {
    try {
      const candidates = repo.listByRun(req.runId, req.nodeId);
      return { ok: true, candidates };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  });

  ipcMain.handle('candidate:select', async (_event, req: CandidateSelectReq): Promise<CandidateSelectRes> => {
    try {
      // 改后选：editedText 非空且与候选现文本不同时，先回写候选正文再标记选中
      if (req.editedText != null && req.editedText !== '') {
        const current = repo.get(req.candidateId);
        if (!current) return { ok: false, error: `候选不存在: ${req.candidateId}` };
        if (current.text !== req.editedText) {
          repo.updateText(req.candidateId, req.editedText);
        }
      }
      repo.markSelected(req.candidateId);
      // §10.4 Evolution Learner：改进被采纳（parent_candidate_id 非空）→ 记一条 selected
      // pattern（fire-and-forget：失败仅 warn，不影响选中流程）
      let evolutionProjectId: string | undefined;
      try {
        const candidate = repo.get(req.candidateId);
        const pid =
          candidate?.parentCandidateId != null ? resolveProjectId(deps.db, req.runId) : undefined;
        const parent =
          candidate?.parentCandidateId != null ? repo.get(candidate.parentCandidateId) : undefined;
        if (candidate && pid && parent) {
          const hint = latestHintForParent(deps.db, parent.id);
          evolutionRepo.insert({
            projectId: pid,
            parentText: parent.text,
            childText: candidate.text,
            mode: candidate.generationMode,
            ...(hint !== undefined ? { hint } : {}),
            outcome: 'selected',
            // 近似口径：句级 LCS 合并后的删/增段条数
            diff: diffSummary(parent.text, candidate.text),
          });
          evolutionProjectId = pid;
        }
      } catch (err) {
        console.warn('[novel-forge] evolution pattern（selected）记录失败（忽略）：', err);
      }
      // §10.2 偏好采集：choose A 时与其他低满意度候选成对
      const inserted = collector.collectOnSelect(req.runId, req.nodeId, req.candidateId);
      if (inserted.length > 0) {
        // §4.1 growth:updated 流事件
        const projectId = resolveProjectId(deps.db, req.runId);
        deps.emit({ type: 'growth:updated', projectId, stats: aggregateGrowthStats(deps.db, projectId) });
      }
      // §10.5：pattern 累计达阈值后 fire-and-forget 触发 Prompt Evolver（不阻塞 IPC 响应）
      if (evolutionProjectId !== undefined) {
        maybeEvolveImprovePrompt(evolutionDeps, evolutionProjectId);
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  });

  ipcMain.handle('candidate:reject-all', async (_event, req: CandidateRejectAllReq): Promise<CandidateRejectAllRes> => {
    try {
      const candidates = repo.listByRun(req.runId, req.nodeId);
      for (const c of candidates) {
        repo.setSatisfaction(c.id, 'unsatisfied', req.reason ?? undefined);
      }
      // Phase 6：拒全弃计数持久化（growth:stats 的 rejectAllRate 分子）
      const projectId = resolveProjectId(deps.db, req.runId);
      growthRepo.incrementRejectAll(projectId);
      // §10.4 Evolution Learner：拒全弃 → 按 parent_candidate_id 分组，每组记一条 rejected
      //（child_texts=该组全部落选候选文本；无父候选的组不记——parent_text 非空约束）。失败仅 warn。
      try {
        const groups = new Map<string, Candidate[]>();
        for (const c of candidates) {
          if (c.parentCandidateId == null) continue;
          const list = groups.get(c.parentCandidateId) ?? [];
          list.push(c);
          groups.set(c.parentCandidateId, list);
        }
        for (const [parentId, group] of groups) {
          const parent = repo.get(parentId);
          if (!parent || group.length === 0) continue;
          const hint = latestHintForParent(deps.db, parentId);
          evolutionRepo.insert({
            projectId,
            parentText: parent.text,
            childTexts: group.map((c) => c.text),
            mode: group[0]!.generationMode,
            ...(hint !== undefined ? { hint } : {}),
            outcome: 'rejected',
          });
        }
        // §10.5：pattern 累计达阈值后 fire-and-forget 触发 Prompt Evolver
        maybeEvolveImprovePrompt(evolutionDeps, projectId);
      } catch (err) {
        console.warn('[novel-forge] evolution pattern（rejected）记录失败（忽略）：', err);
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  });

  ipcMain.handle('candidate:satisfy', async (_event, req: CandidateSatisfyReq): Promise<CandidateSatisfyRes> => {
    try {
      repo.setSatisfaction(req.candidateId, 'satisfied');
      const inserted = collector.collectOnSatisfaction(req.runId, req.nodeId, req.candidateId);
      if (inserted.length > 0) {
        const pid = resolveProjectId(deps.db, req.runId);
        deps.emit({ type: 'growth:updated', projectId: pid, stats: aggregateGrowthStats(deps.db, pid) });
      }
      deps.emit({ type: 'candidate:marked', runId: req.runId, candidateId: req.candidateId, satisfaction: 'satisfied' });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  });

  ipcMain.handle('candidate:dissatisfy', async (_event, req: CandidateDissatisfyReq): Promise<CandidateDissatisfyRes> => {
    try {
      // §12.2 REASON_TAGS 校验
      if (req.reasonTags !== undefined && req.reasonTags.length > 0) {
        const invalid = req.reasonTags.filter((t) => !REASON_TAGS.includes(t as never));
        if (invalid.length > 0) {
          return { ok: false, error: `无效标签：${invalid.join('、')}` };
        }
      }
      repo.setSatisfaction(req.candidateId, 'unsatisfied', req.reason ?? undefined, req.reasonTags ?? undefined);
      // 不满意标签计数（成长仪表盘 Top 标签）
      const pid = resolveProjectId(deps.db, req.runId);
      if (req.reasonTags) {
        for (const tag of req.reasonTags) {
          tagsRepo.increment(pid, tag, 'negative');
        }
      }
      const inserted = collector.collectOnDissatisfy(req.runId, req.nodeId, req.candidateId);
      if (inserted.length > 0) {
        deps.emit({ type: 'growth:updated', projectId: pid, stats: aggregateGrowthStats(deps.db, pid) });
      }
      deps.emit({ type: 'candidate:marked', runId: req.runId, candidateId: req.candidateId, satisfaction: 'unsatisfied' });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  });

  ipcMain.handle('candidate:unmark', async (_event, req: CandidateUnmarkReq): Promise<CandidateUnmarkRes> => {
    try {
      repo.setSatisfaction(req.candidateId, 'unrated');
      deps.emit({ type: 'candidate:marked', runId: req.runId, candidateId: req.candidateId, satisfaction: 'unrated' });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  });

  ipcMain.handle(
    'candidate:regenerate-from',
    async (_event, req: CandidateRegenerateFromReq): Promise<CandidateRegenerateFromRes> => {
      try {
        if (!deps.llm) return { ok: false, error: 'LLM 未就绪，无法重生成' };
        const created = await regenerateFromCandidate(
          {
            db: deps.db,
            llm: deps.llm,
            runId: req.runId,
            nodeId: req.nodeId,
            emit: deps.emit,
            log: console.log,
          },
          { candidateId: req.candidateId, mode: req.mode, ...(req.hint !== undefined ? { hint: req.hint } : {}) },
        );
        return { ok: true, newCandidateIds: created.map((c) => c.id) };
      } catch (err) {
        return { ok: false, error: errMsg(err) };
      }
    },
  );

  ipcMain.handle(
    'candidate:regenerate-similar',
    async (_event, req: CandidateRegenerateSimilarReq): Promise<CandidateRegenerateSimilarRes> => {
      try {
        if (!deps.llm) return { ok: false, error: 'LLM 未就绪，无法重生成' };
        const created = await regenerateSimilarCandidates(
          {
            db: deps.db,
            llm: deps.llm,
            runId: req.runId,
            nodeId: req.nodeId,
            emit: deps.emit,
            log: console.log,
          },
          { candidateId: req.candidateId, count: req.count },
        );
        return { ok: true, newCandidateIds: created.map((c) => c.id) };
      } catch (err) {
        return { ok: false, error: errMsg(err) };
      }
    },
  );

  ipcMain.handle(
    'candidate:prune-unsatisfied',
    async (_event, req: CandidatePruneUnsatisfiedReq): Promise<CandidatePruneUnsatisfiedRes> => {
      try {
        const removed = repo.deleteUnsatisfied(req.runId, req.nodeId);
        deps.emit({ type: 'candidate:pruned', runId: req.runId, removedIds: removed });
        return { ok: true, removed: removed.length };
      } catch (err) {
        return { ok: false, error: errMsg(err) };
      }
    },
  );

  // Phase 4 新增：谱系树（SPEC §4.1 未定义，SPEC-CHANGELOG 登记）
  ipcMain.handle('candidate:lineage', async (_event, req: CandidateLineageReq): Promise<CandidateLineageRes> => {
    try {
      const lineage = buildLineageFromDb(deps.db, req.runId, req.candidateId);
      return { ok: true, lineage };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  });

  // Phase 6：版本对比（§14 任务 6.4，SPEC §4.1 未列，SPEC-CHANGELOG 登记）
  ipcMain.handle('candidate:diff', async (_event, req: CandidateDiffReq): Promise<CandidateDiffRes> => {
    try {
      const a = repo.get(req.candidateIdA);
      const b = repo.get(req.candidateIdB);
      if (!a || !b) return { ok: false, error: '候选不存在' };
      return { ok: true, segments: diffTexts(a.text, b.text) };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  });
}
