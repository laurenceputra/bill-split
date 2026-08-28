import { describe, expect, it } from 'vitest';
// The worker tsconfig intentionally does not include Node types; this test
// runs in Vitest's Node environment and reads the authored migration.
// @ts-expect-error Node types are not shipped to the Worker build.
import { readFileSync } from 'node:fs';
// @ts-expect-error Node types are not shipped to the Worker build.
import { cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
// @ts-expect-error Node types are not shipped to the Worker build.
import { spawnSync } from 'node:child_process';
// @ts-expect-error Node types are not shipped to the Worker build.
import { tmpdir } from 'node:os';
// @ts-expect-error Node types are not shipped to the Worker build.
import { join } from 'node:path';
// @ts-expect-error Node types are not shipped to the Worker build.
import { fileURLToPath } from 'node:url';

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
     expect(incrementalProjectionTotalsSql).toMatch(/lease_until TEXT/i);
     expect(incrementalProjectionTotalsSql).toMatch(/maintenance_due INTEGER NOT NULL DEFAULT 1/i);
      expect(incrementalProjectionTotalsSql).toMatch(/idx_ledger_summary_maintenance_due ON ledger_summary_state\(maintenance_due,/i);
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
    expect(incrementalProjectionTotalsSql).toMatch(/INSERT INTO ledger_summary_state[\s\S]*SELECT id,'pending'/i);
    expect(incrementalProjectionTotalsSql).toMatch(/CREATE TRIGGER ledger_summary_expense_insert_dirty/i);
    expect(incrementalProjectionTotalsSql).toMatch(/CREATE TRIGGER ledger_summary_group_insert_state/i);
     expect(incrementalProjectionTotalsSql).toMatch(/DROP TRIGGER IF EXISTS expenses_ledger_total_limit_insert/i);
     expect(incrementalProjectionTotalsSql).toMatch(/DROP TRIGGER IF EXISTS settlements_ledger_total_limit_update/i);
     expect(incrementalProjectionTotalsSql).toMatch(/idx_scheduled_completion_due/);
     expect(incrementalProjectionTotalsSql).toMatch(/ledger_summary_payer_reassign_dirty/);
      expect(incrementalProjectionTotalsSql).toMatch(/ledger_period_state_insert_maintenance/);
        expect(monthlySummarySql).toMatch(/yieldGroupLease/);
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

describe('scheduled completion migration integration', () => {
  it('upgrades a populated local D1 database without losing scheduled children or foreign keys', async () => {
    const root = fileURLToPath(new URL('../../', moduleUrl));
    const tempRoot = await mkdtemp(join(tmpdir(), 'bill-split-migration-'));
    const migrationsDir = join(tempRoot, 'migrations');
    const persistDir = join(tempRoot, 'persist');
    const configPath = join(tempRoot, 'wrangler.toml');
    const seedPath = join(tempRoot, 'seed.sql');
    const wrangler = fileURLToPath(new URL('../../node_modules/.bin/wrangler', moduleUrl));
    const migrationNames = [
      '0001_initial.sql', '0002_production_safety.sql', '0003_ledger_total_limits.sql',
      '0004_friend_idempotency_lookup.sql', '0005_clerk_identity.sql',
      '0006_scheduled_expenses.sql', '0007_scheduled_generation_claims.sql',
    ];
    const seed = `
      INSERT INTO users(id,email,created_at,updated_at) VALUES('user-1','migration@example.com','2026-01-01','2026-01-01');
      INSERT INTO people(id,name,email,user_id,created_at) VALUES('person-1','Migration User','migration@example.com','user-1','2026-01-01');
       INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('group-1','Migration Group','USD','2026-01-01','2026-01-01');
       INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('group-multiple','Multiple Owners','USD','2026-01-01','2026-01-01');
       INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('group-ownerless','Ownerless Group','USD','2026-01-01','2026-01-01');
       INSERT INTO group_members(group_id,person_id,user_id,joined_at,role) VALUES('group-1','person-1','user-1','2026-01-01','owner');
       INSERT INTO people(id,name,email,created_at) VALUES('person-2','Second','second@example.com','2026-01-01');
       INSERT INTO people(id,name,email,created_at) VALUES('person-3','Third','third@example.com','2026-01-01');
       INSERT INTO people(id,name,email,created_at) VALUES('person-4','Fourth','fourth@example.com','2026-01-01');
       INSERT INTO group_members(group_id,person_id,joined_at,role) VALUES('group-multiple','person-3','2026-01-03','owner');
       INSERT INTO group_members(group_id,person_id,joined_at,role) VALUES('group-multiple','person-2','2026-01-03','owner');
       INSERT INTO group_members(group_id,person_id,joined_at,role) VALUES('group-ownerless','person-4','2026-01-02','member');
       INSERT INTO group_members(group_id,person_id,joined_at,role) VALUES('group-ownerless','person-3','2026-01-01','member');
       INSERT INTO expenses(id,group_id,description,amount_minor,currency,expense_date,category,created_by,created_at,updated_at,version) VALUES('expense-1','group-1','ÉCLAIR',1000,'USD','2026-01-01','Dining','user-1','2026-01-01','2026-01-01',1);
       INSERT INTO expenses(id,group_id,description,amount_minor,currency,expense_date,category,created_by,created_at,updated_at,version) VALUES('expense-2','group-1','Éclair',500,'USD','2026-01-02','Dessert','user-1','2026-01-02','2026-01-02',1);
      INSERT INTO payers(expense_id,person_id,amount_minor) VALUES('expense-1','person-1',1000);
      INSERT INTO splits(expense_id,person_id,amount_minor) VALUES('expense-1','person-1',1000);
      INSERT INTO scheduled_expenses(id,group_id,description,amount_minor,currency,start_date,end_date,frequency,interval_count,weekdays_json,timezone,status,blocked_reason,next_occurrence_date,created_by,created_at,updated_at,version,client_operation_id,generation_claim_id)
        VALUES('scheduled-1','group-1','Existing schedule',1000,'USD','2026-01-01',NULL,'monthly',1,'[]','UTC','active',NULL,'2026-02-01','user-1','2026-01-01','2026-01-01',3,NULL,'claim-1');
      INSERT INTO scheduled_payers(scheduled_expense_id,person_id,amount_minor) VALUES('scheduled-1','person-1',1000);
      INSERT INTO scheduled_splits(scheduled_expense_id,person_id,amount_minor,metadata_json) VALUES('scheduled-1','person-1',1000,NULL);
      INSERT INTO scheduled_occurrences(scheduled_expense_id,occurrence_date,expense_id,created_at) VALUES('scheduled-1','2026-01-01','expense-1','2026-01-01');
    `;
    const run = (args: string[]) => {
      const result = spawnSync(wrangler, args, { cwd: tempRoot, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(`Wrangler failed (${result.status}): ${result.stdout}\n${result.stderr}`);
      return result.stdout;
    };
    const query = (sql: string) => {
      const output = run(['d1', 'execute', 'bill-split-migration', '--local', '--persist-to', persistDir, '--config', configPath, '--command', sql, '--json']);
      const parsed = JSON.parse(output) as Array<{ results?: Array<Record<string, unknown>> }>;
      return parsed.flatMap((result) => result.results ?? []);
    };

    try {
      await mkdir(migrationsDir, { recursive: true });
      await Promise.all(migrationNames.map((name) => cp(join(root, 'migrations', name), join(migrationsDir, name))));
      await writeFile(configPath, `name = "bill-split-migration-test"\ncompatibility_date = "2025-08-01"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "bill-split-migration"\ndatabase_id = "00000000-0000-4000-8000-000000000002"\nmigrations_dir = "migrations"\n`);
      await writeFile(seedPath, seed);
      run(['d1', 'migrations', 'apply', 'bill-split-migration', '--local', '--persist-to', persistDir, '--config', configPath]);
      run(['d1', 'execute', 'bill-split-migration', '--local', '--persist-to', persistDir, '--config', configPath, '--file', seedPath]);
       expect(query('PRAGMA foreign_key_check;')).toEqual([]);
         await Promise.all(['0008_scheduled_expense_completion.sql', '0009_scheduled_generation_cursor.sql', '0010_generated_expense_operation_namespace.sql', '0011_scheduled_expense_category.sql', '0012_invitations_audit_purge.sql', '0013_projection_layer.sql', '0014_projection_indexes.sql', '0015_audit_actor_snapshot.sql', '0016_projection_readiness_reset.sql', '0017_cleanup_indexes.sql', '0018_category_preferences.sql', '0019_group_membership_events.sql', '0020_account_deletion.sql', '0021_deleted_identity_tombstones.sql', '0022_application_sessions.sql', '0023_group_split_defaults.sql'].map((name) => cp(join(root, 'migrations', name), join(migrationsDir, name))));
        run(['d1', 'migrations', 'apply', 'bill-split-migration', '--local', '--persist-to', persistDir, '--config', configPath]);
        run(['d1', 'execute', 'bill-split-migration', '--local', '--persist-to', persistDir, '--config', configPath, '--command', "UPDATE projection_state SET status='ready' WHERE group_id='group-1';", '--yes']);
        run(['d1', 'execute', 'bill-split-migration', '--local', '--persist-to', persistDir, '--config', configPath, '--command', "INSERT INTO group_balance_projection(group_id,currency,person_id,net_minor,updated_at) VALUES('group-1','USD','person-1',100,'2026-01-01');", '--yes']);
        await cp(join(root, 'migrations', '0024_incremental_projection_totals.sql'), join(migrationsDir, '0024_incremental_projection_totals.sql'));
      run(['d1', 'migrations', 'apply', 'bill-split-migration', '--local', '--persist-to', persistDir, '--config', configPath]);

      expect(query('SELECT id,status,generation_claim_id,next_occurrence_date,(SELECT COUNT(*) FROM scheduled_payers WHERE scheduled_expense_id=scheduled_expenses.id) AS payer_count,(SELECT COUNT(*) FROM scheduled_splits WHERE scheduled_expense_id=scheduled_expenses.id) AS split_count,(SELECT COUNT(*) FROM scheduled_occurrences WHERE scheduled_expense_id=scheduled_expenses.id) AS occurrence_count FROM scheduled_expenses WHERE id=\'scheduled-1\';')).toEqual([
        { id: 'scheduled-1', status: 'active', generation_claim_id: 'claim-1', next_occurrence_date: '2026-02-01', payer_count: 1, split_count: 1, occurrence_count: 1 },
      ]);
      expect(query('PRAGMA foreign_key_check;')).toEqual([]);
      expect(query('PRAGMA foreign_key_list(scheduled_payers);')).toEqual(expect.arrayContaining([expect.objectContaining({ table: 'scheduled_expenses' })]));
      expect(query('PRAGMA foreign_key_list(scheduled_occurrences);')).toEqual(expect.arrayContaining([expect.objectContaining({ table: 'scheduled_expenses' })]));
      expect(query('PRAGMA table_info(scheduled_expenses);')).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'category' })]));
      expect(query('SELECT cursor_id FROM scheduled_generation_cursor WHERE id=1;')).toEqual([{ cursor_id: null }]);
         expect(query('SELECT name FROM sqlite_master WHERE type=\'table\' AND name IN (\'group_invitations\',\'audit_events\') ORDER BY name;')).toEqual([{ name: 'audit_events' }, { name: 'group_invitations' }]);
       expect(query("SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_expenses_group_date','idx_settlements_group_date','idx_audit_entity') ORDER BY name;")).toEqual([{ name: 'idx_audit_entity' }, { name: 'idx_expenses_group_date' }, { name: 'idx_settlements_group_date' }]);
       expect(JSON.stringify(query("EXPLAIN QUERY PLAN SELECT id,deleted_at FROM groups WHERE deleted_at IS NOT NULL AND deleted_at<'2026-02-01' ORDER BY deleted_at,id LIMIT 1;"))).toContain('idx_groups_deleted_purge');
           expect(query('SELECT status,ledger_totals_ready,reconciliation_due FROM projection_state WHERE group_id=\'group-1\';')).toEqual([{ status: 'ready', ledger_totals_ready: 0, reconciliation_due: 0 }]);
       expect(query("SELECT group_id,status,ledger_totals_ready,reconciliation_due FROM projection_state WHERE group_id IN ('group-multiple','group-ownerless') ORDER BY group_id;")).toEqual([
             { group_id: 'group-multiple', status: 'pending', ledger_totals_ready: 0, reconciliation_due: 0 },
             { group_id: 'group-ownerless', status: 'pending', ledger_totals_ready: 0, reconciliation_due: 0 },
           ]);
          expect(query("SELECT group_id,maintenance_due FROM ledger_summary_state ORDER BY group_id;")).toEqual([
            { group_id: 'group-1', maintenance_due: 1 },
            { group_id: 'group-multiple', maintenance_due: 1 },
            { group_id: 'group-ownerless', maintenance_due: 1 },
          ]);
          expect(query('SELECT user_id,normalized_description,category FROM category_preferences;')).toEqual([{ user_id: 'user-1', normalized_description: 'Éclair', category: 'Dessert' }]);
         expect(query('SELECT name FROM pragma_table_info(\'audit_events\') WHERE name IN (\'actor_person_id\',\'actor_name\') ORDER BY name;')).toEqual([{ name: 'actor_name' }, { name: 'actor_person_id' }]);
         expect(query("SELECT name FROM sqlite_master WHERE type='table' AND name='group_membership_events';")).toEqual([{ name: 'group_membership_events' }]);
         expect(query("SELECT group_id,person_id,role FROM group_members WHERE group_id IN ('group-multiple','group-ownerless') AND role='owner' ORDER BY group_id,person_id;")).toEqual([{ group_id: 'group-multiple', person_id: 'person-2', role: 'owner' }, { group_id: 'group-ownerless', person_id: 'person-3', role: 'owner' }]);
       expect(query("SELECT name FROM pragma_table_info('users') WHERE name IN ('deleted_at','deleted_email_hash','deleted_clerk_hash') ORDER BY name;")).toEqual([{ name: 'deleted_at' }, { name: 'deleted_clerk_hash' }, { name: 'deleted_email_hash' }]);
       expect(query('SELECT group_id,currency,gross_minor FROM ledger_totals;')).toEqual([]);
       expect(query('SELECT group_id,currency,person_id,net_minor FROM group_balance_projection;')).toEqual([{ group_id: 'group-1', currency: 'USD', person_id: 'person-1', net_minor: 100 }]);
       run(['d1', 'execute', 'bill-split-migration', '--local', '--persist-to', persistDir, '--config', configPath, '--command', "UPDATE expenses SET currency='EUR' WHERE id='expense-2'; UPDATE expenses SET deleted_at='2026-01-03' WHERE id='expense-1'; UPDATE expenses SET deleted_at=NULL WHERE id='expense-1'; DELETE FROM expenses WHERE id='expense-2';", '--yes']);
       expect(query("SELECT status,maintenance_due FROM ledger_summary_state WHERE group_id='group-1';")).toEqual([{ status: 'dirty', maintenance_due: 1 }]);
       expect(query("SELECT status,ledger_totals_ready,reconciliation_due FROM projection_state WHERE group_id='group-1';")).toEqual([{ status: 'ready', ledger_totals_ready: 0, reconciliation_due: 0 }]);
       expect(query('SELECT group_id,currency,gross_minor FROM ledger_totals ORDER BY currency;')).toEqual([]);
       run(['d1', 'execute', 'bill-split-migration', '--local', '--persist-to', persistDir, '--config', configPath, '--command', `INSERT INTO group_split_defaults(group_id,method,person_ids_json,values_json,updated_at) VALUES('group-1','equal','["person-1"]',NULL,'2026-01-01'); UPDATE groups SET deleted_at='2026-02-01' WHERE id='group-1';`, '--yes']);
       expect(query("SELECT group_id FROM group_split_defaults WHERE group_id='group-1';")).toEqual([]);
       expect(query('SELECT group_id,currency,person_id,net_minor FROM group_balance_projection;')).toEqual([{ group_id: 'group-1', currency: 'USD', person_id: 'person-1', net_minor: 100 }]);
       expect(query('PRAGMA foreign_key_check;')).toEqual([]);

      const invalidChild = spawnSync(wrangler, ['d1', 'execute', 'bill-split-migration', '--local', '--persist-to', persistDir, '--config', configPath, '--command', "INSERT INTO scheduled_payers(scheduled_expense_id,person_id,amount_minor) VALUES('missing-schedule','person-1',1);", '--yes'], { cwd: tempRoot, encoding: 'utf8' });
      expect(invalidChild.status).not.toBe(0);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
