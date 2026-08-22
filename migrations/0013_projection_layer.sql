-- The projection layer is additive.  The legacy ledger-limit triggers in
-- 0003 remain authoritative while projections are being rolled out.
CREATE TABLE ledger_totals (
  group_id TEXT NOT NULL REFERENCES groups(id),
  currency TEXT NOT NULL,
  gross_minor INTEGER NOT NULL CHECK(gross_minor >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(group_id, currency)
);

CREATE TABLE group_balance_projection (
  group_id TEXT NOT NULL REFERENCES groups(id),
  currency TEXT NOT NULL,
  person_id TEXT NOT NULL REFERENCES people(id),
  net_minor INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(group_id, currency, person_id)
);

CREATE TABLE projection_state (
  group_id TEXT PRIMARY KEY REFERENCES groups(id),
  status TEXT NOT NULL CHECK(status IN ('pending','backfilling','ready','stale')),
  backfill_cursor TEXT,
  last_rebuilt_at TEXT,
  updated_at TEXT NOT NULL
);

-- Migration-first safety: do not publish a projection assembled before the
-- projection-aware Worker is deployed.  The Worker keeps the old aggregate
-- authoritative while these rows are pending.  projectionBackfill() rebuilds
-- one group in a bounded atomic batch and is the only path that publishes
-- status='ready' for existing groups.
INSERT INTO projection_state(group_id,status,backfill_cursor,last_rebuilt_at,updated_at)
SELECT id,'pending',NULL,NULL,CURRENT_TIMESTAMP FROM groups;
