-- Include active credit allocation magnitude in the legacy expense and
-- settlement guards as well as the credit-side guards.  The compact
-- ledger_totals path does not store credit allocations, so both paths must
-- consult the authoritative allocation rows to make mutation order irrelevant.
DROP TRIGGER IF EXISTS expenses_ledger_total_guard_insert;
DROP TRIGGER IF EXISTS expenses_ledger_total_scan_guard_insert;
DROP TRIGGER IF EXISTS expenses_ledger_total_guard_update;
DROP TRIGGER IF EXISTS expenses_ledger_total_scan_guard_update;
DROP TRIGGER IF EXISTS settlements_ledger_total_guard_insert;
DROP TRIGGER IF EXISTS settlements_ledger_total_scan_guard_insert;
DROP TRIGGER IF EXISTS settlements_ledger_total_guard_update;
DROP TRIGGER IF EXISTS settlements_ledger_total_scan_guard_update;
DROP TRIGGER IF EXISTS credit_allocation_safe_guard_insert;
DROP TRIGGER IF EXISTS credit_allocation_safe_guard_update;
DROP TRIGGER IF EXISTS credit_application_safe_guard_insert;
DROP TRIGGER IF EXISTS credit_application_safe_guard_update;
DROP TRIGGER IF EXISTS credit_safe_guard_update;

CREATE TRIGGER expenses_ledger_total_guard_insert BEFORE INSERT ON expenses
WHEN NEW.deleted_at IS NULL
  AND EXISTS(SELECT 1 FROM ledger_summary_state state WHERE state.group_id=NEW.group_id AND state.status='ready' AND state.discovery_complete=1 AND state.maintenance_due=0)
  AND (COALESCE((SELECT SUM(amount_minor) FROM expenses WHERE group_id=NEW.group_id AND currency=NEW.currency AND deleted_at IS NULL),0)
    + COALESCE((SELECT SUM(amount_minor*2) FROM settlements WHERE group_id=NEW.group_id AND currency=NEW.currency AND deleted_at IS NULL),0)
    + COALESCE((SELECT SUM(a.amount_minor) FROM credit_allocations a JOIN credits c ON c.id=a.credit_id WHERE c.group_id=NEW.group_id AND c.currency=NEW.currency AND c.deleted_at IS NULL),0)
      > 9007199254740991-NEW.amount_minor
  OR COALESCE((SELECT gross_minor FROM ledger_totals WHERE group_id=NEW.group_id AND currency=NEW.currency),0)
    + COALESCE((SELECT SUM(a.amount_minor) FROM credit_allocations a JOIN credits c ON c.id=a.credit_id WHERE c.group_id=NEW.group_id AND c.currency=NEW.currency AND c.deleted_at IS NULL),0)
      > 9007199254740991-NEW.amount_minor)
BEGIN SELECT RAISE(ABORT,'BALANCE_OVERFLOW'); END;

-- Credit-side mutations use the same expense gross contribution. This closes
-- the reverse order where an expense already at the limit could otherwise be
-- followed by an allocation write because the old guard only summed payers
-- and splits.
CREATE TRIGGER credit_allocation_safe_guard_insert BEFORE INSERT ON credit_allocations
WHEN EXISTS (
  SELECT 1 FROM (
    SELECT e.group_id,e.currency,e.amount_minor FROM expenses e WHERE e.deleted_at IS NULL
    UNION ALL SELECT s.group_id,s.currency,s.amount_minor*2 FROM settlements s WHERE s.deleted_at IS NULL
    UNION ALL SELECT c.group_id,c.currency,a.amount_minor FROM credits c JOIN credit_allocations a ON a.credit_id=c.id WHERE c.deleted_at IS NULL
    UNION ALL SELECT c.group_id,c.currency,NEW.amount_minor FROM credits c WHERE c.id=NEW.credit_id AND c.deleted_at IS NULL
  ) ledger GROUP BY group_id,currency HAVING SUM(amount_minor)>9007199254740991
)
BEGIN SELECT RAISE(ABORT,'BALANCE_OVERFLOW'); END;

