-- Credit allocations are signed balance contributions. Keep a conservative
-- absolute group/currency ledger bound so no combination of payer, split,
-- settlement, or credit rows can overflow SQLite's safe JavaScript integer
-- boundary. This is deliberately stricter than a net-balance check.
DROP TRIGGER IF EXISTS credit_allocation_safe_guard_insert;
CREATE TRIGGER credit_allocation_safe_guard_insert BEFORE INSERT ON credit_allocations
WHEN EXISTS (
  SELECT 1 FROM (
    SELECT e.group_id,e.currency,
      COALESCE((SELECT SUM(p.amount_minor) FROM payers p WHERE p.expense_id=e.id),0)+
      COALESCE((SELECT SUM(s.amount_minor) FROM splits s WHERE s.expense_id=e.id),0) AS amount_minor
      FROM expenses e WHERE e.deleted_at IS NULL
    UNION ALL
    SELECT s.group_id,s.currency,s.amount_minor*2 FROM settlements s WHERE s.deleted_at IS NULL
    UNION ALL
    SELECT c.group_id,c.currency,a.amount_minor
      FROM credits c JOIN credit_allocations a ON a.credit_id=c.id
      WHERE c.deleted_at IS NULL
    UNION ALL
    SELECT c.group_id,c.currency,NEW.amount_minor
      FROM credits c WHERE c.id=NEW.credit_id AND c.deleted_at IS NULL
  ) ledger
  GROUP BY group_id,currency
  HAVING SUM(amount_minor)>9007199254740991
)
BEGIN SELECT RAISE(ABORT,'BALANCE_OVERFLOW'); END;

-- Applications do not contribute a second signed balance, but changing one can
-- move a credit between expenses while a concurrent projection is being
-- rebuilt. Refuse the application mutation if the authoritative group ledger
-- is already outside the conservative bound.
DROP TRIGGER IF EXISTS credit_application_safe_guard_insert;
CREATE TRIGGER credit_application_safe_guard_insert BEFORE INSERT ON credit_applications
WHEN EXISTS (
  SELECT 1 FROM (
    SELECT e.group_id,e.currency,COALESCE((SELECT SUM(p.amount_minor) FROM payers p WHERE p.expense_id=e.id),0)+COALESCE((SELECT SUM(s.amount_minor) FROM splits s WHERE s.expense_id=e.id),0) AS amount_minor FROM expenses e WHERE e.deleted_at IS NULL
    UNION ALL SELECT s.group_id,s.currency,s.amount_minor*2 FROM settlements s WHERE s.deleted_at IS NULL
    UNION ALL SELECT c.group_id,c.currency,a.amount_minor FROM credits c JOIN credit_allocations a ON a.credit_id=c.id WHERE c.deleted_at IS NULL
  ) ledger
  GROUP BY group_id,currency HAVING SUM(amount_minor)>9007199254740991
)
BEGIN SELECT RAISE(ABORT,'BALANCE_OVERFLOW'); END;

DROP TRIGGER IF EXISTS credit_application_safe_guard_update;
CREATE TRIGGER credit_application_safe_guard_update BEFORE UPDATE OF credit_id,expense_id,amount_minor ON credit_applications
WHEN EXISTS (
  SELECT 1 FROM (
    SELECT e.group_id,e.currency,COALESCE((SELECT SUM(p.amount_minor) FROM payers p WHERE p.expense_id=e.id),0)+COALESCE((SELECT SUM(s.amount_minor) FROM splits s WHERE s.expense_id=e.id),0) AS amount_minor FROM expenses e WHERE e.deleted_at IS NULL
    UNION ALL SELECT s.group_id,s.currency,s.amount_minor*2 FROM settlements s WHERE s.deleted_at IS NULL
    UNION ALL SELECT c.group_id,c.currency,a.amount_minor FROM credits c JOIN credit_allocations a ON a.credit_id=c.id WHERE c.deleted_at IS NULL
  ) ledger
  GROUP BY group_id,currency HAVING SUM(amount_minor)>9007199254740991
)
BEGIN SELECT RAISE(ABORT,'BALANCE_OVERFLOW'); END;

