-- 0024: independently verified monthly ledger summaries.
--
-- Production is only through 0023. Financial tables remain authoritative; everything
-- below is disposable, derived state.

-- 0003's transaction-wide scans are replaced by the hybrid guards below.
DROP TRIGGER IF EXISTS expenses_ledger_total_limit_insert;
DROP TRIGGER IF EXISTS expenses_ledger_total_limit_update;
DROP TRIGGER IF EXISTS settlements_ledger_total_limit_insert;
DROP TRIGGER IF EXISTS settlements_ledger_total_limit_update;

ALTER TABLE expenses ADD COLUMN projection_mutation_id TEXT;
ALTER TABLE settlements ADD COLUMN projection_mutation_id TEXT;
ALTER TABLE projection_state ADD COLUMN ledger_totals_ready INTEGER NOT NULL DEFAULT 0 CHECK(ledger_totals_ready IN (0,1));
ALTER TABLE projection_state ADD COLUMN mutation_count INTEGER NOT NULL DEFAULT 0 CHECK(mutation_count >= 0);
ALTER TABLE projection_state ADD COLUMN last_reconciled_at TEXT;
ALTER TABLE projection_state ADD COLUMN reconciliation_due INTEGER NOT NULL DEFAULT 0 CHECK(reconciliation_due IN (0,1));

-- Keep the legacy projection and its readiness untouched.  0021 Workers may
-- still be deployed while this migration is pending; marking these rows stale
-- would make them start an unbounded legacy full-group rebuild.  The new Worker
-- uses only the monthly summary state below.

CREATE TABLE ledger_summary_state (
  group_id TEXT PRIMARY KEY REFERENCES groups(id),
  status TEXT NOT NULL CHECK(status IN ('pending','backfilling','ready','dirty','failed')),
  checkpoint_through TEXT,
  discovery_complete INTEGER NOT NULL DEFAULT 0 CHECK(discovery_complete IN (0,1)),
  expense_discovery_cursor TEXT,
  settlement_discovery_cursor TEXT,
  expense_discovery_high_water TEXT,
  settlement_discovery_high_water TEXT,
  lease_owner TEXT,
  lease_until_ms INTEGER,
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK(retry_count >= 0),
  available_at_ms INTEGER NOT NULL,
  last_error TEXT,
  maintenance_due INTEGER NOT NULL DEFAULT 1 CHECK(maintenance_due IN (0,1)),
  updated_at TEXT NOT NULL
);

CREATE TABLE ledger_period_state (
  group_id TEXT NOT NULL REFERENCES groups(id),
  month TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','backfilling','ready','dirty','failed')),
  source_generation INTEGER NOT NULL DEFAULT 0 CHECK(source_generation >= 0),
  applied_generation INTEGER NOT NULL DEFAULT 0 CHECK(applied_generation >= 0),
  build_generation INTEGER NOT NULL DEFAULT 0 CHECK(build_generation >= 0),
  -- build_id is the hidden build currently being verified. active_build_id is
  -- the only build visible to reads and normal mutation deltas.
  build_id TEXT,
  active_build_id TEXT,
  expense_cursor TEXT,
  settlement_cursor TEXT,
  expense_high_water TEXT,
  settlement_high_water TEXT,
  lease_owner TEXT,
  lease_until_ms INTEGER,
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK(retry_count >= 0),
  retry_at_ms INTEGER,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(group_id,month)
);

-- Period rows are immutable build versions. Verification writes directly to a
-- hidden build; publication is one bounded pointer flip per period.
CREATE TABLE ledger_period_balances (
  group_id TEXT NOT NULL REFERENCES groups(id), month TEXT NOT NULL,
  build_id TEXT NOT NULL, currency TEXT NOT NULL, person_id TEXT NOT NULL REFERENCES people(id),
  net_minor INTEGER NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY(group_id,month,build_id,currency,person_id)
);
CREATE TABLE ledger_period_totals (
  group_id TEXT NOT NULL REFERENCES groups(id), month TEXT NOT NULL,
  build_id TEXT NOT NULL, currency TEXT NOT NULL,
  gross_minor INTEGER NOT NULL CHECK(gross_minor >= 0), updated_at TEXT NOT NULL,
  PRIMARY KEY(group_id,month,build_id,currency)
);

-- A build is disposable only after it is no longer the published build or the
-- build currently being verified.  The queue is deliberately independent of
-- readiness so garbage collection can never make a ready read fall back.
CREATE TABLE ledger_period_build_gc (
  group_id TEXT NOT NULL REFERENCES groups(id),
  month TEXT NOT NULL,
  build_id TEXT NOT NULL,
  enqueued_at_ms INTEGER NOT NULL,
  available_at_ms INTEGER NOT NULL,
  last_served_at_ms INTEGER,
  lease_owner TEXT,
  lease_until_ms INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  last_error TEXT,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(group_id,month,build_id)
);
CREATE TABLE ledger_checkpoint_balances (
  group_id TEXT NOT NULL REFERENCES groups(id), currency TEXT NOT NULL,
  person_id TEXT NOT NULL REFERENCES people(id), net_minor INTEGER NOT NULL,
  updated_at TEXT NOT NULL, PRIMARY KEY(group_id,currency,person_id)
);
CREATE TABLE ledger_checkpoint_totals (
  group_id TEXT NOT NULL REFERENCES groups(id), currency TEXT NOT NULL,
  gross_minor INTEGER NOT NULL CHECK(gross_minor >= 0), updated_at TEXT NOT NULL,
  PRIMARY KEY(group_id,currency)
);

