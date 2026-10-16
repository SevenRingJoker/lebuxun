/** growth_stats 表仓库（SPEC §5.1）：偏好画像（§10.3 维度向量）持久化
 *
 * stats JSON 为多兄弟字段容器：{ profile, history, counters, rewardStatusCache }。
 * 所有写入一律「读取-合并-写回」，严禁整体覆盖吞掉兄弟字段。
 */

import type { PreferenceProfile, ProfileSnapshot, RewardStatusResponse } from '@novel-forge/shared';
import type { AppDatabase } from '../index.js';
import { emptyProfile } from '../../growth/profile-updater.js';

/** 画像历史快照上限：趋势图只需近期窗口，超上限丢最旧（防 stats JSON 无限膨胀） */
export const PROFILE_HISTORY_LIMIT = 50;

interface GrowthStatsRow {
  project_id: string;
  stats: string;
  updated_at: number;
}

/** stats JSON 容器形状（兄弟字段全可选，缺省即无） */
interface StatsDoc {
  profile?: PreferenceProfile;
  history?: ProfileSnapshot[];
  counters?: { rejectAll?: number };
  rewardStatusCache?: RewardStatusResponse;
}

export class GrowthStatsRepository {
  constructor(private readonly db: AppDatabase) {}

  private readDoc(projectId: string): StatsDoc {
    const row = this.db
      .prepare('SELECT * FROM growth_stats WHERE project_id = ?')
      .get(projectId) as GrowthStatsRow | undefined;
    if (!row) return {};
    try {
      return JSON.parse(row.stats) as StatsDoc;
    } catch {
      // 坏 JSON 视为空文档（不抛错以免拖垮整个仪表盘）
      return {};
    }
  }

  private writeDoc(projectId: string, doc: StatsDoc): void {
    this.db
      .prepare(
        `INSERT INTO growth_stats (project_id, stats, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET stats = excluded.stats, updated_at = excluded.updated_at`,
      )
      .run(projectId, JSON.stringify(doc), Date.now());
  }

  /** 读画像；不存在时返回零初始化画像（不落库） */
  getProfile(projectId: string): PreferenceProfile {
    return this.readDoc(projectId).profile ?? emptyProfile();
  }

  /** 保存画像并追加历史快照（合并写回，保留 counters/rewardStatusCache 等兄弟字段） */
  saveProfile(projectId: string, profile: PreferenceProfile): void {
    const doc = this.readDoc(projectId);
    const history = [...(doc.history ?? []), { at: Date.now(), dimensions: { ...profile.dimensions } }];
    // 封顶 PROFILE_HISTORY_LIMIT 条，超出丢最旧
    while (history.length > PROFILE_HISTORY_LIMIT) history.shift();
    doc.profile = profile;
    doc.history = history;
    this.writeDoc(projectId, doc);
  }

  /** 画像历史快照（时间升序） */
  getHistory(projectId: string): ProfileSnapshot[] {
    return this.readDoc(projectId).history ?? [];
  }

  /** 拒全弃计数 +1（candidate:reject-all 每次调用递增，合并写回） */
  incrementRejectAll(projectId: string): void {
    const doc = this.readDoc(projectId);
    doc.counters = { ...doc.counters, rejectAll: (doc.counters?.rejectAll ?? 0) + 1 };
    this.writeDoc(projectId, doc);
  }

  /** 拒全弃累计次数（无记录为 0） */
  getRejectAllCount(projectId: string): number {
    return this.readDoc(projectId).counters?.rejectAll ?? 0;
  }

  /** 上次成功的 sidecar /reward/status 缓存（sidecar 挂掉时降级用） */
  getRewardStatusCache(projectId: string): RewardStatusResponse | undefined {
    return this.readDoc(projectId).rewardStatusCache;
  }

  saveRewardStatusCache(projectId: string, status: RewardStatusResponse): void {
    const doc = this.readDoc(projectId);
    doc.rewardStatusCache = status;
    this.writeDoc(projectId, doc);
  }
}
