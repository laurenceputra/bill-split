import { describe, expect, it, vi } from 'vitest';
import worker from './index';

class Statement {
  constructor(protected readonly sql: string) {}
  bind(..._args: unknown[]) { return this; }
  async first() { if (this.sql.includes('deleted_email_hash')) return null; if (this.sql.includes('FROM users')) return { id: 'user-1', email: 'dev@example.com' }; if (this.sql.includes('FROM groups g JOIN')) return null; if (this.sql.includes('FROM people')) return { id: 'person-1', name: 'Dev' }; return null; }
  async run() { return {}; }
  async all() { return { results: [] }; }
}
class MemberStatement extends Statement {
  async first() { if (this.sql.includes('deleted_email_hash')) return null; if (this.sql.includes('FROM users')) return { id: 'user-1', email: 'dev@example.com' }; if (this.sql.includes('FROM groups g JOIN')) return { id: '00000000-0000-4000-8000-000000000009', name: 'Shared', currency: 'USD', created_at: '', updated_at: '', role: 'member' }; if (this.sql.includes('FROM people')) return { id: 'person-1', name: 'Dev' }; return null; }
}
class TriggerOverflowStatement extends MemberStatement {
  async all<T>() {
    if (this.sql.includes('FROM people p JOIN group_members')) return { results: [{ person_id: '00000000-0000-4000-8000-000000000003', name: 'Dev', email: null, joined_at: '', role: 'owner' }, { person_id: '00000000-0000-4000-8000-000000000004', name: 'Other', email: null, joined_at: '', role: 'member' }] as T[] };
    return { results: [] as T[] };
  }
}
class TriggerOverflowDb {
  prepare(sql: string) { return new TriggerOverflowStatement(sql); }
  async batch(_statements: unknown[]) { throw new Error('SQLITE_CONSTRAINT: BALANCE_OVERFLOW'); }
}
class SummaryGroupsStatement extends Statement {
  async all<T>() {
    if (this.sql.includes('FROM groups g JOIN')) return { results: [{ id: 'group-1', name: 'Shared', currency: 'USD', created_at: '', updated_at: '', role: 'owner', member_count: 2, counterpart_name: 'Friend', balance_summaries: '[{"currency":"USD","net_minor":500},{"currency":"EUR","net_minor":-250}]' }] as T[] };
    return { results: [] as T[] };
  }
}
class SummaryGroupsDb {
  prepare(sql: string) { return new SummaryGroupsStatement(sql); }
}
const env = (extra: Record<string, unknown> = {}) => ({ ENVIRONMENT: 'development', DB: { prepare: (sql: string) => new Statement(sql) }, ASSETS: { fetch: () => new Response('asset') }, ...extra }) as any;
const sameOriginHeaders = { Origin: 'https://split.example', 'Sec-Fetch-Site': 'same-origin' };

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
    if (this.sql.includes('deleted_email_hash')) return null;
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

class OverflowStatement extends Statement {
  async first<T>() {
    if (this.sql.includes('deleted_email_hash')) return null;
    if (this.sql.includes('FROM users')) return { id: 'user-1', email: 'dev@example.com' } as T;
    if (this.sql.includes('FROM people')) return { id: 'person-a', name: 'A' } as T;
    if (this.sql.includes('FROM groups')) return { id: 'group-1', name: 'Shared', currency: 'USD', created_at: '', updated_at: '', role: 'member' } as T;
    return null;
  }
  async all<T>() {
    const max = Number.MAX_SAFE_INTEGER;
    if (this.sql.includes('FROM expenses')) return { results: [
      { id: 'expense-1', group_id: 'group-1', description: 'One', amount_minor: max, currency: 'USD', expense_date: '2025-01-01', created_by: 'user-1', created_at: '', updated_at: '', version: 1 },
      { id: 'expense-2', group_id: 'group-1', description: 'Two', amount_minor: max, currency: 'USD', expense_date: '2025-01-02', created_by: 'user-1', created_at: '', updated_at: '', version: 1 },
    ] as T[] };
    if (this.sql.includes('FROM payers')) return { results: [{ expense_id: 'expense-1', person_id: 'person-a', amount_minor: max }, { expense_id: 'expense-2', person_id: 'person-a', amount_minor: max }] as T[] };
    if (this.sql.includes('FROM splits')) return { results: [{ expense_id: 'expense-1', person_id: 'person-b', amount_minor: max }, { expense_id: 'expense-2', person_id: 'person-b', amount_minor: max }] as T[] };
    if (this.sql.includes('FROM settlements')) return { results: [] as T[] };
    if (this.sql.includes('FROM people p JOIN group_members')) return { results: [{ person_id: 'person-a', name: 'A', email: null, joined_at: '', role: 'owner' }, { person_id: 'person-b', name: 'B', email: null, joined_at: '', role: 'member' }] as T[] };
    return { results: [] as T[] };
  }
}