-- Retained as disposable compatibility storage for installations that had the
-- short-lived pre-publication implementation. New verification never uses it.
CREATE TABLE ledger_period_verify_balances (
  group_id TEXT NOT NULL, month TEXT NOT NULL, currency TEXT NOT NULL,
  person_id TEXT NOT NULL, net_minor INTEGER NOT NULL, build_id TEXT NOT NULL,
  PRIMARY KEY(group_id,month,currency,person_id,build_id)
);
CREATE TABLE ledger_period_verify_totals (
  group_id TEXT NOT NULL, month TEXT NOT NULL, currency TEXT NOT NULL,
  gross_minor INTEGER NOT NULL, build_id TEXT NOT NULL,
  PRIMARY KEY(group_id,month,currency,build_id)
);

CREATE INDEX idx_ledger_verify_balances_chunk ON ledger_period_verify_balances(group_id,month,build_id);
CREATE INDEX idx_ledger_verify_totals_chunk ON ledger_period_verify_totals(group_id,month,build_id);
CREATE INDEX idx_ledger_summary_maintenance_due ON ledger_summary_state(maintenance_due,available_at_ms,updated_at,group_id);
CREATE INDEX idx_ledger_period_gc_available ON ledger_period_build_gc(available_at_ms,last_served_at_ms,enqueued_at_ms,group_id,month,build_id);
CREATE INDEX idx_ledger_period_gc_group ON ledger_period_build_gc(group_id,month,build_id);
CREATE INDEX idx_ledger_period_eligible_month ON ledger_period_state(group_id,retry_at_ms,month)
  WHERE status<>'ready' OR source_generation<>applied_generation OR active_build_id IS NULL;
CREATE INDEX idx_ledger_period_non_ready ON ledger_period_state(group_id,status,source_generation,applied_generation,active_build_id,month)
  WHERE status<>'ready' OR source_generation<>applied_generation OR active_build_id IS NULL;
CREATE INDEX idx_ledger_period_non_ready_month ON ledger_period_state(group_id,month)
  WHERE status<>'ready' OR source_generation<>applied_generation OR active_build_id IS NULL;
CREATE INDEX idx_groups_deleted_purge ON groups(deleted_at,id);
CREATE INDEX idx_attachments_expense_purge ON attachments(expense_id,id);
CREATE INDEX idx_scheduled_occurrence_expense_purge ON scheduled_occurrences(expense_id);
CREATE INDEX idx_scheduled_payers_purge ON scheduled_payers(scheduled_expense_id,person_id);
CREATE INDEX idx_scheduled_splits_purge ON scheduled_splits(scheduled_expense_id,person_id);
CREATE INDEX idx_scheduled_expenses_purge ON scheduled_expenses(group_id,id);
CREATE INDEX idx_revisions_entity_purge ON revisions(entity_type,entity_id,revision);
CREATE INDEX idx_group_invitations_purge ON group_invitations(group_id,created_at,id);
CREATE INDEX idx_idempotency_group_purge ON idempotency_keys(group_id,created_at,operation_id);

-- Deleted-group cleanup uses a durable lexicographic cursor rather than a
-- timestamp-only ordering. D1 timestamps have one-second precision, so a
-- cursor is required to keep a partially drained group from winning every
-- invocation when several groups are touched in the same second.
CREATE TABLE group_purge_cursor (
  id INTEGER PRIMARY KEY CHECK(id=1),
  deleted_at TEXT,
  group_id TEXT,
  updated_at TEXT NOT NULL
);
INSERT INTO group_purge_cursor(id,deleted_at,group_id,updated_at) VALUES(1,NULL,NULL,CURRENT_TIMESTAMP);

-- Immutable-ID discovery and date+ID verification each have a matching
-- group-leading index. Do not replace these with MAX(id) scans.
CREATE INDEX idx_expenses_group_id ON expenses(group_id,id);
CREATE INDEX idx_settlements_group_id ON settlements(group_id,id);
CREATE INDEX idx_expenses_group_date_id ON expenses(group_id,expense_date,id);
CREATE INDEX idx_settlements_group_date_id ON settlements(group_id,settlement_date,id);
CREATE INDEX idx_scheduled_completion_due ON scheduled_expenses(status,end_date,generation_claim_id,next_occurrence_date,id);
CREATE INDEX idx_scheduled_generation_cleanup ON scheduled_expenses(status,generation_claim_id,group_id,created_by,id);

