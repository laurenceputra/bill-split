CREATE TABLE scheduled_expenses (
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
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','cancelled','blocked')),
  blocked_reason TEXT,
  next_occurrence_date TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  client_operation_id TEXT,
  UNIQUE(created_by, client_operation_id)
);
CREATE TABLE scheduled_payers (
  scheduled_expense_id TEXT NOT NULL REFERENCES scheduled_expenses(id),
  person_id TEXT NOT NULL REFERENCES people(id), amount_minor INTEGER NOT NULL CHECK(amount_minor >= 0),
  PRIMARY KEY(scheduled_expense_id, person_id)
);
CREATE TABLE scheduled_splits (
  scheduled_expense_id TEXT NOT NULL REFERENCES scheduled_expenses(id),
  person_id TEXT NOT NULL REFERENCES people(id), amount_minor INTEGER NOT NULL CHECK(amount_minor >= 0), metadata_json TEXT,
  PRIMARY KEY(scheduled_expense_id, person_id)
);
CREATE TABLE scheduled_occurrences (
  scheduled_expense_id TEXT NOT NULL REFERENCES scheduled_expenses(id),
  occurrence_date TEXT NOT NULL,
  expense_id TEXT NOT NULL UNIQUE REFERENCES expenses(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY(scheduled_expense_id, occurrence_date)
);
CREATE INDEX idx_scheduled_due ON scheduled_expenses(status, next_occurrence_date);
CREATE INDEX idx_scheduled_group ON scheduled_expenses(group_id, status);
CREATE INDEX idx_scheduled_occurrence_expense ON scheduled_occurrences(expense_id);