const scheduledRow = { id: '00000000-0000-0000-0000-000000000010', group_id: '00000000-0000-0000-0000-000000000009', description: 'Rent', amount_minor: 1000, currency: 'USD', start_date: '2026-01-01', end_date: null, frequency: 'monthly', interval_count: 1, weekdays_json: '[]', timezone: 'UTC', status: 'active', blocked_reason: null, next_occurrence_date: '2026-01-01', created_by: 'user-1', created_at: '', updated_at: '', version: 1, client_operation_id: null };
class ScheduledRouteDb {
  batches: unknown[][] = [];
  prepare(sql: string) { return new ScheduledRouteStatement(this, sql); }
  async batch(statements: unknown[]) { this.batches.push(statements); return []; }
}
class ScheduledRouteStatement extends Statement {
  constructor(private readonly db: ScheduledRouteDb, sql: string) { super(sql); }
  async first<T>() {
    if (this.sql.includes('deleted_email_hash')) return null;
    if (this.sql.includes('FROM users')) return { id: 'user-1', email: 'dev@example.com' } as T;
    if (this.sql.includes('FROM people WHERE user_id')) return { id: 'person-1', name: 'Dev' } as T;
    if (this.sql.includes('FROM groups g JOIN')) return { id: '00000000-0000-0000-0000-000000000009', name: 'Shared', currency: 'USD', created_at: '', updated_at: '', role: 'owner' } as T;
    if (this.sql.includes('FROM groups WHERE')) return { id: '00000000-0000-0000-0000-000000000009' } as T;
    if (this.sql.includes('FROM scheduled_occurrences')) return null;
    if (this.sql.includes('FROM scheduled_expenses')) return scheduledRow as T;
    return null;
  }
  async all<T>() {
    if (this.sql.includes('FROM people p JOIN group_members')) return { results: [{ person_id: '00000000-0000-0000-0000-000000000001', name: 'Dev', email: null, joined_at: '', role: 'owner' }] as T[] };
    if (this.sql.includes('FROM group_members')) return { results: [{ group_id: '00000000-0000-0000-0000-000000000009', person_id: '00000000-0000-0000-0000-000000000001' }] as T[] };
    if (this.sql.includes('FROM scheduled_expenses')) return { results: [scheduledRow] as T[] };
    return { results: [] as T[] };
  }
  async run() { return { meta: { changes: 1 } }; }
}
class ProjectionFailureStatement extends Statement {
  async all<T>() {
    if (this.sql.includes('FROM groups g LEFT JOIN projection_state')) return { results: [{ id: 'group-1' }] as T[] };
    return { results: [] as T[] };
  }
}
class ProjectionFailureDb {
  prepare(sql: string) { return new ProjectionFailureStatement(sql); }
  async batch() { throw new Error('projection backfill unavailable'); }
}
class MutationDb {
  prepare(sql: string) { return new Statement(sql); }
  async batch(_statements: unknown[]) { return []; }
}
class IdentifiedStatement extends Statement {
  constructor(sql: string, private readonly userId: string) { super(sql); }
  async first<T>() {
    if (this.sql.includes('deleted_email_hash')) return null;
    if (this.sql.includes('FROM users')) return { id: this.userId, email: `${this.userId}@example.com` } as T;
    if (this.sql.includes('FROM people')) return { id: `person-${this.userId}`, name: 'Dev' } as T;
    return null;
  }
}
class IdentifiedDb {
  constructor(private readonly userId: string) {}
  prepare(sql: string) { return new IdentifiedStatement(sql, this.userId); }
  async batch(_statements: unknown[]) { return []; }
}
const testRateLimiter = (success = true) => ({
  success,
  keys: [] as string[],
  async limit({ key }: { key: string }) { this.keys.push(key); return { success: this.success }; },
});

