-- Debts never enter the payment table or its monthly materialization.
-- An older Worker can keep maintaining that base materialization on rollback
-- without reading or reclassifying debt as payments.
CREATE TABLE debts (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  debtor_person_id TEXT NOT NULL REFERENCES people(id),
  creditor_person_id TEXT NOT NULL REFERENCES people(id),
  amount_minor INTEGER NOT NULL CHECK(typeof(amount_minor)='integer' AND amount_minor > 0 AND amount_minor <= 9007199254740991),
  currency TEXT NOT NULL CHECK(currency IN ('USD','EUR','GBP','AUD','CAD','NZD','SGD','HKD','CHF','CNY','INR')),
  debt_date TEXT NOT NULL, note TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  CHECK(debtor_person_id <> creditor_person_id)
);
CREATE INDEX idx_debts_group_date ON debts(group_id,debt_date DESC,created_at DESC,id DESC);
CREATE INDEX idx_debts_group_currency ON debts(group_id,currency);

CREATE VIEW debt_balance_contributions AS
  SELECT group_id,currency,debtor_person_id AS person_id,-amount_minor AS net_minor FROM debts
  UNION ALL SELECT group_id,currency,creditor_person_id,amount_minor FROM debts;
CREATE TRIGGER debts_immutable BEFORE UPDATE ON debts
BEGIN SELECT RAISE(ABORT,'DEBT_IMMUTABLE'); END;

CREATE TRIGGER ledger_revision_debt_insert AFTER INSERT ON debts BEGIN
  UPDATE groups SET ledger_revision=ledger_revision+1 WHERE id=NEW.group_id;
END;
CREATE TRIGGER ledger_revision_debt_delete AFTER DELETE ON debts BEGIN
  UPDATE groups SET ledger_revision=ledger_revision+1 WHERE id=OLD.group_id;
END;

-- The ordinary ledger guards remain intact. These additional guards also
-- enforce the combined limit on writes made by a pre-debt Worker, independent
-- of monthly projection state. Two-sided movements use the settlement bound.
CREATE VIEW ledger_gross_with_debts AS
  SELECT group_id,currency,amount_minor AS magnitude FROM expenses WHERE deleted_at IS NULL
  UNION ALL SELECT group_id,currency,amount_minor*2 FROM settlements WHERE deleted_at IS NULL
  UNION ALL SELECT c.group_id,c.currency,a.amount_minor FROM credits c JOIN credit_allocations a ON a.credit_id=c.id WHERE c.deleted_at IS NULL
  UNION ALL SELECT group_id,currency,amount_minor*2 FROM debts;

CREATE TRIGGER debts_ledger_limit_insert BEFORE INSERT ON debts
WHEN COALESCE((SELECT SUM(magnitude) FROM ledger_gross_with_debts WHERE group_id=NEW.group_id AND currency=NEW.currency),0)
  > 9007199254740991-NEW.amount_minor*2
BEGIN SELECT RAISE(ABORT,'BALANCE_OVERFLOW'); END;

CREATE TRIGGER debt_limit_expense_insert BEFORE INSERT ON expenses
WHEN NEW.deleted_at IS NULL AND EXISTS (SELECT 1 FROM debts WHERE group_id=NEW.group_id AND currency=NEW.currency)
  AND (SELECT SUM(magnitude) FROM ledger_gross_with_debts WHERE group_id=NEW.group_id AND currency=NEW.currency)>9007199254740991-NEW.amount_minor
BEGIN SELECT RAISE(ABORT,'BALANCE_OVERFLOW'); END;
CREATE TRIGGER debt_limit_expense_update BEFORE UPDATE OF group_id,currency,amount_minor,deleted_at ON expenses
WHEN NEW.deleted_at IS NULL AND EXISTS (SELECT 1 FROM debts WHERE group_id=NEW.group_id AND currency=NEW.currency)
  AND (SELECT SUM(magnitude) FROM ledger_gross_with_debts WHERE group_id=NEW.group_id AND currency=NEW.currency)
    - CASE WHEN OLD.deleted_at IS NULL AND OLD.group_id=NEW.group_id AND OLD.currency=NEW.currency THEN OLD.amount_minor ELSE 0 END
    > 9007199254740991-NEW.amount_minor
