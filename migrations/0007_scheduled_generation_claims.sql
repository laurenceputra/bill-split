-- A generation batch claims a schedule cursor before inserting its ordinary
-- expense.  The claim is cleared by the same batch when the cursor advances;
-- status/version/member predicates make pause, cancel, edit, and membership
-- changes win cleanly against an in-flight generation.
ALTER TABLE scheduled_expenses ADD COLUMN generation_claim_id TEXT;
CREATE INDEX idx_scheduled_generation_claim ON scheduled_expenses(generation_claim_id) WHERE generation_claim_id IS NOT NULL;
