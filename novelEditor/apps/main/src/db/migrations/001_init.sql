-- 001_init.sql · 完整翻译 SPEC §5.1
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;

CREATE TABLE schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  genre TEXT NOT NULL,
  description TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE chapters (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  idx INTEGER NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,     -- planned|writing|draft|final
  word_count INTEGER DEFAULT 0,
  summary TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE paragraphs (
  id TEXT PRIMARY KEY,
  chapter_id TEXT NOT NULL REFERENCES chapters(id),
  idx INTEGER NOT NULL,
  text TEXT NOT NULL,
  scene_type TEXT NOT NULL,
  metadata TEXT,            -- JSON
  created_at INTEGER NOT NULL
);

CREATE TABLE workflows (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  graph TEXT NOT NULL,      -- JSON: { nodes, edges }
  version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  status TEXT NOT NULL,     -- running|paused|done|error
  current_node_id TEXT,
  state TEXT,               -- JSON
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE candidates (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  node_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  text TEXT NOT NULL,
  strategy TEXT NOT NULL,           -- JSON
  scores TEXT NOT NULL,             -- JSON
  satisfaction TEXT NOT NULL DEFAULT 'unrated',   -- satisfied|unsatisfied|unrated
  satisfaction_reason TEXT,
  satisfaction_tags TEXT,           -- JSON array
  parent_candidate_id TEXT REFERENCES candidates(id),
  generation_mode TEXT NOT NULL DEFAULT 'fresh',
  generation_depth INTEGER NOT NULL DEFAULT 0,
  lineage TEXT,                     -- JSON array of ids
  marked_at INTEGER,
  selected INTEGER DEFAULT 0
);

CREATE INDEX idx_candidates_parent ON candidates(parent_candidate_id);
CREATE INDEX idx_candidates_satisfaction ON candidates(run_id, satisfaction);

CREATE TABLE candidate_lineage (
  id TEXT PRIMARY KEY,
  parent_id TEXT NOT NULL REFERENCES candidates(id),
  child_ids TEXT NOT NULL,          -- JSON array
  mode TEXT NOT NULL,               -- improve|variant
  hint TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE evolution_patterns (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  parent_text TEXT NOT NULL,
  child_text TEXT,
  child_texts TEXT,                 -- JSON array（全部落选时）
  mode TEXT NOT NULL,
  hint TEXT,
  outcome TEXT,                     -- selected|rejected
  diff TEXT,                        -- JSON: 语义 diff
  created_at INTEGER NOT NULL
);

CREATE TABLE satisfaction_tags (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  polarity TEXT NOT NULL,           -- positive|negative
  count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_tags_project ON satisfaction_tags(project_id, polarity);

CREATE TABLE styles (
  id TEXT PRIMARY KEY,
  author_name TEXT NOT NULL,
  genre TEXT NOT NULL,
  book_count INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,        -- JSON
  report TEXT NOT NULL,             -- JSON
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE style_books (
  id TEXT PRIMARY KEY,
  style_id TEXT NOT NULL REFERENCES styles(id),
  title TEXT NOT NULL,
  word_count INTEGER,
  chapter_count INTEGER,
  path TEXT
);

CREATE TABLE rag_chunks (
  id TEXT PRIMARY KEY,
  style_id TEXT NOT NULL REFERENCES styles(id),
  book_id TEXT NOT NULL,
  chapter_index INTEGER,
  text TEXT NOT NULL,
  scene_type TEXT NOT NULL,
  vector BLOB                       -- float32 array
);

CREATE INDEX idx_rag_style_scene ON rag_chunks(style_id, scene_type);

CREATE TABLE preference_samples (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  style_id TEXT,
  context TEXT NOT NULL,
  chosen TEXT NOT NULL,
  rejected TEXT NOT NULL,
  reasons TEXT,                     -- JSON array
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_pref_project ON preference_samples(project_id, created_at);

CREATE TABLE growth_stats (
  project_id TEXT PRIMARY KEY REFERENCES projects(id),
  stats TEXT NOT NULL,              -- JSON
  updated_at INTEGER NOT NULL
);

CREATE TABLE prompt_versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  node_type TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  metrics TEXT,                     -- JSON
  created_at INTEGER NOT NULL
);
