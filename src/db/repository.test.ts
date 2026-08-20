import { describe, expect, it } from 'vitest';
import { Repository } from './repository';
import type { ExpenseInput, SettlementInput } from '../shared/schemas';

class FakeDb {
  claim: Record<string, unknown> | null = null;
  expense: Record<string, unknown> | null = null;
  settlement: Record<string, unknown> | null = null;
  payers: Array<Record<string, unknown>> = [];
  splits: Array<Record<string, unknown>> = [];
  prepare(sql: string) { return new FakeStatement(this, sql); }
  async batch(statements: FakeStatement[]) { for (const statement of statements) statement.execute(); return []; }
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
    if (this.sql.includes('INSERT INTO expenses(')) { const [id, groupId, description, amountMinor, currency, date, category, notes, createdBy, createdAt, updatedAt] = this.args; this.db.expense = { id, group_id: groupId, description, amount_minor: amountMinor, currency, expense_date: date, category, notes, created_by: createdBy, created_at: createdAt, updated_at: updatedAt, version: 1 }; }
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
  prepare(sql: string) { return new StaleMutationStatement(this, sql); }
  async batch(_statements: StaleMutationStatement[]) { this.batches += 1; throw new Error('UNIQUE constraint failed: revisions.entity_type, revisions.entity_id, revisions.revision'); }
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

describe('repository idempotency', () => {
  it('returns the original entity for a same-payload retry and rejects a mismatch', async () => {
    const repo = new Repository(new FakeDb() as never);
    const first = await repo.createExpense('00000000-0000-4000-8000-000000000010', 'user-1', input('Lunch'));
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
