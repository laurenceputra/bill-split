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

class LocalD1Statement {
  private args: unknown[] = [];

  constructor(private readonly sql: string, private readonly execute: (sql: string, args: unknown[]) => D1Row[]) {}

  bind(...args: unknown[]) {
    this.args = args;
    return this;
  }

  async all<T>() {
    return { results: this.execute(this.sql, this.args) as T[] };
  }

  async first<T>() {
    return (await this.all<T>()).results[0] ?? null;
  }
}

class LocalD1 {
  constructor(private readonly execute: (sql: string, args: unknown[]) => D1Row[]) {}

  prepare(sql: string) {
    return new LocalD1Statement(sql, this.execute);
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
      '0016_projection_readiness_reset.sql',
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
    `;

    const run = (args: string[]) => {
      const result = spawnSync(wrangler, args, { cwd: tempRoot, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(`Wrangler failed (${result.status}): ${result.stdout}\n${result.stderr}`);
      return result.stdout;
    };
    const execute = (sql: string, args: unknown[] = []) => {
      let index = 0;
      const boundSql = sql.replaceAll('?', () => {
        const value = args[index++];
        if (value == null) return 'NULL';
        if (typeof value === 'number') return String(value);
        return `'${String(value).replaceAll("'", "''")}'`;
      });
      if (index !== args.length) throw new Error(`Expected ${index} binds, received ${args.length}`);
      const output = run(['d1', 'execute', 'bill-split-summary', '--local', '--persist-to', persistDir, '--config', configPath, '--command', boundSql, '--yes', '--json']);
      const parsed = JSON.parse(output) as Array<{ results?: D1Row[] }>;
      return parsed.flatMap((result) => result.results ?? []);
    };
    const db = new LocalD1(execute);

    try {
      await mkdir(migrationsDir, { recursive: true });
      await Promise.all(migrationNames.map((name) => cp(join(root, 'migrations', name), join(migrationsDir, name))));
      await writeFile(configPath, `name = "bill-split-summary-test"\ncompatibility_date = "2025-08-01"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "bill-split-summary"\ndatabase_id = "00000000-0000-4000-8000-000000000003"\nmigrations_dir = "migrations"\n`);
      await writeFile(seedPath, seed);
      run(['d1', 'migrations', 'apply', 'bill-split-summary', '--local', '--persist-to', persistDir, '--config', configPath]);
      run(['d1', 'execute', 'bill-split-summary', '--local', '--persist-to', persistDir, '--config', configPath, '--file', seedPath]);

      const repo = new Repository(db as never);
      expect(execute("SELECT group_id,status FROM projection_state ORDER BY group_id")).toEqual([{ group_id: 'group-1', status: 'pending' }, { group_id: 'group-2', status: 'pending' }]);
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
      expect(execute("SELECT group_id,status FROM projection_state ORDER BY group_id")).toEqual([{ group_id: 'group-1', status: 'ready' }, { group_id: 'group-2', status: 'ready' }]);
      expect(execute("SELECT group_id,person_id,net_minor FROM group_balance_projection ORDER BY group_id,person_id")).toEqual([
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
      await expect(repo.groups('user-c')).resolves.toEqual([]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