CREATE TRIGGER credit_allocation_safe_guard_update BEFORE UPDATE OF credit_id,person_id,allocation_type,amount_minor ON credit_allocations
WHEN EXISTS (
  SELECT 1 FROM (
    SELECT e.group_id,e.currency,e.amount_minor FROM expenses e WHERE e.deleted_at IS NULL
    UNION ALL SELECT s.group_id,s.currency,s.amount_minor*2 FROM settlements s WHERE s.deleted_at IS NULL
    UNION ALL SELECT c.group_id,c.currency,a.amount_minor FROM credits c JOIN credit_allocations a ON a.credit_id=c.id WHERE c.deleted_at IS NULL AND NOT (a.credit_id=OLD.credit_id AND a.person_id=OLD.person_id AND a.allocation_type=OLD.allocation_type)
    UNION ALL SELECT c.group_id,c.currency,NEW.amount_minor FROM credits c WHERE c.id=NEW.credit_id AND c.deleted_at IS NULL
  ) ledger GROUP BY group_id,currency HAVING SUM(amount_minor)>9007199254740991
)
BEGIN SELECT RAISE(ABORT,'BALANCE_OVERFLOW'); END;

CREATE TRIGGER credit_application_safe_guard_insert BEFORE INSERT ON credit_applications
WHEN EXISTS (
  SELECT 1 FROM (
    SELECT e.group_id,e.currency,e.amount_minor FROM expenses e WHERE e.deleted_at IS NULL
    UNION ALL SELECT s.group_id,s.currency,s.amount_minor*2 FROM settlements s WHERE s.deleted_at IS NULL
    UNION ALL SELECT c.group_id,c.currency,a.amount_minor FROM credits c JOIN credit_allocations a ON a.credit_id=c.id WHERE c.deleted_at IS NULL
  ) ledger GROUP BY group_id,currency HAVING SUM(amount_minor)>9007199254740991
)
BEGIN SELECT RAISE(ABORT,'BALANCE_OVERFLOW'); END;

CREATE TRIGGER credit_application_safe_guard_update BEFORE UPDATE OF credit_id,expense_id,amount_minor ON credit_applications
WHEN EXISTS (
  SELECT 1 FROM (
    SELECT e.group_id,e.currency,e.amount_minor FROM expenses e WHERE e.deleted_at IS NULL
    UNION ALL SELECT s.group_id,s.currency,s.amount_minor*2 FROM settlements s WHERE s.deleted_at IS NULL
    UNION ALL SELECT c.group_id,c.currency,a.amount_minor FROM credits c JOIN credit_allocations a ON a.credit_id=c.id WHERE c.deleted_at IS NULL
  ) ledger GROUP BY group_id,currency HAVING SUM(amount_minor)>9007199254740991
)
BEGIN SELECT RAISE(ABORT,'BALANCE_OVERFLOW'); END;

CREATE TRIGGER credit_safe_guard_update BEFORE UPDATE OF group_id,currency,deleted_at ON credits
WHEN NEW.deleted_at IS NULL AND EXISTS (
  SELECT 1 FROM (
    SELECT e.group_id,e.currency,e.amount_minor FROM expenses e WHERE e.deleted_at IS NULL
    UNION ALL SELECT s.group_id,s.currency,s.amount_minor*2 FROM settlements s WHERE s.deleted_at IS NULL
    UNION ALL SELECT CASE WHEN c.id=OLD.id THEN NEW.group_id ELSE c.group_id END,CASE WHEN c.id=OLD.id THEN NEW.currency ELSE c.currency END,a.amount_minor
      FROM credits c JOIN credit_allocations a ON a.credit_id=c.id
      WHERE c.deleted_at IS NULL OR (c.id=OLD.id AND NEW.deleted_at IS NULL)
  ) ledger GROUP BY group_id,currency HAVING SUM(amount_minor)>9007199254740991
)
BEGIN SELECT RAISE(ABORT,'BALANCE_OVERFLOW'); END;

CREATE TRIGGER expenses_ledger_total_scan_guard_insert BEFORE INSERT ON expenses
WHEN NEW.deleted_at IS NULL
  AND NOT EXISTS(SELECT 1 FROM ledger_summary_state state WHERE state.group_id=NEW.group_id AND state.status='ready' AND state.discovery_complete=1 AND state.maintenance_due=0)
  AND COALESCE((SELECT SUM(amount_minor) FROM expenses WHERE group_id=NEW.group_id AND currency=NEW.currency AND deleted_at IS NULL),0)
    + COALESCE((SELECT SUM(amount_minor*2) FROM settlements WHERE group_id=NEW.group_id AND currency=NEW.currency AND deleted_at IS NULL),0)
    + COALESCE((SELECT SUM(a.amount_minor) FROM credit_allocations a JOIN credits c ON c.id=a.credit_id WHERE c.group_id=NEW.group_id AND c.currency=NEW.currency AND c.deleted_at IS NULL),0)
      > 9007199254740991-NEW.amount_minor
