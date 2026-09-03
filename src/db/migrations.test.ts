import { describe, expect, it } from 'vitest';
// The worker tsconfig intentionally does not include Node types; this test
// runs in Vitest's Node environment and reads authored migration SQL.
// @ts-expect-error Node types are not shipped to the Worker build.
import { readFileSync } from 'node:fs';

const moduleUrl = (import.meta as ImportMeta & { url: string }).url;
const friendSql = readFileSync(new URL('../../migrations/0004_friend_idempotency_lookup.sql', moduleUrl), 'utf8');
const clerkSql = readFileSync(new URL('../../migrations/0005_clerk_identity.sql', moduleUrl), 'utf8');
const scheduledSql = readFileSync(new URL('../../migrations/0006_scheduled_expenses.sql', moduleUrl), 'utf8');
const scheduledClaimsSql = readFileSync(new URL('../../migrations/0007_scheduled_generation_claims.sql', moduleUrl), 'utf8');
const scheduledCompletionSql = readFileSync(new URL('../../migrations/0008_scheduled_expense_completion.sql', moduleUrl), 'utf8');
const scheduledCursorSql = readFileSync(new URL('../../migrations/0009_scheduled_generation_cursor.sql', moduleUrl), 'utf8');
const generatedOperationSql = readFileSync(new URL('../../migrations/0010_generated_expense_operation_namespace.sql', moduleUrl), 'utf8');
const scheduledCategorySql = readFileSync(new URL('../../migrations/0011_scheduled_expense_category.sql', moduleUrl), 'utf8');
const invitationsAuditSql = readFileSync(new URL('../../migrations/0012_invitations_audit_purge.sql', moduleUrl), 'utf8');
const projectionSql = readFileSync(new URL('../../migrations/0013_projection_layer.sql', moduleUrl), 'utf8');
const projectionIndexesSql = readFileSync(new URL('../../migrations/0014_projection_indexes.sql', moduleUrl), 'utf8');
const projectionReadinessResetSql = readFileSync(new URL('../../migrations/0016_projection_readiness_reset.sql', moduleUrl), 'utf8');
const auditActorSql = readFileSync(new URL('../../migrations/0015_audit_actor_snapshot.sql', moduleUrl), 'utf8');
const cleanupIndexesSql = readFileSync(new URL('../../migrations/0017_cleanup_indexes.sql', moduleUrl), 'utf8');
const categoryPreferencesSql = readFileSync(new URL('../../migrations/0018_category_preferences.sql', moduleUrl), 'utf8');
const membershipEventsSql = readFileSync(new URL('../../migrations/0019_group_membership_events.sql', moduleUrl), 'utf8');
const accountDeletionSql = readFileSync(new URL('../../migrations/0020_account_deletion.sql', moduleUrl), 'utf8');
const identityTombstonesSql = readFileSync(new URL('../../migrations/0021_deleted_identity_tombstones.sql', moduleUrl), 'utf8');
const applicationSessionsSql = readFileSync(new URL('../../migrations/0022_application_sessions.sql', moduleUrl), 'utf8');
const splitDefaultsSql = readFileSync(new URL('../../migrations/0023_group_split_defaults.sql', moduleUrl), 'utf8');
const incrementalProjectionTotalsSql = readFileSync(new URL('../../migrations/0024_incremental_projection_totals.sql', moduleUrl), 'utf8');
const expenseSuggestionLookupSql = readFileSync(new URL('../../migrations/0025_expense_suggestion_lookup.sql', moduleUrl), 'utf8');
const monthlySummarySql = readFileSync(new URL('./monthly-summary.ts', moduleUrl), 'utf8');
const ledgerProjectionSql = readFileSync(new URL('./ledger-projection.ts', moduleUrl), 'utf8');
const repositorySql = readFileSync(new URL('./repository.ts', moduleUrl), 'utf8');

