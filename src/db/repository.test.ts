import { describe, expect, it } from 'vitest';
import { Repository } from './repository';
import type { ExpenseInput, SettlementInput } from '../shared/schemas';

class FakeDb {
  claim: Record<string, unknown> | null = null;
  expense: Record<string, unknown> | null = null;
  settlement: Record<string, unknown> | null = null;
  payers: Array<Record<string, unknown>> = [];
  splits: Array<Record<string, unknown>> = [];
  overflow = false;
  prepare(sql: string) { return new FakeStatement(this, sql); }
  async batch(statements: FakeStatement[]) { if (this.overflow) throw new Error('SQLITE_CONSTRAINT: BALANCE_OVERFLOW'); for (const statement of statements) statement.execute(); return []; }
}
class FakeStatement {
  args: unknown[] = [];
  constructor(private readonly db: FakeDb, private readonly sql: string) {}
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>() {
    if (this.sql.includes('FROM idempotency_keys')) {
      const [kind, userId, groupId, operationId] = this.args;
      return this.db.claim && this.db.claim.kind === kind && this.db.claim.userId === userId && this.db.claim.groupId === groupId && this.db.claim.operationId === operationId ? this.db.claim as T : null;
    }
    if (this.sql.includes('FROM expenses')) return this.db.expense as T | null;
    if (this.sql.includes('FROM settlements')) return this.db.settlement as T | null;
    if (this.sql.includes('FROM revisions')) return null;
    return null;
  }
  async all<T>() { if (this.sql.includes('FROM payers')) return { results: this.db.payers as T[] }; if (this.sql.includes('FROM splits')) return { results: this.db.splits as T[] }; return { results: [] as T[] }; }
  async run() { this.execute(); return {}; }
  execute() {
    if (this.sql.includes('INSERT INTO idempotency_keys')) { const [kind, userId, groupId, operationId, requestHash, entityId] = this.args; this.db.claim = { kind, userId, groupId, operationId, request_hash: requestHash, requestHash, entityId, entity_id: entityId }; }
    if (this.sql.includes('INSERT INTO expenses(')) { const [id, groupId, description, amountMinor, currency, date, category, notes, createdBy, createdAt, updatedAt, clientOperationId] = this.args; this.db.expense = { id, group_id: groupId, description, amount_minor: amountMinor, currency, expense_date: date, category, notes, created_by: createdBy, created_at: createdAt, updated_at: updatedAt, client_operation_id: clientOperationId, version: 1 }; }
    if (this.sql.includes('INSERT INTO settlements(')) { const [id, groupId, fromPersonId, toPersonId, amountMinor, currency, date, note, createdBy, createdAt, updatedAt] = this.args; this.db.settlement = { id, group_id: groupId, from_person_id: fromPersonId, to_person_id: toPersonId, amount_minor: amountMinor, currency, settlement_date: date, note, created_by: createdBy, created_at: createdAt, updated_at: updatedAt, version: 1 }; }
    if (this.sql.includes('INSERT INTO payers(')) this.db.payers.push({ person_id: this.args[1], amount_minor: this.args[2] });
    if (this.sql.includes('INSERT INTO splits(')) this.db.splits.push({ person_id: this.args[1], amount_minor: this.args[2], metadata_json: this.args[3] });
  }
}

const input = (description: string): ExpenseInput => ({ description, amount_minor: 100, currency: 'USD', date: '2025-01-01', payers: [{ person_id: '00000000-0000-4000-8000-000000000001', amount_minor: 100 }], splits: [{ person_id: '00000000-0000-4000-8000-000000000001', amount_minor: 100 }], client_operation_id: 'retry-1' });

