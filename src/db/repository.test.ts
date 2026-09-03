import { describe, expect, it } from 'vitest';
import { Repository, assertLikeSearch, decodeLedgerCursor, decodeTransactionCursor, encodeLedgerCursor, encodeTransactionCursor } from './repository';
import { APPLICATION_SESSION_ACTIVITY_THROTTLE_MS, APPLICATION_SESSION_IDLE_MS } from '../shared/session-policy';
import type { ExpenseInput, SettlementInput } from '../shared/schemas';
import type { Transaction } from '../shared/types';

const IDENTITY_TOMBSTONE_TEST_KEY = 'test-identity-tombstone-key';

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
class BackfillLimitDb {
  limit: unknown;
  batches = 0;
  prepare(sql: string) { return new BackfillLimitStatement(this, sql); }
  async batch(_statements: BackfillLimitStatement[]) { this.batches += 1; return []; }
}
class BackfillLimitStatement {
  args: unknown[] = [];
  constructor(private readonly db: BackfillLimitDb, readonly sql: string) {}
  bind(...args: unknown[]) { this.args = args; if (this.sql.includes('SELECT g.id') || this.sql.includes('FROM ledger_summary_state state JOIN groups')) this.db.limit = args[2]; return this; }
  async first<T>() { return this.sql.includes('ledger_summary_state') ? { status: 'pending', generation: 0 } as T : null; }
  async run() { return { meta: { changes: 1 } }; }
  async all<T>() { return { results: this.sql.includes('SELECT g.id') || this.sql.includes('FROM ledger_summary_state state JOIN groups') ? Array.from({ length: 10 }, (_, index) => ({ id: `group-${index}`, group_id: `group-${index}` })) as T[] : [] as T[] }; }
}
class SettlementGuardDb extends FakeDb {
  readonly sql: string[] = [];
  override prepare(sql: string) { this.sql.push(sql); return super.prepare(sql); }
}
class HistoricalSettlementDb {
  readonly sql: string[] = [];
  row: Record<string, unknown> | null = null;
  prepare(sql: string) { this.sql.push(sql); return new HistoricalSettlementStatement(this, sql); }
  async batch(statements: HistoricalSettlementStatement[]) {
    for (const statement of statements) {
      if (statement.sql.includes('INSERT INTO settlements(')) {
        const [id, groupId, fromPersonId, toPersonId, amountMinor, currency, date, note, createdBy, createdAt, updatedAt] = statement.args;
        this.row = { id, group_id: groupId, from_person_id: fromPersonId, to_person_id: toPersonId, amount_minor: amountMinor, currency, settlement_date: date, note, created_by: createdBy, created_at: createdAt, updated_at: updatedAt, version: 1 };
      }
      if (statement.sql.includes('UPDATE settlements SET from_person_id=')) {
        const [fromPersonId, toPersonId, amountMinor, currency, date, note, updatedAt, version] = statement.args;
        this.row = { ...this.row, from_person_id: fromPersonId, to_person_id: toPersonId, amount_minor: amountMinor, currency, settlement_date: date, note, updated_at: updatedAt, version };
      }
    }
    return statements.map(() => ({ meta: { changes: 1 } }));
  }
}
class HistoricalSettlementStatement {
  args: unknown[] = [];
  constructor(private readonly db: HistoricalSettlementDb, readonly sql: string) {}
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>() {
    if (this.sql.includes('FROM revisions')) return { id: 'revision-1' } as T;
    if (this.sql.includes('FROM settlements')) return this.db.row as T | null;
    return null;
  }
  async all<T>() { return { results: [] as T[] }; }
}

class ApplicationSessionDb {
  createArgs: unknown[] | undefined;
  renewArgs: unknown[] | undefined;
  prepare(sql: string) { return new ApplicationSessionStatement(this, sql); }
}
class ApplicationSessionStatement {
  private args: unknown[] = [];
  constructor(private readonly db: ApplicationSessionDb, private readonly sql: string) {}
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>() {
    if (this.sql.includes('SELECT id FROM users')) return { id: 'user-1' } as T;
    if (this.sql.includes('SELECT id,last_activity_at')) return { id: 'session-1', last_activity_at: '2026-01-01T00:00:00.000Z', idle_expires_at: '2026-02-01T00:00:00.000Z' } as T;
    return null;
  }
  async run() {
    if (this.sql.includes('INSERT INTO application_sessions')) this.db.createArgs = this.args;
    if (this.sql.includes('UPDATE application_sessions SET last_activity_at')) this.db.renewArgs = this.args;
    return { meta: { changes: 1 } };
  }
}

class PurgeAccountingDb {
  metadataPass = 0;
  prepare(sql: string) { return new PurgeAccountingStatement(sql); }
  async batch(statements: PurgeAccountingStatement[]) {
    if (!statements.some((statement) => statement.sql.includes('DELETE FROM groups WHERE'))) return [];
    const result = statements.map(() => ({ meta: { changes: 0 } }));
    const memberDelete = statements.findIndex((statement) => statement.sql.includes('DELETE FROM group_members WHERE'));
    const parentDelete = statements.findIndex((statement) => statement.sql.includes('DELETE FROM groups WHERE'));
    if (this.metadataPass++ === 0) result[memberDelete] = { meta: { changes: 1 } };
    else result[parentDelete] = { meta: { changes: 1 } };
    return result;
  }
}
class PurgeAccountingStatement {
  args: unknown[] = [];
  constructor(readonly sql: string) {}
  bind(...args: unknown[]) { this.args = args; return this; }
  async all<T>() {
    if (this.sql.includes('WITH purge_cursor')) return { results: [{ id: 'expired-group', deleted_at: '2026-01-01T00:00:00.000Z' }] as T[] };
    return { results: [] as T[] };
  }
  async first<T>() { return null as T | null; }
  async run() { return { meta: { changes: 1 } }; }
}

describe('repository application sessions', () => {
  it('creates sessions with the shared idle expiration policy', async () => {
    const db = new ApplicationSessionDb();
    const createdAt = '2026-01-01T00:00:00.000Z';
    await new Repository(db as never).createApplicationSession('user-1', 'a'.repeat(64), createdAt);

    expect(db.createArgs?.[4]).toBe(createdAt);
    expect(db.createArgs?.[5]).toBe(new Date(Date.parse(createdAt) + APPLICATION_SESSION_IDLE_MS).toISOString());
  });

  it('renews sessions with the shared idle expiration and activity throttle policies', async () => {
    const db = new ApplicationSessionDb();
    const asOf = '2026-02-01T00:00:00.000Z';
    const idleExpiresAt = new Date(Date.parse(asOf) + APPLICATION_SESSION_IDLE_MS).toISOString();
    const renewed = await new Repository(db as never).renewApplicationSession('session-1', asOf);

    expect(renewed).toEqual({
      lastActivityAt: asOf,
      idleExpiresAt,
      renewed: true,
    });
    expect(db.renewArgs).toEqual([
      asOf,
      idleExpiresAt,
      'session-1',
      asOf,
      new Date(Date.parse(asOf) - APPLICATION_SESSION_ACTIVITY_THROTTLE_MS).toISOString(),
    ]);
  });
});

describe('repository expired-group purge accounting', () => {
  it('counts only actual parent deletions, including after members were removed', async () => {
    const db = new PurgeAccountingDb();
    const repo = new Repository(db as never);

    const blocked = await repo.purgeExpiredData('2026-03-01T00:00:00.000Z', { maxGroups: 1 });
    expect(blocked.groupsPurged).toBe(0);

    const purged = await repo.purgeExpiredData('2026-03-01T00:00:00.000Z', { maxGroups: 1 });
    expect(purged.groupsPurged).toBe(1);
  });
});

class SplitDefaultDb {
  readonly sql: string[] = [];
  prepare(sql: string) { this.sql.push(sql); return new SplitDefaultStatement(sql); }
}
class SplitDefaultStatement {
  constructor(private readonly sql: string) {}
  bind(..._args: unknown[]) { return this; }
  async first<T>() {
    if (this.sql.includes('SELECT d.*')) return { method: 'percentage', person_ids_json: '["00000000-0000-4000-8000-000000000001","00000000-0000-4000-8000-000000000002"]', values_json: '[2500,7500]' } as T;
    return null;
  }
  async run() { return { meta: { changes: 1 } }; }
}

