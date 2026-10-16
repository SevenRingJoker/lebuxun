/** Phase 6 成长仪表盘（任务 6.2 / 6.3 / 6.6，SPEC §12.5 布局）
 *
 * 区块：成长指数大卡片（含与上一快照 delta）→ 偏好学习 / 候选演化 / 模型对齐三卡 →
 * Top 不满意 / 满意理由两列 → 偏好画像 8 维 SVG 迷你趋势 → 评估器校准区（任务 6.3）。
 * 头部右侧为成稿导出按钮组（TXT/MD/DOCX/EPUB，任务 6.6）。
 * 数据：growth:stats + growth:profile + growth:calibration；订阅 growth:updated 实时刷新。
 * 图表手写 SVG（不引第三方图表库）；无数据时显示空态。
 */

import { useCallback, useEffect, useState } from 'react';
import type {
  CalibrationPair,
  ExportFormat,
  GrowthCalibrationRes,
  GrowthStats,
  ProfileSnapshot,
} from '@novel-forge/shared';
import { exportApi, growthApi, onStreamEvent } from '../ipc/index.js';
import { useWorkflowStore } from '../stores/workflowStore.js';

/** §10.3 八维维度名中文映射 */
const DIMENSION_LABEL: Record<string, string> = {
  pacing: '节奏',
  character_fidelity: '人设',
  lexicon: '用词',
  tension: '冲突',
  restraint: '留白',
  dialogue: '对白',
  atmosphere: '氛围',
  density: '密度',
};

const EXPORT_FORMATS: { format: ExportFormat; label: string }[] = [
  { format: 'txt', label: 'TXT' },
  { format: 'md', label: 'MD' },
  { format: 'docx', label: 'DOCX' },
  { format: 'epub', label: 'EPUB' },
];

/** 成长指数 delta：history 末两条快照 dimensions 均值差 ×100；无两条历史返回 null */
function growthDelta(history: ProfileSnapshot[]): number | null {
  if (history.length < 2) return null;
  const mean = (dims: Record<string, number>): number => {
    const values = Object.values(dims);
    if (values.length === 0) return 0;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
  };
  const last = history[history.length - 1];
  const prev = history[history.length - 2];
  if (last === undefined || prev === undefined) return null;
  return (mean(last.dimensions) - mean(prev.dimensions)) * 100;
}

/** 单维度迷你趋势图：多快照画 polyline，单快照画点 */
function DimensionTrend(props: { label: string; values: number[] }) {
  const { label, values } = props;
  const W = 120;
  const H = 36;
  const PAD = 4;
  // 维度值域按 0..1 归一到画布高度
  const toY = (v: number): number => H - PAD - Math.max(0, Math.min(1, v)) * (H - PAD * 2);
  const toX = (i: number): number =>
    values.length <= 1 ? W / 2 : PAD + (i / (values.length - 1)) * (W - PAD * 2);
  const points = values.map((v, i) => `${toX(i)},${toY(v)}`).join(' ');
  const latest = values.length > 0 ? values[values.length - 1] : undefined;
  return (
    <div className="trend-item">
      <div className="trend-header">
        <span>{label}</span>
        <span className="trend-value">{latest !== undefined ? latest.toFixed(2) : '—'}</span>
      </div>
      <svg width={W} height={H} className="trend-svg">
        {values.length === 1 ? (
          <circle cx={toX(0)} cy={toY(values[0] ?? 0)} r={3} className="trend-dot" />
        ) : values.length > 1 ? (
          <polyline points={points} className="trend-line" />
        ) : null}
      </svg>
    </div>
  );
}

/** 校准对一行：预测分 vs 实际满意度是否一致（满意且 ≥0.5，或不满意且 <0.5 视为一致，仅展示） */
function CalibrationRow(props: { pair: CalibrationPair }) {
  const { pair } = props;
  const satisfied = pair.satisfaction === 'satisfied';
  const consistent = satisfied ? pair.rewardScore >= 0.5 : pair.rewardScore < 0.5;
  return (
    <div className="calibration-row">
      <span className="calibration-id" title={pair.candidateId}>
        {pair.candidateId.slice(0, 8)}
      </span>
      <span>奖励 {pair.rewardScore.toFixed(2)}</span>
      <span>均分 {pair.avgScore.toFixed(2)}</span>
      <span>{satisfied ? '✓ 满意' : pair.satisfaction === 'unsatisfied' ? '✗ 不满意' : '未标记'}</span>
      <span className={consistent ? 'calibration-consistent' : 'calibration-divergent'}>
        {consistent ? '预测一致' : '预测偏离'}
      </span>
    </div>
  );
}