INSERT INTO ledger_summary_state(group_id,status,maintenance_due,available_at_ms,updated_at)
  SELECT id,'pending',1,CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),CURRENT_TIMESTAMP FROM groups;

CREATE TRIGGER ledger_summary_group_insert_state AFTER INSERT ON groups BEGIN
  INSERT INTO ledger_summary_state(group_id,status,maintenance_due,available_at_ms,updated_at)
    VALUES(NEW.id,'pending',1,CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),CURRENT_TIMESTAMP) ON CONFLICT(group_id) DO NOTHING;
END;

-- A newly inserted period must be folded into the rolling checkpoint before
-- publication, even when the mutation itself could otherwise be applied to an
-- existing ready period. Dirty period transitions likewise stay on the
-- maintenance queue; a normal ready delta (source_generation and
-- applied_generation advancing together) does not.
CREATE TRIGGER ledger_period_state_insert_maintenance AFTER INSERT ON ledger_period_state BEGIN
  UPDATE ledger_summary_state SET
    status=CASE WHEN status='ready' THEN 'pending' ELSE status END,
    maintenance_due=1,available_at_ms=CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),updated_at=CURRENT_TIMESTAMP WHERE group_id=NEW.group_id;
END;
CREATE TRIGGER ledger_period_state_dirty_maintenance AFTER UPDATE OF status,source_generation,applied_generation,active_build_id ON ledger_period_state
WHEN NEW.status<>'ready' OR NEW.source_generation<>NEW.applied_generation OR NEW.active_build_id IS NULL BEGIN
  UPDATE ledger_summary_state SET maintenance_due=1,available_at_ms=CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),updated_at=CURRENT_TIMESTAMP WHERE group_id=NEW.group_id;
END;

-- Old Workers have no mutation marker. They dirty exactly the affected month(s)
-- without changing legacy projection readiness; changing that state would
-- enqueue a legacy full-group rebuild on an older Worker. This is deliberately
-- repeated in every legacy dirty trigger, including child-row triggers.
CREATE TRIGGER ledger_summary_expense_insert_dirty AFTER INSERT ON expenses
WHEN NEW.projection_mutation_id IS NULL BEGIN
  INSERT INTO ledger_period_state(group_id,month,status,source_generation,updated_at)
    VALUES(NEW.group_id,substr(NEW.expense_date,1,7)||'-01','dirty',1,CURRENT_TIMESTAMP)
    ON CONFLICT(group_id,month) DO UPDATE SET source_generation=source_generation+1,status='dirty',updated_at=CURRENT_TIMESTAMP;
  UPDATE ledger_summary_state SET status='dirty',maintenance_due=1,available_at_ms=CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),updated_at=CURRENT_TIMESTAMP WHERE group_id=NEW.group_id;
END;
CREATE TRIGGER ledger_summary_expense_update_dirty AFTER UPDATE ON expenses
WHEN NEW.projection_mutation_id IS OLD.projection_mutation_id
  AND (NEW.group_id IS NOT OLD.group_id OR NEW.description IS NOT OLD.description OR NEW.amount_minor IS NOT OLD.amount_minor
    OR NEW.currency IS NOT OLD.currency OR NEW.expense_date IS NOT OLD.expense_date OR NEW.category IS NOT OLD.category
    OR NEW.notes IS NOT OLD.notes OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
    OR NEW.updated_at IS NOT OLD.updated_at OR NEW.deleted_at IS NOT OLD.deleted_at OR NEW.client_operation_id IS NOT OLD.client_operation_id
    OR NEW.version IS NOT OLD.version) BEGIN
  INSERT INTO ledger_period_state(group_id,month,status,source_generation,updated_at)
    VALUES(OLD.group_id,substr(OLD.expense_date,1,7)||'-01','dirty',1,CURRENT_TIMESTAMP)
    ON CONFLICT(group_id,month) DO UPDATE SET source_generation=source_generation+1,status='dirty',updated_at=CURRENT_TIMESTAMP;
  INSERT INTO ledger_period_state(group_id,month,status,source_generation,updated_at)
    VALUES(NEW.group_id,substr(NEW.expense_date,1,7)||'-01','dirty',1,CURRENT_TIMESTAMP)
    ON CONFLICT(group_id,month) DO UPDATE SET source_generation=source_generation+1,status='dirty',updated_at=CURRENT_TIMESTAMP;
  UPDATE ledger_summary_state SET status='dirty',maintenance_due=1,available_at_ms=CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),updated_at=CURRENT_TIMESTAMP WHERE group_id IN (OLD.group_id,NEW.group_id);
END;
CREATE TRIGGER ledger_summary_expense_delete_dirty AFTER DELETE ON expenses BEGIN
  INSERT INTO ledger_period_state(group_id,month,status,source_generation,updated_at)
    VALUES(OLD.group_id,substr(OLD.expense_date,1,7)||'-01','dirty',1,CURRENT_TIMESTAMP)
    ON CONFLICT(group_id,month) DO UPDATE SET source_generation=source_generation+1,status='dirty',updated_at=CURRENT_TIMESTAMP;
  UPDATE ledger_summary_state SET status='dirty',maintenance_due=1,available_at_ms=CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),updated_at=CURRENT_TIMESTAMP WHERE group_id=OLD.group_id;
