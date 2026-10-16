/** sidecar /reward/status 解析与降级（growth:stats / growth:calibration 共用）
 *
 * 2 秒超时或失败 → 读 GrowthStatsRepository 缓存的上次成功结果；成功则更新缓存；
 * 从未成功过 → 全 0（仪表盘模型段降级不阻塞）。
 */

import type { RewardStatusResponse } from '@novel-forge/shared';
import type { GrowthStatsRepository } from '../db/repositories/growth-stats.js';
import type { SidecarClient } from '../sidecar/client.js';

/** 奖励模型版本号与留出集准确率（未知/未训练为 0） */
export interface RewardStatusExtras {
  rewardVersion: number;
  rewardAccuracy: number;
}

/** "v3" → 3；null/解析失败 → 0（SPEC 契约：未训练 version 为 null，UI 显示 0） */
export function parseRewardVersion(version: string | null): number {
  if (version == null) return 0;
  const n = Number.parseInt(version.replace(/^v/i, ''), 10);
  return Number.isNaN(n) ? 0 : n;
}

export function toExtras(status: RewardStatusResponse): RewardStatusExtras {
  return {
    rewardVersion: parseRewardVersion(status.version),
    rewardAccuracy: status.accuracy ?? 0,
  };
}

/** 取奖励模型状态：sidecar 成功则刷新缓存；失败/未配置 → 缓存；从未成功 → 全 0 */
export async function resolveRewardExtras(
  repo: GrowthStatsRepository,
  projectId: string,
  sidecar?: SidecarClient,
): Promise<RewardStatusExtras> {
  if (sidecar) {
    try {
      const status = await sidecar.rewardStatus();
      repo.saveRewardStatusCache(projectId, status);
      return toExtras(status);
    } catch {
      // 超时/网络错误降级到缓存
    }
  }
  const cached = repo.getRewardStatusCache(projectId);
  return cached ? toExtras(cached) : { rewardVersion: 0, rewardAccuracy: 0 };
}
