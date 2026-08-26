import { describe, expect, it } from 'vitest';
import { Repository } from './repository';
// The worker tsconfig intentionally does not include Node types; this test
// runs in Vitest's Node environment and drives a real local D1 database.
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

type D1Row = Record<string, unknown>;
type D1Execution = { rows: D1Row[]; changes: number };

class LocalD1Statement {
  private args: unknown[] = [];

  constructor(private readonly sql: string, private readonly execute: (sql: string, args: unknown[]) => D1Execution) {}

  bind(...args: unknown[]) {
    this.args = args;
    return this;
  }

  async all<T>() {
    return { results: this.execute(this.sql, this.args).rows as T[] };
  }

  async first<T>() {
    return (await this.all<T>()).results[0] ?? null;
  }

  async run() {
    return { meta: { changes: this.execute(this.sql, this.args).changes } };
  }

  bound() { return { sql: this.sql, args: this.args }; }

}

class LocalD1 {
  constructor(private readonly execute: (sql: string, args: unknown[]) => D1Execution, private readonly executeBatch: (statements: Array<{ sql: string; args: unknown[] }>) => D1Execution[]) {}

  prepare(sql: string) {
    return new LocalD1Statement(sql, this.execute);
  }

  async batch(statements: Array<{ bound: () => { sql: string; args: unknown[] } }>) {
    return this.executeBatch(statements.map((statement) => statement.bound())).map((result) => ({ meta: { changes: result.changes } }));
  }

}

