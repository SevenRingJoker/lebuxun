-- 001_init_down.sql · 对应 001_init.sql（SPEC §5.1 全量建表）的回滚
-- 逆序 DROP：先索引，再按外键引用顺序先子表后主表；
-- 末尾删除 001 up 自建的 schema_migrations（DROP 后 umzug storage 的 unlog 需容忍表不存在）。

DROP INDEX IF EXISTS idx_pref_project;
DROP INDEX IF EXISTS idx_rag_style_scene;
DROP INDEX IF EXISTS idx_tags_project;
DROP INDEX IF EXISTS idx_candidates_satisfaction;
DROP INDEX IF EXISTS idx_candidates_parent;

-- 子表 → 主表（外键顺序：candidate_lineage→candidates→runs→workflows→projects 等）
DROP TABLE IF EXISTS prompt_versions;
DROP TABLE IF EXISTS growth_stats;
DROP TABLE IF EXISTS preference_samples;
DROP TABLE IF EXISTS rag_chunks;
DROP TABLE IF EXISTS style_books;
DROP TABLE IF EXISTS styles;
DROP TABLE IF EXISTS satisfaction_tags;
DROP TABLE IF EXISTS evolution_patterns;
DROP TABLE IF EXISTS candidate_lineage;
DROP TABLE IF EXISTS candidates;
DROP TABLE IF EXISTS runs;
DROP TABLE IF EXISTS workflows;
DROP TABLE IF EXISTS paragraphs;
DROP TABLE IF EXISTS chapters;
DROP TABLE IF EXISTS projects;

-- 001 up 自建的迁移记录表，最后删除
DROP TABLE IF EXISTS schema_migrations;
