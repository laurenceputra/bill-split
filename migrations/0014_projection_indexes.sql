-- Stable keyset order indexes.  The id tie-breaker is intentional: created_at
-- is not unique in D1 and must not be used as a page boundary by itself.
CREATE INDEX IF NOT EXISTS idx_expenses_group_keyset
  ON expenses(group_id, expense_date DESC, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_expenses_group_keyset_active
  ON expenses(group_id, expense_date DESC, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_settlements_group_keyset
  ON settlements(group_id, settlement_date DESC, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_settlements_group_keyset_active
  ON settlements(group_id, settlement_date DESC, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_audit_group_keyset
  ON audit_events(group_id, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_revisions_entity_activity
  ON revisions(entity_type, entity_id, created_at DESC, id DESC);

-- Person-leading indexes make the participant filter bounded and avoid a
-- scan of every expense when a large ledger is queried by person.
CREATE INDEX IF NOT EXISTS idx_payers_person_expense ON payers(person_id, expense_id);
CREATE INDEX IF NOT EXISTS idx_splits_person_expense ON splits(person_id, expense_id);
CREATE INDEX IF NOT EXISTS idx_settlements_from_person ON settlements(group_id, from_person_id, settlement_date DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_settlements_to_person ON settlements(group_id, to_person_id, settlement_date DESC, id DESC);
