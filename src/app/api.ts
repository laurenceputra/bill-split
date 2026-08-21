import type { Activity, Expense, Group, GroupMember, Settlement, Balances } from '../shared/types';
import { clearAllPrivateData, normalizeActivity, readActivity, readExpenseDetails, readGroupSnapshot, readGroups, readLastVerifiedClerkUserId, readLastVerifiedIdentity, readMutationGeneration, reconcileOutboxItems, saveActivity, saveGroupsIfGenerationMatches, saveLastVerifiedClerkUserId, saveVerifiedIdentity, saveExpenseDetails, updateGroupSnapshot } from './idb';
import { allowIdentityVerification, blockResourceIdentity, getResourceSnapshot, invalidateForMutation, resetResourceIdentity, seedResource, setResourceIdentity } from './resource-cache';
import { quiesceOutboxForLogout, resumeOutboxAfterFailedLogout } from './logout-coordination';
import { captureSessionGeneration, clearSessionLogout, getSessionGeneration, getSessionLogoutInProgress, isSessionGenerationCurrent, rollbackSessionLogout, SessionGenerationMismatchError, startSessionLogout, subscribeSessionLogout } from './session';
import { beginMutationBarrier, isMutationBarrierActive, releaseMutationBarrier, runMutation, withExclusiveMutationLock } from './mutation-quiescence';

export type CurrentUser = { id: string; email: string; personId: string };
export type CachedResult<T> = T & { offline?: boolean; stale?: boolean; authoritative?: boolean };
export type ApiResponse<T> = { data: T; userId?: string };
export type AuthRequiredCode = 'AUTH_REQUIRED' | 'AUTH_INVALID' | 'IDENTITY_MISMATCH';
export type AuthState = { required: boolean; code?: AuthRequiredCode };
export type ConnectionState = { reconnectRequired: boolean };
export type AuthLifecycleStatus = 'checking' | 'unauthenticated' | 'authenticated' | 'trusted-offline';
export type AuthLifecycle = { status: AuthLifecycleStatus; error?: unknown };

export class ClerkSignOutFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClerkSignOutFailure';
  }
}

