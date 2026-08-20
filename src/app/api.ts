import type { Expense, Group, GroupMember, Settlement, Balances } from '../shared/types';
import { readGroupSnapshot, readGroups, readLastVerifiedIdentity, reconcileOutboxItems, saveGroups, saveVerifiedIdentity, updateGroupSnapshot } from './idb';

export type CurrentUser = { id: string; email: string; personId: string };
export type CachedResult<T> = T & { offline?: boolean; stale?: boolean; authoritative?: boolean };
export type ApiResponse<T> = { data: T; userId?: string };
export type AuthRequiredCode = 'AUTH_REQUIRED' | 'AUTH_INVALID' | 'IDENTITY_MISMATCH';
export type AuthState = { required: boolean; code?: AuthRequiredCode };

let authState: AuthState = { required: false };
const authListeners = new Set<() => void>();
export const getAuthState = () => authState;
export const subscribeAuthState = (listener: () => void) => { authListeners.add(listener); return () => authListeners.delete(listener); };
export const clearAuthRequired = () => { if (!authState.required) return; authState = { required: false }; authListeners.forEach((listener) => listener()); };
const signalAuthRequired = (code: AuthRequiredCode) => {
  authState = { required: true, code };
  authListeners.forEach((listener) => listener());
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('billsplit-auth-required', { detail: { code } }));
};

export class ApiError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly serverMessage?: string;
  readonly networkFailure: boolean;
  readonly isNetworkError: boolean;

  constructor(message: string, options: { status?: number; code?: string; networkFailure?: boolean } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = options.status;
    this.code = options.code;
    this.serverMessage = options.status === undefined ? undefined : message;
    this.networkFailure = options.networkFailure === true;
    this.isNetworkError = this.networkFailure;
  }
}

const devEmail = () => typeof localStorage === 'undefined' ? 'dev@example.com' : localStorage.getItem('dev-email') || 'dev@example.com';
const isNetwork = (error: unknown): error is ApiError => error instanceof ApiError && error.networkFailure;
const cacheRead = async <T>(read: () => Promise<T | undefined>) => { try { return await read(); } catch { return undefined; } };
const cacheWrite = async (write: () => Promise<unknown>) => { try { await write(); } catch { /* Private cache is an enhancement, not a request failure. */ } };

export async function apiWithMeta<T>(path: string, init?: RequestInit): Promise<ApiResponse<T>> {
  const headers = new Headers(init?.headers);
  headers.set('Content-Type', 'application/json');
  headers.set('X-Requested-With', 'XMLHttpRequest');
  if (import.meta.env.DEV) headers.set('X-Dev-Email', devEmail());
  let response: Response;
  try { response = await fetch(`/api${path}`, { ...init, headers }); }
  catch { throw new ApiError('Network connection unavailable.', { networkFailure: true, code: 'NETWORK_ERROR' }); }
  // Access may return a plain redirect/login document rather than our JSON error.
  // Publish this before parsing so HTML responses cannot hide an expired session.
  if (response.status === 401) signalAuthRequired('AUTH_REQUIRED');
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
    const message = body?.error?.message || `Request failed (${response.status})`;
    const code = body?.error?.code;
    if (response.status === 401 && (code === 'AUTH_INVALID' || code === 'IDENTITY_MISMATCH')) signalAuthRequired(code);
    throw new ApiError(message, { status: response.status, code });
  }
  return { data: response.status === 204 ? undefined as T : await response.json(), userId: response.headers.get('X-BillSplit-User-Id') || undefined };
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> { return (await apiWithMeta<T>(path, init)).data; }

async function identityForCache() { return cacheRead(readLastVerifiedIdentity); }
type CacheIdentity = { user: CurrentUser; authoritative: boolean };
async function requireIdentityForCache(): Promise<CacheIdentity | undefined> {
  const cached = await identityForCache();
  // An online request must re-check the server identity before attaching data
  // to a user-scoped cache. Offline, the last verified profile is intentional.
  if (typeof navigator !== 'undefined' && navigator.onLine === false && cached) return { user: { id: cached.userId, email: cached.email, personId: cached.personId }, authoritative: false };
  try {
    const current = await getMe();
    return { user: { id: current.id, email: current.email, personId: current.personId }, authoritative: current.authoritative === true };
  } catch {
    return cached ? { user: { id: cached.userId, email: cached.email, personId: cached.personId }, authoritative: false } : undefined;
  }
}
const offline = <T extends object>(value: T): CachedResult<T> => ({ ...value, offline: true, stale: true });

