import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { createClerkClient } from '@clerk/backend';
import { parsePublishableKey } from '@clerk/shared/keys';
import { accountDeletionInput, categorySuggestionInput, currency, date, friendInput, groupInput, groupSplitDefaultInput, invitationInput, ownershipTransferInput, personInput } from '../shared/schemas';
import { simplifyDebts } from '../domain/balances';
import { Repository, RepositoryError, assertLikeSearch } from '../db/repository';
import { BalanceOverflowError } from '../shared/money';
import { APPLICATION_SESSION_ACTIVITY_THROTTLE_MS, APPLICATION_SESSION_IDLE_MS } from '../shared/session-policy';
import { assertClerkAuthenticationConfig, authenticateClerkSession, ClerkAuthenticationError } from './clerk-auth';
import { escapeCsvCell, settlementCsvRow } from './csv';
import { CSRF_COOKIE, CSRF_HEADER, constantTimeEqual, cookieValue, randomSessionToken, serializeCookie, sessionCookieName, sha256Hex } from './application-session';
import { registerExpenseSettlementRoutes } from './expense-settlement-routes';
export { parseAuthorizedParties } from './clerk-auth';

type ApplicationAuth = { id: string; email: string; personId: string; clerkUserId?: string; applicationSessionId?: string; idleExpiresAt?: string };
export type CronStage = 'purge' | 'generation' | 'monthly-summary' | 'build-gc';
const cronStages: CronStage[] = ['purge', 'generation', 'monthly-summary', 'build-gc'];
const cronSlotMs = 15 * 60 * 1000;
/** Rotate the first stage by scheduled slot so no stage is always last. */
export const cronStageOrder = (scheduledTime: number): CronStage[] => {
  const start = ((Math.floor(scheduledTime / cronSlotMs) % cronStages.length) + cronStages.length) % cronStages.length;
  return [...cronStages.slice(start), ...cronStages.slice(0, start)];
};
type Env = { Bindings: { DB: D1Database; ASSETS: Fetcher; RATE_LIMITER?: RateLimit; ENVIRONMENT?: string; CLERK_PUBLISHABLE_KEY?: string; CLERK_SECRET_KEY?: string; CLERK_JWT_KEY?: string; CLERK_AUTHORIZED_PARTIES?: string; IDENTITY_TOMBSTONE_KEY?: string }; Variables: { auth: ApplicationAuth; repo: Repository; requestId: string } };
export const DEVELOPMENT_IDENTITY_TOMBSTONE_KEY = 'billsplit-development-identity-tombstone-key-v1';
const repositoryFor = (env: Env['Bindings']) => new Repository(env.DB, env.IDENTITY_TOMBSTONE_KEY || (env.ENVIRONMENT === 'development' ? DEVELOPMENT_IDENTITY_TOMBSTONE_KEY : undefined));
const api = new Hono<Env>();
const jsonError = (c: any, status: number, code: string, message: string, details?: Record<string, unknown>) => c.json({ error: { code, message, ...(details ? { details } : {}) } }, status);
const getRepo = (c: any) => c.get('repo') as Repository;
export const MAX_API_BODY_BYTES = 64 * 1024;
// Manual CSP follows Clerk's current CSP guidance. The FAPI origin is decoded
// from the configured publishable key rather than assuming it is the app
// origin. See https://clerk.com/docs/guides/secure/best-practices/csp-headers.md
export const clerkFrontendApiOrigin = (publishableKey?: string): string | undefined => {
  try {
    const frontendApi = parsePublishableKey(publishableKey)?.frontendApi;
    if (!frontendApi) return undefined;
    const url = new URL(frontendApi.includes('://') ? frontendApi : `https://${frontendApi}`);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(url.hostname)) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
};
export const buildContentSecurityPolicy = (publishableKey?: string): string => {
  const fapi = clerkFrontendApiOrigin(publishableKey);
  const fapiSource = fapi ? ` ${fapi}` : '';
  return `default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; script-src 'self'${fapiSource} https://challenges.cloudflare.com https://*.protect.clerk.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://img.clerk.com; font-src 'self'; connect-src 'self'${fapiSource} https://*.protect.clerk.com; frame-src 'self' https://challenges.cloudflare.com https://*.protect.clerk.com; manifest-src 'self'; worker-src 'self' blob:`;
};
const REVALIDATED_ASSETS = new Set(['/manifest.webmanifest', '/sw.js']);
const requestIdFor = (request: Request) => {
  const supplied = request.headers.get('X-Request-ID');
  return supplied && /^[A-Za-z0-9._-]{1,128}$/.test(supplied) ? supplied : crypto.randomUUID();
};
const routeTemplateFor = (c: any) => {
  const route = c.req.routePath;
  if (typeof route === 'string' && route) return route;
  // Hono exposes routePath for matched routes. Keep a safe fallback for
  // adapters/tests that do not, without recording opaque transaction IDs.
  return String(c.req.path || '/').replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '/:id').replace(/\/\d+(?=\/|$)/g, '/:id');
};
const logRequestCompletion = (c: any, startedAt: number, failed = false, status?: number) => {
  console.log(JSON.stringify({ event: 'bill-split.request', requestId: c.get('requestId'), method: c.req.method, route: routeTemplateFor(c), status: failed ? 500 : status ?? c.res.status, durationMs: Math.max(0, Date.now() - startedAt) }));
};
const setSecurityHeaders = (headers: Headers, requestId: string, apiResponse: boolean, publishableKey?: string) => {
  headers.set('X-Request-ID', requestId);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Permissions-Policy', 'camera=(), geolocation=(), microphone=(), payment=()');
  headers.set('X-Frame-Options', 'DENY');
  if (apiResponse) {
    headers.set('Cache-Control', 'no-store');
    headers.set('Pragma', 'no-cache');
  } else {
    headers.set('Content-Security-Policy', buildContentSecurityPolicy(publishableKey));
  }
};
const readBoundedBody = async (c: any): Promise<boolean> => {
  const contentLength = c.req.header('Content-Length');
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_API_BODY_BYTES)) return false;
  const body = c.req.raw.body as ReadableStream<Uint8Array> | null;
  if (!body) return true;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > MAX_API_BODY_BYTES) {
      await reader.cancel();
      return false;
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  c.req.raw = new Request(c.req.raw, { body: bytes });
  c.req.bodyCache = {};
  return true;
};
const allowsMutation = (c: any) => {
  const url = new URL(c.req.url);
  const origin = c.req.header('Origin');
  const fetchSite = c.req.header('Sec-Fetch-Site');
  const authorization = c.req.header('Authorization');
  const exactOrigin = origin === url.origin;
  const trustedFetchSite = fetchSite === 'same-origin';
  if (origin !== undefined && !exactOrigin) return false;
  if (fetchSite !== undefined && !trustedFetchSite) return false;
  // An Authorization header is not an authentication fallback. Permit the
  // legacy non-browser request to reach the explicit no-session rejection so
  // callers receive a normal auth error, but never pass that token to Clerk
  // or an application route.
  return exactOrigin || trustedFetchSite || /^Bearer\s+\S+$/i.test(authorization ?? '');
};
const repositoryError = (c: any, error: unknown) => {
   if (error instanceof RepositoryError) return jsonError(c, error.code === 'BALANCE_OVERFLOW' ? 422 : error.code === 'OWNER_REQUIRED' ? 403 : error.code === 'CONFLICT' || error.code === 'IDEMPOTENCY_CONFLICT' || error.code === 'AUTH_IDENTITY_CONFLICT' || error.code === 'FINAL_OWNER' || error.code === 'INVITATION_EXPIRED' || error.code === 'INVITATION_REVOKED' || error.code === 'ACCOUNT_DELETION_BLOCKED' ? 409 : error.code === 'SELF_FRIEND' || error.code === 'INVITATION_INVALID' || error.code === 'MEMBER_REQUIRED' || error.code === 'INVALID_SEARCH' || error.code === 'INVALID_CURSOR' || error.code === 'INVALID_PAGINATION' || error.code === 'INVALID_DATE' || error.code === 'INVALID_SPLIT_DEFAULT' ? 400 : 500, error.code, error.message, error.details);
  throw error;
};
export const ACCOUNT_DELETION_EXPECTED_CLERK_USER_ID_HEADER = 'X-BillSplit-Expected-Clerk-User-Id';
export const validateAccountDeletionIdentityBinding = (authenticatedClerkUserId: unknown, expectedClerkUserId: string | undefined) => {
  if (typeof authenticatedClerkUserId !== 'string' || authenticatedClerkUserId.trim() === '') return { status: 401 as const, code: 'AUTH_REQUIRED' as const, message: 'A verified Clerk identity is required for account deletion' };
  if (!expectedClerkUserId) return { status: 409 as const, code: 'IDENTITY_MISMATCH' as const, message: 'The account deletion request is not bound to the verified Clerk identity' };
  if (expectedClerkUserId !== authenticatedClerkUserId) return { status: 409 as const, code: 'IDENTITY_MISMATCH' as const, message: 'The account deletion request is bound to a different Clerk identity' };
  return { ok: true as const };
};
const accountDeletionIdentityError = (c: any) => {
  const clerkUserId = c.get('auth')?.clerkUserId;
  const expectedClerkUserId = c.req.header(ACCOUNT_DELETION_EXPECTED_CLERK_USER_ID_HEADER);
  const result = validateAccountDeletionIdentityBinding(clerkUserId, expectedClerkUserId);
  if (!result.ok) return jsonError(c, result.status, result.code, result.message);
  return undefined;
};
const freshClerkIdentityForDeletion = async (c: any) => {
  const env = c.env;
  const config = { publishableKey: env.CLERK_PUBLISHABLE_KEY, secretKey: env.CLERK_SECRET_KEY, jwtKey: env.CLERK_JWT_KEY, authorizedParties: env.CLERK_AUTHORIZED_PARTIES };
  try {
    assertClerkAuthenticationConfig(config);
    const clerk = createClerkClient({ publishableKey: env.CLERK_PUBLISHABLE_KEY, secretKey: env.CLERK_SECRET_KEY, jwtKey: env.CLERK_JWT_KEY });
    return await authenticateClerkSession(c.req.raw, config, clerk.authenticateRequest.bind(clerk));
  } catch (error) {
    if (error instanceof ClerkAuthenticationError) return error;
    return new ClerkAuthenticationError('AUTH_INVALID', 'A fresh Clerk identity is required for account deletion');
  }
};
const recoverDeletedAccountIdentity = async (c: any, repo: Repository) => {
  const expectedClerkUserId = c.req.header(ACCOUNT_DELETION_EXPECTED_CLERK_USER_ID_HEADER);
  if (!expectedClerkUserId) return undefined;
  const fresh = await freshClerkIdentityForDeletion(c);
  if (fresh instanceof ClerkAuthenticationError) return jsonError(c, 401, fresh.code, fresh.message);
  const binding = validateAccountDeletionIdentityBinding(fresh.clerkUserId, expectedClerkUserId);
  if (!binding.ok) return jsonError(c, binding.status, binding.code, binding.message);
  const deleted = await repo.deletedAccountForIdentity(fresh.clerkUserId, fresh.primaryEmail);
  if (!deleted) return undefined;
  return { id: String(deleted.id), email: fresh.primaryEmail, personId: '', clerkUserId: fresh.clerkUserId };
};
const authenticateClerkIdentity = async (c: any) => {
  const env = c.env;
  const clerkConfig = { publishableKey: env.CLERK_PUBLISHABLE_KEY, secretKey: env.CLERK_SECRET_KEY, jwtKey: env.CLERK_JWT_KEY, authorizedParties: env.CLERK_AUTHORIZED_PARTIES };
  assertClerkAuthenticationConfig(clerkConfig);
  const clerk = createClerkClient({ publishableKey: env.CLERK_PUBLISHABLE_KEY, secretKey: env.CLERK_SECRET_KEY, jwtKey: env.CLERK_JWT_KEY });
  return authenticateClerkSession(c.req.raw, clerkConfig, clerk.authenticateRequest.bind(clerk));
};
const authForClerkClaims = async (repo: Repository, identityClaims: Awaited<ReturnType<typeof authenticateClerkIdentity>>) => {
  const identity = await repo.userForClerk(identityClaims.clerkUserId, identityClaims.primaryEmail);
  return {
    id: String(identity.user.id), email: String(identity.user.email), personId: String(identity.person.id), clerkUserId: identityClaims.clerkUserId,
  } satisfies ApplicationAuth;
};
const issueApplicationSession = async (c: any, auth: ApplicationAuth) => {
  const token = randomSessionToken();
  const createdAt = new Date().toISOString();
  const idleExpiresAt = new Date(Date.parse(createdAt) + APPLICATION_SESSION_IDLE_MS).toISOString();
  const session = await getRepo(c).createApplicationSession(auth.id, await sha256Hex(token), createdAt, idleExpiresAt);
  c.res.headers.append('Set-Cookie', serializeCookie(sessionCookieName(c.env.ENVIRONMENT), token, { maxAge: APPLICATION_SESSION_IDLE_MS / 1000, httpOnly: true, secure: c.env.ENVIRONMENT !== 'development' && c.env.ENVIRONMENT !== 'test' }));
  return { ...auth, applicationSessionId: session.id, idleExpiresAt: session.idleExpiresAt } satisfies ApplicationAuth;
};
const balanceError = (c: any, error: unknown) => error instanceof BalanceOverflowError ? jsonError(c, 422, error.code, error.message) : undefined;
export type RateLimitOperation = 'group-create' | 'friend-create' | 'invitation-create' | 'invitation-target-create' | 'invitation-accept' | 'invitation-reject';
export const rateLimitOperationFor = (method: string, pathname: string): RateLimitOperation | undefined => {
  if (method !== 'POST') return undefined;
  if (pathname === '/api/groups') return 'group-create';
  if (pathname === '/api/friends') return 'friend-create';
  if (/^\/api\/groups\/[^/]+\/invitations$/.test(pathname)) return 'invitation-create';
  if (/^\/api\/groups\/[^/]+\/members\/[^/]+\/invitation$/.test(pathname)) return 'invitation-target-create';
  if (/^\/api\/invitations\/[^/]+\/(accept|reject)$/.test(pathname)) return pathname.endsWith('/accept') ? 'invitation-accept' : 'invitation-reject';
  return undefined;
};
export const rateLimitKeyFor = (userId: string, operation: RateLimitOperation): string => `${userId}:${operation}`;
const rateLimitUnavailable = (c: any) => jsonError(c, 503, 'RATE_LIMITER_UNAVAILABLE', 'The protected operation is temporarily unavailable');
const rateLimitExceeded = (c: any) => { c.header('Retry-After', '60'); return jsonError(c, 429, 'RATE_LIMITED', 'Too many requests; retry after 60 seconds', { retryAfter: 60 }); };
const allowsDevelopmentRateLimitBypass = (environment?: string) => environment === 'development' || environment === 'test';