let authState: AuthState = { required: false };
let connectionState: ConnectionState = { reconnectRequired: false };
let verifiedIdentity: CurrentUser | undefined;
let verifiedClerkUserId: string | undefined;
let clerkUserIdHydrated = false;
let authLifecycle: AuthLifecycle = { status: 'checking' };
let authLifecycleRequest: Promise<AuthLifecycle> | undefined;
let identityRequest: Promise<CachedResult<CurrentUser>> | undefined;
let authBlocked = false;
let authInvalidationGeneration = 0;
const authListeners = new Set<() => void>();
const connectionListeners = new Set<() => void>();
/** Build-time-only flag used by the local E2E harness; the Worker still gates it on ENVIRONMENT=development. */
export const isDevelopmentAuthBypass = import.meta.env.DEV || import.meta.env.VITE_DEV_AUTH_BYPASS === 'true';
export const isMeaningfulClerkSessionTransition = (previousSessionKey: string | undefined, currentSessionKey: string | undefined) => Boolean(previousSessionKey && currentSessionKey && previousSessionKey !== currentSessionKey);
export const shouldRevokeForOfflineClerkUser = (providerChanged: boolean, signedIn: boolean, currentClerkUserId: string | undefined, lastVerifiedClerkUserId: string | undefined, hydrated = true) => hydrated && providerChanged && signedIn && Boolean(currentClerkUserId) && currentClerkUserId !== lastVerifiedClerkUserId;
export const shouldReverifyTrustedOffline = (online: boolean, clerkLoaded: boolean, signedIn: boolean, status: AuthLifecycleStatus) => online && clerkLoaded && signedIn && status === 'trusted-offline';
export const getAuthState = () => authState;
export const subscribeAuthState = (listener: () => void) => { authListeners.add(listener); return () => authListeners.delete(listener); };
export const getConnectionState = () => connectionState;
export const subscribeConnectionState = (listener: () => void) => { connectionListeners.add(listener); return () => connectionListeners.delete(listener); };
export const getAuthLifecycle = () => authLifecycle;
export const subscribeAuthLifecycle = (listener: () => void) => { authListeners.add(listener); return () => authListeners.delete(listener); };
const setAuthLifecycle = (next: AuthLifecycle) => { if (authLifecycle.status === next.status && authLifecycle.error === next.error) return; authLifecycle = next; authListeners.forEach((listener) => listener()); };
export const clearAuthRequired = () => { authBlocked = false; allowIdentityVerification(); if (!authState.required) return; authState = { required: false }; authListeners.forEach((listener) => listener()); };
const signalAuthRequired = (code: AuthRequiredCode) => {
  verifiedIdentity = undefined;
  authInvalidationGeneration += 1;
  authBlocked = true;
  blockResourceIdentity(new ApiError('Authentication is required before private data can be refreshed.', { code }));
  authState = { required: true, code };
  setAuthLifecycle({ status: 'unauthenticated' });
  authListeners.forEach((listener) => listener());
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('billsplit-auth-required', { detail: { code } }));
};
/** Clerk is authoritative for the signed-out state; avoid racing /api/me during provider startup. */
export const markSignedOut = () => {
  if (authLifecycle.status === 'unauthenticated' && authState.required) return;
  signalAuthRequired('AUTH_REQUIRED');
};
/** Invalidate all prior private memory before rechecking a changed Clerk session. */
export const resetForClerkSessionChange = () => {
  identityRequest = undefined;
  authLifecycleRequest = undefined;
  signalAuthRequired('AUTH_REQUIRED');
  setAuthLifecycle({ status: 'checking' });
};
/** Revoke private UI immediately for an offline account change; reverification waits for connectivity. */
export const revokeForClerkSessionChange = () => signalAuthRequired('IDENTITY_MISMATCH');
export const getTrustedOfflineClerkUserId = () => verifiedClerkUserId;
export const isTrustedOfflineClerkUserIdHydrated = () => clerkUserIdHydrated;
const signalReconnectRequired = () => {
  if (connectionState.reconnectRequired) return;
  connectionState = { reconnectRequired: true };
  connectionListeners.forEach((listener) => listener());
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('billsplit-reconnect-required'));
};
const clearReconnectRequired = () => {
  if (!connectionState.reconnectRequired) return;
  connectionState = { reconnectRequired: false };
  connectionListeners.forEach((listener) => listener());
};

/** Keep Clerk's post-auth destination on this public shell and out of API paths. */
export function sanitizeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/';
  try {
    const url = new URL(value, 'https://billsplit.invalid');
    if (url.origin !== 'https://billsplit.invalid' || /^(?:\/api(?:\/|$)|\/cdn-cgi(?:\/|$)|\/sign-in(?:\/|$)|\/sign-up(?:\/|$))/i.test(url.pathname)) return '/';
    return `${url.pathname}${url.search}${url.hash}` || '/';
  } catch { return '/'; }
}

/** Offline cold starts may use the trusted cache before Clerk's browser SDK has loaded. */
export const shouldStartAuthCheck = (online: boolean, clerkLoaded: boolean) => !online || clerkLoaded;

export class ApiError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly serverMessage?: string;
  readonly networkFailure: boolean;
  readonly isNetworkError: boolean;
  readonly reconnectRequired: boolean;

  constructor(message: string, options: { status?: number; code?: string; networkFailure?: boolean; reconnectRequired?: boolean } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = options.status;
    this.code = options.code;
    this.serverMessage = options.status === undefined ? undefined : message;
    this.networkFailure = options.networkFailure === true;
    this.isNetworkError = this.networkFailure;
    this.reconnectRequired = options.reconnectRequired === true;
  }
}

