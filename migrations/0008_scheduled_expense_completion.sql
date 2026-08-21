-- D1 runs migrations in a transaction and does not support toggling
-- foreign_keys off inside that transaction. Defer the existing child-table
-- references while the parent is rebuilt instead.
PRAGMA defer_foreign_keys = ON;
DROP INDEX IF EXISTS idx_scheduled_due;
DROP INDEX IF EXISTS idx_scheduled_group;
DROP INDEX IF EXISTS idx_scheduled_generation_claim;
DROP INDEX IF EXISTS idx_scheduled_occurrence_expense;
-- Renaming first makes SQLite update the existing child definitions to point
-- at the temporary parent. The replacement parent can then be created under
-- the original name before the children are rebuilt.
ALTER TABLE scheduled_expenses RENAME TO scheduled_expenses_old;
CREATE TABLE scheduled_expenses_new (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id),
  description TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
  currency TEXT NOT NULL CHECK(currency IN ('USD','EUR','GBP','AUD','CAD','NZD','SGD','HKD','CHF','CNY','INR')),
  start_date TEXT NOT NULL,
  end_date TEXT,
  frequency TEXT NOT NULL CHECK(frequency IN ('daily','weekly','monthly','yearly')),
  interval_count INTEGER NOT NULL CHECK(interval_count > 0 AND interval_count <= 366),
  weekdays_json TEXT NOT NULL DEFAULT '[]',
  timezone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','cancelled','blocked','completed')),
  blocked_reason TEXT,
  next_occurrence_date TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  client_operation_id TEXT,
  generation_claim_id TEXT,
  UNIQUE(created_by, client_operation_id)
);
INSERT INTO scheduled_expenses_new (
  id,group_id,description,amount_minor,currency,start_date,end_date,frequency,
  interval_count,weekdays_json,timezone,status,blocked_reason,next_occurrence_date,
  created_by,created_at,updated_at,version,client_operation_id,generation_claim_id
)
SELECT
  id,group_id,description,amount_minor,currency,start_date,end_date,frequency,
  interval_count,weekdays_json,timezone,status,blocked_reason,next_occurrence_date,
  created_by,created_at,updated_at,version,client_operation_id,generation_claim_id
FROM scheduled_expenses_old;
ALTER TABLE scheduled_expenses_new RENAME TO scheduled_expenses;
CREATE TABLE scheduled_payers_new (
  scheduled_expense_id TEXT NOT NULL REFERENCES scheduled_expenses(id),
  person_id TEXT NOT NULL REFERENCES people(id),
  amount_minor INTEGER NOT NULL CHECK(amount_minor >= 0),
  PRIMARY KEY(scheduled_expense_id, person_id)
);
INSERT INTO scheduled_payers_new (scheduled_expense_id,person_id,amount_minor)
SELECT scheduled_expense_id,person_id,amount_minor FROM scheduled_payers;
CREATE TABLE scheduled_splits_new (
  scheduled_expense_id TEXT NOT NULL REFERENCES scheduled_expenses(id),
  person_id TEXT NOT NULL REFERENCES people(id),
  amount_minor INTEGER NOT NULL CHECK(amount_minor >= 0),
  metadata_json TEXT,
  PRIMARY KEY(scheduled_expense_id, person_id)
);
INSERT INTO scheduled_splits_new (scheduled_expense_id,person_id,amount_minor,metadata_json)
SELECT scheduled_expense_id,person_id,amount_minor,metadata_json FROM scheduled_splits;
CREATE TABLE scheduled_occurrences_new (
  scheduled_expense_id TEXT NOT NULL REFERENCES scheduled_expenses(id),
  occurrence_date TEXT NOT NULL,
  expense_id TEXT NOT NULL UNIQUE REFERENCES expenses(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY(scheduled_expense_id, occurrence_date)
);
INSERT INTO scheduled_occurrences_new (scheduled_expense_id,occurrence_date,expense_id,created_at)
SELECT scheduled_expense_id,occurrence_date,expense_id,created_at FROM scheduled_occurrences;
-- Remove the old children before removing the old parent. This keeps the
-- deferred transaction valid on D1 while retaining every copied child row.
DROP TABLE scheduled_occurrences;
DROP TABLE scheduled_payers;
DROP TABLE scheduled_splits;
DROP TABLE scheduled_expenses_old;
ALTER TABLE scheduled_payers_new RENAME TO scheduled_payers;
ALTER TABLE scheduled_splits_new RENAME TO scheduled_splits;
ALTER TABLE scheduled_occurrences_new RENAME TO scheduled_occurrences;
CREATE INDEX idx_scheduled_due ON scheduled_expenses(status, next_occurrence_date);
CREATE INDEX idx_scheduled_group ON scheduled_expenses(group_id, status);
CREATE INDEX idx_scheduled_generation_claim ON scheduled_expenses(generation_claim_id) WHERE generation_claim_id IS NOT NULL;
CREATE INDEX idx_scheduled_occurrence_expense ON scheduled_occurrences(expense_id);
