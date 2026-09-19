import { describe, expect, it } from 'vitest';
// These tests intentionally exercise the authored SQL with the system SQLite
// CLI, without depending on Wrangler or the Cloudflare module loader.
// @ts-expect-error Node types are not shipped to the Worker build.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
// @ts-expect-error Node types are not shipped to the Worker build.
import { spawnSync } from 'node:child_process';
// @ts-expect-error Node types are not shipped to the Worker build.
import { join } from 'node:path';
// @ts-expect-error Node types are not shipped to the Worker build.
import { tmpdir } from 'node:os';

const moduleUrl = (import.meta as ImportMeta & { url: string }).url;
const migrationsPath = new URL('../../migrations/', moduleUrl);
const migrationNames = (readdirSync(migrationsPath) as string[]).filter((name: string) => name.endsWith('.sql')).sort();
const sqliteAvailable = existsSync('/usr/bin/sqlite3') || existsSync('/usr/local/bin/sqlite3');
const suite = sqliteAvailable ? describe : describe.skip;

type SqliteResult = { status: number | null; stdout: string; stderr: string };

function runSqlite(dbPath: string, sql: string): SqliteResult {
  const result = spawnSync('sqlite3', [dbPath], { input: sql, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function migrationScript(names: string[]) {
  return names.map((name) => readFileSync(new URL(name, migrationsPath), 'utf8')).join('\n');
}

function makeDatabase(names = migrationNames) {
  const directory = mkdtempSync(join(tmpdir(), 'bill-split-credit-safety-'));
  const dbPath = join(directory, 'test.db');
  const seed = `
    INSERT INTO users(id,email,created_at,updated_at) VALUES('u1','u1@example.com','2026-01-01','2026-01-01');
    INSERT INTO people(id,name,email,user_id,created_at) VALUES('p1','P1','u1@example.com','u1','2026-01-01'),('p2','P2','p2@example.com',NULL,'2026-01-01');
    INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('g1','Group','USD','2026-01-01','2026-01-01');
    INSERT INTO group_members(group_id,person_id,user_id,joined_at,role) VALUES('g1','p1','u1','2026-01-01','owner'),('g1','p2',NULL,'2026-01-01','member');
    INSERT INTO expenses(id,group_id,description,amount_minor,currency,expense_date,created_by,created_at,updated_at,version) VALUES('e1','g1','Expense',100,'USD','2026-01-01','u1','2026-01-01','2026-01-01',1);
    INSERT INTO payers(expense_id,person_id,amount_minor) VALUES('e1','p1',100);
    INSERT INTO splits(expense_id,person_id,amount_minor) VALUES('e1','p2',100);
  `;
  const applied = runSqlite(dbPath, `${migrationScript(names)}\n${seed}`);
  if (applied.status !== 0) throw new Error(`${applied.stdout}\n${applied.stderr}`);
  return { directory, dbPath };
}

suite('credit SQL safety and migration upgrades', () => {
  it('executes the 0030 to 0032 upgrade with ready/checkpoint state and requeues existing credits', () => {
    const beforeCredits = migrationNames.filter((name: string) => name < '0030_credit_transactions.sql');
    const afterCredits = migrationNames.filter((name: string) => name > '0030_credit_transactions.sql');
    const { directory, dbPath } = makeDatabase(beforeCredits);
    try {
      const creditSchema = runSqlite(dbPath, `${migrationScript(['0030_credit_transactions.sql'])}
        INSERT INTO credits(id,group_id,subtype,delivery_mode,amount_minor,currency,credit_date,created_by,created_at,updated_at) VALUES('c1','g1','refund','direct_provider_offset',25,'USD','2026-01-02','u1','2026-01-02','2026-01-02');
        INSERT INTO credit_applications(credit_id,expense_id,amount_minor) VALUES('c1','e1',25);
        INSERT INTO credit_allocations(credit_id,person_id,allocation_type,amount_minor) VALUES('c1','p1','recipient',25);
        UPDATE ledger_summary_state SET status='ready',discovery_complete=1,maintenance_due=0,checkpoint_through='2026-01-01' WHERE group_id='g1';
        INSERT INTO ledger_period_state(group_id,month,status,source_generation,applied_generation,build_generation,active_build_id,updated_at) VALUES('g1','2026-01-01','ready',1,1,1,'build-1','2026-01-02') ON CONFLICT(group_id,month) DO UPDATE SET status='ready',source_generation=1,applied_generation=1,build_generation=1,active_build_id='build-1',updated_at='2026-01-02';
        INSERT INTO ledger_period_balances(group_id,month,build_id,currency,person_id,net_minor,updated_at) VALUES('g1','2026-01-01','build-1','USD','p1',100,'2026-01-02');
        INSERT INTO ledger_checkpoint_balances(group_id,currency,person_id,net_minor,updated_at) VALUES('g1','USD','p1',100,'2026-01-02');
        ${migrationScript(afterCredits)}
        SELECT status||'|'||discovery_complete||'|'||maintenance_due||'|'||COALESCE(credit_discovery_cursor,'NULL')||'|'||credit_discovery_high_water FROM ledger_summary_state WHERE group_id='g1';
        SELECT status||'|'||source_generation||'|'||COALESCE(credit_cursor,'NULL') FROM ledger_period_state WHERE group_id='g1' AND month='2026-01-01';`);
      if (creditSchema.status !== 0) throw new Error(`${creditSchema.stdout}\n${creditSchema.stderr}`);
      expect(creditSchema.stdout).toContain('pending|0|1|NULL|c1');
      expect(creditSchema.stdout).toContain('dirty|3|NULL');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects unrelated direct-provider recipients, linked expense mutation, and aggregate overflow', () => {
    const { directory, dbPath } = makeDatabase();
    try {
      const setup = runSqlite(dbPath, `
        INSERT INTO credits(id,group_id,subtype,delivery_mode,amount_minor,currency,credit_date,created_by,created_at,updated_at) VALUES('c1','g1','refund','direct_provider_offset',25,'USD','2026-01-02','u1','2026-01-02','2026-01-02');
        INSERT INTO credit_applications(credit_id,expense_id,amount_minor) VALUES('c1','e1',25);
      `);
      if (setup.status !== 0) throw new Error(`${setup.stdout}\n${setup.stderr}`);
      const unrelatedRecipient = runSqlite(dbPath, "INSERT INTO credit_allocations(credit_id,person_id,allocation_type,amount_minor) VALUES('c1','p2','recipient',25);");
      expect(unrelatedRecipient.status).not.toBe(0);
      expect(`${unrelatedRecipient.stdout}${unrelatedRecipient.stderr}`).toContain('CREDIT_RECIPIENT_INVALID');

      const linkedExpense = runSqlite(dbPath, "UPDATE expenses SET amount_minor=101 WHERE id='e1';");
      expect(linkedExpense.status).not.toBe(0);
      expect(`${linkedExpense.stdout}${linkedExpense.stderr}`).toContain('CREDIT_EXPENSE_LINKED');

      const nearLimit = runSqlite(dbPath, `
        UPDATE credits SET deleted_at='2026-01-03' WHERE id='c1';
        UPDATE expenses SET amount_minor=9007199254740991 WHERE id='e1';
        UPDATE payers SET amount_minor=9007199254740991 WHERE expense_id='e1';
        UPDATE splits SET amount_minor=0 WHERE expense_id='e1';
        UPDATE credits SET deleted_at=NULL WHERE id='c1';
        INSERT INTO credit_allocations(credit_id,person_id,allocation_type,amount_minor) VALUES('c1','p1','beneficiary',1);
      `);
      expect(nearLimit.status).not.toBe(0);
      expect(`${nearLimit.stdout}${nearLimit.stderr}`).toContain('BALANCE_OVERFLOW');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps expense and settlement overflow guards symmetric with active credit allocations', () => {
    const max = Number.MAX_SAFE_INTEGER;
    const credit = (dbPath: string) => runSqlite(dbPath, `
      INSERT INTO credits(id,group_id,subtype,delivery_mode,amount_minor,currency,credit_date,created_by,created_at,updated_at) VALUES('c2','g1','claim','member_reimbursement',1,'USD','2026-01-02','u1','2026-01-02','2026-01-02');
      INSERT INTO credit_allocations(credit_id,person_id,allocation_type,amount_minor) VALUES('c2','p1','recipient',1);
    `);
    const finishCredit = (dbPath: string) => runSqlite(dbPath, "INSERT INTO credit_allocations(credit_id,person_id,allocation_type,amount_minor) VALUES('c2','p2','beneficiary',1);");
    const expectOverflow = (result: SqliteResult) => {
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('BALANCE_OVERFLOW');
    };

    const creditThenExpense = makeDatabase();
    const expenseThenCredit = makeDatabase();
    const creditThenSettlement = makeDatabase();
    const settlementThenCredit = makeDatabase();
    const expenseRestore = makeDatabase();
    const settlementRestore = makeDatabase();
    try {
      expect(runSqlite(creditThenExpense.dbPath, `UPDATE expenses SET amount_minor=${max - 2} WHERE id='e1';`).status).toBe(0);
      expect(credit(creditThenExpense.dbPath).status).toBe(0);
      expect(finishCredit(creditThenExpense.dbPath).status).toBe(0);
      expectOverflow(runSqlite(creditThenExpense.dbPath, `UPDATE expenses SET amount_minor=${max - 1} WHERE id='e1';`));

      expect(runSqlite(expenseThenCredit.dbPath, `UPDATE expenses SET amount_minor=${max - 1} WHERE id='e1';`).status).toBe(0);
      expect(credit(expenseThenCredit.dbPath).status).toBe(0);
      expectOverflow(finishCredit(expenseThenCredit.dbPath));

      const settlementBase = Math.floor((max - 3) / 2);
      expect(runSqlite(creditThenSettlement.dbPath, `UPDATE expenses SET deleted_at='2026-01-03' WHERE id='e1'; INSERT INTO settlements(id,group_id,from_person_id,to_person_id,amount_minor,currency,settlement_date,created_by,created_at,updated_at,version) VALUES('s1','g1','p1','p2',${settlementBase},'USD','2026-01-02','u1','2026-01-02','2026-01-02',1);`).status).toBe(0);
      expect(credit(creditThenSettlement.dbPath).status).toBe(0);
      expect(finishCredit(creditThenSettlement.dbPath).status).toBe(0);
      expectOverflow(runSqlite(creditThenSettlement.dbPath, `UPDATE settlements SET amount_minor=${settlementBase + 1} WHERE id='s1';`));

      expect(runSqlite(settlementThenCredit.dbPath, `UPDATE expenses SET deleted_at='2026-01-03' WHERE id='e1'; INSERT INTO settlements(id,group_id,from_person_id,to_person_id,amount_minor, currency,settlement_date,created_by,created_at,updated_at,version) VALUES('s1','g1','p1','p2',${settlementBase + 1},'USD','2026-01-02','u1','2026-01-02','2026-01-02',1);`).status).toBe(0);
      expect(credit(settlementThenCredit.dbPath).status).toBe(0);
      expectOverflow(finishCredit(settlementThenCredit.dbPath));

      expect(runSqlite(expenseRestore.dbPath, `UPDATE expenses SET amount_minor=${max - 1},deleted_at='2026-01-03' WHERE id='e1';`).status).toBe(0);
      expect(credit(expenseRestore.dbPath).status).toBe(0);
      expect(finishCredit(expenseRestore.dbPath).status).toBe(0);
      expectOverflow(runSqlite(expenseRestore.dbPath, "UPDATE expenses SET deleted_at=NULL WHERE id='e1';"));

      expect(runSqlite(settlementRestore.dbPath, `UPDATE expenses SET deleted_at='2026-01-03' WHERE id='e1'; INSERT INTO settlements(id,group_id,from_person_id,to_person_id,amount_minor,currency,settlement_date,created_by,created_at,updated_at,version) VALUES('s1','g1','p1','p2',${settlementBase + 1},'USD','2026-01-02','u1','2026-01-02','2026-01-02',1); UPDATE settlements SET deleted_at='2026-01-03' WHERE id='s1';`).status).toBe(0);
      expect(credit(settlementRestore.dbPath).status).toBe(0);
      expect(finishCredit(settlementRestore.dbPath).status).toBe(0);
      expectOverflow(runSqlite(settlementRestore.dbPath, "UPDATE settlements SET deleted_at=NULL WHERE id='s1';"));
    } finally {
      for (const database of [creditThenExpense, expenseThenCredit, creditThenSettlement, settlementThenCredit, expenseRestore, settlementRestore]) rmSync(database.directory, { recursive: true, force: true });
    }
  }, 30000);
});