const devEmail = () => typeof localStorage === 'undefined' ? 'dev@example.com' : localStorage.getItem('dev-email') || 'dev@example.com';
const isNetwork = (error: unknown): error is ApiError => error instanceof ApiError && error.networkFailure;
const cacheRead = async <T>(read: () => Promise<T | undefined>) => {
  try { return await read(); }
  catch (error) {
    if (error instanceof SessionGenerationMismatchError) throw error;
    return undefined;
  }
};
const cacheWrite = async <T>(write: () => Promise<T>) => {
  try { return await write(); }
  catch (error) {
    if (error instanceof SessionGenerationMismatchError) throw error;
    /* Private cache is an enhancement, not a request failure. */
    return undefined;
  }
};
const assertRequestGeneration = (generation: number) => {
  if (!isSessionGenerationCurrent(generation)) throw new ApiError('The local session was cleared.', { status: 401, code: 'AUTH_REQUIRED' });
};

async function apiWithMetaTransport<T>(path: string, init?: RequestInit): Promise<ApiResponse<T>> {
  const headers = new Headers(init?.headers);
  headers.set('Content-Type', 'application/json');
  headers.set('X-Requested-With', 'XMLHttpRequest');
  if (import.meta.env.DEV && !headers.has('X-Dev-Email')) headers.set('X-Dev-Email', devEmail());
  let response: Response;
  try { response = await fetch(`/api${path}`, { ...init, headers, credentials: 'same-origin' }); }
  catch (error) {
    if (init?.signal?.aborted) throw error;
    const reconnectRequired = typeof navigator !== 'undefined' && navigator.onLine !== false;
    if (reconnectRequired) signalReconnectRequired();
    throw new ApiError(reconnectRequired ? 'Connection failed while online. Reconnect or check your session.' : 'Network connection unavailable.', { networkFailure: true, code: 'NETWORK_ERROR', reconnectRequired });
  }

  const finalUrl = (() => { try { return new URL(response.url); } catch { return undefined; } })();
  const contentType = response.headers.get('content-type') || '';
  const authResponse = response.status === 401 || (response.status >= 300 && response.status < 400) || response.redirected;
  const unexpectedFormat = !contentType.toLowerCase().includes('json') && response.status !== 204;
  if (response.status === 204) {
    if (authResponse) throw new ApiError('Your secure session needs attention. Reconnect and check your sign-in before retrying.', { status: response.status, code: 'AUTH_REQUIRED' });
    if (!response.ok) throw new ApiError(`Request failed (${response.status})`, { status: response.status });
    clearReconnectRequired();
    return { data: undefined as T, userId: response.headers.get('X-BillSplit-User-Id') || undefined };
  }

  const bodyText = await response.clone().text();
  let body: { error?: { code?: string; message?: string } } | T | null = null;
  try { body = JSON.parse(bodyText) as { error?: { code?: string; message?: string } } | T; } catch { /* handled as an auth/session response below */ }
  const responseCode = body && typeof body === 'object' && 'error' in body ? (body as { error?: { code?: string } }).error?.code : undefined;
  // 403 is auth revocation unless the API has explicitly identified an
  // application-level permission error. OWNER_REQUIRED/ORIGIN_FORBIDDEN are
  // meaningful API errors.
  const accessDenied = response.status === 403 && responseCode !== 'OWNER_REQUIRED' && responseCode !== 'ORIGIN_FORBIDDEN';
  if (authResponse || accessDenied) {
    signalAuthRequired(accessDenied ? 'AUTH_REQUIRED' : 'AUTH_REQUIRED');
    throw new ApiError('Your secure session needs attention. Reconnect and check your sign-in before retrying.', { status: response.status, code: 'AUTH_REQUIRED' });
  }
  if (body === null || unexpectedFormat) {
    if (response.status >= 500) throw new ApiError(`Request failed (${response.status})`, { status: response.status, code: 'SERVER_ERROR' });
    signalReconnectRequired();
    throw new ApiError('The server returned an unexpected response. Reconnect and check your session before retrying.', { status: response.status, code: 'PROTOCOL_ERROR', reconnectRequired: true });
  }
  if (!response.ok) {
    const errorBody = body as { error?: { code?: string; message?: string } };
    const message = errorBody?.error?.message || `Request failed (${response.status})`;
    const code = errorBody?.error?.code;
    if (response.status === 401 && (code === 'AUTH_INVALID' || code === 'IDENTITY_MISMATCH')) signalAuthRequired(code);
    throw new ApiError(message, { status: response.status, code });
  }
  clearReconnectRequired();
  return { data: body as T, userId: response.headers.get('X-BillSplit-User-Id') || undefined };
}