DROP TRIGGER IF EXISTS credit_allocation_safe_guard_update;
CREATE TRIGGER credit_allocation_safe_guard_update BEFORE UPDATE OF credit_id,person_id,allocation_type,amount_minor ON credit_allocations
WHEN EXISTS (
  SELECT 1 FROM (
    SELECT e.group_id,e.currency,COALESCE((SELECT SUM(p.amount_minor) FROM payers p WHERE p.expense_id=e.id),0)+COALESCE((SELECT SUM(s.amount_minor) FROM splits s WHERE s.expense_id=e.id),0) AS amount_minor
      FROM expenses e WHERE e.deleted_at IS NULL
    UNION ALL
    SELECT s.group_id,s.currency,s.amount_minor*2 FROM settlements s WHERE s.deleted_at IS NULL
    UNION ALL
    SELECT c.group_id,c.currency,a.amount_minor
      FROM credits c JOIN credit_allocations a ON a.credit_id=c.id
      WHERE c.deleted_at IS NULL AND NOT (a.credit_id=OLD.credit_id AND a.person_id=OLD.person_id AND a.allocation_type=OLD.allocation_type)
    UNION ALL
    SELECT c.group_id,c.currency,NEW.amount_minor
      FROM credits c WHERE c.id=NEW.credit_id AND c.deleted_at IS NULL
  ) ledger
  GROUP BY group_id,currency
  HAVING SUM(amount_minor)>9007199254740991
)
BEGIN SELECT RAISE(ABORT,'BALANCE_OVERFLOW'); END;

DROP TRIGGER IF EXISTS credit_recipient_payer_guard_insert;
CREATE TRIGGER credit_recipient_payer_guard_insert BEFORE INSERT ON credit_allocations
WHEN NEW.allocation_type='recipient' AND EXISTS (SELECT 1 FROM credits c WHERE c.id=NEW.credit_id AND c.delivery_mode='direct_provider_offset')
  AND NOT EXISTS (
    SELECT 1 FROM credit_applications a JOIN payers p ON p.expense_id=a.expense_id
    WHERE a.credit_id=NEW.credit_id AND p.person_id=NEW.person_id
  )
BEGIN SELECT RAISE(ABORT,'CREDIT_RECIPIENT_INVALID'); END;

DROP TRIGGER IF EXISTS credit_recipient_payer_guard_update;
CREATE TRIGGER credit_recipient_payer_guard_update BEFORE UPDATE OF credit_id,person_id,allocation_type ON credit_allocations
WHEN NEW.allocation_type='recipient' AND EXISTS (SELECT 1 FROM credits c WHERE c.id=NEW.credit_id AND c.delivery_mode='direct_provider_offset')
  AND NOT EXISTS (
    SELECT 1 FROM credit_applications a JOIN payers p ON p.expense_id=a.expense_id
    WHERE a.credit_id=NEW.credit_id AND p.person_id=NEW.person_id
  )
BEGIN SELECT RAISE(ABORT,'CREDIT_RECIPIENT_INVALID'); END;

DROP TRIGGER IF EXISTS credit_safe_guard_update;
CREATE TRIGGER credit_safe_guard_update BEFORE UPDATE OF group_id,currency,deleted_at ON credits
WHEN NEW.deleted_at IS NULL AND EXISTS (
  SELECT 1 FROM (
    SELECT e.group_id,e.currency,COALESCE((SELECT SUM(p.amount_minor) FROM payers p WHERE p.expense_id=e.id),0)+COALESCE((SELECT SUM(s.amount_minor) FROM splits s WHERE s.expense_id=e.id),0) AS amount_minor FROM expenses e WHERE e.deleted_at IS NULL
    UNION ALL SELECT s.group_id,s.currency,s.amount_minor*2 FROM settlements s WHERE s.deleted_at IS NULL
    UNION ALL SELECT CASE WHEN c.id=OLD.id THEN NEW.group_id ELSE c.group_id END,CASE WHEN c.id=OLD.id THEN NEW.currency ELSE c.currency END,a.amount_minor
      FROM credits c JOIN credit_allocations a ON a.credit_id=c.id
      WHERE c.deleted_at IS NULL OR (c.id=OLD.id AND NEW.deleted_at IS NULL)
  ) ledger
  GROUP BY group_id,currency
  HAVING SUM(amount_minor)>9007199254740991
)
BEGIN SELECT RAISE(ABORT,'BALANCE_OVERFLOW'); END;