END;
CREATE TRIGGER ledger_summary_settlement_insert_dirty AFTER INSERT ON settlements
WHEN NEW.projection_mutation_id IS NULL BEGIN
  INSERT INTO ledger_period_state(group_id,month,status,source_generation,updated_at)
    VALUES(NEW.group_id,substr(NEW.settlement_date,1,7)||'-01','dirty',1,CURRENT_TIMESTAMP)
    ON CONFLICT(group_id,month) DO UPDATE SET source_generation=source_generation+1,status='dirty',updated_at=CURRENT_TIMESTAMP;
  UPDATE ledger_summary_state SET status='dirty',maintenance_due=1,available_at_ms=CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),updated_at=CURRENT_TIMESTAMP WHERE group_id=NEW.group_id;
END;
CREATE TRIGGER ledger_summary_settlement_update_dirty AFTER UPDATE ON settlements
WHEN NEW.projection_mutation_id IS OLD.projection_mutation_id
  AND (NEW.group_id IS NOT OLD.group_id OR NEW.from_person_id IS NOT OLD.from_person_id OR NEW.to_person_id IS NOT OLD.to_person_id
    OR NEW.amount_minor IS NOT OLD.amount_minor OR NEW.currency IS NOT OLD.currency OR NEW.settlement_date IS NOT OLD.settlement_date
    OR NEW.note IS NOT OLD.note OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
    OR NEW.updated_at IS NOT OLD.updated_at OR NEW.deleted_at IS NOT OLD.deleted_at OR NEW.client_operation_id IS NOT OLD.client_operation_id
    OR NEW.version IS NOT OLD.version) BEGIN
  INSERT INTO ledger_period_state(group_id,month,status,source_generation,updated_at)
    VALUES(OLD.group_id,substr(OLD.settlement_date,1,7)||'-01','dirty',1,CURRENT_TIMESTAMP)
    ON CONFLICT(group_id,month) DO UPDATE SET source_generation=source_generation+1,status='dirty',updated_at=CURRENT_TIMESTAMP;
  INSERT INTO ledger_period_state(group_id,month,status,source_generation,updated_at)
    VALUES(NEW.group_id,substr(NEW.settlement_date,1,7)||'-01','dirty',1,CURRENT_TIMESTAMP)
    ON CONFLICT(group_id,month) DO UPDATE SET source_generation=source_generation+1,status='dirty',updated_at=CURRENT_TIMESTAMP;
  UPDATE ledger_summary_state SET status='dirty',maintenance_due=1,available_at_ms=CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),updated_at=CURRENT_TIMESTAMP WHERE group_id IN (OLD.group_id,NEW.group_id);
END;
CREATE TRIGGER ledger_summary_settlement_delete_dirty AFTER DELETE ON settlements BEGIN
  INSERT INTO ledger_period_state(group_id,month,status,source_generation,updated_at)
    VALUES(OLD.group_id,substr(OLD.settlement_date,1,7)||'-01','dirty',1,CURRENT_TIMESTAMP)
    ON CONFLICT(group_id,month) DO UPDATE SET source_generation=source_generation+1,status='dirty',updated_at=CURRENT_TIMESTAMP;
  UPDATE ledger_summary_state SET status='dirty',maintenance_due=1,available_at_ms=CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),updated_at=CURRENT_TIMESTAMP WHERE group_id=OLD.group_id;
END;

-- Legacy child writes resolve the parent month and queue only the new summary.
-- New Worker child writes occur while their parent marker is set and are excluded.
CREATE TRIGGER ledger_summary_payer_insert_dirty AFTER INSERT ON payers
WHEN EXISTS(SELECT 1 FROM expenses e WHERE e.id=NEW.expense_id AND e.projection_mutation_id IS NULL) BEGIN
  INSERT INTO ledger_period_state(group_id,month,status,source_generation,updated_at)
    SELECT e.group_id,substr(e.expense_date,1,7)||'-01','dirty',1,CURRENT_TIMESTAMP FROM expenses e WHERE e.id=NEW.expense_id
    ON CONFLICT(group_id,month) DO UPDATE SET source_generation=source_generation+1,status='dirty',updated_at=CURRENT_TIMESTAMP;
  UPDATE ledger_summary_state SET status='dirty',maintenance_due=1,available_at_ms=CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),updated_at=CURRENT_TIMESTAMP WHERE group_id=(SELECT group_id FROM expenses WHERE id=NEW.expense_id);
