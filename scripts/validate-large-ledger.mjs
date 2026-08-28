#!/usr/bin/env node

import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const argv = process.argv.slice(2);
const keep = argv.includes('--keep');
const index = argv.indexOf('--entries');
const entries = index < 0 ? 10_000 : Number(argv[index + 1]);
if (!Number.isSafeInteger(entries) || entries < 1 || entries > 10_000) throw new Error('--entries must be a positive integer no greater than 10000');
const persist = await mkdtemp(join(tmpdir(), 'bill-split-large-ledger-'));
const config = join(persist, 'wrangler.toml');
const seed = join(persist, 'seed.sql');
const wrangler = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');
const run = (args) => execFileSync(wrangler, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const database = 'bill-split-large-ledger';
const query = (sql) => JSON.parse(run(['d1', 'execute', database, '--local', '--persist-to', persist, '--config', config, '--command', sql, '--json'])).flatMap((result) => result.results ?? []);

try {
  // A disposable config plus --local keeps this validator away from the
  // production binding even when invoked from a production checkout.
  await cp(join(root, 'migrations'), join(persist, 'migrations'), { recursive: true });
  await writeFile(config, `name = "bill-split-large-ledger-local"\ncompatibility_date = "2025-08-01"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "${database}"\ndatabase_id = "00000000-0000-4000-8000-000000000099"\nmigrations_dir = "migrations"\n`);
  run(['d1', 'migrations', 'apply', database, '--local', '--persist-to', persist, '--config', config]);
  const statements = [
    'PRAGMA foreign_keys=ON;',
     "INSERT INTO users(id,email,created_at,updated_at) VALUES('large-user','large-ledger.invalid','2026-01-01','2026-01-01');",
     "INSERT INTO people(id,name,user_id,created_at) VALUES('large-person','Large ledger validator','large-user','2026-01-01');",
     "INSERT INTO people(id,name,created_at) VALUES('large-person-2','Removed ledger participant','2026-01-01');",
     "INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('large-group','Local large-ledger validation','USD','2026-01-01','2026-01-01');",
     "INSERT INTO group_members(group_id,person_id,user_id,joined_at,role) VALUES('large-group','large-person','large-user','2026-01-01','owner');",
     "INSERT INTO group_members(group_id,person_id,joined_at,role) VALUES('large-group','large-person-2','2026-01-01','member');",
  ];
  for (let start = 1; start <= entries; start += 1_000) {
    const end = Math.min(entries, start + 999);
    const sequence = `WITH RECURSIVE seq(n) AS (SELECT ${start} UNION ALL SELECT n+1 FROM seq WHERE n<${end})`;
    statements.push(`${sequence} INSERT INTO expenses(id,group_id,description,amount_minor,currency,expense_date,created_by,created_at,updated_at,version) SELECT printf('large-expense-%06d',n),'large-group','Validation entry',100,'USD','2026-01-01','large-user','2026-01-01','2026-01-01',1 FROM seq;`);
    statements.push(`${sequence} INSERT INTO payers(expense_id,person_id,amount_minor) SELECT printf('large-expense-%06d',n),'large-person',100 FROM seq;`);
    statements.push(`${sequence} INSERT INTO splits(expense_id,person_id,amount_minor) SELECT printf('large-expense-%06d',n),'large-person',100 FROM seq;`);
    statements.push(`${sequence} INSERT INTO settlements(id,group_id,from_person_id,to_person_id,amount_minor,currency,settlement_date,created_by,created_at,updated_at) SELECT printf('large-settlement-%06d',n),'large-group','large-person','large-person-2',1,'USD','2026-01-01','large-user','2026-01-01','2026-01-01' FROM seq;`);
  }
   // Publish the compact monthly/checkpoint state from the authoritative seed.
   // The production path does this in bounded chunks; this disposable harness
   // uses one aggregate statement to keep the 10,000-entry validator quick.
    statements.push("INSERT INTO ledger_period_balances(group_id,month,build_id,currency,person_id,net_minor,updated_at) SELECT group_id,'2026-01-01','seed-build',currency,from_person_id,SUM(amount_minor),'2026-01-01' FROM settlements WHERE group_id='large-group' GROUP BY group_id,currency,from_person_id;");
    statements.push("INSERT INTO ledger_period_balances(group_id,month,build_id,currency,person_id,net_minor,updated_at) SELECT group_id,'2026-01-01','seed-build',currency,to_person_id,-SUM(amount_minor),'2026-01-01' FROM settlements WHERE group_id='large-group' GROUP BY group_id,currency,to_person_id;");
    statements.push("INSERT INTO ledger_period_totals(group_id,month,build_id,currency,gross_minor,updated_at) SELECT group_id,'2026-01-01','seed-build',currency,SUM(amount_minor),'2026-01-01' FROM (SELECT group_id,currency,amount_minor FROM expenses UNION ALL SELECT group_id,currency,amount_minor FROM settlements) WHERE group_id='large-group' GROUP BY group_id,currency;");
    statements.push("INSERT INTO ledger_period_state(group_id,month,status,source_generation,applied_generation,build_generation,active_build_id,updated_at) SELECT 'large-group','2026-01-01','ready',0,0,0,'seed-build','2026-01-01' FROM ledger_summary_state WHERE group_id='large-group' ON CONFLICT(group_id,month) DO UPDATE SET status='ready',source_generation=0,applied_generation=0,build_generation=0,active_build_id='seed-build',updated_at=excluded.updated_at;");
   statements.push("INSERT INTO ledger_checkpoint_balances(group_id,currency,person_id,net_minor,updated_at) SELECT group_id,currency,person_id,net_minor,'2026-01-01' FROM ledger_period_balances WHERE group_id='large-group';");
   statements.push("INSERT INTO ledger_totals(group_id,currency,gross_minor,updated_at) SELECT group_id,currency,gross_minor,'2026-01-01' FROM ledger_period_totals WHERE group_id='large-group';");
    statements.push("INSERT INTO ledger_checkpoint_totals(group_id,currency,gross_minor,updated_at) SELECT group_id,currency,gross_minor,'2026-01-01' FROM ledger_period_totals WHERE group_id='large-group' AND build_id='seed-build';");
    statements.push("UPDATE ledger_summary_state SET status='ready',checkpoint_through='2026-01-01',discovery_complete=1,updated_at='2026-01-01' WHERE group_id='large-group';");
  // Exercise a real post-seed mutation rather than validating only seeded
  // reads. This mirrors the repository's add path: authoritative rows first,
  // then exact payer/split deltas and the mutation metadata update.
   statements.push("INSERT INTO expenses(id,group_id,description,amount_minor,currency,expense_date,created_by,created_at,updated_at,version,projection_mutation_id) VALUES('large-expense-mutation','large-group','Mutation entry',125,'USD','2026-01-02','large-user','2026-01-02','2026-01-02',1,'large-expense-mutation');");
  statements.push("INSERT INTO payers(expense_id,person_id,amount_minor) VALUES('large-expense-mutation','large-person',125);");
  statements.push("INSERT INTO splits(expense_id,person_id,amount_minor) VALUES('large-expense-mutation','large-person-2',125);");
    statements.push("INSERT INTO ledger_period_balances(group_id,month,build_id,currency,person_id,net_minor,updated_at) VALUES('large-group','2026-01-01','seed-build','USD','large-person',125,'2026-01-02') ON CONFLICT(group_id,month,build_id,currency,person_id) DO UPDATE SET net_minor=ledger_period_balances.net_minor+excluded.net_minor,updated_at=excluded.updated_at;");
    statements.push("INSERT INTO ledger_period_balances(group_id,month,build_id,currency,person_id,net_minor,updated_at) VALUES('large-group','2026-01-01','seed-build','USD','large-person-2',-125,'2026-01-02') ON CONFLICT(group_id,month,build_id,currency,person_id) DO UPDATE SET net_minor=ledger_period_balances.net_minor+excluded.net_minor,updated_at=excluded.updated_at;");
    statements.push("UPDATE ledger_period_totals SET gross_minor=gross_minor+125,updated_at='2026-01-02' WHERE group_id='large-group' AND month='2026-01-01' AND build_id='seed-build' AND currency='USD'; UPDATE ledger_checkpoint_balances SET net_minor=net_minor+125,updated_at='2026-01-02' WHERE group_id='large-group' AND currency='USD' AND person_id='large-person'; UPDATE ledger_checkpoint_balances SET net_minor=net_minor-125,updated_at='2026-01-02' WHERE group_id='large-group' AND currency='USD' AND person_id='large-person-2'; INSERT INTO ledger_checkpoint_totals(group_id,currency,gross_minor,updated_at) VALUES('large-group','USD',125,'2026-01-02') ON CONFLICT(group_id,currency) DO UPDATE SET gross_minor=ledger_checkpoint_totals.gross_minor+excluded.gross_minor; UPDATE ledger_totals SET gross_minor=gross_minor+125,updated_at='2026-01-02' WHERE group_id='large-group' AND currency='USD';");
  await writeFile(seed, `${statements.join('\n')}\n`);
  run(['d1', 'execute', database, '--local', '--persist-to', persist, '--config', config, '--file', seed]);
  const count = query("SELECT COUNT(*) AS count FROM expenses WHERE group_id='large-group';")[0]?.count;
  const page = query("SELECT id FROM expenses WHERE group_id='large-group' ORDER BY expense_date DESC,created_at DESC,id DESC LIMIT 100;").length;
  const gross = query("SELECT gross_minor FROM ledger_totals WHERE group_id='large-group' AND currency='USD';")[0]?.gross_minor;
  const transactionCte = `WITH transaction_rows AS (
    SELECT e.id,e.group_id,e.description,e.amount_minor,e.currency,e.expense_date AS transaction_date,e.category,e.notes,NULL AS note,NULL AS from_person_id,NULL AS to_person_id,e.created_at,'expense' AS kind
      FROM expenses e WHERE e.group_id='large-group' AND e.deleted_at IS NULL
    UNION ALL
    SELECT s.id,s.group_id,NULL,s.amount_minor,s.currency,s.settlement_date,NULL,NULL,s.note,s.from_person_id,s.to_person_id,s.created_at,'settlement' AS kind
      FROM settlements s WHERE s.group_id='large-group' AND s.deleted_at IS NULL
  )`;
   const transactionSql = `${transactionCte} SELECT id,kind,transaction_date,created_at FROM transaction_rows ORDER BY transaction_date DESC,created_at DESC,kind ASC,id DESC LIMIT 101;`;
   const firstPage = query(transactionSql);
   const boundary = firstPage.length > 100 ? firstPage[99] : null;
   const continuationSql = boundary
     ? `${transactionCte} SELECT id,kind,transaction_date,created_at FROM transaction_rows WHERE transaction_date<'${boundary.transaction_date}' OR (transaction_date='${boundary.transaction_date}' AND created_at<'${boundary.created_at}') OR (transaction_date='${boundary.transaction_date}' AND created_at='${boundary.created_at}' AND (kind>'${boundary.kind}' OR (kind='${boundary.kind}' AND id<'${boundary.id}'))) ORDER BY transaction_date DESC,created_at DESC,kind ASC,id DESC LIMIT 101;`
     : `${transactionCte} SELECT id,kind,transaction_date,created_at FROM transaction_rows WHERE 0 LIMIT 101;`;
   const explain = query(`EXPLAIN QUERY PLAN ${transactionSql}`);
  const startedAt = performance.now();
   const continuation = query(continuationSql);
  const expectedProjection = query(`SELECT group_id,currency,person_id,SUM(net_minor) AS net_minor FROM (
    SELECT e.group_id,e.currency,p.person_id,p.amount_minor AS net_minor
      FROM expenses e JOIN payers p ON p.expense_id=e.id WHERE e.group_id='large-group' AND e.deleted_at IS NULL
    UNION ALL
    SELECT e.group_id,e.currency,s.person_id,-s.amount_minor
      FROM expenses e JOIN splits s ON s.expense_id=e.id WHERE e.group_id='large-group' AND e.deleted_at IS NULL
    UNION ALL
    SELECT s.group_id,s.currency,s.from_person_id,s.amount_minor
      FROM settlements s WHERE s.group_id='large-group' AND s.deleted_at IS NULL
    UNION ALL
    SELECT s.group_id,s.currency,s.to_person_id,-s.amount_minor
      FROM settlements s WHERE s.group_id='large-group' AND s.deleted_at IS NULL
  ) GROUP BY group_id,currency,person_id HAVING SUM(net_minor)<>0 ORDER BY group_id,currency,person_id;`);
   const actualProjection = query("SELECT group_id,currency,person_id,net_minor FROM ledger_checkpoint_balances WHERE group_id='large-group' ORDER BY group_id,currency,person_id;");
  const elapsedMs = Math.round((performance.now() - startedAt) * 100) / 100;
   const kinds = new Set(query(`${transactionCte} SELECT kind FROM transaction_rows GROUP BY kind;`).map((row) => row.kind));
  const expectedGross = entries * 101 + 125;
   const transactionCount = entries * 2 + 1;
   if (Number(count) !== entries + 1 || page !== Math.min(entries + 1, 100) || Number(gross) !== expectedGross || JSON.stringify(actualProjection) !== JSON.stringify(expectedProjection) || firstPage.length !== Math.min(transactionCount, 101) || continuation.length !== Math.max(Math.min(transactionCount - 100, 101), 0) || !kinds.has('expense') || !kinds.has('settlement')) throw new Error(`Validation failed: count=${count}, page=${page}, gross_minor=${gross}, projection=${JSON.stringify(actualProjection)}, expectedProjection=${JSON.stringify(expectedProjection)}, transactions=${firstPage.length}, continuation=${continuation.length}`);
   process.stdout.write(`Validated ${entries.toLocaleString()} expenses + ${entries.toLocaleString()} settlements plus one mutation: tie-heavy transaction pages=${firstPage.length}+${continuation.length}, EXPLAIN steps=${explain.length}, elapsed=${elapsedMs}ms; count, keyset, exact authoritative projection, and O(1) gross total passed.\n`);
} finally {
  if (!keep) await rm(persist, { recursive: true, force: true });
  else process.stdout.write(`Kept local validation state at ${persist}\n`);
}
