import type { Activity, Expense, Group, GroupMember, ScheduledExpense, Settlement, Balances } from '../shared/types';
import type { ScheduledExpenseInput } from '../shared/schemas';
import { clearAllPrivateData, isOfflineTrustUsable, normalizeActivity, readActivity, readCategories, readExpenseDetails, readGroupSnapshot, readGroups, readOfflineTrust, readMutationGeneration, reconcileOutboxItems, revokeOfflineTrust, saveActivity, saveCategories, saveGroupsIfGenerationMatches, saveOfflineTrust, saveExpenseDetails, updateGroupSnapshot, type OfflineTrustRecord } from './idb';
import { allowIdentityVerification, blockResourceIdentity, getResourceSnapshot, invalidateForMutation, resetResourceIdentity, seedResource, setResourceAuthLifecycleReady, setResourceIdentity } from './resource-cache';
import { quiesceOutboxForLogout, resumeOutboxAfterFailedLogout } from './logout-coordination';
import { captureSessionGeneration, clearSessionLogout, getSessionGeneration, getSessionLogoutInProgress, isSessionGenerationCurrent, rollbackSessionLogout, SessionGenerationMismatchError, startSessionLogout, subscribeSessionLogout } from './session';
import { beginMutationBarrier, isMutationBarrierActive, releaseMutationBarrier, runMutation, withExclusiveMutationLock } from './mutation-quiescence';

export type CurrentUser = { id: string; email: string; personId: string };
export type CachedResult<T> = T & { offline?: boolean; stale?: boolean; authoritative?: boolean };
export type ApiResponse<T> = { data: T; userId?: string; clerkUserId?: string };
export type AuthRequiredCode = 'AUTH_REQUIRED' | 'AUTH_INVALID' | 'IDENTITY_MISMATCH';
export type AuthState = { required: boolean; code?: AuthRequiredCode };
export type ConnectionState = { reconnectRequired: boolean };
export type AuthLifecycleStatus = 'checking' | 'unauthenticated' | 'authenticated' | 'trusted-offline' | 'verification-unavailable';
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
let authLifecycleRequest: { key: string; promise: Promise<AuthLifecycle> } | undefined;
let identityRequest: { key: string; promise: Promise<CachedResult<CurrentUser>> } | undefined;
let authBlocked = false;
let authInvalidationGeneration = 0;
let trustRevocationRequest: Promise<boolean> | undefined;
let trustRevocationRequired = false;
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
const setAuthLifecycle = (next: AuthLifecycle) => { if (authLifecycle.status === next.status && authLifecycle.error === next.error) return; authLifecycle = next; setResourceAuthLifecycleReady(next.status === 'authenticated' || next.status === 'trusted-offline'); authListeners.forEach((listener) => listener()); };
export const getAuthEpoch = () => authInvalidationGeneration;
export const isAuthEpochCurrent = (epoch: number) => epoch === authInvalidationGeneration;
const advanceAuthEpoch = () => { authInvalidationGeneration += 1; identityRequest = undefined; authLifecycleRequest = undefined; return authInvalidationGeneration; };
export const clearAuthRequired = () => { authBlocked = false; allowIdentityVerification(); if (!authState.required) return; authState = { required: false }; authListeners.forEach((listener) => listener()); };
const signalAuthRequired = (code: AuthRequiredCode) => {
  verifiedIdentity = undefined;
  advanceAuthEpoch();
  authBlocked = true;
  blockResourceIdentity(new ApiError('Authentication is required before private data can be refreshed.', { code }));
  if (code === 'IDENTITY_MISMATCH') {
    requestTrustRevocation();
    authState = { required: false };
    setAuthLifecycle({ status: 'verification-unavailable', error: new ApiError('The verified account changed. Reconnect and retry verification.', { code }) });
  } else {
    authState = { required: true, code };
    setAuthLifecycle({ status: 'unauthenticated' });
  }
  authListeners.forEach((listener) => listener());
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('billsplit-auth-required', { detail: { code } }));
};
/** Clerk is authoritative for the signed-out state; avoid racing /api/me during provider startup. */
export const markSignedOut = () => {
  requestTrustRevocation();
  if (authLifecycle.status === 'unauthenticated' && authState.required) return;
  signalAuthRequired('AUTH_REQUIRED');
};
/** Invalidate all prior private memory before rechecking a changed Clerk session. */
export const resetForClerkSessionChange = () => {
  requestTrustRevocation();
  verifiedIdentity = undefined;
  verifiedClerkUserId = undefined;
  clerkUserIdHydrated = false;
  advanceAuthEpoch();
  authBlocked = true;
  blockResourceIdentity(new ApiError('The account changed. Verify the current account before viewing private data.', { status: 401, code: 'IDENTITY_MISMATCH' }));
  setAuthLifecycle({ status: 'checking' });
};
/** Revoke private UI immediately for an offline account change; reverification waits for connectivity. */
export const revokeForClerkSessionChange = () => {
  requestTrustRevocation();
  verifiedIdentity = undefined;
  advanceAuthEpoch();
  authBlocked = true;
  blockResourceIdentity(new ApiError('Offline access is unavailable for the current account. Verify the account when connected.', { status: 401, code: 'IDENTITY_MISMATCH' }));
  authState = { required: false };
  setAuthLifecycle({ status: 'verification-unavailable', error: new ApiError('Verify the current account when connected.', { code: 'IDENTITY_MISMATCH' }) });
  authListeners.forEach((listener) => listener());
};
export const getTrustedOfflineClerkUserId = () => verifiedClerkUserId;
export const getVerifiedClerkUserId = () => verifiedClerkUserId;
export const getVerifiedUserId = () => verifiedIdentity?.id;
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