export function apiWithMeta<T>(path: string, init?: RequestInit): Promise<ApiResponse<T>> {
  const method = (init?.method || 'GET').toUpperCase();
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)
    ? runMutation(() => apiWithMetaTransport<T>(path, init))
    : apiWithMetaTransport<T>(path, init);
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> { return (await apiWithMeta<T>(path, init)).data; }

async function identityForCache() { return cacheRead(readLastVerifiedIdentity); }
async function clerkIdentityForCache() {
  const identity = await cacheRead(readLastVerifiedClerkUserId);
  clerkUserIdHydrated = true;
  return identity;
}
type CacheIdentity = { user: CurrentUser; authoritative: boolean };
async function requireIdentityForCache(signal?: AbortSignal): Promise<CacheIdentity | undefined> {
  const identitySnapshot = getResourceSnapshot('identity');
  if (identitySnapshot.status === 'auth-blocked') throw new ApiError('Your secure session needs attention before private data can be refreshed.', { status: 401, code: 'AUTH_REQUIRED' });
  if (typeof window !== 'undefined' && typeof navigator !== 'undefined' && verifiedIdentity) return { user: verifiedIdentity, authoritative: true };
  const cached = await identityForCache();
  // An online request must re-check the server identity before attaching data
  // to a user-scoped cache. Offline, the last verified profile is intentional.
  if (typeof navigator !== 'undefined' && navigator.onLine === false && cached) return { user: { id: cached.userId, email: cached.email, personId: cached.personId }, authoritative: false };
  try {
    const current = await getMe({ signal });
    return { user: { id: current.id, email: current.email, personId: current.personId }, authoritative: current.authoritative === true };
  } catch (error) {
    if (!isNetwork(error)) throw error;
    const trustedOffline = typeof window === 'undefined' || typeof navigator === 'undefined' || navigator.onLine === false;
    return trustedOffline && cached ? { user: { id: cached.userId, email: cached.email, personId: cached.personId }, authoritative: false } : undefined;
  }
}
const offline = <T extends object>(value: T): CachedResult<T> => ({ ...value, offline: true, stale: true });
const assertResponseIdentity = (responseUserId: string | undefined, identity: CacheIdentity | undefined) => {
  if (responseUserId && identity && responseUserId !== identity.user.id) {
    signalAuthRequired('IDENTITY_MISMATCH');
    throw new ApiError('The verified identity changed; cached data was not used.', { status: 401, code: 'IDENTITY_MISMATCH' });
  }
};

