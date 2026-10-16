-- 003_settings.sql · 收尾批次 3：设置面板持久化（SPEC §5.1，SPEC-CHANGELOG 登记）
-- key/value 通用设置表（value 为 JSON 文本）；当前使用 key='model-routes' 存路由覆盖

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,            -- JSON
  updated_at INTEGER NOT NULL
);
