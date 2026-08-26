-- Phase 2: add transactionally maintained, per-group/per-currency totals.
-- Existing groups start with ledger totals unready.  The legacy scan guard is
-- retained for those groups until the bounded per-group reconciliation path
-- rebuilds their totals and publishes readiness.

ALTER TABLE projection_state ADD COLUMN ledger_totals_ready INTEGER NOT NULL DEFAULT 0 CHECK(ledger_totals_ready IN (0,1));
ALTER TABLE projection_state ADD COLUMN mutation_count INTEGER NOT NULL DEFAULT 0 CHECK(mutation_count >= 0);
ALTER TABLE projection_state ADD COLUMN last_reconciled_at TEXT;
ALTER TABLE projection_state ADD COLUMN reconciliation_due INTEGER NOT NULL DEFAULT 0 CHECK(reconciliation_due IN (0,1));
ALTER TABLE expenses ADD COLUMN projection_mutation_id TEXT;
ALTER TABLE settlements ADD COLUMN projection_mutation_id TEXT;

-- Do not publish any pre-existing totals or projection as authoritative.  No
-- expense/settlement rows are read here: each group is rebuilt by the bounded
-- application reconciliation below, one group at a time.
UPDATE projection_state
SET ledger_totals_ready=0,
    status=CASE WHEN status='ready' THEN 'stale' ELSE status END,
    reconciliation_due=1,
    updated_at=CURRENT_TIMESTAMP;

DROP TRIGGER IF EXISTS expenses_ledger_total_limit_insert;
DROP TRIGGER IF EXISTS expenses_ledger_total_limit_update;
DROP TRIGGER IF EXISTS settlements_ledger_total_limit_insert;
DROP TRIGGER IF EXISTS settlements_ledger_total_limit_update;

-- Ready groups use the ledger_totals primary key.  Unready groups use the
-- authoritative tables until reconciliation publishes a complete total.
CREATE TRIGGER expenses_ledger_total_guard_insert
BEFORE INSERT ON expenses
WHEN NEW.deleted_at IS NULL
  AND EXISTS (SELECT 1 FROM projection_state state WHERE state.group_id=NEW.group_id AND state.ledger_totals_ready=1)
  AND COALESCE((SELECT gross_minor FROM ledger_totals WHERE group_id=NEW.group_id AND currency=NEW.currency),0)
      > 9007199254740991 - NEW.amount_minor
BEGIN
  SELECT RAISE(ABORT, 'BALANCE_OVERFLOW');
END;

CREATE TRIGGER expenses_ledger_total_scan_guard_insert
BEFORE INSERT ON expenses
WHEN NEW.deleted_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM projection_state state WHERE state.group_id=NEW.group_id AND state.ledger_totals_ready=1)
  AND COALESCE((SELECT SUM(amount_minor) FROM expenses WHERE group_id=NEW.group_id AND currency=NEW.currency AND deleted_at IS NULL),0)
    + COALESCE((SELECT SUM(amount_minor) FROM settlements WHERE group_id=NEW.group_id AND currency=NEW.currency AND deleted_at IS NULL),0)
    > 9007199254740991 - NEW.amount_minor
BEGIN
  SELECT RAISE(ABORT, 'BALANCE_OVERFLOW');
END;

CREATE TRIGGER expenses_ledger_total_apply_insert
AFTER INSERT ON expenses
WHEN NEW.deleted_at IS NULL
  AND EXISTS (SELECT 1 FROM projection_state state WHERE state.group_id=NEW.group_id AND state.ledger_totals_ready=1)
BEGIN
  INSERT INTO ledger_totals(group_id,currency,gross_minor,updated_at)
  VALUES(NEW.group_id,NEW.currency,NEW.amount_minor,CURRENT_TIMESTAMP)
  ON CONFLICT(group_id,currency) DO UPDATE SET
    gross_minor=ledger_totals.gross_minor+excluded.gross_minor,
    updated_at=excluded.updated_at;
END;

