-- Authoritative revision, independent of disposable projection generations.
-- Multiple row writes may advance it more than once; it is not an event count.
ALTER TABLE groups ADD COLUMN ledger_revision INTEGER NOT NULL DEFAULT 0 CHECK(ledger_revision>=0 AND ledger_revision<=9007199254740991);
CREATE TRIGGER ledger_revision_monotonic BEFORE UPDATE OF ledger_revision ON groups WHEN NEW.ledger_revision<OLD.ledger_revision
BEGIN SELECT RAISE(ABORT,'LEDGER_REVISION_REGRESSION'); END;
CREATE TRIGGER ledger_revision_expense_metadata AFTER UPDATE OF created_by,created_at,updated_at,client_operation_id ON expenses
WHEN NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at OR NEW.updated_at IS NOT OLD.updated_at OR NEW.client_operation_id IS NOT OLD.client_operation_id
BEGIN UPDATE groups SET ledger_revision=ledger_revision+1 WHERE id IN (OLD.group_id,NEW.group_id); END;
CREATE TRIGGER ledger_revision_settlement_metadata AFTER UPDATE OF created_by,created_at,updated_at,client_operation_id ON settlements
WHEN NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at OR NEW.updated_at IS NOT OLD.updated_at OR NEW.client_operation_id IS NOT OLD.client_operation_id
BEGIN UPDATE groups SET ledger_revision=ledger_revision+1 WHERE id IN (OLD.group_id,NEW.group_id); END;
CREATE TRIGGER ledger_revision_credit_metadata AFTER UPDATE OF created_by,created_at,updated_at,client_operation_id ON credits
WHEN NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at OR NEW.updated_at IS NOT OLD.updated_at OR NEW.client_operation_id IS NOT OLD.client_operation_id
BEGIN UPDATE groups SET ledger_revision=ledger_revision+1 WHERE id IN (OLD.group_id,NEW.group_id); END;
CREATE TRIGGER ledger_revision_split_metadata AFTER UPDATE OF metadata_json ON splits WHEN NEW.metadata_json IS NOT OLD.metadata_json
BEGIN UPDATE groups SET ledger_revision=ledger_revision+1 WHERE id IN (SELECT group_id FROM expenses WHERE id IN (OLD.expense_id,NEW.expense_id)); END;
-- 0024 child update triggers queue the new parent only. A move must also
-- invalidate the old parent's period, even when the destination is marked.
CREATE TRIGGER ledger_summary_payer_move_dirty AFTER UPDATE OF expense_id ON payers
WHEN NEW.expense_id IS NOT OLD.expense_id BEGIN
 INSERT INTO ledger_period_state(group_id,month,status,source_generation,updated_at) SELECT group_id,substr(expense_date,1,7)||'-01','dirty',1,CURRENT_TIMESTAMP FROM expenses WHERE id=OLD.expense_id AND projection_mutation_id IS NULL
 ON CONFLICT(group_id,month) DO UPDATE SET status='dirty',source_generation=source_generation+1,updated_at=CURRENT_TIMESTAMP;
 UPDATE ledger_summary_state SET status='dirty',maintenance_due=1,available_at_ms=0 WHERE group_id IN (SELECT group_id FROM expenses WHERE id=OLD.expense_id AND projection_mutation_id IS NULL);
END;
CREATE TRIGGER ledger_summary_split_move_dirty AFTER UPDATE OF expense_id ON splits
WHEN NEW.expense_id IS NOT OLD.expense_id BEGIN
 INSERT INTO ledger_period_state(group_id,month,status,source_generation,updated_at) SELECT group_id,substr(expense_date,1,7)||'-01','dirty',1,CURRENT_TIMESTAMP FROM expenses WHERE id=OLD.expense_id AND projection_mutation_id IS NULL
 ON CONFLICT(group_id,month) DO UPDATE SET status='dirty',source_generation=source_generation+1,updated_at=CURRENT_TIMESTAMP;
 UPDATE ledger_summary_state SET status='dirty',maintenance_due=1,available_at_ms=0 WHERE group_id IN (SELECT group_id FROM expenses WHERE id=OLD.expense_id AND projection_mutation_id IS NULL);
END;
CREATE TRIGGER ledger_revision_groups AFTER UPDATE OF name,currency,kind,deleted_at ON groups
WHEN NEW.name IS NOT OLD.name OR NEW.currency IS NOT OLD.currency OR NEW.kind IS NOT OLD.kind OR NEW.deleted_at IS NOT OLD.deleted_at
BEGIN UPDATE groups SET ledger_revision=ledger_revision+1 WHERE id=NEW.id; END;
CREATE TRIGGER ledger_revision_expenses_insert AFTER INSERT ON expenses BEGIN
 UPDATE groups SET ledger_revision=ledger_revision+1 WHERE id=NEW.group_id;
