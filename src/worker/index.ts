import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { createClerkClient } from '@clerk/backend';
import { parsePublishableKey } from '@clerk/shared/keys';
import { assertFinancialInput, date, expenseInput, friendInput, groupInput, personInput, scheduledExpenseInput, scheduledExpenseStatusInput, settlementInput } from '../shared/schemas';
import { calculateNet, simplifyDebts } from '../domain/balances';
import { Repository, RepositoryError } from '../db/repository';
import { BalanceOverflowError, checkedAddMinor } from '../shared/money';
import { assertClerkAuthenticationConfig, authenticateClerkSession, ClerkAuthenticationError } from './clerk-auth';
export { parseAuthorizedParties } from './clerk-auth';

type Env = { Bindings: { DB: D1Database; ASSETS: Fetcher; ENVIRONMENT?: string; CLERK_PUBLISHABLE_KEY?: string; CLERK_SECRET_KEY?: string; CLERK_JWT_KEY?: string; CLERK_AUTHORIZED_PARTIES?: string }; Variables: { auth: { id: string; email: string; personId: string }; repo: Repository; requestId: string } };
const api = new Hono<Env>();
const jsonError = (c: any, status: number, code: string, message: string) => c.json({ error: { code, message } }, status);
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
  const hasBrowserMetadata = origin !== undefined || fetchSite !== undefined;
  const exactOrigin = origin === url.origin;
  const trustedFetchSite = fetchSite === 'same-origin';
  const explicitBearer = /^Bearer\s+\S+$/i.test(authorization ?? '');
  if (origin !== undefined && !exactOrigin) return false;
  if (fetchSite !== undefined && !trustedFetchSite) return false;
  return exactOrigin || trustedFetchSite || (!hasBrowserMetadata && explicitBearer);
};
const repositoryError = (c: any, error: unknown) => {
  if (error instanceof RepositoryError) return jsonError(c, error.code === 'BALANCE_OVERFLOW' ? 422 : error.code === 'CONFLICT' || error.code === 'IDEMPOTENCY_CONFLICT' || error.code === 'AUTH_IDENTITY_CONFLICT' ? 409 : error.code === 'SELF_FRIEND' ? 400 : 500, error.code, error.message);
  throw error;
};
const balanceError = (c: any, error: unknown) => error instanceof BalanceOverflowError ? jsonError(c, 422, error.code, error.message) : undefined;