BEGIN SELECT RAISE(ABORT,'BALANCE_OVERFLOW'); END;

CREATE TRIGGER expenses_ledger_total_guard_update BEFORE UPDATE OF group_id,currency,amount_minor,deleted_at ON expenses
WHEN NEW.deleted_at IS NULL
  AND EXISTS(SELECT 1 FROM ledger_summary_state state WHERE state.group_id=NEW.group_id AND state.status='ready' AND state.discovery_complete=1 AND state.maintenance_due=0)
  AND (COALESCE((SELECT SUM(amount_minor) FROM expenses WHERE group_id=NEW.group_id AND currency=NEW.currency AND deleted_at IS NULL AND id<>OLD.id),0)
    + COALESCE((SELECT SUM(amount_minor*2) FROM settlements WHERE group_id=NEW.group_id AND currency=NEW.currency AND deleted_at IS NULL),0)
    + COALESCE((SELECT SUM(a.amount_minor) FROM credit_allocations a JOIN credits c ON c.id=a.credit_id WHERE c.group_id=NEW.group_id AND c.currency=NEW.currency AND c.deleted_at IS NULL),0)
      > 9007199254740991-NEW.amount_minor
  OR COALESCE((SELECT gross_minor FROM ledger_totals WHERE group_id=NEW.group_id AND currency=NEW.currency),0)
    - CASE WHEN OLD.deleted_at IS NULL AND OLD.group_id=NEW.group_id AND OLD.currency=NEW.currency THEN OLD.amount_minor ELSE 0 END
    + COALESCE((SELECT SUM(a.amount_minor) FROM credit_allocations a JOIN credits c ON c.id=a.credit_id WHERE c.group_id=NEW.group_id AND c.currency=NEW.currency AND c.deleted_at IS NULL),0)
      > 9007199254740991-NEW.amount_minor)
BEGIN SELECT RAISE(ABORT,'BALANCE_OVERFLOW'); END;

CREATE TRIGGER expenses_ledger_total_scan_guard_update BEFORE UPDATE OF group_id,currency,amount_minor,deleted_at ON expenses
WHEN NEW.deleted_at IS NULL
  AND NOT EXISTS(SELECT 1 FROM ledger_summary_state state WHERE state.group_id=NEW.group_id AND state.status='ready' AND state.discovery_complete=1 AND state.maintenance_due=0)
  AND COALESCE((SELECT SUM(amount_minor) FROM expenses WHERE group_id=NEW.group_id AND currency=NEW.currency AND deleted_at IS NULL AND id<>OLD.id),0)
    + COALESCE((SELECT SUM(amount_minor*2) FROM settlements WHERE group_id=NEW.group_id AND currency=NEW.currency AND deleted_at IS NULL),0)
    + COALESCE((SELECT SUM(a.amount_minor) FROM credit_allocations a JOIN credits c ON c.id=a.credit_id WHERE c.group_id=NEW.group_id AND c.currency=NEW.currency AND c.deleted_at IS NULL),0)
      > 9007199254740991-NEW.amount_minor
BEGIN SELECT RAISE(ABORT,'BALANCE_OVERFLOW'); END;

CREATE TRIGGER settlements_ledger_total_guard_insert BEFORE INSERT ON settlements
WHEN NEW.deleted_at IS NULL
  AND EXISTS(SELECT 1 FROM ledger_summary_state state WHERE state.group_id=NEW.group_id AND state.status='ready' AND state.discovery_complete=1 AND state.maintenance_due=0)
  AND (COALESCE((SELECT SUM(amount_minor) FROM expenses WHERE group_id=NEW.group_id AND currency=NEW.currency AND deleted_at IS NULL),0)
    + COALESCE((SELECT SUM(amount_minor*2) FROM settlements WHERE group_id=NEW.group_id AND currency=NEW.currency AND deleted_at IS NULL),0)
    + COALESCE((SELECT SUM(a.amount_minor) FROM credit_allocations a JOIN credits c ON c.id=a.credit_id WHERE c.group_id=NEW.group_id AND c.currency=NEW.currency AND c.deleted_at IS NULL),0)
      > 9007199254740991-NEW.amount_minor*2
  OR COALESCE((SELECT gross_minor FROM ledger_totals WHERE group_id=NEW.group_id AND currency=NEW.currency),0)
    + COALESCE((SELECT SUM(a.amount_minor) FROM credit_allocations a JOIN credits c ON c.id=a.credit_id WHERE c.group_id=NEW.group_id AND c.currency=NEW.currency AND c.deleted_at IS NULL),0)
      > 9007199254740991-NEW.amount_minor)
