import { describe, expect, it } from 'vitest';
import { Repository } from './repository';
import { all, db, executeSql } from './cloudflare-d1-test';

type Fixture = {
  groupId: string;
  userA: string;
  userB: string;
  personA: string;
  personB: string;
};

let fixtureNumber = 0;

const exec = (sql: string, ...args: unknown[]) => args.length
  ? db.prepare(sql).bind(...args).run()
  : executeSql(sql);

async function createFixture(label: string): Promise<Fixture> {
  const key = `${label}-${++fixtureNumber}`;
  const fixture = {
    groupId: `${key}-group`,
    userA: `${key}-user-a`,
    userB: `${key}-user-b`,
    personA: `${key}-person-a`,
    personB: `${key}-person-b`,
  };
  await exec(`
    INSERT INTO users(id,email,created_at,updated_at) VALUES
      ('${fixture.userA}','${key}-a@example.com','2026-01-01','2026-01-01'),
      ('${fixture.userB}','${key}-b@example.com','2026-01-01','2026-01-01');
    INSERT INTO people(id,name,email,user_id,created_at) VALUES
      ('${fixture.personA}','A','${key}-a@example.com','${fixture.userA}','2026-01-01'),
      ('${fixture.personB}','B','${key}-b@example.com','${fixture.userB}','2026-01-01');
    INSERT INTO groups(id,name,currency,created_at,updated_at)
      VALUES('${fixture.groupId}','${label}','USD','2026-01-01','2026-01-01');
    INSERT INTO group_members(group_id,person_id,user_id,joined_at,role) VALUES
      ('${fixture.groupId}','${fixture.personA}','${fixture.userA}','2026-01-01','owner'),
      ('${fixture.groupId}','${fixture.personB}','${fixture.userB}','2026-01-01','member');
  `);
  return fixture;
}

async function addExpense(fixture: Fixture, id: string, amount: number, date: string, currency = 'USD') {
  await exec(`
    INSERT INTO expenses(id,group_id,description,amount_minor,currency,expense_date,created_by,created_at,updated_at,version)
      VALUES('${id}','${fixture.groupId}','${id}',${amount},'${currency}','${date}','${fixture.userA}','${date}','${date}',1);
    INSERT INTO payers(expense_id,person_id,amount_minor) VALUES('${id}','${fixture.personA}',${amount});
    INSERT INTO splits(expense_id,person_id,amount_minor) VALUES('${id}','${fixture.personB}',${amount});
  `);
}

async function maintainUntilReady(repo: Repository, groupId: string, maxPasses = 12) {
  for (let pass = 0; pass < maxPasses; pass += 1) {
    await repo.monthlySummaryMaintenance({ maxGroups: 1, maxMonths: 12, chunkSize: 100 });
    const state = (await all('SELECT status,maintenance_due FROM ledger_summary_state WHERE group_id=?', groupId))[0];
    if (state?.status === 'ready' && Number(state.maintenance_due) === 0) return;
  }
  throw new Error(`summary did not become ready for ${groupId}`);
}

function databaseWithReadRace(groupId: string) {
  let raced = false;
  return {
    prepare(sql: string) {
      const prepared = db.prepare(sql);
      return {
        bind(...args: unknown[]) {
          const bound = prepared.bind(...args);
          return {
            async all<T>() {
              if (!raced && sql.includes('WITH requested_group AS')) {
                raced = true;
                await db.prepare('UPDATE ledger_summary_state SET status=?,maintenance_due=1 WHERE group_id=?').bind('pending', groupId).run();
              }
              return bound.all<T>();
            },
          };
        },
      };
    },
    get raced() { return raced; },
  };
}

