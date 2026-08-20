import { describe, expect, it } from 'vitest';
import worker from './index';

class Statement {
  constructor(protected readonly sql: string) {}
  bind(..._args: unknown[]) { return this; }
  async first() { if (this.sql.includes('FROM users')) return { id: 'user-1', email: 'dev@example.com' }; if (this.sql.includes('FROM people')) return { id: 'person-1', name: 'Dev' }; return null; }
  async run() { return {}; }
  async all() { return { results: [] }; }
}
class MemberStatement extends Statement {
  async first() { if (this.sql.includes('FROM users')) return { id: 'user-1', email: 'dev@example.com' }; if (this.sql.includes('FROM people')) return { id: 'person-1', name: 'Dev' }; if (this.sql.includes('FROM groups')) return { id: '00000000-0000-4000-8000-000000000009', name: 'Shared', currency: 'USD', created_at: '', updated_at: '', role: 'member' }; return null; }
}
const env = (extra: Record<string, unknown> = {}) => ({ ENVIRONMENT: 'development', DB: { prepare: (sql: string) => new Statement(sql) }, ASSETS: { fetch: () => new Response('asset') }, ...extra }) as any;

class GoneOnUpdateDb {
  expenseReads = 0;
  settlementReads = 0;
  prepare(sql: string) { return new GoneOnUpdateStatement(this, sql); }
  async batch() { return []; }
}
class GoneOnUpdateStatement {
  args: unknown[] = [];
  constructor(private readonly db: GoneOnUpdateDb, private readonly sql: string) {}
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>() {
    if (this.sql.includes('FROM users')) return { id: 'user-1', email: 'dev@example.com' } as T;
    if (this.sql.includes('FROM people')) return { id: 'person-1', name: 'Dev' } as T;
    if (this.sql.includes('FROM groups')) return { id: '00000000-0000-4000-8000-000000000009', name: 'Shared', currency: 'USD', created_at: '', updated_at: '', role: 'owner' } as T;
    if (this.sql.includes('FROM expenses')) { this.db.expenseReads += 1; return this.db.expenseReads === 1 ? { id: '00000000-0000-4000-8000-000000000001', group_id: '00000000-0000-4000-8000-000000000009', description: 'Lunch', amount_minor: 100, currency: 'USD', expense_date: '2025-01-01', created_by: 'user-1', created_at: '', updated_at: '', version: 1 } as T : null; }
    if (this.sql.includes('FROM settlements')) { this.db.settlementReads += 1; return this.db.settlementReads === 1 ? { id: '00000000-0000-4000-8000-000000000002', group_id: '00000000-0000-4000-8000-000000000009', from_person_id: '00000000-0000-4000-8000-000000000003', to_person_id: '00000000-0000-4000-8000-000000000004', amount_minor: 100, currency: 'USD', settlement_date: '2025-01-01', created_at: '', updated_at: '', version: 1 } as T : null; }
    return null;
  }
  async all<T>() {
    if (this.sql.includes('FROM payers') || this.sql.includes('FROM splits')) return { results: [] as T[] };
    if (this.sql.includes('FROM people p JOIN group_members')) return { results: [{ person_id: '00000000-0000-4000-8000-000000000003', name: 'Dev', email: null, joined_at: '', role: 'owner' }, { person_id: '00000000-0000-4000-8000-000000000004', name: 'Other', email: null, joined_at: '', role: 'member' }] as T[] };
    return { results: [] as T[] };
  }
  async run() { return {}; }
}