api.use('/api/*', async (c, next) => {
  const requestId = requestIdFor(c.req.raw);
  c.set('requestId', requestId);
  setSecurityHeaders(c.res.headers, requestId, true);
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(c.req.method)) {
    if (!allowsMutation(c)) return jsonError(c, 403, 'ORIGIN_FORBIDDEN', 'Mutations require same-origin browser metadata or an explicit bearer authorization');
    if (!(await readBoundedBody(c))) return jsonError(c, 413, 'REQUEST_BODY_TOO_LARGE', 'Request body must not exceed 64 KiB');
  }
  await next();
  const auth = c.get('auth');
  if (auth) c.res.headers.set('X-BillSplit-User-Id', auth.id);
  setSecurityHeaders(c.res.headers, requestId, true);
});
api.use('/api/*', async (c, next) => {
  const env = c.env;
  const devEmail = c.req.header('X-Dev-Email');
  if (env.ENVIRONMENT === 'development' && devEmail && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(devEmail)) {
    try {
      const repo = new Repository(env.DB); const identity = await repo.user(devEmail.trim().toLowerCase());
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

  try {
    const clerkConfig = { publishableKey: env.CLERK_PUBLISHABLE_KEY, secretKey: env.CLERK_SECRET_KEY, jwtKey: env.CLERK_JWT_KEY, authorizedParties: env.CLERK_AUTHORIZED_PARTIES };
    assertClerkAuthenticationConfig(clerkConfig);
    const clerk = createClerkClient({ publishableKey: env.CLERK_PUBLISHABLE_KEY, secretKey: env.CLERK_SECRET_KEY, jwtKey: env.CLERK_JWT_KEY });
    const identityClaims = await authenticateClerkSession(c.req.raw, clerkConfig, clerk.authenticateRequest.bind(clerk));
    const repo = new Repository(env.DB); const identity = await repo.userForClerk(identityClaims.clerkUserId, identityClaims.primaryEmail);
    const auth = { id: String(identity.user.id), email: String(identity.user.email), personId: String(identity.person.id) };
    const expectedUserId = c.req.header('X-BillSplit-Expected-User-Id');
    if (expectedUserId && expectedUserId !== auth.id) return jsonError(c, 401, 'IDENTITY_MISMATCH', 'The verified identity changed; sign in again before syncing');
    c.set('repo', repo); c.set('auth', auth); c.header('X-BillSplit-User-Id', auth.id); await next();
  } catch (error) {
    if (error instanceof ClerkAuthenticationError) return jsonError(c, 401, error.code, error.message);
    if (error instanceof RepositoryError) return repositoryError(c, error);
    if (error instanceof Error && /Clerk|token|JWT|authorized|session/i.test(error.message)) return jsonError(c, 401, 'AUTH_INVALID', 'The Clerk session could not be verified');
    console.error(JSON.stringify({ message: 'database request failed', requestId: c.get('requestId') })); return jsonError(c, 500, 'DATABASE_ERROR', 'The request could not be completed');
  }
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

/** Return only a same-origin app path after authentication succeeds. */
export function sanitizeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/';
  try {
    const url = new URL(value, 'https://billsplit.invalid');
    if (url.origin !== 'https://billsplit.invalid' || /^(?:\/api(?:\/|$)|\/cdn-cgi(?:\/|$)|\/sign-in(?:\/|$)|\/sign-up(?:\/|$))/i.test(url.pathname)) return '/';
    return `${url.pathname}${url.search}${url.hash}` || '/';
  } catch { return '/'; }
}

api.get('/api/me', (c) => { const a = c.get('auth'); c.header('X-BillSplit-User-Id', a.id); return c.json({ id: a.id, email: a.email, personId: a.personId }); });
api.get('/api/groups', async (c) => c.json({ groups: await getRepo(c).groups(c.get('auth').id) }));
api.post('/api/groups', zValidator('json', groupInput), async (c) => c.json({ group: await getRepo(c).createGroup(c.get('auth').id, c.get('auth').personId, c.req.valid('json')) }, 201));
api.post('/api/friends', zValidator('json', friendInput), async (c) => { try { const input = c.req.valid('json'); return c.json({ group: await getRepo(c).createFriend(c.get('auth').id, c.get('auth').personId, input) }, 201); } catch (error) { return repositoryError(c, error); } });
api.get('/api/groups/:groupId', async (c) => { const x = await authorizedGroup(c, c.req.param('groupId')); if (x instanceof Response) return x; return c.json({ group: x.group, members: await x.repo.members(c.req.param('groupId')) }); });
api.put('/api/groups/:groupId', zValidator('json', groupInput), async (c) => { const x = await authorizedGroup(c, c.req.param('groupId')); if (x instanceof Response) return x; const denied = ownerOnly(c, x); if (denied) return denied; return c.json({ group: await x.repo.updateGroup(c.req.param('groupId'), x.auth.id, c.req.valid('json')) }); });
api.delete('/api/groups/:groupId', async (c) => { const x = await authorizedGroup(c, c.req.param('groupId')); if (x instanceof Response) return x; const denied = ownerOnly(c, x); if (denied) return denied; await x.repo.deleteGroup(c.req.param('groupId')); return c.body(null, 204); });
api.post('/api/groups/:groupId/people', zValidator('json', personInput), async (c) => { const x = await authorizedGroup(c, c.req.param('groupId')); if (x instanceof Response) return x; const denied = ownerOnly(c, x); if (denied) return denied; try { return c.json({ person: await x.repo.addPerson(c.req.param('groupId'), c.req.valid('json'), x.auth.id, x.auth.personId) }, 201); } catch (error) { return repositoryError(c, error); } });
api.get('/api/groups/:groupId/people', async (c) => { const x = await authorizedGroup(c, c.req.param('groupId')); if (x instanceof Response) return x; return c.json({ people: await x.repo.members(c.req.param('groupId')) }); });

api.get('/api/groups/:groupId/expenses', async (c) => { const x = await authorizedGroup(c, c.req.param('groupId')); if (x instanceof Response) return x; const q = c.req.query(); const limit = page(q.limit, 50, 100); const offset = page(q.offset, 0, Number.MAX_SAFE_INTEGER); if (limit < 1 || offset < 0) return jsonError(c, 400, 'INVALID_PAGINATION', 'Pagination values must be finite non-negative integers'); try { if (q.from) date.parse(q.from); if (q.to) date.parse(q.to); } catch { return jsonError(c, 400, 'INVALID_DATE', 'Date filters must be real YYYY-MM-DD dates'); } return c.json({ expenses: await x.repo.expenses(c.req.param('groupId'), { q: q.q, person: q.person, category: q.category, from: q.from, to: q.to, currency: q.currency, limit, offset }) }); });
api.get('/api/groups/:groupId/scheduled-expenses', async (c) => { const x = await authorizedGroup(c, c.req.param('groupId')); if (x instanceof Response) return x; const q = c.req.query(); const limit = page(q.limit, 100, 100); const offset = page(q.offset, 0, Number.MAX_SAFE_INTEGER); if (limit < 1 || offset < 0) return jsonError(c, 400, 'INVALID_PAGINATION', 'Pagination values must be finite non-negative integers'); return c.json({ scheduledExpenses: await x.repo.scheduledExpenses(c.req.param('groupId'), { limit, offset }) }); });
api.post('/api/groups/:groupId/scheduled-expenses', zValidator('json', scheduledExpenseInput), async (c) => {
  const x = await authorizedGroup(c, c.req.param('groupId')); if (x instanceof Response) return x;
  const input = c.req.valid('json');
  try { assertFinancialInput({ ...input, date: input.start_date }); } catch (error) { const balanceResponse = balanceError(c, error); if (balanceResponse) return balanceResponse; return jsonError(c, 400, 'INVALID_FINANCIAL_INPUT', error instanceof Error ? error.message : 'Invalid financial input'); }
  if (!(await validPeople(x.repo, c.req.param('groupId'), [...input.payers, ...input.splits].map((person) => person.person_id)))) return jsonError(c, 400, 'INVALID_MEMBER', 'Every payer and split must be a group member');
  try { return c.json({ scheduledExpense: await x.repo.createScheduledExpense(c.req.param('groupId'), x.auth.id, input) }, 201); } catch (error) { return repositoryError(c, error); }
});
api.post('/api/groups/:groupId/expenses', zValidator('json', expenseInput), async (c) => { const x = await authorizedGroup(c, c.req.param('groupId')); if (x instanceof Response) return x; const input = c.req.valid('json'); try { assertFinancialInput(input); } catch (error) { const balanceResponse = balanceError(c, error); if (balanceResponse) return balanceResponse; return jsonError(c, 400, 'INVALID_FINANCIAL_INPUT', error instanceof Error ? error.message : 'Invalid financial input'); } try { if (!(await validPeople(x.repo, c.req.param('groupId'), [...input.payers, ...input.splits].map((p) => p.person_id))) ) return jsonError(c, 400, 'INVALID_MEMBER', 'Every payer and split must be a group member'); return c.json({ expense: await x.repo.createExpense(c.req.param('groupId'), x.auth.id, input) }, 201); } catch (error) { return repositoryError(c, error); } });
api.put('/api/scheduled-expenses/:scheduledExpenseId', zValidator('json', scheduledExpenseInput), async (c) => {
  const x = await authorizedScheduled(c, c.req.param('scheduledExpenseId')); if (x instanceof Response) return x;
  const input = c.req.valid('json');
  try { assertFinancialInput({ ...input, date: input.start_date }); } catch (error) { const balanceResponse = balanceError(c, error); if (balanceResponse) return balanceResponse; return jsonError(c, 400, 'INVALID_FINANCIAL_INPUT', error instanceof Error ? error.message : 'Invalid financial input'); }
  if (!(await validPeople(x.repo, x.scheduled.groupId, [...input.payers, ...input.splits].map((person) => person.person_id)))) return jsonError(c, 400, 'INVALID_MEMBER', 'Every payer and split must be a group member');
  try { return c.json({ scheduledExpense: await x.repo.updateScheduledExpense(c.req.param('scheduledExpenseId'), x.auth.id, input) }); } catch (error) { return repositoryError(c, error); }
});
api.get('/api/scheduled-expenses/:scheduledExpenseId', async (c) => { const x = await authorizedScheduled(c, c.req.param('scheduledExpenseId')); if (x instanceof Response) return x; return c.json({ scheduledExpense: x.scheduled }); });
for (const [action, method] of [['pause', 'pauseScheduledExpense'], ['resume', 'resumeScheduledExpense'], ['cancel', 'cancelScheduledExpense'] ] as const) {
  api.post(`/api/scheduled-expenses/:scheduledExpenseId/${action}`, zValidator('json', scheduledExpenseStatusInput), async (c) => {
    const x = await authorizedScheduled(c, c.req.param('scheduledExpenseId')); if (x instanceof Response) return x;
    try { const result = await x.repo[method](c.req.param('scheduledExpenseId'), c.req.valid('json').version); return c.json({ scheduledExpense: result }); } catch (error) { return repositoryError(c, error); }
  });
}
  api.get('/api/expenses/:expenseId', async (c) => { const expense = await getRepo(c).expense(c.req.param('expenseId')); if (!expense) return jsonError(c, 404, 'EXPENSE_NOT_FOUND', 'Expense not found'); const x = await authorizedGroup(c, expense.groupId); if (x instanceof Response) return x; return c.json({ expense, history: await x.repo.revisions('expense', c.req.param('expenseId')) }); });
  api.put('/api/expenses/:expenseId', zValidator('json', expenseInput), async (c) => { const old = await getRepo(c).expense(c.req.param('expenseId')); if (!old) return jsonError(c, 404, 'EXPENSE_NOT_FOUND', 'Expense not found'); const x = await authorizedGroup(c, old.groupId); if (x instanceof Response) return x; const input = c.req.valid('json'); try { assertFinancialInput(input); } catch (error) { const balanceResponse = balanceError(c, error); if (balanceResponse) return balanceResponse; return jsonError(c, 400, 'INVALID_FINANCIAL_INPUT', error instanceof Error ? error.message : 'Invalid financial input'); } try { if (input.version === undefined) return jsonError(c, 409, 'CONFLICT', 'The loaded record version is required'); if (!(await validPeople(x.repo, old.groupId, [...input.payers, ...input.splits].map((p) => p.person_id)))) return jsonError(c, 400, 'INVALID_MEMBER', 'Every payer and split must be a group member'); const expense = await x.repo.updateExpense(c.req.param('expenseId'), x.auth.id, input); if (!expense) return jsonError(c, 409, 'CONFLICT', 'The record was deleted by another request'); return c.json({ expense }); } catch (error) { return repositoryError(c, error); } });
api.delete('/api/expenses/:expenseId', async (c) => { const old = await getRepo(c).expense(c.req.param('expenseId')); if (!old) return jsonError(c, 404, 'EXPENSE_NOT_FOUND', 'Expense not found'); const x = await authorizedGroup(c, old.groupId); if (x instanceof Response) return x; const version = page(c.req.query('version'), -1, Number.MAX_SAFE_INTEGER); if (version < 1) return jsonError(c, 400, 'INVALID_VERSION', 'A positive record version is required'); try { await x.repo.deleteExpense(c.req.param('expenseId'), x.auth.id, version); return c.body(null, 204); } catch (error) { return repositoryError(c, error); } });

api.get('/api/groups/:groupId/settlements', async (c) => { const x = await authorizedGroup(c, c.req.param('groupId')); if (x instanceof Response) return x; return c.json({ settlements: await x.repo.settlements(c.req.param('groupId')) }); });
api.post('/api/groups/:groupId/settlements', zValidator('json', settlementInput), async (c) => { const x = await authorizedGroup(c, c.req.param('groupId')); if (x instanceof Response) return x; const input = c.req.valid('json'); if (input.from_person_id === input.to_person_id || !(await validPeople(x.repo, c.req.param('groupId'), [input.from_person_id, input.to_person_id]))) return jsonError(c, 400, 'INVALID_SETTLEMENT', 'Settlement participants are invalid'); try { return c.json({ settlement: await x.repo.createSettlement(c.req.param('groupId'), x.auth.id, input) }, 201); } catch (error) { return repositoryError(c, error); } });
api.put('/api/settlements/:settlementId', zValidator('json', settlementInput), async (c) => { const input = c.req.valid('json'), repo = getRepo(c), row = await repo.settlement(c.req.param('settlementId')); if (!row) return jsonError(c, 404, 'SETTLEMENT_NOT_FOUND', 'Settlement not found'); const x = await authorizedGroup(c, row.groupId); if (x instanceof Response) return x; if (input.version === undefined || input.from_person_id === input.to_person_id || !(await validPeople(repo, row.groupId, [input.from_person_id, input.to_person_id]))) return jsonError(c, 400, 'INVALID_SETTLEMENT', 'Settlement version or participants are invalid'); try { const settlement = await repo.updateSettlement(c.req.param('settlementId'), x.auth.id, input); if (!settlement) return jsonError(c, 409, 'CONFLICT', 'The record was deleted by another request'); return c.json({ settlement }); } catch (error) { return repositoryError(c, error); } });
api.delete('/api/settlements/:settlementId', async (c) => { const row = await getRepo(c).settlement(c.req.param('settlementId')); if (!row) return jsonError(c, 404, 'SETTLEMENT_NOT_FOUND', 'Settlement not found'); const x = await authorizedGroup(c, row.groupId); if (x instanceof Response) return x; const version = page(c.req.query('version'), -1, Number.MAX_SAFE_INTEGER); if (version < 1) return jsonError(c, 400, 'INVALID_VERSION', 'A positive record version is required'); try { await x.repo.deleteSettlement(c.req.param('settlementId'), x.auth.id, version); return c.body(null, 204); } catch (error) { return repositoryError(c, error); } });

api.get('/api/groups/:groupId/balances', async (c) => {
  const x = await authorizedGroup(c, c.req.param('groupId')); if (x instanceof Response) return x; const groupId = c.req.param('groupId');
  const [expenses, settlements, members] = await Promise.all([x.repo.allExpenses(groupId), x.repo.settlements(groupId), x.repo.members(groupId)]);
  const names = Object.fromEntries(members.map((m) => [m.personId, m.name])); const currencies = [...new Set([x.group.currency, ...expenses.map((e) => e.currency), ...settlements.map((s) => s.currency)])];
  const balances: Record<string, { raw: Array<{ personId: string; name: string; netMinor: number; currency: typeof x.group.currency }>; simplified: ReturnType<typeof simplifyDebts> }> = {};
  for (const current of currencies) {
    const net: Record<string, number> = {};
    for (const expense of expenses.filter((e) => e.currency === current)) for (const [id, value] of Object.entries(calculateNet(expense.payers, expense.splits, [], current))) net[id] = checkedAddMinor(net[id] ?? 0, value);
    for (const [id, value] of Object.entries(calculateNet([], [], settlements, current))) net[id] = checkedAddMinor(net[id] ?? 0, value);
    const raw = Object.entries(net).map(([personId, netMinor]) => ({ personId, name: names[personId] ?? personId, netMinor, currency: current }));
    balances[current] = { raw, simplified: simplifyDebts(net, current, names) };
  }
  return c.json({ currencies, balances });
});
api.get('/api/activity', async (c) => { const groupId = c.req.query('group'); if (groupId && (await authorizedGroup(c, groupId)) instanceof Response) return jsonError(c, 404, 'GROUP_NOT_FOUND', 'Group not found'); return c.json({ activity: await getRepo(c).globalActivity(c.get('auth').id, groupId || undefined) }); });
api.get('/api/groups/:groupId/activity', async (c) => { const x = await authorizedGroup(c, c.req.param('groupId')); if (x instanceof Response) return x; return c.json({ activity: await x.repo.globalActivity(x.auth.id, c.req.param('groupId')) }); });
api.get('/api/categories', async (c) => c.json({ categories: await getRepo(c).categories(c.get('auth').id) }));
api.get('/api/groups/:groupId/export.json', async (c) => { const x = await authorizedGroup(c, c.req.param('groupId')); if (x instanceof Response) return x; return c.json(await x.repo.groupExport(c.req.param('groupId'))); });
api.get('/api/groups/:groupId/export.csv', async (c) => { const x = await authorizedGroup(c, c.req.param('groupId')); if (x instanceof Response) return x; const expenses = await x.repo.allExpenses(c.req.param('groupId')); const esc = (value: unknown) => { const valueText = String(value ?? ''); const safe = /^[=+\-@]/.test(valueText) ? `'${valueText}` : valueText; return `"${safe.replaceAll('"', '""')}"`; }; const csv = ['date,description,amount_minor,currency,payers,splits', ...expenses.map((expense) => [expense.date, expense.description, expense.amountMinor, expense.currency, expense.payers.map((p) => `${p.personId}:${p.amountMinor}`).join(';'), expense.splits.map((s) => `${s.personId}:${s.amountMinor}`).join(';')].map(esc).join(','))].join('\n'); return new Response(csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="group-expenses.csv"' } }); });
api.get('/api/export.json', async (c) => c.json(await getRepo(c).allExport(c.get('auth').id)));

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
  await new Repository(env.DB).generateDueScheduledExpenses(new Date(controller.scheduledTime));
} };
