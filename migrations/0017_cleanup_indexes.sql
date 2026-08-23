-- Remove only indexes whose exact key is already enforced by a named
-- constraint or duplicated by the canonical keyset index.
DROP INDEX IF EXISTS idx_audit_group_time;
DROP INDEX IF EXISTS idx_expenses_operation;
DROP INDEX IF EXISTS idx_scheduled_occurrence_expense;