END;
CREATE TRIGGER ledger_summary_payer_update_dirty AFTER UPDATE ON payers
WHEN EXISTS(SELECT 1 FROM expenses e WHERE e.id=NEW.expense_id AND e.projection_mutation_id IS NULL) BEGIN
  INSERT INTO ledger_period_state(group_id,month,status,source_generation,updated_at)
    SELECT e.group_id,substr(e.expense_date,1,7)||'-01','dirty',1,CURRENT_TIMESTAMP FROM expenses e WHERE e.id=NEW.expense_id
    ON CONFLICT(group_id,month) DO UPDATE SET source_generation=source_generation+1,status='dirty',updated_at=CURRENT_TIMESTAMP;
  UPDATE ledger_summary_state SET status='dirty',maintenance_due=1,available_at_ms=CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),updated_at=CURRENT_TIMESTAMP WHERE group_id=(SELECT group_id FROM expenses WHERE id=NEW.expense_id);
END;
CREATE TRIGGER ledger_summary_payer_delete_dirty AFTER DELETE ON payers
WHEN EXISTS(SELECT 1 FROM expenses e WHERE e.id=OLD.expense_id AND e.projection_mutation_id IS NULL) BEGIN
  INSERT INTO ledger_period_state(group_id,month,status,source_generation,updated_at)
    SELECT e.group_id,substr(e.expense_date,1,7)||'-01','dirty',1,CURRENT_TIMESTAMP FROM expenses e WHERE e.id=OLD.expense_id
    ON CONFLICT(group_id,month) DO UPDATE SET source_generation=source_generation+1,status='dirty',updated_at=CURRENT_TIMESTAMP;
  UPDATE ledger_summary_state SET status='dirty',maintenance_due=1,available_at_ms=CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),updated_at=CURRENT_TIMESTAMP WHERE group_id=(SELECT group_id FROM expenses WHERE id=OLD.expense_id);
END;
CREATE TRIGGER ledger_summary_split_insert_dirty AFTER INSERT ON splits
WHEN EXISTS(SELECT 1 FROM expenses e WHERE e.id=NEW.expense_id AND e.projection_mutation_id IS NULL) BEGIN
  INSERT INTO ledger_period_state(group_id,month,status,source_generation,updated_at)
    SELECT e.group_id,substr(e.expense_date,1,7)||'-01','dirty',1,CURRENT_TIMESTAMP FROM expenses e WHERE e.id=NEW.expense_id
    ON CONFLICT(group_id,month) DO UPDATE SET source_generation=source_generation+1,status='dirty',updated_at=CURRENT_TIMESTAMP;
  UPDATE ledger_summary_state SET status='dirty',maintenance_due=1,available_at_ms=CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),updated_at=CURRENT_TIMESTAMP WHERE group_id=(SELECT group_id FROM expenses WHERE id=NEW.expense_id);
END;
CREATE TRIGGER ledger_summary_split_update_dirty AFTER UPDATE ON splits
WHEN EXISTS(SELECT 1 FROM expenses e WHERE e.id=NEW.expense_id AND e.projection_mutation_id IS NULL) BEGIN
  INSERT INTO ledger_period_state(group_id,month,status,source_generation,updated_at)
    SELECT e.group_id,substr(e.expense_date,1,7)||'-01','dirty',1,CURRENT_TIMESTAMP FROM expenses e WHERE e.id=NEW.expense_id
    ON CONFLICT(group_id,month) DO UPDATE SET source_generation=source_generation+1,status='dirty',updated_at=CURRENT_TIMESTAMP;
  UPDATE ledger_summary_state SET status='dirty',maintenance_due=1,available_at_ms=CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),updated_at=CURRENT_TIMESTAMP WHERE group_id=(SELECT group_id FROM expenses WHERE id=NEW.expense_id);
END;
CREATE TRIGGER ledger_summary_split_delete_dirty AFTER DELETE ON splits
WHEN EXISTS(SELECT 1 FROM expenses e WHERE e.id=OLD.expense_id AND e.projection_mutation_id IS NULL) BEGIN
  INSERT INTO ledger_period_state(group_id,month,status,source_generation,updated_at)
    SELECT e.group_id,substr(e.expense_date,1,7)||'-01','dirty',1,CURRENT_TIMESTAMP FROM expenses e WHERE e.id=OLD.expense_id
    ON CONFLICT(group_id,month) DO UPDATE SET source_generation=source_generation+1,status='dirty',updated_at=CURRENT_TIMESTAMP;
  UPDATE ledger_summary_state SET status='dirty',maintenance_due=1,available_at_ms=CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),updated_at=CURRENT_TIMESTAMP WHERE group_id=(SELECT group_id FROM expenses WHERE id=OLD.expense_id);
END;

-- Reassignment touches both parent months.
CREATE TRIGGER ledger_summary_payer_reassign_dirty AFTER UPDATE OF expense_id ON payers
WHEN NEW.expense_id IS NOT OLD.expense_id
  AND (EXISTS(SELECT 1 FROM expenses e WHERE e.id=OLD.expense_id AND e.projection_mutation_id IS NULL)
    OR EXISTS(SELECT 1 FROM expenses e WHERE e.id=NEW.expense_id AND e.projection_mutation_id IS NULL)) BEGIN
  INSERT INTO ledger_period_state(group_id,month,status,source_generation,updated_at)
    SELECT e.group_id,substr(e.expense_date,1,7)||'-01','dirty',1,CURRENT_TIMESTAMP FROM expenses e WHERE e.id IN (OLD.expense_id,NEW.expense_id)
    ON CONFLICT(group_id,month) DO UPDATE SET source_generation=source_generation+1,status='dirty',updated_at=CURRENT_TIMESTAMP;
  UPDATE ledger_summary_state SET status='dirty',maintenance_due=1,available_at_ms=CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),updated_at=CURRENT_TIMESTAMP WHERE group_id IN (SELECT group_id FROM expenses WHERE id IN (OLD.expense_id,NEW.expense_id));
