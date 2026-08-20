import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { assertFinancialInput, date, expenseInput, groupInput, personInput, settlementInput } from '../shared/schemas';
import { calculateNet, simplifyDebts } from '../domain/balances';
import { Repository, RepositoryError } from '../db/repository';

type Env = { Bindings: { DB: D1Database; ASSETS: Fetcher; ENVIRONMENT?: string; ACCESS_TEAM_DOMAIN?: string; ACCESS_AUD?: string }; Variables: { auth: { id: string; email: string; personId: string }; repo: Repository; requestId: string } };
const api = new Hono<Env>();
const jsonError = (c: any, status: number, code: string, message: string) => c.json({ error: { code, message } }, status);
const getRepo = (c: any) => c.get('repo') as Repository;
export const MAX_API_BODY_BYTES = 64 * 1024;
const CONTENT_SECURITY_POLICY = "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'";
const requestIdFor = (request: Request) => {
  const supplied = request.headers.get('X-Request-ID');
  return supplied && /^[A-Za-z0-9._-]{1,128}$/.test(supplied) ? supplied : crypto.randomUUID();
};
const setSecurityHeaders = (headers: Headers, requestId: string, apiResponse: boolean) => {
  headers.set('X-Request-ID', requestId);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Permissions-Policy', 'camera=(), geolocation=(), microphone=(), payment=()');
  headers.set('X-Frame-Options', 'DENY');
  if (apiResponse) {
    headers.set('Cache-Control', 'no-store');
    headers.set('Pragma', 'no-cache');
  } else {
    headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY);
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
  if (error instanceof RepositoryError) return jsonError(c, error.code === 'CONFLICT' ? 409 : error.code === 'IDEMPOTENCY_CONFLICT' ? 409 : 500, error.code, error.message);
  throw error;
};

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
  let email: string | undefined;
  const devEmail = c.req.header('X-Dev-Email');
  if (env.ENVIRONMENT === 'development' && devEmail && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(devEmail)) {
    email = devEmail.trim().toLowerCase();
  } else {
    if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return jsonError(c, 401, 'AUTH_REQUIRED', 'Cloudflare Access configuration is missing');
    const token = c.req.header('Cf-Access-Jwt-Assertion') ?? c.req.header('Authorization')?.replace(/^Bearer\s+/i, '');
    if (!token) return jsonError(c, 401, 'AUTH_REQUIRED', 'A Cloudflare Access JWT is required');
    try {
      const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
      const verified = await jwtVerify(token, createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)), { issuer, audience: env.ACCESS_AUD });
      const claim = verified.payload.email ?? verified.payload.sub;
      if (typeof claim !== 'string' || !claim.includes('@')) return jsonError(c, 401, 'AUTH_INVALID', 'Verified identity has no usable email');
      email = claim.trim().toLowerCase();
    } catch { return jsonError(c, 401, 'AUTH_INVALID', 'Cloudflare Access JWT could not be verified'); }
  }
  try {
    const repo = new Repository(env.DB); const identity = await repo.user(email!);
    const auth = { id: String(identity.user.id), email: email!, personId: String(identity.person.id) };
    const expectedUserId = c.req.header('X-BillSplit-Expected-User-Id');
    if (expectedUserId && expectedUserId !== auth.id) return jsonError(c, 401, 'IDENTITY_MISMATCH', 'The verified identity changed; sign in again before syncing');
    c.set('repo', repo); c.set('auth', auth); c.header('X-BillSplit-User-Id', auth.id); await next();
  } catch { console.error(JSON.stringify({ message: 'database request failed', requestId: c.get('requestId') })); return jsonError(c, 500, 'DATABASE_ERROR', 'The request could not be completed'); }
});

async function authorizedGroup(c: any, groupId: string): Promise<{ repo: Repository; auth: { id: string; email: string; personId: string }; group: NonNullable<Awaited<ReturnType<Repository['group']>>>; role: 'owner' | 'member' } | Response> {
  const repo = getRepo(c), auth = c.get('auth'); const group = await repo.group(groupId, auth.id);
  if (!group) return jsonError(c, 404, 'GROUP_NOT_FOUND', 'Group not found');
  return { repo, auth, group, role: group.role === 'owner' ? 'owner' : 'member' };
}
const ownerOnly = (c: any, x: { role: 'owner' | 'member' }) => x.role === 'owner' ? null : jsonError(c, 403, 'OWNER_REQUIRED', 'Only group owners can perform this action');
async function validPeople(repo: Repository, groupId: string, ids: string[]) { const members = await repo.members(groupId); const allowed = new Set(members.map((m) => m.personId)); return ids.every((id) => allowed.has(id)); }
function page(value: string | undefined, fallback: number, max: number) { if (value === undefined) return fallback; const n = Number(value); return Number.isSafeInteger(n) && n >= 0 ? Math.min(n, max) : -1; }

