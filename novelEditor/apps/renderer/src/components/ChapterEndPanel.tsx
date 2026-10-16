/** 章节结束判定面板（review.chapter-end 暂停节点，SPEC §7.3 / §9.2）
 *
 * run 暂停在 review.chapter-end 时展示：章节草稿预览（暂停 payload 有 chapterDraft 则显示
 * 章号 / 段数 / 正文预览，无则纯按钮）+「继续下一章」「结束本章」两按钮。
 * 判定动作为 UserAction 的 chapter-end 成员（SPEC-CHANGELOG #16 扩展字段，#60 正式入契约）；
 * main 侧 readChapterEndDecision 读取 decision，缺省按 'end'。
 */

import { useWorkflowStore } from '../stores/workflowStore.js';

/** review.chapter-end execute 透传的暂停 payload 形状（chapter-accumulator ChapterDraft 子集） */
interface ChapterEndPayload {
  chapterDraft?: {
    chapterIndex?: number;
    text?: string;
    paragraphs?: unknown[];
  } | null;
  paragraphCount?: number;
}

export default function ChapterEndPanel() {
  const currentNodeId = useWorkflowStore((s) => s.currentNodeId);
  const pausedPayload = useWorkflowStore((s) => s.pausedPayload);
  const error = useWorkflowStore((s) => s.error);
  const resume = useWorkflowStore((s) => s.resume);

  if (currentNodeId === null) return null;

  const payload = (pausedPayload ?? {}) as ChapterEndPayload;
  const draft = payload.chapterDraft ?? null;

  /** 章节判定：UserAction 的 chapter-end 成员（decision 字段，SPEC-CHANGELOG #16/#60） */
  const decide = (decision: 'continue' | 'end') => {
    void resume(currentNodeId, { type: 'chapter-end', decision });
  };

  return (
    <div className="panel-block chapter-end-panel">
      <div className="candidate-panel-header">
        <span>章节结束判定</span>
        {draft?.chapterIndex !== undefined && (
          <span className="candidate-hint">第 {draft.chapterIndex} 章</span>
        )}
      </div>
      {error !== null && <div className="candidate-error">{error}</div>}
      {draft !== null && (
        <div className="chapter-end-meta">
          已积累 {payload.paragraphCount ?? draft.paragraphs?.length ?? 0} 段
        </div>
      )}
      {draft?.text != null && draft.text !== '' && (
        <div className="chapter-end-preview">{draft.text}</div>
      )}
      <div className="candidate-actions chapter-end-actions">
        <button
          type="button"
          className="candidate-btn candidate-btn--primary"
          onClick={() => decide('continue')}
        >
          继续下一章
        </button>
        <button type="button" className="candidate-btn" onClick={() => decide('end')}>
          结束本章
        </button>
      </div>
    </div>
  );
}
