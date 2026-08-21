-- Keep the bounded Cron candidate window rotating so an older backlog cannot
-- permanently hide a later due template.
CREATE TABLE scheduled_generation_cursor (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  cursor_id TEXT,
  updated_at TEXT NOT NULL
);
INSERT INTO scheduled_generation_cursor(id,cursor_id,updated_at) VALUES(1,NULL,'1970-01-01T00:00:00.000Z');
