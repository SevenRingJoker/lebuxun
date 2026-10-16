/** Phase 6 候选面板（任务 6.5 快捷键）+ 收尾：主循环 UI 闭环
 *
 * 渲染 candidateStore 当前 runId/nodeId 下的候选卡片（序号角标 / 策略 / 均分 / 满意度）。
 * 每张卡片操作：
 *   编辑 —— 切换 textarea；「改后选」→ candidateStore.select(id, editedText)
 *   满意 —— satisfy(id)；不满意 —— 展开理由区（REASON_TAGS 多选 chips + 说明）→ dissatisfy
 *   改进 / 生成相似 —— 可带 hint 输入，分别调 regenerateFrom(id,'improve',hint) / regenerateSimilar(id,3)
 * 面板底部：「全弃」（可选理由）→ rejectAll(reason)；
 * 「确认选中并继续」主按钮（有 selectedId 可用）→ workflowStore.resume(nodeId, select 动作，
 * 若选中候选有未应用的编辑文本则带 editedText)。
 * 快捷键（window keydown，卸载清理）：
 *   数字键 1..9 —— 选中面板第 n 个候选（candidate:select）
 *   s —— 对当前 selectedId 候选标满意（candidate:satisfy）
 *   d —— 对当前 selectedId 候选标不满意（candidate:dissatisfy，不带理由）
 * 焦点在 input / textarea / contenteditable 时忽略全部快捷键；无候选 / 无选中时静默忽略。
 */

import { useEffect, useState } from 'react';
import type { Candidate, UserAction } from '@novel-forge/shared';
import { REASON_TAGS } from '@novel-forge/shared';
import { useCandidateStore } from '../stores/candidateStore.js';
import { useWorkflowStore } from '../stores/workflowStore.js';

const SATISFACTION_LABEL: Record<string, string> = {
  satisfied: '👍',
  unsatisfied: '👎',
  unrated: '—',
};

/** 数字键 1..9 对应的序号角标 */
const INDEX_BADGE = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨'];

/** 「生成相似」一次生成的候选数（§9.4 定向重生成默认批量） */
const SIMILAR_COUNT = 3;

/** 六维分数均值（§9.4） */
function avgScore(c: Candidate): number {
  const values = Object.values(c.scores);
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** 焦点是否处于可输入元素（此时忽略快捷键） */
function isEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA';
}

/** 混合选（§15）：计算当前选区相对元素全文的字符偏移 [start,end)；选区不在元素内或为空返回 null */
function selectionSpan(el: HTMLElement): [number, number] | null {
  const sel = window.getSelection();
  if (sel === null || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.commonAncestorContainer)) return null;
  const pre = range.cloneRange();
  pre.selectNodeContents(el);
  pre.setEnd(range.startContainer, range.startOffset);
  const start = pre.toString().length;
  const end = start + range.toString().length;
  return end > start ? [start, end] : null;
}

/** 混合篮条目（候选定位 + 片段区间 + 摘要） */
interface MixBasketItem {
  candidateId: string;
  index: number;
  span: [number, number];
  preview: string;
}