class StaleMutationDb {
  expense = { id: 'expense-1', group_id: 'group-1', description: 'Lunch', amount_minor: 100, currency: 'USD', expense_date: '2025-01-01', created_by: 'user-1', created_at: '', updated_at: '', version: 1 };
  settlement = { id: 'settlement-1', group_id: 'group-1', from_person_id: 'person-1', to_person_id: 'person-2', amount_minor: 100, currency: 'USD', settlement_date: '2025-01-01', created_at: '', updated_at: '', version: 1 };
  batches = 0;
  failure: Error | undefined;
  prepare(sql: string) { return new StaleMutationStatement(this, sql); }
  async batch(_statements: StaleMutationStatement[]) { this.batches += 1; throw this.failure || new Error('UNIQUE constraint failed: revisions.entity_type, revisions.entity_id, revisions.revision'); }
}
class StaleMutationStatement {
  args: unknown[] = [];
  constructor(private readonly db: StaleMutationDb, private readonly sql: string) {}
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>() {
    if (this.sql.includes('FROM expenses')) return this.db.expense as T;
    if (this.sql.includes('FROM settlements')) return this.db.settlement as T;
    return null;
  }
  async all<T>() { return { results: (this.sql.includes('FROM payers') || this.sql.includes('FROM splits') ? [] : []) as T[] }; }
}

class BulkHydrationDb {
  readonly rows: Array<Record<string, unknown>>;
  readonly payers: Array<Record<string, unknown>>;
  readonly splits: Array<Record<string, unknown>>;
  queries = 0;
  constructor(count: number) {
    this.rows = Array.from({ length: count }, (_, index) => ({ id: `expense-${index}`, group_id: 'group-1', description: `Expense ${index}`, amount_minor: 100, currency: 'USD', expense_date: '2025-01-01', created_by: 'user-1', created_at: '', updated_at: '', version: 1 }));
    this.payers = this.rows.map((row) => ({ expense_id: row.id, person_id: 'person-1', amount_minor: 100 }));
    this.splits = this.rows.map((row) => ({ expense_id: row.id, person_id: 'person-1', amount_minor: 100, metadata_json: null }));
  }
  prepare(sql: string) { this.queries += 1; return new BulkHydrationStatement(this, sql); }
  async batch(_statements: unknown[]) { return []; }
}
class BulkHydrationStatement {
  args: unknown[] = [];
  constructor(private readonly db: BulkHydrationDb, private readonly sql: string) {}
  bind(...args: unknown[]) { this.args = args; return this; }
  async all<T>() {
    if (this.sql.includes('FROM expenses')) return { results: this.db.rows as T[] };
    const source = this.sql.includes('FROM payers') ? this.db.payers : this.db.splits;
    const ids = new Set(this.args.map(String));
    return { results: source.filter((row) => ids.has(String(row.expense_id))) as T[] };
  }
}

class FriendDb {
  batches: Array<Array<{ sql: string; args: unknown[] }>> = [];
  existing: Record<string, unknown> | null = null;
  prepare(sql: string) { return new FriendStatement(this, sql); }
  async batch(statements: FriendStatement[]) { this.batches.push(statements.map((statement) => ({ sql: statement.sql, args: statement.args }))); return []; }
}
class FriendStatement {
  args: unknown[] = [];
  constructor(private readonly db: FriendDb, readonly sql: string) {}
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>() {
    if (this.sql.includes('lower(email)')) return this.db.existing as T | null;
    if (this.sql.includes('FROM groups g JOIN')) return { id: 'group-1', name: 'With Friend', currency: 'USD', created_at: '', updated_at: '', role: 'owner', member_count: 2, counterpart_name: 'Friend' } as T;
    return null;
  }
}

class FriendIdempotencyDb {
  claim: Record<string, unknown> | null = null;
  person: Record<string, unknown> | null = null;
  creator: Record<string, unknown> | null = null;
  batches: Array<Array<{ sql: string; args: unknown[] }>> = [];
  race = false;
  claimCollision = false;
  prepare(sql: string) { return new FriendIdempotencyStatement(this, sql); }
  async batch(statements: FriendIdempotencyStatement[]) {
    this.batches.push(statements.map((statement) => ({ sql: statement.sql, args: statement.args })));
    if (this.claimCollision) { this.claimCollision = false; throw new Error('UNIQUE constraint failed: idempotency_keys.user_id, idempotency_keys.operation_id'); }
    if (this.race) { this.race = false; throw new Error('UNIQUE constraint failed: people.lower(email)'); }
    for (const statement of statements) {
      if (statement.sql.includes('INSERT INTO idempotency_keys')) this.claim = { kind: statement.args[0], user_id: statement.args[1], operation_id: statement.args[3], request_hash: statement.args[4], entity_id: statement.args[5] };
    }
  }
}
class FriendIdempotencyStatement {
  args: unknown[] = [];
  constructor(private readonly db: FriendIdempotencyDb, readonly sql: string) {}
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>() {
    if (this.sql.includes('FROM idempotency_keys')) return (this.db.claimCollision ? null : this.db.claim) as T | null;
    if (this.sql.includes('FROM people WHERE id=')) return this.db.creator as T | null;
    if (this.sql.includes('lower(email)')) return (this.db.race ? null : this.db.person) as T | null;
    if (this.sql.includes('FROM groups g JOIN')) return this.db.claim ? { id: this.args[0], name: 'With Friend', currency: 'USD', created_at: '', updated_at: '', role: 'owner', member_count: 2, counterpart_name: 'Friend' } as T : null;
    return null;
  }
}

