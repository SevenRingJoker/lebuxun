/** Phase 5 风格库面板（SPEC §12.4）
 *
 * 风格卡片列表（作家/类型/作品数/语料统计/指纹摘要/分析状态）；
 * [导入作品] 表单：作者名 + 类型 + 书籍路径列表（style:pick-files 逐条追加、可删行、
 * 任意数量动态渲染不硬编码）；
 * 导入中按 style:import-progress 流事件显示阶段名 + 进度条；
 * [查看报告] 弹层 <pre> 展示 report markdown；删除按钮。
 */

import { useCallback, useEffect, useState } from 'react';
import type { StyleProfile, StyleSelfCheckRes } from '@novel-forge/shared';
import { onStreamEvent, styleApi } from '../ipc/index.js';

/** 自测 N 分档中文标签（§15：one 单本 / few 少量 / many 充分） */
const BAND_LABEL: Record<string, string> = {
  one: '单本',
  few: '少量',
  many: '充分',
};

/** 导入阶段中文映射（sidecar /style/analyze SSE stage） */
const STAGE_LABEL: Record<string, string> = {
  chunking: '章节切分',
  cleaning: '清洗',
  tagging: '场景标注',
  stylometry: '统计特征',
  'llm-analysis': 'LLM 分析',
  embedding: '向量入库',
  discriminator: '判别器训练',
  done: '完成',
};

