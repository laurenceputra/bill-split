import { beforeEach, describe, expect, it, vi } from 'vitest';

const clerkAuthenticateRequest = vi.hoisted(() => vi.fn());
vi.mock('@clerk/backend', () => ({
  createClerkClient: vi.fn(() => ({ authenticateRequest: clerkAuthenticateRequest })),
}));

import worker from './index';

const deletedUser = { id: 'deleted-user', email: 'deleted+deleted-user@billsplit.invalid', clerk_user_id: null, deleted_at: '2026-08-01T00:00:00.000Z' };
class RecoveryStatement {
  constructor(private readonly sql: string, private readonly db: RecoveryDb) {}
  bind(..._args: unknown[]) { return this; }
  async first() {
    if (this.sql.includes('s.id,s.user_id')) return null;
    if (this.sql.includes('SELECT id,deleted_at FROM users')) return this.db.tombstone ? { id: deletedUser.id, deleted_at: deletedUser.deleted_at } : null;
    if (this.sql.includes('SELECT id,email,clerk_user_id,deleted_at FROM users')) return deletedUser;
    return null;
  }
  async run() { return { meta: { changes: 0 } }; }
}
class RecoveryDb {
  tombstone = true;
  prepare(sql: string) { return new RecoveryStatement(sql, this); }
}

class SessionStatement {
  private args: unknown[] = [];
  constructor(private readonly sql: string, private readonly db: SessionDb) {}
  bind(...args: unknown[]) { this.args = args; return this; }
  async first() {
    if (this.sql.includes('s.id,s.user_id')) return this.db.sessionExpired ? null : {
      id: 'session-current', user_id: 'user-current', created_at: '2026-08-01T00:00:00.000Z', last_activity_at: this.db.lastActivity,
      idle_expires_at: '2026-09-01T00:00:00.000Z', email: 'current@example.com', clerk_user_id: this.db.sessionClerkUserId, deleted_at: null, person_id: 'person-current',
    };
    if (this.sql.includes('FROM users WHERE clerk_user_id')) return { id: 'user-current', email: 'current@example.com', clerk_user_id: this.db.identityClerkUserId, deleted_at: null };
    if (this.sql.includes('FROM people WHERE user_id')) return { id: 'person-current', name: 'Current', user_id: 'user-current', deleted_at: null };
    if (this.sql.includes('FROM users WHERE id')) return { id: 'user-current', email: 'current@example.com', clerk_user_id: this.db.identityClerkUserId, deleted_at: null };
    if (this.sql.includes('FROM users')) return { id: 'user-current', email: 'current@example.com' };
    if (this.sql.includes('last_activity_at')) return { id: 'session-current', last_activity_at: this.db.lastActivity, idle_expires_at: '2026-09-01T00:00:00.000Z' };
    return null;
  }
  async run() {
    if (this.sql.includes('UPDATE application_sessions SET revoked_at')) this.db.revocations += 1;
    if (this.sql.includes('UPDATE application_sessions SET last_activity_at')) this.db.renewAttempts += 1;
    if (this.sql.includes('INSERT INTO application_sessions')) this.db.createdSessions += 1;
    return { meta: { changes: this.sql.includes('last_activity_at') ? this.db.renewChanges : 1 } };
  }
}
class SessionDb {
  identityClerkUserId = 'clerk-current';
  sessionClerkUserId = 'clerk-current';
  sessionExpired = false;
  lastActivity = '2026-08-01T00:00:00.000Z';
  renewChanges = 0;
  renewAttempts = 0;
  revocations = 0;
  createdSessions = 0;
  prepare(sql: string) { return new SessionStatement(sql, this); }
}

const env = (db: { prepare: (sql: string) => unknown }) => ({
  ENVIRONMENT: 'production',
  CLERK_PUBLISHABLE_KEY: 'pk_test_fixture',
  CLERK_SECRET_KEY: 'sk_test_fixture',
  CLERK_JWT_KEY: 'jwt-test-fixture',
  CLERK_AUTHORIZED_PARTIES: 'https://split.example',
  IDENTITY_TOMBSTONE_KEY: 'test-tombstone-key',
  DB: db,
  ASSETS: { fetch: () => new Response('asset') },
}) as any;

const recoveryHeaders = {
  Origin: 'https://split.example',
  'Sec-Fetch-Site': 'same-origin',
  Cookie: '__Host-billsplit_session=revoked-token; billsplit_csrf=csrf-token',
  'X-BillSplit-Expected-Clerk-User-Id': 'clerk-original',
  'X-BillSplit-CSRF': 'csrf-token',
  'Content-Type': 'application/json',
};
beforeEach(() => {
  clerkAuthenticateRequest.mockReset();
  clerkAuthenticateRequest.mockResolvedValue({
    isAuthenticated: true,
    status: 'signed-in',
    toAuth: () => ({ isAuthenticated: true, userId: 'clerk-original', sessionClaims: { sub: 'clerk-original', azp: 'https://split.example', primaryEmail: 'original@example.com' } }),
  });
});

