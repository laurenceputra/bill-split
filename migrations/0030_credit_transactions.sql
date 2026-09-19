-- Confirmed credits are independent ledger transactions. They are not
-- settlements and are never represented as negative expenses.
PRAGMA foreign_keys = ON;

-- audit_events had a closed entity-type CHECK constraint. Rebuild it so credit
-- audit history is first-class while retaining all existing rows.
ALTER TABLE audit_events RENAME TO audit_events_old;
CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id),
  entity_type TEXT NOT NULL CHECK(entity_type IN ('expense','settlement','credit')),
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

CREATE TABLE credits (
  id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id),
  subtype TEXT NOT NULL CHECK(subtype IN ('refund','claim')),
  delivery_mode TEXT NOT NULL CHECK(delivery_mode IN ('member_reimbursement','direct_provider_offset')),
  amount_minor INTEGER NOT NULL CHECK(amount_minor > 0 AND amount_minor<=9007199254740991),
  currency TEXT NOT NULL CHECK(currency IN ('USD','EUR','GBP','AUD','CAD','NZD','SGD','HKD','CHF','CNY','INR')),
  credit_date TEXT NOT NULL, note TEXT, created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
  client_operation_id TEXT, version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  UNIQUE(created_by, client_operation_id)
);
CREATE TABLE credit_applications (
  credit_id TEXT NOT NULL REFERENCES credits(id), expense_id TEXT NOT NULL REFERENCES expenses(id),
  amount_minor INTEGER NOT NULL CHECK(amount_minor > 0 AND amount_minor<=9007199254740991), PRIMARY KEY(credit_id, expense_id)
);
CREATE TABLE credit_allocations (
  credit_id TEXT NOT NULL REFERENCES credits(id), person_id TEXT NOT NULL REFERENCES people(id),
  allocation_type TEXT NOT NULL CHECK(allocation_type IN ('recipient','beneficiary')),
  amount_minor INTEGER NOT NULL CHECK(amount_minor > 0 AND amount_minor<=9007199254740991), PRIMARY KEY(credit_id, person_id, allocation_type)
);
CREATE INDEX idx_credits_group_date ON credits(group_id, credit_date DESC, created_at DESC, id DESC);
CREATE INDEX idx_credit_applications_expense ON credit_applications(expense_id, credit_id);
CREATE INDEX idx_credit_allocations_credit ON credit_allocations(credit_id, allocation_type, person_id);
CREATE TRIGGER credit_allocation_guard_insert BEFORE INSERT ON credit_allocations
BEGIN
  SELECT RAISE(ABORT,'CREDIT_ALLOCATION_INVALID') WHERE (SELECT COALESCE(SUM(amount_minor),0) FROM credit_allocations WHERE credit_id=NEW.credit_id AND allocation_type=NEW.allocation_type)+NEW.amount_minor>(SELECT amount_minor FROM credits WHERE id=NEW.credit_id);
END;
CREATE TRIGGER credit_allocation_guard_update BEFORE UPDATE OF credit_id,allocation_type,amount_minor ON credit_allocations
BEGIN
  SELECT RAISE(ABORT,'CREDIT_ALLOCATION_INVALID') WHERE (SELECT COALESCE(SUM(amount_minor),0) FROM credit_allocations WHERE credit_id=NEW.credit_id AND allocation_type=NEW.allocation_type AND NOT (credit_id=OLD.credit_id AND person_id=OLD.person_id AND allocation_type=OLD.allocation_type))+NEW.amount_minor>(SELECT amount_minor FROM credits WHERE id=NEW.credit_id);
END;

-- SQLite serializes these trigger checks with the write that changes the
-- authoritative row, so concurrent applications cannot oversubscribe credit
-- or expense capacity.
CREATE TRIGGER credit_application_guard_insert BEFORE INSERT ON credit_applications
BEGIN
  SELECT RAISE(ABORT,'CREDIT_APPLICATION_INVALID') WHERE NOT EXISTS (
    SELECT 1 FROM credits c JOIN expenses e ON e.id=NEW.expense_id
    WHERE c.id=NEW.credit_id AND c.deleted_at IS NULL AND e.deleted_at IS NULL
      AND c.group_id=e.group_id AND c.currency=e.currency
      AND (SELECT COALESCE(SUM(amount_minor),0) FROM credit_applications WHERE credit_id=NEW.credit_id)+NEW.amount_minor<=c.amount_minor
      AND (SELECT COALESCE(SUM(amount_minor),0) FROM credit_applications a WHERE a.expense_id=NEW.expense_id AND a.credit_id IN (SELECT id FROM credits WHERE deleted_at IS NULL))+NEW.amount_minor<=e.amount_minor
  );
