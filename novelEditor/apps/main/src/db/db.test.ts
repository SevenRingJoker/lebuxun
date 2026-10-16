import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMigrator, openDatabase, type AppDatabase } from './index.js';
import { ProjectsRepository } from './repositories/projects.js';
import { CandidatesRepository } from './repositories/candidates.js';
import type { Candidate, Project } from '@novel-forge/shared';

let tmpDir: string;
let db: AppDatabase;
let projects: ProjectsRepository;
let candidates: CandidatesRepository;

function makeProject(overrides: Partial<Project> = {}): Project {
  const now = Date.now();
  return {
    id: 'p1',
    name: '测试项目',
    genre: '仙侠',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** 候选外键链：project → workflow → run */
function seedRun(runId = 'r1', projectId = 'p1'): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO workflows (id, project_id, name, graph, version, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('w1', projectId, '默认工作流', '{"nodes":[],"edges":[]}', 1, now);
  db.prepare(
    `INSERT INTO runs (id, workflow_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(runId, 'w1', 'running', now, now);
}

function makeCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: 'c1',
    runId: 'r1',
    nodeId: 'n1',
    index: 0,
    text: '候选文本',
    strategy: { label: '稳健', temperature: 0.5 },
    scores: {
      pacing: 0.6,
      character: 0.8,
      consistency: 0.7,
      profileFit: 0.5,
      styleSimilarity: 0.72,
      rewardScore: 0.66,
    },
    satisfaction: 'unrated',
    generationMode: 'fresh',
    generationDepth: 0,
    lineage: [],
    ...overrides,
  };
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-db-'));
  db = await openDatabase(path.join(tmpDir, 'test.db'));
  projects = new ProjectsRepository(db);
  candidates = new CandidatesRepository(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('openDatabase + migrations', () => {
  it('执行 SPEC §5.1 pragma 并建出全部表', () => {
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('synchronous', { simple: true })).toBe(1); // NORMAL
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);

    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as { name: string }[]
    ).map((r) => r.name);
    for (const t of [
      'schema_migrations', 'projects', 'chapters', 'paragraphs', 'workflows', 'runs',
      'candidates', 'candidate_lineage', 'evolution_patterns', 'satisfaction_tags',
      'styles', 'style_books', 'rag_chunks', 'preference_samples', 'growth_stats',
      'prompt_versions', 'memory_chunks', 'settings',
    ]) {
      expect(tables).toContain(t);
    }
  });

  it('migration 幂等：同一库重复 openDatabase 不报错', async () => {
    const dbPath = path.join(tmpDir, 'again.db');
    const first = await openDatabase(dbPath);
    first.close();
    const second = await openDatabase(dbPath);
    const versions = second
      .prepare('SELECT version FROM schema_migrations')
      .all() as { version: string }[];
    expect(versions.map((v) => v.version)).toEqual(['001_init', '002_memory_chunks', '003_settings']);
    second.close();
  });

  it('migration down 回滚：down({to:0}) 业务表全部消失，再 up 幂等恢复', async () => {
    const mem = await openDatabase(':memory:');
    const migrator = createMigrator(mem);
    const tableNames = (): string[] =>
      (mem.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
        (r) => r.name,
      );

    await migrator.down({ to: 0 });

    const afterDown = tableNames();
    for (const t of [
      'schema_migrations', 'projects', 'chapters', 'paragraphs', 'workflows', 'runs',
      'candidates', 'candidate_lineage', 'evolution_patterns', 'satisfaction_tags',
      'styles', 'style_books', 'rag_chunks', 'preference_samples', 'growth_stats',
      'prompt_versions', 'memory_chunks', 'settings',
    ]) {
      expect(afterDown).not.toContain(t);
    }

    // 再 up：全量恢复（幂等），版本记录按序重放
    await migrator.up();
    const afterUp = tableNames();
    for (const t of ['projects', 'candidates', 'styles', 'memory_chunks', 'settings', 'schema_migrations']) {
      expect(afterUp).toContain(t);
    }
    const versions = mem.prepare('SELECT version FROM schema_migrations').all() as { version: string }[];
    expect(versions.map((v) => v.version)).toEqual(['001_init', '002_memory_chunks', '003_settings']);
    mem.close();
  });

  it('parent_candidate_id 索引存在', () => {
    const indexes = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='candidates'")
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(indexes).toContain('idx_candidates_parent');
    expect(indexes).toContain('idx_candidates_satisfaction');
  });
});

describe('ProjectsRepository', () => {
  it('增 / 查 / 列 / 删', () => {
    const p = makeProject();
    projects.insert(p);
    expect(projects.get('p1')).toEqual(p);

    projects.insert(makeProject({ id: 'p2', name: '第二个' }));
    expect(projects.list().map((x) => x.id).sort()).toEqual(['p1', 'p2']);

    expect(projects.remove('p1')).toBe(true);
    expect(projects.get('p1')).toBeUndefined();
    expect(projects.remove('p1')).toBe(false);
  });
});

describe('CandidatesRepository', () => {
  it('插入与查询，satisfaction 默认 unrated', () => {
    projects.insert(makeProject());
    seedRun();
    const c = makeCandidate();
    candidates.insert(c);

    const got = candidates.get('c1');
    expect(got).toEqual(c);
    expect(got?.satisfaction).toBe('unrated');

    const raw = db
      .prepare('SELECT satisfaction, generation_mode, generation_depth FROM candidates WHERE id = ?')
      .get('c1') as { satisfaction: string; generation_mode: string; generation_depth: number };
    expect(raw.satisfaction).toBe('unrated');
    expect(raw.generation_mode).toBe('fresh');
    expect(raw.generation_depth).toBe(0);
  });

  it('listByRun 按 nodeId 过滤，子候选携带 parentCandidateId', () => {
    projects.insert(makeProject());
    seedRun();
    candidates.insert(makeCandidate({ id: 'c1', index: 0 }));
    candidates.insert(makeCandidate({ id: 'c2', index: 1 }));
    candidates.insert(
      makeCandidate({
        id: 'c2-1',
        index: 2,
        parentCandidateId: 'c2',
        generationMode: 'improve',
        generationDepth: 1,
        lineage: ['c2'],
      }),
    );

    expect(candidates.listByRun('r1').map((c) => c.id)).toEqual(['c1', 'c2', 'c2-1']);
    const child = candidates.get('c2-1');
    expect(child?.parentCandidateId).toBe('c2');
    expect(child?.lineage).toEqual(['c2']);
    expect(child?.generationDepth).toBe(1);
    expect(candidates.listByRun('r1', 'other-node')).toEqual([]);
  });

  it('Phase 4：nextIndex / listChildren / deleteUnsatisfied', () => {
    projects.insert(makeProject());
    seedRun();
    candidates.insert(makeCandidate({ id: 'c1', index: 0 }));
    candidates.insert(makeCandidate({ id: 'c2', index: 1, satisfaction: 'unsatisfied' }));
    candidates.insert(
      makeCandidate({ id: 'c1-1', index: 2, parentCandidateId: 'c1', generationMode: 'improve', generationDepth: 1 }),
    );

    // nextIndex：同 run/node 的 max(idx)+1
    expect(candidates.nextIndex('r1', 'n1')).toBe(3);
    // listChildren：直接子候选
    expect(candidates.listChildren('c1').map((c) => c.id)).toEqual(['c1-1']);
    // deleteUnsatisfied：删除并返回 id 列表
    expect(candidates.deleteUnsatisfied('r1', 'n1')).toEqual(['c2']);
    expect(candidates.get('c2')).toBeUndefined();
    expect(candidates.listByRun('r1').map((c) => c.id)).toEqual(['c1', 'c1-1']);
  });
});