describe('friend idempotency migration', () => {
  it('enforces one friend claim per user and operation, independent of group', () => {
    expect(friendSql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS[\s\S]*ON idempotency_keys\(user_id, operation_id\)[\s\S]*WHERE kind = 'friend\.create'/i);
    expect(friendSql).not.toMatch(/UNIQUE INDEX[\s\S]*group_id/i);
  });
});

describe('Clerk identity migration', () => {
  it('adds a nullable Clerk mapping with a unique partial index', () => {
    expect(clerkSql).toMatch(/ALTER TABLE users ADD COLUMN clerk_user_id TEXT/i);
    expect(clerkSql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS[\s\S]*ON users\(clerk_user_id\)[\s\S]*WHERE clerk_user_id IS NOT NULL/i);
  });
});

describe('scheduled expense migration', () => {
  it('stores calendar recurrence state and an occurrence uniqueness claim', () => {
    expect(scheduledSql).toMatch(/CREATE TABLE scheduled_expenses/);
    expect(scheduledSql).toMatch(/timezone TEXT NOT NULL/);
    expect(scheduledSql).toMatch(/next_occurrence_date TEXT/);
    expect(scheduledSql).toMatch(/CREATE TABLE scheduled_occurrences/);
    expect(scheduledSql).toMatch(/PRIMARY KEY\(scheduled_expense_id, occurrence_date\)/);
  });
});

describe('scheduled generation claim migration', () => {
  it('adds an indexed claim marker for atomic cursor generation', () => {
    expect(scheduledClaimsSql).toMatch(/ALTER TABLE scheduled_expenses ADD COLUMN generation_claim_id TEXT/i);
    expect(scheduledClaimsSql).toMatch(/idx_scheduled_generation_claim/i);
  });
});

describe('scheduled completion migration', () => {
  it('uses deferred foreign keys while preserving generation claims and completed cursors', () => {
    expect(scheduledCompletionSql).toMatch(/PRAGMA\s+defer_foreign_keys\s*=\s*ON/i);
    expect(scheduledCompletionSql).not.toMatch(/PRAGMA\s+foreign_keys\s*=\s*OFF/i);
    expect(scheduledCompletionSql).toMatch(/status IN \('active','paused','cancelled','blocked','completed'\)/);
    expect(scheduledCompletionSql).toMatch(/generation_claim_id TEXT/);
    expect(scheduledCompletionSql).toMatch(/next_occurrence_date TEXT/);
  });
});

describe('scheduled generation cursor migration', () => {
  it('creates a singleton persistent cursor for bounded Cron rotation', () => {
    expect(scheduledCursorSql).toMatch(/CREATE TABLE scheduled_generation_cursor/);
    expect(scheduledCursorSql).toMatch(/CHECK\(id = 1\)/);
    expect(scheduledCursorSql).toMatch(/INSERT INTO scheduled_generation_cursor/);
  });
});

describe('generated expense operation namespace migration', () => {
  it('removes legacy user-collidable operation values from generated expenses', () => {
    expect(generatedOperationSql).toMatch(/UPDATE expenses[\s\S]*SET client_operation_id=NULL[\s\S]*scheduled_occurrences/i);
  });
});

describe('scheduled category migration', () => {
  it('adds the optional category stored on schedule templates', () => {
    expect(scheduledCategorySql).toMatch(/ALTER TABLE scheduled_expenses ADD COLUMN category TEXT/i);
  });
});

describe('invitation, audit, and purge migration', () => {
  it('adds normalized-email invitations, append-only audit rows, and occurrence tombstones', () => {
    expect(invitationsAuditSql).toMatch(/CREATE TABLE group_invitations/);
    expect(invitationsAuditSql).toMatch(/email_normalized TEXT NOT NULL/);
    expect(invitationsAuditSql).toMatch(/CREATE TABLE audit_events/);
    expect(invitationsAuditSql).toMatch(/before_json TEXT/);
    expect(invitationsAuditSql).toMatch(/after_json TEXT/);
    expect(invitationsAuditSql).toMatch(/expense_id TEXT NOT NULL UNIQUE/);
    expect(invitationsAuditSql).not.toMatch(/expense_id TEXT NOT NULL UNIQUE REFERENCES expenses/);
  });
});