class SplitSuggestionDb {
  readonly sql: string[] = [];
  current: Record<string, unknown> | null = null;
  expenses = [
    { id: 'expense-3' },
    { id: 'expense-2' },
    { id: 'expense-1' },
  ];
  splits: Record<string, Array<Record<string, unknown>>> = {};
  members: Array<Record<string, unknown>> = [{ person_id: suggestionPersonA, name: 'Amy', joined_at: '', role: 'owner' }, { person_id: suggestionPersonB, name: 'Bea', joined_at: '', role: 'member' }];
  prepare(sql: string) { this.sql.push(sql); return new SplitSuggestionStatement(this, sql); }
}
const suggestionPersonA = '00000000-0000-4000-8000-000000000001';
const suggestionPersonB = '00000000-0000-4000-8000-000000000002';
class SplitSuggestionStatement {
  args: unknown[] = [];
  constructor(private readonly db: SplitSuggestionDb, readonly sql: string) {}
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>() { return this.sql.includes('SELECT d.*') ? this.db.current as T | null : null; }
  async all<T>() {
    if (this.sql.includes('FROM expenses e')) return { results: this.db.expenses as T[] };
    if (this.sql.includes('FROM people p JOIN group_members')) return { results: this.db.members as T[] };
    if (this.sql.includes('FROM splits')) return { results: (this.db.splits[String(this.args[0])] || []) as T[] };
    return { results: [] as T[] };
  }
  async run() { return { meta: { changes: 0 } }; }
}

