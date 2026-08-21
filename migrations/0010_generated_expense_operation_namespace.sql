-- Generated expenses are idempotent through scheduled_occurrences. Clear the
-- legacy client operation values so previously generated rows cannot collide
-- with a user-supplied expense operation after generation stops using that
-- namespace.
UPDATE expenses
SET client_operation_id=NULL
WHERE id IN (SELECT expense_id FROM scheduled_occurrences);
