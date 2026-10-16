/** settings 表仓库（收尾批次 3：设置面板持久化，SPEC §5.1 settings），JSON 序列化存取 */

import type { AppDatabase } from '../index.js';

export class SettingsRepository {
  constructor(private readonly db: AppDatabase) {}

  /** 读 key 的 JSON 值；不存在或 JSON 损坏时返回 undefined（视为未设置） */
  get<T = unknown>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return undefined;
    }
  }

  /** upsert：value 以 JSON 文本落库，updated_at 记当前时间 */
  set(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (@key, @value, @updatedAt)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run({ key, value: JSON.stringify(value), updatedAt: Date.now() });
  }

  delete(key: string): boolean {
    return this.db.prepare('DELETE FROM settings WHERE key = ?').run(key).changes > 0;
  }
}