END;
CREATE TRIGGER ledger_revision_expenses_delete AFTER DELETE ON expenses BEGIN
 UPDATE groups SET ledger_revision=ledger_revision+1 WHERE id=OLD.group_id;
END;
CREATE TRIGGER ledger_revision_expenses_update AFTER UPDATE ON expenses
WHEN NEW.group_id IS NOT OLD.group_id OR NEW.currency IS NOT OLD.currency OR NEW.amount_minor IS NOT OLD.amount_minor OR NEW.deleted_at IS NOT OLD.deleted_at OR NEW.expense_date IS NOT OLD.expense_date OR NEW.version IS NOT OLD.version OR NEW.description IS NOT OLD.description OR NEW.notes IS NOT OLD.notes OR NEW.category IS NOT OLD.category
BEGIN UPDATE groups SET ledger_revision=ledger_revision+1 WHERE id IN (OLD.group_id,NEW.group_id); END;
CREATE TRIGGER ledger_revision_settlements_insert AFTER INSERT ON settlements BEGIN
 UPDATE groups SET ledger_revision=ledger_revision+1 WHERE id=NEW.group_id;
END;
CREATE TRIGGER ledger_revision_settlements_delete AFTER DELETE ON settlements BEGIN
 UPDATE groups SET ledger_revision=ledger_revision+1 WHERE id=OLD.group_id;
END;
CREATE TRIGGER ledger_revision_settlements_update AFTER UPDATE ON settlements
WHEN NEW.group_id IS NOT OLD.group_id OR NEW.currency IS NOT OLD.currency OR NEW.amount_minor IS NOT OLD.amount_minor OR NEW.deleted_at IS NOT OLD.deleted_at OR NEW.settlement_date IS NOT OLD.settlement_date OR NEW.version IS NOT OLD.version OR NEW.from_person_id IS NOT OLD.from_person_id OR NEW.to_person_id IS NOT OLD.to_person_id OR NEW.note IS NOT OLD.note
BEGIN UPDATE groups SET ledger_revision=ledger_revision+1 WHERE id IN (OLD.group_id,NEW.group_id); END;
CREATE TRIGGER ledger_revision_credits_insert AFTER INSERT ON credits BEGIN
 UPDATE groups SET ledger_revision=ledger_revision+1 WHERE id=NEW.group_id;
END;
CREATE TRIGGER ledger_revision_credits_delete AFTER DELETE ON credits BEGIN
 UPDATE groups SET ledger_revision=ledger_revision+1 WHERE id=OLD.group_id;
END;
CREATE TRIGGER ledger_revision_credits_update AFTER UPDATE ON credits
WHEN NEW.group_id IS NOT OLD.group_id OR NEW.currency IS NOT OLD.currency OR NEW.amount_minor IS NOT OLD.amount_minor OR NEW.deleted_at IS NOT OLD.deleted_at OR NEW.credit_date IS NOT OLD.credit_date OR NEW.version IS NOT OLD.version OR NEW.subtype IS NOT OLD.subtype OR NEW.delivery_mode IS NOT OLD.delivery_mode OR NEW.note IS NOT OLD.note
BEGIN UPDATE groups SET ledger_revision=ledger_revision+1 WHERE id IN (OLD.group_id,NEW.group_id); END;
CREATE TRIGGER ledger_revision_payers_insert AFTER INSERT ON payers BEGIN
 UPDATE groups SET ledger_revision=ledger_revision+1 WHERE id=(SELECT group_id FROM expenses WHERE id=NEW.expense_id);
END;
CREATE TRIGGER ledger_revision_payers_delete AFTER DELETE ON payers BEGIN
 UPDATE groups SET ledger_revision=ledger_revision+1 WHERE id=(SELECT group_id FROM expenses WHERE id=OLD.expense_id);
END;
CREATE TRIGGER ledger_revision_payers_update AFTER UPDATE ON payers
WHEN NEW.expense_id IS NOT OLD.expense_id OR NEW.person_id IS NOT OLD.person_id OR NEW.amount_minor IS NOT OLD.amount_minor
BEGIN UPDATE groups SET ledger_revision=ledger_revision+1 WHERE id IN (SELECT group_id FROM expenses WHERE id IN (OLD.expense_id,NEW.expense_id)); END;
CREATE TRIGGER ledger_revision_splits_insert AFTER INSERT ON splits BEGIN
 UPDATE groups SET ledger_revision=ledger_revision+1 WHERE id=(SELECT group_id FROM expenses WHERE id=NEW.expense_id);