api.get('/api/me', (c) => { const a = c.get('auth'); c.header('X-BillSplit-User-Id', a.id); return c.json({ id: a.id, email: a.email, personId: a.personId }); });
api.get('/api/groups', async (c) => c.json({ groups: await getRepo(c).groups(c.get('auth').id) }));
api.post('/api/groups', zValidator('json', groupInput), async (c) => c.json({ group: await getRepo(c).createGroup(c.get('auth').id, c.get('auth').personId, c.req.valid('json')) }, 201));
api.get('/api/groups/:groupId', async (c) => { const x = await authorizedGroup(c, c.req.param('groupId')); if (x instanceof Response) return x; return c.json({ group: x.group, members: await x.repo.members(c.req.param('groupId')) }); });
api.put('/api/groups/:groupId', zValidator('json', groupInput), async (c) => { const x = await authorizedGroup(c, c.req.param('groupId')); if (x instanceof Response) return x; const denied = ownerOnly(c, x); if (denied) return denied; return c.json({ group: await x.repo.updateGroup(c.req.param('groupId'), x.auth.id, c.req.valid('json')) }); });
api.delete('/api/groups/:groupId', async (c) => { const x = await authorizedGroup(c, c.req.param('groupId')); if (x instanceof Response) return x; const denied = ownerOnly(c, x); if (denied) return denied; await x.repo.deleteGroup(c.req.param('groupId')); return c.body(null, 204); });
api.post('/api/groups/:groupId/people', zValidator('json', personInput), async (c) => { const x = await authorizedGroup(c, c.req.param('groupId')); if (x instanceof Response) return x; const denied = ownerOnly(c, x); if (denied) return denied; try { return c.json({ person: await x.repo.addPerson(c.req.param('groupId'), c.req.valid('json')) }, 201); } catch (error) { return repositoryError(c, error); } });
api.get('/api/groups/:groupId/people', async (c) => { const x = await authorizedGroup(c, c.req.param('groupId')); if (x instanceof Response) return x; return c.json({ people: await x.repo.members(c.req.param('groupId')) }); });

