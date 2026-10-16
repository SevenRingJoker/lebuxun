/** Phase 6 候选版本对比视图（任务 6.4）
 *
 * 调 candidate:diff 取句级 segments，左右双栏渲染：
 * 左栏为版本 A（显 same + del，del 红底删除线），右栏为版本 B（显 same + add，add 绿底）。
 * 含加载 / 错误态。
 */

import { useEffect, useState } from 'react';
import type { DiffSegment } from '@novel-forge/shared';
import { candidateApi } from '../ipc/index.js';

interface CandidateDiffProps {
  candidateIdA: string;
  candidateIdB: string;
  onClose: () => void;
}

/** 单栏：side='a' 显 same+del，side='b' 显 same+add */
function DiffColumn(props: { segments: DiffSegment[]; side: 'a' | 'b' }) {
  const { segments, side } = props;
  const visible = segments.filter((seg) =>
    seg.type === 'same' ? true : side === 'a' ? seg.type === 'del' : seg.type === 'add',
  );
  return (
    <div className="diff-column">
      {visible.map((seg, i) => (
        <span
          key={i}
          className={
            seg.type === 'del' ? 'diff-seg diff-seg--del' : seg.type === 'add' ? 'diff-seg diff-seg--add' : 'diff-seg'
          }
        >
          {seg.text}
        </span>
      ))}
    </div>
  );
}

export default function CandidateDiff({ candidateIdA, candidateIdB, onClose }: CandidateDiffProps) {
  const [segments, setSegments] = useState<DiffSegment[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSegments(null);
    setError(null);
    candidateApi
      .diff(candidateIdA, candidateIdB)
      .then((res) => {
        if (cancelled) return;
        if (res.ok && res.segments !== undefined) {
          setSegments(res.segments);
        } else {
          setError(res.error ?? '对比加载失败');
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [candidateIdA, candidateIdB]);

  return (
    <div className="candidate-diff">
      <div className="diff-header">
        <span>版本对比</span>
        <button type="button" onClick={onClose}>
          关闭
        </button>
      </div>
      {error !== null ? (
        <div className="diff-status diff-status--error">对比加载失败:{error}</div>
      ) : segments === null ? (
        <div className="diff-status">对比加载中…</div>
      ) : (
        <div className="diff-columns">
          <div className="diff-pane">
            <div className="diff-pane-title">版本 A</div>
            <DiffColumn segments={segments} side="a" />
          </div>
          <div className="diff-pane">
            <div className="diff-pane-title">版本 B</div>
            <DiffColumn segments={segments} side="b" />
          </div>
        </div>
      )}
    </div>
  );
}