END;
CREATE TRIGGER ledger_revision_splits_delete AFTER DELETE ON splits BEGIN
 UPDATE groups SET ledger_revision=ledger_revision+1 WHERE id=(SELECT group_id FROM expenses WHERE id=OLD.expense_id);
END;
CREATE TRIGGER ledger_revision_splits_update AFTER UPDATE ON splits
WHEN NEW.expense_id IS NOT OLD.expense_id OR NEW.person_id IS NOT OLD.person_id OR NEW.amount_minor IS NOT OLD.amount_minor
BEGIN UPDATE groups SET ledger_revision=ledger_revision+1 WHERE id IN (SELECT group_id FROM expenses WHERE id IN (OLD.expense_id,NEW.expense_id)); END;
CREATE TRIGGER ledger_revision_allocations_insert AFTER INSERT ON credit_allocations BEGIN
 UPDATE groups SET ledger_revision=ledger_revision+1 WHERE id=(SELECT group_id FROM credits WHERE id=NEW.credit_id);
END;
CREATE TRIGGER ledger_revision_allocations_delete AFTER DELETE ON credit_allocations BEGIN
 UPDATE groups SET ledger_revision=ledger_revision+1 WHERE id=(SELECT group_id FROM credits WHERE id=OLD.credit_id);
END;
CREATE TRIGGER ledger_revision_allocations_update AFTER UPDATE ON credit_allocations
WHEN NEW.credit_id IS NOT OLD.credit_id OR NEW.person_id IS NOT OLD.person_id OR NEW.amount_minor IS NOT OLD.amount_minor OR NEW.allocation_type IS NOT OLD.allocation_type
BEGIN UPDATE groups SET ledger_revision=ledger_revision+1 WHERE id IN (SELECT group_id FROM credits WHERE id IN (OLD.credit_id,NEW.credit_id)); END;
CREATE TRIGGER ledger_revision_members_insert AFTER INSERT ON group_members BEGIN
 UPDATE groups SET ledger_revision=ledger_revision+1 WHERE id=NEW.group_id;
END;
CREATE TRIGGER ledger_revision_members_delete AFTER DELETE ON group_members BEGIN
 UPDATE groups SET ledger_revision=ledger_revision+1 WHERE id=OLD.group_id;
END;
CREATE TRIGGER ledger_revision_members_update AFTER UPDATE ON group_members
WHEN NEW.group_id IS NOT OLD.group_id OR NEW.person_id IS NOT OLD.person_id OR NEW.user_id IS NOT OLD.user_id OR NEW.role IS NOT OLD.role OR NEW.deleted_at IS NOT OLD.deleted_at OR NEW.joined_at IS NOT OLD.joined_at
BEGIN UPDATE groups SET ledger_revision=ledger_revision+1 WHERE id IN (OLD.group_id,NEW.group_id); END;

-- Legacy credits have no delta maintenance. Queue both affected periods and
-- invalidate readiness in the same transaction as the authoritative write.
CREATE TRIGGER ledger_summary_credit_insert_dirty AFTER INSERT ON credits WHEN NEW.projection_mutation_id IS NULL BEGIN
 INSERT INTO ledger_period_state(group_id,month,status,source_generation,updated_at) VALUES(NEW.group_id,substr(NEW.credit_date,1,7)||'-01','dirty',1,CURRENT_TIMESTAMP)
 ON CONFLICT(group_id,month) DO UPDATE SET status='dirty',source_generation=source_generation+1,updated_at=CURRENT_TIMESTAMP;
 UPDATE ledger_summary_state SET status='dirty',maintenance_due=1,available_at_ms=0 WHERE group_id=NEW.group_id;
 UPDATE projection_state SET status='stale' WHERE group_id=NEW.group_id;
END;
CREATE TRIGGER ledger_summary_credit_update_dirty AFTER UPDATE ON credits
WHEN NEW.projection_mutation_id IS OLD.projection_mutation_id AND (NEW.group_id IS NOT OLD.group_id OR NEW.currency IS NOT OLD.currency OR NEW.amount_minor IS NOT OLD.amount_minor OR NEW.deleted_at IS NOT OLD.deleted_at OR NEW.credit_date IS NOT OLD.credit_date OR NEW.version IS NOT OLD.version OR NEW.delivery_mode IS NOT OLD.delivery_mode) BEGIN
 INSERT INTO ledger_period_state(group_id,month,status,source_generation,updated_at) VALUES(OLD.group_id,substr(OLD.credit_date,1,7)||'-01','dirty',1,CURRENT_TIMESTAMP)
 ON CONFLICT(group_id,month) DO UPDATE SET status='dirty',source_generation=source_generation+1,updated_at=CURRENT_TIMESTAMP;
 INSERT INTO ledger_period_state(group_id,month,status,source_generation,updated_at) VALUES(NEW.group_id,substr(NEW.credit_date,1,7)||'-01','dirty',1,CURRENT_TIMESTAMP)
 ON CONFLICT(group_id,month) DO UPDATE SET status='dirty',source_generation=source_generation+1,updated_at=CURRENT_TIMESTAMP;
 UPDATE ledger_summary_state SET status='dirty',maintenance_due=1,available_at_ms=0 WHERE group_id IN (OLD.group_id,NEW.group_id);
 UPDATE projection_state SET status='stale' WHERE group_id IN (OLD.group_id,NEW.group_id);