export async function getMe(options: { networkOnly?: boolean; signal?: AbortSignal; clerkUserId?: string } = {}): Promise<CachedResult<CurrentUser>> {
  if (identityRequest) return identityRequest;
  if ((isMutationBarrierActive() || getSessionLogoutInProgress()) && (authLifecycle.status === 'authenticated' || authLifecycle.status === 'trusted-offline')) throw new ApiError('Logout is in progress. Try again after signing in.', { status: 401, code: 'AUTH_REQUIRED' });
  const generation = captureSessionGeneration();
  const authGeneration = authInvalidationGeneration;
  identityRequest = (async () => {
    try {
      const result = await apiWithMeta<CurrentUser>('/me', { signal: options.signal });
       if (authGeneration !== authInvalidationGeneration) throw new ApiError('Authentication is required before private data can be refreshed.', { status: 401, code: 'AUTH_REQUIRED' });
       assertRequestGeneration(generation);
      const user = result.data;
      if (result.userId && result.userId !== user.id) { signalAuthRequired('IDENTITY_MISMATCH'); throw new ApiError('The verified identity changed; sign in again before retrying.', { status: 401, code: 'IDENTITY_MISMATCH' }); }
       assertRequestGeneration(generation);
       await cacheWrite(() => saveVerifiedIdentity({ userId: user.id, email: user.email, personId: user.personId, verifiedAt: new Date().toISOString() }, generation));
       if (options.clerkUserId) await cacheWrite(() => saveLastVerifiedClerkUserId(options.clerkUserId!, generation));
       assertRequestGeneration(generation);
       if (getSessionLogoutInProgress()) clearSessionLogout(generation);
       verifiedIdentity = user;
       if (options.clerkUserId) { verifiedClerkUserId = options.clerkUserId; clerkUserIdHydrated = true; }
      setResourceIdentity(user.id);
      seedResource('identity', '', user, Date.now(), { offline: false });
       clearAuthRequired();
       releaseMutationBarrier();
      setAuthLifecycle({ status: 'authenticated' });
      if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('billsplit-authenticated', { detail: { userId: user.id } }));
      return { ...user, authoritative: true };
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (!isNetwork(error)) throw error;
       const cached = await identityForCache();
       const cachedClerkIdentity = await clerkIdentityForCache();
       if (cachedClerkIdentity?.clerkUserId) verifiedClerkUserId = cachedClerkIdentity.clerkUserId;
      const trustedOffline = typeof window === 'undefined' || typeof navigator === 'undefined' || navigator.onLine === false;
        if (!options.networkOnly && !getSessionLogoutInProgress() && authGeneration === authInvalidationGeneration && !authBlocked && trustedOffline && cached && isSessionGenerationCurrent(generation)) {
        const result = { ...offline({ id: cached.userId, email: cached.email, personId: cached.personId }), authoritative: false };
        seedResource('identity', '', result, Date.now(), { offline: true });
        setAuthLifecycle({ status: 'trusted-offline' });
        return result;
      }
      throw error;
    }
  })();
  try { return await identityRequest; } finally { identityRequest = undefined; }
}

export async function initializeAuthLifecycle(options: { networkOnly?: boolean; clerkUserId?: string } = {}): Promise<AuthLifecycle> {
  if (authLifecycleRequest) return authLifecycleRequest;
  const forceReverify = options.networkOnly === true;
  if ((authLifecycle.status === 'authenticated' || authLifecycle.status === 'trusted-offline') && !forceReverify) return authLifecycle;
  setAuthLifecycle({ status: 'checking' });
  const request = getMe({ networkOnly: forceReverify, clerkUserId: options.clerkUserId }).then(() => authLifecycle).catch((error) => {
    if (error instanceof ApiError && (error.status === 401 || error.code === 'AUTH_REQUIRED' || error.code === 'AUTH_INVALID' || error.code === 'IDENTITY_MISMATCH')) setAuthLifecycle({ status: 'unauthenticated' });
    else setAuthLifecycle({ status: 'unauthenticated', error });
    return authLifecycle;
  }).finally(() => { if (authLifecycleRequest === request) authLifecycleRequest = undefined; });
  authLifecycleRequest = request;
  return authLifecycleRequest;
}

/**
 * A failed Clerk sign-out must not strand the durable logout barrier. The
 * generation remains advanced, so responses from the old session stay stale;
 * only the barrier is released so the user can retry sign-in or sign-out.
 */
export const recoverAfterClerkSignOutFailure = (cause?: unknown) => {
  const generation = getSessionGeneration();
  clearSessionLogout(generation);
  releaseMutationBarrier(generation);
  resumeOutboxAfterFailedLogout();
  authBlocked = true;
  authState = { required: true, code: 'AUTH_REQUIRED' };
  const message = cause instanceof Error ? cause.message : 'Clerk sign-out could not be completed';
  setAuthLifecycle({ status: 'unauthenticated', error: new ClerkSignOutFailure(message) });
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('billsplit-signout-retryable'));
};