api.use('/api/*', async (c, next) => {
  const startedAt = Date.now();
  const requestId = requestIdFor(c.req.raw);
  c.set('requestId', requestId);
  setSecurityHeaders(c.res.headers, requestId, true);
  let failed = false;
  let earlyResponse: Response | undefined;
  try {
    if (!cookieValue(c.req.raw, CSRF_COOKIE)) c.res.headers.append('Set-Cookie', serializeCookie(CSRF_COOKIE, randomSessionToken(), { secure: c.env.ENVIRONMENT !== 'development' && c.env.ENVIRONMENT !== 'test' }));
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(c.req.method)) {
      if (!allowsMutation(c)) { earlyResponse = jsonError(c, 403, 'ORIGIN_FORBIDDEN', 'Mutations require same-origin browser metadata or an explicit bearer authorization'); return earlyResponse; }
      const path = new URL(c.req.url).pathname;
      const csrfCookie = cookieValue(c.req.raw, CSRF_COOKIE);
      const csrfHeader = c.req.header(CSRF_HEADER);
      if (path !== '/api/session/bootstrap' && c.env.ENVIRONMENT !== 'development' && c.env.ENVIRONMENT !== 'test' && cookieValue(c.req.raw, sessionCookieName(c.env.ENVIRONMENT)) && !constantTimeEqual(csrfCookie, csrfHeader)) { earlyResponse = jsonError(c, 403, 'CSRF_FORBIDDEN', 'A matching host-only CSRF token is required'); return earlyResponse; }
      if (!(await readBoundedBody(c))) { earlyResponse = jsonError(c, 413, 'REQUEST_BODY_TOO_LARGE', 'Request body must not exceed 64 KiB'); return earlyResponse; }
    }
    await next();
    const auth = c.get('auth');
    if (auth) {
      c.res.headers.set('X-BillSplit-User-Id', auth.id);
      // This header is attached only to authenticated same-origin API
      // responses. Static assets and non-API responses never receive it.
      if (auth.clerkUserId && new URL(c.req.url).pathname === '/api/me') c.res.headers.set('X-BillSplit-Clerk-User-Id', auth.clerkUserId);
    }
    setSecurityHeaders(c.res.headers, requestId, true);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    logRequestCompletion(c, startedAt, failed, earlyResponse?.status);
  }
});
api.use('/api/*', async (c, next) => {
  const env = c.env;
  const pathname = new URL(c.req.url).pathname;
  const devEmail = c.req.header('X-Dev-Email');
  const hasApplicationCookie = Boolean(cookieValue(c.req.raw, sessionCookieName(env.ENVIRONMENT)));
  if (env.ENVIRONMENT === 'development' && !hasApplicationCookie && devEmail && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(devEmail)) {
    try {
      const repo = repositoryFor(env); const identity = await repo.user(devEmail.trim().toLowerCase());
      const auth = { id: String(identity.user.id), email: String(identity.user.email), personId: String(identity.person.id) };
      const expectedUserId = c.req.header('X-BillSplit-Expected-User-Id');
      if (expectedUserId && expectedUserId !== auth.id) return jsonError(c, 401, 'IDENTITY_MISMATCH', 'The verified identity changed; sign in again before syncing');
      c.set('repo', repo); c.set('auth', auth); c.header('X-BillSplit-User-Id', auth.id); await next();
      return;
    } catch (error) {
      if (error instanceof RepositoryError) return repositoryError(c, error);
      console.error(JSON.stringify({ message: 'database request failed', requestId: c.get('requestId') })); return jsonError(c, 500, 'DATABASE_ERROR', 'The request could not be completed');
    }
  }

  // Clerk is used only to bootstrap a new application session. Every other
  // ordinary API request, including GET /api/me, requires the app cookie.
  if (pathname === '/api/session/bootstrap') {
    try {
      const repo = repositoryFor(env);
      const identityClaims = await authenticateClerkIdentity(c);
      const presentedToken = cookieValue(c.req.raw, sessionCookieName(env.ENVIRONMENT));
      if (presentedToken) {
        const presentedSession = await repo.applicationSession(await sha256Hex(presentedToken));
        if (presentedSession && presentedSession.clerkUserId !== identityClaims.clerkUserId) await repo.revokeApplicationSessionForIdentitySwitch(presentedSession.id, identityClaims.clerkUserId);
      }
      const auth = await authForClerkClaims(repo, identityClaims);
      c.set('repo', repo); c.set('auth', auth);
      await next();
      return;
    } catch (error) {
      if (error instanceof ClerkAuthenticationError) return jsonError(c, 401, error.code, error.message);
      if (error instanceof RepositoryError) return repositoryError(c, error);
      return jsonError(c, 401, 'AUTH_INVALID', 'The Clerk session could not be verified');
    }
  }

  const rawToken = cookieValue(c.req.raw, sessionCookieName(env.ENVIRONMENT));
  try {
    const repo = repositoryFor(env);
    const session = rawToken ? await repo.applicationSession(await sha256Hex(rawToken)) : null;
    if (session) {
      const auth = { id: session.userId, email: session.email, personId: session.personId, clerkUserId: session.clerkUserId, applicationSessionId: session.id, idleExpiresAt: session.idleExpiresAt };
      const expectedUserId = c.req.header('X-BillSplit-Expected-User-Id');
      if (expectedUserId && expectedUserId !== auth.id) return jsonError(c, 401, 'IDENTITY_MISMATCH', 'The verified identity changed; sign in again before syncing');
      c.set('repo', repo); c.set('auth', auth); c.header('X-BillSplit-User-Id', auth.id); await next();
      return;
    }
    // This is the sole post-commit recovery exception. It is available only
    // for DELETE /account, requires a fresh Clerk identity bound to the
    // request header, and resolves an existing Clerk tombstone. No ordinary
    // API route reaches Clerk here.
    if (pathname === '/api/account' && c.req.method === 'DELETE') {
      const recoveryAuth = await recoverDeletedAccountIdentity(c, repo);
      if (recoveryAuth instanceof Response) return recoveryAuth;
      if (recoveryAuth) {
        c.set('repo', repo); c.set('auth', recoveryAuth); c.header('X-BillSplit-User-Id', recoveryAuth.id); c.header('X-BillSplit-Clerk-User-Id', recoveryAuth.clerkUserId); await next();
        return;
      }
    }
    return jsonError(c, 401, /^Bearer\s+\S+$/i.test(c.req.header('Authorization') ?? '') && env.CLERK_SECRET_KEY ? 'AUTH_INVALID' : 'AUTH_REQUIRED', 'A valid BillSplit session is required');
  } catch (error) {
    if (error instanceof RepositoryError) return repositoryError(c, error);
    console.error(JSON.stringify({ message: 'database request failed', requestId: c.get('requestId') })); return jsonError(c, 401, 'AUTH_REQUIRED', 'The BillSplit session could not be verified');
  }
});
// This middleware is deliberately placed after authentication. It only sees
// internal BillSplit user IDs, never provider IDs, email addresses, or IPs.
api.use('/api/*', async (c, next) => {
  const operation = rateLimitOperationFor(c.req.method, new URL(c.req.url).pathname);
  if (!operation) return next();
  const environment = c.env.ENVIRONMENT;
  const limiter = c.env.RATE_LIMITER;
  if (!limiter && allowsDevelopmentRateLimitBypass(environment)) return next();
  if (!limiter) return rateLimitUnavailable(c);
  try {
    const outcome = await limiter.limit({ key: rateLimitKeyFor(c.get('auth').id, operation) });
    if (!outcome.success) return rateLimitExceeded(c);
  } catch (error) {
    console.error(JSON.stringify({ event: 'bill-split.rate-limit', operation, outcome: 'unavailable', error: error instanceof Error ? error.name : 'UNEXPECTED_ERROR', requestId: c.get('requestId') }));
    return rateLimitUnavailable(c);
  }
  return next();
});