class ActivityDb {
  sql = '';
  prepare(sql: string) { this.sql = sql; return new ActivityStatement(sql); }
}
class ActivityStatement {
  constructor(private readonly sql: string) {}
  bind(..._args: unknown[]) { return this; }
  async all<T>() {
    return { results: [
      { type: 'expense', id: 'expense-event', entity_id: 'expense-1', label: 'Lunch', amount_minor: 1250, currency: 'USD', transaction_date: '2026-01-02', created_at: '2026-01-02T10:00:00Z' },
      { type: 'settlement_revision', id: 'revision-1', entity_id: 'settlement-1', label: 'Paid back', amount_minor: 500, currency: 'EUR', transaction_date: '2026-01-01', from_name: 'A', to_name: 'B', created_at: '2026-01-02T11:00:00Z' },
    ] as T[] };
  }
}
class RevisionActivityDb {
  sql = '';
  prepare(sql: string) { this.sql = sql; return new RevisionActivityStatement(this, sql); }
}
class RevisionActivityStatement {
  constructor(private readonly db: RevisionActivityDb, private readonly sql: string) {}
  bind(..._args: unknown[]) { return this; }
  async all<T>() {
    const current = { group_id: 'group-1', version: 3, deleted_at: '2026-01-03T00:00:00Z' };
    const revisions = [
      { id: 'revision-1', entity_type: 'expense', entity_id: 'expense-1', revision: 1, description: 'Lunch', amount_minor: 100, currency: 'USD', transaction_date: '2026-01-01', created_at: '2026-01-02T10:00:00Z' },
      { id: 'revision-2', entity_type: 'expense', entity_id: 'expense-1', revision: 2, description: 'Dinner', amount_minor: 200, currency: 'USD', transaction_date: '2026-01-02', created_at: '2026-01-03T10:00:00Z' },
    ];
    const results = revisions.map((revision) => ({
      type: current.deleted_at && current.version === revision.revision + 1 ? 'expense_deleted' : 'expense_revision',
      id: revision.id, entity_id: revision.entity_id, label: revision.description, amount_minor: revision.amount_minor,
      currency: revision.currency, transaction_date: revision.transaction_date, created_at: revision.created_at,
    }));
    // Keep the fake grounded in raw revision/current-entity state rather than
    // returning a pre-mapped expected payload.
    if (!this.db.sql.includes('e.version = r.revision + 1')) throw new Error('revision deletion predicate missing');
    return { results: results as T[] };
  }
}

class GroupSummaryDb {
  sql = '';
  args: unknown[] = [];
  prepare(sql: string) { this.sql = sql; return this; }
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>() {
    return { id: 'group-1', name: 'Shared', currency: 'USD', created_at: '', updated_at: '', role: 'owner', member_count: 2, counterpart_name: 'Friend', balance_summaries: JSON.stringify([{ currency: 'USD', net_minor: 500 }, { currency: 'EUR', net_minor: -250 }]) } as T;
  }
  async all<T>() {
    return { results: [{ id: 'group-1', name: 'Shared', currency: 'USD', created_at: '', updated_at: '', role: 'owner', member_count: 2, counterpart_name: 'Friend', balance_summaries: JSON.stringify([{ currency: 'USD', net_minor: 500 }, { currency: 'EUR', net_minor: -250 }]) }] as T[] };
  }
}

