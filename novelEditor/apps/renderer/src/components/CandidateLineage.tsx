/** Phase 4 谱系可视化（task 4.5 / SPEC §12.2 谱系展示）
 *
 * 简单缩进树（不引图库）：每行显示 策略标签 · 满意度 · avgScore，
 * 点击节点在下方查看正文与六维分数。数据来自 candidate:lineage IPC。
 * Phase 6（任务 6.4）：有父候选的节点提供「与父对比」入口，调 candidate:diff
 * 在下方渲染 CandidateDiff 双栏对比（A=父，B=子）。
 */

import { useCallback, useEffect, useState } from 'react';
import type { CandidateLineageNode } from '@novel-forge/shared';
import { invoke } from '../ipc/index.js';
import CandidateDiff from './CandidateDiff.js';

const SATISFACTION_LABEL: Record<string, string> = {
  satisfied: '👍 满意',
  unsatisfied: '👎 不满意',
  unrated: '未标记',
};

interface CandidateLineageProps {
  runId?: string;
  candidateId?: string;
}

/** 版本对比对：A=父候选，B=子候选（del 属父侧、add 属子侧） */
interface DiffPair {
  a: string;
  b: string;
}

function LineageRow(props: {
  node: CandidateLineageNode;
  depth: number;
  selectedId: string | null;
  onSelect: (node: CandidateLineageNode) => void;
  onCompare: (pair: DiffPair) => void;
}) {
  const { node, depth, selectedId, onSelect, onCompare } = props;
  const c = node.candidate;
  return (
    <>
      <div
        className={`lineage-row${selectedId === c.id ? ' lineage-row--selected' : ''}`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        <button type="button" className="lineage-main" onClick={() => onSelect(node)}>
          <span className="lineage-label">
            {depth > 0 ? '└ ' : ''}
            {c.strategy.label} · {c.strategy.temperature}
          </span>
          <span className="lineage-meta">
            {c.generationMode !== 'fresh' ? `${c.generationMode} · 深度 ${c.generationDepth} · ` : '原始 · '}
            {SATISFACTION_LABEL[c.satisfaction] ?? c.satisfaction} · 均分 {node.avgScore.toFixed(2)}
          </span>
        </button>
        {c.parentCandidateId !== undefined && (
          <button
            type="button"
            className="lineage-compare"
            title="与父候选对比"
            onClick={() => onCompare({ a: c.parentCandidateId as string, b: c.id })}
          >
            对比
          </button>
        )}
      </div>
      {node.children.map((child) => (
        <LineageRow
          key={child.candidate.id}
          node={child}
          depth={depth + 1}
          selectedId={selectedId}
          onSelect={onSelect}
          onCompare={onCompare}
        />
      ))}
    </>
  );
}

export default function CandidateLineage({ runId, candidateId }: CandidateLineageProps) {
  const [tree, setTree] = useState<CandidateLineageNode | null>(null);
  const [selected, setSelected] = useState<CandidateLineageNode | null>(null);
  const [diffPair, setDiffPair] = useState<DiffPair | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (runId === undefined || candidateId === undefined) return;
    try {
      const res = await invoke('candidate:lineage', { runId, candidateId });
      if (res.ok && res.lineage !== undefined) {
        setTree(res.lineage);
        setError(null);
      } else {
        setError(res.error ?? '谱系加载失败');
      }
    } catch (err) {
      // 非 Electron 环境（纯 vite 预览）下降级为空态
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [runId, candidateId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (runId === undefined || candidateId === undefined) {
    return <div className="panel-block">谱系（选择候选后展示）</div>;
  }
  if (error !== null) {
    return <div className="panel-block">谱系加载失败：{error}</div>;
  }
  if (tree === null) {
    return <div className="panel-block">谱系加载中…</div>;
  }

  return (
    <div className="panel-block candidate-lineage">
      <div className="lineage-tree">
        <LineageRow
          node={tree}
          depth={0}
          selectedId={selected?.candidate.id ?? null}
          onSelect={setSelected}
          onCompare={setDiffPair}
        />
      </div>
      {selected !== null && (
        <div className="lineage-detail">
          <p className="lineage-text">{selected.candidate.text}</p>
          <ul className="lineage-scores">
            {Object.entries(selected.candidate.scores).map(([dim, v]) => (
              <li key={dim}>
                {dim}: {v.toFixed(2)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {diffPair !== null && (
        <CandidateDiff
          candidateIdA={diffPair.a}
          candidateIdB={diffPair.b}
          onClose={() => setDiffPair(null)}
        />
      )}
    </div>
  );
}