describe('projection migrations', () => {
  it('adds pending projection state for migration-first rollout without removing legacy triggers', () => {
    expect(projectionSql).toMatch(/CREATE TABLE ledger_totals/);
    expect(projectionSql).toMatch(/CREATE TABLE group_balance_projection/);
    expect(projectionSql).toMatch(/CREATE TABLE projection_state/);
    expect(projectionSql).toMatch(/backfill_cursor TEXT/);
    expect(projectionSql).not.toMatch(/INSERT INTO ledger_totals\s*\(/);
    expect(projectionSql).not.toMatch(/INSERT INTO group_balance_projection\s*\(/);
    expect(projectionSql).toMatch(/SELECT id,'pending'/);
    expect(projectionReadinessResetSql).toMatch(/SET status='pending'/);
    expect(projectionIndexesSql).toMatch(/idx_expenses_group_keyset/);
    expect(projectionIndexesSql).toMatch(/idx_settlements_group_keyset/);
    expect(projectionIndexesSql).toMatch(/idx_payers_person_expense/);
    expect(projectionIndexesSql).toMatch(/idx_splits_person_expense/);
  });

  it('adds resumable monthly/checkpoint state and replaces legacy scan guards', () => {
    expect(incrementalProjectionTotalsSql).toMatch(/CREATE TABLE ledger_summary_state/i);
    expect(incrementalProjectionTotalsSql).toMatch(/CREATE TABLE ledger_period_state/i);
    expect(incrementalProjectionTotalsSql).toMatch(/CREATE TABLE ledger_period_balances/i);
    expect(incrementalProjectionTotalsSql).toMatch(/CREATE TABLE ledger_period_totals/i);
    expect(incrementalProjectionTotalsSql).toMatch(/CREATE TABLE ledger_checkpoint_balances/i);
     expect(incrementalProjectionTotalsSql).toMatch(/CREATE TABLE ledger_period_verify_balances/i);
     expect(incrementalProjectionTotalsSql).toMatch(/expense_high_water TEXT/i);
     expect(incrementalProjectionTotalsSql).toMatch(/discovery_complete INTEGER NOT NULL/i);
     expect(incrementalProjectionTotalsSql).toMatch(/expense_discovery_cursor TEXT/i);
     expect(incrementalProjectionTotalsSql).toMatch(/settlement_discovery_high_water TEXT/i);
      expect(incrementalProjectionTotalsSql).toMatch(/lease_until_ms INTEGER/i);
       expect(incrementalProjectionTotalsSql).toMatch(/available_at_ms INTEGER NOT NULL/i);
       expect(incrementalProjectionTotalsSql).not.toMatch(/available_at_ms INTEGER NOT NULL DEFAULT 0/i);
      expect(incrementalProjectionTotalsSql).toMatch(/retry_at_ms INTEGER/i);
      expect(incrementalProjectionTotalsSql).toMatch(/CREATE TABLE ledger_period_build_gc/i);
     expect(incrementalProjectionTotalsSql).toMatch(/maintenance_due INTEGER NOT NULL DEFAULT 1/i);
       expect(incrementalProjectionTotalsSql).toMatch(/idx_ledger_summary_maintenance_due ON ledger_summary_state\(maintenance_due,available_at_ms,updated_at,group_id\)/i);
       expect(incrementalProjectionTotalsSql).toMatch(/idx_ledger_period_gc_available/i);
       expect(incrementalProjectionTotalsSql).toMatch(/idx_ledger_period_eligible_month/i);
       expect(monthlySummarySql).toMatch(/available_at_ms<=\?/i);
       expect(monthlySummarySql).not.toMatch(/datetime\(/i);
      expect(incrementalProjectionTotalsSql).toMatch(/idx_ledger_period_non_ready ON ledger_period_state\(group_id,status,/i);
      expect(incrementalProjectionTotalsSql).toMatch(/idx_ledger_period_non_ready_month ON ledger_period_state\(group_id,month\)/i);
      expect(incrementalProjectionTotalsSql).toMatch(/idx_attachments_expense_purge ON attachments\(expense_id,id\)/i);
      expect(incrementalProjectionTotalsSql).toMatch(/idx_idempotency_group_purge ON idempotency_keys\(group_id,created_at,operation_id\)/i);
      expect(incrementalProjectionTotalsSql).toMatch(/idx_groups_deleted_purge ON groups\(deleted_at,id\)/i);
     expect(incrementalProjectionTotalsSql).toMatch(/CREATE TABLE group_purge_cursor/i);
     expect(monthlySummarySql).toMatch(/state\.maintenance_due=1[\s\S]*LIMIT \?/i);
     expect(incrementalProjectionTotalsSql).toMatch(/retry_count INTEGER/i);
    expect(incrementalProjectionTotalsSql).toMatch(/ALTER TABLE expenses ADD COLUMN projection_mutation_id/i);
    expect(incrementalProjectionTotalsSql).toMatch(/ALTER TABLE settlements ADD COLUMN projection_mutation_id/i);
     expect(incrementalProjectionTotalsSql).toMatch(/INSERT INTO ledger_summary_state[\s\S]*SELECT id,'pending',1,CAST\(\(julianday\('now'\)/i);
    expect(incrementalProjectionTotalsSql).toMatch(/CREATE TRIGGER ledger_summary_expense_insert_dirty/i);
     expect(incrementalProjectionTotalsSql).toMatch(/CREATE TRIGGER ledger_summary_group_insert_state/i);
      expect(incrementalProjectionTotalsSql).toMatch(/ledger_summary_group_insert_state[\s\S]*available_at_ms[\s\S]*julianday\('now'\)/i);
     expect(incrementalProjectionTotalsSql).toMatch(/DROP TRIGGER IF EXISTS expenses_ledger_total_limit_insert/i);
     expect(incrementalProjectionTotalsSql).toMatch(/DROP TRIGGER IF EXISTS settlements_ledger_total_limit_update/i);
     expect(incrementalProjectionTotalsSql).toMatch(/idx_scheduled_completion_due/);
     expect(incrementalProjectionTotalsSql).toMatch(/ledger_summary_payer_reassign_dirty/);
      expect(incrementalProjectionTotalsSql).toMatch(/ledger_period_state_insert_maintenance/);
       expect(monthlySummarySql).toMatch(/yieldGroupLease/);
        expect(monthlySummarySql).toMatch(/UPDATE ledger_period_state SET lease_owner=NULL,lease_until_ms=NULL/);
        expect(monthlySummarySql).not.toMatch(/yieldGroupLease[\s\S]*available_at_ms=0/);
        expect(monthlySummarySql).toMatch(/p\.build_generation=p\.source_generation[\s\S]*p\.month>COALESCE\(ledger_summary_state\.checkpoint_through/);
       expect(monthlySummarySql).toMatch(/maintenance_due=1 AND available_at_ms<=\?/);
       expect(monthlySummarySql).toMatch(/g\.deleted_at IS NULL/);
       expect(monthlySummarySql).toMatch(/NOT EXISTS \(SELECT 1 FROM ledger_period_state p[\s\S]*active_build_id=ledger_period_build_gc\.build_id/);
       expect(monthlySummarySql).not.toMatch(/monthlySummaryMaintenance[\s\S]*ledgerPeriodBuildGarbageCollection/);
       expect(monthlySummarySql).toMatch(/await db\.batch\(\[[\s\S]*INSERT OR IGNORE INTO ledger_period_build_gc[\s\S]*UPDATE ledger_period_state SET active_build_id=build_id/);
       expect(monthlySummarySql).toMatch(/status='backfilling',maintenance_due=1/);
        expect(monthlySummarySql).toMatch(/p\.month>COALESCE\(state\.checkpoint_through/);
        expect(monthlySummarySql).not.toMatch(/p\.month<=\?/);
        expect(monthlySummarySql).not.toMatch(/previousMonth\(new Date\(\)/);
       expect(incrementalProjectionTotalsSql).not.toMatch(/UPDATE projection_state[\s\S]*ledger_summary_expense_insert_dirty/);
      expect(incrementalProjectionTotalsSql).not.toMatch(/UPDATE projection_state/);
      expect(incrementalProjectionTotalsSql).toMatch(/ledger_summary_state state WHERE state\.group_id=NEW\.group_id[\s\S]*state\.maintenance_due=0/);
      expect(incrementalProjectionTotalsSql).not.toMatch(/ledger_totals_ready=1/);
      expect(ledgerProjectionSql).not.toMatch(/UPDATE projection_state/);
      expect(monthlySummarySql).not.toMatch(/UPDATE projection_state/);
      expect(ledgerProjectionSql).toMatch(/status='pending',maintenance_due=1[\s\S]*NOT EXISTS \(SELECT 1 FROM ledger_period_state/);
       expect(ledgerProjectionSql).not.toMatch(/UPDATE projection_state[\s\S]*status='stale'/);
       expect(repositorySql).not.toMatch(/projection_state[\s\S]*status='stale'/);
     expect(incrementalProjectionTotalsSql).not.toMatch(/idx_ledger_period_state_group_month/);
     expect(incrementalProjectionTotalsSql).not.toMatch(/idx_ledger_period_balances_active/);
     expect(incrementalProjectionTotalsSql).not.toMatch(/idx_ledger_period_totals_active/);
     expect(incrementalProjectionTotalsSql).not.toMatch(/idx_ledger_checkpoint_balances_group/);
     expect(incrementalProjectionTotalsSql).not.toMatch(/idx_ledger_checkpoint_totals_group/);
  });
});

describe('audit actor snapshot migration', () => {
  it('adds person and name snapshots without adding email to audit rows', () => {
    expect(auditActorSql).toMatch(/ALTER TABLE audit_events ADD COLUMN actor_person_id TEXT/i);
    expect(auditActorSql).toMatch(/ALTER TABLE audit_events ADD COLUMN actor_name TEXT/i);
    expect(auditActorSql).toMatch(/Unknown user/);
    expect(auditActorSql).not.toMatch(/email/i);
  });
});

describe('cleanup indexes migration', () => {
  it('drops only exact duplicate indexes and keeps covered-but-different indexes', () => {
    expect(cleanupIndexesSql).toMatch(/DROP INDEX IF EXISTS idx_audit_group_time/i);
    expect(cleanupIndexesSql).toMatch(/DROP INDEX IF EXISTS idx_expenses_operation/i);
    expect(cleanupIndexesSql).toMatch(/DROP INDEX IF EXISTS idx_scheduled_occurrence_expense/i);
    expect(cleanupIndexesSql).not.toMatch(/idx_expenses_group_date|idx_settlements_group_date|idx_audit_entity/);
  });
});

describe('category preferences migration', () => {
  it('documents conservative normalization, private ownership, and deterministic backfill rules', () => {
    expect(categoryPreferencesSql).toMatch(/CREATE TABLE category_preferences/);
    expect(categoryPreferencesSql).toMatch(/REFERENCES users\(id\)/i);
    expect(categoryPreferencesSql).toMatch(/normalized_description = lower\(trim\(normalized_description\)\)/i);
    expect(categoryPreferencesSql).toMatch(/ROW_NUMBER\(\) OVER/);
    expect(categoryPreferencesSql).toMatch(/ORDER BY updated_at DESC, id DESC, source DESC/);
    expect(categoryPreferencesSql).not.toMatch(/status <> 'cancelled'/i);
  });
});

describe('group membership lifecycle migration', () => {
  it('stores non-email lifecycle snapshots and enforces one active owner', () => {
    expect(membershipEventsSql).toMatch(/CREATE TABLE group_membership_events/);
    expect(membershipEventsSql).toMatch(/event_type TEXT NOT NULL CHECK[\s\S]*owner_transfer/);
    expect(membershipEventsSql).toMatch(/actor_person_id TEXT/);
    expect(membershipEventsSql).toMatch(/actor_name TEXT NOT NULL/);
    expect(membershipEventsSql).toMatch(/CREATE UNIQUE INDEX[\s\S]*group_members\(group_id\)[\s\S]*role='owner'/i);
    expect(membershipEventsSql).not.toMatch(/email/i);
  });
});

describe('account deletion migration', () => {
  it('adds a soft-delete marker while retaining the user FK anchor', () => {
    expect(accountDeletionSql).toMatch(/ALTER TABLE users ADD COLUMN deleted_at TEXT/i);
    expect(accountDeletionSql).toMatch(/idx_users_deleted_at/);
    expect(accountDeletionSql).not.toMatch(/DROP TABLE users|DELETE FROM users/i);
  });

  it('adds non-contact identity tombstones for relink prevention', () => {
    expect(identityTombstonesSql).toMatch(/ALTER TABLE users ADD COLUMN deleted_email_hash TEXT/i);
    expect(identityTombstonesSql).toMatch(/ALTER TABLE users ADD COLUMN deleted_clerk_hash TEXT/i);
    expect(identityTombstonesSql).toMatch(/idx_users_deleted_email_hash/);
    expect(identityTombstonesSql).toMatch(/idx_users_deleted_clerk_hash/);
    expect(identityTombstonesSql).not.toMatch(/email[^_].*TEXT NOT NULL/i);
  });
});

describe('application session migration', () => {
  it('stores only fixed-size token digests and supports bounded cleanup indexes', () => {
    expect(applicationSessionsSql).toMatch(/CREATE TABLE application_sessions/);
    expect(applicationSessionsSql).toMatch(/token_hash TEXT NOT NULL UNIQUE CHECK\(length\(token_hash\) = 64\)/i);
    expect(applicationSessionsSql).toMatch(/last_activity_at TEXT NOT NULL/);
    expect(applicationSessionsSql).toMatch(/idle_expires_at TEXT NOT NULL/);
    expect(applicationSessionsSql).toMatch(/idx_application_sessions_expiry/);
  });
});

describe('group split default migration', () => {
  it('stores one optional supported arrangement per group and cascades physical purges', () => {
    expect(splitDefaultsSql).toMatch(/CREATE TABLE group_split_defaults/);
    expect(splitDefaultsSql).toMatch(/PRIMARY KEY/);
    expect(splitDefaultsSql).toMatch(/method TEXT NOT NULL CHECK\(method IN \('equal','percentage','shares'\)\)/i);
    expect(splitDefaultsSql).toMatch(/REFERENCES groups\(id\) ON DELETE CASCADE/i);
    expect(splitDefaultsSql).toMatch(/json_valid/);
    expect(splitDefaultsSql).toMatch(/group_split_defaults_purge_on_group_delete/);
  });
});

describe('expense suggestion lookup migration', () => {
  it('indexes active expenses by group, creator, and newest creation tie-breakers', () => {
    expect(expenseSuggestionLookupSql).toMatch(/CREATE INDEX IF NOT EXISTS idx_expenses_suggestion_lookup/i);
    expect(expenseSuggestionLookupSql).toMatch(/ON expenses\(group_id,created_by,created_at DESC,id DESC\)/i);
    expect(expenseSuggestionLookupSql).toMatch(/WHERE deleted_at IS NULL/i);
    expect(expenseSuggestionLookupSql).not.toMatch(/CREATE TABLE|ALTER TABLE|DROP INDEX|CREATE TRIGGER/i);
    expect(repositorySql).toMatch(/NOT EXISTS \(SELECT 1 FROM scheduled_occurrences occurrence WHERE occurrence\.expense_id=e\.id\)/i);
    expect(incrementalProjectionTotalsSql).toMatch(/idx_scheduled_occurrence_expense_purge ON scheduled_occurrences\(expense_id\)/i);
  });
});