function formatDate(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 语料统计：作品总字数（万字）+ 风格库段数 */
function corpusLine(profile: StyleProfile): string {
  const words = profile.books.reduce((sum, b) => sum + (b.wordCount ?? 0), 0);
  return `作品：${profile.bookCount} 本 · 语料 ${(words / 10000).toFixed(1)} 万字 · 风格库 ${profile.ragStats.totalChunks} 段`;
}

function fingerprintLine(profile: StyleProfile): string {
  const fp = profile.fingerprint;
  return `句长 ${fp.avgSentenceLength.toFixed(1)} · 对白 ${(fp.dialogueRatio * 100).toFixed(0)}% · 短句比 ${(fp.shortSentenceRatio * 100).toFixed(0)}%`;
}

interface ImportFormState {
  authorName: string;
  genre: string;
  bookPaths: string[];
}

interface ImportProgress {
  stage: string;
  progress: number;
}

const EMPTY_FORM: ImportFormState = { authorName: '', genre: '', bookPaths: [] };

export default function StyleLibrary() {
  const [styles, setStyles] = useState<StyleProfile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<ImportFormState>(EMPTY_FORM);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [reportId, setReportId] = useState<string | null>(null);
  // 风格相似度自测（§15）：各档案最近一次自测结果 + 自测中标记
  const [checks, setChecks] = useState<Record<string, StyleSelfCheckRes>>({});
  const [checking, setChecking] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    try {
      const res = await styleApi.list();
      if (res.ok) {
        setStyles(res.styles ?? []);
        setError(null);
      } else {
        setError(res.error ?? '风格库加载失败');
      }
    } catch (err) {
      // 非 Electron 环境（纯 vite 预览）下降级为空态
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 导入进度流事件（仅导入进行中跟踪；done 后刷新列表）
  useEffect(() => {
    if (!importing) return;
    const off = onStreamEvent((event) => {
      if (event.type !== 'style:import-progress') return;
      setProgress({ stage: event.stage, progress: event.progress });
      if (event.stage === 'done') {
        void load();
      }
    });
    return off;
  }, [importing, load]);

  const pickFiles = useCallback(async () => {
    const res = await styleApi.pickFiles();
    if (res.ok && res.canceled !== true) {
      // 契约收尾批次 4：paths 转可选（shared 冻结），缺省按空数组
      setForm((f) => ({ ...f, bookPaths: [...f.bookPaths, ...(res.paths ?? [])] }));
    }
  }, []);

  const removePath = useCallback((index: number) => {
    setForm((f) => ({ ...f, bookPaths: f.bookPaths.filter((_, i) => i !== index) }));
  }, []);

  const startImport = useCallback(async () => {
    setImporting(true);
    setProgress({ stage: 'chunking', progress: 0 });
    try {
      const res = await styleApi.import({
        authorName: form.authorName.trim(),
        genre: form.genre.trim(),
        bookPaths: form.bookPaths,
      });
      if (res.ok) {
        setFormOpen(false);
        setForm(EMPTY_FORM);
      } else {
        setError(res.error ?? '导入失败');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
      setProgress(null);
      void load();
    }
  }, [form, load]);

  const removeStyle = useCallback(
    async (styleId: string) => {
      const res = await styleApi.remove(styleId);
      if (!res.ok) setError(res.error ?? '删除失败');
      void load();
    },
    [load],
  );

  /** 立即自测（§15）：style:self-check → 按档案缓存结果 */
  const runSelfCheck = useCallback(async (styleId: string) => {
    setChecking((prev) => ({ ...prev, [styleId]: true }));
    try {
      const res = await styleApi.selfCheck(styleId);
      setChecks((prev) => ({ ...prev, [styleId]: res }));
    } catch (err) {
      setChecks((prev) => ({
        ...prev,
        [styleId]: { ok: false, error: err instanceof Error ? err.message : String(err) },
      }));
    } finally {
      setChecking((prev) => ({ ...prev, [styleId]: false }));
    }
  }, []);

  const reportStyle = reportId !== null ? styles.find((s) => s.id === reportId) : undefined;

  return (
    <div className="style-library">
      <div className="style-header">
        <span>作家风格库</span>
        <button type="button" onClick={() => setFormOpen(true)} disabled={importing}>
          + 导入作品
        </button>
      </div>

      {error !== null && <div className="style-error">{error}</div>}

      {formOpen && (
        <div className="style-import-form">
          <label>
            作者名
            <input
              value={form.authorName}
              onChange={(e) => setForm((f) => ({ ...f, authorName: e.target.value }))}
              disabled={importing}
            />
          </label>
          <label>
            类型
            <input
              value={form.genre}
              placeholder="如：网文 · 仙侠"
              onChange={(e) => setForm((f) => ({ ...f, genre: e.target.value }))}
              disabled={importing}
            />
          </label>
          <div className="style-books">
            <div className="style-books-header">
              <span>书籍（{form.bookPaths.length}）</span>
              <button type="button" onClick={() => void pickFiles()} disabled={importing}>
                选择文件…
              </button>
            </div>
            {form.bookPaths.map((p, i) => (
              <div key={`${p}-${i}`} className="style-book-row">
                <span className="style-book-path" title={p}>
                  {p}
                </span>
                <button type="button" onClick={() => removePath(i)} disabled={importing}>
                  删除
                </button>
              </div>
            ))}
          </div>
          {importing && progress !== null && (
            <div className="style-progress">
              <span>{STAGE_LABEL[progress.stage] ?? progress.stage}</span>
              <progress value={progress.progress} max={1} />
            </div>
          )}
          <div className="style-form-actions">
            <button
              type="button"
              onClick={() => void startImport()}
              disabled={importing || form.authorName.trim() === '' || form.bookPaths.length === 0}
            >
              {importing ? '导入中…' : '开始导入'}
            </button>
            <button type="button" onClick={() => setFormOpen(false)} disabled={importing}>
              取消
            </button>
          </div>
        </div>
      )}

      {styles.length === 0 && !formOpen ? (
        <div className="style-empty">暂无风格档案，点击「导入作品」创建。</div>
      ) : (
        styles.map((s) => (
          <div key={s.id} className="style-card">
            <div className="style-card-title">
              {s.authorName} · {s.genre}
            </div>
            <div className="style-card-meta">{corpusLine(s)}</div>
            <div className="style-card-meta">分析状态：已完成 · 最后更新 {formatDate(s.updatedAt)}</div>
            <div className="style-card-meta">{fingerprintLine(s)}</div>
            <div className="style-card-meta">
              风格相似度自测：
              {(() => {
                const check = checks[s.id];
                if (check === undefined) return '未自测';
                if (check.ok !== true) return check.error ?? '自测失败';
                if (check.skipped === true) return `跳过：${check.reason ?? ''}`;
                const score = check.score ?? 0;
                const threshold = check.threshold ?? 0;
                const pass = score >= threshold;
                return (
                  <>
                    {(score * 100).toFixed(0)}%（{BAND_LABEL[check.band ?? ''] ?? check.band} · 阈值{' '}
                    {(threshold * 100).toFixed(0)}%）{' '}
                    <span className={pass ? 'self-check--pass' : 'self-check--fail'}>
                      {pass ? '达标' : '未达标'}
                    </span>
                  </>
                );
              })()}
            </div>
            <div className="style-card-actions">
              <button type="button" onClick={() => setReportId(s.id)}>
                查看报告
              </button>
              <button
                type="button"
                onClick={() => void runSelfCheck(s.id)}
                disabled={checking[s.id] === true}
              >
                {checking[s.id] === true ? '自测中…' : '立即自测'}
              </button>
              <button type="button" onClick={() => void removeStyle(s.id)}>
                删除
              </button>
            </div>
          </div>
        ))
      )}

      {reportStyle !== undefined && (
        <div className="style-report-overlay" onClick={() => setReportId(null)}>
          <div className="style-report" onClick={(e) => e.stopPropagation()}>
            <div className="style-report-header">
              <span>
                {reportStyle.authorName} · 风格报告
              </span>
              <button type="button" onClick={() => setReportId(null)}>
                关闭
              </button>
            </div>
            <pre>{String(reportStyle.report['markdown'] ?? reportStyle.report['summary'] ?? '（无报告）')}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
