-- 002_memory_chunks.sql · Phase 3 记忆库（SPEC §7.3 memory.updater / context.memory 持久层）
-- SPEC §5.1 未定义项目级记忆表（rag_chunks 属风格库侧），按 Phase 3 节点需求补全，SPEC-CHANGELOG 登记。
CREATE TABLE memory_chunks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  chapter_id TEXT REFERENCES chapters(id),
  kind TEXT NOT NULL,        -- chapter-summary | paragraph | note
  content TEXT NOT NULL,
  metadata TEXT,             -- JSON
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_memory_chunks_project ON memory_chunks(project_id, created_at);