/** Bootstrap always starts; provider loading and network reachability are not deadlines. */
export const shouldStartAuthCheck = (_online: boolean, _clerkLoaded: boolean) => true;
/** Clerk must have finished restoring before a false value is a signed-out decision. */
export const isDefinitivelySignedOut = (clerkLoaded: boolean, signedIn: boolean | undefined) => clerkLoaded && signedIn === false;

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

async function apiWithMetaTransport<T>(path: string, init?: RequestInit, expectedAuthEpoch?: number): Promise<ApiResponse<T>> {
  const headers = new Headers(init?.headers);
  headers.set('Content-Type', 'application/json');
  headers.set('X-Requested-With', 'XMLHttpRequest');
  if (import.meta.env.DEV && !headers.has('X-Dev-Email')) headers.set('X-Dev-Email', devEmail());
  let response: Response;
  try { response = await fetch(`/api${path}`, { ...init, headers, credentials: 'same-origin' }); }
  catch (error) {
    if (init?.signal?.aborted) throw error;
    const reconnectRequired = typeof navigator !== 'undefined' && navigator.onLine !== false;
    if (reconnectRequired && (expectedAuthEpoch === undefined || isAuthEpochCurrent(expectedAuthEpoch))) signalReconnectRequired();
    throw new ApiError(reconnectRequired ? 'Connection failed while online. Reconnect or check your session.' : 'Network connection unavailable.', { networkFailure: true, code: 'NETWORK_ERROR', reconnectRequired });
  }

  const finalUrl = (() => { try { return new URL(response.url); } catch { return undefined; } })();
  const contentType = response.headers.get('content-type') || '';
  const authResponse = response.status === 401 || (response.status >= 300 && response.status < 400) || response.redirected;
  const unexpectedFormat = !contentType.toLowerCase().includes('json') && response.status !== 204;
  const assertTransportEpoch = () => {
    // A destructive logout deliberately waits for already-dispatched
    // mutations to settle. Let that transport report its server result, while
    // resource/session-generation guards prevent it from repopulating local
    // private state. A response after a new lifecycle has started is rejected.
    if (expectedAuthEpoch !== undefined && !isAuthEpochCurrent(expectedAuthEpoch) && !getSessionLogoutInProgress()) throw new ApiError('The authentication session changed before this response completed.', { status: 401, code: 'AUTH_REQUIRED' });
  };
  if (response.status === 204) {
    if (authResponse) throw new ApiError('Your secure session needs attention. Reconnect and check your sign-in before retrying.', { status: response.status, code: 'AUTH_REQUIRED' });
    if (!response.ok) throw new ApiError(`Request failed (${response.status})`, { status: response.status });
    assertTransportEpoch();
    clearReconnectRequired();
    return { data: undefined as T, userId: response.headers.get('X-BillSplit-User-Id') || undefined, clerkUserId: response.headers.get('X-BillSplit-Clerk-User-Id') || undefined };
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
    // A request from an earlier Clerk epoch may finish after a new account has
    // started. It must not downgrade the new session.
    const authCode: AuthRequiredCode = responseCode === 'IDENTITY_MISMATCH' ? 'IDENTITY_MISMATCH' : 'AUTH_REQUIRED';
    if (expectedAuthEpoch === undefined || isAuthEpochCurrent(expectedAuthEpoch)) signalAuthRequired(authCode);
    throw new ApiError('Your secure session needs attention. Reconnect and check your sign-in before retrying.', { status: response.status, code: authCode });
  }
  if (body === null || unexpectedFormat) {
    if (response.status >= 500) throw new ApiError(`Request failed (${response.status})`, { status: response.status, code: 'SERVER_ERROR' });
    if (expectedAuthEpoch === undefined || isAuthEpochCurrent(expectedAuthEpoch)) signalReconnectRequired();
    throw new ApiError('The server returned an unexpected response. Reconnect and check your session before retrying.', { status: response.status, code: 'PROTOCOL_ERROR', reconnectRequired: true });
  }
  if (!response.ok) {
    const errorBody = body as { error?: { code?: string; message?: string } };
    const message = errorBody?.error?.message || `Request failed (${response.status})`;
    const code = errorBody?.error?.code;
    if (response.status === 401 && (code === 'AUTH_INVALID' || code === 'IDENTITY_MISMATCH') && (expectedAuthEpoch === undefined || isAuthEpochCurrent(expectedAuthEpoch))) signalAuthRequired(code);
    throw new ApiError(message, { status: response.status, code });
  }
  assertTransportEpoch();
  if (expectedAuthEpoch === undefined || isAuthEpochCurrent(expectedAuthEpoch)) clearReconnectRequired();
  return { data: body as T, userId: response.headers.get('X-BillSplit-User-Id') || undefined, clerkUserId: response.headers.get('X-BillSplit-Clerk-User-Id') || undefined };
}