END;
CREATE TRIGGER credit_application_guard_update BEFORE UPDATE OF credit_id,expense_id,amount_minor ON credit_applications
BEGIN
  SELECT RAISE(ABORT,'CREDIT_APPLICATION_INVALID') WHERE NOT EXISTS (
    SELECT 1 FROM credits c JOIN expenses e ON e.id=NEW.expense_id
    WHERE c.id=NEW.credit_id AND c.deleted_at IS NULL AND e.deleted_at IS NULL AND c.group_id=e.group_id AND c.currency=e.currency
      AND (SELECT COALESCE(SUM(amount_minor),0) FROM credit_applications WHERE credit_id=NEW.credit_id AND NOT (credit_id=OLD.credit_id AND expense_id=OLD.expense_id))+NEW.amount_minor<=c.amount_minor
      AND (SELECT COALESCE(SUM(amount_minor),0) FROM credit_applications a WHERE a.expense_id=NEW.expense_id AND NOT (a.credit_id=OLD.credit_id AND a.expense_id=OLD.expense_id) AND a.credit_id IN (SELECT id FROM credits WHERE deleted_at IS NULL))+NEW.amount_minor<=e.amount_minor
  );
END;
CREATE TRIGGER credit_expense_delete_guard BEFORE UPDATE OF deleted_at ON expenses
WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL AND EXISTS (SELECT 1 FROM credit_applications a JOIN credits c ON c.id=a.credit_id WHERE a.expense_id=OLD.id AND c.deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'CREDIT_EXPENSE_LINKED'); END;
CREATE TRIGGER credit_expense_amount_guard BEFORE UPDATE OF amount_minor,currency,group_id ON expenses
WHEN OLD.deleted_at IS NULL AND EXISTS (SELECT 1 FROM credit_applications a JOIN credits c ON c.id=a.credit_id WHERE a.expense_id=OLD.id AND c.deleted_at IS NULL)
 AND (NEW.currency IS NOT OLD.currency OR NEW.group_id IS NOT OLD.group_id OR NEW.amount_minor < (SELECT COALESCE(SUM(a.amount_minor),0) FROM credit_applications a JOIN credits c ON c.id=a.credit_id WHERE a.expense_id=OLD.id AND c.deleted_at IS NULL))
BEGIN SELECT RAISE(ABORT,'CREDIT_EXPENSE_LINKED'); END;
CREATE TRIGGER credit_restore_guard BEFORE UPDATE OF deleted_at ON expenses
WHEN NEW.deleted_at IS NULL AND OLD.deleted_at IS NOT NULL AND EXISTS (SELECT 1 FROM credit_applications a JOIN credits c ON c.id=a.credit_id WHERE a.expense_id=OLD.id AND c.deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'CREDIT_EXPENSE_LINKED'); END;
CREATE TRIGGER credit_restore_application_guard BEFORE UPDATE OF deleted_at ON credits
WHEN NEW.deleted_at IS NULL AND OLD.deleted_at IS NOT NULL AND EXISTS (
  SELECT 1 FROM credit_applications a JOIN expenses e ON e.id=a.expense_id
  WHERE a.credit_id=OLD.id AND (e.deleted_at IS NOT NULL OR e.group_id!=NEW.group_id OR e.currency!=NEW.currency
    OR (SELECT COALESCE(SUM(x.amount_minor),0) FROM credit_applications x WHERE x.expense_id=e.id AND x.credit_id IN (SELECT id FROM credits WHERE deleted_at IS NULL OR id=OLD.id))>e.amount_minor)
)
BEGIN SELECT RAISE(ABORT,'CREDIT_APPLICATION_INVALID'); END;
