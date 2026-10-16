/** text-diff.ts 单测：句级 LCS diff（§14 任务 6.4） */

import { describe, expect, it } from 'vitest';
import type { DiffSegment } from '@novel-forge/shared';
import { diffTexts, MAX_DIFF_SENTENCES, splitSentences } from './text-diff.js';

/** 从 segments 重建 A 侧文本（same + del） */
function rebuildA(segments: DiffSegment[]): string {
  return segments
    .filter((s) => s.type !== 'add')
    .map((s) => s.text)
    .join('');
}

/** 从 segments 重建 B 侧文本（same + add） */
function rebuildB(segments: DiffSegment[]): string {
  return segments
    .filter((s) => s.type !== 'del')
    .map((s) => s.text)
    .join('');
}

describe('splitSentences', () => {
  it('按 。！？\\n 切句且分隔符保留在句尾', () => {
    expect(splitSentences('甲。乙！丙？丁\n戊')).toEqual(['甲。', '乙！', '丙？', '丁\n', '戊']);
  });

  it('空串 → 空数组；无分隔符 → 整段一句', () => {
    expect(splitSentences('')).toEqual([]);
    expect(splitSentences('没有标点')).toEqual(['没有标点']);
  });
});

describe('diffTexts', () => {
  it('完全相同 → 单个 same 段', () => {
    expect(diffTexts('甲。乙。', '甲。乙。')).toEqual([{ type: 'same', text: '甲。乙。' }]);
    expect(diffTexts('', '')).toEqual([]);
  });

  it('中间删一句 + 末尾加一句', () => {
    const segments = diffTexts('甲。乙。丙。', '甲。丙。丁。');
    expect(segments).toEqual([
      { type: 'same', text: '甲。' },
      { type: 'del', text: '乙。' },
      { type: 'same', text: '丙。' },
      { type: 'add', text: '丁。' },
    ]);
  });

  it('连续同类型段合并（整段替换）', () => {
    const segments = diffTexts('甲。乙。', '丙。丁。');
    // 无公共句 → del 合并 + add 合并
    expect(segments).toEqual([
      { type: 'del', text: '甲。乙。' },
      { type: 'add', text: '丙。丁。' },
    ]);
  });

  it('任意输入两侧文本均可从 segments 重建', () => {
    const a = '开头相同。A 侧独有。中段共有！A 又删。\n尾部 A。';
    const b = '开头相同。B 侧新增？中段共有！尾部 B。';
    const segments = diffTexts(a, b);
    expect(rebuildA(segments)).toBe(a);
    expect(rebuildB(segments)).toBe(b);
  });

  it(`任一侧超过 ${MAX_DIFF_SENTENCES} 句 → 退化为整段 del+add`, () => {
    const a = Array.from({ length: MAX_DIFF_SENTENCES + 1 }, (_, i) => `第${i}句。`).join('');
    const b = '短文本。';
    const segments = diffTexts(a, b);
    expect(segments).toEqual([
      { type: 'del', text: a },
      { type: 'add', text: b },
    ]);
    expect(rebuildA(segments)).toBe(a);
    expect(rebuildB(segments)).toBe(b);
  });
});