describe('worker boundary', () => {
  it('rejects API requests without verified production auth', async () => {
    const response = await worker.fetch(new Request('https://split.example/api/me'), env({ ENVIRONMENT: 'production' }), {} as ExecutionContext);
    expect(response.status).toBe(401);
    expect(((await response.json()) as any).error.code).toBe('AUTH_REQUIRED');
  });
  it('returns the authenticated local user response header', async () => {
    const response = await worker.fetch(new Request('https://split.example/api/me', { headers: { 'X-Dev-Email': 'dev@example.com' } }), env(), {} as ExecutionContext);
    expect(response.status).toBe(200);
    expect(response.headers.get('X-BillSplit-User-Id')).toBe('user-1');
  });
  it('rejects an outbox identity guard mismatch before the mutation route writes', async () => {
    const response = await worker.fetch(new Request('https://split.example/api/groups/00000000-0000-4000-8000-000000000009/expenses', { method: 'POST', headers: { 'X-Dev-Email': 'dev@example.com', 'X-BillSplit-Expected-User-Id': 'different-user', 'Content-Type': 'application/json' }, body: '{}' }), env(), {} as ExecutionContext);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'IDENTITY_MISMATCH' } });
  });
  it('does not allow a local identity to access a group it is not a member of', async () => {
    const response = await worker.fetch(new Request('https://split.example/api/groups/00000000-0000-4000-8000-000000000009', { headers: { 'X-Dev-Email': 'dev@example.com' } }), env(), {} as ExecutionContext);
    expect(response.status).toBe(404);
    expect(((await response.json()) as any).error.code).toBe('GROUP_NOT_FOUND');
  });
  it('does not enable the development bypass for near-miss environments', async () => {
    const response = await worker.fetch(new Request('https://split.example/api/me', { headers: { 'X-Dev-Email': 'dev@example.com' } }), env({ ENVIRONMENT: 'Development' }), {} as ExecutionContext);
    expect(response.status).toBe(401);
    expect(((await response.json()) as any).error.code).toBe('AUTH_REQUIRED');
  });
  it('accepts the standard Access assertion header path before JWT verification', async () => {
    const response = await worker.fetch(new Request('https://split.example/api/me', { headers: { 'Cf-Access-Jwt-Assertion': 'not-a-valid-jwt' } }), env({ ENVIRONMENT: 'production', ACCESS_TEAM_DOMAIN: 'team.example.com', ACCESS_AUD: 'aud' }), {} as ExecutionContext);
    expect(response.status).toBe(401);
    expect(((await response.json()) as any).error.code).toBe('AUTH_INVALID');
  });
  it('enforces owner-only group administration', async () => {
    const response = await worker.fetch(new Request('https://split.example/api/groups/00000000-0000-4000-8000-000000000009', { method: 'PUT', headers: { 'X-Dev-Email': 'dev@example.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Renamed', currency: 'USD' }) }), env({ DB: { prepare: (sql: string) => new MemberStatement(sql) } }), {} as ExecutionContext);
    expect(response.status).toBe(403);
    expect(((await response.json()) as any).error.code).toBe('OWNER_REQUIRED');
  });
  it('maps an expense deleted after authorization to a structured conflict', async () => {
    const response = await worker.fetch(new Request('https://split.example/api/expenses/00000000-0000-4000-8000-000000000001', { method: 'PUT', headers: { 'X-Dev-Email': 'dev@example.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ description: 'Lunch', amount_minor: 100, currency: 'USD', date: '2025-01-01', version: 1, payers: [{ person_id: '00000000-0000-4000-8000-000000000003', amount_minor: 100 }], splits: [{ person_id: '00000000-0000-4000-8000-000000000003', amount_minor: 100 }] }) }), env({ DB: new GoneOnUpdateDb() }), {} as ExecutionContext);
    expect(response.status).toBe(409);
    expect(((await response.json()) as any).error).toMatchObject({ code: 'CONFLICT' });
  });
  it('maps a settlement deleted after authorization to a structured conflict', async () => {
    const response = await worker.fetch(new Request('https://split.example/api/settlements/00000000-0000-4000-8000-000000000002', { method: 'PUT', headers: { 'X-Dev-Email': 'dev@example.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ from_person_id: '00000000-0000-4000-8000-000000000003', to_person_id: '00000000-0000-4000-8000-000000000004', amount_minor: 100, currency: 'USD', date: '2025-01-01', version: 1 }) }), env({ DB: new GoneOnUpdateDb() }), {} as ExecutionContext);
    expect(response.status).toBe(409);
    expect(((await response.json()) as any).error).toMatchObject({ code: 'CONFLICT' });
  });
});
