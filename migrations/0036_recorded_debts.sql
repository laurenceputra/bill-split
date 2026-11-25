-- Payments and recorded debts share the same two-sided balance movement
-- infrastructure but are separate transaction kinds. For debt, from/to are
-- the creditor/debtor respectively (the positive/negative balance sides).
-- Debts count toward the ledger's safe-integer bound on balance movements,
-- not toward spending, expense shares, or payment exports.
ALTER TABLE settlements ADD COLUMN entry_kind TEXT NOT NULL DEFAULT 'settlement'
  CHECK(entry_kind IN ('settlement', 'debt'));
CREATE INDEX idx_settlements_group_kind_date ON settlements(group_id, entry_kind, settlement_date DESC, created_at DESC, id DESC);

ALTER TABLE audit_events RENAME TO audit_events_old;
CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id),
  entity_type TEXT NOT NULL CHECK(entity_type IN ('expense','settlement','credit','debt')),
  entity_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  action TEXT NOT NULL CHECK(action IN ('create','update','delete','restore')),
  actor_id TEXT NOT NULL REFERENCES users(id),
  actor_person_id TEXT REFERENCES people(id), actor_name TEXT,
  occurred_at TEXT NOT NULL, before_json TEXT, after_json TEXT,
  UNIQUE(entity_type, entity_id, version, action)
);
INSERT INTO audit_events(id,group_id,entity_type,entity_id,version,action,actor_id,actor_person_id,actor_name,occurred_at,before_json,after_json)
SELECT id,group_id,entity_type,entity_id,version,action,actor_id,actor_person_id,actor_name,occurred_at,before_json,after_json FROM audit_events_old;
DROP TABLE audit_events_old;
CREATE INDEX idx_audit_group_time ON audit_events(group_id, occurred_at DESC, id DESC);
CREATE INDEX idx_audit_entity ON audit_events(entity_type, entity_id, version DESC);
CREATE INDEX idx_audit_actor ON audit_events(actor_id, occurred_at DESC);
