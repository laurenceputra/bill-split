import type { Activity, AuditEvent, Expense, Group, GroupInvitation, GroupMember, HistoricalParticipant, ScheduledExpense, Settlement, Balances } from '../shared/types';
import type { ScheduledExpenseInput, SettlementInput } from '../shared/schemas';
import { clearAllPrivateData, isOfflineTrustUsable, normalizeActivity, readActivity, readCategories, readExpenseDetails, readGroupSnapshot, readGroups, readOfflineTrust, readMutationGeneration, reconcileOutboxItems, revokeOfflineTrust, saveActivity, saveCategories, saveGroupsIfGenerationMatches, saveOfflineTrust, saveExpenseDetails, updateGroupSnapshot, type OfflineTrustRecord } from './idb';
import { allowIdentityVerification, blockResourceIdentity, getResourceSnapshot, invalidateForMutation, resetResourceIdentity, seedResource, setResourceAuthLifecycleReady, setResourceIdentity } from './resource-cache';
import { quiesceOutboxForLogout, resumeOutboxAfterFailedLogout } from './logout-coordination';
import { captureSessionGeneration, clearSessionLogout, getSessionGeneration, getSessionLogoutInProgress, isSessionGenerationCurrent, rollbackSessionLogout, SessionGenerationMismatchError, startSessionLogout, subscribeSessionLogout } from './session';
import { beginMutationBarrier, isMutationBarrierActive, releaseMutationBarrier, runMutation, withExclusiveMutationLock } from './mutation-quiescence';
import type { ExpenseFilters } from './expense-filters';
import { expenseFilterQuery, hasExpenseFilters } from './expense-filters';

export type CurrentUser = { id: string; email: string; personId: string };
export type CachedResult<T> = T & { offline?: boolean; stale?: boolean; authoritative?: boolean };
export type ApiResponse<T> = { data: T; userId?: string; clerkUserId?: string; headers?: Headers };
export type AuthRequiredCode = 'AUTH_REQUIRED' | 'AUTH_INVALID' | 'IDENTITY_MISMATCH';
export type AuthState = { required: boolean; code?: AuthRequiredCode };
export type ConnectionStatus = 'checking' | 'connected' | 'connection-issue' | 'offline';
export type ConnectionState = { status: ConnectionStatus; reconnectRequired: boolean };
export type AuthLifecycleStatus = 'checking' | 'unauthenticated' | 'authenticated' | 'trusted-offline' | 'verification-unavailable';
export type AuthLifecycle = { status: AuthLifecycleStatus; error?: unknown };
export type ClerkAuthEvidence = { isLoaded: boolean; isSignedIn: boolean | undefined; userId?: string; sessionId?: string };
export type ExpensePage = { expenses: Expense[]; nextCursor?: string };
export type SettlementPage = { settlements: Settlement[]; nextCursor?: string };
export type ActivityPage = { activity: Activity[]; nextCursor?: string };
export type AuditPage = { audit: AuditEvent[]; nextCursor?: string };
export type GroupExportPage = { version: number; exportedAt: string; group: Group | null; members: GroupMember[]; expenses: Expense[]; settlements: Settlement[]; nextCursor?: { expenses: string | null; settlements: string | null } };
export type ExportPage = { version: number; exportedAt: string; groups: GroupExportPage[]; nextCursor?: string };

export class ClerkSignOutFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClerkSignOutFailure';
  }
}

/** The installed Clerk client exposes UserResource.delete(). Keep the check
 * defensive so an older client can clearly report account-management
 * deferral without claiming that Clerk was deleted. */
export async function deleteClerkUserIfSupported(user: unknown): Promise<'deleted' | 'unsupported'> {
  const candidate = user as { delete?: unknown } | null;
  if (!candidate || typeof candidate.delete !== 'function') return 'unsupported';
  await (candidate.delete as () => Promise<void>)();
  return 'deleted';
}

const PENDING_ACCOUNT_DELETION_KEY = 'billsplit-pending-account-deletion';
export const ACCOUNT_DELETION_EXPECTED_CLERK_USER_ID_HEADER = 'X-BillSplit-Expected-Clerk-User-Id';
type PendingAccountDeletion = { version: 1; phase: 'server-pending' | 'server-deleted' | 'local-cleared' | 'provider-deleted'; clerkUserId: string };
type CompletePendingAccountDeletionOptions = { clearLocal?: () => Promise<void>; clerkEvidence?: ClerkAuthEvidence };
type ClerkDeletionStatus = 'deleted' | 'unsupported' | 'signed-out';
let pendingAccountDeletionRequest: { clerkUserId: string; promise: Promise<{ clerkStatus: ClerkDeletionStatus }> } | undefined;

const readRawPendingAccountDeletion = () => {
  if (typeof localStorage === 'undefined') return undefined;
  try { return localStorage.getItem(PENDING_ACCOUNT_DELETION_KEY) ?? undefined; }
  catch { return undefined; }
};

const readPendingAccountDeletion = (): PendingAccountDeletion | undefined => {
  const raw = readRawPendingAccountDeletion();
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<PendingAccountDeletion> | null;
    return value?.version === 1 && (value.phase === 'server-pending' || value.phase === 'server-deleted' || value.phase === 'local-cleared' || value.phase === 'provider-deleted') && typeof value.clerkUserId === 'string' && value.clerkUserId.trim() !== '' ? value as PendingAccountDeletion : undefined;
  } catch { return undefined; }
};

const requireClerkUserId = (clerkUserId: unknown) => {
  if (typeof clerkUserId !== 'string' || clerkUserId.trim() === '') throw new Error('A loaded Clerk user ID is required before account deletion.');
  return clerkUserId;
};

const writePendingAccountDeletion = (phase: PendingAccountDeletion['phase'], clerkUserId: string) => {
  const id = requireClerkUserId(clerkUserId);
  if (typeof localStorage === 'undefined') throw new Error('Local recovery storage is unavailable. Clerk deletion was not attempted.');
  localStorage.setItem(PENDING_ACCOUNT_DELETION_KEY, JSON.stringify({ version: 1, phase, clerkUserId: id } satisfies PendingAccountDeletion));
};
export const hasPendingAccountDeletion = () => readRawPendingAccountDeletion() !== undefined;
export const hasInvalidPendingAccountDeletion = () => {
  const raw = readRawPendingAccountDeletion();
  return raw !== undefined && readPendingAccountDeletion() === undefined;
};
export const getPendingAccountDeletionPhase = () => readPendingAccountDeletion()?.phase;
export const getPendingAccountDeletionClerkUserId = () => readPendingAccountDeletion()?.clerkUserId;
export const markAccountDeletionPending = (clerkUserId: string) => {
  writePendingAccountDeletion('server-pending', requireClerkUserId(clerkUserId));
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('billsplit-account-deletion-pending'));
};
/** Discard only an unreadable legacy marker; this never performs account cleanup or binds it to an identity. */
export const discardInvalidPendingAccountDeletion = () => {
  if (!hasInvalidPendingAccountDeletion() || typeof localStorage === 'undefined') return false;
  localStorage.removeItem(PENDING_ACCOUNT_DELETION_KEY);
  return true;
};
const clearPendingAccountDeletion = () => { if (typeof localStorage !== 'undefined') localStorage.removeItem(PENDING_ACCOUNT_DELETION_KEY); };

const clerkUserIdFromUser = (user: unknown) => {
  const id = typeof user === 'object' && user !== null && 'id' in user ? (user as { id?: unknown }).id : undefined;
  return typeof id === 'string' && id.trim() !== '' ? id : undefined;
};
const hasAuthoritativeSignedOutEvidence = (evidence: ClerkAuthEvidence | undefined) => Boolean(evidence && evidence.isLoaded && evidence.isSignedIn === false && !evidence.userId);
const currentRecoveryClerkEvidence = (fallback: ClerkAuthEvidence | undefined) => clerkEvidenceKnown && clerkEvidenceAuthoritative ? clerkEvidence : fallback;

