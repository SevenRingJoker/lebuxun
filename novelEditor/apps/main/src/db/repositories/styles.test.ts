/** StylesRepository 单测：upsertProfile/getProfile/listProfiles/latestProfile/deleteProfile
 *
 * ragStats / discriminatorVersion 无独立列，序列化进 report JSON（SPEC-CHANGELOG 登记）。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { SceneType, StyleProfile } from '@novel-forge/shared';
import { openDatabase, type AppDatabase } from '../index.js';
import { StylesRepository } from './styles.js';

let db: AppDatabase;
let styles: StylesRepository;

function makeProfile(overrides: Partial<StyleProfile> = {}): StyleProfile {
  const now = Date.now();
  return {
    id: 's1',
    authorName: '作家X',
    genre: '仙侠',
    bookCount: 1,
    books: [
      { id: 'b1', styleId: 's1', title: '书一', wordCount: 100000, chapterCount: 200, path: 'data/books/1.txt' },
    ],
    fingerprint: {
      avgSentenceLength: 14.5,
      sentenceLengthStd: 6.2,
      shortSentenceRatio: 0.31,
      avgParagraphLength: 88,
      dialogueRatio: 0.42,
      metaphorDensity: 3.5,
      punctuation: { '，': 0.5, '。': 0.3 },
      topWords: ['剑', '风'],
      signatureWords: ['蓦地', '霎时'],
      forbiddenWords: [],
    },
    report: { markdown: '# 风格报告\n\n善用短句。', summary: '短句流' },
    ragStats: { totalChunks: 120, byScene: { battle: 40, daily: 80 } as Record<SceneType, number> },
    discriminatorVersion: 'd1',
    rewardModelVersion: 'r1',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

beforeEach(async () => {
  db = await openDatabase(':memory:');
  styles = new StylesRepository(db);
});

describe('StylesRepository', () => {
  it('upsertProfile + getProfile 完整往返（含 ragStats / 版本号 / books）', () => {
    const profile = makeProfile();
    styles.upsertProfile(profile);

    const got = styles.getProfile('s1');
    expect(got).toEqual(profile);
    expect(got?.ragStats.totalChunks).toBe(120);
    expect(got?.discriminatorVersion).toBe('d1');
    expect(got?.books).toHaveLength(1);
  });

  it('重复 upsert：styles 行更新且 style_books 整组替换', () => {
    styles.upsertProfile(makeProfile());
    styles.upsertProfile(
      makeProfile({
        bookCount: 2,
        books: [
          { id: 'b2', styleId: 's1', title: '书二' },
          { id: 'b3', styleId: 's1', title: '书三' },
        ],
        updatedAt: Date.now() + 1000,
      }),
    );

    const got = styles.getProfile('s1');
    expect(got?.bookCount).toBe(2);
    expect(got?.books.map((b) => b.id)).toEqual(['b2', 'b3']);
    const bookRows = db.prepare('SELECT COUNT(*) AS n FROM style_books WHERE style_id = ?').get('s1') as {
      n: number;
    };
    expect(bookRows.n).toBe(2);
  });

  it('getProfile 缺省字段给空值（report 无扩展字段时）', () => {
    db.prepare(
      `INSERT INTO styles (id, author_name, genre, book_count, fingerprint, report, created_at, updated_at)
       VALUES ('s2', '作家Y', '都市', 0, '{}', '{"markdown":"m"}', 1, 1)`,
    ).run();

    const got = styles.getProfile('s2');
    expect(got?.fingerprint.avgSentenceLength).toBe(0);
    expect(got?.fingerprint.signatureWords).toEqual([]);
    expect(got?.ragStats).toEqual({ totalChunks: 0, byScene: {} });
    expect(got?.discriminatorVersion).toBeUndefined();
    expect(got?.books).toEqual([]);
  });

  it('listProfiles 按 updated_at 降序；latestProfile 取最近一条', () => {
    styles.upsertProfile(makeProfile({ id: 's1', updatedAt: 100 }));
    styles.upsertProfile(makeProfile({ id: 's2', books: [], updatedAt: 300 }));
    styles.upsertProfile(makeProfile({ id: 's3', books: [], updatedAt: 200 }));

    expect(styles.listProfiles().map((p) => p.id)).toEqual(['s2', 's3', 's1']);
    expect(styles.latestProfile()?.id).toBe('s2');
  });

  it('deleteProfile 连 books 一起删；不存在返回 false', () => {
    styles.upsertProfile(makeProfile());
    expect(styles.deleteProfile('s1')).toBe(true);
    expect(styles.getProfile('s1')).toBeUndefined();
    const bookRows = db.prepare('SELECT COUNT(*) AS n FROM style_books WHERE style_id = ?').get('s1') as {
      n: number;
    };
    expect(bookRows.n).toBe(0);
    expect(styles.deleteProfile('s1')).toBe(false);
  });

  it('空库 latestProfile 返回 undefined', () => {
    expect(styles.latestProfile()).toBeUndefined();
    expect(styles.getProfile('不存在')).toBeUndefined();
  });
});