export async function clearEverythingForLogout(broadcast = true, receivedGeneration?: number) {
  const generation = receivedGeneration ?? startSessionLogout(broadcast);
  if (receivedGeneration !== undefined && !isSessionGenerationCurrent(receivedGeneration)) return;
  beginMutationBarrier(generation);
  try {
    // Publish the barrier first, then ask the outbox to abort as an
    // accelerator. The exclusive lock still owns the actual quiescence
    // boundary and waits for the transport promise to settle.
    const outboxQuiescence = quiesceOutboxForLogout();
    await withExclusiveMutationLock(async () => {
      await outboxQuiescence;
      await clearAllPrivateData();
    });
  } catch (error) {
    // Keep the current authenticated UI visible when storage is unavailable.
    // Release the lock barrier so retry is possible; the session generation
    // remains advanced so old responses cannot repopulate private caches.
    releaseMutationBarrier(generation);
    resumeOutboxAfterFailedLogout();
    if (receivedGeneration === undefined) rollbackSessionLogout(generation);
    throw error;
  }
  verifiedIdentity = undefined;
  verifiedClerkUserId = undefined;
  clerkUserIdHydrated = true;
  authBlocked = true;
  authInvalidationGeneration += 1;
  identityRequest = undefined;
  resetResourceIdentity();
  authState = { required: true, code: 'AUTH_REQUIRED' };
  clearReconnectRequired();
  setAuthLifecycle({ status: 'unauthenticated' });
  if (typeof localStorage !== 'undefined') {
    try { localStorage.removeItem('dev-email'); } catch { /* Storage can be disabled. */ }
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('billsplit-cache-cleared', { detail: { clearOutbox: true, generation } }));
}

export async function getGroups(signal?: AbortSignal): Promise<CachedResult<{ groups: Group[] }>> {
  const generation = captureSessionGeneration();
  const identity = await requireIdentityForCache(signal);
  assertRequestGeneration(generation);
  const requestGeneration = identity ? (await cacheRead(() => readMutationGeneration(identity.user.id)) ?? 0) : 0;
  try {
    const result = await apiWithMeta<{ groups: Group[] }>('/groups', { signal });
    assertRequestGeneration(generation); assertResponseIdentity(result.userId, identity);
    let persisted = true;
    if (result.userId) { const responseUserId = result.userId; persisted = (await cacheWrite(() => saveGroupsIfGenerationMatches({ userId: responseUserId, groups: result.data.groups, cachedAt: new Date().toISOString() }, requestGeneration, generation))) !== false; }
    return persisted ? result.data : { ...result.data, stale: true };
  } catch (error) {
    assertRequestGeneration(generation);
    if (!isNetwork(error) || !identity) throw error;
    const cached = await cacheRead(() => readGroups(identity.user.id));
    if (cached) return offline({ groups: cached.groups });
    throw error;
  }
}

export async function getGroup(id: string, signal?: AbortSignal): Promise<CachedResult<{ group: Group; members: GroupMember[] }>> {
  const generation = captureSessionGeneration();
  const identity = await requireIdentityForCache(signal);
  try {
    const result = await apiWithMeta<{ group: Group; members: GroupMember[] }>(`/groups/${id}`, { signal });
    assertRequestGeneration(generation); assertResponseIdentity(result.userId, identity);
    if (result.userId) await cacheWrite(() => updateGroupSnapshot(result.userId!, id, { group: result.data.group, members: result.data.members }, generation));
    return result.data;
  } catch (error) {
    assertRequestGeneration(generation);
    if (!isNetwork(error) || !identity) throw error;
    const cached = await cacheRead(() => readGroupSnapshot(identity.user.id, id));
    if (cached?.group && cached.members) return offline({ group: cached.group, members: cached.members });
    throw error;
  }
}

