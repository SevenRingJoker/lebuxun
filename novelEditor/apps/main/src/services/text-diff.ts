/** SPEC §14 任务 6.4 版本对比：句级 LCS diff（candidate:diff IPC）
 *
 * 切句：按中文句号/问号/叹号/换行切分，分隔符保留在句尾（渲染时原样拼回）。
 * LCS DP 回溯输出 DiffSegment[]（same/del/add 序列，del 属 A 侧、add 属 B 侧）。
 * 防御：任一侧句数超 MAX_DIFF_SENTENCES 时 O(n²) DP 不可接受，退化为整段 del+add。
 */

import type { DiffSegment } from '@novel-forge/shared';

/** 句数防御上限：800×800 DP 约 64 万元素，再大退化为整段 diff（不炸即可） */
export const MAX_DIFF_SENTENCES = 800;

/** 按 。！？\n 切句，分隔符保留在句尾；空串返回空数组 */
export function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === '。' || ch === '！' || ch === '？' || ch === '\n') {
      sentences.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) sentences.push(text.slice(start));
  return sentences;
}

/** 合并相邻同类型段（LCS 回溯产物可能逐句碎裂，合并后更适合渲染） */
function mergeSegments(segments: DiffSegment[]): DiffSegment[] {
  const merged: DiffSegment[] = [];
  for (const seg of segments) {
    const last = merged[merged.length - 1];
    if (last && last.type === seg.type) {
      last.text += seg.text;
    } else {
      merged.push({ ...seg });
    }
  }
  return merged;
}

/** 句级 LCS diff：A→B 的最小编辑序列（same 共有 / del 仅 A / add 仅 B） */
export function diffTexts(textA: string, textB: string): DiffSegment[] {
  if (textA === textB) return textA === '' ? [] : [{ type: 'same', text: textA }];

  const a = splitSentences(textA);
  const b = splitSentences(textB);

  // 防御：任一侧过长 → 整段 del+add
  if (a.length > MAX_DIFF_SENTENCES || b.length > MAX_DIFF_SENTENCES) {
    const segments: DiffSegment[] = [];
    if (textA !== '') segments.push({ type: 'del', text: textA });
    if (textB !== '') segments.push({ type: 'add', text: textB });
    return segments;
  }

  // dp[i][j] = a 前 i 句与 b 前 j 句的 LCS 长度
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] =
        a[i] === b[j]
          ? dp[i + 1]![j + 1]! + 1
          : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  // 回溯：相等 → same；否则朝 LCS 更长的方向走（del 优先于 add，渲染顺序稳定）
  const segments: DiffSegment[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      segments.push({ type: 'same', text: a[i]! });
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      segments.push({ type: 'del', text: a[i]! });
      i += 1;
    } else {
      segments.push({ type: 'add', text: b[j]! });
      j += 1;
    }
  }
  while (i < n) {
    segments.push({ type: 'del', text: a[i]! });
    i += 1;
  }
  while (j < m) {
    segments.push({ type: 'add', text: b[j]! });
    j += 1;
  }
  return mergeSegments(segments);
}