describe('production account deletion recovery boundary', () => {
  it('retries a committed deletion with a fresh matching Clerk identity after the app session was revoked', async () => {
    const response = await worker.fetch(new Request('https://split.example/api/account', {
      method: 'DELETE', headers: recoveryHeaders, body: JSON.stringify({ confirmation: 'DELETE MY ACCOUNT' }),
    }), env(new RecoveryDb()), {} as ExecutionContext);

    expect(response.status).toBe(204);
    expect(clerkAuthenticateRequest).toHaveBeenCalledTimes(2);
  });

  it('does not turn a Clerk identity into ordinary API authorization', async () => {
    const response = await worker.fetch(new Request('https://split.example/api/me', {
      headers: { Cookie: recoveryHeaders.Cookie, 'X-BillSplit-Expected-Clerk-User-Id': 'clerk-original' },
    }), env(new RecoveryDb()), {} as ExecutionContext);

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'AUTH_REQUIRED' } });
    expect(clerkAuthenticateRequest).not.toHaveBeenCalled();
  });

  it('does not recover an identity without an existing tombstone', async () => {
    const db = new RecoveryDb();
    db.tombstone = false;
    const response = await worker.fetch(new Request('https://split.example/api/account', {
      method: 'DELETE', headers: recoveryHeaders, body: JSON.stringify({ confirmation: 'DELETE MY ACCOUNT' }),
    }), env(db), {} as ExecutionContext);

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'AUTH_REQUIRED' } });
  });

  it('bootstraps successfully, preserves same-user device sessions, and revokes only the switched current device', async () => {
    const sameUserDb = new SessionDb();
    clerkAuthenticateRequest.mockResolvedValue({
      isAuthenticated: true, status: 'signed-in',
      toAuth: () => ({ isAuthenticated: true, userId: 'clerk-current', sessionClaims: { sub: 'clerk-current', azp: 'https://split.example', primaryEmail: 'current@example.com' } }),
    });
    sameUserDb.sessionClerkUserId = 'clerk-current';
    const bootstrap = (db: SessionDb) => worker.fetch(new Request('https://split.example/api/session/bootstrap', {
      method: 'POST', headers: { Cookie: '__Host-billsplit_session=presented-token', Origin: 'https://split.example', 'Sec-Fetch-Site': 'same-origin' }, body: '{}',
    }), env(db), {} as ExecutionContext);

    const sameUser = await bootstrap(sameUserDb);
    expect(sameUser.status).toBe(200);
    expect(sameUser.headers.get('Set-Cookie')).toContain('__Host-billsplit_session=');
    expect(sameUser.headers.get('Set-Cookie')).toContain('Max-Age=2592000');
    expect(sameUserDb.revocations).toBe(0);
    expect(sameUserDb.createdSessions).toBe(1);

    const switchedDb = new SessionDb();
    switchedDb.identityClerkUserId = 'clerk-new';
    switchedDb.sessionClerkUserId = 'clerk-old';
    clerkAuthenticateRequest.mockResolvedValue({
      isAuthenticated: true, status: 'signed-in',
      toAuth: () => ({ isAuthenticated: true, userId: 'clerk-new', sessionClaims: { sub: 'clerk-new', azp: 'https://split.example', primaryEmail: 'current@example.com' } }),
    });
    const switched = await bootstrap(switchedDb);
    expect(switched.status).toBe(200);
    expect(switchedDb.revocations).toBe(1);
    expect(switchedDb.createdSessions).toBe(1);
  });

  it('requires the app cookie, rejects expiry, throttles activity, and supports current/all-device revocation', async () => {
    const db = new SessionDb();
    const request = (path: string, method = 'GET') => worker.fetch(new Request(`https://split.example${path}`, {
      method,
      headers: { ...recoveryHeaders, Cookie: '__Host-billsplit_session=presented-token; billsplit_csrf=csrf-token', ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
      ...(method === 'POST' ? { body: '{}' } : {}),
    }), env(db), {} as ExecutionContext);

    expect((await request('/api/me')).status).toBe(200);
    db.sessionExpired = true;
    expect((await request('/api/me')).status).toBe(401);
    db.sessionExpired = false;
    const activity = await request('/api/session/activity', 'POST');
    expect(activity.status).toBe(200);
    expect(activity.headers.get('Set-Cookie')).toContain('Max-Age=2592000');
    expect(db.renewAttempts).toBe(1);
    expect((await request('/api/session', 'DELETE')).status).toBe(204);
    expect((await request('/api/sessions', 'DELETE')).status).toBe(204);
    expect(db.revocations).toBe(2);
  });

  it('enforces CSRF independently of the application session boundary', async () => {
    const response = await worker.fetch(new Request('https://split.example/api/session/activity', {
      method: 'POST',
      headers: { Origin: 'https://split.example', 'Sec-Fetch-Site': 'same-origin', Cookie: '__Host-billsplit_session=presented-token', 'Content-Type': 'application/json' },
      body: '{}',
    }), env(new SessionDb()), {} as ExecutionContext);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'CSRF_FORBIDDEN' } });
  });
});