async function authorizedGroup(c: any, groupId: string): Promise<{ repo: Repository; auth: { id: string; email: string; personId: string }; group: NonNullable<Awaited<ReturnType<Repository['group']>>>; role: 'owner' | 'member' } | Response> {
  const repo = getRepo(c), auth = c.get('auth'); const group = await repo.group(groupId, auth.id);
  if (!group) return jsonError(c, 404, 'GROUP_NOT_FOUND', 'Group not found');
  return { repo, auth, group, role: group.role === 'owner' ? 'owner' : 'member' };
}
async function authorizedScheduled(c: any, scheduledId: string): Promise<{ repo: Repository; auth: { id: string; email: string; personId: string }; scheduled: NonNullable<Awaited<ReturnType<Repository['scheduledExpense']>>> } | Response> {
  const repo = getRepo(c), scheduled = await repo.scheduledExpense(scheduledId);
  if (!scheduled) return jsonError(c, 404, 'SCHEDULED_EXPENSE_NOT_FOUND', 'Scheduled expense not found');
  const group = await repo.group(scheduled.groupId, c.get('auth').id);
  if (!group) return jsonError(c, 404, 'SCHEDULED_EXPENSE_NOT_FOUND', 'Scheduled expense not found');
  return { repo, auth: c.get('auth'), scheduled };
}
const ownerOnly = (c: any, x: { role: 'owner' | 'member' }) => x.role === 'owner' ? null : jsonError(c, 403, 'OWNER_REQUIRED', 'Only group owners can perform this action');
async function validPeople(repo: Repository, groupId: string, ids: string[]) { const members = await repo.members(groupId); const allowed = new Set(members.map((m) => m.personId)); return ids.every((id) => allowed.has(id)); }
function page(value: string | undefined, fallback: number, max: number) { if (value === undefined) return fallback; const n = Number(value); return Number.isSafeInteger(n) && n >= 0 ? Math.min(n, max) : -1; }
const rejectOffset = (c: any) => c.req.query('offset') === undefined ? undefined : jsonError(c, 400, 'INVALID_PAGINATION', 'Offset pagination is no longer supported; use the cursor');