class AuditPageDb {
  prepare(sql: string) { return new AuditPageStatement(sql); }
}
class AuditPageStatement {
  constructor(private readonly sql: string) {}
  bind(..._args: unknown[]) { return this; }
  async all<T>() {
    if (this.sql.includes('FROM audit_events')) return { results: [{ id: 'audit-1', group_id: 'group-1', entity_type: 'expense', entity_id: 'expense-1', version: 1, action: 'create', actor_id: 'user-1', actor_person_id: 'person-1', actor_name: 'Alex', occurred_at: '', before_json: null, after_json: null }] as T[] };
    return { results: [] as T[] };
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

class ClerkIdentityDb {
  users: Array<Record<string, unknown>> = [];
  people: Array<Record<string, unknown>> = [];
  members: Array<Record<string, unknown>> = [];
  raceLinkClerkId: string | undefined;
  deletedIdentityTombstone = false;
  prepare(sql: string) { return new ClerkIdentityStatement(this, sql); }
  async batch(statements: ClerkIdentityStatement[]) {
    for (const statement of statements) {
      if (this.raceLinkClerkId && statement.sql.includes('UPDATE users SET clerk_user_id')) {
        const user = this.users.find((row) => row.id === statement.args[2]);
        if (user) user.clerk_user_id = this.raceLinkClerkId;
        this.raceLinkClerkId = undefined;
      } else statement.execute();
    }
    return [];
  }
}
class ClerkIdentityStatement {
  args: unknown[] = [];
  constructor(private readonly db: ClerkIdentityDb, readonly sql: string) {}
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>() {
    if (this.sql.includes('FROM users WHERE clerk_user_id')) return (this.db.users.find((row) => row.clerk_user_id === this.args[0]) ?? null) as T | null;
    if (this.sql.includes('deleted_clerk_hash')) return this.db.deletedIdentityTombstone ? { id: 'deleted-user' } as T : null;
    if (this.sql.includes('FROM users WHERE lower(email)')) return (this.db.users.find((row) => String(row.email).toLowerCase() === this.args[0]) ?? null) as T | null;
    if (this.sql.includes('FROM users WHERE id=')) return (this.db.users.find((row) => row.id === this.args[0]) ?? null) as T | null;
    if (this.sql.includes('FROM people WHERE user_id=')) return (this.db.people.find((row) => row.user_id === this.args[0] && row.deleted_at == null) ?? null) as T | null;
    if (this.sql.includes('FROM people WHERE lower(email)')) return (this.db.people.find((row) => String(row.email).toLowerCase() === this.args[0] && row.deleted_at == null) ?? null) as T | null;
    return null;
  }
  async run() { this.execute(); return {}; }
  execute() {
    if (this.sql.includes('UPDATE users SET clerk_user_id')) {
      const [clerkId, updatedAt, id] = this.args;
      const user = this.db.users.find((row) => row.id === id && row.clerk_user_id == null);
      if (user) { user.clerk_user_id = clerkId; user.updated_at = updatedAt; }
    }
    if (this.sql.includes('INSERT INTO users(')) {
      const [id, email, clerkId, createdAt, updatedAt] = this.args;
      if (this.db.users.some((row) => row.email === email || (clerkId != null && row.clerk_user_id === clerkId))) throw new Error('UNIQUE constraint failed: users');
      this.db.users.push({ id, email, clerk_user_id: clerkId, created_at: createdAt, updated_at: updatedAt });
    }
    if (this.sql.includes('INSERT INTO people(')) {
      const [id, name, email, userId, createdAt] = this.args;
      this.db.people.push({ id, name, email, user_id: userId, created_at: createdAt, deleted_at: null });
    }
    if (this.sql.includes('UPDATE people SET user_id=')) {
      const [userId, personId] = this.args;
      const person = this.db.people.find((row) => row.id === personId && row.user_id == null);
      if (person) person.user_id = userId;
    }
    if (this.sql.includes('UPDATE group_members SET user_id=')) {
      const [userId, personId] = this.args;
      for (const member of this.db.members.filter((row) => row.person_id === personId && row.user_id == null)) member.user_id = userId;
    }
  }
}

class GroupSummaryDb {
  sql = '';
  args: unknown[] = [];
  prepare(sql: string) { this.sql = sql; return this; }
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>() {
    return { id: 'group-1', name: 'Shared', currency: 'USD', created_at: '', updated_at: '', role: 'owner', member_count: 2, counterpart_name: 'Friend' } as T;
  }
  async all<T>() {
    return { results: [{ id: 'group-1', name: 'Shared', currency: 'USD', created_at: '', updated_at: '', role: 'owner', member_count: 2, counterpart_name: 'Friend', balance_summaries: JSON.stringify([{ currency: 'USD', net_minor: 500 }, { currency: 'EUR', net_minor: -250 }]) }] as T[] };
  }
}

class GroupAuthorizationDb {
  sql = '';
  args: unknown[] = [];
  constructor(private readonly state: { groupDeleted?: boolean; memberDeleted?: boolean; userId?: string } = {}) {}
  prepare(sql: string) { this.sql = sql; return this; }
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>() {
    if (this.state.groupDeleted || this.state.memberDeleted || (this.state.userId && this.args[1] !== this.state.userId)) return null;
    return { id: this.args[0], name: 'Shared', currency: 'USD', created_at: '', updated_at: '', role: 'member', member_count: 2, counterpart_name: 'Friend' } as T;
  }
}

class LifecycleDb {
  actorRole: 'owner' | 'member' | 'removed' = 'owner';
  targetRole: 'owner' | 'member' = 'member';
  targetLinked = true;
  batches: Array<Array<{ sql: string; args: unknown[] }>> = [];
  prepare(sql: string) { return new LifecycleStatement(this, sql); }
  async batch(statements: LifecycleStatement[]) {
    this.batches.push(statements.map((statement) => ({ sql: statement.sql, args: statement.args })));
    const event = statements.find((statement) => statement.sql.includes('INSERT INTO group_membership_events'));
    const eventType = event?.args[2];
    const allowed = eventType === 'owner_transfer' ? this.actorRole === 'owner' && this.targetRole === 'member' && this.targetLinked : eventType === 'member_leave' ? this.actorRole === 'member' : true;
    return statements.map((statement) => {
      if (statement === event) return { meta: { changes: allowed ? 1 : 0 } };
      if (statement.sql.includes("UPDATE group_members SET role='member'")) {
        if (allowed) { this.actorRole = 'member'; return { meta: { changes: 1 } }; }
        return { meta: { changes: 0 } };
      }
      if (statement.sql.includes("UPDATE group_members SET role='owner'")) {
        if (allowed) { this.targetRole = 'owner'; return { meta: { changes: 1 } }; }
        return { meta: { changes: 0 } };
      }
      if (statement.sql.includes("UPDATE group_members SET deleted_at")) {
        if (allowed) { this.actorRole = 'removed'; return { meta: { changes: 1 } }; }
        return { meta: { changes: 0 } };
      }
      return { meta: { changes: 0 } };
    });
  }
}
class LifecycleStatement {
  args: unknown[] = [];
  constructor(private readonly db: LifecycleDb, readonly sql: string) {}
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>() {
    if (this.sql.includes('SELECT role FROM group_members')) return (this.db.actorRole === 'removed' ? null : { role: this.db.actorRole }) as T | null;
    return null;
  }
}

class DeletedMutationDb {
  batches: Array<Array<string>> = [];
  prepare(sql: string) { return new DeletedMutationStatement(this, sql); }
  async batch(statements: DeletedMutationStatement[]) {
    this.batches.push(statements.map((statement) => statement.sql));
    return statements.map(() => ({ meta: { changes: 0 } }));
  }
}
class DeletedMutationStatement {
  args: unknown[] = [];
  constructor(private readonly db: DeletedMutationDb, readonly sql: string) {}
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>() {
    if (this.sql.includes('SELECT deleted_at FROM users')) return { deleted_at: '2026-01-01T00:00:00.000Z' } as T;
    if (this.sql.includes('SELECT * FROM users WHERE id=')) return { id: 'user-1', email: 'person@example.com', deleted_at: null } as T;
    if (this.sql.includes('FROM people WHERE id=')) return { id: 'person-1', name: 'Friend', email: null, deleted_at: null } as T;
    if (this.sql.includes('FROM group_invitations WHERE id=')) return { id: 'invitation-1', group_id: 'group-1', email_normalized: 'person@example.com', expires_at: '9999-01-01T00:00:00.000Z', revoked_at: null, accepted_at: null, rejected_at: null } as T;
    return null;
  }
  async run() { return { meta: { changes: 0 } }; }
}

class StaleRemovalDb {
  invitationSql = '';
  prepare(sql: string) { return new StaleRemovalStatement(this, sql); }
  async batch(statements: StaleRemovalStatement[]) {
    this.invitationSql = statements.find((statement) => statement.sql.includes('UPDATE group_invitations'))?.sql ?? '';
    return statements.map(() => ({ meta: { changes: 0 } }));
  }
}
class StaleRemovalStatement {
  constructor(private readonly db: StaleRemovalDb, readonly sql: string) {}
  bind(..._args: unknown[]) { return this; }
  async first<T>() {
    if (this.sql.includes('SELECT role,deleted_at')) return { role: 'member', deleted_at: null } as T;
    return null;
  }
}

class AccountDeletionDb {
  ownerCount = 0;
  deleted = false;
  batches: Array<AccountDeletionStatement[]> = [];
  failBatch = false;
  prepare(sql: string) { return new AccountDeletionStatement(this, sql); }
  async batch(statements: AccountDeletionStatement[]) {
    this.batches.push(statements);
    if (this.failBatch) throw new Error('cleanup failed');
    this.deleted = true;
    return statements.map((_, index) => index === 0 ? { meta: { changes: 1 } } : { meta: { changes: 0 } });
  }
}
class AccountDeletionStatement {
  args: unknown[] = [];
  constructor(private readonly db: AccountDeletionDb, readonly sql: string) {}
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>() {
    if (this.sql.includes('SELECT id,email,clerk_user_id,deleted_at FROM users')) return { id: 'user-1', email: 'person@example.com', clerk_user_id: 'clerk-1', deleted_at: this.db.deleted ? '2026-01-01T00:00:00.000Z' : null } as T;
    if (this.sql.includes('SELECT COUNT(*) AS count')) return { count: this.db.ownerCount } as T;
    return null;
  }
  async run() { return { meta: { changes: 1 } }; }
}
class DeletedRecoveryDb {
  recoveryHash: unknown;
  prepare(sql: string) { return new DeletedRecoveryStatement(this, sql); }
}
class DeletedRecoveryStatement {
  args: unknown[] = [];
  constructor(private readonly db: DeletedRecoveryDb, readonly sql: string) {}
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>() {
    if (!this.sql.includes('deleted_clerk_hash')) return null;
    if (this.db.recoveryHash === undefined) this.db.recoveryHash = this.args[0];
    return this.args[0] === this.db.recoveryHash ? { id: 'deleted-user', deleted_at: '2026-01-01T00:00:00.000Z' } as T : null;
  }
}
class HistoricalParticipantsDb {
  sql = '';
  prepare(sql: string) { this.sql = sql; return this; }
  bind(..._args: unknown[]) { return this; }
  async all<T>() { return { results: [
    { person_id: 'active-person', name: 'Active', joined_at: '2026-01-01', role: 'member', membership_deleted_at: null, person_deleted_at: null, linked: 1 },
    { person_id: 'removed-person', name: 'Former', joined_at: '2026-01-02', role: 'member', membership_deleted_at: '2026-02-01', person_deleted_at: null, linked: 0 },
    { person_id: 'deleted-person', name: 'Deleted account', joined_at: '2026-01-03', role: 'member', membership_deleted_at: '2026-02-02', person_deleted_at: '2026-03-01', linked: 0 },
  ] as T[] }; }
}

class GlobalActivityDb {
  sql = '';
  args: unknown[] = [];
  prepare(sql: string) { this.sql = sql; return this; }
  bind(...args: unknown[]) { this.args = args; return this; }
  async all<T>() {
    const selectedGroup = this.sql.includes('activity.group_id=?') ? this.args[1] : undefined;
    const rows = [
      { type: 'expense', id: 'expense-allowed', entity_id: 'expense-allowed', entity_active: 1, group_id: 'group-allowed', group_name: 'Allowed', label: 'Lunch', amount_minor: 100, currency: 'USD', transaction_date: '2026-01-01', created_at: '2026-01-01' },
      { type: 'settlement', id: 'settlement-allowed', entity_id: 'settlement-allowed', entity_active: 0, group_id: 'group-allowed', group_name: 'Allowed', label: 'Paid', amount_minor: 50, currency: 'USD', transaction_date: '2026-01-02', created_at: '2026-01-02' },
      { type: 'expense_deleted', id: 'deleted-expense', entity_id: 'expense-deleted', entity_active: 0, group_id: 'group-allowed', group_name: 'Allowed', label: 'Deleted', amount_minor: 75, currency: 'USD', transaction_date: '2026-01-01', created_at: '2026-01-04', deleted: true },
      { type: 'expense', id: 'expense-other', entity_id: 'expense-other', entity_active: 1, group_id: 'group-other', group_name: 'Other', label: 'Secret', amount_minor: 200, currency: 'USD', transaction_date: '2026-01-01', created_at: '2026-01-01' },
    ];
    return { results: rows.filter((row) => !row.deleted && row.group_id === 'group-allowed' && (!selectedGroup || row.group_id === selectedGroup)) as T[] };
  }
}

class GlobalExportDb {
  readonly groups = ['group-a', 'group-b', 'group-c'];
  prepare(sql: string) { return new GlobalExportStatement(this, sql); }
}
class GlobalExportStatement {
  args: unknown[] = [];
  constructor(private readonly db: GlobalExportDb, private readonly sql: string) {}
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>() {
    if (this.sql.includes('SELECT g.id FROM groups')) {
      if (this.sql.includes('g.id>?')) {
        const index = this.db.groups.findIndex((id) => id > String(this.args[1]));
        return (index < 0 ? null : { id: this.db.groups[index] }) as T | null;
      }
      if (this.sql.includes('g.id=?')) return (this.db.groups.includes(String(this.args[0])) ? { id: this.args[0] } : null) as T | null;
      return { id: this.db.groups[0] } as T;
    }
    return null;
  }
}

class CategoriesDb {
  sql = '';
  args: unknown[] = [];
  prepare(sql: string) { this.sql = sql; return this; }
  bind(...args: unknown[]) { this.args = args; return this; }
  async all<T>() { return { results: [{ category: 'Custom rent' }, { category: 'Dining' }] as T[] }; }
}

type TransactionTestRow = Record<string, unknown> & { personIds: string[]; deleted?: boolean };
class TransactionPageDb {
  lastSql = '';
  constructor(readonly rows: TransactionTestRow[]) {}
  prepare(sql: string) { this.lastSql = sql; return new TransactionPageStatement(this.rows, sql); }
}
class TransactionPageStatement {
  private args: unknown[] = [];
  constructor(private readonly source: TransactionTestRow[], private readonly sql: string) {}
  bind(...args: unknown[]) { this.args = args; return this; }
  async all<T>() {
    let index = 2;
    let rows = this.source.filter((row) => row.deleted !== true);
    if (this.sql.includes('AND tr.kind=?')) {
      const kind = String(this.args[index++]);
      rows = rows.filter((row) => row.kind === kind);
    }
    if (this.sql.includes('tr.description LIKE ?')) {
      const query = String(this.args[index++]).slice(1, -1).replaceAll('\\%', '%').replaceAll('\\_', '_').replaceAll('\\\\', '\\');
      index += 2;
      rows = rows.filter((row) => [row.description, row.notes, row.note].some((value) => String(value ?? '').toLocaleLowerCase().includes(query.toLocaleLowerCase())));
    }
    if (this.sql.includes('tr.category=?')) {
      const category = String(this.args[index++]);
      rows = rows.filter((row) => row.kind === 'expense' && row.category === category);
    }
    if (this.sql.includes('AND tr.currency=?')) { const currency = this.args[index++]; rows = rows.filter((row) => row.currency === currency); }
    if (this.sql.includes('AND tr.transaction_date>=?')) { const from = String(this.args[index++]); rows = rows.filter((row) => String(row.transaction_date) >= from); }
    if (this.sql.includes('AND tr.transaction_date<=?')) { const to = String(this.args[index++]); rows = rows.filter((row) => String(row.transaction_date) <= to); }
    if (this.sql.includes('payers WHERE person_id=?')) {
      const personIds = this.args.slice(-5, -1).map(String);
      rows = rows.filter((row) => row.personIds.some((personId) => personIds.includes(personId)));
    }
    if (this.args.length === 7 && this.sql.includes('payers WHERE person_id=?')) {
      const personIds = this.args.slice(2, 6).map(String);
      rows = rows.filter((row) => row.personIds.some((personId) => personIds.includes(personId)));
    }
    if (this.sql.includes('tr.transaction_date<?')) {
      const [date, , createdAt, , , kind, , id] = this.args.slice(-9, -1).map(String);
      rows = rows.filter((row) => String(row.transaction_date) < date || (String(row.transaction_date) === date && String(row.created_at) < createdAt) || (String(row.transaction_date) === date && String(row.created_at) === createdAt && (String(row.kind) > kind || (String(row.kind) === kind && String(row.id) < id))));
    }
    rows.sort((left, right) => String(right.transaction_date).localeCompare(String(left.transaction_date)) || String(right.created_at).localeCompare(String(left.created_at)) || String(left.kind).localeCompare(String(right.kind)) || String(right.id).localeCompare(String(left.id)));
    const limit = Number(this.args[this.args.length - 1]);
    const projectedRows = this.sql.includes('NULL AS group_name') ? rows.map((row) => {
      const { group_name: _groupName, ...projected } = row;
      return projected;
    }) : rows;
    return { results: projectedRows.slice(0, limit) as T[] };
  }
}

const transactionRows: TransactionTestRow[] = [
  { id: 'expense-new', kind: 'expense', group_id: 'group-1', description: 'New dinner', amount_minor: 900, currency: 'USD', transaction_date: '2026-01-04', category: 'Dining', notes: 'team', created_by: 'user-1', created_at: '2026-01-04T02:00:00.000Z', client_operation_id: null, personIds: ['person-payer'] },
  { id: 'expense-z', kind: 'expense', group_id: 'group-1', description: 'Dinner', amount_minor: 800, currency: 'USD', transaction_date: '2026-01-03', category: 'Dining', notes: 'shared', created_by: 'user-1', created_at: '2026-01-03T01:00:00.000Z', client_operation_id: null, personIds: ['person-split'] },
  { id: 'expense-a', kind: 'expense', group_id: 'group-1', description: 'Dinner', amount_minor: 700, currency: 'EUR', transaction_date: '2026-01-03', category: 'Dining', notes: null, created_by: 'user-1', created_at: '2026-01-03T01:00:00.000Z', client_operation_id: null, personIds: ['person-payer'] },
  { id: 'settlement-z', kind: 'settlement', group_id: 'group-1', description: null, amount_minor: 600, currency: 'USD', transaction_date: '2026-01-03', category: null, note: 'Paid dinner', created_by: 'user-1', created_at: '2026-01-03T01:00:00.000Z', from_person_id: 'person-from', to_person_id: 'person-to', from_name: 'Former payer', to_name: 'Removed participant', personIds: ['person-from', 'person-to'] },
  { id: 'settlement-a', kind: 'settlement', group_id: 'group-1', description: null, amount_minor: 500, currency: 'USD', transaction_date: '2026-01-03', category: null, note: 'Paid dinner', created_by: 'user-1', created_at: '2026-01-03T01:00:00.000Z', from_person_id: 'person-from', to_person_id: 'person-to', from_name: 'Former payer', to_name: 'Removed participant', personIds: ['person-from', 'person-to'] },
  { id: 'expense-deleted', kind: 'expense', group_id: 'group-1', description: 'Deleted', amount_minor: 400, currency: 'USD', transaction_date: '2026-01-02', category: 'Dining', notes: null, created_by: 'user-1', created_at: '2026-01-02T01:00:00.000Z', client_operation_id: null, personIds: ['person-payer'], deleted: true },
  { id: 'settlement-old', kind: 'settlement', group_id: 'group-1', description: null, amount_minor: 300, currency: 'GBP', transaction_date: '2026-01-02', category: null, note: 'Old payment', created_by: 'user-1', created_at: '2026-01-02T01:00:00.000Z', from_person_id: 'person-from', to_person_id: 'person-to', from_name: 'Former payer', to_name: 'Removed participant', personIds: ['person-to'] },
  { id: 'expense-other', kind: 'expense', group_id: 'group-1', description: 'Rent', amount_minor: 200, currency: 'USD', transaction_date: '2026-01-01', category: 'Housing', notes: null, created_by: 'user-1', created_at: '2026-01-01T01:00:00.000Z', client_operation_id: null, personIds: ['person-payer'] },
];

class PreferenceDb {
  sql = '';
  args: unknown[] = [];
  prepare(sql: string) {
    this.sql = sql;
    const statement = {
      bind: (...args: unknown[]) => { this.args = args; return statement; },
      first: async <T>() => ({ category: 'Dining' } as T),
    };
    return statement;
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

describe('repository historical settlement participants', () => {
  it('keeps removed/deleted settlement endpoints valid for create and edit while retaining the actor guard', async () => {
    const db = new HistoricalSettlementDb();
    const repository = new Repository(db as never);
    const settlement: SettlementInput = { from_person_id: 'removed-person', to_person_id: 'deleted-person', amount_minor: 100, currency: 'USD', date: '2025-01-01', client_operation_id: undefined };
    const created = await repository.createSettlement('group-1', 'user-1', settlement);
    expect(created).toMatchObject({ fromPersonId: 'removed-person', toPersonId: 'deleted-person' });
    const updated = await repository.updateSettlement(String(created.id), 'user-1', { ...settlement, from_person_id: 'deleted-person', to_person_id: 'removed-person', version: 1 });
    expect(updated).toMatchObject({ fromPersonId: 'deleted-person', toPersonId: 'removed-person', version: 2 });
    const writes = db.sql.filter((sql) => sql.includes('settlement_participant.group_id=?'));
    expect(writes).toHaveLength(2);
    expect(writes.every((sql) => !sql.includes('settlement_participant.deleted_at IS NULL') && !sql.includes('settlement_person.deleted_at IS NULL'))).toBe(true);
    expect(writes.every((sql) => sql.includes('auth_member'))).toBe(true);
  });
});

describe('repository authorization-scoped transaction lookups', () => {
  it('does not resolve transaction details outside the authenticated user group scope', async () => {
    const db = new SettlementGuardDb();
    const repository = new Repository(db as never);
    await expect(repository.expenseForUser('expense-a', 'user-a')).resolves.toBeNull();
    await expect(repository.settlementForUser('settlement-a', 'user-a')).resolves.toBeNull();
    expect(db.sql.some((sql) => sql.includes('FROM expenses e') && sql.includes('gm.user_id=?'))).toBe(true);
    expect(db.sql.some((sql) => sql.includes('FROM settlements s') && sql.includes('gm.user_id=?'))).toBe(true);
  });
});

describe('repository mutation safety', () => {
  const settlementInput: SettlementInput = { from_person_id: '00000000-0000-4000-8000-000000000001', to_person_id: '00000000-0000-4000-8000-000000000002', amount_minor: 100, currency: 'USD', date: '2025-01-01', version: 1 };

  it('caps reconciliation at ten groups per repository call', async () => {
    const db = new BackfillLimitDb();
    await expect(new Repository(db as never).projectionBackfill({ maxGroups: 100 })).resolves.toMatchObject({ groupsScanned: 10, monthsScanned: 0, capped: true });
    expect(db.limit).toBe(10);
    // Each selected group may perform a bounded discovery batch in addition
    // to its maintenance work; the group selection itself remains capped.
    expect(db.batches).toBeLessThanOrEqual(20);
  });

  it('keeps 100-payer/100-split expense update, delete, and restore deltas bounded', () => {
    const repository = new Repository(new FakeDb() as never) as unknown as {
      boundExpenseProjectionDelta: (...args: unknown[]) => Array<{ sql: string; args: unknown[] }>;
    };
    const payers = Array.from({ length: 100 }, (_, index) => ({ personId: `person-${index}`, amountMinor: 1 }));
    const splits = Array.from({ length: 100 }, (_, index) => ({ personId: `person-${index}`, amountMinor: 1 }));
    for (const sign of [-1, 1] as const) {
       const statements = repository.boundExpenseProjectionDelta('expense-1', 'group-1', 'USD', payers, splits, sign, '2025-01-01', 'revision-1');
      // The bounded compatibility upsert precedes the monthly summary delta;
      // its zero-row cleanup is performed by the projection trigger.
      expect(statements).toHaveLength(14);
       const balanceDelta = statements.find((statement) => statement.sql.includes('ledger_period_balances'));
       expect(balanceDelta?.sql).toContain('json_each(?)');
       expect(balanceDelta?.sql).toContain('GROUP BY json_extract(value,\'$.month\')');
       expect(JSON.parse(String(balanceDelta?.args[2]))).toHaveLength(200);
       expect(balanceDelta?.args.length).toBeLessThanOrEqual(10);
       expect(statements.some((statement) => statement.sql.includes('ledger_period_totals'))).toBe(true);
    }
  });

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

describe('repository collaboration lifecycle', () => {
  it('transfers ownership atomically and records a non-email event', async () => {
    const db = new LifecycleDb();
    await expect(new Repository(db as never).transferOwnership('group-1', 'person-2', 'user-1')).resolves.toBe(true);
    expect(db.actorRole).toBe('member');
    expect(db.targetRole).toBe('owner');
    expect(db.batches[0]).toHaveLength(3);
    expect(db.batches[0][0].sql).toContain('group_membership_events');
    expect(db.batches[0][0].sql.toLowerCase()).not.toContain('email');
    expect(db.batches[0][1].sql).toContain("(SELECT COUNT(*) FROM group_members owners");
  });

  it('rejects transfer attempts by non-owners and to ledger-only members', async () => {
    const nonOwner = new LifecycleDb(); nonOwner.actorRole = 'member';
    await expect(new Repository(nonOwner as never).transferOwnership('group-1', 'person-2', 'user-1')).rejects.toMatchObject({ code: 'OWNER_REQUIRED' });
    const ledgerOnly = new LifecycleDb(); ledgerOnly.targetLinked = false;
    await expect(new Repository(ledgerOnly as never).transferOwnership('group-1', 'person-2', 'user-1')).rejects.toMatchObject({ code: 'MEMBER_REQUIRED' });
  });

  it('allows a non-owner to leave but protects the owner', async () => {
    const member = new LifecycleDb(); member.actorRole = 'member';
    await expect(new Repository(member as never).leaveGroup('group-1', 'user-1')).resolves.toBe(true);
    expect(member.actorRole).toBe('removed');
    expect(member.batches[0][0].sql).toContain("event_type");
     expect(member.batches[0].some((statement) => statement.sql.includes("UPDATE scheduled_expenses SET status='cancelled'") && !statement.sql.includes("status='active'"))).toBe(true);
    const owner = new LifecycleDb();
    await expect(new Repository(owner as never).leaveGroup('group-1', 'user-1')).rejects.toMatchObject({ code: 'MEMBER_REQUIRED' });
  });

  it('cancels only templates created by a removed member', async () => {
    const db = new LifecycleDb();
    await expect(new Repository(db as never).removeMember('group-1', 'person-2', 'user-1')).resolves.toBe(true);
     const cancellation = db.batches[0].find((statement) => statement.sql.includes("UPDATE scheduled_expenses SET status='cancelled'"));
     expect(cancellation?.sql).toContain('created_by=(SELECT removed_member.user_id');
     expect(cancellation?.sql).toContain('next_occurrence_date=NULL');
     expect(cancellation?.sql).not.toContain("status='active'");
  });
});

describe('repository account-deletion mutation guards', () => {
  it('keeps create, friend, and invitation acceptance writes atomic when deletion wins the race', async () => {
    const groupDb = new DeletedMutationDb();
    await expect(new Repository(groupDb as never).createGroup('user-1', 'person-1', { name: 'Group', currency: 'USD' })).rejects.toMatchObject({ code: 'AUTH_IDENTITY_CONFLICT' });
    expect(groupDb.batches[0].every((sql) => sql.includes('deleted_at IS NULL'))).toBe(true);
    expect(groupDb.batches[0].some((sql) => sql.includes('ledger_summary_state') && sql.includes("'ready'"))).toBe(true);

    const friendDb = new DeletedMutationDb();
    await expect(new Repository(friendDb as never).createFriend('user-1', 'person-1', { name: 'Friend', currency: 'USD' })).rejects.toMatchObject({ code: 'AUTH_IDENTITY_CONFLICT' });
    expect(friendDb.batches[0].every((sql) => sql.includes('deleted_at IS NULL'))).toBe(true);
    expect(friendDb.batches[0].some((sql) => sql.includes('ledger_summary_state') && sql.includes("'ready'"))).toBe(true);

    const invitationDb = new DeletedMutationDb();
    await expect(new Repository(invitationDb as never).acceptInvitation('invitation-1', 'user-1')).rejects.toMatchObject({ code: 'AUTH_IDENTITY_CONFLICT' });
    expect(invitationDb.batches[0].every((sql) => sql.includes('deleted_at IS NULL'))).toBe(true);
  });

  it('does not revoke invitations when a stale owner removal is rejected', async () => {
    const db = new StaleRemovalDb();
    await expect(new Repository(db as never).removeMember('group-1', 'person-2', 'user-1')).rejects.toMatchObject({ code: 'OWNER_REQUIRED' });
    expect(db.invitationSql).toContain('removed_member.deleted_at=?');
  });
});

describe('repository account deletion', () => {
  it('blocks deletion with only the active owned-group count and does not start cleanup', async () => {
    const db = new AccountDeletionDb(); db.ownerCount = 2;
    await expect(new Repository(db as never, IDENTITY_TOMBSTONE_TEST_KEY).deleteAccount('user-1')).rejects.toMatchObject({
      code: 'ACCOUNT_DELETION_BLOCKED',
      details: { activeOwnedGroupCount: 2 },
    });
    expect(db.batches).toHaveLength(0);
  });

  it('submits membership, invitation, preference, idempotency, identity, and linkage cleanup atomically', async () => {
    const db = new AccountDeletionDb();
    await expect(new Repository(db as never, IDENTITY_TOMBSTONE_TEST_KEY).deleteAccount('user-1')).resolves.toEqual(expect.objectContaining({ deletedAt: expect.any(String) }));
    expect(db.batches).toHaveLength(1);
    expect(db.batches[0]).toHaveLength(8);
    expect(db.batches[0].map((statement) => statement.sql)).toEqual(expect.arrayContaining([
       expect.stringContaining('UPDATE group_members SET deleted_at'),
       expect.stringContaining("UPDATE scheduled_expenses SET status='cancelled'"),
      expect.stringContaining('UPDATE group_invitations SET revoked_at'),
      expect.stringContaining('UPDATE group_invitations SET email_normalized'),
      expect.stringContaining('DELETE FROM category_preferences'),
      expect.stringContaining('DELETE FROM idempotency_keys'),
      expect.stringContaining('UPDATE people SET name'),
      expect.stringContaining('UPDATE users SET email'),
     ]));
     expect(db.batches[0].find((statement) => statement.sql.includes("UPDATE scheduled_expenses SET status='cancelled'"))?.sql).not.toContain("status='active'");
    expect(db.batches[0].find((statement) => statement.sql.includes('SET email_normalized'))?.sql).toContain('WHERE email_normalized=?');
  });

  it('treats a repeated delete for the authenticated account as already committed', async () => {
    const db = new AccountDeletionDb();
    const repository = new Repository(db as never, IDENTITY_TOMBSTONE_TEST_KEY);
    await repository.deleteAccount('user-1');
    await expect(repository.deleteAccount('user-1')).resolves.toMatchObject({ alreadyDeleted: true });
    expect(db.batches).toHaveLength(1);
  });

  it('limits deletion recovery to the same non-empty Clerk identity, not email', async () => {
    const db = new DeletedRecoveryDb();
    const repository = new Repository(db as never, IDENTITY_TOMBSTONE_TEST_KEY);
    await expect(repository.deletedAccountForIdentity('clerk-original', 'person@example.com')).resolves.toMatchObject({ id: 'deleted-user' });
    await expect(repository.deletedAccountForIdentity('clerk-unrelated', 'person@example.com')).resolves.toBeNull();
    await expect(repository.deletedAccountForIdentity('', 'person@example.com')).resolves.toBeNull();
  });
});

describe('repository historical settlement participants', () => {
  it('returns removed and deleted people without making them active members', async () => {
    const db = new HistoricalParticipantsDb();
    const participants = await new Repository(db as never).historicalParticipants('group-1');
    expect(participants.map((participant) => [participant.personId, participant.status])).toEqual([
      ['active-person', 'active'], ['removed-person', 'removed'], ['deleted-person', 'deleted'],
    ]);
    expect(db.sql).toContain('person_deleted_at');
  });
});

describe('repository expense hydration', () => {
  it('uses two bulk child queries per bind-limited chunk rather than two per expense', async () => {
    const db = new BulkHydrationDb(91);
    const expenses = (await new Repository(db as never).expensePage('group-1', { limit: 100 })).items;
    expect(expenses).toHaveLength(91);
    expect(expenses.every((expense) => expense.payers.length === 1 && expense.splits.length === 1)).toBe(true);
    // 91 IDs are split into two chunks, so this is one page query plus two
    // payer/split query pairs, not 183 per-expense hydration queries.
    expect(db.queries).toBe(5);
  });
});

describe('repository pagination guards', () => {
  it('round-trips an opaque stable keyset cursor and rejects tampering', () => {
    const cursor = encodeLedgerCursor({ date: '2026-01-01', createdAt: '2026-01-01T00:00:00.000Z', id: 'expense-2' });
    expect(decodeLedgerCursor(cursor)).toEqual({ date: '2026-01-01', createdAt: '2026-01-01T00:00:00.000Z', id: 'expense-2' });
    expect(() => decodeLedgerCursor(`${cursor}x`)).toThrowError(expect.objectContaining({ code: 'INVALID_CURSOR' }));
  });

  it('counts UTF-8 bytes and the two LIKE wildcards', () => {
    expect(() => assertLikeSearch('é'.repeat(25))).toThrowError(expect.objectContaining({ code: 'INVALID_SEARCH' }));
    expect(() => assertLikeSearch('é'.repeat(24))).not.toThrow();
  });

  it('returns actor IDs and a name snapshot without exposing email fields', async () => {
    const page = await new Repository(new AuditPageDb() as never).auditPage('group-1', { limit: 10 });
    expect(page.items[0]).toMatchObject({ actorId: 'user-1', actorPersonId: 'person-1', actorName: 'Alex' });
    expect(page.items[0]).not.toHaveProperty('email');
  });
});

describe('repository transaction pagination', () => {
  it('walks a mixed ledger without duplicates or omissions across date, created-at, kind, and ID ties', async () => {
    const repository = new Repository(new TransactionPageDb(transactionRows) as never);
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await repository.transactionPage('group-1', { limit: 2, cursor });
      ids.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    } while (cursor);

    expect(ids).toEqual(['expense-new', 'expense-z', 'expense-a', 'settlement-z', 'settlement-a', 'settlement-old', 'expense-other']);
    expect(new Set(ids).size).toBe(ids.length);
    expect(decodeTransactionCursor(encodeTransactionCursor({ date: '2026-01-03', createdAt: '2026-01-03T01:00:00.000Z', kind: 'expense', id: 'expense-z' }))).toMatchObject({ kind: 'expense', id: 'expense-z' });
  });

  it('continues from either kind at an equal date and created-at, preserving descending IDs', async () => {
    const repository = new Repository(new TransactionPageDb(transactionRows) as never);
    const afterExpense = await repository.transactionPage('group-1', { limit: 10, cursor: encodeTransactionCursor({ date: '2026-01-03', createdAt: '2026-01-03T01:00:00.000Z', kind: 'expense', id: 'expense-z' }) });
    expect(afterExpense.items.map((item) => item.id)).toEqual(['expense-a', 'settlement-z', 'settlement-a', 'settlement-old', 'expense-other']);
    const afterSettlement = await repository.transactionPage('group-1', { limit: 10, cursor: encodeTransactionCursor({ date: '2026-01-03', createdAt: '2026-01-03T01:00:00.000Z', kind: 'settlement', id: 'settlement-z' }) });
    expect(afterSettlement.items.map((item) => item.id)).toEqual(['settlement-a', 'settlement-old', 'expense-other']);
  });

  it('retains q/category/kind/date/currency filters and person payer, split, from, and to matches', async () => {
    const db = new TransactionPageDb(transactionRows);
    const repository = new Repository(db as never);
    await expect(repository.transactionPage('group-1', { q: 'Paid dinner', kind: 'settlement', from: '2026-01-03', to: '2026-01-03', currency: 'USD', person: 'person-to', limit: 10 })).resolves.toMatchObject({ items: [{ id: 'settlement-z' }, { id: 'settlement-a' }] });
    await expect(repository.transactionPage('group-1', { category: 'Dining', currency: 'EUR', limit: 10 })).resolves.toMatchObject({ items: [{ id: 'expense-a' }] });
    const payerPage = await repository.transactionPage('group-1', { person: 'person-payer', limit: 10 });
    expect(payerPage.items.map((item) => item.id)).toEqual(['expense-new', 'expense-a', 'expense-other']);
    expect(db.lastSql).toContain('payers WHERE person_id=?');
    const splitPage = await repository.transactionPage('group-1', { person: 'person-split', limit: 10 });
    expect(splitPage.items.map((item) => item.id)).toEqual(['expense-z']);
    expect(db.lastSql).toContain('splits WHERE person_id=?');
    const fromPage = await repository.transactionPage('group-1', { person: 'person-from', limit: 10 });
    expect(fromPage.items.map((item) => item.id)).toEqual(['settlement-z', 'settlement-a']);
    expect(db.lastSql).toContain('tr.from_person_id=? OR tr.to_person_id=?');
  });

  it('excludes deleted transactions and keeps historical settlement names', async () => {
    const repository = new Repository(new TransactionPageDb(transactionRows) as never);
    const page = await repository.transactionPage('group-1', { limit: 100 });
    expect(page.items.some((item) => item.id === 'expense-deleted')).toBe(false);
    expect(page.items.filter((item): item is Extract<Transaction, { kind: 'settlement' }> => item.kind === 'settlement')[0]).toMatchObject({ fromName: 'Former payer', toName: 'Removed participant' });
  });

  it('supports an authorized unscoped all-groups page and includes the display group name', async () => {
    const rows = transactionRows.map((row) => ({ ...row, group_name: row.group_id === 'group-1' ? 'Friend' : 'Other group' }));
    const db = new TransactionPageDb(rows);
    const page = await new Repository(db as never).globalTransactionPage('user-1', undefined, { limit: 2 });

    expect(page.items).toHaveLength(2);
    expect(page.items.every((item) => item.groupName === 'Friend')).toBe(true);
    expect(db.lastSql).toContain('CASE WHEN');
    expect(db.lastSql).toContain('authorized_member.user_id=?');
    expect(db.lastSql).toContain('authorized_group.deleted_at IS NULL');
  });

  it('omits group display names from scoped transaction pages', async () => {
    const rows = transactionRows.map((row) => ({ ...row, group_name: 'Friend' }));
    const groupDb = new TransactionPageDb(rows);
    const groupPage = await new Repository(groupDb as never).transactionPage('group-1', { limit: 2 });
    expect(groupPage.items.every((item) => !('groupName' in item))).toBe(true);
    expect(groupDb.lastSql).toContain('NULL AS group_name');
    expect(groupDb.lastSql).not.toContain('CASE WHEN');

    const scopedGlobalDb = new TransactionPageDb(rows);
    const scopedGlobalPage = await new Repository(scopedGlobalDb as never).globalTransactionPage('user-1', 'group-1', { limit: 2 });
    expect(scopedGlobalPage.items.every((item) => !('groupName' in item))).toBe(true);
    expect(scopedGlobalDb.lastSql).toContain('NULL AS group_name');
    expect(scopedGlobalDb.lastSql).not.toContain('CASE WHEN');
  });

  it('rejects invalid cursors, dates, and offset pagination', async () => {
    const repository = new Repository(new TransactionPageDb(transactionRows) as never);
    await expect(repository.transactionPage('group-1', { cursor: 'not-a-cursor' })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    await expect(repository.transactionPage('group-1', { from: '2026-02-30' })).rejects.toMatchObject({ code: 'INVALID_DATE' });
    await expect(repository.transactionPage('group-1', { offset: 1 })).rejects.toMatchObject({ code: 'INVALID_PAGINATION' });
  });
});

describe('repository friend creation', () => {
  it('creates the ledger-only person, group, and both memberships in one batch', async () => {
    const db = new FriendDb();
    const group = await new Repository(db as never).createFriend('user-1', 'person-1', { name: 'Friend', currency: 'USD' });
    expect(group).toMatchObject({ id: 'group-1', memberCount: 2, counterpartName: 'Friend' });
    expect(db.batches).toHaveLength(1);
     expect(db.batches[0]).toHaveLength(6);
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
     expect(db.batches[0]).toHaveLength(5);
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
  it('scopes global activity to the authenticated user and optional authorized group', async () => {
    const db = new GlobalActivityDb();
    const repo = new Repository(db as never);
    await expect(repo.globalActivity('user-a', undefined, { limit: 100 })).resolves.toMatchObject({ items: [
      { type: 'expense', groupId: 'group-allowed', label: 'Lunch' },
      { type: 'settlement', groupId: 'group-allowed', label: 'Paid' },
    ] });
    await expect(repo.globalActivity('user-a', 'group-other', { limit: 100 })).resolves.toMatchObject({ items: [] });
    expect(db.sql).toContain('gm.user_id=? AND gm.deleted_at IS NULL AND g.deleted_at IS NULL');
    expect(db.sql).toContain('e.deleted_at IS NULL');
    expect(db.sql).toContain('s.deleted_at IS NULL');
    expect(db.sql).not.toContain('FROM revisions');
  });
});

describe('repository global export pagination', () => {
  it('rejects the removed raw group-id cursor format', async () => {
    await expect(new Repository(new GlobalExportDb() as never).exportPage('user-1', { groupCursor: 'group-a' })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
  });

  it('finishes unequal streams before advancing across multiple groups', async () => {
    const db = new GlobalExportDb();
    const repo = new Repository(db as never);
    const calls: Array<{ groupId: string; expenseCursor?: string | null; settlementCursor?: string | null }> = [];
    repo.groupExportPage = async (groupId, options = {}) => {
      calls.push({ groupId, expenseCursor: options.expenseCursor, settlementCursor: options.settlementCursor });
      if (groupId === 'group-a' && !options.settlementCursor) return { version: 1, exportedAt: '', group: { id: groupId }, members: [], expenses: [{ id: 'expense-a' }], settlements: [{ id: 'settlement-a-1' }], nextCursor: { expenses: null, settlements: 'settlement-a-next' } } as never;
      if (groupId === 'group-a') return { version: 1, exportedAt: '', group: { id: groupId }, members: [], expenses: [], settlements: [{ id: 'settlement-a-2' }, { id: 'settlement-a-3' }] } as never;
      return { version: 1, exportedAt: '', group: { id: groupId }, members: [], expenses: [{ id: `expense-${groupId}` }], settlements: [] } as never;
    };

    const first = await repo.exportPage('user-1', { limit: 2 });
    expect(first.groups).toHaveLength(1);
    expect(first.groups[0].settlements).toHaveLength(1);
    expect(first.nextCursor).toBeTruthy();

    const second = await repo.exportPage('user-1', { limit: 2, groupCursor: first.nextCursor });
    expect(second.groups.map((group) => group.group?.id)).toEqual(['group-a', 'group-b']);
    expect(second.groups[0].settlements).toHaveLength(2);
    expect(second.nextCursor).toBeTruthy();

    const third = await repo.exportPage('user-1', { limit: 2, groupCursor: second.nextCursor });
    expect(third.groups.map((group) => group.group?.id)).toEqual(['group-c']);
    expect(third.nextCursor).toBeUndefined();
    expect(calls).toEqual([
      { groupId: 'group-a', expenseCursor: undefined, settlementCursor: undefined },
      { groupId: 'group-a', expenseCursor: null, settlementCursor: 'settlement-a-next' },
      { groupId: 'group-b', expenseCursor: undefined, settlementCursor: undefined },
      { groupId: 'group-c', expenseCursor: undefined, settlementCursor: undefined },
    ]);
  });
});

describe('repository group split defaults', () => {
  it('maps stored basis-point defaults and keeps writes owner/member guarded', async () => {
    const db = new SplitDefaultDb();
    const repo = new Repository(db as never);
    const personIds = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];
    await expect(repo.getGroupSplitDefault('group-1')).resolves.toEqual({ method: 'percentage', personIds, values: [2500, 7500] });
    await expect(repo.upsertGroupSplitDefault('group-1', 'user-1', { method: 'percentage', person_ids: personIds, values: [2500, 7500] })).resolves.toEqual({ method: 'percentage', personIds, values: [2500, 7500] });
    await expect(repo.deleteGroupSplitDefault('group-1', 'user-1')).resolves.toBe(true);
    const upsert = db.sql.find((sql) => sql.includes('INSERT INTO group_split_defaults')) || '';
    expect(upsert).toContain('auth_member.user_id=?');
    expect(upsert).toContain('gm.deleted_at IS NULL');
    expect(upsert).toContain('p.deleted_at IS NULL');
  });

  it('rejects the forbidden exact method before database access', async () => {
    const db = new SplitDefaultDb();
    await expect(new Repository(db as never).upsertGroupSplitDefault('group-1', 'user-1', { method: 'exact', person_ids: ['00000000-0000-4000-8000-000000000001'] } as never)).rejects.toMatchObject({ code: 'INVALID_SPLIT_DEFAULT' });
    expect(db.sql).toEqual([]);
  });

  it('suggests the normalized arrangement from the authenticated user latest three qualifying expenses', async () => {
    const db = new SplitSuggestionDb();
    for (const id of ['expense-1', 'expense-2', 'expense-3']) db.splits[id] = [
      { person_id: suggestionPersonB, metadata_json: '{"method":"percentage","value":7500}' },
      { person_id: suggestionPersonA, metadata_json: '{"method":"percentage","value":2500}' },
    ];
    const suggestion = await new Repository(db as never).getGroupSplitDefaultSuggestion('group-1', 'user-1');
    expect(suggestion).toEqual({ method: 'percentage', personIds: [suggestionPersonA, suggestionPersonB], values: [2500, 7500] });
    expect(db.sql[0]).toContain('e.created_by=?');
    expect(db.sql[0]).toContain('e.deleted_at IS NULL');
    expect(db.sql[0]).toContain('NOT EXISTS (SELECT 1 FROM scheduled_occurrences');
    expect(db.sql[0]).toContain('ORDER BY e.created_at DESC,e.id DESC');
  });

  it('does not suggest an arrangement that already is the party default', async () => {
    const db = new SplitSuggestionDb();
    db.current = { method: 'equal', person_ids_json: `["${suggestionPersonA}","${suggestionPersonB}"]`, values_json: null };
    for (const id of ['expense-1', 'expense-2', 'expense-3']) db.splits[id] = [
      { person_id: suggestionPersonB, metadata_json: '{"method":"equal"}' },
      { person_id: suggestionPersonA, metadata_json: '{"method":"equal"}' },
    ];
    await expect(new Repository(db as never).getGroupSplitDefaultSuggestion('group-1', 'user-1')).resolves.toBeNull();
  });

  it('does not suggest an arrangement containing a removed participant', async () => {
    const db = new SplitSuggestionDb();
    db.members = [{ person_id: suggestionPersonA, name: 'Amy', joined_at: '', role: 'owner' }];
    for (const id of ['expense-1', 'expense-2', 'expense-3']) db.splits[id] = [
      { person_id: suggestionPersonA, metadata_json: '{"method":"equal"}' },
      { person_id: suggestionPersonB, metadata_json: '{"method":"equal"}' },
    ];
    await expect(new Repository(db as never).getGroupSplitDefaultSuggestion('group-1', 'user-1')).resolves.toBeNull();
  });

  it.each([
    ['mismatch', (db: SplitSuggestionDb) => { db.splits['expense-2'] = []; }],
  ])('returns no suggestion for %s patterns', async (_label, mutate) => {
    const db = new SplitSuggestionDb();
    for (const id of ['expense-1', 'expense-2', 'expense-3']) db.splits[id] = [
      { person_id: suggestionPersonA, metadata_json: '{"method":"equal"}' },
      { person_id: suggestionPersonB, metadata_json: '{"method":"equal"}' },
    ];
    mutate(db);
    await expect(new Repository(db as never).getGroupSplitDefaultSuggestion('group-1', 'user-1')).resolves.toBeNull();
  });
});

describe('repository categories', () => {
  it('includes custom categories from active authorized schedules as well as expenses', async () => {
    const db = new CategoriesDb();
    await expect(new Repository(db as never).categories('user-a')).resolves.toEqual(['Custom rent', 'Dining']);
    expect(db.args).toEqual(['user-a', 'user-a', 'user-a']);
    expect(db.sql).toContain('FROM scheduled_expenses se');
    expect(db.sql).not.toContain("se.status<>'cancelled'");
    expect(db.sql).toContain('e.created_by=?');
  });
  it('normalizes descriptions, scopes lookups, and generates guarded upsert/delete statements', async () => {
    const db = new PreferenceDb();
    const repo = new Repository(db as never);
    expect(repo.normalizeCategoryDescription('  DINNER  ')).toBe('dinner');
    await expect(repo.categoryPreference('user-a', '  Dinner ')).resolves.toBe('Dining');
    expect(db.args).toEqual(['user-a', 'dinner']);
    repo.categoryPreferenceStatements('user-a', ' Dinner ', ' Dining ');
    expect(db.sql).toContain('ON CONFLICT(user_id,normalized_description) DO UPDATE');
    expect(db.args).toEqual(['user-a', 'dinner', 'Dining', expect.any(String)]);
    repo.categoryPreferenceStatements('user-a', 'Dinner', null);
    expect(db.sql).toContain('DELETE FROM category_preferences');
  });
  it('uses the migration-compatible ASCII normalization for non-ASCII descriptions', () => {
    expect(new Repository(new PreferenceDb() as never).normalizeCategoryDescription('  ÉCLAIR  ')).toBe('Éclair');
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
    expect(db.sql).toContain('WHERE balance_rank<=2');
  });

  it('uses only active membership and group metadata for single-group authorization', async () => {
    const db = new GroupAuthorizationDb({ userId: 'user-a' });
    const group = await new Repository(db as never).group('group-1', 'user-a');
    expect(group).toMatchObject({ id: 'group-1', role: 'member', memberCount: 2, counterpartName: 'Friend' });
    expect(group?.balanceSummaries).toBeUndefined();
    expect(db.args).toEqual(['group-1', 'user-a']);
    expect(db.sql).toContain('FROM groups g JOIN group_members gm');
    expect(db.sql).toContain('WHERE g.id=? AND g.deleted_at IS NULL');
    expect(db.sql).toContain('gm.user_id=? AND gm.deleted_at IS NULL');
    expect(db.sql).not.toMatch(/\bWITH\b/i);
    expect(db.sql).not.toMatch(/\b(expenses|payers|splits|settlements)\b|authorized_groups|scoped_groups|ledger|group_balances|ranked_balances|balance_json|ROW_NUMBER/i);
  });

  it('returns no group for an unauthorized or deleted group/member', async () => {
    await expect(new Repository(new GroupAuthorizationDb({ userId: 'other-user' }) as never).group('group-1', 'user-a')).resolves.toBeNull();
    await expect(new Repository(new GroupAuthorizationDb({ groupDeleted: true }) as never).group('group-1', 'user-a')).resolves.toBeNull();
    await expect(new Repository(new GroupAuthorizationDb({ memberDeleted: true }) as never).group('group-1', 'user-a')).resolves.toBeNull();
  });

  it('preserves database errors from the scoped group query', async () => {
    const db = { prepare: () => { throw new Error('scoped query failed'); } };
    await expect(new Repository(db as never).groups('user-a')).rejects.toThrow('scoped query failed');
  });
});

describe('repository Clerk identity linking', () => {
  it('links an existing D1 user and preserves its person and membership IDs', async () => {
    const db = new ClerkIdentityDb();
    db.users.push({ id: 'legacy-user', email: 'person@example.com', clerk_user_id: null });
    db.people.push({ id: 'legacy-person', name: 'Person', email: 'person@example.com', user_id: 'legacy-user', deleted_at: null });
    db.members.push({ group_id: 'group-1', person_id: 'legacy-person', user_id: null });
    const identity = await new Repository(db as never, IDENTITY_TOMBSTONE_TEST_KEY).userForClerk('user_123', 'PERSON@example.com');
    expect(identity.user.id).toBe('legacy-user');
    expect(identity.person.id).toBe('legacy-person');
    expect(db.users[0].clerk_user_id).toBe('user_123');
    // Linking a verified identity must not turn a legacy ledger-only member
    // into a group member; an invitation acceptance performs that transition.
    expect(db.members[0].user_id).toBeNull();
  });

  it('creates a new app user and person when the verified email is new', async () => {
    const db = new ClerkIdentityDb();
    const identity = await new Repository(db as never, IDENTITY_TOMBSTONE_TEST_KEY).userForClerk('user_new', 'new@example.com');
    expect(identity.user.email).toBe('new@example.com');
    expect(identity.user.clerk_user_id).toBe('user_new');
    expect(identity.person.user_id).toBe(identity.user.id);
  });

  it('fails closed for an email already linked to another Clerk ID', async () => {
    const db = new ClerkIdentityDb();
    db.users.push({ id: 'linked-user', email: 'person@example.com', clerk_user_id: 'user_existing' });
    await expect(new Repository(db as never, IDENTITY_TOMBSTONE_TEST_KEY).userForClerk('user_other', 'person@example.com')).rejects.toMatchObject({ code: 'AUTH_IDENTITY_CONFLICT' });
    expect(db.users[0].clerk_user_id).toBe('user_existing');
  });

  it('does not relink a deleted internal user by its old Clerk identity', async () => {
    const db = new ClerkIdentityDb();
    db.users.push({ id: 'deleted-user', email: 'deleted+user@billsplit.invalid', clerk_user_id: 'deleted_clerk', deleted_at: '2026-01-01T00:00:00.000Z' });
    await expect(new Repository(db as never, IDENTITY_TOMBSTONE_TEST_KEY).userForClerk('deleted_clerk', 'person@example.com')).rejects.toMatchObject({ code: 'AUTH_IDENTITY_CONFLICT' });
  });

  it('does not create a new internal user for a deleted identity email tombstone', async () => {
    const db = new ClerkIdentityDb();
    db.deletedIdentityTombstone = true;
    await expect(new Repository(db as never, IDENTITY_TOMBSTONE_TEST_KEY).userForClerk('new_clerk', 'person@example.com')).rejects.toMatchObject({ code: 'AUTH_IDENTITY_CONFLICT' });
  });

  it('resolves a linked user by Clerk ID and retains the canonical D1 email after an email change', async () => {
    const db = new ClerkIdentityDb();
    db.users.push({ id: 'stable-user', email: 'old@example.com', clerk_user_id: 'user_stable' });
    db.people.push({ id: 'stable-person', name: 'Stable', email: 'old@example.com', user_id: 'stable-user', deleted_at: null });
    const identity = await new Repository(db as never, IDENTITY_TOMBSTONE_TEST_KEY).userForClerk('user_stable', 'new@example.com');
    expect(identity.user.id).toBe('stable-user');
    expect(identity.user.email).toBe('old@example.com');
    expect(db.users).toHaveLength(1);
  });

  it('self-heals a Clerk mapping left behind before person creation completed', async () => {
    const db = new ClerkIdentityDb();
    db.users.push({ id: 'interrupted-user', email: 'interrupted@example.com', clerk_user_id: 'user_interrupted' });
    const identity = await new Repository(db as never, IDENTITY_TOMBSTONE_TEST_KEY).userForClerk('user_interrupted', 'interrupted@example.com');
    expect(identity.user.id).toBe('interrupted-user');
    expect(identity.person.user_id).toBe('interrupted-user');
    expect(db.people).toHaveLength(1);
  });

  it('fails closed when a concurrent first link wins and never reassigns it', async () => {
    const db = new ClerkIdentityDb();
    db.users.push({ id: 'raced-user', email: 'raced@example.com', clerk_user_id: null });
    db.raceLinkClerkId = 'winner_clerk_id';
    await expect(new Repository(db as never, IDENTITY_TOMBSTONE_TEST_KEY).userForClerk('loser_clerk_id', 'raced@example.com')).rejects.toMatchObject({ code: 'AUTH_IDENTITY_CONFLICT' });
    expect(db.users[0].clerk_user_id).toBe('winner_clerk_id');
  });
});