export async function getExpenses(id: string, signal?: AbortSignal): Promise<CachedResult<{ expenses: Expense[] }>> {
  const generation = captureSessionGeneration();
  const identity = await requireIdentityForCache(signal);
  try {
    const result = await apiWithMeta<{ expenses: Expense[] }>(`/groups/${id}/expenses`, { signal });
    assertRequestGeneration(generation); assertResponseIdentity(result.userId, identity);
    if (result.userId) { await cacheWrite(() => updateGroupSnapshot(result.userId!, id, { expenses: result.data.expenses }, generation)); const reconciled = await cacheRead(() => reconcileOutboxItems(result.userId!, id, result.data.expenses, generation)); if (reconciled) { await invalidateForMutation.expenseChanged(id, undefined, result.userId, generation); if (typeof window !== 'undefined') window.dispatchEvent(new Event('billsplit-outbox-changed')); } }
    return result.data;
  } catch (error) {
    assertRequestGeneration(generation);
    if (!isNetwork(error) || !identity) throw error;
    const cached = await cacheRead(() => readGroupSnapshot(identity.user.id, id));
    if (cached?.expenses) return offline({ expenses: cached.expenses });
    throw error;
  }
}

export async function getBalances(id: string, signal?: AbortSignal): Promise<CachedResult<{ balances: Record<string, Balances> }>> {
  const generation = captureSessionGeneration();
  const identity = await requireIdentityForCache(signal);
  try {
    const result = await apiWithMeta<{ balances: Record<string, Balances> }>(`/groups/${id}/balances`, { signal });
    assertRequestGeneration(generation); assertResponseIdentity(result.userId, identity);
    if (result.userId) await cacheWrite(() => updateGroupSnapshot(result.userId!, id, { balances: result.data.balances }, generation));
    return result.data;
  } catch (error) {
    assertRequestGeneration(generation);
    if (!isNetwork(error) || !identity) throw error;
    const cached = await cacheRead(() => readGroupSnapshot(identity.user.id, id));
    if (cached?.balances) return offline({ balances: cached.balances });
    throw error;
  }
}

export async function getSettlements(id: string, signal?: AbortSignal): Promise<CachedResult<{ settlements: Settlement[] }>> {
  const generation = captureSessionGeneration();
  const identity = await requireIdentityForCache(signal);
  try {
    const result = await apiWithMeta<{ settlements: Settlement[] }>(`/groups/${id}/settlements`, { signal });
    assertRequestGeneration(generation); assertResponseIdentity(result.userId, identity);
    if (result.userId) await cacheWrite(() => updateGroupSnapshot(result.userId!, id, { settlements: result.data.settlements }, generation));
    return result.data;
  } catch (error) {
    assertRequestGeneration(generation);
    if (!isNetwork(error) || !identity) throw error;
    const cached = await cacheRead(() => readGroupSnapshot(identity.user.id, id));
    if (cached?.settlements) return offline({ settlements: cached.settlements });
    throw error;
  }
}

export const getExpense = (id: string) => getExpenseDetails(id).then((result) => result.expense);
export async function getExpenseDetails(id: string, signal?: AbortSignal): Promise<CachedResult<{ expense: Expense; history: Array<{ id: string; revision: number; createdAt: string }> }>> {
  const generation = captureSessionGeneration();
  const identity = await requireIdentityForCache(signal);
  try {
    const result = await apiWithMeta<{ expense: Expense; history: Array<{ id: string; revision: number; createdAt: string }> }>(`/expenses/${id}`, { signal });
    assertRequestGeneration(generation); assertResponseIdentity(result.userId, identity);
    if (result.userId) await cacheWrite(() => saveExpenseDetails({ userId: result.userId!, expenseId: id, expense: result.data.expense, history: result.data.history, fetchedAt: new Date().toISOString() }, generation));
    return result.data;
  } catch (error) {
    assertRequestGeneration(generation);
    if (!isNetwork(error) || !identity) throw error;
    const cached = await cacheRead(() => readExpenseDetails(identity.user.id, id));
    if (cached) return offline({ expense: cached.expense, history: cached.history });
    throw error;
  }
}

