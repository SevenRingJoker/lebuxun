/** ④ 右侧栏：候选对比 / 段落历史 / 章节累加器 / 成长面板（占位）
 *
 * Phase 4：候选对比块内嵌谱系可视化（CandidateLineage，§12.2 缩进树）。
 * Phase 5：新增「风格」tab 挂载风格库面板（§12.4）。
 * Phase 6：候选对比块上方挂候选面板（CandidatePanel，任务 6.5 快捷键入口）。
 * 收尾：CandidateLineage 接通 runId（workflowStore）与候选 id（selectedId 缺省取面板首个）；
 * 暂停面板互斥 —— 按当前暂停节点类型切换：review.candidate-picker → CandidatePanel，
 * review.chapter-end → ChapterEndPanel；非暂停态二者皆不显示。
 */

import { useState } from 'react';
import CandidateLineage from './CandidateLineage.js';
import CandidatePanel from './CandidatePanel.js';
import ChapterEndPanel from './ChapterEndPanel.js';
import StyleLibrary from './StyleLibrary.js';
import { useCandidateStore } from '../stores/candidateStore.js';
import { useWorkflowStore } from '../stores/workflowStore.js';
import { useProjectOverviewStore } from '../stores/projectOverviewStore.js';

const CHAPTER_STATUS_LABEL: Record<string, string> = {
  planned: '已规划',
  writing: '写作中',
  draft: '草稿',
  final: '已定稿',
};

const TABS = ['面板', '风格'] as const;
type Tab = (typeof TABS)[number];

export default function SidePanel() {
  const [tab, setTab] = useState<Tab>('面板');
  // 谱系数据源：当前 runId（workflowStore）+ 选中候选（无选中时取面板首个）
  const runId = useWorkflowStore((s) => s.runId);
  const selectedId = useCandidateStore((s) => s.selectedId);
  const firstCandidateId = useCandidateStore((s) => s.candidates[0]?.id);
  const lineageCandidateId = selectedId ?? firstCandidateId;
  const lineageProps =
    runId !== null && lineageCandidateId !== undefined
      ? { runId, candidateId: lineageCandidateId }
      : {};
  // 当前暂停节点类型（非暂停态为 null，驱动面板互斥）
  const pausedNodeType = useWorkflowStore((s) =>
    s.runStatus === 'paused' && s.currentNodeId !== null
      ? (s.workflow?.nodes.find((n) => n.id === s.currentNodeId)?.type ?? null)
      : null,
  );
  // token 级流式（§15）：生成中状态区（CandidatePanel 仅暂停时挂载，生成期间状态区放这里）
  const runStatus = useWorkflowStore((s) => s.runStatus);
  const tokenCount = useWorkflowStore((s) => s.tokenCount);
  const tokenTail = useWorkflowStore((s) => s.tokenTail);
  // 章节累加器实时值：chapter.accumulator 节点 done 事件写入 store（按章覆盖）
  const accumulatedCount = useWorkflowStore((s) => s.accumulatedCount);
  // 段落历史：项目章节（定稿后由 projectOverviewStore 自动刷新）
  const chapters = useProjectOverviewStore((s) => s.chapters);
  const finalizedChapters = chapters.filter((c) => c.status === 'final' || c.status === 'draft');
  return (
    <aside className="app-sidepanel">
      <div className="sidepanel-tabs">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            className={tab === t ? 'sidepanel-tab sidepanel-tab--active' : 'sidepanel-tab'}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === '风格' ? (
        <StyleLibrary />
      ) : (
        <>
          {runStatus === 'running' && tokenCount > 0 && (
            <div className="panel-block token-stream">
              生成中… 已接收 {tokenCount} token
              <div className="token-stream-tail">{tokenTail}</div>
            </div>
          )}
          {pausedNodeType === 'review.candidate-picker' && <CandidatePanel />}
          {pausedNodeType === 'review.chapter-end' && <ChapterEndPanel />}
          <div className="panel-block">
            候选对比
            <CandidateLineage {...lineageProps} />
          </div>
          <div className="panel-block">
            章节累加器
            <div className="sidepanel-sub">
              当前章节已累加 <strong>{accumulatedCount}</strong> 段
              {runStatus === 'running' || runStatus === 'paused' ? '' : '（未开始）'}
            </div>
          </div>
          <div className="panel-block">
            段落历史
            {finalizedChapters.length === 0 ? (
              <div className="sidepanel-sub">暂无定稿章节</div>
            ) : (
              <ul className="chapter-history">
                {finalizedChapters.map((c) => (
                  <li key={c.id} className="chapter-history-row">
                    <span className="chapter-history-title">
                      第 {c.index + 1} 章 · {c.title}
                    </span>
                    <span className="chapter-history-meta">
                      {CHAPTER_STATUS_LABEL[c.status] ?? c.status} · {c.wordCount} 字
                    </span>
                    {c.summary !== undefined && c.summary !== '' && (
                      <span className="chapter-history-summary">{c.summary}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </aside>
  );
}