export function apiWithMeta<T>(path: string, init?: RequestInit, expectedAuthEpoch?: number): Promise<ApiResponse<T>> {
  // Capture the epoch before a mutation waits for the shared lock. A late
  // response from that request must not affect a later Clerk lifecycle.
  const requestEpoch = expectedAuthEpoch ?? getAuthEpoch();
  const method = (init?.method || 'GET').toUpperCase();
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)
    ? runMutation(() => apiWithMetaTransport<T>(path, init, requestEpoch))
    : apiWithMetaTransport<T>(path, init, requestEpoch);
}

export async function api<T>(path: string, init?: RequestInit, expectedAuthEpoch?: number): Promise<T> { return (await apiWithMeta<T>(path, init, expectedAuthEpoch)).data; }

async function trustForCache() { return cacheRead(readOfflineTrust); }
const cachedTrustMatches = (requestedClerkUserId: string | undefined, trust: OfflineTrustRecord | undefined) => requestedClerkUserId === undefined || Boolean(trust?.clerkUserId && trust.clerkUserId.trim().length > 0 && trust.clerkUserId === requestedClerkUserId);
type CacheIdentity = { user: CurrentUser; authoritative: boolean };
async function requireIdentityForCache(signal?: AbortSignal): Promise<CacheIdentity | undefined> {
  const identitySnapshot = getResourceSnapshot('identity');
  if (identitySnapshot.status === 'auth-blocked') throw new ApiError('Your secure session needs attention before private data can be refreshed.', { status: 401, code: 'AUTH_REQUIRED' });
  if (typeof window !== 'undefined' && typeof navigator !== 'undefined' && verifiedIdentity) return { user: verifiedIdentity, authoritative: true };
  const cachedTrust = await trustForCache();
  const cached = cachedTrust && isOfflineTrustUsable(cachedTrust) ? cachedTrust : undefined;
  if (authLifecycle.status === 'trusted-offline' && cached) return { user: { id: cached.userId, email: cached.email, personId: cached.personId }, authoritative: false };
  try {
    const current = await getMe({ signal });
    return { user: { id: current.id, email: current.email, personId: current.personId }, authoritative: current.authoritative === true };
  } catch (error) {
    if (!isNetwork(error)) throw error;
    return cached ? { user: { id: cached.userId, email: cached.email, personId: cached.personId }, authoritative: false } : undefined;
  }
}
const offline = <T extends object>(value: T): CachedResult<T> => ({ ...value, offline: true, stale: true });
const assertResponseIdentity = (responseUserId: string | undefined, identity: CacheIdentity | undefined) => {
  if (responseUserId && identity && responseUserId !== identity.user.id) {
    signalAuthRequired('IDENTITY_MISMATCH');
    throw new ApiError('The verified identity changed; cached data was not used.', { status: 401, code: 'IDENTITY_MISMATCH' });
  }
};