describe('group summaries with the in-process local D1 binding', () => {
  it('uses authoritative fallback, publishes a ready projection, and selects the branch from one read snapshot', async () => {
    const fixture = await createFixture('fallback');
    await addExpense(fixture, `${fixture.groupId}-expense`, 100, '2026-01-01');
    const repo = new Repository(db);

    await expect(repo.balanceProjection(fixture.groupId)).resolves.toEqual({ ready: false, rows: [
      { currency: 'USD', personId: fixture.personA, netMinor: 100 },
      { currency: 'USD', personId: fixture.personB, netMinor: -100 },
    ] });
    await expect(repo.groups(fixture.userB)).resolves.toMatchObject([{ id: fixture.groupId, balanceSummaries: [{ currency: 'USD', netMinor: -100 }] }]);
    await expect(repo.groups(fixture.userA)).resolves.toMatchObject([{ id: fixture.groupId, balanceSummaries: [{ currency: 'USD', netMinor: 100 }] }]);

    await maintainUntilReady(repo, fixture.groupId);
    await expect(repo.balanceProjection(fixture.groupId)).resolves.toEqual({ ready: true, rows: [
      { currency: 'USD', personId: fixture.personA, netMinor: 100 },
      { currency: 'USD', personId: fixture.personB, netMinor: -100 },
    ] });
    await expect(repo.groups(fixture.userB)).resolves.toMatchObject([{ id: fixture.groupId, balanceSummaries: [{ currency: 'USD', netMinor: -100 }] }]);

    await exec('UPDATE ledger_summary_state SET status=?,maintenance_due=0 WHERE group_id=?', 'ready', fixture.groupId).then(() => undefined);
    const racedDb = databaseWithReadRace(fixture.groupId);
    const racedRepository = new Repository(racedDb as never);
    await expect(racedRepository.balanceProjection(fixture.groupId)).resolves.toEqual({ ready: false, rows: [
      { currency: 'USD', personId: fixture.personA, netMinor: 100 },
      { currency: 'USD', personId: fixture.personB, netMinor: -100 },
    ] });
    expect(racedDb.raced).toBe(true);
  });

  it('keeps old-worker projection selectors compatible while mutating expense and settlement summaries', async () => {
    const fixture = await createFixture('hybrid');
    await exec(`
      INSERT INTO projection_state(group_id,status,backfill_cursor,updated_at,ledger_totals_ready,reconciliation_due)
        VALUES('${fixture.groupId}','ready',NULL,'2026-01-01',1,0);
      INSERT INTO group_balance_projection(group_id,currency,person_id,net_minor,updated_at)
        VALUES('${fixture.groupId}','USD','${fixture.personA}',0,'2026-01-01'),
              ('${fixture.groupId}','USD','${fixture.personB}',0,'2026-01-01');
    `);
    const legacySelectors = await all('SELECT status,backfill_cursor,updated_at,ledger_totals_ready,reconciliation_due FROM projection_state WHERE group_id=?', fixture.groupId);
    const repo = new Repository(db);
    const expense = await repo.createExpense(fixture.groupId, fixture.userA, {
      description: 'Dinner', amount_minor: 120, currency: 'USD', date: '2026-01-01',
      payers: [{ person_id: fixture.personA, amount_minor: 120 }],
      splits: [{ person_id: fixture.personB, amount_minor: 120 }],
    });
    const settlement = await repo.createSettlement(fixture.groupId, fixture.userA, {
      from_person_id: fixture.personA, to_person_id: fixture.personB, amount_minor: 40, currency: 'USD', date: '2026-01-02',
    });
    const updatedExpense = await repo.updateExpense(expense.id, fixture.userA, {
      description: 'Dinner revised', amount_minor: 150, currency: 'USD', date: '2026-01-01', version: expense.version,
      payers: [{ person_id: fixture.personA, amount_minor: 150 }], splits: [{ person_id: fixture.personB, amount_minor: 150 }],
    });
    const updatedSettlement = await repo.updateSettlement(settlement.id, fixture.userA, {
      from_person_id: fixture.personA, to_person_id: fixture.personB, amount_minor: 60, currency: 'USD', date: '2026-01-02', version: settlement.version,
    });
    await repo.deleteExpense(updatedExpense.id, fixture.userA, updatedExpense.version);
    await repo.restoreExpense(updatedExpense.id, fixture.userA, updatedExpense.version + 1);
    await repo.deleteSettlement(updatedSettlement.id, fixture.userA, updatedSettlement.version);
    await repo.restoreSettlement(updatedSettlement.id, fixture.userA, updatedSettlement.version + 1);

    expect(await all('SELECT status,backfill_cursor,updated_at,ledger_totals_ready,reconciliation_due FROM projection_state WHERE group_id=?', fixture.groupId)).toEqual(legacySelectors);
    expect(await all('SELECT currency,person_id,net_minor FROM group_balance_projection WHERE group_id=? ORDER BY person_id', fixture.groupId)).toEqual([
      { currency: 'USD', person_id: fixture.personA, net_minor: 210 },
      { currency: 'USD', person_id: fixture.personB, net_minor: -210 },
    ]);
    await maintainUntilReady(repo, fixture.groupId);
    await expect(repo.balanceProjection(fixture.groupId)).resolves.toEqual({ ready: true, rows: [
      { currency: 'USD', personId: fixture.personA, netMinor: 210 },
      { currency: 'USD', personId: fixture.personB, netMinor: -210 },
    ] });

    await exec(`UPDATE group_balance_projection SET net_minor=999 WHERE group_id='${fixture.groupId}' AND person_id='${fixture.personA}'; UPDATE group_balance_projection SET net_minor=-999 WHERE group_id='${fixture.groupId}' AND person_id='${fixture.personB}';`);
    await expect(repo.balanceProjection(fixture.groupId)).resolves.toEqual({ ready: true, rows: [
      { currency: 'USD', personId: fixture.personA, netMinor: 210 },
      { currency: 'USD', personId: fixture.personB, netMinor: -210 },
    ] });
    const projectionBeforeRejected = await repo.balanceProjection(fixture.groupId);
    await expect(repo.updateExpense(expense.id, fixture.userA, {
      description: 'Stale', amount_minor: 999, currency: 'USD', date: '2026-01-01', version: expense.version,
      payers: [{ person_id: fixture.personA, amount_minor: 999 }], splits: [{ person_id: fixture.personB, amount_minor: 999 }],
    })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(repo.updateExpense(expense.id, 'not-a-member', {
      description: 'Unauthorized', amount_minor: 210, currency: 'USD', date: '2026-01-01', version: expense.version + 3,
      payers: [{ person_id: fixture.personA, amount_minor: 210 }], splits: [{ person_id: fixture.personB, amount_minor: 210 }],
    })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(repo.balanceProjection(fixture.groupId)).resolves.toEqual(projectionBeforeRejected);

    await exec('UPDATE ledger_totals SET gross_minor=? WHERE group_id=? AND currency=?', 9007199254740991, fixture.groupId, 'USD');
    await expect(repo.createExpense(fixture.groupId, fixture.userB, {
      description: 'Overflow', amount_minor: 1, currency: 'USD', date: '2026-01-03',
      payers: [{ person_id: fixture.personB, amount_minor: 1 }], splits: [{ person_id: fixture.personB, amount_minor: 1 }],
    })).rejects.toMatchObject({ code: 'BALANCE_OVERFLOW' });
  });

  it('folds future months one at a time and applies folded corrections to the checkpoint', async () => {
    const fixture = await createFixture('future');
    for (const [index, date] of ['2029-01-15', '2031-07-15', '2040-12-15'].entries()) {
      await addExpense(fixture, `${fixture.groupId}-expense-${index}`, (index + 1) * 100, date);
    }
    await exec('UPDATE ledger_summary_state SET checkpoint_through=?,maintenance_due=1 WHERE group_id=?', '2025-12-01', fixture.groupId);
    const repo = new Repository(db);

    await repo.monthlySummaryMaintenance({ maxGroups: 1, maxMonths: 12, chunkSize: 100 });
    expect(await all('SELECT status,checkpoint_through FROM ledger_summary_state WHERE group_id=?', fixture.groupId)).toEqual([{ status: 'backfilling', checkpoint_through: '2025-12-01' }]);
    await expect(repo.balanceProjection(fixture.groupId)).resolves.toMatchObject({ ready: false });

    const checkpoints: unknown[] = [];
    for (let pass = 0; pass < 3; pass += 1) {
      await repo.monthlySummaryMaintenance({ maxGroups: 1, maxMonths: 12, chunkSize: 100 });
      checkpoints.push((await all('SELECT checkpoint_through FROM ledger_summary_state WHERE group_id=?', fixture.groupId))[0].checkpoint_through);
    }
    expect(checkpoints).toEqual(['2029-01-01', '2031-07-01', '2040-12-01']);
    expect(await all('SELECT status,checkpoint_through,maintenance_due FROM ledger_summary_state WHERE group_id=?', fixture.groupId)).toEqual([{ status: 'ready', checkpoint_through: '2040-12-01', maintenance_due: 0 }]);
    await expect(repo.balanceProjection(fixture.groupId)).resolves.toEqual({ ready: true, rows: [
      { currency: 'USD', personId: fixture.personA, netMinor: 600 },
      { currency: 'USD', personId: fixture.personB, netMinor: -600 },
    ] });

    const corrected = await new Repository(db).updateExpense(`${fixture.groupId}-expense-2`, fixture.userA, {
      description: `${fixture.groupId}-expense-2`, amount_minor: 350, currency: 'USD', date: '2040-12-15', version: 1,
      payers: [{ person_id: fixture.personA, amount_minor: 350 }], splits: [{ person_id: fixture.personB, amount_minor: 350 }],
    });
    expect(await all('SELECT currency,gross_minor FROM ledger_checkpoint_totals WHERE group_id=?', fixture.groupId)).toEqual([{ currency: 'USD', gross_minor: 650 }]);
    await new Repository(db).deleteExpense(corrected.id, fixture.userA, corrected.version);
    expect(await all('SELECT currency,gross_minor FROM ledger_checkpoint_totals WHERE group_id=?', fixture.groupId)).toEqual([{ currency: 'USD', gross_minor: 300 }]);

    for (const [index, date] of ['2200-01-15', '2220-03-15'].entries()) {
      await repo.createExpense(fixture.groupId, fixture.userA, {
        description: `Future tail ${index}`, amount_minor: 25, currency: 'USD', date,
        payers: [{ person_id: fixture.personA, amount_minor: 25 }],
        splits: [{ person_id: fixture.personB, amount_minor: 25 }],
      });
    }
    expect(await all('SELECT status,checkpoint_through,maintenance_due FROM ledger_summary_state WHERE group_id=?', fixture.groupId)).toEqual([{ status: 'pending', checkpoint_through: '2040-12-01', maintenance_due: 1 }]);
    await expect(repo.balanceProjection(fixture.groupId)).resolves.toMatchObject({ ready: false, rows: [
      { currency: 'USD', personId: fixture.personA, netMinor: 350 },
      { currency: 'USD', personId: fixture.personB, netMinor: -350 },
    ] });
    expect(await all('SELECT currency,gross_minor FROM ledger_totals WHERE group_id=?', fixture.groupId)).toEqual([{ currency: 'USD', gross_minor: 300 }]);
    await maintainUntilReady(repo, fixture.groupId);
    expect(await all('SELECT checkpoint_through FROM ledger_summary_state WHERE group_id=?', fixture.groupId)).toEqual([{ checkpoint_through: '2220-03-01' }]);
    await expect(repo.balanceProjection(fixture.groupId)).resolves.toMatchObject({ ready: true, rows: [
      { currency: 'USD', personId: fixture.personA, netMinor: 350 },
      { currency: 'USD', personId: fixture.personB, netMinor: -350 },
    ] });
  });

  it('bounds build GC and retries eligible failed periods without starving due groups', async () => {
    const fixture = await createFixture('maintenance');
    await addExpense(fixture, `${fixture.groupId}-expense`, 100, '2026-01-01');
    const repo = new Repository(db);
    await maintainUntilReady(repo, fixture.groupId);
    const period = (await all('SELECT month,active_build_id FROM ledger_period_state WHERE group_id=?', fixture.groupId))[0];
    const activeBuildId = String(period.active_build_id);
    await exec(`INSERT INTO ledger_period_build_gc(group_id,month,build_id,enqueued_at_ms,available_at_ms,updated_at_ms)
      VALUES('${fixture.groupId}','${period.month}','${activeBuildId}',0,-1,0);`);
    await expect(repo.ledgerPeriodBuildGarbageCollection({ maxBuilds: 1, chunkSize: 1 })).resolves.toMatchObject({ buildsScanned: 0, buildsCompleted: 0 });
    expect(await all('SELECT build_id FROM ledger_period_build_gc WHERE group_id=? AND build_id=?', fixture.groupId, activeBuildId)).toEqual([{ build_id: activeBuildId }]);
    await exec(`
      INSERT INTO ledger_period_balances(group_id,month,build_id,currency,person_id,net_minor,updated_at)
        VALUES('${fixture.groupId}','${period.month}','old-build','USD','${fixture.personA}',1,'2026-01-01'),
              ('${fixture.groupId}','${period.month}','old-build','EUR','${fixture.personA}',1,'2026-01-01'),
              ('${fixture.groupId}','${period.month}','old-build','GBP','${fixture.personA}',1,'2026-01-01'),
              ('${fixture.groupId}','${period.month}','new-build','USD','${fixture.personA}',1,'2026-01-01');
      INSERT INTO ledger_period_totals(group_id,month,build_id,currency,gross_minor,updated_at)
        VALUES('${fixture.groupId}','${period.month}','old-build','USD',1,'2026-01-01'),
              ('${fixture.groupId}','${period.month}','old-build','EUR',1,'2026-01-01'),
              ('${fixture.groupId}','${period.month}','old-build','GBP',1,'2026-01-01'),
              ('${fixture.groupId}','${period.month}','new-build','USD',1,'2026-01-01');
      INSERT INTO ledger_period_build_gc(group_id,month,build_id,enqueued_at_ms,available_at_ms,updated_at_ms)
        VALUES('${fixture.groupId}','${period.month}','old-build',0,-1,0),('${fixture.groupId}','${period.month}','new-build',0,-1,0);
    `);
    const gcResults = [await repo.ledgerPeriodBuildGarbageCollection({ maxBuilds: 1, chunkSize: 1 })];
    for (let pass = 0; pass < 5; pass += 1) gcResults.push(await repo.ledgerPeriodBuildGarbageCollection({ maxBuilds: 1, chunkSize: 1 }));
    expect(gcResults[0]).toMatchObject({ buildsScanned: 1, balancesDeleted: 1, totalsDeleted: 1, capped: true });
    expect(gcResults.some((result) => result.buildsCompleted > 0)).toBe(true);
    expect(await all('SELECT build_id FROM ledger_period_build_gc WHERE group_id=?', fixture.groupId)).toEqual([]);
    expect(await all('SELECT build_id,currency,person_id,net_minor FROM ledger_period_balances WHERE group_id=? AND month=? AND build_id=?', fixture.groupId, period.month, activeBuildId)).toEqual([
      { build_id: activeBuildId, currency: 'USD', person_id: fixture.personA, net_minor: 100 },
      { build_id: activeBuildId, currency: 'USD', person_id: fixture.personB, net_minor: -100 },
    ]);
    expect(await all('SELECT build_id,currency,gross_minor FROM ledger_period_totals WHERE group_id=? AND month=? AND build_id=?', fixture.groupId, period.month, activeBuildId)).toEqual([
      { build_id: activeBuildId, currency: 'USD', gross_minor: 100 },
    ]);

    const continuousA = await createFixture('continuous-a');
    const continuousB = await createFixture('continuous-b');
    await addExpense(continuousA, `${continuousA.groupId}-first`, 10, '2026-08-20');
    await addExpense(continuousA, `${continuousA.groupId}-second`, 10, '2026-08-21');
    await addExpense(continuousB, `${continuousB.groupId}-first`, 10, '2026-08-20');
    await addExpense(continuousB, `${continuousB.groupId}-second`, 10, '2026-08-21');
    const queueEpoch = Date.now();
    await exec(`
      UPDATE ledger_summary_state SET status='pending',discovery_complete=1,maintenance_due=1,available_at_ms=${queueEpoch}
        WHERE group_id IN ('${continuousA.groupId}','${continuousB.groupId}');
    `);
    const retry = await createFixture('retry');
    await exec(`
      INSERT INTO ledger_period_state(group_id,month,status,source_generation,retry_at_ms,updated_at)
        VALUES('${retry.groupId}','2026-01-01','failed',1,${Date.now() + 60000},'2026-01-01');
      UPDATE ledger_summary_state SET status='pending',discovery_complete=1,maintenance_due=1,available_at_ms=${queueEpoch + 60000} WHERE group_id='${retry.groupId}';
    `);
    await repo.monthlySummaryMaintenance({ maxGroups: 2, maxMonths: 1, chunkSize: 1 });
    expect(await all('SELECT group_id,maintenance_due FROM ledger_summary_state WHERE group_id IN (?,?) ORDER BY group_id', continuousA.groupId, continuousB.groupId)).toEqual([
      { group_id: continuousA.groupId, maintenance_due: 1 },
      { group_id: continuousB.groupId, maintenance_due: 1 },
    ]);
    expect(await all('SELECT status,retry_at_ms FROM ledger_period_state WHERE group_id=?', retry.groupId)).toEqual([{ status: 'failed', retry_at_ms: expect.any(Number) }]);
    await exec('UPDATE ledger_summary_state SET available_at_ms=? WHERE group_id IN (?,?)', Date.now() + 60000, continuousA.groupId, continuousB.groupId);
    await exec('UPDATE ledger_period_state SET retry_at_ms=? WHERE group_id=?', Date.now() - 1, retry.groupId);
    await exec('UPDATE ledger_summary_state SET available_at_ms=? WHERE group_id=?', Date.now() - 1, retry.groupId);
    await repo.monthlySummaryMaintenance({ maxGroups: 1, maxMonths: 1, chunkSize: 1 });
    expect(await all('SELECT status,retry_at_ms FROM ledger_period_state WHERE group_id=?', retry.groupId)).toEqual([{ status: 'ready', retry_at_ms: null }]);
  });

  it('repairs old-worker direct SQL writes after a deadline and an expired lease', async () => {
    const fixture = await createFixture('old-worker');
    await addExpense(fixture, `${fixture.groupId}-expense`, 100, '2026-01-01');
    const repo = new Repository(db);
    await maintainUntilReady(repo, fixture.groupId);
    await exec(`
      UPDATE expenses SET amount_minor=150,updated_at='2026-02-01' WHERE id='${fixture.groupId}-expense';
      UPDATE payers SET amount_minor=150 WHERE expense_id='${fixture.groupId}-expense';
      UPDATE splits SET amount_minor=150 WHERE expense_id='${fixture.groupId}-expense';
      UPDATE ledger_summary_state SET lease_owner='expired-worker',lease_until_ms=0,available_at_ms=0 WHERE group_id='${fixture.groupId}';
    `);
    expect(await all('SELECT status,maintenance_due,lease_owner FROM ledger_summary_state WHERE group_id=?', fixture.groupId)).toEqual([{ status: 'dirty', maintenance_due: 1, lease_owner: 'expired-worker' }]);
    await expect(repo.monthlySummaryMaintenance({ maxGroups: 1, deadlineMs: Date.now() - 1 })).resolves.toMatchObject({ groupsScanned: 0, capped: true });
    await expect(repo.balanceProjection(fixture.groupId)).resolves.toMatchObject({ ready: false, rows: [
      { currency: 'USD', personId: fixture.personA, netMinor: 150 },
      { currency: 'USD', personId: fixture.personB, netMinor: -150 },
    ] });
    await maintainUntilReady(repo, fixture.groupId);
    expect(await all('SELECT status,maintenance_due,lease_owner FROM ledger_summary_state WHERE group_id=?', fixture.groupId)).toEqual([{ status: 'ready', maintenance_due: 0, lease_owner: null }]);
    await expect(repo.balanceProjection(fixture.groupId)).resolves.toMatchObject({ ready: true, rows: [
      { currency: 'USD', personId: fixture.personA, netMinor: 150 },
      { currency: 'USD', personId: fixture.personB, netMinor: -150 },
    ] });
  });

  it('round-robins deleted-group cleanup and drains audit metadata before removing parents', async () => {
    const first = await createFixture('purge-first');
    const second = await createFixture('purge-second');
    await exec(`
      UPDATE groups SET deleted_at='2026-01-01T00:00:00.000Z' WHERE id IN ('${first.groupId}','${second.groupId}');
        INSERT INTO audit_events(id,group_id,entity_type,entity_id,version,action,actor_id,occurred_at)
        VALUES('${first.groupId}-audit-1','${first.groupId}','expense','${first.groupId}-missing-1',1,'create','${first.userA}','2026-01-01'),
              ('${first.groupId}-audit-2','${first.groupId}','expense','${first.groupId}-missing-2',1,'create','${first.userA}','2026-01-01'),
              ('${second.groupId}-audit-1','${second.groupId}','expense','${second.groupId}-missing-1',1,'create','${second.userA}','2026-01-01');
    `);
    const repo = new Repository(db);
    const firstPass = await repo.purgeExpiredData('2026-03-01T00:00:00.000Z', { maxTransactions: 1, maxGroups: 1 });
    expect(firstPass.groupsScanned).toBe(1);
    expect(firstPass.groupsPurged).toBe(0);
    const secondPass = await repo.purgeExpiredData('2026-03-01T00:00:00.000Z', { maxTransactions: 1, maxGroups: 1 });
    expect(secondPass.groupsScanned).toBe(1);
    expect(secondPass.groupsPurged).toBe(0);
    expect(await all('SELECT COUNT(*) AS count FROM audit_events WHERE group_id=?', first.groupId)).toEqual([{ count: 1 }]);
    for (let pass = 0; pass < 12; pass += 1) {
      if (!(await all('SELECT id FROM groups WHERE id IN (?,?)', first.groupId, second.groupId)).length) break;
      await repo.purgeExpiredData('2026-03-01T00:00:00.000Z', { maxTransactions: 1, maxGroups: 1 });
    }
    expect(await all('SELECT id FROM groups WHERE id IN (?,?)', first.groupId, second.groupId)).toEqual([]);
    expect(await all('SELECT group_id FROM audit_events WHERE group_id IN (?,?)', first.groupId, second.groupId)).toEqual([]);
    expect(await all('SELECT group_id FROM group_members WHERE group_id IN (?,?)', first.groupId, second.groupId)).toEqual([]);
  });
});
