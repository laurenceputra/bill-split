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
      INSERT INTO group_members(group_id,person_id,user_id,joined_at,role) VALUES('group-1','person-1','user-1','2026-01-01','owner');
      INSERT INTO expenses(id,group_id,description,amount_minor,currency,expense_date,created_by,created_at,updated_at,version) VALUES('expense-1','group-1','Existing occurrence',1000,'USD','2026-01-01','user-1','2026-01-01','2026-01-01',1);
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
      await Promise.all(['0008_scheduled_expense_completion.sql', '0009_scheduled_generation_cursor.sql', '0010_generated_expense_operation_namespace.sql', '0011_scheduled_expense_category.sql'].map((name) => cp(join(root, 'migrations', name), join(migrationsDir, name))));
      run(['d1', 'migrations', 'apply', 'bill-split-migration', '--local', '--persist-to', persistDir, '--config', configPath]);

      expect(query('SELECT id,status,generation_claim_id,next_occurrence_date,(SELECT COUNT(*) FROM scheduled_payers WHERE scheduled_expense_id=scheduled_expenses.id) AS payer_count,(SELECT COUNT(*) FROM scheduled_splits WHERE scheduled_expense_id=scheduled_expenses.id) AS split_count,(SELECT COUNT(*) FROM scheduled_occurrences WHERE scheduled_expense_id=scheduled_expenses.id) AS occurrence_count FROM scheduled_expenses WHERE id=\'scheduled-1\';')).toEqual([
        { id: 'scheduled-1', status: 'active', generation_claim_id: 'claim-1', next_occurrence_date: '2026-02-01', payer_count: 1, split_count: 1, occurrence_count: 1 },
      ]);
      expect(query('PRAGMA foreign_key_check;')).toEqual([]);
      expect(query('PRAGMA foreign_key_list(scheduled_payers);')).toEqual(expect.arrayContaining([expect.objectContaining({ table: 'scheduled_expenses' })]));
      expect(query('PRAGMA foreign_key_list(scheduled_occurrences);')).toEqual(expect.arrayContaining([expect.objectContaining({ table: 'scheduled_expenses' })]));
      expect(query('PRAGMA table_info(scheduled_expenses);')).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'category' })]));
      expect(query('SELECT cursor_id FROM scheduled_generation_cursor WHERE id=1;')).toEqual([{ cursor_id: null }]);

      const invalidChild = spawnSync(wrangler, ['d1', 'execute', 'bill-split-migration', '--local', '--persist-to', persistDir, '--config', configPath, '--command', "INSERT INTO scheduled_payers(scheduled_expense_id,person_id,amount_minor) VALUES('missing-schedule','person-1',1);", '--yes'], { cwd: tempRoot, encoding: 'utf8' });
      expect(invalidChild.status).not.toBe(0);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