export default function GrowthDashboard() {
  const projectId = useWorkflowStore((s) => s.projectId);
  const [stats, setStats] = useState<GrowthStats | null>(null);
  const [history, setHistory] = useState<ProfileSnapshot[]>([]);
  const [calibration, setCalibration] = useState<GrowthCalibrationRes | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const [exportResult, setExportResult] = useState<{ ok: boolean; message: string } | null>(null);
  // §10.2 奖励模型训练（学习闭环批次）：训练中 loading + 结果提示
  const [training, setTraining] = useState(false);
  const [trainResult, setTrainResult] = useState<{ ok: boolean; message: string } | null>(null);

  const load = useCallback(async () => {
    if (projectId === null) {
      setLoaded(true);
      return;
    }
    try {
      const [statsRes, profileRes, calibrationRes] = await Promise.all([
        growthApi.stats(projectId),
        growthApi.profile(projectId),
        growthApi.calibration(projectId),
      ]);
      if (statsRes.ok) setStats(statsRes.stats ?? null);
      if (profileRes.ok) setHistory(profileRes.history ?? []);
      if (calibrationRes.ok) setCalibration(calibrationRes);
      setError(null);
    } catch (err) {
      // 非 Electron 环境（纯 vite 预览）下降级为空态
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoaded(true);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  // 订阅 growth:updated 流事件：事件携带最新 stats，其余数据重新拉取保持一致
  useEffect(() => {
    if (projectId === null) return;
    const off = onStreamEvent((event) => {
      if (event.type !== 'growth:updated' || event.projectId !== projectId) return;
      void load();
    });
    return off;
  }, [projectId, load]);

  const doExport = useCallback(
    async (format: ExportFormat) => {
      if (projectId === null || exporting !== null) return;
      setExporting(format);
      setExportResult(null);
      try {
        const res = await exportApi.manuscript(projectId, format);
        if (res.ok && res.path !== undefined) {
          setExportResult({ ok: true, message: `已导出：${res.path}` });
        } else {
          setExportResult({ ok: false, message: res.error ?? '导出失败' });
        }
      } catch (err) {
        setExportResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
      } finally {
        setExporting(null);
      }
    },
    [projectId, exporting],
  );

  const hasData = stats !== null || history.length > 0;

  // §10.2：手动触发奖励模型训练；成功显示 accuracy/kendallTau，失败显示 detail/error
  const doTrainReward = useCallback(async () => {
    if (projectId === null || training) return;
    setTraining(true);
    setTrainResult(null);
    try {
      const res = await growthApi.trainReward(projectId);
      if (res.ok && res.metrics) {
        setTrainResult({
          ok: true,
          message: `训练完成：准确率 ${Math.round(res.metrics.accuracy * 100)}% · Kendall τ ${res.metrics.kendallTau.toFixed(2)}`,
        });
        void load(); // 刷新模型对齐卡指标
      } else if (res.ok) {
        setTrainResult({ ok: false, message: '训练完成但未返回指标' });
      } else {
        setTrainResult({ ok: false, message: res.detail ?? res.error ?? '训练失败' });
      }
    } catch (err) {
      setTrainResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setTraining(false);
    }
  }, [projectId, training, load]);

  if (projectId === null || (loaded && !hasData)) {
    return (
      <div className="growth-dashboard">
        <div className="growth-empty">暂无成长数据，先去生成并标注候选</div>
      </div>
    );
  }

  const delta = growthDelta(history);
  const dimensionKeys = Object.keys(DIMENSION_LABEL).filter(
    (dim) => history.length > 0 && history.some((snap) => snap.dimensions[dim] !== undefined),
  );

  return (
    <div className="growth-dashboard">
      <div className="growth-top">
        <span className="growth-title">成长仪表盘</span>
        <span style={{ flex: 1 }} />
        <span className="growth-export-label">导出成稿：</span>
        {EXPORT_FORMATS.map(({ format, label }) => (
          <button
            key={format}
            type="button"
            onClick={() => void doExport(format)}
            disabled={exporting !== null}
          >
            {exporting === format ? '导出中…' : label}
          </button>
        ))}
      </div>

      {error !== null && <div className="growth-error">{error}</div>}
      {exportResult !== null && (
        <div className={exportResult.ok ? 'growth-export-ok' : 'growth-error'}>
          {exportResult.message}
        </div>
      )}

      {stats !== null && (
        <>
          <div className="growth-index-card">
            <span className="growth-index-label">成长指数</span>
            {/* growthIndex 由 Main 聚合为 0..100（stats.ts），直接取整显示 */}
            <span className="growth-index-value">{Math.round(stats.growthIndex)}</span>
            {delta !== null && (
              <span className={delta >= 0 ? 'growth-delta growth-delta--up' : 'growth-delta growth-delta--down'}>
                {delta >= 0 ? '▲' : '▼'} {delta >= 0 ? '+' : ''}
                {delta.toFixed(1)} 较上一快照
              </span>
            )}
          </div>

          <div className="growth-cards">
            <div className="growth-card">
              <div className="growth-card-title">偏好学习</div>
              <div className="growth-card-meta">样本 {stats.preference.totalSamples}</div>
              <div className="growth-card-meta">
                理由覆盖 {Math.round(stats.preference.reasonCoverage * 100)}%
              </div>
              <div className="growth-card-meta">
                维度 {Object.keys(stats.preference.dimensions).length} 维
              </div>
            </div>
            <div className="growth-card">
              <div className="growth-card-title">候选演化</div>
              <div className="growth-card-meta">
                平均深度 {stats.satisfaction.avgGenerationDepth.toFixed(1)}
              </div>
              <div className="growth-card-meta">
                收敛率 {Math.round(stats.satisfaction.convergenceRate * 100)}%
              </div>
              <div className="growth-card-meta">
                满意率 {Math.round(stats.satisfaction.satisfiedRate * 100)}%
              </div>
            </div>
            <div className="growth-card">
              <div className="growth-card-title">模型对齐</div>
              <div className="growth-card-meta">奖励模型 v{stats.model.rewardVersion}</div>
              <div className="growth-card-meta">
                准确率 {Math.round(stats.model.rewardAccuracy * 100)}%
              </div>
              <div className="growth-card-meta">
                评估对齐 {Math.round(stats.model.evaluatorAlignment * 100)}%
              </div>
              {/* §10.2：手动触发奖励模型训练（学习闭环批次） */}
              <button type="button" onClick={() => void doTrainReward()} disabled={training}>
                {training ? '训练中…' : '训练奖励模型'}
              </button>
              {trainResult !== null && (
                <div className={trainResult.ok ? 'growth-export-ok' : 'growth-error'}>
                  {trainResult.message}
                </div>
              )}
            </div>
          </div>

          <div className="growth-tags">
            <div className="growth-tag-col">
              <div className="growth-card-title">Top 不满意理由</div>
              {stats.satisfaction.topNegativeTags.length === 0 ? (
                <div className="growth-card-meta">暂无</div>
              ) : (
                stats.satisfaction.topNegativeTags.map((t) => (
                  <div key={t.tag} className="growth-card-meta">
                    · {t.tag}　{t.count} 次
                  </div>
                ))
              )}
            </div>
            <div className="growth-tag-col">
              <div className="growth-card-title">Top 满意理由</div>
              {stats.satisfaction.topPositiveTags.length === 0 ? (
                <div className="growth-card-meta">暂无</div>
              ) : (
                stats.satisfaction.topPositiveTags.map((t) => (
                  <div key={t.tag} className="growth-card-meta">
                    · {t.tag}　{t.count} 次
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}

      {history.length > 0 && (
        <div className="growth-trends">
          <div className="growth-card-title">偏好画像趋势</div>
          <div className="growth-trend-grid">
            {dimensionKeys.map((dim) => (
              <DimensionTrend
                key={dim}
                label={DIMENSION_LABEL[dim] ?? dim}
                values={history.map((snap) => snap.dimensions[dim] ?? 0)}
              />
            ))}
          </div>
        </div>
      )}

      {calibration !== null && (
        <div className="growth-calibration">
          <div className="growth-card-title">评估器校准</div>
          <div className="calibration-summary">
            <span className="calibration-alignment">
              {Math.round((calibration.alignment ?? 0) * 100)}%
            </span>
            <span className="growth-card-meta">
              奖励模型 v{calibration.rewardVersion ?? 0} · 准确率{' '}
              {Math.round((calibration.rewardAccuracy ?? 0) * 100)}%
            </span>
          </div>
          {(calibration.pairs ?? []).length === 0 ? (
            <div className="growth-card-meta">暂无已标注候选，标注满意/不满意后此处展示预测一致性</div>
          ) : (
            (calibration.pairs ?? []).map((pair) => <CalibrationRow key={pair.candidateId} pair={pair} />)
          )}
        </div>
      )}
    </div>
  );
}