/** Return only a same-origin app path after authentication succeeds. */
export function sanitizeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/';
  try {
    const url = new URL(value, 'https://billsplit.invalid');
    if (url.origin !== 'https://billsplit.invalid' || /^(?:\/api(?:\/|$)|\/cdn-cgi(?:\/|$)|\/sign-in(?:\/|$)|\/sign-up(?:\/|$))/i.test(url.pathname)) return '/';
    return `${url.pathname}${url.search}${url.hash}` || '/';
  } catch { return '/'; }
}

api.post('/api/session/bootstrap', async (c) => {
  const auth = c.get('auth');
  if (!auth.clerkUserId) return jsonError(c, 401, 'AUTH_REQUIRED', 'A verified Clerk identity is required to bootstrap a session');
  try {
    const sessionAuth = await issueApplicationSession(c, auth);
    c.set('auth', sessionAuth);
    c.header('X-BillSplit-User-Id', sessionAuth.id);
    c.header('X-BillSplit-Clerk-User-Id', sessionAuth.clerkUserId!);
    return c.json({ user: { id: sessionAuth.id, email: sessionAuth.email, personId: sessionAuth.personId }, idleExpiresAt: sessionAuth.idleExpiresAt });
  } catch (error) { return repositoryError(c, error); }
});
api.get('/api/me', (c) => { const a = c.get('auth'); c.header('X-BillSplit-User-Id', a.id); if (a.clerkUserId) c.header('X-BillSplit-Clerk-User-Id', a.clerkUserId); return c.json({ id: a.id, email: a.email, personId: a.personId, ...(a.idleExpiresAt ? { idleExpiresAt: a.idleExpiresAt } : {}) }); });
api.post('/api/session/activity', async (c) => {
  const auth = c.get('auth');
  if (!auth.applicationSessionId) return c.json({ idleExpiresAt: auth.idleExpiresAt });
  const session = await getRepo(c).renewApplicationSession(auth.applicationSessionId, new Date().toISOString(), APPLICATION_SESSION_ACTIVITY_THROTTLE_MS);
  if (!session) return jsonError(c, 401, 'AUTH_REQUIRED', 'A valid BillSplit session is required');
  c.res.headers.append('Set-Cookie', serializeCookie(sessionCookieName(c.env.ENVIRONMENT), cookieValue(c.req.raw, sessionCookieName(c.env.ENVIRONMENT)) || '', { maxAge: APPLICATION_SESSION_IDLE_MS / 1000, httpOnly: true, secure: c.env.ENVIRONMENT !== 'development' && c.env.ENVIRONMENT !== 'test' }));
  return c.json({ idleExpiresAt: session.idleExpiresAt });
});
const clearApplicationSessionCookie = (c: any) => c.res.headers.append('Set-Cookie', serializeCookie(sessionCookieName(c.env.ENVIRONMENT), '', { maxAge: 0, httpOnly: true, secure: c.env.ENVIRONMENT !== 'development' && c.env.ENVIRONMENT !== 'test' }));
api.delete('/api/session', async (c) => { const id = c.get('auth').applicationSessionId; if (id) await getRepo(c).revokeApplicationSession(id); clearApplicationSessionCookie(c); return c.body(null, 204); });
api.delete('/api/sessions', async (c) => { await getRepo(c).revokeAllApplicationSessions(c.get('auth').id); clearApplicationSessionCookie(c); return c.body(null, 204); });
api.delete('/api/account', zValidator('json', accountDeletionInput), async (c) => {
  const identityError = accountDeletionIdentityError(c);
  if (identityError) return identityError;
  const fresh = await freshClerkIdentityForDeletion(c);
  if (fresh instanceof ClerkAuthenticationError) return jsonError(c, 401, fresh.code, fresh.message);
  if (fresh.clerkUserId !== c.get('auth').clerkUserId) return jsonError(c, 409, 'IDENTITY_MISMATCH', 'The fresh Clerk identity does not match this BillSplit session');
  try { await getRepo(c).deleteAccount(c.get('auth').id); clearApplicationSessionCookie(c); return c.body(null, 204); } catch (error) { return repositoryError(c, error); }
});
api.post('/api/category-suggestion', zValidator('json', categorySuggestionInput), async (c) => c.json({ category: await getRepo(c).categorySuggestion(c.get('auth').id, c.req.valid('json').description) }));
api.get('/api/groups', async (c) => c.json({ groups: await getRepo(c).groups(c.get('auth').id) }));
api.post('/api/groups', zValidator('json', groupInput), async (c) => c.json({ group: await getRepo(c).createGroup(c.get('auth').id, c.get('auth').personId, c.req.valid('json')) }, 201));
api.post('/api/friends', zValidator('json', friendInput), async (c) => { try { const input = c.req.valid('json'); return c.json({ group: await getRepo(c).createFriend(c.get('auth').id, c.get('auth').personId, input) }, 201); } catch (error) { return repositoryError(c, error); } });
api.get('/api/groups/:groupId', async (c) => { const x = await authorizedGroup(c, c.req.param('groupId')); if (x instanceof Response) return x; const groupId = c.req.param('groupId'); const [members, historicalParticipants, splitDefault, currentPersonId] = await Promise.all([x.repo.members(groupId), x.repo.historicalParticipants(groupId), x.repo.getGroupSplitDefault(groupId), x.repo.currentPersonId(groupId, x.auth.id)]); return c.json({ group: x.group, members, historicalParticipants, splitDefault, currentPersonId }); });
api.get('/api/groups/:groupId/split-default-suggestion', async (c) => { const x = await authorizedGroup(c, c.req.param('groupId')); if (x instanceof Response) return x; try { return c.json({ suggestion: await x.repo.getGroupSplitDefaultSuggestion(c.req.param('groupId'), x.auth.id) }); } catch (error) { return repositoryError(c, error); } });
api.get('/api/groups/:groupId/historical-participants', async (c) => { const x = await authorizedGroup(c, c.req.param('groupId')); if (x instanceof Response) return x; return c.json({ participants: await x.repo.historicalParticipants(c.req.param('groupId')) }); });
api.put('/api/groups/:groupId', zValidator('json', groupInput), async (c) => { const x = await authorizedGroup(c, c.req.param('groupId')); if (x instanceof Response) return x; const denied = ownerOnly(c, x); if (denied) return denied; return c.json({ group: await x.repo.updateGroup(c.req.param('groupId'), x.auth.id, c.req.valid('json')) }); });
api.put('/api/groups/:groupId/split-default', zValidator('json', groupSplitDefaultInput), async (c) => { const x = await authorizedGroup(c, c.req.param('groupId')); if (x instanceof Response) return x; try { return c.json({ splitDefault: await x.repo.upsertGroupSplitDefault(c.req.param('groupId'), x.auth.id, c.req.valid('json')) }); } catch (error) { return repositoryError(c, error); } });
api.delete('/api/groups/:groupId/split-default', async (c) => { const x = await authorizedGroup(c, c.req.param('groupId')); if (x instanceof Response) return x; const denied = ownerOnly(c, x); if (denied) return denied; try { await x.repo.deleteGroupSplitDefault(c.req.param('groupId'), x.auth.id); return c.body(null, 204); } catch (error) { return repositoryError(c, error); } });
api.delete('/api/groups/:groupId', async (c) => { const x = await authorizedGroup(c, c.req.param('groupId')); if (x instanceof Response) return x; const denied = ownerOnly(c, x); if (denied) return denied; try { await x.repo.deleteGroup(c.req.param('groupId'), x.auth.id); return c.body(null, 204); } catch (error) { return repositoryError(c, error); } });
api.post('/api/groups/:groupId/people', zValidator('json', personInput), async (c) => { const x = await authorizedGroup(c, c.req.param('groupId')); if (x instanceof Response) return x; const denied = ownerOnly(c, x); if (denied) return denied; try { return c.json({ person: await x.repo.addPerson(c.req.param('groupId'), c.req.valid('json'), x.auth.id, x.auth.personId) }, 201); } catch (error) { return repositoryError(c, error); } });
api.delete('/api/groups/:groupId/members/:personId', async (c) => { const x = await authorizedGroup(c, c.req.param('groupId')); if (x instanceof Response) return x; const denied = ownerOnly(c, x); if (denied) return denied; try { await x.repo.removeMember(c.req.param('groupId'), c.req.param('personId'), x.auth.id); return c.body(null, 204); } catch (error) { return repositoryError(c, error); } });
api.post('/api/groups/:groupId/members/:personId/invitation', zValidator('json', invitationInput), async (c) => { const x = await authorizedGroup(c, c.req.param('groupId')); if (x instanceof Response) return x; const denied = ownerOnly(c, x); if (denied) return denied; try { return c.json({ invitation: await x.repo.createTargetedInvitation(c.req.param('groupId'), c.req.param('personId'), x.auth.id, c.req.valid('json').email) }, 201); } catch (error) { return repositoryError(c, error); } });
api.post('/api/groups/:groupId/transfer-ownership', zValidator('json', ownershipTransferInput), async (c) => { const x = await authorizedGroup(c, c.req.param('groupId')); if (x instanceof Response) return x; const denied = ownerOnly(c, x); if (denied) return denied; try { await x.repo.transferOwnership(c.req.param('groupId'), c.req.valid('json').person_id, x.auth.id); return c.body(null, 204); } catch (error) { return repositoryError(c, error); } });
api.post('/api/groups/:groupId/leave', async (c) => { const x = await authorizedGroup(c, c.req.param('groupId')); if (x instanceof Response) return x; try { await x.repo.leaveGroup(c.req.param('groupId'), x.auth.id); return c.body(null, 204); } catch (error) { return repositoryError(c, error); } });
api.post('/api/groups/:groupId/invitations', zValidator('json', invitationInput), async (c) => { const x = await authorizedGroup(c, c.req.param('groupId')); if (x instanceof Response) return x; const denied = ownerOnly(c, x); if (denied) return denied; try { return c.json({ invitation: await x.repo.createInvitation(c.req.param('groupId'), x.auth.id, c.req.valid('json').email) }, 201); } catch (error) { return repositoryError(c, error); } });
api.get('/api/groups/:groupId/invitations', async (c) => { const x = await authorizedGroup(c, c.req.param('groupId')); if (x instanceof Response) return x; const denied = ownerOnly(c, x); if (denied) return denied; return c.json({ invitations: await x.repo.invitationsForOwner(c.req.param('groupId')) }); });
api.delete('/api/groups/:groupId/invitations/:invitationId', async (c) => { const x = await authorizedGroup(c, c.req.param('groupId')); if (x instanceof Response) return x; const denied = ownerOnly(c, x); if (denied) return denied; const revoked = await x.repo.revokeInvitation(c.req.param('groupId'), c.req.param('invitationId'), x.auth.id); if (!revoked) return jsonError(c, 404, 'INVITATION_NOT_FOUND', 'Invitation not found'); return c.body(null, 204); });
api.get('/api/invitations', async (c) => c.json({ invitations: await getRepo(c).invitationsForUser(c.get('auth').id) }));
api.post('/api/invitations/:invitationId/accept', async (c) => { try { return c.json({ invitation: await getRepo(c).acceptInvitation(c.req.param('invitationId'), c.get('auth').id) }); } catch (error) { return repositoryError(c, error); } });
api.post('/api/invitations/:invitationId/reject', async (c) => { const rejected = await getRepo(c).rejectInvitation(c.req.param('invitationId'), c.get('auth').id); if (!rejected) return jsonError(c, 404, 'INVITATION_NOT_FOUND', 'Invitation not found'); return c.body(null, 204); });

