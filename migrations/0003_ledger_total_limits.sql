-- Keep the gross active ledger total conservatively representable in JavaScript.
-- This is deliberately stricter than netting: active expenses and settlements
-- are both counted, per group and currency, so concurrent writes cannot make a
-- later balance calculation exceed Number.MAX_SAFE_INTEGER.
--
-- The trigger message is part of the application error contract. Repository
-- mutation paths translate it to BALANCE_OVERFLOW/HTTP 422.

CREATE INDEX idx_expenses_active_ledger ON expenses(group_id, currency) WHERE deleted_at IS NULL;
CREATE INDEX idx_settlements_active_ledger ON settlements(group_id, currency) WHERE deleted_at IS NULL;

CREATE TRIGGER expenses_ledger_total_limit_insert
BEFORE INSERT ON expenses
WHEN NEW.deleted_at IS NULL
  AND COALESCE((SELECT SUM(amount_minor) FROM expenses WHERE group_id = NEW.group_id AND currency = NEW.currency AND deleted_at IS NULL), 0)
    + COALESCE((SELECT SUM(amount_minor) FROM settlements WHERE group_id = NEW.group_id AND currency = NEW.currency AND deleted_at IS NULL), 0)
    > 9007199254740991 - NEW.amount_minor
BEGIN
  SELECT RAISE(ABORT, 'BALANCE_OVERFLOW');
END;

CREATE TRIGGER expenses_ledger_total_limit_update
BEFORE UPDATE OF group_id, currency, amount_minor, deleted_at ON expenses
WHEN NEW.deleted_at IS NULL
  AND COALESCE((SELECT SUM(amount_minor) FROM expenses WHERE group_id = NEW.group_id AND currency = NEW.currency AND deleted_at IS NULL AND id <> OLD.id), 0)
    + COALESCE((SELECT SUM(amount_minor) FROM settlements WHERE group_id = NEW.group_id AND currency = NEW.currency AND deleted_at IS NULL), 0)
    > 9007199254740991 - NEW.amount_minor
BEGIN
  SELECT RAISE(ABORT, 'BALANCE_OVERFLOW');
END;

CREATE TRIGGER settlements_ledger_total_limit_insert
BEFORE INSERT ON settlements
WHEN NEW.deleted_at IS NULL
  AND COALESCE((SELECT SUM(amount_minor) FROM expenses WHERE group_id = NEW.group_id AND currency = NEW.currency AND deleted_at IS NULL), 0)
    + COALESCE((SELECT SUM(amount_minor) FROM settlements WHERE group_id = NEW.group_id AND currency = NEW.currency AND deleted_at IS NULL), 0)
    > 9007199254740991 - NEW.amount_minor
BEGIN
  SELECT RAISE(ABORT, 'BALANCE_OVERFLOW');
END;

CREATE TRIGGER settlements_ledger_total_limit_update
BEFORE UPDATE OF group_id, currency, amount_minor, deleted_at ON settlements
WHEN NEW.deleted_at IS NULL
  AND COALESCE((SELECT SUM(amount_minor) FROM expenses WHERE group_id = NEW.group_id AND currency = NEW.currency AND deleted_at IS NULL), 0)
    + COALESCE((SELECT SUM(amount_minor) FROM settlements WHERE group_id = NEW.group_id AND currency = NEW.currency AND deleted_at IS NULL AND id <> OLD.id), 0)
    > 9007199254740991 - NEW.amount_minor
BEGIN
  SELECT RAISE(ABORT, 'BALANCE_OVERFLOW');
END;