export async function getMe(options: { networkOnly?: boolean } = {}): Promise<CachedResult<CurrentUser>> {
  try {
    const result = await apiWithMeta<CurrentUser>('/me');
    const user = result.data;
    await cacheWrite(() => saveVerifiedIdentity({ userId: user.id, email: user.email, personId: user.personId, verifiedAt: new Date().toISOString() }));
    clearAuthRequired();
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('billsplit-authenticated', { detail: { userId: user.id } }));
    return { ...user, authoritative: true };
  } catch (error) {
    if (!isNetwork(error)) throw error;
    const cached = await identityForCache();
    if (!options.networkOnly && cached) return { ...offline({ id: cached.userId, email: cached.email, personId: cached.personId }), authoritative: false };
    throw error;
  }
}

export async function getGroups(): Promise<CachedResult<{ groups: Group[] }>> {
  const identity = await requireIdentityForCache();
  try {
    const result = await apiWithMeta<{ groups: Group[] }>('/groups');
    if (result.userId) { const responseUserId = result.userId; await cacheWrite(() => saveGroups({ userId: responseUserId, groups: result.data.groups, cachedAt: new Date().toISOString() })); }
    return result.data;
  } catch (error) {
    if (!isNetwork(error) || !identity) throw error;
    const cached = await cacheRead(() => readGroups(identity.user.id));
    if (cached) return offline({ groups: cached.groups });
    throw error;
  }
}

export async function getGroup(id: string): Promise<CachedResult<{ group: Group; members: GroupMember[] }>> {
  const identity = await requireIdentityForCache();
  try {
    const result = await apiWithMeta<{ group: Group; members: GroupMember[] }>(`/groups/${id}`);
    if (result.userId) await cacheWrite(() => updateGroupSnapshot(result.userId!, id, { group: result.data.group, members: result.data.members }));
    return result.data;
  } catch (error) {
    if (!isNetwork(error) || !identity) throw error;
    const cached = await cacheRead(() => readGroupSnapshot(identity.user.id, id));
    if (cached?.group && cached.members) return offline({ group: cached.group, members: cached.members });
    throw error;
  }
}

export async function getExpenses(id: string): Promise<CachedResult<{ expenses: Expense[] }>> {
  const identity = await requireIdentityForCache();
  try {
    const result = await apiWithMeta<{ expenses: Expense[] }>(`/groups/${id}/expenses`);
    if (result.userId) { await cacheWrite(() => updateGroupSnapshot(result.userId!, id, { expenses: result.data.expenses })); const reconciled = await cacheRead(() => reconcileOutboxItems(result.userId!, id, result.data.expenses)); if (reconciled && typeof window !== 'undefined') window.dispatchEvent(new Event('billsplit-outbox-changed')); }
    return result.data;
  } catch (error) {
    if (!isNetwork(error) || !identity) throw error;
    const cached = await cacheRead(() => readGroupSnapshot(identity.user.id, id));
    if (cached?.expenses) return offline({ expenses: cached.expenses });
    throw error;
  }
}

export async function getBalances(id: string): Promise<CachedResult<{ balances: Record<string, Balances> }>> {
  const identity = await requireIdentityForCache();
  try {
    const result = await apiWithMeta<{ balances: Record<string, Balances> }>(`/groups/${id}/balances`);
    if (result.userId) await cacheWrite(() => updateGroupSnapshot(result.userId!, id, { balances: result.data.balances }));
    return result.data;
  } catch (error) {
    if (!isNetwork(error) || !identity) throw error;
    const cached = await cacheRead(() => readGroupSnapshot(identity.user.id, id));
    if (cached?.balances) return offline({ balances: cached.balances });
    throw error;
  }
}

export async function getSettlements(id: string): Promise<CachedResult<{ settlements: Settlement[] }>> {
  const identity = await requireIdentityForCache();
  try {
    const result = await apiWithMeta<{ settlements: Settlement[] }>(`/groups/${id}/settlements`);
    if (result.userId) await cacheWrite(() => updateGroupSnapshot(result.userId!, id, { settlements: result.data.settlements }));
    return result.data;
  } catch (error) {
    if (!isNetwork(error) || !identity) throw error;
    const cached = await cacheRead(() => readGroupSnapshot(identity.user.id, id));
    if (cached?.settlements) return offline({ settlements: cached.settlements });
    throw error;
  }
}

export const getExpense = (id: string) => api<{ expense: Expense }>(`/expenses/${id}`).then((result) => result.expense);
export const getExpenseDetails = (id: string) => api<{ expense: Expense; history: Array<{ id: string; revision: number; createdAt: string }> }>(`/expenses/${id}`);