CREATE TRIGGER expenses_ledger_total_guard_update
BEFORE UPDATE OF group_id,currency,amount_minor,deleted_at ON expenses
WHEN NEW.deleted_at IS NULL
  AND EXISTS (SELECT 1 FROM projection_state state WHERE state.group_id=NEW.group_id AND state.ledger_totals_ready=1)
  AND COALESCE((SELECT gross_minor FROM ledger_totals WHERE group_id=NEW.group_id AND currency=NEW.currency),0)
      - CASE WHEN OLD.deleted_at IS NULL AND OLD.group_id=NEW.group_id AND OLD.currency=NEW.currency THEN OLD.amount_minor ELSE 0 END
      > 9007199254740991 - NEW.amount_minor
BEGIN
  SELECT RAISE(ABORT, 'BALANCE_OVERFLOW');
END;

CREATE TRIGGER expenses_ledger_total_scan_guard_update
BEFORE UPDATE OF group_id,currency,amount_minor,deleted_at ON expenses
WHEN NEW.deleted_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM projection_state state WHERE state.group_id=NEW.group_id AND state.ledger_totals_ready=1)
  AND COALESCE((SELECT SUM(amount_minor) FROM expenses WHERE group_id=NEW.group_id AND currency=NEW.currency AND deleted_at IS NULL AND id<>OLD.id),0)
    + COALESCE((SELECT SUM(amount_minor) FROM settlements WHERE group_id=NEW.group_id AND currency=NEW.currency AND deleted_at IS NULL),0)
    > 9007199254740991 - NEW.amount_minor
BEGIN
  SELECT RAISE(ABORT, 'BALANCE_OVERFLOW');
END;

CREATE TRIGGER expenses_ledger_total_apply_update
AFTER UPDATE OF group_id,currency,amount_minor,deleted_at ON expenses
BEGIN
  UPDATE ledger_totals SET gross_minor=gross_minor-OLD.amount_minor,updated_at=CURRENT_TIMESTAMP
    WHERE OLD.deleted_at IS NULL AND group_id=OLD.group_id AND currency=OLD.currency
      AND EXISTS (SELECT 1 FROM projection_state state WHERE state.group_id=OLD.group_id AND state.ledger_totals_ready=1);
  INSERT INTO ledger_totals(group_id,currency,gross_minor,updated_at)
  SELECT NEW.group_id,NEW.currency,NEW.amount_minor,CURRENT_TIMESTAMP
    WHERE NEW.deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM projection_state state WHERE state.group_id=NEW.group_id AND state.ledger_totals_ready=1)
  ON CONFLICT(group_id,currency) DO UPDATE SET
    gross_minor=ledger_totals.gross_minor+excluded.gross_minor,
    updated_at=excluded.updated_at;
END;

CREATE TRIGGER expenses_ledger_total_apply_delete
AFTER DELETE ON expenses
WHEN OLD.deleted_at IS NULL
  AND EXISTS (SELECT 1 FROM projection_state state WHERE state.group_id=OLD.group_id AND state.ledger_totals_ready=1)
BEGIN
  UPDATE ledger_totals SET gross_minor=gross_minor-OLD.amount_minor,updated_at=CURRENT_TIMESTAMP
    WHERE group_id=OLD.group_id AND currency=OLD.currency;
END;

CREATE TRIGGER settlements_ledger_total_guard_insert
BEFORE INSERT ON settlements
WHEN NEW.deleted_at IS NULL
  AND EXISTS (SELECT 1 FROM projection_state state WHERE state.group_id=NEW.group_id AND state.ledger_totals_ready=1)
  AND COALESCE((SELECT gross_minor FROM ledger_totals WHERE group_id=NEW.group_id AND currency=NEW.currency),0)
      > 9007199254740991 - NEW.amount_minor
BEGIN
  SELECT RAISE(ABORT, 'BALANCE_OVERFLOW');
END;

CREATE TRIGGER settlements_ledger_total_scan_guard_insert
BEFORE INSERT ON settlements
WHEN NEW.deleted_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM projection_state state WHERE state.group_id=NEW.group_id AND state.ledger_totals_ready=1)
  AND COALESCE((SELECT SUM(amount_minor) FROM expenses WHERE group_id=NEW.group_id AND currency=NEW.currency AND deleted_at IS NULL),0)
    + COALESCE((SELECT SUM(amount_minor) FROM settlements WHERE group_id=NEW.group_id AND currency=NEW.currency AND deleted_at IS NULL),0)
    > 9007199254740991 - NEW.amount_minor