END;
CREATE TRIGGER ledger_summary_credit_delete_dirty AFTER DELETE ON credits BEGIN
 INSERT INTO ledger_period_state(group_id,month,status,source_generation,updated_at) VALUES(OLD.group_id,substr(OLD.credit_date,1,7)||'-01','dirty',1,CURRENT_TIMESTAMP)
 ON CONFLICT(group_id,month) DO UPDATE SET status='dirty',source_generation=source_generation+1,updated_at=CURRENT_TIMESTAMP;
 UPDATE ledger_summary_state SET status='dirty',maintenance_due=1,available_at_ms=0 WHERE group_id=OLD.group_id;
 UPDATE projection_state SET status='stale' WHERE group_id=OLD.group_id;
END;
CREATE TRIGGER ledger_summary_allocation_insert_dirty AFTER INSERT ON credit_allocations BEGIN
 INSERT INTO ledger_period_state(group_id,month,status,source_generation,updated_at) SELECT group_id,substr(credit_date,1,7)||'-01','dirty',1,CURRENT_TIMESTAMP FROM credits WHERE id=NEW.credit_id AND projection_mutation_id IS NULL
 ON CONFLICT(group_id,month) DO UPDATE SET status='dirty',source_generation=source_generation+1,updated_at=CURRENT_TIMESTAMP;
 UPDATE ledger_summary_state SET status='dirty',maintenance_due=1,available_at_ms=0 WHERE group_id IN (SELECT group_id FROM credits WHERE id=NEW.credit_id AND projection_mutation_id IS NULL);
 UPDATE projection_state SET status='stale' WHERE group_id IN (SELECT group_id FROM credits WHERE id=NEW.credit_id AND projection_mutation_id IS NULL);
END;
CREATE TRIGGER ledger_summary_allocation_delete_dirty AFTER DELETE ON credit_allocations BEGIN
 INSERT INTO ledger_period_state(group_id,month,status,source_generation,updated_at) SELECT group_id,substr(credit_date,1,7)||'-01','dirty',1,CURRENT_TIMESTAMP FROM credits WHERE id=OLD.credit_id AND projection_mutation_id IS NULL
 ON CONFLICT(group_id,month) DO UPDATE SET status='dirty',source_generation=source_generation+1,updated_at=CURRENT_TIMESTAMP;
 UPDATE ledger_summary_state SET status='dirty',maintenance_due=1,available_at_ms=0 WHERE group_id IN (SELECT group_id FROM credits WHERE id=OLD.credit_id AND projection_mutation_id IS NULL);
 UPDATE projection_state SET status='stale' WHERE group_id IN (SELECT group_id FROM credits WHERE id=OLD.credit_id AND projection_mutation_id IS NULL);
END;
CREATE TRIGGER ledger_summary_allocation_update_dirty AFTER UPDATE ON credit_allocations
WHEN NEW.credit_id IS NOT OLD.credit_id OR NEW.person_id IS NOT OLD.person_id OR NEW.amount_minor IS NOT OLD.amount_minor OR NEW.allocation_type IS NOT OLD.allocation_type BEGIN
 INSERT INTO ledger_period_state(group_id,month,status,source_generation,updated_at) SELECT group_id,substr(credit_date,1,7)||'-01','dirty',1,CURRENT_TIMESTAMP FROM credits WHERE id IN (OLD.credit_id,NEW.credit_id) AND projection_mutation_id IS NULL
 ON CONFLICT(group_id,month) DO UPDATE SET status='dirty',source_generation=source_generation+1,updated_at=CURRENT_TIMESTAMP;
 UPDATE ledger_summary_state SET status='dirty',maintenance_due=1,available_at_ms=0 WHERE group_id IN (SELECT group_id FROM credits WHERE id IN (OLD.credit_id,NEW.credit_id) AND projection_mutation_id IS NULL);
 UPDATE projection_state SET status='stale' WHERE group_id IN (SELECT group_id FROM credits WHERE id IN (OLD.credit_id,NEW.credit_id) AND projection_mutation_id IS NULL);
END;
