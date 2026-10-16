/** styles / style_books 表仓库（SPEC §5.1），prepared statements
 *
 * §5.1 styles 表无 ragStats / discriminatorVersion / rewardModelVersion 独立列，
 * 连同 report 一起序列化进 report JSON 扩展字段（SPEC-CHANGELOG 登记）；
 * style_books 随档案整组替换（upsertProfile 先删后插）。
 */

import type { SceneType, StyleBook, StyleFingerprint, StyleProfile, StyleReport } from '@novel-forge/shared';
import type { AppDatabase } from '../index.js';

interface StyleRow {
  id: string;
  author_name: string;
  genre: string;
  book_count: number;
  fingerprint: string;
  report: string;
  created_at: number;
  updated_at: number;
}

interface StyleBookRow {
  id: string;
  style_id: string;
  title: string;
  word_count: number | null;
  chapter_count: number | null;
  path: string | null;
}

/** report JSON 中除 StyleReport 外的扩展字段（ragStats 等，无独立列） */
interface ReportExtra {
  ragStats?: { totalChunks: number; byScene: Record<SceneType, number> };
  discriminatorVersion?: string;
  rewardModelVersion?: string;
}

function emptyFingerprint(): StyleFingerprint {
  return {
    avgSentenceLength: 0,
    sentenceLengthStd: 0,
    shortSentenceRatio: 0,
    avgParagraphLength: 0,
    dialogueRatio: 0,
    metaphorDensity: 0,
    punctuation: {},
    topWords: [],
    signatureWords: [],
    forbiddenWords: [],
  };
}

export class StylesRepository {
  constructor(private readonly db: AppDatabase) {}

  /** 整组写入：styles 行 upsert + style_books 行先删后插 */
  upsertProfile(profile: StyleProfile): StyleProfile {
    const reportExtra: ReportExtra & StyleReport = {
      ...profile.report,
      ragStats: profile.ragStats,
      ...(profile.discriminatorVersion !== undefined
        ? { discriminatorVersion: profile.discriminatorVersion }
        : {}),
      ...(profile.rewardModelVersion !== undefined
        ? { rewardModelVersion: profile.rewardModelVersion }
        : {}),
    };
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO styles (id, author_name, genre, book_count, fingerprint, report, created_at, updated_at)
           VALUES (@id, @authorName, @genre, @bookCount, @fingerprint, @report, @createdAt, @updatedAt)
           ON CONFLICT(id) DO UPDATE SET
             author_name = @authorName, genre = @genre, book_count = @bookCount,
             fingerprint = @fingerprint, report = @report, updated_at = @updatedAt`,
        )
        .run({
          id: profile.id,
          authorName: profile.authorName,
          genre: profile.genre,
          bookCount: profile.bookCount,
          fingerprint: JSON.stringify(profile.fingerprint),
          report: JSON.stringify(reportExtra),
          createdAt: profile.createdAt,
          updatedAt: profile.updatedAt,
        });
      this.db.prepare('DELETE FROM style_books WHERE style_id = ?').run(profile.id);
      const insertBook = this.db.prepare(
        `INSERT INTO style_books (id, style_id, title, word_count, chapter_count, path)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const book of profile.books) {
        insertBook.run(
          book.id,
          profile.id,
          book.title,
          book.wordCount ?? null,
          book.chapterCount ?? null,
          book.path ?? null,
        );
      }
    });
    tx();
    return profile;
  }

  /** 组装回 StyleProfile；缺省字段给空值；不存在返回 undefined */
  getProfile(id: string): StyleProfile | undefined {
    const row = this.db.prepare('SELECT * FROM styles WHERE id = ?').get(id) as StyleRow | undefined;
    if (!row) return undefined;
    return this.rowToProfile(row);
  }

  /** 按 updated_at 降序（§12.4 风格卡片列表） */
  listProfiles(): StyleProfile[] {
    const rows = this.db
      .prepare('SELECT * FROM styles ORDER BY updated_at DESC')
      .all() as StyleRow[];
    return rows.map((r) => this.rowToProfile(r));
  }

  /** 最近更新一条（节点缺省 styleId 时取用）；无档案返回 undefined */
  latestProfile(): StyleProfile | undefined {
    const row = this.db
      .prepare('SELECT * FROM styles ORDER BY updated_at DESC LIMIT 1')
      .get() as StyleRow | undefined;
    return row ? this.rowToProfile(row) : undefined;
  }

  /** 连 books 一起删；返回是否存在该档案 */
  deleteProfile(id: string): boolean {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM style_books WHERE style_id = ?').run(id);
      return this.db.prepare('DELETE FROM styles WHERE id = ?').run(id);
    });
    return tx().changes > 0;
  }

  private rowToProfile(row: StyleRow): StyleProfile {
    const fingerprint = {
      ...emptyFingerprint(),
      ...(JSON.parse(row.fingerprint) as Partial<StyleFingerprint>),
    };
    const reportJson = JSON.parse(row.report) as ReportExtra & StyleReport;
    const { ragStats, discriminatorVersion, rewardModelVersion, ...report } = reportJson;
    const books = (
      this.db
        .prepare('SELECT * FROM style_books WHERE style_id = ? ORDER BY rowid ASC')
        .all(row.id) as StyleBookRow[]
    ).map(
      (b): StyleBook => ({
        id: b.id,
        styleId: b.style_id,
        title: b.title,
        ...(b.word_count != null ? { wordCount: b.word_count } : {}),
        ...(b.chapter_count != null ? { chapterCount: b.chapter_count } : {}),
        ...(b.path != null ? { path: b.path } : {}),
      }),
    );
    return {
      id: row.id,
      authorName: row.author_name,
      genre: row.genre,
      bookCount: row.book_count,
      books,
      fingerprint,
      report,
      ragStats: ragStats ?? { totalChunks: 0, byScene: {} as Record<SceneType, number> },
      ...(discriminatorVersion !== undefined ? { discriminatorVersion } : {}),
      ...(rewardModelVersion !== undefined ? { rewardModelVersion } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