describe('home balance summaries against local D1', () => {
  it('uses the authenticated person for pending fallback and ready projections', async () => {
    const moduleUrl = (import.meta as ImportMeta & { url: string }).url;
    const root = fileURLToPath(new URL('../../', moduleUrl));
    const tempRoot = await mkdtemp(join(tmpdir(), 'bill-split-summary-'));
    const migrationsDir = join(tempRoot, 'migrations');
    const persistDir = join(tempRoot, 'persist');
    const configPath = join(tempRoot, 'wrangler.toml');
    const seedPath = join(tempRoot, 'seed.sql');
    const readyPath = join(tempRoot, 'ready.sql');
    const wrangler = fileURLToPath(new URL('../../node_modules/.bin/wrangler', moduleUrl));
    const migrationNames = [
      '0001_initial.sql', '0002_production_safety.sql', '0003_ledger_total_limits.sql',
      '0004_friend_idempotency_lookup.sql', '0005_clerk_identity.sql',
      '0006_scheduled_expenses.sql', '0007_scheduled_generation_claims.sql',
      '0008_scheduled_expense_completion.sql', '0009_scheduled_generation_cursor.sql',
      '0010_generated_expense_operation_namespace.sql', '0011_scheduled_expense_category.sql',
      '0012_invitations_audit_purge.sql', '0013_projection_layer.sql',
      '0014_projection_indexes.sql', '0015_audit_actor_snapshot.sql',
      '0016_projection_readiness_reset.sql', '0017_cleanup_indexes.sql', '0018_category_preferences.sql',
      '0019_group_membership_events.sql', '0020_account_deletion.sql', '0021_deleted_identity_tombstones.sql', '0022_incremental_projection_totals.sql',
    ];
    const seed = `
      INSERT INTO users(id,email,created_at,updated_at) VALUES
        ('user-a','a@example.com','2026-01-01','2026-01-01'),
        ('user-b','b@example.com','2026-01-01','2026-01-01'),
        ('user-c','c@example.com','2026-01-01','2026-01-01');
      INSERT INTO people(id,name,email,user_id,created_at) VALUES
        ('person-a','Alex','a@example.com','user-a','2026-01-01'),
        ('person-b','Blair','b@example.com','user-b','2026-01-01'),
        ('person-c','Casey','c@example.com','user-c','2026-01-01');
      INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES
        ('group-1','Shared','USD','2026-01-01','2026-01-01'),
        ('group-2','Other shared','USD','2026-01-02','2026-01-02');
      INSERT INTO group_members(group_id,person_id,user_id,joined_at,role) VALUES
        ('group-1','person-a','user-a','2026-01-01','owner'),
        ('group-1','person-b','user-b','2026-01-01','member'),
        ('group-2','person-a','user-a','2026-01-02','owner'),
        ('group-2','person-b','user-b','2026-01-02','member');
      INSERT INTO projection_state(group_id,status,backfill_cursor,last_rebuilt_at,updated_at) VALUES
        ('group-1','pending',NULL,NULL,'2026-01-01'),
        ('group-2','pending',NULL,NULL,'2026-01-02');
      INSERT INTO expenses(id,group_id,description,amount_minor,currency,expense_date,created_by,created_at,updated_at,version)
        VALUES('expense-1','group-1','Dinner',100,'USD','2026-01-01','user-a','2026-01-01','2026-01-01',1),
        ('expense-2','group-2','Other dinner',200,'USD','2026-01-02','user-b','2026-01-02','2026-01-02',1);
      INSERT INTO payers(expense_id,person_id,amount_minor) VALUES('expense-1','person-a',100);
      INSERT INTO splits(expense_id,person_id,amount_minor) VALUES('expense-1','person-b',100);
      INSERT INTO payers(expense_id,person_id,amount_minor) VALUES('expense-2','person-b',200);
      INSERT INTO splits(expense_id,person_id,amount_minor) VALUES('expense-2','person-a',200);
    ` + Array.from({ length: 100 }, (_, index) => {
      const personId = `bulk-person-${String(index + 1).padStart(3, '0')}`;
      return `INSERT INTO people(id,name,created_at) VALUES('${personId}','Bulk ${index + 1}','2026-01-02');
        INSERT INTO group_members(group_id,person_id,joined_at,role) VALUES('group-2','${personId}','2026-01-02','member');`;
    }).join('\n') + `
      INSERT INTO expenses(id,group_id,description,amount_minor,currency,expense_date,created_by,created_at,updated_at,version)
        VALUES('bulk-expense','group-2','Bulk expense',100,'USD','2026-01-02','user-b','2026-01-02','2026-01-02',1);
      INSERT INTO payers(expense_id,person_id,amount_minor) VALUES
        ${Array.from({ length: 100 }, (_, index) => `('bulk-expense','bulk-person-${String(index + 1).padStart(3, '0')}',1)`).join(',')};
      INSERT INTO splits(expense_id,person_id,amount_minor) VALUES
        ${Array.from({ length: 100 }, (_, index) => `('bulk-expense','bulk-person-${String(index + 1).padStart(3, '0')}',1)`).join(',')};
    `;
    const bulkExpenseInput = {
      description: 'Bulk expense revised', amount_minor: 100, currency: 'USD' as const, date: '2026-01-02',
      payers: Array.from({ length: 100 }, (_, index) => ({ person_id: `bulk-person-${String(index + 1).padStart(3, '0')}`, amount_minor: 1 })),
      splits: Array.from({ length: 100 }, (_, index) => ({ person_id: `bulk-person-${String(index + 1).padStart(3, '0')}`, amount_minor: 1 })),
    };

    const run = (args: string[]) => {
      const result = spawnSync(wrangler, args, { cwd: tempRoot, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(`Wrangler failed (${result.status}): ${result.stdout}\n${result.stderr}`);
      return result.stdout;
    };
    const bindSql = (sql: string, args: unknown[]) => {
      let index = 0;
      const boundSql = sql.replaceAll('?', () => {
        const value = args[index++];
        if (value == null) return 'NULL';
        if (typeof value === 'number') return String(value);
        return `'${String(value).replaceAll("'", "''")}'`;
      });
      if (index !== args.length) throw new Error(`Expected ${index} binds, received ${args.length}`);
      return boundSql;
    };
    const executeParsed = (sql: string, args: unknown[] = []) => {
      const boundSql = bindSql(sql, args);
      const output = run(['d1', 'execute', 'bill-split-summary', '--local', '--persist-to', persistDir, '--config', configPath, '--command', boundSql, '--yes', '--json']);
      return JSON.parse(output) as Array<{ results?: D1Row[]; meta?: { changes?: number } }>;
    };
    const execute = (sql: string, args: unknown[] = []): D1Execution => {
      const parsed = executeParsed(sql, args);
      let changes = parsed.reduce((total, result) => total + Number(result.meta?.changes ?? 0), 0);
      if (sql.includes('UPDATE expenses SET') || sql.includes('UPDATE settlements SET')) {
        const boundSql = bindSql(sql, args), marker = boundSql.match(/projection_mutation_id='([^']+)'/);
        if (marker) {
          const table = sql.includes('UPDATE settlements') ? 'settlements' : 'expenses';
          const verification = executeParsed(`SELECT COUNT(*) AS changes FROM ${table} WHERE projection_mutation_id='${marker[1].replaceAll("'", "''")}'`);
          changes = Number(verification[0]?.results?.[0]?.changes ?? 0);
        }
      }
      return { rows: parsed.flatMap((result) => result.results ?? []), changes };
    };
    const executeBatch = (statements: Array<{ sql: string; args: unknown[] }>): D1Execution[] => {
      // Wrangler's local D1 CLI does not expose a Worker binding.batch(), and
      // rejects SQL BEGIN/SAVEPOINT. Keep this on one real-D1 command and
      // derive each statement's actual changes; rollback atomicity remains
      // covered by the repository guards and production D1 batch contract.
      const command = statements.flatMap((statement, index) => [bindSql(statement.sql, statement.args), `SELECT changes() AS __batch_changes_${index}`]).join(';\n');
      const rows = executeParsed(command).flatMap((result) => result.results ?? []);
      return statements.map((_, index) => ({ rows: [], changes: Number(rows.find((row) => row[`__batch_changes_${index}`] !== undefined)?.[`__batch_changes_${index}`] ?? 0) }));
    };
    const db = new LocalD1(execute, executeBatch);

    try {
      await mkdir(migrationsDir, { recursive: true });
      await Promise.all(migrationNames.map((name) => cp(join(root, 'migrations', name), join(migrationsDir, name))));
      await writeFile(configPath, `name = "bill-split-summary-test"\ncompatibility_date = "2025-08-01"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "bill-split-summary"\ndatabase_id = "00000000-0000-4000-8000-000000000003"\nmigrations_dir = "migrations"\n`);
      await writeFile(seedPath, seed);
      run(['d1', 'migrations', 'apply', 'bill-split-summary', '--local', '--persist-to', persistDir, '--config', configPath]);
      run(['d1', 'execute', 'bill-split-summary', '--local', '--persist-to', persistDir, '--config', configPath, '--file', seedPath]);

      const repo = new Repository(db as never);
      const scheduled = await repo.createScheduledExpense('group-1', 'user-a', {
        description: 'Recurring rent', amount_minor: 1000, currency: 'USD', category: 'Housing', start_date: '2026-01-15', end_date: null,
        frequency: 'monthly', interval: 1, weekdays: [], timezone: 'UTC',
        payers: [{ person_id: 'person-a', amount_minor: 1000 }],
        splits: [{ person_id: 'person-a', amount_minor: 500 }, { person_id: 'person-b', amount_minor: 500 }],
        client_operation_id: 'real-d1-scheduled-create',
      });
      expect(scheduled).toMatchObject({ groupId: 'group-1', description: 'Recurring rent', category: 'Housing', status: 'active', nextOccurrenceDate: '2026-01-15', version: 1 });
      expect(execute('SELECT group_id,description,amount_minor,currency,category,start_date,frequency,interval_count,weekdays_json,timezone,status,version FROM scheduled_expenses WHERE id=?', [scheduled.id]).rows).toEqual([{
        group_id: 'group-1', description: 'Recurring rent', amount_minor: 1000, currency: 'USD', category: 'Housing', start_date: '2026-01-15', frequency: 'monthly', interval_count: 1, weekdays_json: '[]', timezone: 'UTC', status: 'active', version: 1,
      }]);
      expect(execute('SELECT person_id,amount_minor FROM scheduled_payers WHERE scheduled_expense_id=?', [scheduled.id]).rows).toEqual([{ person_id: 'person-a', amount_minor: 1000 }]);
      expect(execute('SELECT person_id,amount_minor,metadata_json FROM scheduled_splits WHERE scheduled_expense_id=? ORDER BY person_id', [scheduled.id]).rows).toEqual([
        { person_id: 'person-a', amount_minor: 500, metadata_json: null },
        { person_id: 'person-b', amount_minor: 500, metadata_json: null },
      ]);
      expect(execute("SELECT group_id,status,ledger_totals_ready FROM projection_state ORDER BY group_id").rows).toEqual([
        { group_id: 'group-1', status: 'pending', ledger_totals_ready: 0 },
        { group_id: 'group-2', status: 'pending', ledger_totals_ready: 0 },
      ]);
      const pendingA = await repo.groups('user-a');
      const pendingB = await repo.groups('user-b');
      expect(pendingA.map(({ id, balanceSummaries }) => ({ id, balanceSummaries }))).toEqual([
        { id: 'group-2', balanceSummaries: [{ currency: 'USD', netMinor: -200 }] },
        { id: 'group-1', balanceSummaries: [{ currency: 'USD', netMinor: 100 }] },
      ]);
      expect(pendingB.map(({ id, balanceSummaries }) => ({ id, balanceSummaries }))).toEqual([
        { id: 'group-2', balanceSummaries: [{ currency: 'USD', netMinor: 200 }] },
        { id: 'group-1', balanceSummaries: [{ currency: 'USD', netMinor: -100 }] },
      ]);
      await expect(repo.groups('user-c')).resolves.toEqual([]);

      // Deliberately use a different projection value so this assertion proves
      // the ready branch is selected instead of falling back to the expense.
      await writeFile(readyPath, `
        DELETE FROM group_balance_projection WHERE group_id IN ('group-1','group-2');
        INSERT INTO group_balance_projection(group_id,currency,person_id,net_minor,updated_at) VALUES('group-1','USD','person-a',250,'2026-01-02');
        INSERT INTO group_balance_projection(group_id,currency,person_id,net_minor,updated_at) VALUES('group-1','USD','person-b',-250,'2026-01-02');
        INSERT INTO group_balance_projection(group_id,currency,person_id,net_minor,updated_at) VALUES('group-2','USD','person-a',-450,'2026-01-02');
        INSERT INTO group_balance_projection(group_id,currency,person_id,net_minor,updated_at) VALUES('group-2','USD','person-b',450,'2026-01-02');
        UPDATE projection_state SET status='ready',updated_at='2026-01-02' WHERE group_id IN ('group-1','group-2');
      `);
      run(['d1', 'execute', 'bill-split-summary', '--local', '--persist-to', persistDir, '--config', configPath, '--file', readyPath]);
      expect(execute("SELECT group_id,status FROM projection_state ORDER BY group_id").rows).toEqual([{ group_id: 'group-1', status: 'ready' }, { group_id: 'group-2', status: 'ready' }]);
      expect(execute("SELECT group_id,person_id,net_minor FROM group_balance_projection ORDER BY group_id,person_id").rows).toEqual([
        { group_id: 'group-1', person_id: 'person-a', net_minor: 250 },
        { group_id: 'group-1', person_id: 'person-b', net_minor: -250 },
        { group_id: 'group-2', person_id: 'person-a', net_minor: -450 },
        { group_id: 'group-2', person_id: 'person-b', net_minor: 450 },
      ]);
      const readyA = await repo.groups('user-a');
      const readyB = await repo.groups('user-b');
      expect(readyA.map(({ id, balanceSummaries }) => ({ id, balanceSummaries }))).toEqual([
        { id: 'group-2', balanceSummaries: [{ currency: 'USD', netMinor: -450 }] },
        { id: 'group-1', balanceSummaries: [{ currency: 'USD', netMinor: 250 }] },
      ]);
      expect(readyB.map(({ id, balanceSummaries }) => ({ id, balanceSummaries }))).toEqual([
        { id: 'group-2', balanceSummaries: [{ currency: 'USD', netMinor: 450 }] },
        { id: 'group-1', balanceSummaries: [{ currency: 'USD', netMinor: -250 }] },
      ]);

      await execute("DELETE FROM group_balance_projection WHERE group_id='group-2'; UPDATE projection_state SET status='pending',reconciliation_due=0 WHERE group_id IN ('group-1','group-2')");
      const pendingUpdated = await repo.updateExpense('expense-2', 'user-a', {
        description: 'Other dinner revised', amount_minor: 200, currency: 'USD', date: '2026-01-02', version: 1,
        payers: [{ person_id: 'person-b', amount_minor: 200 }], splits: [{ person_id: 'person-a', amount_minor: 200 }],
      });
      await repo.deleteExpense(pendingUpdated.id, 'user-a', pendingUpdated.version);
      expect(execute("SELECT * FROM group_balance_projection WHERE group_id='group-2'").rows).toEqual([]);
      await repo.projectionBackfill({ maxGroups: 2 });
      expect(execute("SELECT group_id,status,ledger_totals_ready FROM projection_state ORDER BY group_id").rows).toEqual([
        { group_id: 'group-1', status: 'ready', ledger_totals_ready: 1 },
        { group_id: 'group-2', status: 'ready', ledger_totals_ready: 1 },
      ]);
      const bulkCreated = await repo.createExpense('group-2', 'user-b', { ...bulkExpenseInput, description: 'Bulk expense created' });
      expect(bulkCreated.version).toBe(1);
      const bulkUpdated = await repo.updateExpense('bulk-expense', 'user-b', { ...bulkExpenseInput, version: 1 });
      expect(bulkUpdated.version).toBe(2);
      await expect(repo.deleteExpense('bulk-expense', 'user-b', bulkUpdated.version)).resolves.toBe(true);
      const bulkRestored = await repo.restoreExpense('bulk-expense', 'user-b', bulkUpdated.version + 1);
      expect(bulkRestored.version).toBe(4);
      expect(execute("SELECT COUNT(*) AS count FROM group_balance_projection WHERE group_id='group-2' AND person_id LIKE 'bulk-person-%'").rows).toEqual([{ count: 0 }]);
      const created = await repo.createExpense('group-1', 'user-a', {
        description: 'Incremental dinner', amount_minor: 100, currency: 'USD', date: '2026-01-03',
        payers: [{ person_id: 'person-a', amount_minor: 100 }], splits: [{ person_id: 'person-b', amount_minor: 100 }],
      });
      const updated = await repo.updateExpense(created.id, 'user-a', {
        description: 'Incremental dinner', amount_minor: 150, currency: 'EUR', date: '2026-01-03', version: created.version,
        payers: [{ person_id: 'person-b', amount_minor: 150 }], splits: [{ person_id: 'person-a', amount_minor: 150 }],
      });
      const settlement = await repo.createSettlement('group-1', 'user-a', {
        from_person_id: 'person-a', to_person_id: 'person-b', amount_minor: 40, currency: 'EUR', date: '2026-01-03',
      });
      await repo.deleteExpense(updated.id, 'user-a', updated.version);
      await repo.restoreExpense(updated.id, 'user-a', updated.version + 1);
      expect(settlement.amountMinor).toBe(40);
      expect(execute("SELECT currency,person_id,net_minor FROM group_balance_projection WHERE group_id='group-1' ORDER BY currency,person_id").rows).toEqual([
        { currency: 'EUR', person_id: 'person-a', net_minor: -110 },
        { currency: 'EUR', person_id: 'person-b', net_minor: 110 },
        { currency: 'USD', person_id: 'person-a', net_minor: 100 },
        { currency: 'USD', person_id: 'person-b', net_minor: -100 },
      ]);
      expect(execute("SELECT currency,gross_minor FROM ledger_totals WHERE group_id='group-1' ORDER BY currency").rows).toEqual([
        { currency: 'EUR', gross_minor: 190 }, { currency: 'USD', gross_minor: 100 },
      ]);
      expect(execute("SELECT mutation_count,reconciliation_due FROM projection_state WHERE group_id='group-1'").rows).toEqual([{ mutation_count: 5, reconciliation_due: 0 }]);

      const projectionBeforeRejected = execute("SELECT currency,person_id,net_minor FROM group_balance_projection WHERE group_id='group-1' ORDER BY currency,person_id").rows;
      await expect(repo.updateExpense(created.id, 'user-a', {
        description: 'Stale', amount_minor: 150, currency: 'EUR', date: '2026-01-03', version: 1,
        payers: [{ person_id: 'person-b', amount_minor: 150 }], splits: [{ person_id: 'person-a', amount_minor: 150 }],
      })).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(repo.updateExpense(created.id, 'user-a', {
        description: 'Removed participant', amount_minor: 150, currency: 'EUR', date: '2026-01-03', version: updated.version + 2,
        payers: [{ person_id: 'person-c', amount_minor: 150 }], splits: [{ person_id: 'person-a', amount_minor: 150 }],
      })).rejects.toMatchObject({ code: 'CONFLICT' });
      await execute("UPDATE group_members SET deleted_at='2026-01-04' WHERE group_id='group-1' AND user_id='user-a'");
      await expect(repo.updateExpense(created.id, 'user-a', {
        description: 'Lost actor', amount_minor: 150, currency: 'EUR', date: '2026-01-03', version: updated.version + 2,
        payers: [{ person_id: 'person-b', amount_minor: 150 }], splits: [{ person_id: 'person-a', amount_minor: 150 }],
      })).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(execute("SELECT currency,person_id,net_minor FROM group_balance_projection WHERE group_id='group-1' ORDER BY currency,person_id").rows).toEqual(projectionBeforeRejected);

      await expect(repo.groups('user-c')).resolves.toEqual([]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }, 600_000);
});