BEGIN SELECT RAISE(ABORT,'BALANCE_OVERFLOW'); END;
CREATE TRIGGER debt_limit_settlement_insert BEFORE INSERT ON settlements
WHEN NEW.deleted_at IS NULL AND EXISTS (SELECT 1 FROM debts WHERE group_id=NEW.group_id AND currency=NEW.currency)
  AND (SELECT SUM(magnitude) FROM ledger_gross_with_debts WHERE group_id=NEW.group_id AND currency=NEW.currency)>9007199254740991-NEW.amount_minor*2
BEGIN SELECT RAISE(ABORT,'BALANCE_OVERFLOW'); END;
CREATE TRIGGER debt_limit_settlement_update BEFORE UPDATE OF group_id,currency,amount_minor,deleted_at ON settlements
WHEN NEW.deleted_at IS NULL AND EXISTS (SELECT 1 FROM debts WHERE group_id=NEW.group_id AND currency=NEW.currency)
  AND (SELECT SUM(magnitude) FROM ledger_gross_with_debts WHERE group_id=NEW.group_id AND currency=NEW.currency)
    - CASE WHEN OLD.deleted_at IS NULL AND OLD.group_id=NEW.group_id AND OLD.currency=NEW.currency THEN OLD.amount_minor*2 ELSE 0 END
    > 9007199254740991-NEW.amount_minor*2
BEGIN SELECT RAISE(ABORT,'BALANCE_OVERFLOW'); END;
CREATE TRIGGER debt_limit_credit_allocation_insert BEFORE INSERT ON credit_allocations
WHEN EXISTS (SELECT 1 FROM credits c WHERE c.id=NEW.credit_id AND c.deleted_at IS NULL
  AND EXISTS (SELECT 1 FROM debts WHERE group_id=c.group_id AND currency=c.currency)
  AND (SELECT SUM(magnitude) FROM ledger_gross_with_debts WHERE group_id=c.group_id AND currency=c.currency)>9007199254740991-NEW.amount_minor)
BEGIN SELECT RAISE(ABORT,'BALANCE_OVERFLOW'); END;
CREATE TRIGGER debt_limit_credit_allocation_update BEFORE UPDATE OF credit_id,person_id,allocation_type,amount_minor ON credit_allocations
WHEN EXISTS (SELECT 1 FROM credits c WHERE c.id=NEW.credit_id AND c.deleted_at IS NULL
  AND EXISTS (SELECT 1 FROM debts WHERE group_id=c.group_id AND currency=c.currency)
  AND (SELECT SUM(magnitude) FROM ledger_gross_with_debts WHERE group_id=c.group_id AND currency=c.currency)
    - CASE WHEN EXISTS (SELECT 1 FROM credits old_credit WHERE old_credit.id=OLD.credit_id AND old_credit.deleted_at IS NULL
      AND old_credit.group_id=c.group_id AND old_credit.currency=c.currency) THEN OLD.amount_minor ELSE 0 END
    > 9007199254740991-NEW.amount_minor)
BEGIN SELECT RAISE(ABORT,'BALANCE_OVERFLOW'); END;
CREATE TRIGGER debt_limit_credit_update BEFORE UPDATE OF group_id,currency,deleted_at ON credits
WHEN NEW.deleted_at IS NULL AND (OLD.deleted_at IS NOT NULL OR OLD.group_id<>NEW.group_id OR OLD.currency<>NEW.currency)
  AND EXISTS (SELECT 1 FROM debts WHERE group_id=NEW.group_id AND currency=NEW.currency)
  AND (SELECT SUM(magnitude) FROM ledger_gross_with_debts WHERE group_id=NEW.group_id AND currency=NEW.currency)
    > 9007199254740991-COALESCE((SELECT SUM(amount_minor) FROM credit_allocations WHERE credit_id=OLD.id),0)
BEGIN SELECT RAISE(ABORT,'BALANCE_OVERFLOW'); END;

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