export async function getActivity(id: string, signal?: AbortSignal): Promise<CachedResult<{ activity: Activity[] }>> {
  const generation = captureSessionGeneration();
  const identity = await requireIdentityForCache(signal);
  try {
    const result = await apiWithMeta<{ activity: Activity[] }>(`/groups/${id}/activity`, { signal });
    assertRequestGeneration(generation); assertResponseIdentity(result.userId, identity);
    const data = { activity: normalizeActivity(result.data.activity) };
    if (result.userId) await cacheWrite(() => saveActivity({ userId: result.userId!, groupId: id, activity: data.activity, fetchedAt: new Date().toISOString() }, generation));
    return data;
  } catch (error) {
    assertRequestGeneration(generation);
    if (!isNetwork(error) || !identity) throw error;
    const cached = await cacheRead(() => readActivity(identity.user.id, id));
    if (cached) return offline({ activity: cached.activity });
    throw error;
  }
}

export async function hydrateGroups(userId: string) {
  const cached = await cacheRead(() => readGroups(userId));
  return cached ? { data: { groups: cached.groups }, fetchedAt: cacheTimestamp(cached.cachedAt), offline: true } : undefined;
}
const cacheTimestamp = (value: string) => { const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : 0; };
export async function hydrateIdentity() {
  if (typeof navigator !== 'undefined' && navigator.onLine !== false) return undefined;
  const cached = await cacheRead(readLastVerifiedIdentity);
  return cached ? { data: { id: cached.userId, email: cached.email, personId: cached.personId }, fetchedAt: cacheTimestamp(cached.verifiedAt), offline: true } : undefined;
}
export async function hydrateGroup(userId: string, id: string) {
  const cached = await cacheRead(() => readGroupSnapshot(userId, id));
  return cached?.group && cached.members ? { data: { group: cached.group, members: cached.members }, fetchedAt: cacheTimestamp(cached.cachedAtByResource?.group || cached.cachedAt), offline: true } : undefined;
}
export async function hydrateExpenses(userId: string, id: string) {
  const cached = await cacheRead(() => readGroupSnapshot(userId, id));
  return cached?.expenses ? { data: { expenses: cached.expenses }, fetchedAt: cacheTimestamp(cached.cachedAtByResource?.expenses || cached.cachedAt), offline: true } : undefined;
}
export async function hydrateBalances(userId: string, id: string) {
  const cached = await cacheRead(() => readGroupSnapshot(userId, id));
  return cached?.balances ? { data: { balances: cached.balances }, fetchedAt: cacheTimestamp(cached.cachedAtByResource?.balances || cached.cachedAt), offline: true } : undefined;
}
export async function hydrateSettlements(userId: string, id: string) {
  const cached = await cacheRead(() => readGroupSnapshot(userId, id));
  return cached?.settlements ? { data: { settlements: cached.settlements }, fetchedAt: cacheTimestamp(cached.cachedAtByResource?.settlements || cached.cachedAt), offline: true } : undefined;
}
export async function hydrateActivity(userId: string, id: string) {
  const cached = await cacheRead(() => readActivity(userId, id));
  // Caches written before entityActive existed are safe to display, but their
  // rows cannot establish link eligibility. Mark them stale immediately so an
  // online tab revalidates without discarding the offline-safe presentation.
  const hasUnknownEligibility = cached?.activity.some((item) => item.entityActive === undefined) === true;
  return cached ? { data: { activity: cached.activity }, fetchedAt: hasUnknownEligibility ? 0 : cacheTimestamp(cached.fetchedAt), offline: true } : undefined;
}
export async function hydrateExpenseDetails(userId: string, id: string) {
  const cached = await cacheRead(() => readExpenseDetails(userId, id));
  return cached ? { data: { expense: cached.expense, history: cached.history }, fetchedAt: cacheTimestamp(cached.fetchedAt), offline: true } : undefined;
}

if (typeof window !== 'undefined') window.addEventListener('billsplit-cache-cleared', () => { verifiedIdentity = undefined; verifiedClerkUserId = undefined; clerkUserIdHydrated = true; });
subscribeSessionLogout((generation) => { void clearEverythingForLogout(false, generation); });