/** Finish an account deletion, retrying the server commit before local/provider cleanup. */
export function completePendingAccountDeletion(user: unknown, signOut: (options?: { redirectUrl?: string }) => Promise<unknown>, options: CompletePendingAccountDeletionOptions = {}) {
  if (pendingAccountDeletionRequest) {
    const currentClerkUserId = clerkUserIdFromUser(user);
    const pending = readPendingAccountDeletion();
    if (typeof options.clerkEvidence?.userId === 'string' && options.clerkEvidence.userId !== pendingAccountDeletionRequest.clerkUserId) return Promise.reject(new Error('The provider identity changed while account deletion was pending. Sign in with the original account to continue.'));
    if (!currentClerkUserId) {
      const safeSignedOutRecovery = hasAuthoritativeSignedOutEvidence(options.clerkEvidence) && (!pending || pending.phase === 'server-deleted' || pending.phase === 'local-cleared' || pending.phase === 'provider-deleted');
      if (!safeSignedOutRecovery) return Promise.reject(new Error('A loaded Clerk user ID is required before account deletion recovery can continue.'));
    } else if (currentClerkUserId !== pendingAccountDeletionRequest.clerkUserId) {
      return Promise.reject(new Error('The provider identity changed while account deletion was pending. Sign in with the original account to continue.'));
    }
    return pendingAccountDeletionRequest.promise;
  }
  const initialPending = readPendingAccountDeletion();
  if (!initialPending) {
    if (hasPendingAccountDeletion()) return Promise.reject(new Error('The pending account deletion marker is invalid and was not used. Explicitly discard it before continuing.'));
    return Promise.resolve({ clerkStatus: 'unsupported' as const });
  }
  const request = (async () => {
    let pending = readPendingAccountDeletion();
    if (!pending) throw new Error('The pending account deletion marker is invalid and was not used. Explicitly discard it before continuing.');
    const currentClerkUserId = clerkUserIdFromUser(user);
    const recoveryEvidence = currentRecoveryClerkEvidence(options.clerkEvidence);
    if (typeof currentClerkUserId === 'string' && currentClerkUserId !== pending.clerkUserId) throw new Error('The provider identity changed while account deletion was pending. Sign in with the original account to continue.');
    if (typeof recoveryEvidence?.userId === 'string' && recoveryEvidence.userId !== pending.clerkUserId) throw new Error('The provider identity changed while account deletion was pending. Sign in with the original account to continue.');
    // A provider-deleted marker is already proof that all destructive work
    // completed. It must be recoverable after Clerk has removed the session.
    if (pending.phase === 'provider-deleted') {
      clearPendingAccountDeletion();
      return { clerkStatus: 'deleted' as const };
    }
    const signedOut = hasAuthoritativeSignedOutEvidence(recoveryEvidence) && !user;
    if (pending.phase === 'local-cleared' && signedOut) {
      return { clerkStatus: 'signed-out' as const };
    }
    // The server-pending phase is the only phase that can still delete the
    // BillSplit account. Never retry it on a signed-out or unidentified
    // provider state.
    if (pending.phase === 'server-pending') {
      const matchingClerkUserId = requireClerkUserId(currentClerkUserId);
      if (matchingClerkUserId !== pending.clerkUserId) throw new Error('The provider identity changed while account deletion was pending. Sign in with the original account to continue.');
    } else if (!currentClerkUserId && pending.phase !== 'server-deleted') {
      throw new Error('The provider identity is still restoring. Retry account deletion when Clerk has loaded.');
    }
    if (pending.phase === 'server-pending') {
      // The request may have committed before its response was lost. DELETE
      // /account is deliberately idempotent for the authenticated tombstone,
      // so retrying is the only safe way to turn that uncertainty into a
      // confirmed server phase. No local or provider cleanup can run unless
      // this request succeeds.
      await deleteAccount(pending.clerkUserId);
      pending = readPendingAccountDeletion();
      if (!pending || pending.phase === 'server-pending') throw new Error('BillSplit account deletion is still awaiting server confirmation.');
    }
    if (pending.phase === 'server-deleted') {
      await (options.clearLocal || clearEverythingForLogout)();
      writePendingAccountDeletion('local-cleared', pending.clerkUserId);
      pending = { version: 1, phase: 'local-cleared', clerkUserId: pending.clerkUserId };
    }
    if (pending.phase === 'local-cleared') {
      if (!user) {
        const latestEvidence = currentRecoveryClerkEvidence(options.clerkEvidence);
        if (typeof latestEvidence?.userId === 'string' && latestEvidence.userId !== pending.clerkUserId) throw new Error('The provider identity changed while account deletion was pending. Sign in with the original account to continue.');
        if (hasAuthoritativeSignedOutEvidence(latestEvidence)) {
          // BillSplit and local cleanup are already confirmed, but the
          // provider account is not. Keep the identity-bound marker until the
          // original Clerk account can call UserResource.delete().
          return { clerkStatus: 'signed-out' as const };
        }
        throw new Error('The provider identity is still restoring. Retry account deletion when Clerk has loaded.');
      }
      let clerkStatus: 'deleted' | 'unsupported' = 'unsupported';
      let clerkError: unknown;
      try { clerkStatus = await deleteClerkUserIfSupported(user); } catch (cause) { clerkError = cause; }
      if (clerkStatus === 'deleted' && !clerkError) {
        writePendingAccountDeletion('provider-deleted', pending.clerkUserId);
      } else {
        try { await signOut({ redirectUrl: '/' }); return { clerkStatus }; }
        catch (cause) { throw clerkError || cause; }
      }
    }
    // UserResource.delete normally ends the Clerk session. The marker is
    // cleared only after local cleanup and provider deletion are complete.
    clearPendingAccountDeletion();
    return { clerkStatus: 'deleted' as const };
  })();
  const tracked = request.finally(() => { if (pendingAccountDeletionRequest?.promise === tracked) pendingAccountDeletionRequest = undefined; });
  pendingAccountDeletionRequest = { clerkUserId: initialPending.clerkUserId, promise: tracked };
  return tracked;
}

let authState: AuthState = { required: false };
let connectionState: ConnectionState = { status: typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'checking', reconnectRequired: false };
let authoritativeConnection = false;
let verifiedIdentity: CurrentUser | undefined;
let verifiedClerkUserId: string | undefined;
let clerkUserIdHydrated = false;
let authLifecycle: AuthLifecycle = { status: 'checking' };
let authLifecycleRequest: { key: string; promise: Promise<AuthLifecycle> } | undefined;
let identityRequest: { key: string; promise: Promise<CachedResult<CurrentUser>> } | undefined;
let authBlocked = false;
let authInvalidationGeneration = 0;
// Clerk evidence is a separate monotonic fence from the session/logout
// generation.  Provider callbacks can arrive out of order, so an evidence
// update must invalidate every probe that was started for the previous view.
let clerkEvidenceEpoch = 0;
const clerkProbeControllers = new Set<AbortController>();
let trustRevocationRequest: Promise<boolean> | undefined;
let trustRevocationRequired = false;
let clerkEvidence: ClerkAuthEvidence = { isLoaded: false, isSignedIn: undefined };
let clerkEvidenceKnown = false;
let clerkEvidenceAuthoritative = false;
let clerkRestorationTimer: ReturnType<typeof setTimeout> | undefined;
let clerkRestorationPromise: Promise<AuthLifecycle> | undefined;
let clerkRestorationSettledKey: string | undefined;
const authListeners = new Set<() => void>();
const connectionListeners = new Set<() => void>();
/** Explicit build-time flag used by the local E2E harness; the Worker still gates it on ENVIRONMENT=development. */
export const isDevelopmentAuthBypass = import.meta.env.VITE_DEV_AUTH_BYPASS === 'true';
export const isMeaningfulClerkSessionTransition = (previousSessionKey: string | undefined, currentSessionKey: string | undefined) => Boolean(previousSessionKey && currentSessionKey && previousSessionKey !== currentSessionKey);
export const shouldRevokeForOfflineClerkUser = (providerChanged: boolean, signedIn: boolean, currentClerkUserId: string | undefined, lastVerifiedClerkUserId: string | undefined, hydrated = true) => hydrated && providerChanged && signedIn && Boolean(currentClerkUserId) && currentClerkUserId !== lastVerifiedClerkUserId;
export const shouldReverifyTrustedOffline = (online: boolean, clerkLoaded: boolean, signedIn: boolean, status: AuthLifecycleStatus) => online && clerkLoaded && signedIn && status === 'trusted-offline';
export const getAuthState = () => authState;
export const subscribeAuthState = (listener: () => void) => { authListeners.add(listener); return () => authListeners.delete(listener); };
export const getConnectionState = () => connectionState;
export const subscribeConnectionState = (listener: () => void) => { connectionListeners.add(listener); return () => connectionListeners.delete(listener); };
// A successful arbitrary API request proves transport reachability, but the
// outbox may resume only after the current session has also passed /api/me.
export const isUsableConnection = () => connectionState.status === 'connected' && authoritativeConnection;
export const getAuthLifecycle = () => authLifecycle;
export const subscribeAuthLifecycle = (listener: () => void) => { authListeners.add(listener); return () => authListeners.delete(listener); };
const setAuthLifecycle = (next: AuthLifecycle) => { if (authLifecycle.status === next.status && authLifecycle.error === next.error) return; authLifecycle = next; setResourceAuthLifecycleReady(next.status === 'authenticated' || next.status === 'trusted-offline'); authListeners.forEach((listener) => listener()); };
export const getAuthEpoch = () => authInvalidationGeneration;
export const isAuthEpochCurrent = (epoch: number) => epoch === authInvalidationGeneration;
export const getClerkEvidenceEpoch = () => clerkEvidenceEpoch;
export const isClerkEvidenceEpochCurrent = (epoch: number) => epoch === clerkEvidenceEpoch;
const advanceAuthEpoch = () => { authInvalidationGeneration += 1; identityRequest = undefined; authLifecycleRequest = undefined; return authInvalidationGeneration; };
const cancelClerkProbes = () => { for (const controller of clerkProbeControllers) controller.abort(); clerkProbeControllers.clear(); };
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
  cancelClerkProbes();
  cancelClerkRestorationDeadline();
  clerkEvidenceEpoch += 1;
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
  cancelClerkProbes();
  cancelClerkRestorationDeadline();
  clerkEvidenceEpoch += 1;
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
const setConnectionState = (status: ConnectionStatus, reconnectRequired = status === 'connection-issue') => {
  if (connectionState.status === status && connectionState.reconnectRequired === reconnectRequired) return;
  if (status !== 'connected') authoritativeConnection = false;
  connectionState = { status, reconnectRequired };
  connectionListeners.forEach((listener) => listener());
  if (typeof window !== 'undefined') {
    if (status === 'connection-issue') window.dispatchEvent(new CustomEvent('billsplit-reconnect-required'));
    if (status === 'connected') window.dispatchEvent(new CustomEvent('billsplit-connection-restored'));
  }
};
const signalReconnectRequired = () => setConnectionState('connection-issue');
const clearReconnectRequired = (authoritative = false) => {
  if (authoritative) authoritativeConnection = true;
  setConnectionState('connected', false);
};
const signalOffline = () => setConnectionState('offline', false);
export const signalConnectionChecking = () => {
  setConnectionState('checking', false);
  void requestAuthProbe({ startupFallbackMs: AUTH_BOOTSTRAP_DEADLINE_MS });
};
const isRetryableConnectionError = (error: unknown) => error instanceof ApiError && (
  error.networkFailure || error.code === 'NETWORK_TIMEOUT' || error.code === 'PROTOCOL_ERROR' ||
  error.status === 408 || error.status === 429 || (error.status !== undefined && error.status >= 500)
);

