import { describe, expect, it } from 'vitest';
import { Repository } from './repository';
import { all, db, executeSql } from './cloudflare-d1-test';

describe('large local-D1 summary workloads', () => {
  it('handles a 100-participant mutation and retains bounded delete plans', async () => {
    const ids = Array.from({ length: 100 }, (_, index) => `bulk-person-${String(index + 1).padStart(3, '0')}`);
    await executeSql(`
      INSERT INTO users(id,email,created_at,updated_at) VALUES('bulk-user','bulk@example.com','2026-01-01','2026-01-01');
      INSERT INTO people(id,name,email,user_id,created_at) VALUES('bulk-owner','Bulk Owner','bulk@example.com','bulk-user','2026-01-01');
      INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('bulk-group','Bulk participants','USD','2026-01-01','2026-01-01');
      INSERT INTO group_members(group_id,person_id,user_id,joined_at,role) VALUES('bulk-group','bulk-owner','bulk-user','2026-01-01','owner');
      ${ids.map((id, index) => `INSERT INTO people(id,name,created_at) VALUES('${id}','Bulk ${index + 1}','2026-01-02'); INSERT INTO group_members(group_id,person_id,joined_at,role) VALUES('bulk-group','${id}','2026-01-02','member');`).join('\n')}
      UPDATE ledger_summary_state SET status='ready',discovery_complete=1,maintenance_due=0,available_at_ms=0 WHERE group_id='bulk-group';
    `);
    const repo = new Repository(db);
    expect(await all('SELECT status,discovery_complete,maintenance_due FROM ledger_summary_state WHERE group_id=?', 'bulk-group')).toEqual([{ status: 'ready', discovery_complete: 1, maintenance_due: 0 }]);
    const input = {
      description: 'Bulk expense', amount_minor: 5050, currency: 'USD' as const, date: '2026-01-02',
      payers: ids.map((person_id, index) => ({ person_id, amount_minor: index + 1 })),
      splits: ids.map((person_id, index) => ({ person_id, amount_minor: 100 - index })),
    };
    const created = await repo.createExpense('bulk-group', 'bulk-user', input);
    expect((await db.prepare('SELECT COUNT(*) AS count FROM payers WHERE expense_id=?').bind(created.id).all()).results).toEqual([{ count: 100 }]);
    expect((await db.prepare('SELECT COUNT(*) AS count FROM splits WHERE expense_id=?').bind(created.id).all()).results).toEqual([{ count: 100 }]);

    for (let pass = 0; pass < 12; pass += 1) {
      await repo.monthlySummaryMaintenance({ maxGroups: 1, maxMonths: 12, chunkSize: 100 });
      const state = (await all('SELECT status,maintenance_due FROM ledger_summary_state WHERE group_id=?', 'bulk-group'))[0];
      if (state?.status === 'ready' && Number(state.maintenance_due) === 0) break;
    }
    expect(await all('SELECT status,maintenance_due FROM ledger_summary_state WHERE group_id=?', 'bulk-group')).toEqual([{ status: 'ready', maintenance_due: 0 }]);
    const balances = await repo.balanceProjection('bulk-group');
    expect(balances.ready).toBe(true);
    expect(balances.rows).toEqual(ids.map((personId, index) => ({ currency: 'USD', personId, netMinor: 2 * index - 99 })));
    expect(await all(`SELECT COALESCE((SELECT SUM(gross_minor) FROM ledger_checkpoint_totals WHERE group_id=?),0)
      + COALESCE((SELECT SUM(t.gross_minor) FROM ledger_period_totals t JOIN ledger_period_state p
        ON p.group_id=t.group_id AND p.month=t.month AND p.active_build_id=t.build_id
        WHERE t.group_id=? AND (p.month>COALESCE((SELECT checkpoint_through FROM ledger_summary_state WHERE group_id=?),'0000-00-00'))),0) AS gross`,
      'bulk-group', 'bulk-group', 'bulk-group')).toEqual([{ gross: 5050 }]);

    const suggestionPlan = JSON.stringify((await db.prepare(`EXPLAIN QUERY PLAN SELECT e.id FROM expenses e
      WHERE e.group_id='bulk-group' AND e.created_by='bulk-user' AND e.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM scheduled_occurrences occurrence WHERE occurrence.expense_id=e.id)
      ORDER BY e.created_at DESC,e.id DESC LIMIT 3`).all()).results).toLowerCase();
    expect(suggestionPlan).toContain('idx_expenses_suggestion_lookup');
    const payerDeletePlan = JSON.stringify((await db.prepare(`EXPLAIN QUERY PLAN DELETE FROM payers WHERE rowid IN
      (SELECT payer.rowid FROM payers payer JOIN expenses expense ON expense.id=payer.expense_id
        WHERE expense.group_id='bulk-group' LIMIT 100)`).all()).results).toLowerCase();
    expect(payerDeletePlan).toMatch(/search|using/);
    expect(payerDeletePlan).not.toContain('use temp b-tree');
    const verificationDeletePlan = JSON.stringify((await db.prepare(`EXPLAIN QUERY PLAN DELETE FROM ledger_period_verify_balances WHERE rowid IN
      (SELECT rowid FROM ledger_period_verify_balances WHERE group_id='bulk-group' LIMIT 100)`).all()).results).toLowerCase();
    expect(verificationDeletePlan).toContain('idx_ledger_verify_balances_chunk');
    expect(verificationDeletePlan).not.toContain('use temp b-tree');
  });
});
