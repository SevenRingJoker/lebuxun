/** growth 域 IPC：Phase 4 真实实现 + Phase 6 扩展 + 学习闭环批次
 *
 * growth:stats（§4.1）：聚合 GrowthStats（见 growth/stats.ts）；model 段经 sidecar
 *   /reward/status + 缓存降级注入，evaluatorAlignment 由校准服务同步算出。
 * growth:profile：偏好画像（§10.3 维度向量）+ Phase 6 历史快照（趋势图）。
 * growth:calibration（§14 任务 6.3）：评估器一致率 + 已标记 pairs。
 * growth:train-reward（§10.2）：读 preference_samples 全量 → /reward/train SSE 训练 →
 *   回读 /reward/status 组装 metrics；400 业务失败透传 detail，连接失败返回 error。
 */

import { ipcMain } from 'electron';
import type {
  GrowthCalibrationReq,
  GrowthCalibrationRes,
  GrowthProfileReq,
  GrowthProfileRes,
  GrowthStatsReq,
  GrowthStatsRes,
  GrowthTrainRewardReq,
  GrowthTrainRewardRes,
} from '@novel-forge/shared';
import type { AppDatabase } from '../db/index.js';
import { GrowthStatsRepository } from '../db/repositories/growth-stats.js';
import { PreferenceSamplesRepository } from '../db/repositories/preference-samples.js';
import { computeEvaluatorAlignment, listCalibrationPairs } from '../growth/calibration.js';
import { resolveRewardExtras } from '../growth/reward-status.js';
import { aggregateGrowthStats } from '../growth/stats.js';
import { SidecarHttpError, type SidecarClient } from '../sidecar/client.js';

export interface GrowthIpcDeps {
  db: AppDatabase;
  /** 缺省时 model 段走缓存/全 0 降级；train-reward 返回 {ok:false, error} */
  sidecar?: SidecarClient;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function registerGrowthIpc(deps: GrowthIpcDeps): void {
  const growthRepo = new GrowthStatsRepository(deps.db);

  ipcMain.handle('growth:stats', async (_event, req: GrowthStatsReq): Promise<GrowthStatsRes> => {
    try {
      const reward = await resolveRewardExtras(growthRepo, req.projectId, deps.sidecar);
      const stats = aggregateGrowthStats(deps.db, req.projectId, {
        ...reward,
        evaluatorAlignment: computeEvaluatorAlignment(deps.db, req.projectId),
      });
      return { ok: true, stats };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  });

  ipcMain.handle('growth:profile', async (_event, req: GrowthProfileReq): Promise<GrowthProfileRes> => {
    try {
      const profile = growthRepo.getProfile(req.projectId);
      const history = growthRepo.getHistory(req.projectId);
      return { ok: true, profile, history };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  });

  ipcMain.handle(
    'growth:calibration',
    async (_event, req: GrowthCalibrationReq): Promise<GrowthCalibrationRes> => {
      try {
        const reward = await resolveRewardExtras(growthRepo, req.projectId, deps.sidecar);
        return {
          ok: true,
          alignment: computeEvaluatorAlignment(deps.db, req.projectId),
          ...reward,
          pairs: listCalibrationPairs(deps.db, req.projectId),
        };
      } catch (err) {
        return { ok: false, error: errMsg(err) };
      }
    },
  );

  // §10.2：手动触发奖励模型训练（收尾批次 2 新增频道，SPEC §4.1 未列，SPEC-CHANGELOG 登记）
  ipcMain.handle(
    'growth:train-reward',
    async (_event, req: GrowthTrainRewardReq): Promise<GrowthTrainRewardRes> => {
      if (!deps.sidecar) return { ok: false, error: 'sidecar 未就绪，无法训练奖励模型' };
      try {
        // 全量偏好样本（reasons 为 {tag,inferred}[] → 只取 tag 字符串数组）
        const sampleRepo = new PreferenceSamplesRepository(deps.db);
        const total = sampleRepo.countByProject(req.projectId);
        const samples = sampleRepo
          .listByProject(req.projectId, Math.max(1, total))
          .map((s) => ({
            projectId: s.projectId,
            context: s.context,
            chosen: s.chosen,
            rejected: s.rejected,
            reasons: s.reasons.map((r) => r.tag),
          }));
        await deps.sidecar.trainReward({ samples });
        // 训练完成后回读指标（未训练字段为 null → 按契约空串/0 缺省）
        const status = await deps.sidecar.rewardStatus();
        return {
          ok: true,
          metrics: {
            version: status.version ?? '',
            accuracy: status.accuracy ?? 0,
            kendallTau: status.kendallTau ?? 0,
            sampleCount: status.sampleCount ?? 0,
            trainedAt: status.trainedAt ?? 0,
          },
        };
      } catch (err) {
        // 400 = 样本不足等业务失败（sidecar 返回 {detail}）；其余按连接/网络失败处理
        if (err instanceof SidecarHttpError && err.status === 400) {
          return { ok: false, detail: err.detail ?? err.message };
        }
        return { ok: false, error: errMsg(err) };
      }
    },
  );
}