const AUTH_BOOTSTRAP_DEADLINE_MS = 2_500;
const TRUST_READ_DEADLINE_MS = 500;
const TRUST_WRITE_DEADLINE_MS = 500;
const deadline = <T>(promise: Promise<T>, timeoutMs: number, timeout: () => T | Promise<T>) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((resolve, reject) => { timer = setTimeout(() => { try { Promise.resolve(timeout()).then(resolve, reject); } catch (error) { reject(error); } }, timeoutMs); });
  return Promise.race([promise, timeoutPromise]).finally(() => { if (timer) clearTimeout(timer); });
};

type BoundedTrustRead = { record?: OfflineTrustRecord; timedOut: boolean };
const boundedTrustRead = async (): Promise<BoundedTrustRead> => {
  const read = trustForCache();
  let timedOut = false;
  // A browser can leave an IDB request pending forever after a version-change
  // or abort. Do not await it; its eventual value is intentionally ignored.
  void read.catch(() => undefined);
  const record = await deadline(read, TRUST_READ_DEADLINE_MS, () => { timedOut = true; return undefined; });
  return { record, timedOut };
};

const boundedTrustWrite = (write: Promise<boolean>) => {
  void write.catch(() => undefined);
  return deadline(write, TRUST_WRITE_DEADLINE_MS, () => false).catch(() => false);
};

const requestTrustRevocation = () => {
  trustRevocationRequired = true;
  if (trustRevocationRequest) return trustRevocationRequest;
  const write = revokeOfflineTrust();
  void write.catch(() => undefined);
  const request = deadline(write, TRUST_WRITE_DEADLINE_MS, () => false).catch(() => false).then((result) => { if (result === true) trustRevocationRequired = false; return result === true; }).finally(() => {
    if (trustRevocationRequest === request) trustRevocationRequest = undefined;
  });
  trustRevocationRequest = request;
  return request;
};

const ensureTrustRevoked = async () => {
  const request = requestTrustRevocation();
  const revoked = await request;
  if (revoked && !trustRevocationRequest) trustRevocationRequired = false;
  return revoked && !trustRevocationRequest;
};

class StaleAuthInitializationError extends Error {
  constructor() { super('The authentication lifecycle changed while it was being initialized.'); this.name = 'StaleAuthInitializationError'; }
}
const assertAuthEpoch = (epoch: number) => {
  if (!isAuthEpochCurrent(epoch)) throw new StaleAuthInitializationError();
};

