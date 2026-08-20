-- Safe local-only seed. Run: npm run db:migrate:local && npm run db:seed
INSERT OR IGNORE INTO users(id,email,created_at,updated_at) VALUES ('00000000-0000-4000-8000-000000000001','dev@example.com',datetime('now'),datetime('now'));
INSERT OR IGNORE INTO people(id,name,email,created_at) VALUES ('00000000-0000-4000-8000-000000000002','Dev User','dev@example.com',datetime('now'));