BEGIN
  SELECT RAISE(ABORT, 'BALANCE_OVERFLOW');
END;

CREATE TRIGGER settlements_ledger_total_apply_insert
AFTER INSERT ON settlements
WHEN NEW.deleted_at IS NULL
  AND EXISTS (SELECT 1 FROM projection_state state WHERE state.group_id=NEW.group_id AND state.ledger_totals_ready=1)
BEGIN
  INSERT INTO ledger_totals(group_id,currency,gross_minor,updated_at)
  VALUES(NEW.group_id,NEW.currency,NEW.amount_minor,CURRENT_TIMESTAMP)
  ON CONFLICT(group_id,currency) DO UPDATE SET
    gross_minor=ledger_totals.gross_minor+excluded.gross_minor,
    updated_at=excluded.updated_at;
END;

CREATE TRIGGER settlements_ledger_total_guard_update
BEFORE UPDATE OF group_id,currency,amount_minor,deleted_at ON settlements
WHEN NEW.deleted_at IS NULL
  AND EXISTS (SELECT 1 FROM projection_state state WHERE state.group_id=NEW.group_id AND state.ledger_totals_ready=1)
  AND COALESCE((SELECT gross_minor FROM ledger_totals WHERE group_id=NEW.group_id AND currency=NEW.currency),0)
      - CASE WHEN OLD.deleted_at IS NULL AND OLD.group_id=NEW.group_id AND OLD.currency=NEW.currency THEN OLD.amount_minor ELSE 0 END
      > 9007199254740991 - NEW.amount_minor
BEGIN
  SELECT RAISE(ABORT, 'BALANCE_OVERFLOW');
END;

CREATE TRIGGER settlements_ledger_total_scan_guard_update
BEFORE UPDATE OF group_id,currency,amount_minor,deleted_at ON settlements
WHEN NEW.deleted_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM projection_state state WHERE state.group_id=NEW.group_id AND state.ledger_totals_ready=1)
  AND COALESCE((SELECT SUM(amount_minor) FROM settlements WHERE group_id=NEW.group_id AND currency=NEW.currency AND deleted_at IS NULL AND id<>OLD.id),0)
    + COALESCE((SELECT SUM(amount_minor) FROM expenses WHERE group_id=NEW.group_id AND currency=NEW.currency AND deleted_at IS NULL),0)
    > 9007199254740991 - NEW.amount_minor
BEGIN
  SELECT RAISE(ABORT, 'BALANCE_OVERFLOW');
END;

CREATE TRIGGER settlements_ledger_total_apply_update
AFTER UPDATE OF group_id,currency,amount_minor,deleted_at ON settlements
BEGIN
  UPDATE ledger_totals SET gross_minor=gross_minor-OLD.amount_minor,updated_at=CURRENT_TIMESTAMP
    WHERE OLD.deleted_at IS NULL AND group_id=OLD.group_id AND currency=OLD.currency
      AND EXISTS (SELECT 1 FROM projection_state state WHERE state.group_id=OLD.group_id AND state.ledger_totals_ready=1);
  INSERT INTO ledger_totals(group_id,currency,gross_minor,updated_at)
  SELECT NEW.group_id,NEW.currency,NEW.amount_minor,CURRENT_TIMESTAMP
    WHERE NEW.deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM projection_state state WHERE state.group_id=NEW.group_id AND state.ledger_totals_ready=1)
  ON CONFLICT(group_id,currency) DO UPDATE SET
    gross_minor=ledger_totals.gross_minor+excluded.gross_minor,
    updated_at=excluded.updated_at;
END;

CREATE TRIGGER settlements_ledger_total_apply_delete
AFTER DELETE ON settlements
WHEN OLD.deleted_at IS NULL
  AND EXISTS (SELECT 1 FROM projection_state state WHERE state.group_id=OLD.group_id AND state.ledger_totals_ready=1)
BEGIN
  UPDATE ledger_totals SET gross_minor=gross_minor-OLD.amount_minor,updated_at=CURRENT_TIMESTAMP
    WHERE group_id=OLD.group_id AND currency=OLD.currency;
END;