describe('worker boundary', () => {
  it('sanitizes bootstrap return paths', async () => {
    const { sanitizeReturnTo } = await import('./index');
    expect(sanitizeReturnTo('/groups/g-1?tab=activity#ledger')).toBe('/groups/g-1?tab=activity#ledger');
    expect(sanitizeReturnTo('https://evil.test/steal')).toBe('/');
    expect(sanitizeReturnTo('//evil.test/steal')).toBe('/');
    expect(sanitizeReturnTo('/api/me')).toBe('/');
    expect(sanitizeReturnTo('/cdn-cgi/internal/login')).toBe('/');
  });
  it('parses the explicit Clerk authorized-party allowlist', async () => {
    const { parseAuthorizedParties } = await import('./index');
    expect(parseAuthorizedParties('https://billsplit.laurenceputra.com')).toEqual(['https://billsplit.laurenceputra.com']);
    expect(parseAuthorizedParties(' https://one.example, ,https://two.example ')).toEqual(['https://one.example', 'https://two.example']);
  });
  it('rejects API requests without verified production auth', async () => {
    const response = await worker.fetch(new Request('https://split.example/api/me'), env({ ENVIRONMENT: 'production' }), {} as ExecutionContext);
    expect(response.status).toBe(401);
    expect(((await response.json()) as any).error.code).toBe('AUTH_REQUIRED');
  });
  it('returns the authenticated local user response header', async () => {
    const response = await worker.fetch(new Request('https://split.example/api/me', { headers: { 'X-Dev-Email': 'dev@example.com' } }), env(), {} as ExecutionContext);
    expect(response.status).toBe(200);
    expect(response.headers.get('X-BillSplit-User-Id')).toBe('user-1');
    expect(response.headers.get('X-BillSplit-Clerk-User-Id')).toBeNull();
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Pragma')).toBe('no-cache');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(response.headers.get('X-Request-ID')).toBeTruthy();
  });
  it('allows protected creation routes and keys the native limiter by internal user and operation bucket', async () => {
    const limiter = testRateLimiter();
    const group = await worker.fetch(new Request('https://split.example/api/groups', { method: 'POST', headers: { ...sameOriginHeaders, 'X-Dev-Email': 'user-1@example.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Trip', currency: 'USD' }) }), env({ DB: new IdentifiedDb('user-1'), RATE_LIMITER: limiter }), {} as ExecutionContext);
    const friend = await worker.fetch(new Request('https://split.example/api/friends', { method: 'POST', headers: { ...sameOriginHeaders, 'X-Dev-Email': 'user-2@example.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Friend', currency: 'USD' }) }), env({ DB: new IdentifiedDb('user-2'), RATE_LIMITER: limiter }), {} as ExecutionContext);
    expect(group.status).not.toBe(429);
    expect(friend.status).not.toBe(429);
    expect(limiter.keys).toEqual(['user-1:group-create', 'user-2:friend-create']);
  });
  it('denies a protected invitation operation with structured JSON and Retry-After', async () => {
    const limiter = testRateLimiter(false);
    const response = await worker.fetch(new Request('https://split.example/api/invitations/invitation-1/accept', { method: 'POST', headers: { ...sameOriginHeaders, 'X-Dev-Email': 'dev@example.com' } }), env({ RATE_LIMITER: limiter }), {} as ExecutionContext);
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(await response.json()).toEqual({ error: { code: 'RATE_LIMITED', message: 'Too many requests; retry after 60 seconds', details: { retryAfter: 60 } } });
    expect(limiter.keys).toEqual(['user-1:invitation-accept']);
  });
  it('covers only the intended high-risk operation buckets', async () => {
    const { rateLimitOperationFor } = await import('./index');
    expect(rateLimitOperationFor('POST', '/api/groups')).toBe('group-create');
    expect(rateLimitOperationFor('POST', '/api/friends')).toBe('friend-create');
    expect(rateLimitOperationFor('POST', '/api/groups/group-1/invitations')).toBe('invitation-create');
    expect(rateLimitOperationFor('POST', '/api/invitations/inv-1/accept')).toBe('invitation-accept');
    expect(rateLimitOperationFor('POST', '/api/invitations/inv-1/reject')).toBe('invitation-reject');
    expect(rateLimitOperationFor('POST', '/api/groups/group-1/expenses')).toBeUndefined();
    expect(rateLimitOperationFor('POST', '/api/groups/group-1/scheduled-expenses')).toBeUndefined();
    expect(rateLimitOperationFor('POST', '/api/groups/group-1/settlements')).toBeUndefined();
  });
  it('does not rate-limit expense creation, including when the limiter would deny it', async () => {
    const limiter = testRateLimiter(false);
    const response = await worker.fetch(new Request('https://split.example/api/groups/00000000-0000-4000-8000-000000000009/expenses', { method: 'POST', headers: { ...sameOriginHeaders, 'X-Dev-Email': 'dev@example.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ description: 'Offline replay', amount_minor: 100, currency: 'USD', date: '2025-01-01', payers: [{ person_id: '00000000-0000-4000-8000-000000000003', amount_minor: 100 }], splits: [{ person_id: '00000000-0000-4000-8000-000000000004', amount_minor: 100 }] }) }), env({ DB: new TriggerOverflowDb(), RATE_LIMITER: limiter }), {} as ExecutionContext);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: 'BALANCE_OVERFLOW' } });
    expect(limiter.keys).toEqual([]);
  });
  it('returns a private category suggestion for the authenticated user', async () => {
    const response = await worker.fetch(new Request('https://split.example/api/category-suggestion', { method: 'POST', headers: { ...sameOriginHeaders, 'X-Dev-Email': 'dev@example.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ description: 'Dinner' }) }), env(), {} as ExecutionContext);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ category: null });
  });
  it('does not expose the Clerk proof header on static assets', async () => {
    const response = await worker.fetch(new Request('https://split.example/'), env(), {} as ExecutionContext);
    expect(response.headers.get('X-BillSplit-Clerk-User-Id')).toBeNull();
  });
  it('returns authenticated user home balance summaries in the groups response', async () => {
    const response = await worker.fetch(new Request('https://split.example/api/groups', { headers: { 'X-Dev-Email': 'dev@example.com' } }), env({ DB: new SummaryGroupsDb() }), {} as ExecutionContext);
    expect(response.status).toBe(200);
    expect(((await response.json()) as any).groups[0].balanceSummaries).toEqual([{ currency: 'USD', netMinor: 500 }, { currency: 'EUR', netMinor: -250 }]);
  });
  it('preserves a valid request correlation ID', async () => {
    const response = await worker.fetch(new Request('https://split.example/api/me', { headers: { 'X-Dev-Email': 'dev@example.com', 'X-Request-ID': 'test-request-1' } }), env(), {} as ExecutionContext);
    expect(response.headers.get('X-Request-ID')).toBe('test-request-1');
  });
  it('emits a compact structured completion record without request content', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const response = await worker.fetch(new Request('https://split.example/api/me', { headers: { 'X-Dev-Email': 'dev@example.com', 'X-Request-ID': 'structured-request' } }), env(), {} as ExecutionContext);
      const records = log.mock.calls.map(([value]) => JSON.parse(String(value)) as Record<string, unknown>);
      expect(records).toContainEqual(expect.objectContaining({ event: 'bill-split.request', requestId: 'structured-request', method: 'GET', status: 200 }));
      expect(records.find((record) => record.event === 'bill-split.request')).not.toHaveProperty('email');
      expect(response.status).toBe(200);
    } finally { log.mockRestore(); }
  });
  it('rejects oversized chunked mutation bodies with a structured error', async () => {
    const response = await worker.fetch(new Request('https://split.example/api/groups', { method: 'POST', headers: { ...sameOriginHeaders, 'X-Dev-Email': 'dev@example.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x'.repeat(70_000), currency: 'USD' }) }), env(), {} as ExecutionContext);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: 'REQUEST_BODY_TOO_LARGE' } });
  });
  it('rejects cross-site mutation metadata', async () => {
    const response = await worker.fetch(new Request('https://split.example/api/groups', { method: 'POST', headers: { 'X-Dev-Email': 'dev@example.com', 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' }, body: '{}' }), env(), {} as ExecutionContext);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'ORIGIN_FORBIDDEN' } });
  });
  it('adds security headers to static responses', async () => {
    const response = await worker.fetch(new Request('https://split.example/'), env(), {} as ExecutionContext);
    expect(response.status).toBe(200);
    const csp = response.headers.get('Content-Security-Policy') || '';
    const directives = Object.fromEntries(csp.split(';').map((directive) => { const [name, ...values] = directive.trim().split(/\s+/); return [name, values]; }));
    expect(directives['script-src']).toEqual(expect.arrayContaining(['\'self\'', 'https://challenges.cloudflare.com', 'https://*.protect.clerk.com']));
    expect(directives['connect-src']).toEqual(expect.arrayContaining(['\'self\'', 'https://*.protect.clerk.com']));
    expect(directives['img-src']).toEqual(expect.arrayContaining(['\'self\'', 'data:', 'https://img.clerk.com']));
    expect(directives['frame-src']).toEqual(expect.arrayContaining(['\'self\'', 'https://challenges.cloudflare.com', 'https://*.protect.clerk.com']));
    expect(directives['worker-src']).toEqual(expect.arrayContaining(['\'self\'', 'blob:']));
    expect(directives['script-src']).not.toContain('https:');
    expect(directives['connect-src']).not.toContain('https:');
    expect(directives['script-src']).not.toContain("'unsafe-eval'");
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(response.headers.get('X-Request-ID')).toBeTruthy();
  });
  it('derives the production FAPI host from the encoded publishable key only', async () => {
    const publishableKey = 'pk_live_YmlsbHNwbGl0LmxhdXJlbmNlcHV0cmEuY29tJA';
    const response = await worker.fetch(new Request('https://split.example/'), env({ CLERK_PUBLISHABLE_KEY: publishableKey }), {} as ExecutionContext);
    const csp = response.headers.get('Content-Security-Policy') || '';
    expect(csp).toContain('https://billsplit.laurenceputra.com');
    expect(csp).not.toContain('https://evil.example');
    expect(csp).not.toContain('https://split.example');
  });
  it('fails closed for absent or malformed publishable keys without breaking same-origin assets', async () => {
    const { buildContentSecurityPolicy, clerkFrontendApiOrigin } = await import('./index');
    expect(clerkFrontendApiOrigin()).toBeUndefined();
    expect(clerkFrontendApiOrigin('not-a-publishable-key')).toBeUndefined();
    expect(buildContentSecurityPolicy('not-a-publishable-key')).toContain("default-src 'self'");
    expect(buildContentSecurityPolicy('not-a-publishable-key')).not.toContain('https://evil.example');
    const response = await worker.fetch(new Request('https://split.example/'), env({ CLERK_PUBLISHABLE_KEY: 'not-a-publishable-key' }), {} as ExecutionContext);
    expect(response.status).toBe(200);
  });
  it('revalidates the manifest and service-worker script through the asset binding', async () => {
    const assets = { fetch: () => new Response('asset', { headers: { 'Cache-Control': 'public, max-age=31536000' } }) };
    for (const path of ['/manifest.webmanifest', '/sw.js']) {
      const response = await worker.fetch(new Request(`https://split.example${path}`), env({ ASSETS: assets }), {} as ExecutionContext);
      expect(response.headers.get('Cache-Control')).toBe('no-cache');
      expect(response.headers.get('Pragma')).toBe('no-cache');
    }
  });
  it('rejects an outbox identity guard mismatch before the mutation route writes', async () => {
    const response = await worker.fetch(new Request('https://split.example/api/groups/00000000-0000-4000-8000-000000000009/expenses', { method: 'POST', headers: { ...sameOriginHeaders, 'X-Dev-Email': 'dev@example.com', 'X-BillSplit-Expected-User-Id': 'different-user', 'Content-Type': 'application/json' }, body: '{}' }), env(), {} as ExecutionContext);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'IDENTITY_MISMATCH' } });
  });
  it('requires a verified Clerk identity and request binding for account deletion', async () => {
    const { validateAccountDeletionIdentityBinding } = await import('./index');
    expect(validateAccountDeletionIdentityBinding(undefined, undefined)).toMatchObject({ status: 401, code: 'AUTH_REQUIRED' });
    expect(validateAccountDeletionIdentityBinding('clerk-a', undefined)).toMatchObject({ status: 409, code: 'IDENTITY_MISMATCH' });
    expect(validateAccountDeletionIdentityBinding('clerk-a', 'clerk-b')).toMatchObject({ status: 409, code: 'IDENTITY_MISMATCH' });
    expect(validateAccountDeletionIdentityBinding('clerk-a', 'clerk-a')).toEqual({ ok: true });
  });
  it('rejects development account deletion before repository mutation because it has no Clerk identity', async () => {
    const response = await worker.fetch(new Request('https://split.example/api/account', { method: 'DELETE', headers: { ...sameOriginHeaders, 'X-Dev-Email': 'dev@example.com', 'Content-Type': 'application/json', 'X-BillSplit-Expected-Clerk-User-Id': 'clerk-a' }, body: JSON.stringify({ confirmation: 'DELETE MY ACCOUNT' }) }), env(), {} as ExecutionContext);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'AUTH_REQUIRED' } });
  });
  it('rejects browser mutations with no same-origin metadata', async () => {
    const response = await worker.fetch(new Request('https://split.example/api/groups', { method: 'POST', headers: { 'X-Dev-Email': 'dev@example.com', 'Content-Type': 'application/json' }, body: '{}' }), env(), {} as ExecutionContext);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'ORIGIN_FORBIDDEN' } });
  });
  it('does not treat an auth header as a CSRF bypass', async () => {
    const response = await worker.fetch(new Request('https://split.example/api/groups', { method: 'POST', headers: { 'X-Unknown-Auth': 'not-a-browser-bypass', 'Content-Type': 'application/json' }, body: '{}' }), env(), {} as ExecutionContext);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'ORIGIN_FORBIDDEN' } });
  });
  it('allows an explicit bearer non-browser path to reach Clerk authentication', async () => {
    const response = await worker.fetch(new Request('https://split.example/api/groups', { method: 'POST', headers: { Authorization: 'Bearer not-a-valid-token', 'Content-Type': 'application/json' }, body: '{}' }), env({ ENVIRONMENT: 'production', CLERK_PUBLISHABLE_KEY: 'pk_test_invalid', CLERK_SECRET_KEY: 'sk_test_fixture', CLERK_JWT_KEY: 'invalid', CLERK_AUTHORIZED_PARTIES: 'https://split.example' }), {} as ExecutionContext);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: expect.stringMatching(/^AUTH_(?:REQUIRED|INVALID)$/) } });
  });
  it('does not allow a local identity to access a group it is not a member of', async () => {
    const response = await worker.fetch(new Request('https://split.example/api/groups/00000000-0000-4000-8000-000000000009', { headers: { 'X-Dev-Email': 'dev@example.com' } }), env(), {} as ExecutionContext);
    expect(response.status).toBe(404);
    expect(((await response.json()) as any).error.code).toBe('GROUP_NOT_FOUND');
  });
  it('does not leak global activity for an unauthorized group filter', async () => {
    const response = await worker.fetch(new Request('https://split.example/api/activity?group=00000000-0000-4000-8000-000000000009', { headers: { 'X-Dev-Email': 'dev@example.com' } }), env(), {} as ExecutionContext);
    expect(response.status).toBe(404);
    expect(((await response.json()) as any).error.code).toBe('GROUP_NOT_FOUND');
  });
  it('allows an active group member through the group authorization lookup', async () => {
    const response = await worker.fetch(new Request('https://split.example/api/groups/00000000-0000-4000-8000-000000000009', { headers: { 'X-Dev-Email': 'dev@example.com' } }), env({ DB: { prepare: (sql: string) => new MemberStatement(sql) } }), {} as ExecutionContext);
    expect(response.status).toBe(200);
    expect(((await response.json()) as any).group).toMatchObject({ role: 'member', currency: 'USD' });
  });
  it('does not enable the development bypass for near-miss environments', async () => {
    const response = await worker.fetch(new Request('https://split.example/api/me', { headers: { 'X-Dev-Email': 'dev@example.com' } }), env({ ENVIRONMENT: 'Development' }), {} as ExecutionContext);
    expect(response.status).toBe(401);
    expect(((await response.json()) as any).error.code).toBe('AUTH_REQUIRED');
  });
  it('rejects an invalid Clerk session before repository access', async () => {
    const response = await worker.fetch(new Request('https://split.example/api/me', { headers: { Authorization: 'Bearer not-a-valid-token' } }), env({ ENVIRONMENT: 'production', CLERK_PUBLISHABLE_KEY: 'pk_test_invalid', CLERK_SECRET_KEY: 'sk_test_fixture', CLERK_JWT_KEY: 'invalid', CLERK_AUTHORIZED_PARTIES: 'https://split.example' }), {} as ExecutionContext);
    expect(response.status).toBe(401);
    expect(((await response.json()) as any).error.code).toBe('AUTH_INVALID');
  });
  it('reports a missing Clerk secret as configuration rather than an invalid session', async () => {
    const response = await worker.fetch(new Request('https://split.example/api/me', { headers: { Authorization: 'Bearer not-a-valid-token' } }), env({ ENVIRONMENT: 'production', CLERK_PUBLISHABLE_KEY: 'pk_test_invalid', CLERK_JWT_KEY: 'invalid', CLERK_AUTHORIZED_PARTIES: 'https://split.example' }), {} as ExecutionContext);
    expect(response.status).toBe(401);
    expect(((await response.json()) as any).error.code).toBe('AUTH_REQUIRED');
  });
  it('enforces owner-only group administration', async () => {
    const response = await worker.fetch(new Request('https://split.example/api/groups/00000000-0000-4000-8000-000000000009', { method: 'PUT', headers: { ...sameOriginHeaders, 'X-Dev-Email': 'dev@example.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Renamed', currency: 'USD' }) }), env({ DB: { prepare: (sql: string) => new MemberStatement(sql) } }), {} as ExecutionContext);
    expect(response.status).toBe(403);
    expect(((await response.json()) as any).error.code).toBe('OWNER_REQUIRED');
  });
  it('enforces owner-only invitation and member administration routes', async () => {
    const paths: Array<[string, string]> = [
      ['/api/groups/00000000-0000-0000-0000-000000000009/invitations', 'GET'],
      ['/api/groups/00000000-0000-0000-0000-000000000009/invitations', 'POST'],
      ['/api/groups/00000000-0000-0000-0000-000000000009/members/person-1', 'DELETE'],
      ['/api/groups/00000000-0000-0000-0000-000000000009/transfer-ownership', 'POST'],
    ];
    for (const [path, method] of paths) {
       const response = await worker.fetch(new Request(`https://split.example${path}`, { method, headers: { ...sameOriginHeaders, 'X-Dev-Email': 'dev@example.com', ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) }, ...(method === 'POST' ? { body: JSON.stringify(path.includes('transfer-ownership') ? { person_id: '00000000-0000-4000-8000-000000000002' } : { email: 'invitee@example.com' }) } : {}) }), env({ DB: { prepare: (sql: string) => new MemberStatement(sql) } }), {} as ExecutionContext);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: 'OWNER_REQUIRED' } });
    }
  });
  it('maps an expense deleted after authorization to a structured conflict', async () => {
    const response = await worker.fetch(new Request('https://split.example/api/expenses/00000000-0000-4000-8000-000000000001', { method: 'PUT', headers: { ...sameOriginHeaders, 'X-Dev-Email': 'dev@example.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ description: 'Lunch', amount_minor: 100, currency: 'USD', date: '2025-01-01', version: 1, payers: [{ person_id: '00000000-0000-4000-8000-000000000003', amount_minor: 100 }], splits: [{ person_id: '00000000-0000-4000-8000-000000000003', amount_minor: 100 }] }) }), env({ DB: new GoneOnUpdateDb() }), {} as ExecutionContext);
    expect(response.status).toBe(409);
    expect(((await response.json()) as any).error).toMatchObject({ code: 'CONFLICT' });
  });
  it('maps a settlement deleted after authorization to a structured conflict', async () => {
    const response = await worker.fetch(new Request('https://split.example/api/settlements/00000000-0000-4000-8000-000000000002', { method: 'PUT', headers: { ...sameOriginHeaders, 'X-Dev-Email': 'dev@example.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ from_person_id: '00000000-0000-4000-8000-000000000003', to_person_id: '00000000-0000-4000-8000-000000000004', amount_minor: 100, currency: 'USD', date: '2025-01-01', version: 1 }) }), env({ DB: new GoneOnUpdateDb() }), {} as ExecutionContext);
    expect(response.status).toBe(409);
    expect(((await response.json()) as any).error).toMatchObject({ code: 'CONFLICT' });
  });
  it('returns a structured 422 when individually safe expenses overflow an aggregate balance', async () => {
    const response = await worker.fetch(new Request('https://split.example/api/groups/group-1/balances', { headers: { 'X-Dev-Email': 'dev@example.com' } }), env({ DB: { prepare: (sql: string) => new OverflowStatement(sql) } }), {} as ExecutionContext);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: 'BALANCE_OVERFLOW' } });
  });
  it('maps D1 ledger trigger failures to 422 for expense and settlement writes', async () => {
    const database = new TriggerOverflowDb();
    const expenseResponse = await worker.fetch(new Request('https://split.example/api/groups/00000000-0000-4000-8000-000000000009/expenses', { method: 'POST', headers: { ...sameOriginHeaders, 'X-Dev-Email': 'dev@example.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ description: 'Ledger limit', amount_minor: 100, currency: 'USD', date: '2025-01-01', payers: [{ person_id: '00000000-0000-4000-8000-000000000003', amount_minor: 100 }], splits: [{ person_id: '00000000-0000-4000-8000-000000000004', amount_minor: 100 }] }) }), env({ DB: database }), {} as ExecutionContext);
    expect(expenseResponse.status).toBe(422);
    expect(await expenseResponse.json()).toMatchObject({ error: { code: 'BALANCE_OVERFLOW' } });
    const settlementResponse = await worker.fetch(new Request('https://split.example/api/groups/00000000-0000-4000-8000-000000000009/settlements', { method: 'POST', headers: { ...sameOriginHeaders, 'X-Dev-Email': 'dev@example.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ from_person_id: '00000000-0000-4000-8000-000000000003', to_person_id: '00000000-0000-4000-8000-000000000004', amount_minor: 100, currency: 'USD', date: '2025-01-01' }) }), env({ DB: database }), {} as ExecutionContext);
    expect(settlementResponse.status).toBe(422);
    expect(await settlementResponse.json()).toMatchObject({ error: { code: 'BALANCE_OVERFLOW' } });
  });

  it('creates and lists scheduled expenses through authenticated group routes', async () => {
    const database = new ScheduledRouteDb();
    const body = { description: 'Rent', amount_minor: 1000, currency: 'USD', start_date: '2026-01-01', frequency: 'monthly', interval: 1, weekdays: [], timezone: 'UTC', payers: [{ person_id: '00000000-0000-0000-0000-000000000001', amount_minor: 1000 }], splits: [{ person_id: '00000000-0000-0000-0000-000000000001', amount_minor: 1000 }] };
    const create = await worker.fetch(new Request('https://split.example/api/groups/00000000-0000-0000-0000-000000000009/scheduled-expenses', { method: 'POST', headers: { ...sameOriginHeaders, 'X-Dev-Email': 'dev@example.com', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env({ DB: database }), {} as ExecutionContext);
    expect(create.status).toBe(201);
    const list = await worker.fetch(new Request('https://split.example/api/groups/00000000-0000-0000-0000-000000000009/scheduled-expenses', { headers: { 'X-Dev-Email': 'dev@example.com' } }), env({ DB: database }), {} as ExecutionContext);
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ scheduledExpenses: [{ frequency: 'monthly', timezone: 'UTC' }] });
  });

  it('runs the bounded scheduled handler on the unified Worker export', async () => {
     const database = new ScheduledRouteDb();
     const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
     try {
       await worker.scheduled?.({ type: 'scheduled', cron: '*/15 * * * *', scheduledTime: Date.parse('2026-01-02T00:00:00Z'), noRetry: () => undefined } as ScheduledController, env({ DB: database }), {} as ExecutionContext);
       expect(database.batches.some((batch) => batch.some((statement: any) => String(statement.sql ?? '').includes('INSERT INTO expenses')))).toBe(true);
       const record = log.mock.calls.map(([value]) => JSON.parse(String(value)) as Record<string, any>).find((value) => value.event === 'bill-split.cron');
       expect(record).toMatchObject({ outcome: 'completed', generated: expect.any(Number), blocked: expect.any(Number), generationCapped: expect.any(Boolean), projection: { ready: true } });
       expect(record).not.toHaveProperty('email');
     } finally { log.mockRestore(); }
  });
  it('logs a structured projection failure and preserves the scheduled error', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(worker.scheduled?.({ type: 'scheduled', cron: '*/15 * * * *', scheduledTime: Date.parse('2026-01-02T00:00:00Z'), noRetry: () => undefined } as ScheduledController, env({ DB: new ProjectionFailureDb() }), {} as ExecutionContext)).rejects.toThrow('projection backfill unavailable');
      expect(error.mock.calls.map(([value]) => JSON.parse(String(value)))).toContainEqual(expect.objectContaining({ event: 'bill-split.cron', stage: 'projection', outcome: 'failed', error: 'UNEXPECTED_ERROR' }));
      expect(log.mock.calls.map(([value]) => JSON.parse(String(value)))).toContainEqual(expect.objectContaining({ event: 'bill-split.cron', outcome: 'failed', projection: { ready: false } }));
    } finally { log.mockRestore(); error.mockRestore(); }
  });
  it.each(['/api/groups/group-1/expenses?offset=1', '/api/groups/group-1/settlements?offset=1', '/api/groups/group-1/audit?offset=1'])('rejects removed offset pagination on %s', async (path) => {
    const response = await worker.fetch(new Request(`https://split.example${path}`, { headers: { 'X-Dev-Email': 'dev@example.com' } }), env({ DB: { prepare: (sql: string) => new MemberStatement(sql) } }), {} as ExecutionContext);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'INVALID_PAGINATION' } });
  });
});