if (typeof window !== 'undefined') {
  window.addEventListener('offline', signalOffline);
  window.addEventListener('online', signalConnectionChecking);
  // Connectivity and foreground hints are inputs to the single coordinator,
  // not independent identity probes.
  window.addEventListener('focus', () => { void requestAuthProbe(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void requestAuthProbe(); });
}

/** Keep Clerk's post-auth destination on this public shell and out of API paths. */
export function sanitizeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/';
  try {
    const url = new URL(value, 'https://billsplit.invalid');
    if (url.origin !== 'https://billsplit.invalid' || /^(?:\/api(?:\/|$)|\/cdn-cgi(?:\/|$)|\/sign-in(?:\/|$)|\/sign-up(?:\/|$))/i.test(url.pathname)) return '/';
    return `${url.pathname}${url.search}${url.hash}` || '/';
  } catch { return '/'; }
}

/** A provider loading state is not signed-out, and is never an auth deadline. */
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

async function apiWithMetaTransport<T>(path: string, init?: RequestInit, expectedAuthEpoch?: number, responseMode: 'json' | 'blob' = 'json'): Promise<ApiResponse<T>> {
  const headers = new Headers(init?.headers);
  headers.set('Content-Type', 'application/json');
  headers.set('X-Requested-With', 'XMLHttpRequest');
  if (import.meta.env.DEV && !headers.has('X-Dev-Email')) headers.set('X-Dev-Email', devEmail());
  let response: Response;
  try { response = await fetch(`/api${path}`, { ...init, headers, credentials: 'same-origin' }); }
  catch (error) {
    if (init?.signal?.aborted) throw error;
    const browserOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
    if (expectedAuthEpoch === undefined || isAuthEpochCurrent(expectedAuthEpoch)) browserOffline ? signalOffline() : signalReconnectRequired();
    throw new ApiError(browserOffline ? 'Network connection unavailable.' : 'Connection issue. Retry when the connection is available.', { networkFailure: true, code: 'NETWORK_ERROR', reconnectRequired: !browserOffline });
  }

  const finalUrl = (() => { try { return new URL(response.url); } catch { return undefined; } })();
  const contentType = response.headers.get('content-type') || '';
  const authResponse = response.status === 401 || (response.status >= 300 && response.status < 400) || response.redirected;
  const unexpectedFormat = !contentType.toLowerCase().includes('json') && response.status !== 204;
  const currentTransportEpoch = expectedAuthEpoch === undefined || isAuthEpochCurrent(expectedAuthEpoch);
  const authoritativePath = path === '/me';
  // This is defense in depth for callers which accidentally probe while Clerk
  // is restoring. Such a response is not evidence of logout and must not
  // advance the auth epoch or revoke private state.
  const authEvidenceRestoring = clerkEvidenceKnown && !clerkEvidence.isLoaded && !isDevelopmentAuthBypass;
  const signedInClerkEvidence = clerkEvidenceKnown && clerkEvidenceAuthoritative && clerkEvidence.isLoaded && clerkEvidence.isSignedIn === true && Boolean(clerkEvidence.sessionId);
  const incompleteSignedInClerkEvidence = clerkEvidenceKnown && isIncompleteSignedInEvidence(clerkEvidence);
  const assertTransportEpoch = () => {
    // A destructive logout deliberately waits for already-dispatched
    // mutations to settle. Let that transport report its server result, while
    // resource/session-generation guards prevent it from repopulating local
    // private state. A response after a new lifecycle has started is rejected.
    if (expectedAuthEpoch !== undefined && !isAuthEpochCurrent(expectedAuthEpoch) && !getSessionLogoutInProgress()) throw new ApiError('The authentication session changed before this response completed.', { status: 401, code: 'AUTH_REQUIRED' });
  };
  if (response.status === 204) {
    if (authResponse) { if (currentTransportEpoch) clearReconnectRequired(authoritativePath); throw new ApiError('Your secure session needs attention. Reconnect and check your sign-in before retrying.', { status: response.status, code: 'AUTH_REQUIRED' }); }
    if (!response.ok) { if (currentTransportEpoch) { if (response.status >= 500) signalReconnectRequired(); else clearReconnectRequired(authoritativePath); } throw new ApiError(`Request failed (${response.status})`, { status: response.status }); }
    assertTransportEpoch();
    clearReconnectRequired(authoritativePath);
     return { data: undefined as T, userId: response.headers.get('X-BillSplit-User-Id') || undefined, clerkUserId: response.headers.get('X-BillSplit-Clerk-User-Id') || undefined, headers: response.headers };
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
    // Authentication responses are still authoritative evidence that the
    // server was reached, even though they require a lifecycle transition.
    if (currentTransportEpoch) clearReconnectRequired(authoritativePath);
    // A request from an earlier Clerk epoch may finish after a new account has
    // started. It must not downgrade the new session.
    const authCode: AuthRequiredCode = responseCode === 'IDENTITY_MISMATCH' || signedInClerkEvidence || incompleteSignedInClerkEvidence ? 'IDENTITY_MISMATCH' : 'AUTH_REQUIRED';
    if (!authEvidenceRestoring && (expectedAuthEpoch === undefined || isAuthEpochCurrent(expectedAuthEpoch))) signalAuthRequired(authCode);
    throw new ApiError('Your secure session needs attention. Reconnect and check your sign-in before retrying.', { status: response.status, code: authCode });
  }
  if (responseMode === 'blob' && response.ok) {
    assertTransportEpoch();
    if (expectedAuthEpoch === undefined || isAuthEpochCurrent(expectedAuthEpoch)) clearReconnectRequired(authoritativePath);
    return { data: await response.blob() as T, userId: response.headers.get('X-BillSplit-User-Id') || undefined, clerkUserId: response.headers.get('X-BillSplit-Clerk-User-Id') || undefined, headers: response.headers };
  }
  if (body === null || unexpectedFormat) {
    if (currentTransportEpoch) signalReconnectRequired();
    if (response.status >= 500) throw new ApiError(`Request failed (${response.status})`, { status: response.status, code: 'SERVER_ERROR' });
    throw new ApiError('The server returned an unexpected response. Reconnect and check your session before retrying.', { status: response.status, code: 'PROTOCOL_ERROR', reconnectRequired: true });
  }
  if (!response.ok) {
    if (currentTransportEpoch) { if (response.status >= 500) signalReconnectRequired(); else clearReconnectRequired(authoritativePath); }
    const errorBody = body as { error?: { code?: string; message?: string } };
    const message = errorBody?.error?.message || `Request failed (${response.status})`;
    const code = errorBody?.error?.code;
    if (response.status === 401 && !authEvidenceRestoring && (code === 'AUTH_INVALID' || code === 'IDENTITY_MISMATCH') && (expectedAuthEpoch === undefined || isAuthEpochCurrent(expectedAuthEpoch))) signalAuthRequired(signedInClerkEvidence || incompleteSignedInClerkEvidence ? 'IDENTITY_MISMATCH' : code);
    throw new ApiError(message, { status: response.status, code });
  }
  assertTransportEpoch();
  if (expectedAuthEpoch === undefined || isAuthEpochCurrent(expectedAuthEpoch)) clearReconnectRequired(authoritativePath);
  return { data: body as T, userId: response.headers.get('X-BillSplit-User-Id') || undefined, clerkUserId: response.headers.get('X-BillSplit-Clerk-User-Id') || undefined };
}

