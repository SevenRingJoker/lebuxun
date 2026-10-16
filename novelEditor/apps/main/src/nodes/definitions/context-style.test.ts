/** context.style 单测：无风格 / 指定 styleId / 缺省最近风格 / 报告截断 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { SceneType, StyleProfile } from '@novel-forge/shared';
import { openDatabase, type AppDatabase } from '../../db/index.js';
import { StylesRepository } from '../../db/repositories/styles.js';
import { contextStyleNode, DEFAULT_STYLE_PROMPT } from './context-style.js';
import { makeCtx } from './test-helpers.js';

let db: AppDatabase;
let styles: StylesRepository;

function makeProfile(overrides: Partial<StyleProfile> = {}): StyleProfile {
  const now = Date.now();
  return {
    id: 's1',
    authorName: '作家X',
    genre: '仙侠',
    bookCount: 1,
    books: [],
    fingerprint: {
      avgSentenceLength: 14.46,
      sentenceLengthStd: 6.2,
      shortSentenceRatio: 0.312,
      avgParagraphLength: 88,
      dialogueRatio: 0.424,
      metaphorDensity: 3.5,
      punctuation: {},
      topWords: [],
      signatureWords: ['蓦地', '霎时', '陡然', '赫然'],
      forbiddenWords: [],
    },
    report: { markdown: '# 风格报告\n\n善用短句与反转。' },
    ragStats: { totalChunks: 0, byScene: {} as Record<SceneType, number> },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function run(params: Record<string, unknown>): Promise<{ stylePrompt: string }> {
  const { ctx } = makeCtx(db, { params, nodeType: 'context.style' });
  return (await contextStyleNode.execute(ctx, {})) as { stylePrompt: string };
}

beforeEach(async () => {
  db = await openDatabase(':memory:');
  styles = new StylesRepository(db);
});

describe('context.style', () => {
  it('无风格档案 → 缺省「你是小说作家。」', async () => {
    const out = await run({});
    expect(out.stylePrompt).toBe(DEFAULT_STYLE_PROMPT);
  });

  it('指定 styleId 不存在 → 缺省提示', async () => {
    const out = await run({ styleId: 'ghost' });
    expect(out.stylePrompt).toBe(DEFAULT_STYLE_PROMPT);
  });

  it('指定 styleId：报告 markdown + 指纹摘要行', async () => {
    styles.upsertProfile(makeProfile());
    const out = await run({ styleId: 's1' });

    expect(out.stylePrompt).toContain('# 风格报告');
    expect(out.stylePrompt).toContain('善用短句与反转。');
    // 指纹摘要行：句长 X.X · 对白 XX% · 短句比 XX% · 标志词 a/b/c（取前 3 个）
    expect(out.stylePrompt).toContain('句长 14.5');
    expect(out.stylePrompt).toContain('对白 42%');
    expect(out.stylePrompt).toContain('短句比 31%');
    expect(out.stylePrompt).toContain('标志词 蓦地/霎时/陡然');
  });

  it('缺省 styleId 时取最近更新一条', async () => {
    styles.upsertProfile(makeProfile({ id: 's1', authorName: '旧作家', updatedAt: 100 }));
    styles.upsertProfile(makeProfile({ id: 's2', authorName: '新作家', updatedAt: 200 }));

    const { ctx, logs } = makeCtx(db, { params: {}, nodeType: 'context.style' });
    const out = (await contextStyleNode.execute(ctx, {})) as { stylePrompt: string };
    expect(logs.some((l) => l.includes('新作家'))).toBe(true);
    expect(out.stylePrompt).toContain('# 风格报告');
  });

  it('maxReportChars 截断报告 markdown', async () => {
    const longReport = '报'.repeat(2000);
    styles.upsertProfile(makeProfile({ report: { markdown: longReport } }));

    const out = await run({ styleId: 's1', maxReportChars: 1200 });
    // 截断到 1200 字 + 省略号，指纹行仍完整
    expect(out.stylePrompt.startsWith('报'.repeat(1200) + '…')).toBe(true);
    expect(out.stylePrompt).not.toContain('报'.repeat(1201));
    expect(out.stylePrompt).toContain('【风格指纹】');
  });
});