describe('repository idempotency', () => {
  it('returns the original entity for a same-payload retry and rejects a mismatch', async () => {
    const repo = new Repository(new FakeDb() as never);
    const first = await repo.createExpense('00000000-0000-4000-8000-000000000010', 'user-1', input('Lunch'));
    expect(first?.clientOperationId).toBe('retry-1');
    const retry = await repo.createExpense('00000000-0000-4000-8000-000000000010', 'user-1', input('Lunch'));
    expect(retry?.id).toBe(first?.id);
    await expect(repo.createExpense('00000000-0000-4000-8000-000000000010', 'user-1', input('Dinner'))).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('also returns the original settlement for a same-payload retry', async () => {
    const settlement = { from_person_id: '00000000-0000-4000-8000-000000000001', to_person_id: '00000000-0000-4000-8000-000000000002', amount_minor: 100, currency: 'USD' as const, date: '2025-01-01', client_operation_id: 'settle-retry-1' };
    const repo = new Repository(new FakeDb() as never);
    const first = await repo.createSettlement('00000000-0000-4000-8000-000000000010', 'user-1', settlement);
    const retry = await repo.createSettlement('00000000-0000-4000-8000-000000000010', 'user-1', settlement);
    expect(retry?.id).toBe(first?.id);
    await expect(repo.createSettlement('00000000-0000-4000-8000-000000000010', 'user-1', { ...settlement, amount_minor: 200 })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
});

describe('repository mutation safety', () => {
  const settlementInput: SettlementInput = { from_person_id: '00000000-0000-4000-8000-000000000001', to_person_id: '00000000-0000-4000-8000-000000000002', amount_minor: 100, currency: 'USD', date: '2025-01-01', version: 1 };

  it('turns revision unique failures into conflicts for every stale update/delete mutation', async () => {
    const expenseDb = new StaleMutationDb(); const expenseRepo = new Repository(expenseDb as never);
    await expect(expenseRepo.updateExpense('expense-1', 'user-1', { ...input('Lunch'), client_operation_id: undefined, version: 1 })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(expenseRepo.deleteExpense('expense-1', 'user-1', 1)).rejects.toMatchObject({ code: 'CONFLICT' });
    const settlementDb = new StaleMutationDb(); const settlementRepo = new Repository(settlementDb as never);
    await expect(settlementRepo.updateSettlement('settlement-1', 'user-1', settlementInput)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(settlementRepo.deleteSettlement('settlement-1', 'user-1', 1)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(expenseDb.batches + settlementDb.batches).toBe(4);
  });

  it('does not turn an unrelated child unique failure into a conflict', async () => {
    const db = new StaleMutationDb();
    db.batch = async () => { throw new Error('UNIQUE constraint failed: payers.expense_id, payers.person_id'); };
    await expect(new Repository(db as never).updateExpense('expense-1', 'user-1', { ...input('Lunch'), client_operation_id: undefined, version: 1 })).rejects.toThrow('payers.expense_id');
  });

  it('maps the authoritative D1 ledger trigger to a stable overflow error', async () => {
    const expenseDb = new FakeDb(); expenseDb.overflow = true;
    await expect(new Repository(expenseDb as never).createExpense('group-1', 'user-1', input('Overflow'))).rejects.toMatchObject({ code: 'BALANCE_OVERFLOW' });
    const settlementDb = new FakeDb(); settlementDb.overflow = true;
    await expect(new Repository(settlementDb as never).createSettlement('group-1', 'user-1', { from_person_id: '00000000-0000-0000-0000-000000000001', to_person_id: '00000000-0000-0000-0000-000000000002', amount_minor: 100, currency: 'USD', date: '2025-01-01', client_operation_id: 'overflow-settlement' })).rejects.toMatchObject({ code: 'BALANCE_OVERFLOW' });
    const expenseUpdateDb = new StaleMutationDb(); expenseUpdateDb.failure = new Error('SQLITE_CONSTRAINT: BALANCE_OVERFLOW');
    await expect(new Repository(expenseUpdateDb as never).updateExpense('expense-1', 'user-1', { ...input('Updated'), client_operation_id: undefined, version: 1 })).rejects.toMatchObject({ code: 'BALANCE_OVERFLOW' });
    const settlementUpdateDb = new StaleMutationDb(); settlementUpdateDb.failure = new Error('SQLITE_CONSTRAINT: BALANCE_OVERFLOW');
    await expect(new Repository(settlementUpdateDb as never).updateSettlement('settlement-1', 'user-1', settlementInput)).rejects.toMatchObject({ code: 'BALANCE_OVERFLOW' });
  });
});

describe('repository expense hydration', () => {
  it('uses two bulk child queries per bind-limited chunk rather than two per expense', async () => {
    const db = new BulkHydrationDb(91);
    const expenses = await new Repository(db as never).expenses('group-1', { limit: 100, offset: 0 });
    expect(expenses).toHaveLength(91);
    expect(expenses.every((expense) => expense.payers.length === 1 && expense.splits.length === 1)).toBe(true);
    // 91 IDs are split into two chunks, so this is one page query plus two
    // payer/split query pairs, not 183 per-expense hydration queries.
    expect(db.queries).toBe(5);
  });
});

describe('repository friend creation', () => {
  it('creates the ledger-only person, group, and both memberships in one batch', async () => {
    const db = new FriendDb();
    const group = await new Repository(db as never).createFriend('user-1', 'person-1', { name: 'Friend', currency: 'USD' });
    expect(group).toMatchObject({ id: 'group-1', memberCount: 2, counterpartName: 'Friend' });
    expect(db.batches).toHaveLength(1);
    expect(db.batches[0]).toHaveLength(4);
    expect(db.batches[0].map((statement) => statement.sql)).toEqual(expect.arrayContaining([
      expect.stringContaining('INSERT INTO people'),
      expect.stringContaining('INSERT INTO groups'),
      expect.stringContaining('INSERT INTO group_members'),
    ]));
  });

  it('uses an existing email person and preserves their linked user membership', async () => {
    const db = new FriendDb();
    db.existing = { id: 'person-2', name: 'Friend', email: 'friend@example.com', user_id: 'user-2', created_at: '' };
    await new Repository(db as never).createFriend('user-1', 'person-1', { name: 'Friend', email: 'FRIEND@example.com', currency: 'EUR' });
    expect(db.batches[0]).toHaveLength(3);
    const memberStatements = db.batches[0].filter((statement) => statement.sql.includes('INSERT INTO group_members'));
    expect(memberStatements[1].args[2]).toBe('user-2');
  });

  it('returns one original group for retries and conflicts on a changed payload', async () => {
    const db = new FriendIdempotencyDb();
    const repo = new Repository(db as never);
    const first = await repo.createFriend('user-1', 'person-1', { name: 'Friend', currency: 'USD', client_operation_id: 'friend-op' });
    const retry = await repo.createFriend('user-1', 'person-1', { name: 'Friend', currency: 'USD', client_operation_id: 'friend-op' });
    expect(retry?.id).toBe(first?.id);
    await expect(repo.createFriend('user-1', 'person-1', { name: 'Different', currency: 'USD', client_operation_id: 'friend-op' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(db.batches).toHaveLength(1);
  });

  it('recovers the winning group after a concurrent claim collision and rejects a changed payload', async () => {
    const db = new FriendIdempotencyDb();
    const repo = new Repository(db as never);
    const first = await repo.createFriend('user-1', 'person-1', { name: 'Friend', currency: 'USD', client_operation_id: 'collision-op' });

    db.claimCollision = true;
    const retry = await repo.createFriend('user-1', 'person-1', { name: 'Friend', currency: 'USD', client_operation_id: 'collision-op' });
    expect(retry?.id).toBe(first?.id);

    db.claimCollision = true;
    await expect(repo.createFriend('user-1', 'person-1', { name: 'Different', currency: 'USD', client_operation_id: 'collision-op' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(db.batches).toHaveLength(3);
  });

  it('re-reads a winner after a normalized-email race and retries the atomic group batch', async () => {
    const db = new FriendIdempotencyDb();
    db.race = true;
    db.person = { id: 'person-2', name: 'Friend', email: 'friend@example.com', user_id: 'user-2', created_at: '' };
    const group = await new Repository(db as never).createFriend('user-1', 'person-1', { name: 'Friend', email: 'FRIEND@example.com', currency: 'USD', client_operation_id: 'race-op' });
    expect(group).toMatchObject({ currency: 'USD' });
    expect(db.batches).toHaveLength(2);
    expect(db.batches[1].some((statement) => statement.sql.includes('INSERT INTO people'))).toBe(false);
  });

  it('rejects the creator email as a structured self-friend error', async () => {
    const db = new FriendIdempotencyDb();
    db.creator = { id: 'person-1', email: 'owner@example.com', user_id: 'user-1' };
    await expect(new Repository(db as never).createFriend('user-1', 'person-1', { name: 'Owner', email: 'OWNER@example.com', currency: 'USD' })).rejects.toMatchObject({ code: 'SELF_FRIEND' });
    expect(db.batches).toHaveLength(0);
  });
});

describe('repository activity mapping', () => {
  it('keeps event IDs separate from canonical entity IDs and carries transaction context', async () => {
    const activity = await new Repository(new ActivityDb() as never).activity('group-1');
    expect(activity[0]).toMatchObject({ type: 'expense', id: 'expense-event', entityId: 'expense-1', amountMinor: 1250, currency: 'USD', transactionDate: '2026-01-02' });
    expect(activity[1]).toMatchObject({ type: 'settlement_revision', id: 'revision-1', entityId: 'settlement-1', fromName: 'A', toName: 'B' });
  });

  it('marks only the revision immediately before deletion as deleted', async () => {
    const db = new RevisionActivityDb();
    const activity = await new Repository(db as never).activity('group-1');
    // D1 evaluates this against the current version and deleted_at. Earlier
    // edit revisions therefore stay revisions after an edit-then-delete.
    expect(db.sql).toContain("e.deleted_at IS NOT NULL AND e.version = r.revision + 1");
    expect(db.sql).toContain("s.deleted_at IS NOT NULL AND s.version = r.revision + 1");
    expect(activity.map((item) => item.type)).toEqual(['expense_revision', 'expense_deleted']);
    expect(activity.map((item) => item.entityId)).toEqual(['expense-1', 'expense-1']);
  });
});

describe('repository home balance summaries', () => {
  it('aggregates the authenticated person, excludes deleted ledger rows, and applies top-two tie ordering in D1', async () => {
    const db = new GroupSummaryDb();
    const groups = await new Repository(db as never).groups('user-a');
    expect(groups[0]).toMatchObject({ balanceSummaries: [{ currency: 'USD', netMinor: 500 }, { currency: 'EUR', netMinor: -250 }] });
    expect(db.args).toEqual(['user-a']);
    expect(db.sql).toContain('p.person_id');
    expect(db.sql).toContain('s.person_id');
    expect(db.sql).toContain('gm.user_id=?');
    expect(db.sql).toContain('JOIN scoped_groups scope ON scope.group_id=e.group_id');
    expect(db.sql).toContain('JOIN scoped_groups scope ON scope.group_id=s.group_id');
    expect(db.sql).toContain('JOIN authorized_groups balance_member');
    expect(db.sql).toContain('e.deleted_at IS NULL');
    expect(db.sql).toContain('s.deleted_at IS NULL');
    expect(db.sql).toContain('ROW_NUMBER() OVER (PARTITION BY group_id ORDER BY ABS(net_minor) DESC,currency ASC)');
    expect(db.sql).toContain('WHERE balance_rank <= 2');
  });

  it('scopes a single-group authorization and ledger query to the requested group', async () => {
    const db = new GroupSummaryDb();
    const group = await new Repository(db as never).group('group-1', 'user-a');
    expect(group?.id).toBe('group-1');
    expect(db.args).toEqual(['user-a', 'group-1', 'group-1']);
    expect(db.sql).toContain('AND gm.group_id=?');
    expect(db.sql).toContain('FROM groups g JOIN authorized_groups gm');
    expect(db.sql).toContain('WHERE g.id=? AND g.deleted_at IS NULL');
  });

  it('omits malformed summaries instead of failing group authorization', async () => {
    const db = new GroupSummaryDb();
    db.first = async <T>() => ({ id: 'group-1', name: 'Shared', currency: 'USD', created_at: '', updated_at: '', balance_summaries: '{bad json' } as T);
    const group = await new Repository(db as never).group('group-1', 'user-a');
    expect(group).toMatchObject({ id: 'group-1' });
    expect(group?.balanceSummaries).toBeUndefined();
  });

  it('preserves database errors from the scoped group query', async () => {
    const db = { prepare: () => { throw new Error('scoped query failed'); } };
    await expect(new Repository(db as never).groups('user-a')).rejects.toThrow('scoped query failed');
  });
});