BEGIN SELECT RAISE(ABORT,'BALANCE_OVERFLOW'); END;

CREATE TRIGGER settlements_ledger_total_scan_guard_insert BEFORE INSERT ON settlements
WHEN NEW.deleted_at IS NULL
  AND NOT EXISTS(SELECT 1 FROM ledger_summary_state state WHERE state.group_id=NEW.group_id AND state.status='ready' AND state.discovery_complete=1 AND state.maintenance_due=0)
  AND COALESCE((SELECT SUM(amount_minor) FROM expenses WHERE group_id=NEW.group_id AND currency=NEW.currency AND deleted_at IS NULL),0)
    + COALESCE((SELECT SUM(amount_minor*2) FROM settlements WHERE group_id=NEW.group_id AND currency=NEW.currency AND deleted_at IS NULL),0)
    + COALESCE((SELECT SUM(a.amount_minor) FROM credit_allocations a JOIN credits c ON c.id=a.credit_id WHERE c.group_id=NEW.group_id AND c.currency=NEW.currency AND c.deleted_at IS NULL),0)
      > 9007199254740991-NEW.amount_minor*2
BEGIN SELECT RAISE(ABORT,'BALANCE_OVERFLOW'); END;

CREATE TRIGGER settlements_ledger_total_guard_update BEFORE UPDATE OF group_id,currency,amount_minor,deleted_at ON settlements
WHEN NEW.deleted_at IS NULL
  AND EXISTS(SELECT 1 FROM ledger_summary_state state WHERE state.group_id=NEW.group_id AND state.status='ready' AND state.discovery_complete=1 AND state.maintenance_due=0)
  AND (COALESCE((SELECT SUM(amount_minor) FROM expenses WHERE group_id=NEW.group_id AND currency=NEW.currency AND deleted_at IS NULL),0)
    + COALESCE((SELECT SUM(amount_minor*2) FROM settlements WHERE group_id=NEW.group_id AND currency=NEW.currency AND deleted_at IS NULL AND id<>OLD.id),0)
    + COALESCE((SELECT SUM(a.amount_minor) FROM credit_allocations a JOIN credits c ON c.id=a.credit_id WHERE c.group_id=NEW.group_id AND c.currency=NEW.currency AND c.deleted_at IS NULL),0)
      > 9007199254740991-NEW.amount_minor*2
  OR COALESCE((SELECT gross_minor FROM ledger_totals WHERE group_id=NEW.group_id AND currency=NEW.currency),0)
    - CASE WHEN OLD.deleted_at IS NULL AND OLD.group_id=NEW.group_id AND OLD.currency=NEW.currency THEN OLD.amount_minor ELSE 0 END
    + COALESCE((SELECT SUM(a.amount_minor) FROM credit_allocations a JOIN credits c ON c.id=a.credit_id WHERE c.group_id=NEW.group_id AND c.currency=NEW.currency AND c.deleted_at IS NULL),0)
      > 9007199254740991-NEW.amount_minor)
BEGIN SELECT RAISE(ABORT,'BALANCE_OVERFLOW'); END;

CREATE TRIGGER settlements_ledger_total_scan_guard_update BEFORE UPDATE OF group_id,currency,amount_minor,deleted_at ON settlements
WHEN NEW.deleted_at IS NULL
  AND NOT EXISTS(SELECT 1 FROM ledger_summary_state state WHERE state.group_id=NEW.group_id AND state.status='ready' AND state.discovery_complete=1 AND state.maintenance_due=0)
  AND COALESCE((SELECT SUM(amount_minor*2) FROM settlements WHERE group_id=NEW.group_id AND currency=NEW.currency AND deleted_at IS NULL AND id<>OLD.id),0)
    + COALESCE((SELECT SUM(amount_minor) FROM expenses WHERE group_id=NEW.group_id AND currency=NEW.currency AND deleted_at IS NULL),0)
    + COALESCE((SELECT SUM(a.amount_minor) FROM credit_allocations a JOIN credits c ON c.id=a.credit_id WHERE c.group_id=NEW.group_id AND c.currency=NEW.currency AND c.deleted_at IS NULL),0)
      > 9007199254740991-NEW.amount_minor*2
BEGIN SELECT RAISE(ABORT,'BALANCE_OVERFLOW'); END;
