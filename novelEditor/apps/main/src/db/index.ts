/** SPEC §5.1 / §5.4：openDatabase → pragma → umzug migrations → Database */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { Umzug } from 'umzug';
import type { MigrationParams, UmzugStorage } from 'umzug';

export type AppDatabase = Database.Database;

/** schema_migrations 由 001_init.sql 自建，storage 需容忍表不存在 */
class BetterSqliteStorage implements UmzugStorage {
  constructor(private readonly db: AppDatabase) {}

  async executed(): Promise<string[]> {
    const hasTable = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
      .get();
    if (!hasTable) return [];
    const rows = this.db
      .prepare('SELECT version FROM schema_migrations ORDER BY applied_at ASC')
      .all() as { version: string }[];
    return rows.map((r) => r.version);
  }

  async logMigration({ name }: { name: string }): Promise<void> {
    this.db
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run(name, Date.now());
  }

  async unlogMigration({ name }: { name: string }): Promise<void> {
    // 001_init_down.sql 会 DROP schema_migrations 本身：表不存在时容忍（视为已 unlog）
    const hasTable = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
      .get();
    if (!hasTable) return;
    this.db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(name);
  }
}

/** 兼容 vitest（ESM）与 esbuild CJS 产物两种运行形态 */
function moduleDir(): string {
  if (typeof __dirname !== 'undefined') return __dirname;
  return path.dirname(fileURLToPath(import.meta.url));
}

function defaultMigrationsDir(): string {
  // 产物形态：dist/migrations（构建脚本拷贝）；源码形态（vitest）：src/db/migrations
  const here = moduleDir();
  const candidates = [
    path.join(here, 'migrations'),
    path.join(here, 'db', 'migrations'),
    path.join(here, '..', 'src', 'db', 'migrations'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return candidates[0]!;
}

export interface OpenDatabaseOptions {
  migrationsDir?: string;
  /** 测试用 ':memory:'；默认按文件路径打开 */
}

/** 构建迁移器：up 只注册 `{name}.sql`（`*_down.sql` 是回滚脚本，不参与 up 排序）；
 *  down 按命名约定探测同名 `{name}_down.sql`，存在则 exec 回滚，不存在抛错。 */
export function createMigrator(db: AppDatabase, migrationsDir = defaultMigrationsDir()): Umzug {
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('_down.sql'))
    .sort();

  return new Umzug({
    migrations: files.map((file) => {
      const name = file.replace(/\.sql$/, '');
      const downFile = `${name}_down.sql`;
      const downPath = path.join(migrationsDir, downFile);
      const hasDown = fs.existsSync(downPath);
      return {
        name,
        up: async (_params: MigrationParams<unknown>) => {
          db.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
        },
        down: async () => {
          if (!hasDown) {
            throw new Error(`migration ${file} 不支持回滚（缺少 ${downFile}）`);
          }
          db.exec(fs.readFileSync(downPath, 'utf8'));
        },
      };
    }),
    storage: new BetterSqliteStorage(db),
    logger: undefined,
  });
}

export async function openDatabase(
  dbPath: string,
  options: OpenDatabaseOptions = {},
): Promise<AppDatabase> {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);

  // SPEC §5.1 pragma（WAL 模式下 Node/Python 双进程读写不互斥）
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  const umzug = createMigrator(db, options.migrationsDir ?? defaultMigrationsDir());
  await umzug.up();
  return db;
}