api.get('/api/groups/:groupId/expenses', async (c) => { const x = await authorizedGroup(c, c.req.param('groupId')); if (x instanceof Response) return x; const q = c.req.query(); const limit = page(q.limit, 50, 100); const offset = page(q.offset, 0, Number.MAX_SAFE_INTEGER); if (limit < 1 || offset < 0) return jsonError(c, 400, 'INVALID_PAGINATION', 'Pagination values must be finite non-negative integers'); try { if (q.from) date.parse(q.from); if (q.to) date.parse(q.to); } catch { return jsonError(c, 400, 'INVALID_DATE', 'Date filters must be real YYYY-MM-DD dates'); } return c.json({ expenses: await x.repo.expenses(c.req.param('groupId'), { q: q.q, person: q.person, category: q.category, from: q.from, to: q.to, currency: q.currency, limit, offset }) }); });
api.post('/api/groups/:groupId/expenses', zValidator('json', expenseInput), async (c) => { const x = await authorizedGroup(c, c.req.param('groupId')); if (x instanceof Response) return x; const input = c.req.valid('json'); try { assertFinancialInput(input); } catch (error) { return jsonError(c, 400, 'INVALID_FINANCIAL_INPUT', error instanceof Error ? error.message : 'Invalid financial input'); } try { if (!(await validPeople(x.repo, c.req.param('groupId'), [...input.payers, ...input.splits].map((p) => p.person_id))) ) return jsonError(c, 400, 'INVALID_MEMBER', 'Every payer and split must be a group member'); return c.json({ expense: await x.repo.createExpense(c.req.param('groupId'), x.auth.id, input) }, 201); } catch (error) { return repositoryError(c, error); } });
api.get('/api/expenses/:expenseId', async (c) => { const expense = await getRepo(c).expense(c.req.param('expenseId')); if (!expense) return jsonError(c, 404, 'EXPENSE_NOT_FOUND', 'Expense not found'); const x = await authorizedGroup(c, expense.groupId); if (x instanceof Response) return x; return c.json({ expense, history: await x.repo.revisions('expense', c.req.param('expenseId')) }); });
api.put('/api/expenses/:expenseId', zValidator('json', expenseInput), async (c) => { const old = await getRepo(c).expense(c.req.param('expenseId')); if (!old) return jsonError(c, 404, 'EXPENSE_NOT_FOUND', 'Expense not found'); const x = await authorizedGroup(c, old.groupId); if (x instanceof Response) return x; const input = c.req.valid('json'); try { assertFinancialInput(input); } catch (error) { return jsonError(c, 400, 'INVALID_FINANCIAL_INPUT', error instanceof Error ? error.message : 'Invalid financial input'); } try { if (input.version === undefined) return jsonError(c, 409, 'CONFLICT', 'The loaded record version is required'); if (!(await validPeople(x.repo, old.groupId, [...input.payers, ...input.splits].map((p) => p.person_id)))) return jsonError(c, 400, 'INVALID_MEMBER', 'Every payer and split must be a group member'); const expense = await x.repo.updateExpense(c.req.param('expenseId'), x.auth.id, input); if (!expense) return jsonError(c, 409, 'CONFLICT', 'The record was deleted by another request'); return c.json({ expense }); } catch (error) { return repositoryError(c, error); } });
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
    for (const expense of expenses.filter((e) => e.currency === current)) for (const [id, value] of Object.entries(calculateNet(expense.payers, expense.splits, [], current))) net[id] = (net[id] ?? 0) + value;
    for (const [id, value] of Object.entries(calculateNet([], [], settlements, current))) net[id] = (net[id] ?? 0) + value;
    const raw = Object.entries(net).map(([personId, netMinor]) => ({ personId, name: names[personId] ?? personId, netMinor, currency: current }));
    balances[current] = { raw, simplified: simplifyDebts(net, current, names) };
  }
  return c.json({ currencies, balances });
});
api.get('/api/groups/:groupId/activity', async (c) => { const x = await authorizedGroup(c, c.req.param('groupId')); if (x instanceof Response) return x; return c.json({ activity: await x.repo.activity(c.req.param('groupId')) }); });
api.get('/api/groups/:groupId/export.json', async (c) => { const x = await authorizedGroup(c, c.req.param('groupId')); if (x instanceof Response) return x; return c.json(await x.repo.groupExport(c.req.param('groupId'))); });
api.get('/api/groups/:groupId/export.csv', async (c) => { const x = await authorizedGroup(c, c.req.param('groupId')); if (x instanceof Response) return x; const expenses = await x.repo.allExpenses(c.req.param('groupId')); const esc = (value: unknown) => { const valueText = String(value ?? ''); const safe = /^[=+\-@]/.test(valueText) ? `'${valueText}` : valueText; return `"${safe.replaceAll('"', '""')}"`; }; const csv = ['date,description,amount_minor,currency,payers,splits', ...expenses.map((expense) => [expense.date, expense.description, expense.amountMinor, expense.currency, expense.payers.map((p) => `${p.personId}:${p.amountMinor}`).join(';'), expense.splits.map((s) => `${s.personId}:${s.amountMinor}`).join(';')].map(esc).join(','))].join('\n'); return new Response(csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="group-expenses.csv"' } }); });
api.get('/api/export.json', async (c) => c.json(await getRepo(c).allExport(c.get('auth').id)));

api.notFound((c) => jsonError(c, 404, 'NOT_FOUND', 'API route not found'));
api.onError((error, c) => { if (error instanceof RepositoryError) return repositoryError(c, error); console.error(JSON.stringify({ message: 'request failed', requestId: c.get('requestId') })); return jsonError(c, 500, 'INTERNAL_ERROR', 'Unexpected server error'); });
export default { async fetch(request: Request, env: Env['Bindings'], ctx: ExecutionContext) {
  const requestId = requestIdFor(request);
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api')) return api.fetch(request, env, ctx);
  const response = await env.ASSETS.fetch(request);
  const headers = new Headers(response.headers);
  setSecurityHeaders(headers, requestId, false);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
} };