registerExpenseSettlementRoutes(api, { authorizedGroup, authorizedScheduled, getRepo, jsonError, repositoryError, balanceError, validPeople, page, rejectOffset });
api.get('/api/transactions', async (c) => {
  const q = c.req.query();
  const offsetError = rejectOffset(c); if (offsetError) return offsetError;
  const limit = page(q.limit, 25, 100);
  if (limit < 1) return jsonError(c, 400, 'INVALID_PAGINATION', 'Pagination values must be finite non-negative integers');
  if (q.kind !== undefined && q.kind !== 'expense' && q.kind !== 'settlement') return jsonError(c, 400, 'INVALID_FILTER', 'Transaction kind must be expense or settlement');
  if (q.currency !== undefined && !currency.safeParse(q.currency).success) return jsonError(c, 400, 'INVALID_FILTER', 'Currency filter is invalid');
  try { if (q.from) date.parse(q.from); if (q.to) date.parse(q.to); assertLikeSearch(q.q); }
  catch (error) { if (error instanceof RepositoryError) return repositoryError(c, error); return jsonError(c, 400, 'INVALID_DATE', 'Date filters must be real YYYY-MM-DD dates'); }
  if (q.group && (await authorizedGroup(c, q.group)) instanceof Response) return jsonError(c, 404, 'GROUP_NOT_FOUND', 'Group not found');
  try {
    const result = await getRepo(c).globalTransactionPage(c.get('auth').id, q.group || undefined, { kind: q.kind as 'expense' | 'settlement' | undefined, q: q.q, person: q.person, category: q.category, from: q.from, to: q.to, currency: q.currency, limit, cursor: q.cursor });
    return c.json({ transactions: result.items, nextCursor: result.nextCursor });
  } catch (error) { return repositoryError(c, error); }
});