export async function getMe(options: { networkOnly?: boolean; signal?: AbortSignal; clerkUserId?: string; expectedUserId?: string; expectedAuthEpoch?: number; startupFallbackMs?: number } = {}): Promise<CachedResult<CurrentUser>> {
  const authGeneration = options.expectedAuthEpoch ?? authInvalidationGeneration;
  const key = `${authGeneration}:${options.clerkUserId || ''}:${options.networkOnly === true}:${options.signal ? 'signal' : 'shared'}`;
  if (identityRequest && identityRequest.key === key) return identityRequest.promise;
  if ((isMutationBarrierActive() || getSessionLogoutInProgress()) && (authLifecycle.status === 'authenticated' || authLifecycle.status === 'trusted-offline')) throw new ApiError('Logout is in progress. Try again after signing in.', { status: 401, code: 'AUTH_REQUIRED' });
  const generation = captureSessionGeneration();
  const request = (async () => {
    const controller = new AbortController();
    const onCallerAbort = () => controller.abort();
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', onCallerAbort, { once: true });
    }
    const signal = controller.signal;
    let transport: Promise<ApiResponse<CurrentUser>> | undefined;
    // Capture the CAS token at the start of verification. A revoke in another
    // tab must make the later save a no-op rather than resurrecting trust.
    // Establish the durable fence before dispatching authoritative /me. A
    // promise started before fetch is not enough: its read may complete after
    // a concurrent revocation and accidentally authorize the stale response.
    const expectedTrustRead = await boundedTrustRead();
    try {
      transport = apiWithMeta<CurrentUser>('/me', { signal }, authGeneration);
      const result = await deadline(transport, options.startupFallbackMs ?? AUTH_BOOTSTRAP_DEADLINE_MS, () => {
        throw new ApiError('Verification is taking too long. Check your connection and retry.', { networkFailure: true, code: 'NETWORK_TIMEOUT' });
      });
      if (authGeneration !== authInvalidationGeneration) throw new ApiError('Authentication is required before private data can be refreshed.', { status: 401, code: 'AUTH_REQUIRED' });
      assertRequestGeneration(generation);
      const user = result.data;
      // /api/me carries both sides of the server-authenticated identity. A
      // client supplied Clerk ID is never sufficient to create or refresh a
      // trusted-device record.
      if ((result.userId && result.userId !== user.id) || (options.expectedUserId && user.id !== options.expectedUserId)) {
        if (authGeneration === authInvalidationGeneration) signalAuthRequired('IDENTITY_MISMATCH');
        throw new ApiError('The verified identity changed; sign in again before retrying.', { status: 401, code: 'IDENTITY_MISMATCH' });
      }
      if (options.clerkUserId && result.clerkUserId !== options.clerkUserId) {
        if (authGeneration === authInvalidationGeneration) signalAuthRequired('IDENTITY_MISMATCH');
        throw new ApiError('The server could not prove the current Clerk identity.', { status: 401, code: 'IDENTITY_MISMATCH' });
      }
      assertRequestGeneration(generation);
       // This is the sole trust write. A timeout or CAS miss is non-fatal to
       // the authoritative session, but it grants no durable offline trust.
       if (options.clerkUserId && result.clerkUserId === options.clerkUserId && result.userId === user.id && (!options.expectedUserId || options.expectedUserId === user.id)) {
          if (!expectedTrustRead.timedOut) await boundedTrustWrite(saveOfflineTrust({ userId: user.id, email: user.email, personId: user.personId, clerkUserId: options.clerkUserId!, verifiedAt: new Date().toISOString() }, generation, () => authGeneration === authInvalidationGeneration, expectedTrustRead.record?.revision ?? 0));
         if (authGeneration !== authInvalidationGeneration) throw new ApiError('The authentication session changed during verification.', { status: 401, code: 'AUTH_REQUIRED' });
         verifiedClerkUserId = options.clerkUserId;
         clerkUserIdHydrated = true;
      }
      assertRequestGeneration(generation);
      if (getSessionLogoutInProgress()) clearSessionLogout(generation);
      verifiedIdentity = user;
      setResourceIdentity(user.id);
      seedResource('identity', '', user, Date.now(), { offline: false });
      clearAuthRequired();
      releaseMutationBarrier();
      setAuthLifecycle({ status: 'authenticated' });
      if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('billsplit-authenticated', { detail: { userId: user.id, authEpoch: authGeneration } }));
      return { ...user, authoritative: true };
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (!isNetwork(error)) throw error;
      const cachedRead = await boundedTrustRead();
      const cached = cachedRead.timedOut ? undefined : cachedRead.record;
      if (authGeneration !== authInvalidationGeneration || getSessionLogoutInProgress() || authBlocked || !isSessionGenerationCurrent(generation)) throw error;
      const offlineCacheAllowed = cached && isOfflineTrustUsable(cached) && cachedTrustMatches(options.clerkUserId, cached);
      if (offlineCacheAllowed) {
        const result = { ...offline({ id: cached.userId, email: cached.email, personId: cached.personId }), authoritative: false };
        verifiedIdentity = { id: cached.userId, email: cached.email, personId: cached.personId };
        verifiedClerkUserId = cached.clerkUserId;
        clerkUserIdHydrated = true;
        setResourceIdentity(cached.userId);
        seedResource('identity', '', result, Date.now(), { offline: true });
        setAuthLifecycle({ status: 'trusted-offline' });
        return result;
      }
      throw error;
    } finally {
      // Abort is cleanup only. The raced promise remains observed so a late
      // completion cannot become an unhandled rejection or a state decision.
      controller.abort();
      options.signal?.removeEventListener('abort', onCallerAbort);
      void transport?.catch(() => undefined);
    }
  })();
  identityRequest = { key, promise: request };
  try { return await request; } finally { if (identityRequest?.promise === request) identityRequest = undefined; }
}