export function apiWithMeta<T>(path: string, init?: RequestInit, expectedAuthEpoch?: number): Promise<ApiResponse<T>> {
  if (path === '/me' && clerkEvidenceKnown && !clerkEvidence.isLoaded && !isDevelopmentAuthBypass) {
    return Promise.reject(new ApiError('Clerk is still restoring; authoritative verification has not started.', { code: 'CLERK_LOADING', networkFailure: true }));
  }
  // Capture the epoch before a mutation waits for the shared lock. A late
  // response from that request must not affect a later Clerk lifecycle.
  const requestEpoch = expectedAuthEpoch ?? getAuthEpoch();
  const method = (init?.method || 'GET').toUpperCase();
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)
    ? runMutation(() => apiWithMetaTransport<T>(path, init, requestEpoch))
    : apiWithMetaTransport<T>(path, init, requestEpoch);
}

export function apiBlobWithMeta(path: string, init?: RequestInit, expectedAuthEpoch?: number): Promise<ApiResponse<Blob>> {
  const requestEpoch = expectedAuthEpoch ?? getAuthEpoch();
  return apiWithMetaTransport<Blob>(path, init, requestEpoch, 'blob');
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
const isGroupAuthorizationLoss = (error: unknown) => error instanceof ApiError && error.status === 404 && error.code === 'GROUP_NOT_FOUND';
const evictRevokedGroup = async (groupId: string, identity?: CacheIdentity) => {
  if (identity?.user.id) await invalidateForMutation.groupAccessRevoked(groupId, identity.user.id, captureSessionGeneration());
};
const evictRevokedGroupForCurrentUser = async (groupId: string) => {
  const userId = getVerifiedUserId();
  if (userId) await invalidateForMutation.groupAccessRevoked(groupId, userId, captureSessionGeneration());
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

const setVerificationUnavailable = (error: unknown = new ApiError('Verification is unavailable. Retry when the connection is available.', { code: 'VERIFICATION_UNAVAILABLE' })) => {
  verifiedIdentity = undefined;
  blockResourceIdentity(error instanceof ApiError ? error : new ApiError('Verification is unavailable.', { code: 'VERIFICATION_UNAVAILABLE' }));
  setAuthLifecycle({ status: 'verification-unavailable', error });
};

export const isIncompleteLoadedSignedInEvidence = (isLoaded: boolean, isSignedIn: boolean | undefined, userId?: string, sessionId?: string) => isLoaded && isSignedIn === true && (!userId || !sessionId);
const isIncompleteSignedInEvidence = (evidence: ClerkAuthEvidence) => clerkEvidenceAuthoritative && isIncompleteLoadedSignedInEvidence(evidence.isLoaded, evidence.isSignedIn, evidence.userId, evidence.sessionId);

const activateTrustedOffline = async (trust: OfflineTrustRecord, expectedEvidenceEpoch = clerkEvidenceEpoch) => {
  if (!isClerkEvidenceEpochCurrent(expectedEvidenceEpoch)) return authLifecycle;
  const user = { id: trust.userId, email: trust.email, personId: trust.personId };
  verifiedIdentity = user;
  verifiedClerkUserId = trust.clerkUserId;
  clerkUserIdHydrated = true;
  setResourceIdentity(user.id);
  seedResource('identity', '', { ...offline(user), authoritative: false }, Date.now(), { offline: true });
  if (typeof navigator !== 'undefined' && navigator.onLine === false) signalOffline();
  else signalReconnectRequired();
  clearAuthRequired();
  setAuthLifecycle({ status: 'trusted-offline' });
  return authLifecycle;
};

const settleClerkRestorationDeadline = async (expectedEvidenceEpoch: number) => {
  if (!isClerkEvidenceEpochCurrent(expectedEvidenceEpoch)) return authLifecycle;
  if ((clerkEvidence.isLoaded && !isIncompleteSignedInEvidence(clerkEvidence)) || isDevelopmentAuthBypass) return authLifecycle;
  if (clerkEvidence.isLoaded) {
    setVerificationUnavailable(new ApiError('Clerk did not provide a complete signed-in identity before the verification deadline.', { code: 'VERIFICATION_TIMEOUT', networkFailure: true }));
    return authLifecycle;
  }
  const trustRead = await boundedTrustRead();
  if (!isClerkEvidenceEpochCurrent(expectedEvidenceEpoch) || clerkEvidence.isLoaded || isDevelopmentAuthBypass) return authLifecycle;
  if (!trustRead.timedOut && trustRead.record && isOfflineTrustUsable(trustRead.record) && !getSessionLogoutInProgress() && !authBlocked) {
    return activateTrustedOffline(trustRead.record, expectedEvidenceEpoch);
  }
  if (!isClerkEvidenceEpochCurrent(expectedEvidenceEpoch)) return authLifecycle;
  setVerificationUnavailable(new ApiError('Clerk did not finish restoring before the verification deadline. Retry verification.', { code: 'VERIFICATION_TIMEOUT', networkFailure: true }));
  return authLifecycle;
};

const clerkEvidenceKey = (evidence: ClerkAuthEvidence) => `${evidence.isLoaded}:${evidence.isSignedIn}:${evidence.userId || ''}:${evidence.sessionId || ''}`;

const startClerkRestorationDeadline = (timeoutMs = AUTH_BOOTSTRAP_DEADLINE_MS, expectedEvidenceEpoch = clerkEvidenceEpoch) => {
  if (clerkRestorationPromise) return clerkRestorationPromise;
  let promise!: Promise<AuthLifecycle>;
  let resolvePromise!: (value: AuthLifecycle) => void;
  promise = new Promise<AuthLifecycle>((resolve) => {
    resolvePromise = resolve;
    clerkRestorationResolve = resolve;
    clerkRestorationTimer = setTimeout(() => {
      clerkRestorationTimer = undefined;
      if (isClerkEvidenceEpochCurrent(expectedEvidenceEpoch)) clerkRestorationSettledKey = clerkEvidenceKey(clerkEvidence);
      void settleClerkRestorationDeadline(expectedEvidenceEpoch).then((result) => {
        if (clerkRestorationPromise !== promise) return;
        if (isClerkEvidenceEpochCurrent(expectedEvidenceEpoch)) clerkRestorationSettledKey = clerkEvidenceKey(clerkEvidence);
        clerkRestorationPromise = undefined;
        clerkRestorationResolve = undefined;
        resolvePromise(result);
      });
    }, timeoutMs);
  });
  clerkRestorationPromise = promise;
  return clerkRestorationPromise;
};

let clerkRestorationResolve: ((value: AuthLifecycle) => void) | undefined;
const cancelClerkRestorationDeadline = () => {
  if (clerkRestorationTimer) { clearTimeout(clerkRestorationTimer); clerkRestorationTimer = undefined; }
  const resolve = clerkRestorationResolve;
  clerkRestorationResolve = undefined;
  clerkRestorationPromise = undefined;
  resolve?.(authLifecycle);
};

/**
 * The only public auth bootstrap entry point used by the app and recovery
 * paths. Clerk restoration gets a real deadline; no network auth probe is
 * permitted before Clerk has supplied its final state.
 */
export function coordinateAuthBootstrap(evidence: ClerkAuthEvidence, options: { networkOnly?: boolean; startupFallbackMs?: number; force?: boolean } = {}) {
  const nextEvidence = { ...evidence, userId: evidence.userId || undefined, sessionId: evidence.sessionId || undefined };
  const evidenceChanged = clerkEvidenceKnown && clerkEvidenceKey(clerkEvidence) !== clerkEvidenceKey(nextEvidence);
  if (evidenceChanged) {
    const previousEvidence = clerkEvidence;
    clerkEvidenceEpoch += 1;
    cancelClerkProbes();
    advanceAuthEpoch();
    cancelClerkRestorationDeadline();
    const meaningfulIdentityChange = previousEvidence.isSignedIn === true && (
      previousEvidence.userId !== nextEvidence.userId ||
      previousEvidence.sessionId !== nextEvidence.sessionId ||
      nextEvidence.isSignedIn !== true
    ) || previousEvidence.isSignedIn === false && nextEvidence.isSignedIn === true;
    if (meaningfulIdentityChange) {
      requestTrustRevocation();
      verifiedIdentity = undefined;
      verifiedClerkUserId = undefined;
      clerkUserIdHydrated = false;
      authBlocked = true;
      blockResourceIdentity(new ApiError('The Clerk account changed. Verify the current account before viewing private data.', { status: 401, code: 'IDENTITY_MISMATCH' }));
      setAuthLifecycle({ status: 'checking' });
    }
  }
  clerkEvidence = nextEvidence;
  clerkEvidenceKnown = true;
  clerkEvidenceAuthoritative = true;
  const evidenceEpoch = clerkEvidenceEpoch;
  const evidenceIncomplete = !clerkEvidence.isLoaded || isIncompleteSignedInEvidence(clerkEvidence);
  if (evidenceIncomplete && !isDevelopmentAuthBypass) {
    if (clerkRestorationSettledKey === clerkEvidenceKey(clerkEvidence) && !options.force) return Promise.resolve(authLifecycle);
    if (options.force) clerkRestorationSettledKey = undefined;
    // A loaded/signed-in provider with incomplete identity evidence must not
    // inherit trusted-offline access. An entirely unloaded provider may still
    // activate a previously verified trusted-device record at the deadline.
    if (isIncompleteSignedInEvidence(clerkEvidence) && authLifecycle.status !== 'checking') setAuthLifecycle({ status: 'checking' });
    return startClerkRestorationDeadline(options.startupFallbackMs, evidenceEpoch);
  }
  clerkRestorationSettledKey = undefined;

  const resolveDeadline = clerkRestorationResolve;
  cancelClerkRestorationDeadline();
  if (isDefinitivelySignedOut(clerkEvidence.isLoaded, clerkEvidence.isSignedIn) && !isDevelopmentAuthBypass) {
    markSignedOut();
    resolveDeadline?.(authLifecycle);
    return Promise.resolve(authLifecycle);
  }
  if (clerkEvidence.isLoaded && clerkEvidence.isSignedIn !== true && !isDevelopmentAuthBypass) {
    setVerificationUnavailable(new ApiError('Clerk loaded without a usable signed-in identity.', { code: 'VERIFICATION_UNAVAILABLE' }));
    resolveDeadline?.(authLifecycle);
    return Promise.resolve(authLifecycle);
  }
  if (!isDevelopmentAuthBypass && !clerkEvidence.userId) {
    setVerificationUnavailable(new ApiError('The current Clerk identity is unavailable for verification.', { code: 'VERIFICATION_UNAVAILABLE' }));
    resolveDeadline?.(authLifecycle);
    return Promise.resolve(authLifecycle);
  }
  const request = initializeAuthLifecycle({
    ...options,
    clerkLoaded: true,
    signedIn: true,
    clerkEvidenceEpoch: evidenceEpoch,
    ...(clerkEvidence.userId ? { clerkUserId: clerkEvidence.userId } : {}),
  });
  void request.then((result) => resolveDeadline?.(result), () => resolveDeadline?.(authLifecycle));
  return request;
}

export const getClerkAuthEvidence = () => clerkEvidence;
export function requestAuthProbe(options: { startupFallbackMs?: number } = {}) {
  if (!clerkEvidenceKnown) return Promise.resolve(authLifecycle);
  if (!clerkEvidence.isLoaded || clerkEvidence.isSignedIn !== true) return coordinateAuthBootstrap(clerkEvidence, options);
  return coordinateAuthBootstrap(clerkEvidence, { ...options, networkOnly: true });
}

class StaleAuthInitializationError extends Error {
  constructor() { super('The authentication lifecycle changed while it was being initialized.'); this.name = 'StaleAuthInitializationError'; }
}
const assertAuthEpoch = (epoch: number) => {
  if (!isAuthEpochCurrent(epoch)) throw new StaleAuthInitializationError();
};
const assertAuthEvidence = (authEpoch: number, evidenceEpoch: number) => {
  assertAuthEpoch(authEpoch);
  if (!isClerkEvidenceEpochCurrent(evidenceEpoch)) throw new StaleAuthInitializationError();
};

export async function getMe(options: { networkOnly?: boolean; signal?: AbortSignal; clerkUserId?: string; expectedUserId?: string; expectedAuthEpoch?: number; expectedClerkEvidenceEpoch?: number; startupFallbackMs?: number } = {}): Promise<CachedResult<CurrentUser>> {
  if (clerkEvidenceKnown && !clerkEvidence.isLoaded && !isDevelopmentAuthBypass) {
    throw new ApiError('Clerk is still restoring; authoritative verification has not started.', { code: 'CLERK_LOADING', networkFailure: true });
  }
  const authGeneration = options.expectedAuthEpoch ?? authInvalidationGeneration;
  const evidenceGeneration = options.expectedClerkEvidenceEpoch ?? clerkEvidenceEpoch;
  const key = `${authGeneration}:${options.clerkUserId || ''}:${options.networkOnly === true}:${options.signal ? 'signal' : 'shared'}`;
  if (identityRequest && identityRequest.key === key) return identityRequest.promise;
  if ((isMutationBarrierActive() || getSessionLogoutInProgress()) && (authLifecycle.status === 'authenticated' || authLifecycle.status === 'trusted-offline')) throw new ApiError('Logout is in progress. Try again after signing in.', { status: 401, code: 'AUTH_REQUIRED' });
  const generation = captureSessionGeneration();
  const request = (async () => {
    const controller = new AbortController();
    clerkProbeControllers.add(controller);
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
      assertAuthEvidence(authGeneration, evidenceGeneration);
      transport = apiWithMeta<CurrentUser>('/me', { signal }, authGeneration);
      const result = await deadline(transport, options.startupFallbackMs ?? AUTH_BOOTSTRAP_DEADLINE_MS, () => {
        throw new ApiError('Verification is taking too long. Check your connection and retry.', { networkFailure: true, code: 'NETWORK_TIMEOUT' });
      });
      assertAuthEvidence(authGeneration, evidenceGeneration);
      assertRequestGeneration(generation);
      const user = result.data;
      // /api/me carries both sides of the server-authenticated identity. A
      // client supplied Clerk ID is never sufficient to create or refresh a
      // trusted-device record.
      if ((result.userId && result.userId !== user.id) || (options.expectedUserId && user.id !== options.expectedUserId)) {
        if (authGeneration === authInvalidationGeneration && isClerkEvidenceEpochCurrent(evidenceGeneration)) signalAuthRequired('IDENTITY_MISMATCH');
        throw new ApiError('The verified identity changed; sign in again before retrying.', { status: 401, code: 'IDENTITY_MISMATCH' });
      }
      if (options.clerkUserId && result.clerkUserId !== options.clerkUserId) {
        if (authGeneration === authInvalidationGeneration && isClerkEvidenceEpochCurrent(evidenceGeneration)) signalAuthRequired('IDENTITY_MISMATCH');
        throw new ApiError('The server could not prove the current Clerk identity.', { status: 401, code: 'IDENTITY_MISMATCH' });
      }
      assertAuthEvidence(authGeneration, evidenceGeneration);
      assertRequestGeneration(generation);
      // This is the sole trust write. A timeout or CAS miss is non-fatal to
      // the authoritative session, but it grants no durable offline trust.
      if (options.clerkUserId && result.clerkUserId === options.clerkUserId && result.userId === user.id && (!options.expectedUserId || options.expectedUserId === user.id)) {
        if (!expectedTrustRead.timedOut) await boundedTrustWrite(saveOfflineTrust({ userId: user.id, email: user.email, personId: user.personId, clerkUserId: options.clerkUserId!, verifiedAt: new Date().toISOString() }, generation, () => authGeneration === authInvalidationGeneration && isClerkEvidenceEpochCurrent(evidenceGeneration), expectedTrustRead.record?.revision ?? 0));
        assertAuthEvidence(authGeneration, evidenceGeneration);
        verifiedClerkUserId = options.clerkUserId;
        clerkUserIdHydrated = true;
      }
      assertAuthEvidence(authGeneration, evidenceGeneration);
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
      // A timeout can win the bounded race before fetch itself rejects, so
      // make the connection decision here as well as in the transport catch.
      const browserOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
      const cachedRead = await boundedTrustRead();
      const cached = cachedRead.timedOut ? undefined : cachedRead.record;
      if (authGeneration !== authInvalidationGeneration || !isClerkEvidenceEpochCurrent(evidenceGeneration) || getSessionLogoutInProgress() || authBlocked || !isSessionGenerationCurrent(generation)) throw error;
      const offlineCacheAllowed = cached && isOfflineTrustUsable(cached) && cachedTrustMatches(options.clerkUserId, cached);
      if (offlineCacheAllowed) {
        if (browserOffline) signalOffline(); else signalReconnectRequired();
        const result = { ...offline({ id: cached.userId, email: cached.email, personId: cached.personId }), authoritative: false };
        assertAuthEvidence(authGeneration, evidenceGeneration);
        verifiedIdentity = { id: cached.userId, email: cached.email, personId: cached.personId };
        verifiedClerkUserId = cached.clerkUserId;
        clerkUserIdHydrated = true;
        setResourceIdentity(cached.userId);
        seedResource('identity', '', result, Date.now(), { offline: true });
        setAuthLifecycle({ status: 'trusted-offline' });
        return result;
      }
      if (browserOffline) signalOffline(); else signalReconnectRequired();
      throw error;
    } finally {
      // Abort is cleanup only. The raced promise remains observed so a late
      // completion cannot become an unhandled rejection or a state decision.
      controller.abort();
      options.signal?.removeEventListener('abort', onCallerAbort);
      clerkProbeControllers.delete(controller);
      void transport?.catch(() => undefined);
    }
  })();
  identityRequest = { key, promise: request };
  try { return await request; } finally { if (identityRequest?.promise === request) identityRequest = undefined; }
}

export async function initializeAuthLifecycle(options: { networkOnly?: boolean; clerkUserId?: string; startupFallbackMs?: number; clerkLoaded?: boolean; signedIn?: boolean; clerkEvidenceEpoch?: number } = {}): Promise<AuthLifecycle> {
  // Keep this lower-level helper safe for recovery callers too. Direct local
  // test/dev callers may supply a Clerk ID, but production callers with no
  // provider evidence must go through coordinateAuthBootstrap.
  if (options.clerkUserId && options.clerkLoaded !== false && options.clerkEvidenceEpoch === undefined && (!clerkEvidenceKnown || clerkEvidence.isLoaded)) {
    // Backwards-compatible helper use in local tests; production bootstrap
    // always establishes this evidence through coordinateAuthBootstrap.
    // Direct helper callers predate the provider coordinator. Give those
    // calls a complete synthetic evidence tuple; real Clerk evidence always
    // comes through coordinateAuthBootstrap and must include sessionId.
    clerkEvidence = { isLoaded: true, isSignedIn: true, userId: options.clerkUserId, sessionId: `direct:${options.clerkUserId}` };
    clerkEvidenceKnown = true;
    clerkEvidenceAuthoritative = false;
  }
  const providerRestoring = !isDevelopmentAuthBypass && (options.clerkLoaded === false || (clerkEvidenceKnown && !clerkEvidence.isLoaded));
  if (providerRestoring) {
    if (clerkEvidenceKnown && clerkRestorationSettledKey === clerkEvidenceKey(clerkEvidence)) return authLifecycle;
    return startClerkRestorationDeadline(options.startupFallbackMs, options.clerkEvidenceEpoch ?? clerkEvidenceEpoch);
  }
  if (!isDevelopmentAuthBypass && options.clerkLoaded === true && options.signedIn === false) { markSignedOut(); return authLifecycle; }
  // This is deliberately captured before any await. Clerk transitions and
  // revocation advance the epoch, invalidating every already-running init.
  let authEpoch = getAuthEpoch();
  const evidenceEpoch = options.clerkEvidenceEpoch ?? clerkEvidenceEpoch;
  // A foreground hint and the React Clerk effect must share one probe. The
  // networkOnly bit changes the optimization, not the request identity.
  const key = `${authEpoch}:${options.clerkUserId || ''}`;
  if (authLifecycleRequest?.key === key) return authLifecycleRequest.promise;
  const browserOnline = typeof navigator === 'undefined' || navigator.onLine !== false;
  // `checking` is entered by the online transition. It must never take the
  // durable trust record fast path: only an authoritative /api/me response
  // may resolve this probe back to connected/authenticated.
  const forceReverify = options.networkOnly === true || (connectionState.status === 'checking' && browserOnline);
  const previousUsableLifecycle = authLifecycle.status === 'authenticated' || authLifecycle.status === 'trusted-offline' ? authLifecycle.status : undefined;
  const currentSessionMatches = authLifecycle.status === 'authenticated' && verifiedIdentity && (options.clerkUserId === undefined || verifiedClerkUserId === options.clerkUserId);
  if ((authLifecycle.status === 'authenticated' || (authLifecycle.status === 'trusted-offline' && !browserOnline)) && !forceReverify && (options.clerkUserId === undefined || verifiedClerkUserId === options.clerkUserId)) {
    // An expired record must not block an already authoritative session from
    // refreshing its durable trust record. IDB failure is non-fatal here: the
    // live verified session and its outbox remain usable online.
    const trustRead = await boundedTrustRead();
    const trust = trustRead.timedOut ? undefined : trustRead.record;
    assertAuthEvidence(authEpoch, evidenceEpoch);
    if (trust && isOfflineTrustUsable(trust)) return authLifecycle;
    if (!options.clerkUserId || !verifiedIdentity) return authLifecycle;
  }
  assertAuthEvidence(authEpoch, evidenceEpoch);
  if (!currentSessionMatches) setAuthLifecycle({ status: 'checking' });
  const request = (async () => {
    try {
      let trustRead = await boundedTrustRead();
      let trust = trustRead.timedOut ? undefined : trustRead.record;
      assertAuthEvidence(authEpoch, evidenceEpoch);
      if (options.clerkUserId && trust?.state === 'active' && trust.clerkUserId !== options.clerkUserId) {
        // Revoke before issuing /me for the new Clerk account. A stale old
        // record can therefore never be used if that request is unavailable.
        verifiedIdentity = undefined;
        requestTrustRevocation();
        authEpoch = advanceAuthEpoch();
        if (!await ensureTrustRevoked()) {
          assertAuthEvidence(authEpoch, evidenceEpoch);
          setAuthLifecycle({ status: 'verification-unavailable', error: new ApiError('The previous account is still being cleared. Retry verification.', { code: 'IDENTITY_MISMATCH' }) });
          return authLifecycle;
        }
        assertAuthEvidence(authEpoch, evidenceEpoch);
        trustRead = await boundedTrustRead();
        trust = trustRead.timedOut ? undefined : trustRead.record;
        assertAuthEvidence(authEpoch, evidenceEpoch);
      }
      if (trustRevocationRequest || trustRevocationRequired) {
        if (!await ensureTrustRevoked()) {
          assertAuthEvidence(authEpoch, evidenceEpoch);
          setAuthLifecycle({ status: 'verification-unavailable', error: new ApiError('Private data is still being cleared. Retry verification.', { code: 'IDENTITY_MISMATCH' }) });
          return authLifecycle;
        }
        assertAuthEvidence(authEpoch, evidenceEpoch);
        // The read which preceded revocation is stale by definition. Never
        // use it for offline activation after a session transition.
        trustRead = await boundedTrustRead();
        trust = trustRead.timedOut ? undefined : trustRead.record;
        assertAuthEvidence(authEpoch, evidenceEpoch);
      }
      // Online/unknown Clerk startup must first try the authoritative path.
      // A complete, active record is only the bounded-unavailability fallback.
      if (!browserOnline && !forceReverify && !getSessionLogoutInProgress() && !authBlocked && trust && isOfflineTrustUsable(trust) && cachedTrustMatches(options.clerkUserId, trust)) {
        signalOffline();
        assertAuthEvidence(authEpoch, evidenceEpoch);
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
      await getMe({ networkOnly: forceReverify, clerkUserId: options.clerkUserId, expectedUserId, expectedAuthEpoch: authEpoch, expectedClerkEvidenceEpoch: evidenceEpoch, startupFallbackMs: options.startupFallbackMs });
      assertAuthEvidence(authEpoch, evidenceEpoch);
      return authLifecycle;
    } catch (error) {
      // A stale init is intentionally silent. The newer lifecycle owns all
      // visible state and resource decisions.
      if (!isAuthEpochCurrent(authEpoch) || !isClerkEvidenceEpochCurrent(evidenceEpoch) || error instanceof StaleAuthInitializationError) return authLifecycle;
      if (error instanceof ApiError && error.code === 'IDENTITY_MISMATCH') {
        assertAuthEvidence(authEpoch, evidenceEpoch);
        requestTrustRevocation();
        setVerificationUnavailable(error);
      } else if (error instanceof ApiError && (error.status === 401 || error.code === 'AUTH_REQUIRED' || error.code === 'AUTH_INVALID') && options.clerkLoaded !== true) {
        assertAuthEvidence(authEpoch, evidenceEpoch);
        setAuthLifecycle({ status: 'unauthenticated' });
      } else if (isRetryableConnectionError(error) && error instanceof ApiError && error.networkFailure && connectionState.status === 'checking' && (currentSessionMatches || previousUsableLifecycle)) {
        // A failed foreground revalidation must settle to a bounded,
        // explicitly offline-safe state when the active trust record exists.
        const trustRead = await boundedTrustRead();
        const trust = trustRead.timedOut ? undefined : trustRead.record;
        assertAuthEvidence(authEpoch, evidenceEpoch);
        if (trust && isOfflineTrustUsable(trust) && cachedTrustMatches(options.clerkUserId, trust)) await activateTrustedOffline(trust, evidenceEpoch);
        else setVerificationUnavailable(error);
      } else if (isRetryableConnectionError(error) && (currentSessionMatches || previousUsableLifecycle)) {
        // Expiry blocks a fresh offline bootstrap, but never strands a live
        // authoritative session or its queue while a refresh is unavailable.
        assertAuthEvidence(authEpoch, evidenceEpoch);
        if (browserOnline) signalReconnectRequired(); else signalOffline();
        const trustRead = await boundedTrustRead();
        assertAuthEvidence(authEpoch, evidenceEpoch);
        const trustedFallback = !trustRead.timedOut && trustRead.record && isOfflineTrustUsable(trustRead.record) && cachedTrustMatches(options.clerkUserId, trustRead.record);
        if (previousUsableLifecycle && trustedFallback && authLifecycle.status !== previousUsableLifecycle) setAuthLifecycle({ status: previousUsableLifecycle });
        else if (!trustedFallback) setVerificationUnavailable(error);
      } else if (authLifecycle.status !== 'unauthenticated') {
         assertAuthEvidence(authEpoch, evidenceEpoch);
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

export async function getGroup(id: string, signal?: AbortSignal): Promise<CachedResult<{ group: Group; members: GroupMember[]; historicalParticipants: HistoricalParticipant[] }>> {
  const generation = captureSessionGeneration();
  const identity = await requireIdentityForCache(signal);
  try {
    const result = await apiWithMeta<{ group: Group; members: GroupMember[]; historicalParticipants?: HistoricalParticipant[] }>(`/groups/${id}`, { signal });
    assertRequestGeneration(generation); assertResponseIdentity(result.userId, identity);
    const data = { ...result.data, historicalParticipants: result.data.historicalParticipants || result.data.members.map((member) => ({ ...member, status: member.removedAt ? 'removed' as const : 'active' as const })) };
    if (result.userId) await cacheWrite(() => updateGroupSnapshot(result.userId!, id, { group: data.group, members: data.members, historicalParticipants: data.historicalParticipants }, generation));
    return data;
  } catch (error) {
    assertRequestGeneration(generation);
    if (isGroupAuthorizationLoss(error)) { await evictRevokedGroup(id, identity); throw error; }
    if (!isNetwork(error) || !identity) throw error;
    const cached = await cacheRead(() => readGroupSnapshot(identity.user.id, id));
    if (cached?.group && cached.members) return offline({ group: cached.group, members: cached.members, historicalParticipants: cached.members.map((member) => ({ ...member, status: member.removedAt ? 'removed' as const : 'active' as const })) });
    throw error;
  }
}

export async function getHistoricalParticipants(groupId: string, signal?: AbortSignal): Promise<{ participants: HistoricalParticipant[] }> {
  try { return (await apiWithMeta<{ participants: HistoricalParticipant[] }>(`/groups/${groupId}/historical-participants`, { signal })).data; }
  catch (error) { if (isGroupAuthorizationLoss(error)) await evictRevokedGroupForCurrentUser(groupId); throw error; }
}

export async function updateGroup(id: string, input: { name: string; currency: Group['currency'] }) {
  return api<{ group: Group }>(`/groups/${id}`, { method: 'PUT', body: JSON.stringify(input) });
}

export async function deleteGroup(id: string) {
  return api<void>(`/groups/${id}`, { method: 'DELETE' });
}

export async function deleteAccount(clerkUserId: string) {
  const currentClerkUserId = requireClerkUserId(clerkUserId);
  const pending = readPendingAccountDeletion();
  if (hasPendingAccountDeletion() && !pending) throw new Error('The pending account deletion marker is invalid and was not used. Explicitly discard it before starting a new deletion.');
  // This write is deliberately before the destructive request. If storage is
  // unavailable, no server mutation is dispatched and no provider cleanup can
  // be reached by the marker-driven recovery path.
  if (pending && pending.clerkUserId !== currentClerkUserId) throw new Error('The provider identity changed while account deletion was pending. Sign in with the original account to continue.');
  if (pending && pending.phase !== 'server-pending') return;
  if (!pending) markAccountDeletionPending(currentClerkUserId);
  await api<void>('/account', { method: 'DELETE', body: JSON.stringify({ confirmation: 'DELETE MY ACCOUNT' }), headers: { [ACCOUNT_DELETION_EXPECTED_CLERK_USER_ID_HEADER]: currentClerkUserId } });
  // A lost response can leave this phase behind. The server DELETE is
  // idempotent for the authenticated tombstoned identity, so retrying this
  // phase is safe until this marker update succeeds.
  writePendingAccountDeletion('server-deleted', currentClerkUserId);
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('billsplit-account-deletion-pending'));
}

export async function getPendingInvitations(signal?: AbortSignal): Promise<{ invitations: GroupInvitation[] }> {
  return (await apiWithMeta<{ invitations: GroupInvitation[] }>('/invitations', { signal })).data;
}

export const getCurrentUserInvitations = getPendingInvitations;
export const getInvitations = getPendingInvitations;

export async function getOwnerInvitations(groupId: string, signal?: AbortSignal): Promise<{ invitations: GroupInvitation[] }> {
  try { return (await apiWithMeta<{ invitations: GroupInvitation[] }>(`/groups/${groupId}/invitations`, { signal })).data; }
  catch (error) { if (isGroupAuthorizationLoss(error)) await evictRevokedGroupForCurrentUser(groupId); throw error; }
}
export const getGroupInvitations = getOwnerInvitations;

export async function createGroupInvitation(groupId: string, email: string) {
  return api<{ invitation: GroupInvitation }>(`/groups/${groupId}/invitations`, { method: 'POST', body: JSON.stringify({ email }) });
}
export const createInvitation = createGroupInvitation;

export async function revokeGroupInvitation(groupId: string, invitationId: string) {
  return api<void>(`/groups/${groupId}/invitations/${invitationId}`, { method: 'DELETE' });
}
export const revokeInvitation = revokeGroupInvitation;

export async function acceptInvitation(invitationId: string) {
  return api<{ invitation: GroupInvitation }>(`/invitations/${invitationId}/accept`, { method: 'POST' });
}

export async function rejectInvitation(invitationId: string) {
  return api<void>(`/invitations/${invitationId}/reject`, { method: 'POST' });
}

export async function removeGroupMember(groupId: string, personId: string) {
  return api<void>(`/groups/${groupId}/members/${personId}`, { method: 'DELETE' });
}
export const removeMember = removeGroupMember;

export async function transferGroupOwnership(groupId: string, personId: string) {
  return api<void>(`/groups/${groupId}/transfer-ownership`, { method: 'POST', body: JSON.stringify({ person_id: personId }) });
}

export async function leaveGroup(groupId: string) {
  return api<void>(`/groups/${groupId}/leave`, { method: 'POST' });
}
export const leaveGroupMember = leaveGroup;

const pageParams = (options: { limit?: number; cursor?: string } = {}) => {
  const params = new URLSearchParams();
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  if (options.cursor) params.set('cursor', options.cursor);
  return params.toString();
};

export type ExpensePageOptions = ExpenseFilters & { limit?: number; cursor?: string };
export async function getExpensePage(groupId: string, options: ExpensePageOptions = {}, signal?: AbortSignal): Promise<ExpensePage> {
  const query = new URLSearchParams(pageParams({ limit: options.limit ?? 50, cursor: options.cursor }));
  for (const [key, value] of expenseFilterQuery(options).entries()) query.set(key, value);
  try { return (await apiWithMeta<ExpensePage>(`/groups/${groupId}/expenses?${query}`, { signal })).data; }
  catch (error) { if (isGroupAuthorizationLoss(error)) await evictRevokedGroupForCurrentUser(groupId); throw error; }
}

export async function getExpenses(id: string, signal?: AbortSignal, filters: ExpenseFilters = {}): Promise<CachedResult<ExpensePage>> {
  const generation = captureSessionGeneration();
  const authEpoch = getAuthEpoch();
  const identity = await requireIdentityForCache(signal);
  try {
     const options = { limit: 50, ...filters };
     const query = new URLSearchParams(pageParams(options));
     for (const [key, value] of expenseFilterQuery(filters).entries()) query.set(key, value);
     const result = await apiWithMeta<ExpensePage>(`/groups/${id}/expenses?${query}`, { signal });
    assertRequestGeneration(generation); assertResponseIdentity(result.userId, identity);
     if (result.userId && !hasExpenseFilters(filters)) { await cacheWrite(() => updateGroupSnapshot(result.userId!, id, { expenses: result.data.expenses }, generation)); const reconciled = await cacheRead(() => reconcileOutboxItems(result.userId!, id, result.data.expenses, generation, authEpoch)); if (reconciled) { await invalidateForMutation.expenseChanged(id, undefined, result.userId, generation); if (typeof window !== 'undefined') window.dispatchEvent(new Event('billsplit-outbox-changed')); } }
    return result.data;
  } catch (error) {
    assertRequestGeneration(generation);
    if (isGroupAuthorizationLoss(error)) { await evictRevokedGroup(id, identity); throw error; }
    if (!isNetwork(error) || !identity) throw error;
    if (hasExpenseFilters(filters)) throw error;
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
    if (isGroupAuthorizationLoss(error)) { await evictRevokedGroup(id, identity); throw error; }
    if (!isNetwork(error) || !identity) throw error;
    const cached = await cacheRead(() => readGroupSnapshot(identity.user.id, id));
    if (cached?.balances) return offline({ balances: cached.balances });
    throw error;
  }
}

export async function getSettlementPage(groupId: string, options: { limit?: number; cursor?: string } = {}, signal?: AbortSignal): Promise<SettlementPage> {
  const query = pageParams({ limit: options.limit ?? 50, cursor: options.cursor });
  try { return (await apiWithMeta<SettlementPage>(`/groups/${groupId}/settlements?${query}`, { signal })).data; }
  catch (error) { if (isGroupAuthorizationLoss(error)) await evictRevokedGroupForCurrentUser(groupId); throw error; }
}

export async function getSettlements(id: string, signal?: AbortSignal): Promise<CachedResult<SettlementPage>> {
  const generation = captureSessionGeneration();
  const identity = await requireIdentityForCache(signal);
  try {
     const result = await apiWithMeta<SettlementPage>(`/groups/${id}/settlements?limit=50`, { signal });
    assertRequestGeneration(generation); assertResponseIdentity(result.userId, identity);
    if (result.userId) await cacheWrite(() => updateGroupSnapshot(result.userId!, id, { settlements: result.data.settlements }, generation));
    return result.data;
  } catch (error) {
    assertRequestGeneration(generation);
    if (isGroupAuthorizationLoss(error)) { await evictRevokedGroup(id, identity); throw error; }
    if (!isNetwork(error) || !identity) throw error;
    const cached = await cacheRead(() => readGroupSnapshot(identity.user.id, id));
    if (cached?.settlements) return offline({ settlements: cached.settlements });
    throw error;
  }
}

/** Schedules are intentionally online-only; unlike new expenses they never enter the outbox. */
export type ScheduledExpensePage = { scheduledExpenses: ScheduledExpense[]; nextCursor?: string };
export async function getScheduledExpensePage(id: string, options: { limit?: number; cursor?: string } = {}, signal?: AbortSignal): Promise<ScheduledExpensePage> {
  const params = pageParams({ limit: options.limit ?? 100, cursor: options.cursor });
  try { return (await apiWithMeta<ScheduledExpensePage>(`/groups/${id}/scheduled-expenses?${params}`, { signal })).data; }
  catch (error) { if (isGroupAuthorizationLoss(error)) await evictRevokedGroupForCurrentUser(id); throw error; }
}
/** The initial request is deliberately one bounded page; the UI owns the
 * cursor and exposes explicit Load more rather than building an unbounded
 * client-side list during a render. */
export async function getScheduledExpenses(id: string, signal?: AbortSignal): Promise<CachedResult<ScheduledExpensePage>> {
  return getScheduledExpensePage(id, {}, signal);
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
    if (isGroupAuthorizationLoss(error)) {
      const cached = identity ? await cacheRead(() => readExpenseDetails(identity.user.id, id)) : undefined;
      if (cached?.expense.groupId) await evictRevokedGroup(cached.expense.groupId, identity);
      throw error;
    }
    if (!isNetwork(error) || !identity) throw error;
    const cached = await cacheRead(() => readExpenseDetails(identity.user.id, id));
    if (cached) return offline({ expense: cached.expense, history: cached.history });
    throw error;
  }
}

export async function getSettlementDetails(id: string, signal?: AbortSignal): Promise<{ settlement: Settlement; history: Array<{ id: string; revision: number; createdAt: string }> }> {
  return (await apiWithMeta<{ settlement: Settlement; history: Array<{ id: string; revision: number; createdAt: string }> }>(`/settlements/${id}`, { signal })).data;
}

export async function restoreExpense(id: string, version: number) {
  return api<{ expense: Expense }>(`/expenses/${id}/restore`, { method: 'POST', body: JSON.stringify({ version }) });
}

export async function restoreSettlement(id: string, version: number) {
  return api<{ settlement: Settlement }>(`/settlements/${id}/restore`, { method: 'POST', body: JSON.stringify({ version }) });
}

export async function updateSettlement(id: string, input: SettlementInput) {
  return api<{ settlement: Settlement }>(`/settlements/${id}`, { method: 'PUT', body: JSON.stringify(input) });
}

export async function getAuditPage(groupId: string, options: { limit?: number; cursor?: string } = {}, signal?: AbortSignal): Promise<AuditPage> {
  const query = pageParams({ limit: options.limit ?? 50, cursor: options.cursor });
  try { return (await apiWithMeta<AuditPage>(`/groups/${groupId}/audit?${query}`, { signal })).data; }
  catch (error) { if (isGroupAuthorizationLoss(error)) await evictRevokedGroupForCurrentUser(groupId); throw error; }
}

export async function getActivityPage(id?: string, options: { limit?: number; cursor?: string } = {}, signal?: AbortSignal): Promise<ActivityPage> {
  const query = pageParams({ limit: options.limit ?? 50, cursor: options.cursor });
  try {
    const result = (await apiWithMeta<ActivityPage>(`${id ? `/activity?group=${encodeURIComponent(id)}&` : '/activity?'}${query}`, { signal })).data;
    return { ...result, activity: normalizeActivity(result.activity) };
  } catch (error) { if (id && isGroupAuthorizationLoss(error)) await evictRevokedGroupForCurrentUser(id); throw error; }
}

export async function getActivity(id?: string, signal?: AbortSignal): Promise<CachedResult<ActivityPage>> {
  const generation = captureSessionGeneration();
  const identity = await requireIdentityForCache(signal);
  try {
    const requestMutationGeneration = identity ? (await cacheRead(() => readMutationGeneration(identity.user.id)) ?? 0) : 0;
     const result = await apiWithMeta<ActivityPage>(id ? `/activity?group=${encodeURIComponent(id)}&limit=50` : '/activity?limit=50', { signal });
    assertRequestGeneration(generation); assertResponseIdentity(result.userId, identity);
     const data = { activity: normalizeActivity(result.data.activity), nextCursor: result.data.nextCursor };
    if (result.userId) await cacheWrite(() => saveActivity({ userId: result.userId!, groupId: id || 'all', activity: data.activity, fetchedAt: new Date().toISOString() }, generation, requestMutationGeneration));
    return data;
  } catch (error) {
    assertRequestGeneration(generation);
    if (id && isGroupAuthorizationLoss(error)) { await evictRevokedGroup(id, identity); throw error; }
    if (!isNetwork(error) || !identity) throw error;
    const cached = await cacheRead(() => readActivity(identity.user.id, id || 'all'));
    if (cached) return offline({ activity: cached.activity });
    throw error;
  }
}

export async function getGroupExportPage(groupId: string, options: { limit?: number; expenseCursor?: string | null; settlementCursor?: string | null } = {}, signal?: AbortSignal): Promise<GroupExportPage> {
  const params = new URLSearchParams({ limit: String(options.limit ?? 50) });
  if (options.expenseCursor === null) params.set('expenseDone', '1');
  else if (options.expenseCursor) params.set('expenseCursor', options.expenseCursor);
  if (options.settlementCursor === null) params.set('settlementDone', '1');
  else if (options.settlementCursor) params.set('settlementCursor', options.settlementCursor);
  try { return (await apiWithMeta<GroupExportPage>(`/groups/${groupId}/export.json?${params}`, { signal })).data; }
  catch (error) { if (isGroupAuthorizationLoss(error)) await evictRevokedGroupForCurrentUser(groupId); throw error; }
}

export async function getExportPage(options: { limit?: number; groupCursor?: string } = {}, signal?: AbortSignal): Promise<ExportPage> {
  const params = new URLSearchParams({ limit: String(options.limit ?? 2) });
  if (options.groupCursor) params.set('groupCursor', options.groupCursor);
  return (await apiWithMeta<ExportPage>(`/export.json?${params}`, { signal })).data;
}

export type CsvExportPage = { blob: Blob; nextCursor?: string };
export async function getGroupCsvExportPage(groupId: string, options: { limit?: number; cursor?: string } = {}, signal?: AbortSignal): Promise<CsvExportPage> {
  const params = new URLSearchParams({ limit: String(options.limit ?? 100) });
  if (options.cursor) params.set('cursor', options.cursor);
  const headers = new Headers({ Accept: 'text/csv' });
  try {
    const response = await apiBlobWithMeta(`/groups/${groupId}/export.csv?${params}`, { headers, signal });
    return { blob: response.data, nextCursor: response.headers?.get('X-Next-Cursor') || undefined };
  } catch (error) { if (isGroupAuthorizationLoss(error)) await evictRevokedGroupForCurrentUser(groupId); throw error; }
}

export async function getGroupSettlementCsvExportPage(groupId: string, options: { limit?: number; cursor?: string } = {}, signal?: AbortSignal): Promise<CsvExportPage> {
  const params = new URLSearchParams({ limit: String(options.limit ?? 100) });
  if (options.cursor) params.set('cursor', options.cursor);
  try {
    const response = await apiBlobWithMeta(`/groups/${groupId}/settlements.csv?${params}`, { headers: new Headers({ Accept: 'text/csv' }), signal });
    return { blob: response.data, nextCursor: response.headers?.get('X-Next-Cursor') || undefined };
  } catch (error) { if (isGroupAuthorizationLoss(error)) await evictRevokedGroupForCurrentUser(groupId); throw error; }
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

export async function getCategorySuggestion(description: string, signal?: AbortSignal): Promise<{ category: string | null }> {
  return api<{ category: string | null }>('/category-suggestion', { method: 'POST', body: JSON.stringify({ description }), signal });
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
  return cached?.group && cached.members ? { data: { group: cached.group, members: cached.members, historicalParticipants: cached.historicalParticipants || cached.members.map((member) => ({ ...member, status: member.removedAt ? 'removed' as const : 'active' as const })) }, fetchedAt: cacheTimestamp(cached.cachedAtByResource?.group || cached.cachedAt), offline: true } : undefined;
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
