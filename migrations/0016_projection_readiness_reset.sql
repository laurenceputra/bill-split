-- 0013 originally published projections as ready during migration.  Reset
-- those states for installations that applied that version before deploying
-- projection-aware application code.  Backfill will repopulate both tables
-- and publish readiness atomically, one group at a time.
DELETE FROM group_balance_projection;
DELETE FROM ledger_totals;
UPDATE projection_state
SET status='pending',backfill_cursor=NULL,last_rebuilt_at=NULL,updated_at=CURRENT_TIMESTAMP;