export async function initializeAuthLifecycle(options: { networkOnly?: boolean; clerkUserId?: string; startupFallbackMs?: number } = {}): Promise<AuthLifecycle> {
  // This is deliberately captured before any await. Clerk transitions and
  // revocation advance the epoch, invalidating every already-running init.
  let authEpoch = getAuthEpoch();
  const key = `${authEpoch}:${options.clerkUserId || ''}:${options.networkOnly === true}`;
  if (authLifecycleRequest?.key === key) return authLifecycleRequest.promise;
  const forceReverify = options.networkOnly === true;
  const browserOnline = typeof navigator === 'undefined' || navigator.onLine !== false;
  const currentSessionMatches = authLifecycle.status === 'authenticated' && verifiedIdentity && (options.clerkUserId === undefined || verifiedClerkUserId === options.clerkUserId);
  if ((authLifecycle.status === 'authenticated' || (authLifecycle.status === 'trusted-offline' && !browserOnline)) && !forceReverify && (options.clerkUserId === undefined || verifiedClerkUserId === options.clerkUserId)) {
    // An expired record must not block an already authoritative session from
    // refreshing its durable trust record. IDB failure is non-fatal here: the
    // live verified session and its outbox remain usable online.
    const trustRead = await boundedTrustRead();
    const trust = trustRead.timedOut ? undefined : trustRead.record;
    assertAuthEpoch(authEpoch);
    if (trust && isOfflineTrustUsable(trust)) return authLifecycle;
    if (!options.clerkUserId || !verifiedIdentity) return authLifecycle;
  }
  assertAuthEpoch(authEpoch);
  if (!currentSessionMatches) setAuthLifecycle({ status: 'checking' });
  const request = (async () => {
    try {
      let trustRead = await boundedTrustRead();
      let trust = trustRead.timedOut ? undefined : trustRead.record;
      assertAuthEpoch(authEpoch);
      if (options.clerkUserId && trust?.state === 'active' && trust.clerkUserId !== options.clerkUserId) {
        // Revoke before issuing /me for the new Clerk account. A stale old
        // record can therefore never be used if that request is unavailable.
        verifiedIdentity = undefined;
        requestTrustRevocation();
        authEpoch = advanceAuthEpoch();
        if (!await ensureTrustRevoked()) {
          setAuthLifecycle({ status: 'verification-unavailable', error: new ApiError('The previous account is still being cleared. Retry verification.', { code: 'IDENTITY_MISMATCH' }) });
          return authLifecycle;
        }
        assertAuthEpoch(authEpoch);
        trustRead = await boundedTrustRead();
        trust = trustRead.timedOut ? undefined : trustRead.record;
        assertAuthEpoch(authEpoch);
      }
      if (trustRevocationRequest || trustRevocationRequired) {
        if (!await ensureTrustRevoked()) {
          setAuthLifecycle({ status: 'verification-unavailable', error: new ApiError('Private data is still being cleared. Retry verification.', { code: 'IDENTITY_MISMATCH' }) });
          return authLifecycle;
        }
        assertAuthEpoch(authEpoch);
        // The read which preceded revocation is stale by definition. Never
        // use it for offline activation after a session transition.
        trustRead = await boundedTrustRead();
        trust = trustRead.timedOut ? undefined : trustRead.record;
        assertAuthEpoch(authEpoch);
      }
      // Online/unknown Clerk startup must first try the authoritative path.
      // A complete, active record is only the bounded-unavailability fallback.
      if (!browserOnline && !forceReverify && !getSessionLogoutInProgress() && !authBlocked && trust && isOfflineTrustUsable(trust) && cachedTrustMatches(options.clerkUserId, trust)) {
        assertAuthEpoch(authEpoch);
        const user = { id: trust.userId, email: trust.email, personId: trust.personId };
        verifiedIdentity = user;
        verifiedClerkUserId = trust.clerkUserId;
        clerkUserIdHydrated = true;
        setResourceIdentity(user.id);
        seedResource('identity', '', { ...offline(user), authoritative: false }, Date.now(), { offline: true });
        setAuthLifecycle({ status: 'trusted-offline' });
        return authLifecycle;
      }
      const expectedUserId = currentSessionMatches ? verifiedIdentity?.id : undefined;
      await getMe({ networkOnly: forceReverify, clerkUserId: options.clerkUserId, expectedUserId, expectedAuthEpoch: authEpoch, startupFallbackMs: options.startupFallbackMs });
      assertAuthEpoch(authEpoch);
      return authLifecycle;
    } catch (error) {
      // A stale init is intentionally silent. The newer lifecycle owns all
      // visible state and resource decisions.
      if (!isAuthEpochCurrent(authEpoch) || error instanceof StaleAuthInitializationError) return authLifecycle;
      if (error instanceof ApiError && (error.status === 401 || error.code === 'AUTH_REQUIRED' || error.code === 'AUTH_INVALID')) {
        assertAuthEpoch(authEpoch);
        setAuthLifecycle({ status: 'unauthenticated' });
      } else if (currentSessionMatches && isNetwork(error)) {
        // Expiry blocks a fresh offline bootstrap, but never strands a live
        // authoritative session or its queue while a refresh is unavailable.
        assertAuthEpoch(authEpoch);
      } else if (authLifecycle.status !== 'unauthenticated') {
        assertAuthEpoch(authEpoch);
        setAuthLifecycle({ status: 'verification-unavailable', error });
      }
      return authLifecycle;
    }
  })().finally(() => { if (authLifecycleRequest?.promise === request) authLifecycleRequest = undefined; });
  authLifecycleRequest = { key, promise: request };
  return request;
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
  // Invalidate in-flight authentication immediately, before waiting for the
  // outbox or IndexedDB cleanup. The final advance below also invalidates any
  // work that somehow started during the destructive boundary.
  advanceAuthEpoch();
  beginMutationBarrier(generation);
  try {
    // Publish the barrier first, then ask the outbox to abort as an
    // accelerator. The exclusive lock still owns the actual quiescence
    // boundary and waits for the transport promise to settle.
    const outboxQuiescence = quiesceOutboxForLogout();
    // The lock bounds already-dispatched mutations when possible. Cleanup is
    // deliberately performed after the bounded wait as well, so a transport
    // which ignores abort cannot strand local private rows.
    await withExclusiveMutationLock(async () => { await outboxQuiescence; });
    await clearAllPrivateData();
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
  advanceAuthEpoch();
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
  const authEpoch = getAuthEpoch();
  const identity = await requireIdentityForCache(signal);
  try {
    const result = await apiWithMeta<{ expenses: Expense[] }>(`/groups/${id}/expenses`, { signal });
    assertRequestGeneration(generation); assertResponseIdentity(result.userId, identity);
     if (result.userId) { await cacheWrite(() => updateGroupSnapshot(result.userId!, id, { expenses: result.data.expenses }, generation)); const reconciled = await cacheRead(() => reconcileOutboxItems(result.userId!, id, result.data.expenses, generation, authEpoch)); if (reconciled) { await invalidateForMutation.expenseChanged(id, undefined, result.userId, generation); if (typeof window !== 'undefined') window.dispatchEvent(new Event('billsplit-outbox-changed')); } }
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

/** Schedules are intentionally online-only; unlike new expenses they never enter the outbox. */
export async function getScheduledExpenses(id: string, signal?: AbortSignal): Promise<CachedResult<{ scheduledExpenses: ScheduledExpense[] }>> {
  const pageSize = 100;
  const scheduledExpenses: ScheduledExpense[] = [];
  let offset = 0;
  while (true) {
    const result = await apiWithMeta<{ scheduledExpenses: ScheduledExpense[] }>(`/groups/${id}/scheduled-expenses?limit=${pageSize}&offset=${offset}`, { signal });
    scheduledExpenses.push(...result.data.scheduledExpenses);
    if (result.data.scheduledExpenses.length < pageSize) return { ...result.data, scheduledExpenses };
    offset += pageSize;
  }
}

export async function getScheduledExpense(id: string, signal?: AbortSignal): Promise<CachedResult<{ scheduledExpense: ScheduledExpense }>> {
  const result = await apiWithMeta<{ scheduledExpense: ScheduledExpense }>(`/scheduled-expenses/${id}`, { signal });
  return result.data;
}

export async function createScheduledExpense(groupId: string, input: ScheduledExpenseInput) {
  return api<{ scheduledExpense: ScheduledExpense }>(`/groups/${groupId}/scheduled-expenses`, { method: 'POST', body: JSON.stringify(input) });
}

export async function updateScheduledExpense(id: string, input: ScheduledExpenseInput) {
  return api<{ scheduledExpense: ScheduledExpense }>(`/scheduled-expenses/${id}`, { method: 'PUT', body: JSON.stringify(input) });
}

export async function changeScheduledExpenseStatus(id: string, action: 'pause' | 'resume' | 'cancel', version: number) {
  return api<{ scheduledExpense: ScheduledExpense }>(`/scheduled-expenses/${id}/${action}`, { method: 'POST', body: JSON.stringify({ version }) });
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

export async function getActivity(id?: string, signal?: AbortSignal): Promise<CachedResult<{ activity: Activity[] }>> {
  const generation = captureSessionGeneration();
  const identity = await requireIdentityForCache(signal);
  try {
    const requestMutationGeneration = identity ? (await cacheRead(() => readMutationGeneration(identity.user.id)) ?? 0) : 0;
    const result = await apiWithMeta<{ activity: Activity[] }>(id ? `/activity?group=${encodeURIComponent(id)}` : '/activity', { signal });
    assertRequestGeneration(generation); assertResponseIdentity(result.userId, identity);
    const data = { activity: normalizeActivity(result.data.activity) };
    if (result.userId) await cacheWrite(() => saveActivity({ userId: result.userId!, groupId: id || 'all', activity: data.activity, fetchedAt: new Date().toISOString() }, generation, requestMutationGeneration));
    return data;
  } catch (error) {
    assertRequestGeneration(generation);
    if (!isNetwork(error) || !identity) throw error;
    const cached = await cacheRead(() => readActivity(identity.user.id, id || 'all'));
    if (cached) return offline({ activity: cached.activity });
    throw error;
  }
}

export async function getCategories(signal?: AbortSignal): Promise<CachedResult<{ categories: string[] }>> {
  const generation = captureSessionGeneration();
  const identity = await requireIdentityForCache(signal);
  try {
    const requestMutationGeneration = identity ? (await cacheRead(() => readMutationGeneration(identity.user.id)) ?? 0) : 0;
    const result = await apiWithMeta<{ categories: string[] }>('/categories', { signal });
    assertRequestGeneration(generation); assertResponseIdentity(result.userId, identity);
    if (result.userId) await cacheWrite(() => saveCategories({ userId: result.userId!, categories: result.data.categories, fetchedAt: new Date().toISOString() }, generation, requestMutationGeneration));
    return result.data;
  } catch (error) {
    assertRequestGeneration(generation);
    if (!isNetwork(error) || !identity) throw error;
    const cached = await cacheRead(() => readCategories(identity.user.id));
    if (cached) return offline({ categories: cached.categories });
    throw error;
  }
}

export async function hydrateGroups(userId: string) {
  const cached = await cacheRead(() => readGroups(userId));
  return cached ? { data: { groups: cached.groups }, fetchedAt: cacheTimestamp(cached.cachedAt), offline: true } : undefined;
}
const cacheTimestamp = (value: string) => { const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : 0; };
export async function hydrateIdentity() {
  const cached = await cacheRead(readOfflineTrust);
  return cached && isOfflineTrustUsable(cached) ? { data: { id: cached.userId, email: cached.email, personId: cached.personId }, fetchedAt: cacheTimestamp(cached.verifiedAt), offline: true } : undefined;
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
export async function hydrateCategories(userId: string) {
  const cached = await cacheRead(() => readCategories(userId));
  return cached ? { data: { categories: cached.categories }, fetchedAt: cacheTimestamp(cached.fetchedAt), offline: true } : undefined;
}
export async function hydrateExpenseDetails(userId: string, id: string) {
  const cached = await cacheRead(() => readExpenseDetails(userId, id));
  return cached ? { data: { expense: cached.expense, history: cached.history }, fetchedAt: cacheTimestamp(cached.fetchedAt), offline: true } : undefined;
}

if (typeof window !== 'undefined') window.addEventListener('billsplit-cache-cleared', () => { verifiedIdentity = undefined; verifiedClerkUserId = undefined; clerkUserIdHydrated = true; });
subscribeSessionLogout((generation) => { void clearEverythingForLogout(false, generation); });
