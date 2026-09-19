import { afterEach, describe, expect, it } from 'vitest';
import type { D1PreparedStatement } from '@cloudflare/workers-types';
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
const fixtureGroups = new Set<string>();

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
  fixtureGroups.add(fixture.groupId);
  return fixture;
}

afterEach(async () => {
  for (const groupId of fixtureGroups) await exec('DELETE FROM ledger_summary_state WHERE group_id=?', groupId);
  fixtureGroups.clear();
});

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

function databaseWithCreditDefaultRace(expenseId: string) {
  let raced = false;
  return {
    prepare(sql: string) {
      const prepared = db.prepare(sql);
      const wrap = <T extends D1PreparedStatement>(bound: T) => new Proxy(bound, {
        get(target, property, receiver) {
          if (property !== 'all') return Reflect.get(target, property, receiver);
          return async <R>() => {
            const result = await target.all<R>();
            if (!raced && sql.includes('FROM expenses e JOIN json_each')) {
              raced = true;
              await db.prepare('UPDATE expenses SET amount_minor=?,version=? WHERE id=?').bind(90, 2, expenseId).run();
              await db.prepare('UPDATE payers SET amount_minor=? WHERE expense_id=?').bind(90, expenseId).run();
              await db.prepare('UPDATE splits SET amount_minor=? WHERE expense_id=?').bind(90, expenseId).run();
            }
            return result;
          };
        },
      });
      return {
        bind(...args: unknown[]) {
          return wrap(prepared.bind(...args));
        },
      };
    },
    batch: (statements: D1PreparedStatement[]) => db.batch(statements),
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

  it('includes signed credit allocations in both fallback and ready monthly projections', async () => {
    const fixture = await createFixture('credit-projection');
    await addExpense(fixture, `${fixture.groupId}-expense`, 100, '2026-01-01');
    const repo = new Repository(db);
    await repo.createCredit(fixture.groupId, fixture.userA, {
      subtype: 'refund', delivery_mode: 'direct_provider_offset', amount_minor: 40,
      currency: 'USD', date: '2026-01-02', applications: [{ expense_id: `${fixture.groupId}-expense`, amount_minor: 40 }], allocations: [],
    });
    await expect(repo.balanceProjection(fixture.groupId)).resolves.toEqual({ ready: false, rows: [
      { currency: 'USD', personId: fixture.personA, netMinor: 60 },
      { currency: 'USD', personId: fixture.personB, netMinor: -60 },
    ] });
    await maintainUntilReady(repo, fixture.groupId);
    await expect(repo.balanceProjection(fixture.groupId)).resolves.toEqual({ ready: true, rows: [
      { currency: 'USD', personId: fixture.personA, netMinor: 60 },
      { currency: 'USD', personId: fixture.personB, netMinor: -60 },
    ] });
  });

  it('rejects a stale default-allocation snapshot inside the credit write batch', async () => {
    const fixture = await createFixture('credit-default-conflict');
    const expenseId = `${fixture.groupId}-expense`;
    await addExpense(fixture, expenseId, 100, '2026-01-01');
    const racedDb = databaseWithCreditDefaultRace(expenseId);
    const input = {
      subtype: 'refund' as const, delivery_mode: 'direct_provider_offset' as const, amount_minor: 40,
      currency: 'USD' as const, date: '2026-01-02', applications: [{ expense_id: expenseId, amount_minor: 40 }], allocations: [], client_operation_id: 'credit-race-retry',
    };
    const repo = new Repository(racedDb as never);
    await expect(repo.createCredit(fixture.groupId, fixture.userA, input)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(racedDb.raced).toBe(true);
    expect(await all('SELECT COUNT(*) AS count FROM credits WHERE group_id=?', fixture.groupId)).toEqual([{ count: 0 }]);
    expect(await all('SELECT COUNT(*) AS count FROM idempotency_keys WHERE kind=? AND operation_id=?', 'credit.create', input.client_operation_id)).toEqual([{ count: 0 }]);
    const retry = await repo.createCredit(fixture.groupId, fixture.userA, input);
    expect(retry.amountMinor).toBe(40);
    await expect(repo.createCredit(fixture.groupId, fixture.userA, input)).resolves.toMatchObject({ id: retry.id });
    await expect(repo.createCredit(fixture.groupId, fixture.userA, { ...input, amount_minor: 30, applications: [{ expense_id: expenseId, amount_minor: 30 }] })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('rejects a member reimbursement when the linked split changes during derivation without poisoning the idempotency key', async () => {
    const fixture = await createFixture('member-credit-default-conflict');
    const expenseId = `${fixture.groupId}-expense`;
    await addExpense(fixture, expenseId, 100, '2026-01-01');
    const racedDb = databaseWithCreditDefaultRace(expenseId);
    const input = {
      subtype: 'refund' as const, delivery_mode: 'member_reimbursement' as const, amount_minor: 40,
      currency: 'USD' as const, date: '2026-01-02', applications: [{ expense_id: expenseId, amount_minor: 40 }],
      allocations: [{ person_id: fixture.personA, allocation_type: 'recipient' as const, amount_minor: 40 }], client_operation_id: 'member-credit-race-retry',
    };
    const repo = new Repository(racedDb as never);
    await expect(repo.createCredit(fixture.groupId, fixture.userA, input)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await all('SELECT COUNT(*) AS count FROM credits WHERE group_id=?', fixture.groupId)).toEqual([{ count: 0 }]);
    expect(await all('SELECT COUNT(*) AS count FROM idempotency_keys WHERE kind=? AND operation_id=?', 'credit.create', input.client_operation_id)).toEqual([{ count: 0 }]);
  });

  it('restricts direct-provider recipients to payers and refreshes defaults only when applications change', async () => {
    const fixture = await createFixture('credit-recipient-rules');
    const firstExpense = `${fixture.groupId}-expense-a`, secondExpense = `${fixture.groupId}-expense-b`;
    await addExpense(fixture, firstExpense, 100, '2026-01-01');
    await exec(`
      INSERT INTO expenses(id,group_id,description,amount_minor,currency,expense_date,created_by,created_at,updated_at,version)
        VALUES('${secondExpense}','${fixture.groupId}','${secondExpense}',100,'USD','2026-01-02','${fixture.userA}','2026-01-02','2026-01-02',1);
      INSERT INTO payers(expense_id,person_id,amount_minor) VALUES('${secondExpense}','${fixture.personB}',100);
      INSERT INTO splits(expense_id,person_id,amount_minor) VALUES('${secondExpense}','${fixture.personA}',100);
    `);
    const repo = new Repository(db);
    const created = await repo.createCredit(fixture.groupId, fixture.userA, {
      subtype: 'refund', delivery_mode: 'direct_provider_offset', amount_minor: 40, currency: 'USD', date: '2026-01-03',
      applications: [{ expense_id: firstExpense, amount_minor: 40 }], allocations: [],
    });
    expect(created.allocations).toEqual([
      { personId: fixture.personB, allocationType: 'beneficiary', amountMinor: 40 },
      { personId: fixture.personA, allocationType: 'recipient', amountMinor: 40 },
    ]);
    const noteEdit = await repo.updateCredit(created.id, fixture.userA, {
      subtype: created.subtype, delivery_mode: created.deliveryMode, amount_minor: created.amountMinor, currency: created.currency, date: '2026-01-04', note: 'Confirmed', version: created.version,
       applications: [{ expense_id: firstExpense, amount_minor: 40 }], allocations: [],
    });
    expect(noteEdit.allocations).toEqual(created.allocations);
    const refreshed = await repo.updateCredit(noteEdit.id, fixture.userA, {
      subtype: noteEdit.subtype, delivery_mode: noteEdit.deliveryMode, amount_minor: 40, currency: 'USD', date: noteEdit.date, note: noteEdit.note,
       version: noteEdit.version, applications: [{ expense_id: secondExpense, amount_minor: 40 }], allocations: [],
    });
    expect(refreshed.allocations).toEqual([
      { personId: fixture.personA, allocationType: 'beneficiary', amountMinor: 40 },
      { personId: fixture.personB, allocationType: 'recipient', amountMinor: 40 },
    ]);
    await expect(repo.updateCredit(refreshed.id, fixture.userA, {
      subtype: refreshed.subtype, delivery_mode: refreshed.deliveryMode, amount_minor: 40, currency: 'USD', date: refreshed.date, note: refreshed.note,
      version: refreshed.version, applications: [{ expense_id: secondExpense, amount_minor: 40 }], allocations: [
        { person_id: fixture.personA, allocation_type: 'recipient', amount_minor: 40 },
        { person_id: fixture.personB, allocation_type: 'beneficiary', amount_minor: 40 },
      ],
    })).rejects.toMatchObject({ code: 'INVALID_CREDIT' });
  });

  it('derives and persists linked reimbursement beneficiaries from expense splits with exact remainder parity', async () => {
    const fixture = await createFixture('member-reimbursement-derived-beneficiaries');
    const expenseId = `${fixture.groupId}-expense`;
    await addExpense(fixture, expenseId, 100, '2026-01-01');
    await exec('DELETE FROM splits WHERE expense_id=?', expenseId);
    await exec('INSERT INTO splits(expense_id,person_id,amount_minor) VALUES(?,?,?),(?,?,?)', expenseId, fixture.personA, 33, expenseId, fixture.personB, 67);
    const created = await new Repository(db).createCredit(fixture.groupId, fixture.userA, {
      subtype: 'refund', delivery_mode: 'member_reimbursement', amount_minor: 10, currency: 'USD', date: '2026-01-02',
      applications: [{ expense_id: expenseId, amount_minor: 10 }],
      allocations: [{ person_id: fixture.personA, allocation_type: 'recipient', amount_minor: 10 }],
    });
    expect(created.allocations).toEqual([
      { personId: fixture.personA, allocationType: 'beneficiary', amountMinor: 4 },
      { personId: fixture.personB, allocationType: 'beneficiary', amountMinor: 6 },
      { personId: fixture.personA, allocationType: 'recipient', amountMinor: 10 },
    ]);
    await expect(all('SELECT allocation_type,amount_minor FROM credit_allocations WHERE credit_id=? ORDER BY allocation_type,person_id', created.id)).resolves.toEqual([
      { allocation_type: 'beneficiary', amount_minor: 4 },
      { allocation_type: 'beneficiary', amount_minor: 6 },
      { allocation_type: 'recipient', amount_minor: 10 },
    ]);
  });

  it('allows linked credit snapshots to retain a removed expense participant while keeping standalone allocations active-only', async () => {
    const fixture = await createFixture('removed-credit-participant');
    const expenseId = `${fixture.groupId}-expense`;
    await addExpense(fixture, expenseId, 100, '2026-01-01');
    const repo = new Repository(db);
    await repo.removeMember(fixture.groupId, fixture.personB, fixture.userA);
    const input = {
      subtype: 'refund' as const, delivery_mode: 'member_reimbursement' as const, amount_minor: 40, currency: 'USD' as const, date: '2026-01-02',
      applications: [{ expense_id: expenseId, amount_minor: 40 }], allocations: [{ person_id: fixture.personA, allocation_type: 'recipient' as const, amount_minor: 40 }],
    };
    const created = await repo.createCredit(fixture.groupId, fixture.userA, input);
    expect(created.allocations).toContainEqual({ personId: fixture.personB, allocationType: 'beneficiary', amountMinor: 40 });
    await expect(repo.createCredit(fixture.groupId, fixture.userA, {
      ...input, applications: [], allocations: [{ person_id: fixture.personB, allocation_type: 'recipient', amount_minor: 40 }, { person_id: fixture.personA, allocation_type: 'beneficiary', amount_minor: 40 }],
    })).rejects.toBeInstanceOf(Error);
  });

  it('permits note-only updates to preserve removed linked participants and their accounting snapshot', async () => {
    const fixture = await createFixture('removed-credit-update');
    const expenseId = `${fixture.groupId}-expense`;
    await addExpense(fixture, expenseId, 100, '2026-01-01');
    const repo = new Repository(db);
    const created = await repo.createCredit(fixture.groupId, fixture.userA, {
      subtype: 'refund', delivery_mode: 'member_reimbursement', amount_minor: 40, currency: 'USD', date: '2026-01-02',
      applications: [{ expense_id: expenseId, amount_minor: 40 }], allocations: [{ person_id: fixture.personA, allocation_type: 'recipient', amount_minor: 40 }],
    });
    await repo.removeMember(fixture.groupId, fixture.personB, fixture.userA);
    const updated = await repo.updateCredit(created.id, fixture.userA, {
      subtype: created.subtype, delivery_mode: created.deliveryMode, amount_minor: created.amountMinor, currency: created.currency, date: created.date, note: 'Receipt confirmed', version: created.version,
      applications: [{ expense_id: expenseId, amount_minor: 40 }], allocations: [{ person_id: fixture.personA, allocation_type: 'recipient', amount_minor: 40 }],
    });
    expect(updated.note).toBe('Receipt confirmed');
    expect(updated.allocations).toEqual(created.allocations);
  });

  it('preserves a removed custom beneficiary only when the update keeps its persisted snapshot', async () => {
    const fixture = await createFixture('removed-custom-beneficiary');
    const customPerson = `${fixture.groupId}-custom-person`;
    await exec(`
      INSERT INTO people(id,name,created_at) VALUES('${customPerson}','Custom beneficiary','2026-01-01');
      INSERT INTO group_members(group_id,person_id,joined_at,role) VALUES('${fixture.groupId}','${customPerson}','2026-01-01','member');
    `);
    const expenseId = `${fixture.groupId}-expense`;
    await addExpense(fixture, expenseId, 100, '2026-01-01');
    const repo = new Repository(db);
    const created = await repo.createCredit(fixture.groupId, fixture.userA, {
      subtype: 'refund', delivery_mode: 'member_reimbursement', amount_minor: 40, currency: 'USD', date: '2026-01-02',
      applications: [{ expense_id: expenseId, amount_minor: 40 }], allocations: [
        { person_id: fixture.personA, allocation_type: 'recipient', amount_minor: 40 },
        { person_id: customPerson, allocation_type: 'beneficiary', amount_minor: 40 },
      ],
    });
    await repo.removeMember(fixture.groupId, customPerson, fixture.userA);
    await expect(repo.createCredit(fixture.groupId, fixture.userA, {
      subtype: 'refund', delivery_mode: 'member_reimbursement', amount_minor: 40, currency: 'USD', date: '2026-01-02',
      applications: [{ expense_id: expenseId, amount_minor: 40 }], allocations: [
        { person_id: fixture.personA, allocation_type: 'recipient', amount_minor: 40 },
        { person_id: customPerson, allocation_type: 'beneficiary', amount_minor: 40 },
      ],
    })).rejects.toBeInstanceOf(Error);
    await expect(repo.createCredit(fixture.groupId, fixture.userA, {
      subtype: 'refund', delivery_mode: 'member_reimbursement', amount_minor: 40, currency: 'USD', date: '2026-01-02',
      applications: [{ expense_id: expenseId, amount_minor: 40 }], allocations: [
        { person_id: customPerson, allocation_type: 'recipient', amount_minor: 40 },
        { person_id: fixture.personA, allocation_type: 'beneficiary', amount_minor: 40 },
      ],
    })).rejects.toBeInstanceOf(Error);
    const unchanged = await repo.updateCredit(created.id, fixture.userA, {
      subtype: created.subtype, delivery_mode: created.deliveryMode, amount_minor: created.amountMinor, currency: created.currency,
      date: created.date, note: 'Receipt confirmed', version: created.version,
      applications: [{ expense_id: expenseId, amount_minor: 40 }], allocations: created.allocations.map((allocation) => ({
        person_id: allocation.personId, allocation_type: allocation.allocationType, amount_minor: allocation.amountMinor,
      })),
    });
    expect(unchanged.allocations).toEqual(created.allocations);
    await repo.removeMember(fixture.groupId, fixture.personB, fixture.userA);
    await expect(repo.updateCredit(unchanged.id, fixture.userA, {
      subtype: unchanged.subtype, delivery_mode: unchanged.deliveryMode, amount_minor: unchanged.amountMinor, currency: unchanged.currency,
      date: unchanged.date, note: unchanged.note, version: unchanged.version,
      applications: [{ expense_id: expenseId, amount_minor: 40 }], allocations: [
        { person_id: fixture.personA, allocation_type: 'recipient', amount_minor: 40 },
        { person_id: fixture.personB, allocation_type: 'beneficiary', amount_minor: 40 },
      ],
    })).rejects.toBeInstanceOf(Error);
  });

  it('derives direct-provider allocations exactly from every linked bill and rejects overrides', async () => {
    const fixture = await createFixture('credit-exact-proportions');
    const firstExpense = `${fixture.groupId}-expense-a`, secondExpense = `${fixture.groupId}-expense-b`;
    await exec(`
      INSERT INTO expenses(id,group_id,description,amount_minor,currency,expense_date,created_by,created_at,updated_at,version) VALUES
        ('${firstExpense}','${fixture.groupId}','First',100,'USD','2026-01-01','${fixture.userA}','2026-01-01','2026-01-01',1),
        ('${secondExpense}','${fixture.groupId}','Second',80,'USD','2026-01-02','${fixture.userA}','2026-01-02','2026-01-02',1);
      INSERT INTO payers(expense_id,person_id,amount_minor) VALUES
        ('${firstExpense}','${fixture.personA}',60),('${firstExpense}','${fixture.personB}',40),('${secondExpense}','${fixture.personB}',80);
      INSERT INTO splits(expense_id,person_id,amount_minor) VALUES
        ('${firstExpense}','${fixture.personA}',25),('${firstExpense}','${fixture.personB}',75),('${secondExpense}','${fixture.personA}',40),('${secondExpense}','${fixture.personB}',40);
    `);
    const repo = new Repository(db);
    const applications = [{ expense_id: firstExpense, amount_minor: 40 }, { expense_id: secondExpense, amount_minor: 60 }];
    await expect(repo.createCredit(fixture.groupId, fixture.userA, {
      subtype: 'refund', delivery_mode: 'direct_provider_offset', amount_minor: 100, currency: 'USD', date: '2026-01-03', applications,
      allocations: [{ person_id: fixture.personA, allocation_type: 'recipient', amount_minor: 100 }, { person_id: fixture.personB, allocation_type: 'beneficiary', amount_minor: 100 }],
    })).rejects.toMatchObject({ code: 'INVALID_CREDIT' });
    const credit = await repo.createCredit(fixture.groupId, fixture.userA, {
      subtype: 'refund', delivery_mode: 'direct_provider_offset', amount_minor: 100, currency: 'USD', date: '2026-01-03', applications, allocations: [],
    });
    expect(credit.allocations).toEqual([
      { personId: fixture.personA, allocationType: 'beneficiary', amountMinor: 40 },
      { personId: fixture.personB, allocationType: 'beneficiary', amountMinor: 60 },
      { personId: fixture.personA, allocationType: 'recipient', amountMinor: 24 },
      { personId: fixture.personB, allocationType: 'recipient', amountMinor: 76 },
    ]);
    await expect(repo.updateCredit(credit.id, fixture.userA, {
      subtype: credit.subtype, delivery_mode: credit.deliveryMode, amount_minor: credit.amountMinor, currency: credit.currency, date: credit.date, note: 'Reviewed', version: credit.version,
      applications, allocations: [],
    })).resolves.toMatchObject({ allocations: credit.allocations });
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
    const purgeExpenseId = `${first.groupId}-purge-expense`;
    await addExpense(first, purgeExpenseId, 20, '2026-01-01');
    const purgeCredit = await new Repository(db).createCredit(first.groupId, first.userA, {
      subtype: 'refund', delivery_mode: 'member_reimbursement', amount_minor: 10, currency: 'USD', date: '2026-01-02',
      applications: [{ expense_id: purgeExpenseId, amount_minor: 10 }], allocations: [
        { person_id: first.personA, allocation_type: 'recipient', amount_minor: 10 },
        { person_id: first.personB, allocation_type: 'beneficiary', amount_minor: 10 },
      ],
    });
    await exec(`
      UPDATE groups SET deleted_at='2026-01-01T00:00:00.000Z' WHERE id IN ('${first.groupId}','${second.groupId}');
        INSERT INTO audit_events(id,group_id,entity_type,entity_id,version,action,actor_id,occurred_at)
        VALUES('${first.groupId}-audit-1','${first.groupId}','expense','${first.groupId}-missing-1',1,'create','${first.userA}','2026-01-01'),
              ('${first.groupId}-audit-2','${first.groupId}','expense','${first.groupId}-missing-2',1,'create','${first.userA}','2026-01-01'),
              ('${second.groupId}-audit-1','${second.groupId}','expense','${second.groupId}-missing-1',1,'create','${second.userA}','2026-01-01'),
              ('${first.groupId}-credit-audit','${first.groupId}','credit','${purgeCredit.id}',2,'update','${first.userA}','2026-01-01');
        INSERT INTO revisions(id,entity_type,entity_id,revision,snapshot_json,created_by,created_at)
          VALUES('${first.groupId}-credit-revision','credit','${purgeCredit.id}',1,'{}','${first.userA}','2026-01-01');
    `);
    const repo = new Repository(db);
    const firstPass = await repo.purgeExpiredData('2026-03-01T00:00:00.000Z', { maxTransactions: 1, maxGroups: 1 });
    expect(firstPass.groupsScanned).toBe(1);
    expect(firstPass.groupsPurged).toBe(0);
    const secondPass = await repo.purgeExpiredData('2026-03-01T00:00:00.000Z', { maxTransactions: 1, maxGroups: 1 });
    expect(secondPass.groupsScanned).toBe(1);
    expect(secondPass.groupsPurged).toBe(0);
    expect(await all('SELECT COUNT(*) AS count FROM audit_events WHERE group_id=?', first.groupId)).toEqual([{ count: 4 }]);
    for (let pass = 0; pass < 30; pass += 1) {
      if (!(await all('SELECT id FROM groups WHERE id IN (?,?)', first.groupId, second.groupId)).length) break;
      await repo.purgeExpiredData('2026-03-01T00:00:00.000Z', { maxTransactions: 1, maxGroups: 1 });
    }
    expect(await all('SELECT id FROM groups WHERE id IN (?,?)', first.groupId, second.groupId)).toEqual([]);
    expect(await all('SELECT group_id FROM audit_events WHERE group_id IN (?,?)', first.groupId, second.groupId)).toEqual([]);
    expect(await all('SELECT group_id FROM group_members WHERE group_id IN (?,?)', first.groupId, second.groupId)).toEqual([]);
    expect(await all('SELECT group_id FROM credits WHERE group_id IN (?,?)', first.groupId, second.groupId)).toEqual([]);
    expect(await all('SELECT entity_id FROM revisions WHERE entity_type=? AND entity_id=?', 'credit', purgeCredit.id)).toEqual([]);
  });
});