export default function CandidatePanel() {
  const candidates = useCandidateStore((s) => s.candidates);
  const selectedId = useCandidateStore((s) => s.selectedId);
  const runId = useCandidateStore((s) => s.runId);
  const nodeId = useCandidateStore((s) => s.nodeId);
  const error = useCandidateStore((s) => s.error);
  const select = useCandidateStore((s) => s.select);
  const satisfy = useCandidateStore((s) => s.satisfy);
  const dissatisfy = useCandidateStore((s) => s.dissatisfy);
  const regenerateFrom = useCandidateStore((s) => s.regenerateFrom);
  const regenerateSimilar = useCandidateStore((s) => s.regenerateSimilar);
  const pruneUnsatisfied = useCandidateStore((s) => s.pruneUnsatisfied);
  const rejectAll = useCandidateStore((s) => s.rejectAll);
  const mix = useCandidateStore((s) => s.mix);
  const resume = useWorkflowStore((s) => s.resume);
  const workflowError = useWorkflowStore((s) => s.error);

  // 面板本地 UI 状态（不入 store）：编辑中卡片 / 各卡片编辑稿 / 不满意理由区 / 改进提示 / 全弃理由
  const [editingId, setEditingId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [dissatisfyId, setDissatisfyId] = useState<string | null>(null);
  const [dissReason, setDissReason] = useState('');
  const [dissTags, setDissTags] = useState<string[]>([]);
  const [hints, setHints] = useState<Record<string, string>>({});
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  // 混合选（§15）：选段模式开关 + 混合篮（跨候选句级片段）
  const [mixMode, setMixMode] = useState(false);
  const [mixBasket, setMixBasket] = useState<MixBasketItem[]>([]);

  // 快捷键监听：卸载时清理
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditingTarget(e.target)) return;
      // 划选文本（混合选段等选择操作）时不触发快捷键
      const sel = window.getSelection();
      if (sel !== null && !sel.isCollapsed) return;
      const { candidates: list, selectedId: selId } = useCandidateStore.getState();
      if (list.length === 0) return;
      if (/^[1-9]$/.test(e.key)) {
        const index = Number(e.key) - 1;
        const target = list[index];
        if (target !== undefined) void select(target.id);
        return;
      }
      if (selId === null) return;
      if (e.key === 's' || e.key === 'S') {
        void satisfy(selId);
      } else if (e.key === 'd' || e.key === 'D') {
        void dissatisfy(selId);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [select, satisfy, dissatisfy]);

  if (runId === null) {
    return <div className="panel-block">候选（候选加载中…）</div>;
  }

  /** 不满意理由区标签切换 */
  const toggleDissTag = (tag: string) => {
    setDissTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));
  };

  /** 确认不满意标记并收起理由区 */
  const confirmDissatisfy = (candidateId: string) => {
    void dissatisfy(
      candidateId,
      dissReason.trim() !== '' ? dissReason.trim() : undefined,
      dissTags.length > 0 ? dissTags : undefined,
    );
    setDissatisfyId(null);
    setDissReason('');
    setDissTags([]);
  };

  /** 改后选：编辑稿非空即随 select 上送 editedText */
  const confirmEditSelect = (candidateId: string) => {
    const draft = drafts[candidateId];
    void select(candidateId, draft !== undefined && draft !== '' ? draft : undefined);
    setEditingId(null);
  };

  /** 确认选中并继续：选中候选若有编辑稿（与现文本不同）则带 editedText 恢复运行 */
  const confirmResume = () => {
    if (selectedId === null || nodeId === null) return;
    const current = candidates.find((c) => c.id === selectedId);
    const draft = drafts[selectedId];
    const action: UserAction = {
      type: 'select',
      candidateId: selectedId,
      ...(current !== undefined && draft !== undefined && draft !== '' && draft !== current.text
        ? { editedText: draft }
        : {}),
    };
    void resume(nodeId, action);
  };

  /** 混合选：选段模式下划选候选文本 → 片段入混合篮 */
  const handleSpanSelect = (c: Candidate, index: number, el: HTMLElement) => {
    if (!mixMode) return;
    const span = selectionSpan(el);
    if (span === null) return;
    const preview = c.text.slice(span[0], span[1]);
    setMixBasket((prev) => [...prev, { candidateId: c.id, index, span, preview }]);
    window.getSelection()?.removeAllRanges(); // 入篮后清选区，避免持续遮罩与快捷键误判
  };

  /** 混合选：合并篮内片段作为选中段落恢复运行 */
  const confirmMix = () => {
    if (mixBasket.length === 0 || nodeId === null) return;
    void mix(mixBasket.map(({ candidateId, span }) => ({ candidateId, span })));
    setMixBasket([]);
    setMixMode(false);
  };

  return (
    <div className="panel-block candidate-panel">
      <div className="candidate-panel-header">
        <span>候选（{candidates.length}）</span>
        <span className="candidate-hint">[1-9] 选择 [S] 满意 [D] 不满意</span>
        <button
          type="button"
          className="candidate-btn"
          title="清除所有标记为不满意的候选（candidate:prune-unsatisfied）"
          disabled={!candidates.some((c) => c.satisfaction === 'unsatisfied')}
          onClick={() => void pruneUnsatisfied()}
        >
          🧹 清除不满意
        </button>
        <button
          type="button"
          className={`candidate-btn${mixMode ? ' candidate-btn--primary' : ''}`}
          onClick={() => {
            setMixMode((m) => !m);
            if (mixMode) setMixBasket([]); // 退出选段清空混合篮
          }}
        >
          {mixMode ? '退出选段' : '选段'}
        </button>
      </div>
      {(error ?? workflowError) !== null && (
        <div className="candidate-error">{error ?? workflowError}</div>
      )}
      {candidates.map((c, i) => (
        <div
          key={c.id}
          className={`candidate-card${selectedId === c.id ? ' candidate-card--selected' : ''}`}
          onClick={() => {
            // 选段模式下点击卡片不触发选中（避免与划选冲突）
            if (!mixMode) void select(c.id);
          }}
        >
          <div className="candidate-card-header">
            <span className="candidate-badge">{INDEX_BADGE[i] ?? `${i + 1}.`}</span>
            <span className="candidate-strategy">
              {c.strategy.label} · {c.strategy.temperature}
            </span>
            <span className="candidate-meta">
              {SATISFACTION_LABEL[c.satisfaction] ?? c.satisfaction} · 均分 {avgScore(c).toFixed(2)}
            </span>
          </div>
          {editingId === c.id ? (
            <textarea
              className="candidate-edit-area"
              value={drafts[c.id] ?? c.text}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setDrafts((prev) => ({ ...prev, [c.id]: e.target.value }))}
              rows={6}
            />
          ) : (
            <div
              className="candidate-text"
              onMouseUp={(e) => handleSpanSelect(c, i, e.currentTarget)}
            >
              {c.text}
            </div>
          )}
          <div className="candidate-actions" onClick={(e) => e.stopPropagation()}>
            {editingId === c.id ? (
              <>
                <button type="button" className="candidate-btn candidate-btn--primary" onClick={() => confirmEditSelect(c.id)}>
                  改后选
                </button>
                <button type="button" className="candidate-btn" onClick={() => setEditingId(null)}>
                  取消编辑
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="candidate-btn"
                  onClick={() => {
                    setEditingId(c.id);
                    setDrafts((prev) => ({ ...prev, [c.id]: prev[c.id] ?? c.text }));
                  }}
                >
                  编辑
                </button>
                <button type="button" className="candidate-btn" onClick={() => void satisfy(c.id)}>
                  满意
                </button>
                <button
                  type="button"
                  className="candidate-btn"
                  onClick={() => setDissatisfyId(dissatisfyId === c.id ? null : c.id)}
                >
                  不满意
                </button>
                <button
                  type="button"
                  className="candidate-btn"
                  onClick={() =>
                    void regenerateFrom(c.id, 'improve', (hints[c.id] ?? '').trim() || undefined)
                  }
                >
                  改进
                </button>
                <button
                  type="button"
                  className="candidate-btn"
                  title="保持同段落设定，换一种写作风格重新生成 3 个候选（variant）"
                  onClick={() => void regenerateFrom(c.id, 'variant')}
                >
                  换风格
                </button>
                <button
                  type="button"
                  className="candidate-btn"
                  onClick={() => void regenerateSimilar(c.id, SIMILAR_COUNT)}
                >
                  生成相似
                </button>
                <input
                  className="candidate-hint-input"
                  placeholder="改进提示（可选）"
                  value={hints[c.id] ?? ''}
                  onChange={(e) => setHints((prev) => ({ ...prev, [c.id]: e.target.value }))}
                />
              </>
            )}
          </div>
          {dissatisfyId === c.id && (
            <div className="candidate-reason-area" onClick={(e) => e.stopPropagation()}>
              <div className="candidate-reason-tags">
                {REASON_TAGS.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    className={`candidate-tag-chip${dissTags.includes(tag) ? ' candidate-tag-chip--active' : ''}`}
                    onClick={() => toggleDissTag(tag)}
                  >
                    {tag}
                  </button>
                ))}
              </div>
              <input
                className="candidate-reason-input"
                placeholder="不满意说明（可选）"
                value={dissReason}
                onChange={(e) => setDissReason(e.target.value)}
              />
              <div className="candidate-actions">
                <button
                  type="button"
                  className="candidate-btn candidate-btn--primary"
                  onClick={() => confirmDissatisfy(c.id)}
                >
                  确认不满意
                </button>
                <button type="button" className="candidate-btn" onClick={() => setDissatisfyId(null)}>
                  取消
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
      <div className="candidate-panel-footer">
        {mixBasket.length > 0 && (
          <div className="mix-basket">
            {mixBasket.map((item, i) => (
              <div key={`${item.candidateId}-${i}`} className="mix-basket-row">
                <span className="mix-basket-text">
                  {INDEX_BADGE[item.index] ?? `${item.index + 1}.`} {item.preview}
                </span>
                <button
                  type="button"
                  className="candidate-btn"
                  onClick={() => setMixBasket((prev) => prev.filter((_, j) => j !== i))}
                >
                  移除
                </button>
              </div>
            ))}
          </div>
        )}
        {mixMode && (
          <button
            type="button"
            className="candidate-btn candidate-btn--primary"
            disabled={mixBasket.length === 0 || nodeId === null}
            onClick={confirmMix}
          >
            合并选中（{mixBasket.length}）
          </button>
        )}
        {rejectOpen ? (
          <div className="candidate-reject-row">
            <input
              className="candidate-reason-input"
              placeholder="全弃理由（可选）"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
            />
            <button
              type="button"
              className="candidate-btn"
              onClick={() => {
                void rejectAll(rejectReason.trim() !== '' ? rejectReason.trim() : undefined);
                setRejectOpen(false);
                setRejectReason('');
              }}
            >
              确认全弃
            </button>
            <button type="button" className="candidate-btn" onClick={() => setRejectOpen(false)}>
              取消
            </button>
          </div>
        ) : (
          <button type="button" className="candidate-btn" onClick={() => setRejectOpen(true)}>
            全弃
          </button>
        )}
        <button
          type="button"
          className="candidate-btn candidate-btn--primary candidate-confirm"
          disabled={selectedId === null || nodeId === null}
          onClick={confirmResume}
        >
          确认选中并继续
        </button>
      </div>
    </div>
  );
}
