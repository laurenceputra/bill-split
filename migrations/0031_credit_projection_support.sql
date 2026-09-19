-- Add credits to the bounded monthly/checkpoint projection. Credit entries
-- have zero gross total, but their signed allocations are balance
-- contributions and must be discoverable/reconciled like every other ledger
-- entity.
ALTER TABLE credits ADD COLUMN projection_mutation_id TEXT;
ALTER TABLE ledger_summary_state ADD COLUMN credit_discovery_cursor TEXT;
ALTER TABLE ledger_summary_state ADD COLUMN credit_discovery_high_water TEXT;
ALTER TABLE ledger_period_state ADD COLUMN credit_cursor TEXT;
ALTER TABLE ledger_period_state ADD COLUMN credit_high_water TEXT;
CREATE INDEX idx_credits_projection_mutation ON credits(group_id, projection_mutation_id);
CREATE INDEX idx_credits_group_id ON credits(group_id, id);

-- Once a live credit is linked, preserve the expense's original gross amount.
-- This is intentionally stricter than checking only the applied subtotal: a
-- later reduction could otherwise leave a valid-looking but historically
-- mutated expense behind the credit snapshot.
DROP TRIGGER IF EXISTS credit_expense_amount_guard;
CREATE TRIGGER credit_expense_amount_guard BEFORE UPDATE OF amount_minor,currency,group_id ON expenses
WHEN OLD.deleted_at IS NULL AND EXISTS (SELECT 1 FROM credit_applications a JOIN credits c ON c.id=a.credit_id WHERE a.expense_id=OLD.id AND c.deleted_at IS NULL)
 AND (NEW.amount_minor IS NOT OLD.amount_minor OR NEW.currency IS NOT OLD.currency OR NEW.group_id IS NOT OLD.group_id)
BEGIN SELECT RAISE(ABORT,'CREDIT_EXPENSE_LINKED'); END;

-- 0030 may already have live credits while the summary is ready or has folded
-- the affected month into its checkpoint. Requeue those groups and rebuild the
-- affected period builds; otherwise the new credit discovery cursor could be
-- initialized at the high-water mark and the existing rows would be skipped.
UPDATE ledger_summary_state
SET status='pending', discovery_complete=0, credit_discovery_cursor=NULL,
    credit_discovery_high_water=(SELECT MAX(id) FROM credits WHERE credits.group_id=ledger_summary_state.group_id),
    maintenance_due=1, available_at_ms=CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), updated_at=CURRENT_TIMESTAMP
WHERE EXISTS (SELECT 1 FROM credits WHERE credits.group_id=ledger_summary_state.group_id AND credits.deleted_at IS NULL);

UPDATE ledger_period_state
SET status='dirty', source_generation=source_generation+1,
    expense_cursor=NULL, settlement_cursor=NULL, credit_cursor=NULL,
    expense_high_water=NULL, settlement_high_water=NULL, credit_high_water=NULL,
    retry_at_ms=NULL, last_error=NULL, updated_at=CURRENT_TIMESTAMP
WHERE EXISTS (SELECT 1 FROM credits WHERE credits.group_id=ledger_period_state.group_id
  AND credits.deleted_at IS NULL AND substr(credits.credit_date,1,7)||'-01'=ledger_period_state.month);

INSERT INTO ledger_period_state(group_id,month,status,source_generation,updated_at)
SELECT c.group_id,substr(c.credit_date,1,7)||'-01','pending',0,CURRENT_TIMESTAMP
FROM credits c
WHERE c.deleted_at IS NULL
GROUP BY c.group_id,substr(c.credit_date,1,7)
ON CONFLICT(group_id,month) DO UPDATE SET status='dirty',source_generation=ledger_period_state.source_generation+1,
  expense_cursor=NULL,settlement_cursor=NULL,credit_cursor=NULL,expense_high_water=NULL,settlement_high_water=NULL,credit_high_water=NULL,
  retry_at_ms=NULL,last_error=NULL,updated_at=CURRENT_TIMESTAMP;