END;
CREATE TRIGGER ledger_summary_split_reassign_dirty AFTER UPDATE OF expense_id ON splits
WHEN NEW.expense_id IS NOT OLD.expense_id
  AND (EXISTS(SELECT 1 FROM expenses e WHERE e.id=OLD.expense_id AND e.projection_mutation_id IS NULL)
    OR EXISTS(SELECT 1 FROM expenses e WHERE e.id=NEW.expense_id AND e.projection_mutation_id IS NULL)) BEGIN
  INSERT INTO ledger_period_state(group_id,month,status,source_generation,updated_at)
    SELECT e.group_id,substr(e.expense_date,1,7)||'-01','dirty',1,CURRENT_TIMESTAMP FROM expenses e WHERE e.id IN (OLD.expense_id,NEW.expense_id)
    ON CONFLICT(group_id,month) DO UPDATE SET source_generation=source_generation+1,status='dirty',updated_at=CURRENT_TIMESTAMP;
  UPDATE ledger_summary_state SET status='dirty',maintenance_due=1,available_at_ms=CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),updated_at=CURRENT_TIMESTAMP WHERE group_id IN (SELECT group_id FROM expenses WHERE id IN (OLD.expense_id,NEW.expense_id));
END;

-- The legacy projection is still a public read surface for 0021 Workers.
-- Keep its values within the same safe integer contract as the authoritative
-- ledger.  These triggers deliberately do not touch projection_state: a new
-- Worker mutation must not turn an old Worker's backfill/reconciliation
-- selector into a full-group job.
CREATE TRIGGER group_balance_projection_safe_insert BEFORE INSERT ON group_balance_projection
WHEN NEW.net_minor < -9007199254740991 OR NEW.net_minor > 9007199254740991 BEGIN
  SELECT RAISE(ABORT,'BALANCE_OVERFLOW');
END;
CREATE TRIGGER group_balance_projection_safe_update BEFORE UPDATE OF net_minor ON group_balance_projection
WHEN NEW.net_minor < -9007199254740991 OR NEW.net_minor > 9007199254740991 BEGIN
  SELECT RAISE(ABORT,'BALANCE_OVERFLOW');
END;
CREATE TRIGGER group_balance_projection_cleanup_insert AFTER INSERT ON group_balance_projection
WHEN NEW.net_minor=0 BEGIN
  DELETE FROM group_balance_projection WHERE rowid=NEW.rowid;
END;
CREATE TRIGGER group_balance_projection_cleanup_update AFTER UPDATE OF net_minor ON group_balance_projection
WHEN NEW.net_minor=0 BEGIN
  DELETE FROM group_balance_projection WHERE rowid=NEW.rowid;
END;

