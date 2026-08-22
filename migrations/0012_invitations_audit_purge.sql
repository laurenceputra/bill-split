-- In-app invitations are addressed to a verified, normalized email.  An
-- invitation is a capability stored in D1, not a bearer link.
CREATE TABLE group_invitations (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id),
  email_normalized TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  accepted_at TEXT,
  accepted_by TEXT REFERENCES users(id),
  rejected_at TEXT
);
CREATE INDEX idx_group_invitations_email ON group_invitations(email_normalized, expires_at);
CREATE INDEX idx_group_invitations_group ON group_invitations(group_id, created_at DESC);

-- Audit rows are append-only.  after_json is nullable for legacy revisions
-- backfilled by this migration, whose old revision format only stored before.
CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id),
  entity_type TEXT NOT NULL CHECK(entity_type IN ('expense','settlement')),
  entity_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  action TEXT NOT NULL CHECK(action IN ('create','update','delete','restore')),
  actor_id TEXT NOT NULL REFERENCES users(id),
  occurred_at TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  UNIQUE(entity_type, entity_id, version, action)
);
CREATE INDEX idx_audit_group_time ON audit_events(group_id, occurred_at DESC, id DESC);
CREATE INDEX idx_audit_entity ON audit_events(entity_type, entity_id, version DESC);

-- Existing revision snapshots remain readable.  They are represented as
-- update events with an unknown after snapshot; new mutations write complete
-- before/after events in their D1 batch.
INSERT OR IGNORE INTO audit_events
  (id,group_id,entity_type,entity_id,version,action,actor_id,occurred_at,before_json,after_json)
SELECT 'legacy-audit-' || r.id,e.group_id,r.entity_type,r.entity_id,r.revision,'update',
  r.created_by,r.created_at,r.snapshot_json,NULL
FROM revisions r
JOIN expenses e ON r.entity_type='expense' AND e.id=r.entity_id
UNION ALL
SELECT 'legacy-audit-' || r.id,s.group_id,r.entity_type,r.entity_id,r.revision,'update',
  r.created_by,r.created_at,r.snapshot_json,NULL
FROM revisions r
JOIN settlements s ON r.entity_type='settlement' AND s.id=r.entity_id;

-- Keep scheduled occurrence rows as anti-regeneration tombstones after the
-- generated expense itself is purged.  The occurrence identity remains unique
-- while its expense_id no longer depends on the purged ledger row.
PRAGMA defer_foreign_keys = ON;
DROP INDEX IF EXISTS idx_scheduled_occurrence_expense;
ALTER TABLE scheduled_occurrences RENAME TO scheduled_occurrences_old;
CREATE TABLE scheduled_occurrences_new (
  scheduled_expense_id TEXT NOT NULL REFERENCES scheduled_expenses(id),
  occurrence_date TEXT NOT NULL,
  expense_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  PRIMARY KEY(scheduled_expense_id, occurrence_date)
);
INSERT INTO scheduled_occurrences_new(scheduled_expense_id,occurrence_date,expense_id,created_at)
SELECT scheduled_expense_id,occurrence_date,expense_id,created_at FROM scheduled_occurrences_old;
DROP TABLE scheduled_occurrences_old;
ALTER TABLE scheduled_occurrences_new RENAME TO scheduled_occurrences;
CREATE INDEX idx_scheduled_occurrence_expense ON scheduled_occurrences(expense_id);