api.get('/api/groups/:groupId/balances', async (c) => {
  const x = await authorizedGroup(c, c.req.param('groupId')); if (x instanceof Response) return x; const groupId = c.req.param('groupId');
  const [projection, members] = await Promise.all([x.repo.balanceProjection(groupId), x.repo.allMembers(groupId)]);
  const names = Object.fromEntries(members.map((m) => [m.personId, m.name])); const currencies = [...new Set([x.group.currency, ...projection.rows.map((row) => row.currency)])];
  const balances: Record<string, { raw: Array<{ personId: string; name: string; netMinor: number; currency: typeof x.group.currency }>; simplified: ReturnType<typeof simplifyDebts> }> = {};
  for (const current of currencies) {
    const net: Record<string, number> = Object.fromEntries(projection.rows.filter((row) => row.currency === current).map((row) => [row.personId, row.netMinor]));
    const raw = Object.entries(net).map(([personId, netMinor]) => ({ personId, name: names[personId] ?? personId, netMinor, currency: current }));
    balances[current] = { raw, simplified: simplifyDebts(net, current, names) };
  }
  return c.json({ currencies, balances });
});
api.get('/api/activity', async (c) => { const q = c.req.query(), groupId = q.group; if (groupId && (await authorizedGroup(c, groupId)) instanceof Response) return jsonError(c, 404, 'GROUP_NOT_FOUND', 'Group not found'); const limit = page(q.limit, 50, 100); if (limit < 1) return jsonError(c, 400, 'INVALID_PAGINATION', 'Pagination values must be finite non-negative integers'); try { const result = await getRepo(c).globalActivity(c.get('auth').id, groupId || undefined, { limit, cursor: q.cursor }); return c.json({ activity: result.items, nextCursor: result.nextCursor }); } catch (error) { return repositoryError(c, error); } });
api.get('/api/groups/:groupId/audit', async (c) => { const x = await authorizedGroup(c, c.req.param('groupId')); if (x instanceof Response) return x; const offsetError = rejectOffset(c); if (offsetError) return offsetError; const q = c.req.query(), limit = page(q.limit, 50, 100); if (limit < 1) return jsonError(c, 400, 'INVALID_PAGINATION', 'Pagination values must be finite non-negative integers'); try { const result = await x.repo.auditPage(c.req.param('groupId'), { limit, cursor: q.cursor }); return c.json({ audit: result.items, nextCursor: result.nextCursor }); } catch (error) { return repositoryError(c, error); } });
api.get('/api/categories', async (c) => c.json({ categories: await getRepo(c).categories(c.get('auth').id) }));
 api.get('/api/groups/:groupId/export.json', async (c) => { const x = await authorizedGroup(c, c.req.param('groupId')); if (x instanceof Response) return x; const q = c.req.query(), limit = page(q.limit, 50, 100); if (limit < 1) return jsonError(c, 400, 'INVALID_PAGINATION', 'Pagination values must be finite non-negative integers'); try { return c.json(await x.repo.groupExportPage(c.req.param('groupId'), { limit, expenseCursor: q.expenseDone === '1' ? null : q.expenseCursor, settlementCursor: q.settlementDone === '1' ? null : q.settlementCursor })); } catch (error) { return repositoryError(c, error); } });
   api.get('/api/groups/:groupId/export.csv', async (c) => { const x = await authorizedGroup(c, c.req.param('groupId')); if (x instanceof Response) return x; const offsetError = rejectOffset(c); if (offsetError) return offsetError; const q = c.req.query(), limit = page(q.limit, 100, 100); if (limit < 1) return jsonError(c, 400, 'INVALID_PAGINATION', 'Pagination values must be finite non-negative integers'); try { const result = await x.repo.expensePage(c.req.param('groupId'), { limit, cursor: q.cursor }); const csv = ['date,description,amount_minor,currency,payers,splits', ...result.items.map((expense) => [expense.date, expense.description, expense.amountMinor, expense.currency, expense.payers.map((p) => `${p.personId}:${p.amountMinor}`).join(';'), expense.splits.map((s) => `${s.personId}:${s.amountMinor}`).join(';')].map(escapeCsvCell).join(','))].join('\n'); const headers: Record<string, string> = { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="group-expenses.csv"' }; if (result.nextCursor) headers['X-Next-Cursor'] = result.nextCursor; return new Response(csv, { headers }); } catch (error) { return repositoryError(c, error); } });
   api.get('/api/groups/:groupId/settlements.csv', async (c) => { const x = await authorizedGroup(c, c.req.param('groupId')); if (x instanceof Response) return x; const offsetError = rejectOffset(c); if (offsetError) return offsetError; const q = c.req.query(), limit = page(q.limit, 100, 100); if (limit < 1) return jsonError(c, 400, 'INVALID_PAGINATION', 'Pagination values must be finite non-negative integers'); try { const result = await x.repo.settlementPage(c.req.param('groupId'), { limit, cursor: q.cursor }); const csv = ['date,from_person,to_person,amount_minor,currency,note', ...result.items.map(settlementCsvRow)].join('\n'); const headers: Record<string, string> = { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="group-settlements.csv"' }; if (result.nextCursor) headers['X-Next-Cursor'] = result.nextCursor; return new Response(csv, { headers }); } catch (error) { return repositoryError(c, error); } });
api.get('/api/export.json', async (c) => { const q = c.req.query(), limit = page(q.limit, 1, 2); if (limit < 1) return jsonError(c, 400, 'INVALID_PAGINATION', 'Pagination values must be finite non-negative integers'); return c.json(await getRepo(c).exportPage(c.get('auth').id, { limit, groupCursor: q.groupCursor })); });

api.notFound((c) => jsonError(c, 404, 'NOT_FOUND', 'API route not found'));
api.onError((error, c) => { const balanceResponse = balanceError(c, error); if (balanceResponse) return balanceResponse; if (error instanceof RepositoryError) return repositoryError(c, error); console.error(JSON.stringify({ message: 'request failed', requestId: c.get('requestId') })); return jsonError(c, 500, 'INTERNAL_ERROR', 'Unexpected server error'); });
export default { async fetch(request: Request, env: Env['Bindings'], ctx: ExecutionContext) {
  const requestId = requestIdFor(request);
  const url = new URL(request.url);
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return api.fetch(request, env, ctx);
  const response = await env.ASSETS.fetch(request);
  const headers = new Headers(response.headers);
  setSecurityHeaders(headers, requestId, false, env.CLERK_PUBLISHABLE_KEY);
  if (REVALIDATED_ASSETS.has(url.pathname)) {
    headers.set('Cache-Control', 'no-cache');
    headers.set('Pragma', 'no-cache');
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }, async scheduled(controller: ScheduledController, env: Env['Bindings'], _ctx: ExecutionContext) {
  // Cron is deliberately bounded in the repository so a long-outage catch-up
  // cannot consume the entire invocation. A later tick resumes from the
  // template's next occurrence cursor.
    const repo = repositoryFor(env);
   const asOf = new Date(controller.scheduledTime);
   let failure: unknown;
   let purge: Awaited<ReturnType<Repository['purgeExpiredData']>> | undefined;
   let generation: Awaited<ReturnType<Repository['generateDueScheduledExpenses']>> | undefined;
    let sessions: Awaited<ReturnType<Repository['purgeExpiredApplicationSessions']>> | undefined;
    let summary: Awaited<ReturnType<Repository['monthlySummaryMaintenance']>> | undefined;
    let buildGc: Awaited<ReturnType<Repository['ledgerPeriodBuildGarbageCollection']>> | undefined;
    let capped = false;
    let deadlineExhausted = false;
    // Keep one deadline for every bounded Cron stage. The cursors and leases
    // make an invocation that yields here safe to resume on the next tick.
    const deadlineMs = Date.now() + 25_000;
    const runs: Record<CronStage, () => Promise<unknown>> = {
      // Application-session cleanup is part of purge, not a fifth rotating
      // stage. Both operations share this invocation deadline.
      purge: async () => {
        sessions = await repo.purgeExpiredApplicationSessions(asOf, 100);
        const result = await repo.purgeExpiredData(asOf, { maxTransactions: 4, maxGroups: 1, deadlineMs });
        return result;
      },
      generation: () => repo.generateDueScheduledExpenses(asOf, { maxTemplates: 8, maxOccurrences: 8, maxOccurrencesPerTemplate: 8, maxCleanup: 2, deadlineMs }),
      'monthly-summary': () => repo.monthlySummaryMaintenance({ maxGroups: 1, maxMonths: 2, chunkSize: 100, deadlineMs }),
      'build-gc': () => repo.ledgerPeriodBuildGarbageCollection({ maxBuilds: 1, chunkSize: 100, deadlineMs }),
    };
    for (const stage of cronStageOrder(controller.scheduledTime)) {
      if (Date.now() >= deadlineMs) { capped = true; deadlineExhausted = true; break; }
      try {
        const result = await runs[stage]();
        if (stage === 'purge') purge = result as typeof purge;
        else if (stage === 'generation') generation = result as typeof generation;
        else if (stage === 'monthly-summary') summary = result as typeof summary;
        else buildGc = result as typeof buildGc;
        if ((result as { capped?: boolean }).capped) capped = true;
      } catch (error) {
        failure ??= error;
        console.error(JSON.stringify({ event: 'bill-split.cron', scheduledTime: controller.scheduledTime, stage, outcome: 'failed', error: error instanceof RepositoryError ? error.code : 'UNEXPECTED_ERROR' }));
      }
    }
   console.log(JSON.stringify({
     event: 'bill-split.cron',
     scheduledTime: controller.scheduledTime,
     outcome: failure ? 'failed' : 'completed',
      purged: purge ? { transactions: purge.transactionsPurged, groups: purge.groupsPurged, auditEvents: purge.auditEventsPurged, capped: purge.capped } : undefined,
      sessionsPurged: sessions?.purged ?? 0,
      generated: generation?.generated ?? 0,
      blocked: generation?.blocked ?? 0,
      generationCapped: generation?.capped ?? deadlineExhausted,
      monthlySummary: summary ? { groupsScanned: summary.groupsScanned, monthsScanned: summary.monthsScanned, monthsVerified: summary.monthsVerified, chunks: summary.chunks, groupsFailed: summary.groupsFailed, monthsFailed: summary.monthsFailed, capped: summary.capped } : { ready: false, capped },
      buildGc: buildGc ? { buildsScanned: buildGc.buildsScanned, buildsCompleted: buildGc.buildsCompleted, balancesDeleted: buildGc.balancesDeleted, totalsDeleted: buildGc.totalsDeleted, capped: buildGc.capped } : { buildsScanned: 0, buildsCompleted: 0, balancesDeleted: 0, totalsDeleted: 0, capped },
      capped,
   }));
   if (failure) throw failure;
 } };
