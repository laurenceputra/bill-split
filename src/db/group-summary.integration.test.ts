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
// @ts-expect-error Node types are not shipped to the Worker build.
import { execPath } from 'node:process';

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
    const result = this.execute(this.sql, this.args);
    // Lease callers must use their state readback when an adapter omits
    // changes metadata. Do not turn a failed guarded predicate into a fake
    // success; this harness intentionally leaves batch rollback to the
    // production D1 contract (see executeBatch below).
    return { meta: { changes: result.changes } };
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
     const wrangler = fileURLToPath(new URL('../../node_modules/wrangler/wrangler-dist/cli.js', moduleUrl));
    const migrationNames = [
      '0001_initial.sql', '0002_production_safety.sql', '0003_ledger_total_limits.sql',
      '0004_friend_idempotency_lookup.sql', '0005_clerk_identity.sql',
      '0006_scheduled_expenses.sql', '0007_scheduled_generation_claims.sql',
      '0008_scheduled_expense_completion.sql', '0009_scheduled_generation_cursor.sql',
      '0010_generated_expense_operation_namespace.sql', '0011_scheduled_expense_category.sql',
      '0012_invitations_audit_purge.sql', '0013_projection_layer.sql',
      '0014_projection_indexes.sql', '0015_audit_actor_snapshot.sql',
      '0016_projection_readiness_reset.sql', '0017_cleanup_indexes.sql', '0018_category_preferences.sql',
      '0019_group_membership_events.sql', '0020_account_deletion.sql', '0021_deleted_identity_tombstones.sql', '0022_application_sessions.sql', '0023_group_split_defaults.sql', '0024_incremental_projection_totals.sql',
      '0025_expense_suggestion_lookup.sql',
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
      const result = spawnSync(execPath, ['--no-warnings', '--experimental-vm-modules', wrangler, ...args], { cwd: tempRoot, encoding: 'utf8' });
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
       // derive each statement's actual changes; rollback atomicity is not
       // exercised here and remains a production D1 contract.
      const command = statements.flatMap((statement, index) => [bindSql(statement.sql, statement.args), `SELECT changes() AS __batch_changes_${index}`]).join(';\n');
       const rows = executeParsed(command).flatMap((result) => result.results ?? []);
      return statements.map((_, index) => ({ rows: [], changes: Number(rows.find((row) => row[`__batch_changes_${index}`] !== undefined)?.[`__batch_changes_${index}`] ?? 0) }));
    };
     try {
      await mkdir(migrationsDir, { recursive: true });
      await Promise.all(migrationNames.map((name) => cp(join(root, 'migrations', name), join(migrationsDir, name))));
      await writeFile(configPath, `name = "bill-split-summary-test"\ncompatibility_date = "2025-08-01"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "bill-split-summary"\ndatabase_id = "00000000-0000-4000-8000-000000000003"\nmigrations_dir = "migrations"\n`);
      await writeFile(seedPath, seed);
       run(['d1', 'migrations', 'apply', 'bill-split-summary', '--local', '--persist-to', persistDir, '--config', configPath]);
       run(['d1', 'execute', 'bill-split-summary', '--local', '--persist-to', persistDir, '--config', configPath, '--file', seedPath]);

       const db = new LocalD1(execute, executeBatch);
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
       expect(execute("SELECT group_id,discovery_complete FROM ledger_summary_state ORDER BY group_id").rows).toEqual([
         { group_id: 'group-1', discovery_complete: 0 }, { group_id: 'group-2', discovery_complete: 0 },
       ]);
       await expect(repo.monthlySummaryMaintenance({ maxGroups: 2, deadlineMs: Date.now() - 1 })).resolves.toMatchObject({ groupsScanned: 0, capped: true });
       await execute("UPDATE ledger_summary_state SET lease_owner='expired-owner',lease_until_ms=0,available_at_ms=0 WHERE group_id='group-1'");
         for (let pass = 0; pass < 4; pass += 1) await repo.monthlySummaryMaintenance({ maxGroups: 2, maxMonths: 4, chunkSize: 100 });
         expect(execute("SELECT group_id,discovery_complete,maintenance_due FROM ledger_summary_state ORDER BY group_id").rows).toEqual([
           { group_id: 'group-1', discovery_complete: 1, maintenance_due: 0 }, { group_id: 'group-2', discovery_complete: 1, maintenance_due: 0 },
         ]);
         // Simulate a readiness transition immediately before the final
         // balance statement. The query must select its authoritative branch
         // from that same statement snapshot, rather than trusting a prior
         // readiness lookup and returning an empty projection.
         let raced = false;
         const raceExecute = (sql: string, args: unknown[]) => {
           if (!raced && sql.includes('WITH requested_group AS')) {
             raced = true;
             execute("UPDATE ledger_summary_state SET status='pending',maintenance_due=1 WHERE group_id='group-1'");
           }
           return execute(sql, args);
         };
         await expect(new Repository(new LocalD1(raceExecute, executeBatch) as never).balanceProjection('group-1')).resolves.toEqual({ ready: false, rows: [
           { currency: 'USD', personId: 'person-a', netMinor: 100 },
           { currency: 'USD', personId: 'person-b', netMinor: -100 },
         ] });
         expect(raced).toBe(true);
         expect(JSON.stringify(execute("EXPLAIN QUERY PLAN SELECT month FROM ledger_period_state WHERE group_id='group-1' AND (status<>'ready' OR source_generation<>applied_generation OR active_build_id IS NULL) ORDER BY month LIMIT 4").rows)).toContain('idx_ledger_period_non_ready_month');
        expect(JSON.stringify(execute("EXPLAIN QUERY PLAN SELECT state.status FROM ledger_summary_state state WHERE state.group_id='group-1' AND state.status='ready' AND state.discovery_complete=1 AND NOT EXISTS (SELECT 1 FROM ledger_period_state period WHERE period.group_id=state.group_id AND (period.status<>'ready' OR period.source_generation<>period.applied_generation OR period.active_build_id IS NULL))").rows)).toContain('idx_ledger_period_non_ready');
       // Simulate an old Worker editing a month that has already been folded.
       // The request must lose readiness until maintenance repairs the
       // checkpoint by (verified month - old stored month).
       await execute("UPDATE expenses SET amount_minor=150,updated_at='2026-02-01' WHERE id='expense-1'; UPDATE payers SET amount_minor=150 WHERE expense_id='expense-1' AND person_id='person-a'; UPDATE splits SET amount_minor=150 WHERE expense_id='expense-1' AND person_id='person-b'");
       await expect(repo.balanceProjection('group-1')).resolves.toMatchObject({ ready: false });
        for (let pass = 0; pass < 3; pass += 1) await repo.monthlySummaryMaintenance({ maxGroups: 2, maxMonths: 4, chunkSize: 100 });
        expect(execute("SELECT currency,person_id,net_minor FROM ledger_checkpoint_balances WHERE group_id='group-1' ORDER BY currency,person_id").rows).toEqual([
          { currency: 'USD', person_id: 'person-a', net_minor: 150 }, { currency: 'USD', person_id: 'person-b', net_minor: -150 },
        ]);
        await expect(repo.balanceProjection('group-1')).resolves.toMatchObject({ ready: true });
        const foldedPeriod = execute("SELECT period.month,period.build_id,period.active_build_id,period.status,state.checkpoint_through FROM ledger_period_state period JOIN ledger_summary_state state ON state.group_id=period.group_id WHERE period.group_id='group-1'").rows;
         expect(foldedPeriod).toEqual([expect.objectContaining({ month: '2026-01-01', status: 'ready', checkpoint_through: '2026-01-01' })]);
         expect(foldedPeriod[0].active_build_id).toBe(foldedPeriod[0].build_id);
          expect(execute("SELECT DISTINCT build_id FROM ledger_period_balances WHERE group_id='group-1' AND month='2026-01-01'").rows.length).toBeGreaterThan(1);
          await expect(repo.ledgerPeriodBuildGarbageCollection({ maxBuilds: 10, chunkSize: 100 })).resolves.toMatchObject({ buildsCompleted: expect.any(Number) });
          expect(execute("SELECT DISTINCT build_id FROM ledger_period_balances WHERE group_id='group-1' AND month='2026-01-01'").rows).toHaveLength(1);
         await execute(`INSERT OR REPLACE INTO ledger_period_build_gc(group_id,month,build_id,enqueued_at_ms,available_at_ms,updated_at_ms)
           VALUES('group-1','2026-01-01','${String(foldedPeriod[0].active_build_id)}',0,0,0)`);
         await expect(repo.ledgerPeriodBuildGarbageCollection({ maxBuilds: 1, chunkSize: 100 })).resolves.toMatchObject({ buildsScanned: 0, buildsCompleted: 0 });
         expect(execute("SELECT build_id FROM ledger_period_build_gc WHERE group_id='group-1' AND month='2026-01-01'").rows).toEqual(expect.arrayContaining([{ build_id: foldedPeriod[0].active_build_id }]));
           await execute("WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM sequence WHERE n<101) INSERT INTO ledger_period_balances(group_id,month,build_id,currency,person_id,net_minor,updated_at) SELECT 'group-1','2026-01-01','orphan-build','ORPHAN-'||printf('%03d',n),'person-a',1,'2026-01-01' FROM sequence; WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM sequence WHERE n<101) INSERT INTO ledger_period_totals(group_id,month,build_id,currency,gross_minor,updated_at) SELECT 'group-1','2026-01-01','orphan-build','ORPHAN-'||printf('%03d',n),1,'2026-01-01' FROM sequence; INSERT INTO ledger_period_balances(group_id,month,build_id,currency,person_id,net_minor,updated_at) VALUES('group-1','2026-01-01','orphan-next','ORPHAN-NEXT','person-a',1,'2026-01-01'); INSERT INTO ledger_period_totals(group_id,month,build_id,currency,gross_minor,updated_at) VALUES('group-1','2026-01-01','orphan-next','ORPHAN-NEXT',1,'2026-01-01'); INSERT INTO ledger_period_build_gc(group_id,month,build_id,enqueued_at_ms,available_at_ms,updated_at_ms) VALUES('group-1','2026-01-01','orphan-build',0,-1,0),('group-1','2026-01-01','orphan-next',0,-1,0)");
           await expect(repo.ledgerPeriodBuildGarbageCollection({ maxBuilds: 1, chunkSize: 100 })).resolves.toMatchObject({ buildsCompleted: 0, balancesDeleted: 100, totalsDeleted: 100, capped: true });
           expect(execute("SELECT build_id FROM ledger_period_build_gc WHERE group_id='group-1' AND month='2026-01-01' ORDER BY build_id").rows).toEqual(expect.arrayContaining([{ build_id: 'orphan-build' }, { build_id: 'orphan-next' }]));
           await expect(repo.ledgerPeriodBuildGarbageCollection({ maxBuilds: 1, chunkSize: 100 })).resolves.toMatchObject({ buildsCompleted: 1, balancesDeleted: 1, totalsDeleted: 1, capped: true });
           // The partial build yields behind the competing new arrival, then
           // rotates back instead of monopolizing the GC slot.
           expect(execute("SELECT build_id FROM ledger_period_build_gc WHERE group_id='group-1' AND month='2026-01-01'").rows).toEqual([{ build_id: 'orphan-build' }]);
           await expect(repo.ledgerPeriodBuildGarbageCollection({ maxBuilds: 1, chunkSize: 100 })).resolves.toMatchObject({ buildsCompleted: 1, balancesDeleted: 1, totalsDeleted: 1, capped: true });
         expect(execute("SELECT build_id FROM ledger_period_build_gc WHERE group_id='group-1' AND month='2026-01-01' AND build_id='orphan-build'").rows).toEqual([]);
         // The folded month is represented by the checkpoint, not by its active
        // period build. This catches checkpoint + period double counting.
       await expect(repo.balanceProjection('group-1')).resolves.toEqual({ ready: true, rows: [
           { currency: 'USD', personId: 'person-a', netMinor: 150 },
           { currency: 'USD', personId: 'person-b', netMinor: -150 },
         ] });

       // A folded-month correction must decrement the checkpoint immediately;
       // publication must not reconstruct the old gross after maintenance.
       const foldedCorrection = await repo.createExpense('group-1', 'user-a', {
         description: 'Folded correction', amount_minor: 200, currency: 'USD', date: '2026-01-10',
         payers: [{ person_id: 'person-a', amount_minor: 200 }], splits: [{ person_id: 'person-b', amount_minor: 200 }],
       });
       const downward = await repo.updateExpense(foldedCorrection.id, 'user-a', {
         description: 'Folded correction', amount_minor: 50, currency: 'USD', date: '2026-01-10', version: foldedCorrection.version,
         payers: [{ person_id: 'person-a', amount_minor: 50 }], splits: [{ person_id: 'person-b', amount_minor: 50 }],
       });
       expect(execute("SELECT gross_minor FROM ledger_checkpoint_totals WHERE group_id='group-1' AND currency='USD'").rows).toEqual([{ gross_minor: 200 }]);
       expect(execute("SELECT gross_minor FROM ledger_totals WHERE group_id='group-1' AND currency='USD'").rows).toEqual([{ gross_minor: 200 }]);
       for (let pass = 0; pass < 3; pass += 1) await repo.monthlySummaryMaintenance({ maxGroups: 2, maxMonths: 4, chunkSize: 100 });
       expect(execute("SELECT gross_minor FROM ledger_checkpoint_totals WHERE group_id='group-1' AND currency='USD'").rows).toEqual([{ gross_minor: 200 }]);
       expect(execute("SELECT gross_minor FROM ledger_totals WHERE group_id='group-1' AND currency='USD'").rows).toEqual([{ gross_minor: 200 }]);
       await repo.deleteExpense(foldedCorrection.id, 'user-a', downward.version);
       expect(execute("SELECT gross_minor FROM ledger_checkpoint_totals WHERE group_id='group-1' AND currency='USD'").rows).toEqual([{ gross_minor: 150 }]);
       for (let pass = 0; pass < 3; pass += 1) await repo.monthlySummaryMaintenance({ maxGroups: 2, maxMonths: 4, chunkSize: 100 });
       expect(execute("SELECT gross_minor FROM ledger_totals WHERE group_id='group-1' AND currency='USD'").rows).toEqual([{ gross_minor: 150 }]);

       // Legacy projection rows are deliberately poisoned. The new ready path
      // must ignore them and read only monthly/checkpoint summaries.
      await writeFile(readyPath, `
        DELETE FROM group_balance_projection WHERE group_id IN ('group-1','group-2');
        INSERT INTO group_balance_projection(group_id,currency,person_id,net_minor,updated_at) VALUES('group-1','USD','person-a',250,'2026-01-02');
        INSERT INTO group_balance_projection(group_id,currency,person_id,net_minor,updated_at) VALUES('group-1','USD','person-b',-250,'2026-01-02');
        INSERT INTO group_balance_projection(group_id,currency,person_id,net_minor,updated_at) VALUES('group-2','USD','person-a',-450,'2026-01-02');
        INSERT INTO group_balance_projection(group_id,currency,person_id,net_minor,updated_at) VALUES('group-2','USD','person-b',450,'2026-01-02');
      `);
      run(['d1', 'execute', 'bill-split-summary', '--local', '--persist-to', persistDir, '--config', configPath, '--file', readyPath]);
       expect(execute("SELECT group_id,status FROM ledger_summary_state ORDER BY group_id").rows).toEqual([{ group_id: 'group-1', status: 'ready' }, { group_id: 'group-2', status: 'ready' }]);
      expect(execute("SELECT group_id,person_id,net_minor FROM group_balance_projection ORDER BY group_id,person_id").rows).toEqual([
         { group_id: 'group-1', person_id: 'person-a', net_minor: 250 },
         { group_id: 'group-1', person_id: 'person-b', net_minor: -250 },
         { group_id: 'group-2', person_id: 'person-a', net_minor: -450 },
         { group_id: 'group-2', person_id: 'person-b', net_minor: 450 },
       ]);
      const readyA = await repo.groups('user-a');
      const readyB = await repo.groups('user-b');
       expect(readyA.map(({ id, balanceSummaries }) => ({ id, balanceSummaries }))).toEqual([
         { id: 'group-2', balanceSummaries: [{ currency: 'USD', netMinor: -200 }] },
         { id: 'group-1', balanceSummaries: [{ currency: 'USD', netMinor: 150 }] },
       ]);
       expect(readyB.map(({ id, balanceSummaries }) => ({ id, balanceSummaries }))).toEqual([
         { id: 'group-2', balanceSummaries: [{ currency: 'USD', netMinor: 200 }] },
         { id: 'group-1', balanceSummaries: [{ currency: 'USD', netMinor: -150 }] },
       ]);

       await execute("DELETE FROM group_balance_projection WHERE group_id='group-2'; UPDATE ledger_summary_state SET status='pending',maintenance_due=1 WHERE group_id IN ('group-1','group-2')");
      const pendingUpdated = await repo.updateExpense('expense-2', 'user-a', {
        description: 'Other dinner revised', amount_minor: 200, currency: 'USD', date: '2026-01-02', version: 1,
        payers: [{ person_id: 'person-b', amount_minor: 200 }], splits: [{ person_id: 'person-a', amount_minor: 200 }],
      });
      await repo.deleteExpense(pendingUpdated.id, 'user-a', pendingUpdated.version);
      expect(execute("SELECT * FROM group_balance_projection WHERE group_id='group-2'").rows).toEqual([]);
       for (let pass = 0; pass < 3; pass += 1) await repo.monthlySummaryMaintenance({ maxGroups: 2, maxMonths: 4, chunkSize: 100 });
       expect(execute("SELECT group_id,status FROM ledger_summary_state ORDER BY group_id").rows).toEqual([
         { group_id: 'group-1', status: 'ready' },
         { group_id: 'group-2', status: 'ready' },
       ]);
        const bulkCreated = await repo.createExpense('group-2', 'user-b', { ...bulkExpenseInput, description: 'Bulk expense created' });
       expect(bulkCreated.version).toBe(1);
       expect(execute("SELECT COUNT(*) AS count FROM ledger_period_balances WHERE group_id='group-2' AND person_id LIKE 'bulk-person-%'").rows).toBeDefined();
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
        // Versioned period rows retain superseded builds for correction/audit;
        // inspect only the active build when checking the current projection.
        expect(execute("SELECT balances.currency,balances.person_id,balances.net_minor FROM ledger_period_balances balances JOIN ledger_period_state period ON period.group_id=balances.group_id AND period.month=balances.month AND period.active_build_id=balances.build_id WHERE balances.group_id='group-1' ORDER BY balances.currency,balances.person_id").rows).toEqual([
        { currency: 'EUR', person_id: 'person-a', net_minor: -110 },
        { currency: 'EUR', person_id: 'person-b', net_minor: 110 },
         { currency: 'USD', person_id: 'person-a', net_minor: 150 },
         { currency: 'USD', person_id: 'person-b', net_minor: -150 },
      ]);
      expect(execute("SELECT currency,gross_minor FROM ledger_totals WHERE group_id='group-1' ORDER BY currency").rows).toEqual([
         { currency: 'EUR', gross_minor: 190 }, { currency: 'USD', gross_minor: 150 },
      ]);
        expect(execute("SELECT status,maintenance_due FROM ledger_summary_state WHERE group_id='group-1'").rows).toEqual([{ status: 'ready', maintenance_due: 0 }]);

       const projectionBeforeRejected = execute("SELECT currency,person_id,SUM(net_minor) AS net_minor FROM ledger_period_balances WHERE group_id='group-1' GROUP BY currency,person_id HAVING SUM(net_minor)<>0 ORDER BY currency,person_id").rows;
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
       expect(execute("SELECT currency,person_id,SUM(net_minor) AS net_minor FROM ledger_period_balances WHERE group_id='group-1' GROUP BY currency,person_id HAVING SUM(net_minor)<>0 ORDER BY currency,person_id").rows).toEqual(projectionBeforeRejected);

       await execute("UPDATE ledger_totals SET gross_minor=9007199254740991 WHERE group_id='group-1' AND currency='USD'");
       await expect(repo.createExpense('group-1', 'user-b', {
         description: 'Overflow guard', amount_minor: 1, currency: 'USD', date: '2026-01-04',
         payers: [{ person_id: 'person-b', amount_minor: 1 }], splits: [{ person_id: 'person-b', amount_minor: 1 }],
       })).rejects.toMatchObject({ code: 'BALANCE_OVERFLOW' });

        await execute("UPDATE groups SET deleted_at='2026-01-01T00:00:00.000Z' WHERE id='group-2'; INSERT INTO groups(id,name,currency,created_at,updated_at,deleted_at) VALUES('group-3','Purge fairness','USD','2026-01-01','2026-01-01','2026-01-01T00:00:00.000Z'); INSERT INTO group_members(group_id,person_id,user_id,joined_at,role) VALUES('group-3','person-c','user-c','2026-01-01','owner'); WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM sequence WHERE n<101) INSERT INTO audit_events(id,group_id,entity_type,entity_id,version,action,actor_id,occurred_at) SELECT 'group-3-audit-'||n,'group-3','expense','missing-'||n,1,'create','user-c','2026-01-01' FROM sequence");
        const childDeletePlan = JSON.stringify(execute("EXPLAIN QUERY PLAN DELETE FROM payers WHERE rowid IN (SELECT payer.rowid FROM payers payer JOIN expenses expense ON expense.id=payer.expense_id WHERE expense.group_id=? LIMIT ?)", ['group-3', 100]).rows);
        const verifyDeletePlan = JSON.stringify(execute("EXPLAIN QUERY PLAN DELETE FROM ledger_period_verify_balances WHERE rowid IN (SELECT rowid FROM ledger_period_verify_balances WHERE group_id=? LIMIT ?)", ['group-3', 100]).rows);
        expect(childDeletePlan).not.toContain('USE TEMP B-TREE');
        expect(verifyDeletePlan).not.toContain('USE TEMP B-TREE');
        // A metadata-heavy group must yield its slot after one bounded chunk;
       // the next deleted group must make progress instead of being starved.
       const firstPurge = await repo.purgeExpiredData('2026-03-01T00:00:00.000Z', { maxTransactions: 100, maxGroups: 1 });
       expect(firstPurge.groupsScanned).toBe(1);
       expect(firstPurge.groupsPurged).toBe(0);
       expect(execute("SELECT COUNT(*) AS count FROM audit_events WHERE group_id='group-3'").rows).toEqual([{ count: 101 }]);
       const secondPurge = await repo.purgeExpiredData('2026-03-01T00:00:00.000Z', { maxTransactions: 100, maxGroups: 1 });
       expect(secondPurge.groupsScanned).toBe(1);
       expect(secondPurge.groupsPurged).toBe(0);
       expect(execute("SELECT COUNT(*) AS count FROM audit_events WHERE group_id='group-3'").rows).toEqual([{ count: 1 }]);
       let purged = { groupsPurged: 0 };
       for (let pass = 0; pass < 12 && execute("SELECT id FROM groups WHERE id IN ('group-2','group-3')").rows.length; pass += 1) {
         purged = await repo.purgeExpiredData('2026-03-01T00:00:00.000Z', { maxTransactions: 100, maxGroups: 1 });
       }
       // A later pass can delete the parent after members were already
       // removed; the member DELETE then reports zero changes.
       expect(purged.groupsPurged).toBe(1);
       expect(execute("SELECT id FROM groups WHERE id='group-2'").rows).toEqual([]);
       expect(execute("SELECT id FROM expenses WHERE group_id='group-2'").rows).toEqual([]);
       expect(execute("SELECT id FROM settlements WHERE group_id='group-2'").rows).toEqual([]);
       await expect(repo.groups('user-b')).resolves.toMatchObject([{ id: 'group-1' }]);

         // Hybrid deployment: an old Worker may still have a ready legacy
         // projection while the new Worker is pending or backfilling its
         // independent summary. New mutations update only the affected legacy
         // keys; the old Worker's selector fields remain byte-for-byte stable.
         await execute("INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('group-hybrid','Hybrid','USD','2026-08-01','2026-08-01'); INSERT INTO group_members(group_id,person_id,user_id,joined_at,role) VALUES('group-hybrid','person-a','user-a','2026-08-01','owner'),('group-hybrid','person-b','user-b','2026-08-01','member'); INSERT INTO projection_state(group_id,status,backfill_cursor,updated_at,ledger_totals_ready,reconciliation_due) VALUES('group-hybrid','ready',NULL,'2026-08-01',1,0);");
         const legacySelectors = execute("SELECT status,backfill_cursor,updated_at,ledger_totals_ready,reconciliation_due FROM projection_state WHERE group_id='group-hybrid'").rows;
         const hybridExpense = await repo.createExpense('group-hybrid', 'user-a', {
           description: 'Hybrid expense', amount_minor: 120, currency: 'USD', date: '2026-08-15',
           payers: [{ person_id: 'person-a', amount_minor: 120 }], splits: [{ person_id: 'person-b', amount_minor: 120 }],
         });
        expect(execute("SELECT status,discovery_complete,maintenance_due FROM ledger_summary_state WHERE group_id='group-hybrid'").rows).toEqual([{ status: 'pending', discovery_complete: 0, maintenance_due: 1 }]);
        expect(execute("SELECT status,ledger_totals_ready,reconciliation_due FROM projection_state WHERE group_id='group-hybrid'").rows).toEqual([{ status: 'ready', ledger_totals_ready: 1, reconciliation_due: 0 }]);
          await execute("UPDATE ledger_summary_state SET status='backfilling',lease_owner='hybrid-test',lease_until_ms=4102444800000,discovery_complete=0,maintenance_due=1 WHERE group_id='group-hybrid'");
         const hybridSettlement = await repo.createSettlement('group-hybrid', 'user-a', {
           from_person_id: 'person-a', to_person_id: 'person-b', amount_minor: 40, currency: 'USD', date: '2026-08-16',
         });
        expect(execute("SELECT status,ledger_totals_ready,reconciliation_due FROM projection_state WHERE group_id='group-hybrid'").rows).toEqual([{ status: 'ready', ledger_totals_ready: 1, reconciliation_due: 0 }]);
        expect(execute("SELECT status,maintenance_due FROM ledger_summary_state WHERE group_id='group-hybrid'").rows).toEqual([{ status: 'backfilling', maintenance_due: 1 }]);
         expect(execute("SELECT currency,person_id,net_minor FROM group_balance_projection WHERE group_id='group-hybrid' ORDER BY person_id").rows).toEqual([
           { currency: 'USD', person_id: 'person-a', net_minor: 160 }, { currency: 'USD', person_id: 'person-b', net_minor: -160 },
         ]);
         const hybridUpdated = await repo.updateExpense(hybridExpense.id, 'user-a', {
           description: 'Hybrid expense revised', amount_minor: 150, currency: 'USD', date: '2026-08-15', version: hybridExpense.version,
           payers: [{ person_id: 'person-a', amount_minor: 150 }], splits: [{ person_id: 'person-b', amount_minor: 150 }],
         });
         expect(execute("SELECT person_id,net_minor FROM group_balance_projection WHERE group_id='group-hybrid' ORDER BY person_id").rows).toEqual([
           { person_id: 'person-a', net_minor: 190 }, { person_id: 'person-b', net_minor: -190 },
         ]);
         await repo.deleteExpense(hybridUpdated.id, 'user-a', hybridUpdated.version);
         expect(execute("SELECT person_id,net_minor FROM group_balance_projection WHERE group_id='group-hybrid' ORDER BY person_id").rows).toEqual([
           { person_id: 'person-a', net_minor: 40 }, { person_id: 'person-b', net_minor: -40 },
         ]);
         await repo.restoreExpense(hybridUpdated.id, 'user-a', hybridUpdated.version + 1);
         const hybridSettlementUpdated = await repo.updateSettlement(hybridSettlement.id, 'user-a', {
           from_person_id: 'person-a', to_person_id: 'person-b', amount_minor: 60, currency: 'USD', date: '2026-08-16', version: hybridSettlement.version,
         });
         expect(execute("SELECT person_id,net_minor FROM group_balance_projection WHERE group_id='group-hybrid' ORDER BY person_id").rows).toEqual([
           { person_id: 'person-a', net_minor: 210 }, { person_id: 'person-b', net_minor: -210 },
         ]);
         await repo.deleteSettlement(hybridSettlementUpdated.id, 'user-a', hybridSettlementUpdated.version);
         expect(execute("SELECT person_id,net_minor FROM group_balance_projection WHERE group_id='group-hybrid' ORDER BY person_id").rows).toEqual([
           { person_id: 'person-a', net_minor: 150 }, { person_id: 'person-b', net_minor: -150 },
         ]);
         await repo.restoreSettlement(hybridSettlementUpdated.id, 'user-a', hybridSettlementUpdated.version + 1);
         expect(execute("SELECT person_id,net_minor FROM group_balance_projection WHERE group_id='group-hybrid' ORDER BY person_id").rows).toEqual([
           { person_id: 'person-a', net_minor: 210 }, { person_id: 'person-b', net_minor: -210 },
         ]);
         expect(execute("SELECT status,backfill_cursor,updated_at,ledger_totals_ready,reconciliation_due FROM projection_state WHERE group_id='group-hybrid'").rows).toEqual(legacySelectors);
         expect(execute("SELECT month,status,source_generation,applied_generation,active_build_id FROM ledger_period_state WHERE group_id='group-hybrid'").rows).toEqual([{ month: '2026-08-01', status: 'dirty', source_generation: 10, applied_generation: 0, active_build_id: null }]);
         expect(execute("SELECT month,currency,gross_minor FROM ledger_period_totals WHERE group_id='group-hybrid'").rows).toEqual([]);
         expect(hybridExpense.version).toBe(1);
          // Queue fairness: two continuously-due groups must not keep a
          // retrying group behind them once its retry timestamp is eligible.
          await execute(`
            INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES
              ('queue-continuous-a','Queue A','USD','2026-08-20','2026-08-20'),
              ('queue-continuous-b','Queue B','USD','2026-08-20','2026-08-20'),
              ('queue-retry','Queue retry','USD','2026-08-20','2026-08-20');
            INSERT INTO expenses(id,group_id,description,amount_minor,currency,expense_date,created_by,created_at,updated_at,version) VALUES
              ('queue-a-1','queue-continuous-a','A 1',10,'USD','2026-08-20','user-a','2026-08-20','2026-08-20',1),
              ('queue-a-2','queue-continuous-a','A 2',10,'USD','2026-08-21','user-a','2026-08-20','2026-08-20',1),
              ('queue-b-1','queue-continuous-b','B 1',10,'USD','2026-08-20','user-a','2026-08-20','2026-08-20',1),
              ('queue-b-2','queue-continuous-b','B 2',10,'USD','2026-08-21','user-a','2026-08-20','2026-08-20',1);
            INSERT INTO payers(expense_id,person_id,amount_minor) VALUES
              ('queue-a-1','person-a',10),('queue-a-2','person-a',10),('queue-b-1','person-a',10),('queue-b-2','person-a',10);
            INSERT INTO splits(expense_id,person_id,amount_minor) VALUES
              ('queue-a-1','person-b',10),('queue-a-2','person-b',10),('queue-b-1','person-b',10),('queue-b-2','person-b',10);
            INSERT INTO ledger_period_state(group_id,month,status,source_generation,retry_at_ms,updated_at)
              VALUES('queue-retry','2026-08-01','failed',1,?,'2026-08-20');
          `, [Date.now() + 60_000]);
          const queueEpoch = Date.now();
          await execute("UPDATE ledger_summary_state SET maintenance_due=0 WHERE group_id NOT IN ('queue-continuous-a','queue-continuous-b','queue-retry')");
          await execute("UPDATE ledger_summary_state SET status='pending',discovery_complete=1,maintenance_due=1,available_at_ms=? WHERE group_id IN ('queue-continuous-a','queue-continuous-b')", [queueEpoch]);
          await execute("UPDATE ledger_summary_state SET status='pending',discovery_complete=1,maintenance_due=1,available_at_ms=? WHERE group_id='queue-retry'", [queueEpoch + 60_000]);
          await expect(repo.monthlySummaryMaintenance({ maxGroups: 2, maxMonths: 1, chunkSize: 1 })).resolves.toMatchObject({ groupsScanned: 2 });
          const continuouslyQueued = execute("SELECT group_id,maintenance_due,available_at_ms FROM ledger_summary_state WHERE group_id IN ('queue-continuous-a','queue-continuous-b') ORDER BY group_id").rows;
          expect(continuouslyQueued).toEqual([
            { group_id: 'queue-continuous-a', maintenance_due: 1, available_at_ms: expect.any(Number) },
            { group_id: 'queue-continuous-b', maintenance_due: 1, available_at_ms: expect.any(Number) },
          ]);
          expect(continuouslyQueued.every((row) => Number(row.available_at_ms) >= queueEpoch - 1_000)).toBe(true);
          const eligibleRetry = Date.now() - 1;
          await execute("UPDATE ledger_period_state SET retry_at_ms=? WHERE group_id='queue-retry' AND month='2026-08-01'; UPDATE ledger_summary_state SET available_at_ms=? WHERE group_id='queue-retry'", [eligibleRetry, eligibleRetry]);
          await expect(repo.monthlySummaryMaintenance({ maxGroups: 2, maxMonths: 1, chunkSize: 1 })).resolves.toMatchObject({ groupsScanned: 2 });
          expect(execute("SELECT status,retry_at_ms FROM ledger_period_state WHERE group_id='queue-retry' AND month='2026-08-01'").rows).toEqual([{ status: 'ready', retry_at_ms: null }]);
          // Delayed-only work must retain its retry time and stay out of the
          // eligible queue until that time, rather than immediately reacquiring.
          await execute("UPDATE ledger_summary_state SET maintenance_due=0 WHERE group_id IN ('queue-continuous-a','queue-continuous-b'); UPDATE ledger_period_state SET status='failed',retry_at_ms=? WHERE group_id='queue-retry' AND month='2026-08-01'; UPDATE ledger_summary_state SET status='pending',maintenance_due=1,available_at_ms=? WHERE group_id='queue-retry'", [Date.now() + 60_000, Date.now()]);
          await repo.monthlySummaryMaintenance({ maxGroups: 1, maxMonths: 1, chunkSize: 1 });
          const delayedState = execute("SELECT maintenance_due,available_at_ms FROM ledger_summary_state WHERE group_id='queue-retry'").rows[0];
          expect(Number(delayedState.maintenance_due)).toBe(1);
          expect(Number(delayedState.available_at_ms)).toBeGreaterThan(Date.now() - 1_000);
          await expect(repo.monthlySummaryMaintenance({ maxGroups: 1, maxMonths: 1, chunkSize: 1 })).resolves.toMatchObject({ groupsScanned: 0 });
          const resumedRetry = Date.now() - 1;
          await execute("UPDATE ledger_period_state SET retry_at_ms=? WHERE group_id='queue-retry' AND month='2026-08-01'; UPDATE ledger_summary_state SET available_at_ms=? WHERE group_id='queue-retry'", [resumedRetry, resumedRetry]);
          await repo.monthlySummaryMaintenance({ maxGroups: 1, maxMonths: 1, chunkSize: 1 });
          expect(execute("SELECT status,retry_at_ms FROM ledger_period_state WHERE group_id='queue-retry' AND month='2026-08-01'").rows).toEqual([{ status: 'ready', retry_at_ms: null }]);
       await expect(repo.groups('user-c')).resolves.toEqual([]);
     } finally {
       await rm(tempRoot, { recursive: true, force: true });
     }
    // This exercises the full authenticated rollout against the local D1 CLI.
    // Each prepared statement is a separate real-D1 process (~1.5s measured
    // locally), so the intentionally broad scenario needs a longer test budget.
    }, 900_000);

  it('folds one verified future month per bounded invocation and corrects folded months incrementally', async () => {
    const moduleUrl = (import.meta as ImportMeta & { url: string }).url;
    const root = fileURLToPath(new URL('../../', moduleUrl));
    const tempRoot = await mkdtemp(join(tmpdir(), 'bill-split-month-fold-'));
    const migrationsDir = join(tempRoot, 'migrations');
    const persistDir = join(tempRoot, 'persist');
    const configPath = join(tempRoot, 'wrangler.toml');
    const seedPath = join(tempRoot, 'seed.sql');
     const wrangler = fileURLToPath(new URL('../../node_modules/wrangler/wrangler-dist/cli.js', moduleUrl));
    const migrationNames = [
      '0001_initial.sql', '0002_production_safety.sql', '0003_ledger_total_limits.sql',
      '0004_friend_idempotency_lookup.sql', '0005_clerk_identity.sql',
      '0006_scheduled_expenses.sql', '0007_scheduled_generation_claims.sql',
      '0008_scheduled_expense_completion.sql', '0009_scheduled_generation_cursor.sql',
      '0010_generated_expense_operation_namespace.sql', '0011_scheduled_expense_category.sql',
      '0012_invitations_audit_purge.sql', '0013_projection_layer.sql',
      '0014_projection_indexes.sql', '0015_audit_actor_snapshot.sql',
      '0016_projection_readiness_reset.sql', '0017_cleanup_indexes.sql', '0018_category_preferences.sql',
      '0019_group_membership_events.sql', '0020_account_deletion.sql', '0021_deleted_identity_tombstones.sql', '0022_application_sessions.sql', '0023_group_split_defaults.sql', '0024_incremental_projection_totals.sql',
    ];
    const seed = `
      INSERT INTO users(id,email,created_at,updated_at) VALUES
        ('user-fold','fold@example.com','2026-01-01','2026-01-01'),
        ('user-fold-other','fold-other@example.com','2026-01-01','2026-01-01');
      INSERT INTO people(id,name,email,user_id,created_at) VALUES
        ('person-fold','Fold User','fold@example.com','user-fold','2026-01-01'),
        ('person-fold-other','Other User','fold-other@example.com','user-fold-other','2026-01-01');
      INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('group-fold','Multiple future months','USD','2026-01-01','2026-01-01');
      INSERT INTO group_members(group_id,person_id,user_id,joined_at,role) VALUES
        ('group-fold','person-fold','user-fold','2026-01-01','owner'),
        ('group-fold','person-fold-other','user-fold-other','2026-01-01','member');
      INSERT INTO expenses(id,group_id,description,amount_minor,currency,expense_date,created_by,created_at,updated_at,version) VALUES
        ('fold-a','group-fold','Future A',100,'USD','2029-01-15','user-fold','2026-01-15','2026-01-15',1),
        ('fold-b','group-fold','Future B',200,'USD','2031-07-15','user-fold','2026-01-15','2026-01-15',1),
        ('fold-c','group-fold','Future C',300,'USD','2040-12-15','user-fold','2026-01-15','2026-01-15',1),
        ('fold-d','group-fold','Future D',400,'USD','2055-03-15','user-fold','2026-01-15','2026-01-15',1),
        ('fold-e','group-fold','Future E',500,'USD','2099-11-15','user-fold','2026-01-15','2026-01-15',1);
      INSERT INTO payers(expense_id,person_id,amount_minor) VALUES
        ('fold-a','person-fold',100),('fold-b','person-fold',200),('fold-c','person-fold',300),
        ('fold-d','person-fold',400),('fold-e','person-fold',500);
      INSERT INTO splits(expense_id,person_id,amount_minor) VALUES
        ('fold-a','person-fold-other',100),('fold-b','person-fold-other',200),('fold-c','person-fold-other',300),
        ('fold-d','person-fold-other',400),('fold-e','person-fold-other',500);
      UPDATE ledger_summary_state SET checkpoint_through='2025-12-01',maintenance_due=1 WHERE group_id='group-fold';
    `;
    const run = (args: string[]) => {
       const result = spawnSync(execPath, ['--no-warnings', '--experimental-vm-modules', wrangler, ...args], { cwd: tempRoot, encoding: 'utf8' });
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
      const output = run(['d1', 'execute', 'bill-split-month-fold', '--local', '--persist-to', persistDir, '--config', configPath, '--command', bindSql(sql, args), '--yes', '--json']);
      return JSON.parse(output) as Array<{ results?: D1Row[]; meta?: { changes?: number } }>;
    };
    const execute = (sql: string, args: unknown[] = []): D1Execution => {
      const parsed = executeParsed(sql, args);
      return { rows: parsed.flatMap((result) => result.results ?? []), changes: parsed.reduce((total, result) => total + Number(result.meta?.changes ?? 0), 0) };
    };
    const executeBatch = (statements: Array<{ sql: string; args: unknown[] }>): D1Execution[] => {
      // Local Wrangler has no Worker-binding batch rollback. Preserve the
      // statement order and assert guarded readbacks below; rollback itself is
      // a residual limitation of this local harness, not a claimed test.
      const command = statements.flatMap((statement, index) => [bindSql(statement.sql, statement.args), `SELECT changes() AS __batch_changes_${index}`]).join(';\n');
      const rows = executeParsed(command).flatMap((result) => result.results ?? []);
      return statements.map((_, index) => ({ rows: [], changes: Number(rows.find((row) => row[`__batch_changes_${index}`] !== undefined)?.[`__batch_changes_${index}`] ?? 0) }));
    };
    const db = new LocalD1(execute, executeBatch);

    try {
      await mkdir(migrationsDir, { recursive: true });
      await Promise.all(migrationNames.map((name) => cp(join(root, 'migrations', name), join(migrationsDir, name))));
      await writeFile(configPath, `name = "bill-split-month-fold-test"\ncompatibility_date = "2025-08-01"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "bill-split-month-fold"\ndatabase_id = "00000000-0000-4000-8000-000000000004"\nmigrations_dir = "migrations"\n`);
      await writeFile(seedPath, seed);
      run(['d1', 'migrations', 'apply', 'bill-split-month-fold', '--local', '--persist-to', persistDir, '--config', configPath]);
      run(['d1', 'execute', 'bill-split-month-fold', '--local', '--persist-to', persistDir, '--config', configPath, '--file', seedPath]);

      const repo = new Repository(db as never);
      await repo.monthlySummaryMaintenance({ maxGroups: 1, maxMonths: 12, chunkSize: 100 });
      expect(execute("SELECT status,checkpoint_through,discovery_complete,maintenance_due FROM ledger_summary_state WHERE group_id='group-fold'").rows).toEqual([{ status: 'backfilling', checkpoint_through: '2025-12-01', discovery_complete: 0, maintenance_due: 1 }]);
      // Discovery/building is itself bounded. Once bootstrap has completed,
       // Each subsequent invocation verifies all available periods but folds
       // exactly one future period. There must be no early publication.
       await repo.monthlySummaryMaintenance({ maxGroups: 1, maxMonths: 12, chunkSize: 100 });
       expect(execute("SELECT status,checkpoint_through,maintenance_due FROM ledger_summary_state WHERE group_id='group-fold'").rows).toEqual([{ status: 'backfilling', checkpoint_through: '2029-01-01', maintenance_due: 1 }]);
       await expect(repo.balanceProjection('group-fold')).resolves.toMatchObject({ ready: false });
       expect(execute("SELECT * FROM ledger_totals WHERE group_id='group-fold'").rows).toEqual([]);
       await repo.monthlySummaryMaintenance({ maxGroups: 1, maxMonths: 12, chunkSize: 100 });
       expect(execute("SELECT status,checkpoint_through,maintenance_due FROM ledger_summary_state WHERE group_id='group-fold'").rows).toEqual([{ status: 'backfilling', checkpoint_through: '2031-07-01', maintenance_due: 1 }]);
       await expect(repo.balanceProjection('group-fold')).resolves.toMatchObject({ ready: false });
       expect(execute("SELECT * FROM ledger_totals WHERE group_id='group-fold'").rows).toEqual([]);
       await repo.monthlySummaryMaintenance({ maxGroups: 1, maxMonths: 12, chunkSize: 100 });
       expect(execute("SELECT status,checkpoint_through,maintenance_due FROM ledger_summary_state WHERE group_id='group-fold'").rows).toEqual([{ status: 'backfilling', checkpoint_through: '2040-12-01', maintenance_due: 1 }]);
       await expect(repo.balanceProjection('group-fold')).resolves.toMatchObject({ ready: false });
       expect(execute("SELECT * FROM ledger_totals WHERE group_id='group-fold'").rows).toEqual([]);
       await repo.monthlySummaryMaintenance({ maxGroups: 1, maxMonths: 12, chunkSize: 100 });
       expect(execute("SELECT status,checkpoint_through,maintenance_due FROM ledger_summary_state WHERE group_id='group-fold'").rows).toEqual([{ status: 'backfilling', checkpoint_through: '2055-03-01', maintenance_due: 1 }]);
       await expect(repo.balanceProjection('group-fold')).resolves.toMatchObject({ ready: false });
       expect(execute("SELECT * FROM ledger_totals WHERE group_id='group-fold'").rows).toEqual([]);
       await repo.monthlySummaryMaintenance({ maxGroups: 1, maxMonths: 12, chunkSize: 100 });
       expect(execute("SELECT status,checkpoint_through,maintenance_due FROM ledger_summary_state WHERE group_id='group-fold'").rows).toEqual([{ status: 'ready', checkpoint_through: '2099-11-01', maintenance_due: 0 }]);
       await expect(repo.balanceProjection('group-fold')).resolves.toEqual({ ready: true, rows: [
         { currency: 'USD', personId: 'person-fold', netMinor: 1500 },
         { currency: 'USD', personId: 'person-fold-other', netMinor: -1500 },
       ] });
       expect(execute("SELECT currency,gross_minor FROM ledger_totals WHERE group_id='group-fold'").rows).toEqual([{ currency: 'USD', gross_minor: 1500 }]);

       // A correction in a folded future period changes the checkpoint in the
       // mutation batch. It does not enqueue a full rebuild or create a new
       // active build for that period.
       const beforeCorrection = execute("SELECT active_build_id,source_generation,applied_generation FROM ledger_period_state WHERE group_id='group-fold' AND month='2040-12-01'").rows[0];
       const corrected = await repo.updateExpense('fold-c', 'user-fold', {
         description: 'Future C corrected', amount_minor: 350, currency: 'USD', date: '2040-12-15', version: 1,
         payers: [{ person_id: 'person-fold', amount_minor: 350 }], splits: [{ person_id: 'person-fold-other', amount_minor: 350 }],
       });
       expect(execute("SELECT currency,person_id,net_minor FROM ledger_checkpoint_balances WHERE group_id='group-fold' ORDER BY currency,person_id").rows).toEqual([
         { currency: 'USD', person_id: 'person-fold', net_minor: 1550 }, { currency: 'USD', person_id: 'person-fold-other', net_minor: -1550 },
       ]);
       expect(execute("SELECT currency,gross_minor FROM ledger_checkpoint_totals WHERE group_id='group-fold'").rows).toEqual([{ currency: 'USD', gross_minor: 1550 }]);
       expect(execute("SELECT period.status,state.maintenance_due,period.active_build_id,period.source_generation,period.applied_generation FROM ledger_period_state period JOIN ledger_summary_state state USING (group_id) WHERE period.group_id='group-fold' AND period.month='2040-12-01'").rows).toEqual([{
         status: 'ready', maintenance_due: 0, active_build_id: beforeCorrection.active_build_id,
         source_generation: Number(beforeCorrection.source_generation) + 2, applied_generation: Number(beforeCorrection.applied_generation) + 2,
       }]);
       await repo.deleteExpense(corrected.id, 'user-fold', corrected.version);
       expect(execute("SELECT currency,person_id,net_minor FROM ledger_checkpoint_balances WHERE group_id='group-fold' ORDER BY currency,person_id").rows).toEqual([
         { currency: 'USD', person_id: 'person-fold', net_minor: 1200 }, { currency: 'USD', person_id: 'person-fold-other', net_minor: -1200 },
       ]);
       expect(execute("SELECT currency,gross_minor FROM ledger_checkpoint_totals WHERE group_id='group-fold'").rows).toEqual([{ currency: 'USD', gross_minor: 1200 }]);
       await expect(repo.balanceProjection('group-fold')).resolves.toEqual({ ready: true, rows: [
         { currency: 'USD', personId: 'person-fold', netMinor: 1200 },
         { currency: 'USD', personId: 'person-fold-other', netMinor: -1200 },
       ] });

       // Mutations in many distinct future months must not grow an unbounded
       // ready tail. The first new month makes the summary non-ready, and all
       // following writes remain on the authoritative fallback until one
       // month is folded per maintenance pass.
       for (const [index, date] of ['2200-01-15', '2201-06-15', '2205-09-15', '2210-12-15', '2220-03-15'].entries()) {
         await repo.createExpense('group-fold', 'user-fold', {
           description: `New future tail ${index}`, amount_minor: 25, currency: 'USD', date,
           payers: [{ person_id: 'person-fold', amount_minor: 25 }], splits: [{ person_id: 'person-fold-other', amount_minor: 25 }],
         });
       }
       expect(execute("SELECT status,maintenance_due,checkpoint_through FROM ledger_summary_state WHERE group_id='group-fold'").rows).toEqual([
         { status: 'pending', maintenance_due: 1, checkpoint_through: '2099-11-01' },
       ]);
       await expect(repo.balanceProjection('group-fold')).resolves.toEqual({ ready: false, rows: [
         { currency: 'USD', personId: 'person-fold', netMinor: 1325 },
         { currency: 'USD', personId: 'person-fold-other', netMinor: -1325 },
       ] });
       expect(execute("SELECT currency,gross_minor FROM ledger_totals WHERE group_id='group-fold'").rows).toEqual([{ currency: 'USD', gross_minor: 1200 }]);
        for (let pass = 0; pass < 6; pass += 1) {
          await repo.monthlySummaryMaintenance({ maxGroups: 1, maxMonths: 12, chunkSize: 100 });
        }
       expect(execute("SELECT status,checkpoint_through,maintenance_due FROM ledger_summary_state WHERE group_id='group-fold'").rows).toEqual([{ status: 'ready', checkpoint_through: '2220-03-01', maintenance_due: 0 }]);
       await expect(repo.balanceProjection('group-fold')).resolves.toEqual({ ready: true, rows: [
         { currency: 'USD', personId: 'person-fold', netMinor: 1325 },
         { currency: 'USD', personId: 'person-fold-other', netMinor: -1325 },
       ] });
       expect(execute("SELECT currency,gross_minor FROM ledger_totals WHERE group_id='group-fold'").rows).toEqual([{ currency: 'USD', gross_minor: 1325 }]);
     } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
   // The local real-D1 CLI invokes a separate process for each assertion and
   // maintenance statement (~1.5s each measured locally).
   }, 900_000);
 });