-- Ready groups use the compact exact total. The old-worker dirty triggers only
-- queue the monthly summary, so legacy readiness remains an independent
-- compatibility concern during the rollout.
-- Only the 0024-owned summary state selects the compact path. In particular,
-- never use projection_state here: an older Worker may still use its status,
-- reconciliation_due, and ledger_totals_ready columns as a full-rebuild queue.
CREATE TRIGGER expenses_ledger_total_guard_insert BEFORE INSERT ON expenses WHEN NEW.deleted_at IS NULL AND EXISTS(SELECT 1 FROM ledger_summary_state state WHERE state.group_id=NEW.group_id AND state.status='ready' AND state.discovery_complete=1 AND state.maintenance_due=0) AND COALESCE((SELECT gross_minor FROM ledger_totals WHERE group_id=NEW.group_id AND currency=NEW.currency),0)>9007199254740991-NEW.amount_minor BEGIN SELECT RAISE(ABORT,'BALANCE_OVERFLOW'); END;
CREATE TRIGGER expenses_ledger_total_scan_guard_insert BEFORE INSERT ON expenses WHEN NEW.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM ledger_summary_state state WHERE state.group_id=NEW.group_id AND state.status='ready' AND state.discovery_complete=1 AND state.maintenance_due=0) AND COALESCE((SELECT SUM(amount_minor) FROM expenses WHERE group_id=NEW.group_id AND currency=NEW.currency AND deleted_at IS NULL),0)+COALESCE((SELECT SUM(amount_minor) FROM settlements WHERE group_id=NEW.group_id AND currency=NEW.currency AND deleted_at IS NULL),0)>9007199254740991-NEW.amount_minor BEGIN SELECT RAISE(ABORT,'BALANCE_OVERFLOW'); END;
CREATE TRIGGER expenses_ledger_total_apply_insert AFTER INSERT ON expenses WHEN NEW.deleted_at IS NULL AND NEW.projection_mutation_id IS NULL AND EXISTS(SELECT 1 FROM ledger_summary_state state WHERE state.group_id=NEW.group_id AND state.status='ready' AND state.discovery_complete=1 AND state.maintenance_due=0) BEGIN INSERT INTO ledger_totals(group_id,currency,gross_minor,updated_at) VALUES(NEW.group_id,NEW.currency,NEW.amount_minor,CURRENT_TIMESTAMP) ON CONFLICT(group_id,currency) DO UPDATE SET gross_minor=ledger_totals.gross_minor+excluded.gross_minor,updated_at=excluded.updated_at; END;
CREATE TRIGGER expenses_ledger_total_guard_update BEFORE UPDATE OF group_id,currency,amount_minor,deleted_at ON expenses WHEN NEW.deleted_at IS NULL AND EXISTS(SELECT 1 FROM ledger_summary_state state WHERE state.group_id=NEW.group_id AND state.status='ready' AND state.discovery_complete=1 AND state.maintenance_due=0) AND COALESCE((SELECT gross_minor FROM ledger_totals WHERE group_id=NEW.group_id AND currency=NEW.currency),0)-CASE WHEN OLD.deleted_at IS NULL AND OLD.group_id=NEW.group_id AND OLD.currency=NEW.currency THEN OLD.amount_minor ELSE 0 END>9007199254740991-NEW.amount_minor BEGIN SELECT RAISE(ABORT,'BALANCE_OVERFLOW'); END;
CREATE TRIGGER expenses_ledger_total_scan_guard_update BEFORE UPDATE OF group_id,currency,amount_minor,deleted_at ON expenses WHEN NEW.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM ledger_summary_state state WHERE state.group_id=NEW.group_id AND state.status='ready' AND state.discovery_complete=1 AND state.maintenance_due=0) AND COALESCE((SELECT SUM(amount_minor) FROM expenses WHERE group_id=NEW.group_id AND currency=NEW.currency AND deleted_at IS NULL AND id<>OLD.id),0)+COALESCE((SELECT SUM(amount_minor) FROM settlements WHERE group_id=NEW.group_id AND currency=NEW.currency AND deleted_at IS NULL),0)>9007199254740991-NEW.amount_minor BEGIN SELECT RAISE(ABORT,'BALANCE_OVERFLOW'); END;
CREATE TRIGGER expenses_ledger_total_apply_update AFTER UPDATE OF group_id,currency,amount_minor,deleted_at ON expenses WHEN NEW.projection_mutation_id IS NULL BEGIN UPDATE ledger_totals SET gross_minor=gross_minor-OLD.amount_minor,updated_at=CURRENT_TIMESTAMP WHERE OLD.deleted_at IS NULL AND group_id=OLD.group_id AND currency=OLD.currency AND EXISTS(SELECT 1 FROM ledger_summary_state state WHERE state.group_id=OLD.group_id AND state.status='ready' AND state.discovery_complete=1 AND state.maintenance_due=0); INSERT INTO ledger_totals(group_id,currency,gross_minor,updated_at) SELECT NEW.group_id,NEW.currency,NEW.amount_minor,CURRENT_TIMESTAMP WHERE NEW.deleted_at IS NULL AND EXISTS(SELECT 1 FROM ledger_summary_state state WHERE state.group_id=NEW.group_id AND state.status='ready' AND state.discovery_complete=1 AND state.maintenance_due=0) ON CONFLICT(group_id,currency) DO UPDATE SET gross_minor=ledger_totals.gross_minor+excluded.gross_minor,updated_at=excluded.updated_at; END;
CREATE TRIGGER expenses_ledger_total_apply_delete AFTER DELETE ON expenses WHEN OLD.deleted_at IS NULL AND EXISTS(SELECT 1 FROM ledger_summary_state state WHERE state.group_id=OLD.group_id AND state.status='ready' AND state.discovery_complete=1 AND state.maintenance_due=0) BEGIN UPDATE ledger_totals SET gross_minor=gross_minor-OLD.amount_minor,updated_at=CURRENT_TIMESTAMP WHERE group_id=OLD.group_id AND currency=OLD.currency; END;
CREATE TRIGGER settlements_ledger_total_guard_insert BEFORE INSERT ON settlements WHEN NEW.deleted_at IS NULL AND EXISTS(SELECT 1 FROM ledger_summary_state state WHERE state.group_id=NEW.group_id AND state.status='ready' AND state.discovery_complete=1 AND state.maintenance_due=0) AND COALESCE((SELECT gross_minor FROM ledger_totals WHERE group_id=NEW.group_id AND currency=NEW.currency),0)>9007199254740991-NEW.amount_minor BEGIN SELECT RAISE(ABORT,'BALANCE_OVERFLOW'); END;
CREATE TRIGGER settlements_ledger_total_scan_guard_insert BEFORE INSERT ON settlements WHEN NEW.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM ledger_summary_state state WHERE state.group_id=NEW.group_id AND state.status='ready' AND state.discovery_complete=1 AND state.maintenance_due=0) AND COALESCE((SELECT SUM(amount_minor) FROM expenses WHERE group_id=NEW.group_id AND currency=NEW.currency AND deleted_at IS NULL),0)+COALESCE((SELECT SUM(amount_minor) FROM settlements WHERE group_id=NEW.group_id AND currency=NEW.currency AND deleted_at IS NULL),0)>9007199254740991-NEW.amount_minor BEGIN SELECT RAISE(ABORT,'BALANCE_OVERFLOW'); END;
CREATE TRIGGER settlements_ledger_total_apply_insert AFTER INSERT ON settlements WHEN NEW.deleted_at IS NULL AND NEW.projection_mutation_id IS NULL AND EXISTS(SELECT 1 FROM ledger_summary_state state WHERE state.group_id=NEW.group_id AND state.status='ready' AND state.discovery_complete=1 AND state.maintenance_due=0) BEGIN INSERT INTO ledger_totals(group_id,currency,gross_minor,updated_at) VALUES(NEW.group_id,NEW.currency,NEW.amount_minor,CURRENT_TIMESTAMP) ON CONFLICT(group_id,currency) DO UPDATE SET gross_minor=ledger_totals.gross_minor+excluded.gross_minor,updated_at=excluded.updated_at; END;
CREATE TRIGGER settlements_ledger_total_guard_update BEFORE UPDATE OF group_id,currency,amount_minor,deleted_at ON settlements WHEN NEW.deleted_at IS NULL AND EXISTS(SELECT 1 FROM ledger_summary_state state WHERE state.group_id=NEW.group_id AND state.status='ready' AND state.discovery_complete=1 AND state.maintenance_due=0) AND COALESCE((SELECT gross_minor FROM ledger_totals WHERE group_id=NEW.group_id AND currency=NEW.currency),0)-CASE WHEN OLD.deleted_at IS NULL AND OLD.group_id=NEW.group_id AND OLD.currency=NEW.currency THEN OLD.amount_minor ELSE 0 END>9007199254740991-NEW.amount_minor BEGIN SELECT RAISE(ABORT,'BALANCE_OVERFLOW'); END;
CREATE TRIGGER settlements_ledger_total_scan_guard_update BEFORE UPDATE OF group_id,currency,amount_minor,deleted_at ON settlements WHEN NEW.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM ledger_summary_state state WHERE state.group_id=NEW.group_id AND state.status='ready' AND state.discovery_complete=1 AND state.maintenance_due=0) AND COALESCE((SELECT SUM(amount_minor) FROM settlements WHERE group_id=NEW.group_id AND currency=NEW.currency AND deleted_at IS NULL AND id<>OLD.id),0)+COALESCE((SELECT SUM(amount_minor) FROM expenses WHERE group_id=NEW.group_id AND currency=NEW.currency AND deleted_at IS NULL),0)>9007199254740991-NEW.amount_minor BEGIN SELECT RAISE(ABORT,'BALANCE_OVERFLOW'); END;
CREATE TRIGGER settlements_ledger_total_apply_update AFTER UPDATE OF group_id,currency,amount_minor,deleted_at ON settlements WHEN NEW.projection_mutation_id IS NULL BEGIN UPDATE ledger_totals SET gross_minor=gross_minor-OLD.amount_minor,updated_at=CURRENT_TIMESTAMP WHERE OLD.deleted_at IS NULL AND group_id=OLD.group_id AND currency=OLD.currency AND EXISTS(SELECT 1 FROM ledger_summary_state state WHERE state.group_id=OLD.group_id AND state.status='ready' AND state.discovery_complete=1 AND state.maintenance_due=0); INSERT INTO ledger_totals(group_id,currency,gross_minor,updated_at) SELECT NEW.group_id,NEW.currency,NEW.amount_minor,CURRENT_TIMESTAMP WHERE NEW.deleted_at IS NULL AND EXISTS(SELECT 1 FROM ledger_summary_state state WHERE state.group_id=NEW.group_id AND state.status='ready' AND state.discovery_complete=1 AND state.maintenance_due=0) ON CONFLICT(group_id,currency) DO UPDATE SET gross_minor=ledger_totals.gross_minor+excluded.gross_minor,updated_at=excluded.updated_at; END;
CREATE TRIGGER settlements_ledger_total_apply_delete AFTER DELETE ON settlements WHEN OLD.deleted_at IS NULL AND EXISTS(SELECT 1 FROM ledger_summary_state state WHERE state.group_id=OLD.group_id AND state.status='ready' AND state.discovery_complete=1 AND state.maintenance_due=0) BEGIN UPDATE ledger_totals SET gross_minor=gross_minor-OLD.amount_minor,updated_at=CURRENT_TIMESTAMP WHERE group_id=OLD.group_id AND currency=OLD.currency; END;
