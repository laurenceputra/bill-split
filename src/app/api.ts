import type { Activity, AuditEvent, Expense, Group, GroupInvitation, GroupMember, GroupSplitDefault, GroupResponse, HistoricalParticipant, ScheduledExpense, Settlement, Balances, Transaction, NotificationPreferences, NotificationStatus } from '../shared/types';
import type { GroupSplitDefaultInput, ScheduledExpenseInput, SettlementInput, PushSubscriptionInput } from '../shared/schemas';
import { clearAllPrivateData, clearCachedData, isOfflineTrustUsable, normalizeActivity, readActivity, readCategories, readExpenseDetails, readGlobalTransactions, readGroupSnapshot, readGroups, readOfflineTrust, readMutationGeneration, reconcileOutboxItems, revokeOfflineTrust, saveGlobalTransactions, saveOfflineTrust, updateGroupSnapshotIfGenerationMatches, type GroupSnapshot, type OfflineTrustRecord } from './idb';
import { allowIdentityVerification, blockResourceIdentity, getResourceSnapshot, invalidateForMutation, resetResourceIdentity, resourceKeys, seedResource, setResourceAuthLifecycleReady, setResourceIdentity } from './resource-cache';
import { quiesceOutboxForLogout, resumeOutboxAfterFailedLogout } from './logout-coordination';
import { beginLocalLogoutCleanup, broadcastSessionCoordination, cancelLocalLogoutCleanup, captureAuthInvalidationNonce, captureSessionGeneration, clearSessionLogout, completeLocalLogoutCleanup, consumeAuthInvalidationNonce, getLocallyOwnedLogoutGeneration, getSessionGeneration, getSessionLogoutInProgress, hydrateSessionCoordination, isSessionGenerationCurrent, isSessionLogoutAdopted, rollbackSessionLogout, SessionGenerationMismatchError, startSessionLogout, subscribeSessionCoordination, subscribeSessionLogout } from './session';
import { beginMutationBarrier, isMutationBarrierActive, releaseMutationBarrier, runMutation, withExclusiveMutationLock } from './mutation-quiescence';
import type { ExpenseFilters } from './expense-filters';
import { expenseFilterQuery, hasExpenseFilters } from './expense-filters';
import { hasTransactionFilters, readTransactionFilters, transactionFilterKey, transactionFilterQuery, type TransactionFilters } from './transaction-filters';
import { CSRF_COOKIE, CSRF_HEADER } from '../worker/application-session';
import { persistActivityResponse, persistBalanceResponse, persistCategoriesResponse, persistExpenseDetailsResponse, persistExpenseResponse, persistGroupResponse, persistGroupsResponse, persistSettlementResponse, persistTransactionResponse } from './persisted-resources';
import { revokeNotificationIdentity } from './notification-identity';

export type CurrentUser = { id: string; email: string; personId: string; idleExpiresAt?: string };
export type CachedResult<T> = T & { offline?: boolean; stale?: boolean; authoritative?: boolean };
export type ApiResponse<T> = { data: T; userId?: string; clerkUserId?: string; headers?: Headers };
export type AuthRequiredCode = 'AUTH_REQUIRED' | 'AUTH_INVALID' | 'IDENTITY_MISMATCH';
export type AuthState = { required: boolean; code?: AuthRequiredCode };
export type ConnectionStatus = 'checking' | 'connected' | 'connection-issue' | 'offline';
export type ConnectionState = { status: ConnectionStatus; reconnectRequired: boolean };
export type AuthLifecycleStatus = 'checking' | 'provisional' | 'restoring' | 'reverifying' | 'unauthenticated' | 'authenticated' | 'trusted-offline' | 'verification-unavailable';
export type AuthLifecycle = { status: AuthLifecycleStatus; error?: unknown; privateCacheAvailable?: boolean; privateCacheRouteKey?: string };
export type ClerkAuthEvidence = { isLoaded: boolean; isSignedIn: boolean | undefined; userId?: string; sessionId?: string };
export type AuthBootstrapRoute = { pathname: string; search?: string };
export type ExpensePage = { expenses: Expense[]; nextCursor?: string };
export type SettlementPage = { settlements: Settlement[]; nextCursor?: string };
export type TransactionPage = { transactions: Transaction[]; nextCursor?: string };
export type ActivityPage = { activity: Activity[]; nextCursor?: string };
export type AuditPage = { audit: AuditEvent[]; nextCursor?: string };
export type GroupExportPage = { version: number; exportedAt: string; group: Group | null; splitDefault: GroupSplitDefault | null; members: GroupMember[]; expenses: Expense[]; settlements: Settlement[]; nextCursor?: { expenses: string | null; settlements: string | null } };
export type ExportPage = { version: number; exportedAt: string; groups: GroupExportPage[]; nextCursor?: string };
const TRANSACTION_HISTORY_PAGE_LIMIT = 25;
const isSufficientTransactionHistoryPage = (limit: number | undefined) => typeof limit === 'number' && limit >= TRANSACTION_HISTORY_PAGE_LIMIT;

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
  broadcastSessionCoordination({ type: 'account-deletion', reason: 'account-deletion', clerkUserId, phase: 'server-pending' });
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('billsplit-account-deletion-pending'));
};
/** Discard only an unreadable legacy marker; this never performs account cleanup or binds it to an identity. */
export const discardInvalidPendingAccountDeletion = () => {
  if (!hasInvalidPendingAccountDeletion() || typeof localStorage === 'undefined') return false;
  localStorage.removeItem(PENDING_ACCOUNT_DELETION_KEY);
  return true;
};
const clearPendingAccountDeletion = () => { if (typeof localStorage !== 'undefined') localStorage.removeItem(PENDING_ACCOUNT_DELETION_KEY); };
const bestEffortClearPendingAccountDeletion = () => {
  try { clearPendingAccountDeletion(); } catch { /* Provider deletion already completed; recovery must not depend on storage. */ }
};

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
      bestEffortClearPendingAccountDeletion();
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
      if (recoveryEvidence && (recoveryEvidence.isLoaded !== true || recoveryEvidence.isSignedIn !== true || recoveryEvidence.userId !== pending.clerkUserId)) throw new Error('The provider identity is not fully restored for account deletion recovery. Retry when the original Clerk account is loaded.');
    } else if (!currentClerkUserId && pending.phase !== 'server-deleted') {
      throw new Error('The provider identity is still restoring. Retry account deletion when Clerk has loaded.');
    }
    if (pending.phase === 'server-pending') {
      // The request may have committed before its response was lost. DELETE
      // /account is deliberately idempotent for the authenticated tombstone,
      // so retrying is the only safe way to turn that uncertainty into a
      // confirmed server phase. No local or provider cleanup can run unless
      // this request succeeds.
       await deleteAccount(pending.clerkUserId, { recovery: true });
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
        // UserResource.delete() is the destructive provider operation. A
        // storage failure after it resolves cannot turn a completed account
        // deletion back into a required sign-in recovery flow.
        try { writePendingAccountDeletion('provider-deleted', pending.clerkUserId); } catch { bestEffortClearPendingAccountDeletion(); }
      } else if (clerkStatus === 'unsupported' && !clerkError) {
        // BillSplit and local cleanup are complete even when this Clerk
        // client cannot manage the provider account. Do not leave a
        // local-cleared marker which would gate unrelated future accounts.
        bestEffortClearPendingAccountDeletion();
        try { await signOut({ redirectUrl: '/' }); }
        catch (cause) { recoverAfterClerkSignOutFailure(cause); }
        return { clerkStatus: 'unsupported' as const };
      } else {
        try { await signOut({ redirectUrl: '/' }); return { clerkStatus }; }
        catch (cause) { throw clerkError || cause; }
      }
    }
    // UserResource.delete normally ends the Clerk session. The marker is
    // cleared only after local cleanup and provider deletion are complete.
    bestEffortClearPendingAccountDeletion();
    return { clerkStatus: 'deleted' as const };
  })();
  const tracked = request.finally(() => { if (pendingAccountDeletionRequest?.promise === tracked) pendingAccountDeletionRequest = undefined; });
  pendingAccountDeletionRequest = { clerkUserId: initialPending.clerkUserId, promise: tracked };
  return tracked;
}

/**
 * Finish only the local side of a server-confirmed deletion when the original
 * Clerk account was removed outside this client. This is deliberately a
 * user-confirmed escape hatch for post-server-deletion phases; an uncertain
 * server-pending marker can never be discarded this way.
 */
export async function finishLocalCleanupAfterExternalProviderDeletion(options: { confirmed: boolean; clearLocal?: () => Promise<void>; clerkEvidence?: ClerkAuthEvidence }) {
  if (options.confirmed !== true) throw new Error('Confirm that the original Clerk account was deleted externally before finishing local cleanup.');
  const pending = readPendingAccountDeletion();
  if (!pending || (pending.phase !== 'server-deleted' && pending.phase !== 'local-cleared')) throw new Error('Only a server-confirmed account deletion can finish local cleanup while signed out.');
  if (!hasAuthoritativeSignedOutEvidence(options.clerkEvidence)) throw new Error('Finish local cleanup only after Clerk has authoritatively signed out.');
  if (pending.phase === 'server-deleted') await (options.clearLocal || clearAllPrivateData)();
  clearPendingAccountDeletion();
  return { clerkStatus: 'externally-deleted' as const };
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
let startupCacheToken = 0;
let provisionalRouteGeneration = 0;
let provisionalRestoreRequest: { key: string; route?: AuthBootstrapRoute; routeGeneration: number; promise: Promise<AuthLifecycle> } | undefined;
let clerkEvidence: ClerkAuthEvidence = { isLoaded: false, isSignedIn: undefined };
let clerkEvidenceKnown = false;
let clerkEvidenceAuthoritative = false;
let pendingSharedAuthInvalidation: { nonce?: string; previousClerkUserId?: string; clerkUserId?: string } | undefined;
let logoutRecoveryContext: { generation: number; adoptedSessionId?: string; cleanupCompleted: boolean } | undefined;
let completedLogoutCleanupGeneration: number | undefined;
let clerkRestorationTimer: ReturnType<typeof setTimeout> | undefined;
let clerkRestorationPromise: Promise<AuthLifecycle> | undefined;
let clerkRestorationSettledKey: string | undefined;
let clerkRestorationRetryTimer: ReturnType<typeof setTimeout> | undefined;
let clerkRestorationRetryAttempts = 0;
let authIntentTimer: ReturnType<typeof setTimeout> | undefined;
let authIntentNetworkOnly = false;
let authIntentForce = false;
let activeAuthRoute: AuthBootstrapRoute | undefined;
let foregroundRetryTimer: ReturnType<typeof setTimeout> | undefined;
let foregroundRetryAttempts = 0;
let foregroundRetryCooldownUntil = 0;
let foregroundRetryRequested = false;
let authResumeSequence = 0;
let activeAuthResumeId: number | undefined;
let foregroundResumeOperation: { resumeId: number; promise: Promise<AuthLifecycle> } | undefined;
const FOREGROUND_RETRY_MAX_ATTEMPTS = 5;
let scheduleForegroundRetryTimer = (callback: () => void, delay: number) => setTimeout(callback, delay);
let clearForegroundRetryTimer = (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer);
const isForeground = () => typeof document === 'undefined' || document.visibilityState === 'visible';
const cancelForegroundRetry = (reset = true) => {
  if (foregroundRetryTimer) clearForegroundRetryTimer(foregroundRetryTimer);
  foregroundRetryTimer = undefined;
  if (reset) { foregroundRetryAttempts = 0; foregroundRetryCooldownUntil = 0; foregroundRetryRequested = false; }
};
export function setForegroundRetrySchedulerForTests(schedule: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>, clear: (timer: ReturnType<typeof setTimeout>) => void) {
  const previous = { schedule: scheduleForegroundRetryTimer, clear: clearForegroundRetryTimer };
  scheduleForegroundRetryTimer = schedule;
  clearForegroundRetryTimer = clear;
  return () => { scheduleForegroundRetryTimer = previous.schedule; clearForegroundRetryTimer = previous.clear; };
}
const authIntentWaiters = new Set<(result: AuthLifecycle) => void>();
const cancelAuthVerificationIntent = () => {
  cancelForegroundRetry();
  if (authIntentTimer) clearTimeout(authIntentTimer);
  authIntentTimer = undefined;
  authIntentNetworkOnly = false;
  authIntentForce = false;
  const waiters = [...authIntentWaiters];
  authIntentWaiters.clear();
  waiters.forEach((waiter) => waiter(authLifecycle));
};
const claimAuthVerificationIntent = () => {
  if (!authIntentTimer && authIntentWaiters.size === 0) return undefined;
  if (authIntentTimer) clearTimeout(authIntentTimer);
  authIntentTimer = undefined;
  const intent = { networkOnly: authIntentNetworkOnly, force: authIntentForce, waiters: [...authIntentWaiters] };
  authIntentNetworkOnly = false;
  authIntentForce = false;
  authIntentWaiters.clear();
  return intent;
};
const authListeners = new Set<() => void>();
const connectionListeners = new Set<() => void>();
export type AuthEpochTransition = {
  epoch: number;
  reason: 'same-account' | 'account-switch' | 'auth-required' | 'identity-mismatch' | 'logout' | 'account-deletion' | 'cache-clear';
  previousClerkUserId?: string;
  clerkUserId?: string;
};
const authEpochListeners = new Set<(transition: AuthEpochTransition) => void>();
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
export const isServerMutationAllowed = () => authLifecycle.status === 'authenticated' && isUsableConnection() && !getSessionLogoutInProgress();
export const getAuthLifecycle = () => authLifecycle;
export const subscribeAuthLifecycle = (listener: () => void) => { authListeners.add(listener); return () => authListeners.delete(listener); };
const setAuthLifecycle = (next: AuthLifecycle) => {
  const activeRestoreRouteKey = provisionalRestoreRequest?.route ? authRouteCacheKey(provisionalRestoreRequest.route.pathname, provisionalRestoreRequest.route.search || '') : undefined;
  if (next.status !== 'authenticated' && next.privateCacheRouteKey && activeRestoreRouteKey && next.privateCacheRouteKey !== activeRestoreRouteKey) return;
  if (next.status !== 'authenticated' && !next.privateCacheRouteKey && activeRestoreRouteKey && authLifecycle.privateCacheRouteKey) return;
  if (authLifecycle.status === next.status && authLifecycle.error === next.error && authLifecycle.privateCacheAvailable === next.privateCacheAvailable && authLifecycle.privateCacheRouteKey === next.privateCacheRouteKey) return;
  authLifecycle = next;
  setResourceAuthLifecycleReady(next.status === 'authenticated' || next.status === 'trusted-offline');
  authListeners.forEach((listener) => listener());
};
export const getAuthEpoch = () => authInvalidationGeneration;
export const isAuthEpochCurrent = (epoch: number) => epoch === authInvalidationGeneration;
/** Synchronous notification for identity-bound clients. Listeners must only
 * invalidate local state or enqueue cleanup; the auth transition itself does
 * not wait on IndexedDB or network work. */
export const subscribeAuthEpoch = (listener: (transition: AuthEpochTransition) => void) => { authEpochListeners.add(listener); return () => authEpochListeners.delete(listener); };
export const getClerkEvidenceEpoch = () => clerkEvidenceEpoch;
export const isClerkEvidenceEpochCurrent = (epoch: number) => epoch === clerkEvidenceEpoch;
const advanceAuthEpoch = (transition: Omit<AuthEpochTransition, 'epoch'> = { reason: 'auth-required' }) => {
  authInvalidationGeneration += 1;
  startupCacheToken += 1;
  provisionalRouteGeneration += 1;
  provisionalRestoreRequest = undefined;
  identityRequest = undefined;
  authLifecycleRequest = undefined;
  const event = { ...transition, epoch: authInvalidationGeneration } satisfies AuthEpochTransition;
  authEpochListeners.forEach((listener) => { try { listener(event); } catch { /* A cleanup listener cannot block auth invalidation. */ } });
  return authInvalidationGeneration;
};
const cancelClerkProbes = () => { for (const controller of clerkProbeControllers) controller.abort(); clerkProbeControllers.clear(); };
export const clearAuthRequired = () => { authBlocked = false; allowIdentityVerification(); if (!authState.required) return; authState = { required: false }; authListeners.forEach((listener) => listener()); };
const signalAuthRequired = (code: AuthRequiredCode) => {
  cancelForegroundRetry();
  verifiedIdentity = undefined;
  advanceAuthEpoch({ reason: code === 'IDENTITY_MISMATCH' ? 'identity-mismatch' : 'auth-required' });
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
  void revokeNotificationIdentity().catch(() => undefined);
  requestTrustRevocation();
  if (authLifecycle.status === 'unauthenticated' && authState.required) return;
  signalAuthRequired('AUTH_REQUIRED');
};
/** Invalidate all prior private memory before rechecking a changed Clerk session. */
export const resetForClerkSessionChange = (broadcast = true, targetClerkUserId?: string) => {
  const previousClerkUserId = verifiedClerkUserId || clerkEvidence.userId;
  void revokeNotificationIdentity().catch(() => undefined);
  requestTrustRevocation();
  cancelClerkProbes();
  cancelAuthVerificationIntent();
  cancelClerkRestorationDeadline();
  clerkEvidenceEpoch += 1;
  verifiedIdentity = undefined;
  verifiedClerkUserId = undefined;
  clerkUserIdHydrated = false;
  advanceAuthEpoch({ reason: 'account-switch', previousClerkUserId, ...(targetClerkUserId ? { clerkUserId: targetClerkUserId } : {}) });
  authBlocked = true;
  blockResourceIdentity(new ApiError('The account changed. Verify the current account before viewing private data.', { status: 401, code: 'IDENTITY_MISMATCH' }));
  setAuthLifecycle({ status: 'checking' });
  // This transition is emitted before the new provider tuple is authoritative;
  // keep the previous account in its own field and do not claim that the old
  // Clerk user is the new target.
  if (broadcast) broadcastSessionCoordination({ type: 'auth-invalidation', reason: 'account-switch', previousClerkUserId, ...(targetClerkUserId ? { clerkUserId: targetClerkUserId } : {}) });
};
/** Revoke private UI immediately for an offline account change; reverification waits for connectivity. */
export const revokeForClerkSessionChange = (broadcast = true) => {
  const previousClerkUserId = verifiedClerkUserId || clerkEvidence.userId;
  void revokeNotificationIdentity().catch(() => undefined);
  requestTrustRevocation();
  cancelClerkProbes();
  cancelAuthVerificationIntent();
  cancelClerkRestorationDeadline();
  clerkEvidenceEpoch += 1;
  verifiedIdentity = undefined;
  advanceAuthEpoch({ reason: 'account-switch', previousClerkUserId });
  authBlocked = true;
  blockResourceIdentity(new ApiError('Offline access is unavailable for the current account. Verify the account when connected.', { status: 401, code: 'IDENTITY_MISMATCH' }));
  authState = { required: false };
  setAuthLifecycle({ status: 'verification-unavailable', error: new ApiError('Verify the current account when connected.', { code: 'IDENTITY_MISMATCH' }) });
  authListeners.forEach((listener) => listener());
  if (broadcast) broadcastSessionCoordination({ type: 'auth-invalidation', reason: 'account-switch', previousClerkUserId });
};
export const getTrustedOfflineClerkUserId = () => verifiedClerkUserId;
export const getVerifiedClerkUserId = () => verifiedClerkUserId;
export const getVerifiedUserId = () => verifiedIdentity?.id;
/** A same-user provider transition may retain this already verified private view. */
export const hasRetainedPrivateSession = (clerkUserId?: string) => Boolean(verifiedIdentity && verifiedClerkUserId && (clerkUserId === undefined || clerkUserId === verifiedClerkUserId));
export const isTrustedOfflineClerkUserIdHydrated = () => clerkUserIdHydrated;
const setConnectionState = (status: ConnectionStatus, reconnectRequired = status === 'connection-issue', emitRestored = true) => {
  if (connectionState.status === status && connectionState.reconnectRequired === reconnectRequired) return;
  if (status !== 'connected') authoritativeConnection = false;
  connectionState = { status, reconnectRequired };
  connectionListeners.forEach((listener) => listener());
  if (typeof window !== 'undefined') {
    if (status === 'connection-issue') window.dispatchEvent(new CustomEvent('billsplit-reconnect-required'));
    if (status === 'connected' && emitRestored) window.dispatchEvent(new CustomEvent('billsplit-connection-restored'));
  }
};
const signalReconnectRequired = () => setConnectionState('connection-issue');
const clearReconnectRequired = (authoritative = false) => {
  if (authoritative) authoritativeConnection = true;
  // /me itself is the successful reconnect probe. Do not publish a second
  // foreground verification intent while that probe is still settling.
  setConnectionState('connected', false, !authoritative);
};
const signalOffline = () => setConnectionState('offline', false);
export const signalConnectionChecking = () => {
  setConnectionState('checking', false);
  void resumeAuthVerification({ networkOnly: true, startupFallbackMs: AUTH_BOOTSTRAP_DEADLINE_MS });
};
const isRetryableConnectionError = (error: unknown) => error instanceof ApiError && (
  error.networkFailure || error.code === 'NETWORK_TIMEOUT' || error.code === 'PROTOCOL_ERROR' ||
  error.status === 408 || error.status === 429 || (error.status !== undefined && error.status >= 500)
);

if (typeof window !== 'undefined') {
  window.addEventListener('offline', signalOffline);
  window.addEventListener('online', signalConnectionChecking);
  // Connectivity and foreground hints are inputs to the single coordinator,
  // not independent identity probes. The short debounce also lets a phone
  // wake deliver focus, pageshow, visibility, and online as one intent.
  window.addEventListener('focus', () => { if (document.visibilityState === 'visible') void resumeAuthVerification(); });
  window.addEventListener('pageshow', () => { if (document.visibilityState === 'visible') void resumeAuthVerification(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void resumeAuthVerification(); else cancelForegroundRetry(false); });
  // A successful /me already established the current identity.  The
  // connection-restored hint is only a foreground intent; making it
  // networkOnly here used to start a second, non-coalesced /me after every
  // successful reconnect probe.
  window.addEventListener('billsplit-connection-restored', () => { if (document.visibilityState === 'visible') void resumeAuthVerification({ networkOnly: true }); });
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

const isServerMutationMethod = (method: string) => method !== 'GET' && method !== 'HEAD';
const mutationBlockedError = () => new ApiError('Your session must be verified before changing server data.', { status: 401, code: 'AUTH_REQUIRED' });
const mutationIdentityError = () => new ApiError('The verified account is unavailable before changing server data.', { status: 401, code: 'IDENTITY_MISMATCH' });

/**
 * Account deletion is the one mutation which can be safely retried while the
 * normal internal-user verification is being restored. The server route has
 * its own exact Clerk binding and tombstone lookup; keep this option private
 * to that route and require the still-valid local recovery marker here too.
 */
type ApiMutationOptions = { accountDeletionRecovery?: { clerkUserId: string } };
const isBoundAccountDeletionRecovery = (path: string, init: RequestInit | undefined, options: ApiMutationOptions | undefined) => {
  if (!options?.accountDeletionRecovery || path !== '/account' || (init?.method || 'GET').toUpperCase() !== 'DELETE') return false;
  const expectedClerkUserId = new Headers(init?.headers).get(ACCOUNT_DELETION_EXPECTED_CLERK_USER_ID_HEADER);
  const pending = readPendingAccountDeletion();
  return pending?.phase === 'server-pending' && pending.clerkUserId === options.accountDeletionRecovery.clerkUserId && expectedClerkUserId === pending.clerkUserId;
};
const recoveryIdentityIsCurrent = (clerkUserId: string) => !clerkEvidenceKnown || !clerkEvidenceAuthoritative || (
  clerkEvidence.isLoaded && clerkEvidence.isSignedIn === true && clerkEvidence.userId === clerkUserId
);

/**
 * Every server mutation is bound to the internal identity established by
 * /api/me.  This is intentionally separate from the Clerk binding used by
 * account deletion: the server still requires both headers for that route.
 */
const runAuthenticatedMutation = <T>(path: string, init: RequestInit | undefined, requestEpoch: number, transport: (nextInit: RequestInit) => Promise<ApiResponse<T>>, options?: ApiMutationOptions) => {
  // Preserve the stronger logout error even when the caller is no longer
  // authenticated.  The quiescence barrier must remain the first gate.
  if (getSessionLogoutInProgress() || isMutationBarrierActive()) return runMutation(() => Promise.reject(mutationBlockedError()));
  const recovery = isBoundAccountDeletionRecovery(path, init, options) ? options?.accountDeletionRecovery : undefined;
  if (recovery) {
    if (!recoveryIdentityIsCurrent(recovery.clerkUserId)) return Promise.reject(mutationIdentityError());
  } else {
    if (!isServerMutationAllowed()) return Promise.reject(mutationBlockedError());
  }
  const expectedUserId = getVerifiedUserId();
  if (!recovery && !expectedUserId) return Promise.reject(mutationIdentityError());
  return runMutation(() => {
    if (getSessionLogoutInProgress() || isMutationBarrierActive()) return Promise.reject(mutationBlockedError());
    if (recovery) {
      if (!isBoundAccountDeletionRecovery(path, init, options) || !recoveryIdentityIsCurrent(recovery.clerkUserId)) return Promise.reject(mutationIdentityError());
    } else {
      if (!isServerMutationAllowed()) return Promise.reject(mutationBlockedError());
      if (getVerifiedUserId() !== expectedUserId || !isAuthEpochCurrent(requestEpoch)) return Promise.reject(mutationIdentityError());
    }
    const headers = new Headers(init?.headers);
    if (expectedUserId) headers.set('X-BillSplit-Expected-User-Id', expectedUserId);
    return transport({ ...init, headers });
  });
};

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
const assertAuthCommitAllowed = (generation: number, starting = false) => {
  assertRequestGeneration(generation);
  if (getSessionLogoutInProgress() && (isSessionLogoutAdopted() || starting && (authLifecycle.status === 'authenticated' || authLifecycle.status === 'trusted-offline' || authLifecycle.status === 'restoring' || authLifecycle.status === 'reverifying'))) throw new ApiError('Authentication is paused while this account change is completed.', { status: 401, code: 'AUTH_REQUIRED' });
};
const releaseLocalLogoutBarrier = (generation: number) => {
  if (!getSessionLogoutInProgress()) return;
  if (isSessionLogoutAdopted() || !clearSessionLogout(generation)) throw new ApiError('Logout is in progress. Try again after signing in.', { status: 401, code: 'AUTH_REQUIRED' });
};

async function apiWithMetaTransport<T>(path: string, init?: RequestInit, expectedAuthEpoch?: number, responseMode: 'json' | 'blob' = 'json'): Promise<ApiResponse<T>> {
  const headers = new Headers(init?.headers);
  headers.set('Content-Type', 'application/json');
  const method = (init?.method || 'GET').toUpperCase();
  if (isServerMutationMethod(method)) {
    const csrf = typeof document === 'undefined' ? undefined : document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${CSRF_COOKIE}=`))?.slice(CSRF_COOKIE.length + 1);
    if (csrf) headers.set(CSRF_HEADER, decodeURIComponent(csrf));
  }
  if (import.meta.env.DEV && !headers.has('X-Dev-Email')) headers.set('X-Dev-Email', devEmail());
  const clearsConnectionState = path !== '/session/activity';
  let response: Response;
  try { response = await fetch(`/api${path}`, { ...init, headers, credentials: 'same-origin' }); }
  catch (error) {
    if (init?.signal?.aborted) throw error;
    const browserOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
    // The auth coordinator owns the ordering for its authoritative probe. A
    // /me transport failure is published only after the lifecycle has settled
    // to trusted-offline or verification-unavailable.
    if (clearsConnectionState && path !== '/me' && (expectedAuthEpoch === undefined || isAuthEpochCurrent(expectedAuthEpoch))) browserOffline ? signalOffline() : signalReconnectRequired();
    throw new ApiError(browserOffline ? 'Network connection unavailable.' : 'Connection issue. Retry when the connection is available.', { networkFailure: true, code: 'NETWORK_ERROR', reconnectRequired: !browserOffline });
  }

  const contentType = response.headers.get('content-type') || '';
  const authResponse = response.status === 401 || (response.status >= 300 && response.status < 400 && path !== '/me') || (response.redirected && path !== '/me');
  const unexpectedFormat = !contentType.toLowerCase().includes('json') && response.status !== 204;
  const currentTransportEpoch = expectedAuthEpoch === undefined || isAuthEpochCurrent(expectedAuthEpoch);
  const authoritativePath = path === '/me';
  // Foreground session renewal is a background maintenance write, not an
  // authoritative connectivity probe. It must not clear an issue reported by
  // a concurrent resource request (for example, a failed groups request).
  // This is defense in depth for callers which accidentally probe while Clerk
  // is restoring. Such a response is not evidence of logout and must not
  // advance the auth epoch or revoke private state.
  const authEvidenceRestoring = clerkEvidenceKnown && (!clerkEvidence.isLoaded || isIncompleteSignedInEvidence(clerkEvidence)) && !isDevelopmentAuthBypass;
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
    if (authResponse) { if (currentTransportEpoch && clearsConnectionState) clearReconnectRequired(authoritativePath); throw new ApiError('Your secure session needs attention. Reconnect and check your sign-in before retrying.', { status: response.status, code: 'AUTH_REQUIRED' }); }
    if (!response.ok) { if (currentTransportEpoch && clearsConnectionState) { if (response.status >= 500) { if (!authoritativePath) signalReconnectRequired(); } else clearReconnectRequired(authoritativePath); } throw new ApiError(`Request failed (${response.status})`, { status: response.status }); }
    assertTransportEpoch();
    if (clearsConnectionState) clearReconnectRequired(authoritativePath);
     return { data: undefined as T, userId: response.headers.get('X-BillSplit-User-Id') || undefined, clerkUserId: response.headers.get('X-BillSplit-Clerk-User-Id') || undefined, headers: response.headers };
  }

  const bodyText = await response.clone().text();
  let body: { error?: { code?: string; message?: string } } | T | null = null;
  try { body = JSON.parse(bodyText) as { error?: { code?: string; message?: string } } | T; } catch { /* handled as an auth/session response below */ }
  const responseCode = body && typeof body === 'object' && 'error' in body ? (body as { error?: { code?: string } }).error?.code : undefined;
  // 403 is auth revocation unless the API has explicitly identified an
  // application-level error. CSRF failure is a request-integrity problem, not
  // evidence that the account or group authorization was revoked.
  const accessDenied = response.status === 403 && responseCode !== 'OWNER_REQUIRED' && responseCode !== 'ORIGIN_FORBIDDEN' && responseCode !== 'CSRF_FORBIDDEN';
  // A captive portal can turn a same-origin /me request into a redirect or an
  // HTML response. It proves neither logout nor a new identity. Keep it on the
  // retryable transport path so getMe may use only a matching, complete trust
  // record; explicit 401/403 responses remain authoritative auth failures.
  if (authoritativePath && !authResponse && !accessDenied && (response.redirected || (response.status >= 300 && response.status < 400) || unexpectedFormat)) {
    throw new ApiError('The verification response was not a valid JSON session response.', { status: response.status, code: 'PROTOCOL_ERROR', networkFailure: true, reconnectRequired: true });
  }
  if (authResponse || accessDenied) {
    // Authentication responses are still authoritative evidence that the
    // server was reached, even though they require a lifecycle transition.
    if (currentTransportEpoch && clearsConnectionState) clearReconnectRequired(authoritativePath);
    // A request from an earlier Clerk epoch may finish after a new account has
    // started. It must not downgrade the new session.
    // A complete Clerk session can be valid while its application session is
    // absent or expired. Preserve this explicit response so the lifecycle can
    // bootstrap the application session and retry /me without invalidating the
    // still-current Clerk epoch first.
    const shouldBootstrapApplicationSession = authoritativePath && response.status === 401 && responseCode === 'AUTH_REQUIRED' && clerkEvidenceKnown && clerkEvidenceAuthoritative && isCompleteSignedInEvidence(clerkEvidence);
    const authCode: AuthRequiredCode = shouldBootstrapApplicationSession ? 'AUTH_REQUIRED' : responseCode === 'IDENTITY_MISMATCH' || signedInClerkEvidence || incompleteSignedInClerkEvidence ? 'IDENTITY_MISMATCH' : 'AUTH_REQUIRED';
    if (!shouldBootstrapApplicationSession && !authEvidenceRestoring && (expectedAuthEpoch === undefined || isAuthEpochCurrent(expectedAuthEpoch))) signalAuthRequired(authCode);
    throw new ApiError('Your secure session needs attention. Reconnect and check your sign-in before retrying.', { status: response.status, code: authCode });
  }
  if (responseMode === 'blob' && response.ok) {
    assertTransportEpoch();
    if (clearsConnectionState && (expectedAuthEpoch === undefined || isAuthEpochCurrent(expectedAuthEpoch))) clearReconnectRequired(authoritativePath);
    return { data: await response.blob() as T, userId: response.headers.get('X-BillSplit-User-Id') || undefined, clerkUserId: response.headers.get('X-BillSplit-Clerk-User-Id') || undefined, headers: response.headers };
  }
  if (body === null || unexpectedFormat) {
    if (clearsConnectionState && currentTransportEpoch && !authoritativePath) signalReconnectRequired();
    if (response.status >= 500) throw new ApiError(`Request failed (${response.status})`, { status: response.status, code: 'SERVER_ERROR' });
    throw new ApiError('The server returned an unexpected response. Reconnect and check your session before retrying.', { status: response.status, code: 'PROTOCOL_ERROR', reconnectRequired: true });
  }
  if (!response.ok) {
    if (currentTransportEpoch && clearsConnectionState) { if (response.status >= 500) { if (!authoritativePath) signalReconnectRequired(); } else clearReconnectRequired(authoritativePath); }
    const errorBody = body as { error?: { code?: string; message?: string } };
    const message = errorBody?.error?.message || `Request failed (${response.status})`;
    const code = errorBody?.error?.code;
    if (response.status === 401 && !authEvidenceRestoring && (code === 'AUTH_INVALID' || code === 'IDENTITY_MISMATCH') && (expectedAuthEpoch === undefined || isAuthEpochCurrent(expectedAuthEpoch))) signalAuthRequired(signedInClerkEvidence || incompleteSignedInClerkEvidence ? 'IDENTITY_MISMATCH' : code);
    throw new ApiError(message, { status: response.status, code });
  }
  assertTransportEpoch();
  if (clearsConnectionState && (expectedAuthEpoch === undefined || isAuthEpochCurrent(expectedAuthEpoch))) clearReconnectRequired(authoritativePath);
  return { data: body as T, userId: response.headers.get('X-BillSplit-User-Id') || undefined, clerkUserId: response.headers.get('X-BillSplit-Clerk-User-Id') || undefined };
}

type SessionResponse = { idleExpiresAt: string; user?: CurrentUser };
async function directSessionRequest<T>(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  if (import.meta.env.DEV && !headers.has('X-Dev-Email')) headers.set('X-Dev-Email', devEmail());
  const response = await fetch(`/api${path}`, { ...init, headers, credentials: 'same-origin' });
  if (response.status === 204) return undefined as T;
  const body = await response.json().catch(() => null) as { error?: { message?: string; code?: string } } & T | null;
  if (!response.ok) throw new ApiError(body?.error?.message || `Request failed (${response.status})`, { status: response.status, code: body?.error?.code });
  return body as T;
}

/** Establish the application session using the still-live Clerk cookie. */
export const bootstrapApplicationSession = () => directSessionRequest<SessionResponse>('/session/bootstrap', { method: 'POST', body: '{}' });
/** Sliding renewal is intentionally a separately named, explicit operation. */
export const recordSessionActivity = () => api<SessionResponse>('/session/activity', { method: 'POST', body: '{}' });
export const revokeApplicationSession = () => api<void>('/session', { method: 'DELETE' });
export const revokeAllApplicationSessions = () => api<void>('/sessions', { method: 'DELETE' });
export const getNotificationStatus = () => api<NotificationStatus>('/notifications/status');
export const putNotificationSubscription = (subscription: PushSubscriptionInput) => api<{ subscription: { id: string; expirationTime: number | null } }>('/notifications/subscription', { method: 'PUT', body: JSON.stringify(subscription) });
export const removeNotificationSubscription = (endpoint: string) => api<void>('/notifications/subscription', { method: 'DELETE', body: JSON.stringify({ endpoint }) });
export const updateNotificationPreferences = (preferences: NotificationPreferences) => api<{ preferences: NotificationPreferences }>('/notifications/preferences', { method: 'PUT', body: JSON.stringify({ money_changes: preferences.moneyChanges, scheduled_events: preferences.scheduledEvents, detail_level: preferences.detailLevel }) }).then((result) => result.preferences);

export function apiWithMeta<T>(path: string, init?: RequestInit, expectedAuthEpoch?: number, options?: ApiMutationOptions): Promise<ApiResponse<T>> {
  if (path === '/me' && clerkEvidenceKnown && (!clerkEvidence.isLoaded || isIncompleteSignedInEvidence(clerkEvidence)) && !isDevelopmentAuthBypass) {
    return Promise.reject(new ApiError('Clerk is still restoring; authoritative verification has not started.', { code: 'CLERK_LOADING', networkFailure: true }));
  }
  // Capture the epoch before a mutation waits for the shared lock. A late
  // response from that request must not affect a later Clerk lifecycle.
  const requestEpoch = expectedAuthEpoch ?? getAuthEpoch();
  const method = (init?.method || 'GET').toUpperCase();
  return isServerMutationMethod(method)
    ? runAuthenticatedMutation(path, init, requestEpoch, (nextInit) => apiWithMetaTransport<T>(path, nextInit, requestEpoch), options)
    : apiWithMetaTransport<T>(path, init, requestEpoch);
}

export function apiBlobWithMeta(path: string, init?: RequestInit, expectedAuthEpoch?: number, options?: ApiMutationOptions): Promise<ApiResponse<Blob>> {
  const requestEpoch = expectedAuthEpoch ?? getAuthEpoch();
  const method = (init?.method || 'GET').toUpperCase();
  return isServerMutationMethod(method)
    ? runAuthenticatedMutation(path, init, requestEpoch, (nextInit) => apiWithMetaTransport<Blob>(path, nextInit, requestEpoch, 'blob'), options)
    : apiWithMetaTransport<Blob>(path, init, requestEpoch, 'blob');
}

export async function api<T>(path: string, init?: RequestInit, expectedAuthEpoch?: number, options?: ApiMutationOptions): Promise<T> { return (await apiWithMeta<T>(path, init, expectedAuthEpoch, options)).data; }

async function trustForCache() { return cacheRead(readOfflineTrust); }
const cachedTrustMatches = (requestedClerkUserId: string | undefined, trust: OfflineTrustRecord | undefined) => requestedClerkUserId === undefined || Boolean(trust?.clerkUserId && trust.clerkUserId.trim().length > 0 && trust.clerkUserId === requestedClerkUserId);
type CacheIdentity = { user: CurrentUser; authoritative: boolean };
async function requireIdentityForCache(signal?: AbortSignal): Promise<CacheIdentity | undefined> {
  const identitySnapshot = getResourceSnapshot('identity');
  if (identitySnapshot.status === 'auth-blocked') throw new ApiError('Your secure session needs attention before private data can be refreshed.', { status: 401, code: 'AUTH_REQUIRED' });
  if (typeof window !== 'undefined' && typeof navigator !== 'undefined' && verifiedIdentity) return { user: verifiedIdentity, authoritative: authLifecycle.status === 'authenticated' };
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
const groupCurrentPersonId = (members: GroupMember[], currentPersonId: string | null | undefined, authenticatedPersonId?: string) => {
  const candidate = currentPersonId === undefined ? authenticatedPersonId : currentPersonId;
  return candidate && members.some((member) => member.personId === candidate) ? candidate : null;
};
const cachedPersonIdForUser = async (userId: string) => {
  if (verifiedIdentity?.id === userId) return verifiedIdentity.personId;
  const trust = await cacheRead(readOfflineTrust);
  return trust && trust.userId === userId && isOfflineTrustUsable(trust) ? trust.personId : undefined;
};
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

export const AUTH_BOOTSTRAP_DEADLINE_MS = 10_000;
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

const trustRevisionIsCurrent = async (trust: OfflineTrustRecord) => {
  const latest = await boundedTrustRead();
  return !latest.timedOut && latest.record?.state === 'active' && latest.record.revision === trust.revision && latest.record.userId === trust.userId && latest.record.clerkUserId === trust.clerkUserId;
};

const requestTrustRevocation = () => {
  startupCacheToken += 1;
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

const offlineActivationMemoryIsCurrent = (trust: OfflineTrustRecord, expectedEvidenceEpoch: number, generation: number, expectedAuthEpoch?: number) => (
  isClerkEvidenceEpochCurrent(expectedEvidenceEpoch) &&
  (expectedAuthEpoch === undefined || isAuthEpochCurrent(expectedAuthEpoch)) &&
  isSessionGenerationCurrent(generation) &&
  !getSessionLogoutInProgress() &&
  !hasPendingAccountDeletion() &&
  !authBlocked &&
  isOfflineTrustUsable(trust) &&
  cachedTrustMatches(clerkEvidence.userId, trust)
);

const ensureTrustRevoked = async () => {
  const request = requestTrustRevocation();
  const revoked = await request;
  if (revoked && !trustRevocationRequest) trustRevocationRequired = false;
  return revoked && !trustRevocationRequest;
};

const isRetryableVerificationFailure = (error: unknown) => isRetryableConnectionError(error) || error instanceof ApiError && (error.code === 'VERIFICATION_TIMEOUT' || error.code === 'CLERK_LOADING' || error.code === 'VERIFICATION_UNAVAILABLE') && (error.networkFailure || error.reconnectRequired);
export const isRetryableAuthFailure = isRetryableVerificationFailure;
const setVerificationUnavailable = (error: unknown = new ApiError('Verification is unavailable. Retry when the connection is available.', { code: 'VERIFICATION_UNAVAILABLE' }), route?: AuthBootstrapRoute, preserveRetainedSession = false) => {
  if (!preserveRetainedSession) verifiedIdentity = undefined;
  blockResourceIdentity(error instanceof ApiError ? error : new ApiError('Verification is unavailable.', { code: 'VERIFICATION_UNAVAILABLE' }));
  setAuthLifecycle({ status: 'verification-unavailable', error, ...(route ? { privateCacheRouteKey: provisionalRouteKey(route) } : {}) });
};

export const isIncompleteLoadedSignedInEvidence = (isLoaded: boolean, isSignedIn: boolean | undefined, userId?: string, sessionId?: string) => isLoaded && isSignedIn === true && (!userId || !sessionId);
const isIncompleteSignedInEvidence = (evidence: ClerkAuthEvidence) => clerkEvidenceAuthoritative && isIncompleteLoadedSignedInEvidence(evidence.isLoaded, evidence.isSignedIn, evidence.userId, evidence.sessionId);
const isCompleteSignedInEvidence = (evidence: ClerkAuthEvidence) => evidence.isLoaded && evidence.isSignedIn === true && Boolean(evidence.userId && evidence.sessionId);
const holdSharedAuthInvalidation = (message: { nonce?: string; previousClerkUserId?: string; clerkUserId?: string }, terminal = false) => {
  pendingSharedAuthInvalidation = message;
  requestTrustRevocation();
  const evidenceIncomplete = clerkEvidenceKnown && (!clerkEvidence.isLoaded || isIncompleteSignedInEvidence(clerkEvidence));
  if (!evidenceIncomplete) {
    cancelAuthVerificationIntent();
    cancelClerkProbes();
    cancelClerkRestorationDeadline();
  }
  verifiedIdentity = undefined;
  verifiedClerkUserId = undefined;
  clerkUserIdHydrated = false;
  authBlocked = true;
  authState = { required: false };
  advanceAuthEpoch({ reason: 'account-switch', previousClerkUserId: message.previousClerkUserId, clerkUserId: message.clerkUserId });
  resetResourceIdentity();
  blockResourceIdentity(new ApiError('The previous Clerk account was invalidated. Verify the current account before viewing private data.', { status: 401, code: 'IDENTITY_MISMATCH' }));
  if (terminal) setVerificationUnavailable(new ApiError('The current Clerk account does not match the shared account-switch target.', { status: 401, code: 'IDENTITY_MISMATCH' }));
  else setAuthLifecycle({ status: 'checking' });
};

const activateTrustedOffline = async (trust: OfflineTrustRecord, expectedEvidenceEpoch = clerkEvidenceEpoch, route?: AuthBootstrapRoute) => {
  const generation = captureSessionGeneration();
  const effectiveRoute = route || provisionalRestoreRequest?.route;
  const routeKey = effectiveRoute ? authRouteCacheKey(effectiveRoute.pathname, effectiveRoute.search || '') : undefined;
  const routeRestore = routeKey && provisionalRestoreRequest?.route && provisionalRouteKey(provisionalRestoreRequest.route) === routeKey ? provisionalRestoreRequest : undefined;
  if (effectiveRoute && effectiveRoute.pathname !== '/settings') {
    if (provisionalRestoreRequest?.route && provisionalRouteKey(provisionalRestoreRequest.route) !== routeKey) return authLifecycle;
    if (routeRestore) {
      const result = await routeRestore.promise;
      if (result.status === 'authenticated') return result;
      if (result.status === 'provisional') {
        if (result.privateCacheRouteKey !== routeKey || result.privateCacheAvailable !== true) return result;
      } else {
        setAuthLifecycle({ status: 'provisional', privateCacheAvailable: false, privateCacheRouteKey: routeKey });
        return authLifecycle;
      }
    } else {
      // A dev-bypass startup reaches this path through the /me fallback rather
      // than startProvisionalRestore. Build the route contract here so a cold
      // offline reload can hydrate the same cached private page.
      const token = startupCacheToken;
      const routeGeneration = ++provisionalRouteGeneration;
      const authEpoch = getAuthEpoch();
      const restored = await restoreProvisionalRouteCache(trust.userId, trust.personId, effectiveRoute, token, routeGeneration, authEpoch, expectedEvidenceEpoch, generation);
      if (!provisionalRouteIsCurrent(routeGeneration, authEpoch, expectedEvidenceEpoch, generation) || !restored) {
        setAuthLifecycle({ status: 'provisional', privateCacheAvailable: false, privateCacheRouteKey: routeKey });
        return authLifecycle;
      }
    }
  }
  if (!offlineActivationMemoryIsCurrent(trust, expectedEvidenceEpoch, generation)) return authLifecycle;
  if (!(await trustRevisionIsCurrent(trust))) return authLifecycle;
  // The trust read above yields to logout, account deletion, Clerk evidence,
  // and cache-clear handlers. Never commit the identity from the pre-await
  // snapshot after one of those barriers has changed.
  if (!offlineActivationMemoryIsCurrent(trust, expectedEvidenceEpoch, generation) || !(await trustRevisionIsCurrent(trust)) || !offlineActivationMemoryIsCurrent(trust, expectedEvidenceEpoch, generation)) return authLifecycle;
  const user = { id: trust.userId, email: trust.email, personId: trust.personId };
  if (!offlineActivationMemoryIsCurrent(trust, expectedEvidenceEpoch, generation)) return authLifecycle;
  verifiedIdentity = user;
  verifiedClerkUserId = trust.clerkUserId;
  clerkUserIdHydrated = true;
  setResourceIdentity(user.id);
  if (!offlineActivationMemoryIsCurrent(trust, expectedEvidenceEpoch, generation)) return authLifecycle;
  seedResource('identity', '', { ...offline(user), authoritative: false }, Date.now(), { offline: true });
  clearAuthRequired();
  setAuthLifecycle({
    status: 'trusted-offline',
    privateCacheAvailable: effectiveRoute ? true : authLifecycle.privateCacheAvailable,
    ...(routeKey ? { privateCacheRouteKey: routeKey } : authLifecycle.privateCacheRouteKey ? { privateCacheRouteKey: authLifecycle.privateCacheRouteKey } : {}),
  });
  // Publish the connection result only after the lifecycle has settled. This
  // keeps connection listeners from observing a transient reverifying state.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) signalOffline();
  else signalReconnectRequired();
  return authLifecycle;
};

const normalizeAuthRoutePathname = (pathname: string) => pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
const decodeAuthRoutePart = (value: string) => {
  try { return decodeURIComponent(value); } catch { return value; }
};
/** Legacy group history URLs are redirects to one canonical route. Keep the
 * auth fence on that canonical route even if the provider callback races the
 * redirect and reports the legacy URL first. */
const canonicalAuthRoute = (pathname: string, search: string) => {
  let normalizedPathname = normalizeAuthRoutePathname(pathname);
  const params = new URLSearchParams(search);
  const legacyMatch = normalizedPathname.match(/^\/groups\/([^/]+)\/(activity|transactions)$/);
  if (legacyMatch) {
    params.set('group', decodeAuthRoutePart(legacyMatch[1]));
    params.set('view', legacyMatch[2] === 'transactions' ? 'transactions' : 'changes');
    normalizedPathname = '/activity';
  }
  return { normalizedPathname, params };
};
export const authRouteCacheKey = (pathname: string, search = '') => {
  const { normalizedPathname, params } = canonicalAuthRoute(pathname, search);
  params.sort();
  const normalizedSearch = params.toString();
  return `${normalizedPathname}${normalizedSearch ? `?${normalizedSearch}` : ''}`;
};
export const isPrivateCacheRouteCurrent = (lifecycle: Pick<AuthLifecycle, 'privateCacheRouteKey'>, pathname: string, search = '') => pathname === '/settings' || lifecycle.privateCacheRouteKey === authRouteCacheKey(pathname, search);
const provisionalRouteKey = (route: AuthBootstrapRoute | undefined) => route ? authRouteCacheKey(route.pathname, route.search || '') : '';
const provisionalRestoreKey = (authEpoch: number, evidenceEpoch: number, route: AuthBootstrapRoute | undefined) => `${authEpoch}:${evidenceEpoch}:${provisionalRouteKey(route)}`;
const provisionalRouteIsCurrent = (routeGeneration: number, authEpoch: number, evidenceEpoch: number, generation: number) => routeGeneration === provisionalRouteGeneration && isAuthEpochCurrent(authEpoch) && isClerkEvidenceEpochCurrent(evidenceEpoch) && isSessionGenerationCurrent(generation) && !getSessionLogoutInProgress() && !authBlocked && !hasPendingAccountDeletion();
const provisionalRestoreIsCurrent = (token: number, routeGeneration: number, authEpoch: number, evidenceEpoch: number, generation: number) => token === startupCacheToken && provisionalRouteIsCurrent(routeGeneration, authEpoch, evidenceEpoch, generation);
const seedProvisionalResource = <T>(key: string, userId: string, data: T, fetchedAt: number, token: number, routeGeneration: number, authEpoch: number, evidenceEpoch: number, generation: number) => {
  if (!provisionalRestoreIsCurrent(token, routeGeneration, authEpoch, evidenceEpoch, generation)) return false;
  const current = getResourceSnapshot<T>(key, userId);
  // A route hydrator, a mutation invalidation, or another request may have
  // touched this entry while the bounded startup read was pending. Never let
  // the late startup copy replace that newer state.
  if (current.data !== undefined || current.status !== 'idle' || current.stale || current.error) return false;
  seedResource(key, userId, data, fetchedAt, { offline: true });
  return true;
};

/** Restore only the active route's persisted resources. This runs before the
 * private tree is mounted so the first private render can use the same
 * account-scoped keys and hydrators as a normal route visit. */
async function restoreProvisionalRouteCache(userId: string, authenticatedPersonId: string | undefined, route: AuthBootstrapRoute | undefined, token: number, routeGeneration: number, authEpoch: number, evidenceEpoch: number, generation: number): Promise<boolean> {
  if (!route) return provisionalRestoreIsCurrent(token, routeGeneration, authEpoch, evidenceEpoch, generation);
  if (!provisionalRestoreIsCurrent(token, routeGeneration, authEpoch, evidenceEpoch, generation)) return false;
  const pathname = normalizeAuthRoutePathname(route.pathname || '/');
  const search = new URLSearchParams(route.search || '');
  const groupMatch = pathname.match(/^\/groups\/([^/]+)/);
  const decodeRoutePart = (value: string) => { try { return decodeURIComponent(value); } catch { return value; } };
  const groupId = groupMatch ? decodeRoutePart(groupMatch[1]) : search.get('group') || undefined;
  const snapshot = async (id: string) => cacheRead(() => readGroupSnapshot(userId, id));
  const resourceReady = (key: string) => getResourceSnapshot(key, userId).data !== undefined;
  const seedGroup = async (id: string, resources: Array<'group' | 'balances' | 'expenses' | 'settlements' | 'transactions'>) => {
    const cached = await snapshot(id);
    if (!cached || !provisionalRestoreIsCurrent(token, routeGeneration, authEpoch, evidenceEpoch, generation)) return cached;
    const timestamp = cacheTimestamp(cached.cachedAtByResource?.group || cached.cachedAt);
     if (resources.includes('group') && cached.group && cached.members) seedProvisionalResource(resourceKeys.group(userId, id), userId, { group: cached.group, members: cached.members, currentPersonId: groupCurrentPersonId(cached.members, cached.currentPersonId, authenticatedPersonId), historicalParticipants: cached.historicalParticipants || cached.members.map((member) => ({ ...member, status: member.removedAt ? 'removed' as const : 'active' as const })), splitDefault: cached.splitDefault ?? null }, timestamp, token, routeGeneration, authEpoch, evidenceEpoch, generation);
    const resourceTimestamp = (resource: keyof NonNullable<GroupSnapshot['cachedAtByResource']>) => cacheTimestamp(cached.cachedAtByResource?.[resource] || cached.cachedAt);
    if (resources.includes('balances') && cached.balances) seedProvisionalResource(resourceKeys.balances(userId, id), userId, { balances: cached.balances }, resourceTimestamp('balances'), token, routeGeneration, authEpoch, evidenceEpoch, generation);
    if (resources.includes('expenses') && cached.expenses) seedProvisionalResource(resourceKeys.expenses(userId, id), userId, { expenses: cached.expenses }, resourceTimestamp('expenses'), token, routeGeneration, authEpoch, evidenceEpoch, generation);
    if (resources.includes('settlements') && cached.settlements) seedProvisionalResource(resourceKeys.settlements(userId, id), userId, { settlements: cached.settlements }, resourceTimestamp('settlements'), token, routeGeneration, authEpoch, evidenceEpoch, generation);
    if (resources.includes('transactions') && cached.transactions) seedProvisionalResource(resourceKeys.transactions(userId, id, 'overview'), userId, { transactions: cached.transactions.slice(0, 5), nextCursor: cached.transactionsNextCursor }, resourceTimestamp('transactions'), token, routeGeneration, authEpoch, evidenceEpoch, generation);
    return cached;
  };
  const seedHome = async () => {
    const cached = await cacheRead(() => readGroups(userId));
    if (cached) seedProvisionalResource(resourceKeys.groups(userId), userId, { groups: cached.groups }, cacheTimestamp(cached.cachedAt), token, routeGeneration, authEpoch, evidenceEpoch, generation);
    return cached;
  };
  const seedActivity = async (id: string) => {
    const cached = await cacheRead(() => readActivity(userId, id));
    if (cached) seedProvisionalResource(resourceKeys.activity(userId, id), userId, { activity: cached.activity }, cacheTimestamp(cached.fetchedAt), token, routeGeneration, authEpoch, evidenceEpoch, generation);
    return cached;
  };
  const seedCategories = async () => {
    const cached = await cacheRead(() => readCategories(userId));
    if (cached) seedProvisionalResource(resourceKeys.categories(userId), userId, { categories: cached.categories }, cacheTimestamp(cached.fetchedAt), token, routeGeneration, authEpoch, evidenceEpoch, generation);
    };
  const seedExpenseDetail = async (expenseId: string) => {
    const cached = await cacheRead(() => readExpenseDetails(userId, expenseId));
    if (!cached) return undefined;
    seedProvisionalResource(resourceKeys.expenseDetail(userId, expenseId), userId, { expense: cached.expense, history: cached.history }, cacheTimestamp(cached.fetchedAt), token, routeGeneration, authEpoch, evidenceEpoch, generation);
    return cached.expense.groupId;
  };

  if (pathname === '/settings') return true;
  if (pathname === '/') {
    const cached = await seedHome();
    return Boolean(cached && resourceReady(resourceKeys.groups(userId)));
  }
  if (pathname === '/activity' || (groupId && pathname.endsWith('/activity'))) {
    const cachedHome = await seedHome();
    const homeReady = Boolean(cachedHome && resourceReady(resourceKeys.groups(userId)));
    if (pathname === '/activity' && !homeReady) return false;
    if (search.get('view') === 'transactions') {
      const filters = readTransactionFilters(search);
      if (groupId) {
        const cached = await seedGroup(groupId, ['group']);
        if (hasTransactionFilters(filters) || !cached?.group || !cached.members || cached.transactions === undefined || !isSufficientTransactionHistoryPage(cached.transactionsLimit)) return false;
        seedProvisionalResource(resourceKeys.transactions(userId, groupId, transactionFilterKey(filters)), userId, { transactions: cached.transactions, nextCursor: cached.transactionsNextCursor }, cacheTimestamp(cached.cachedAtByResource?.transactions || cached.cachedAt), token, routeGeneration, authEpoch, evidenceEpoch, generation);
      } else {
        const cached = await cacheRead(() => readGlobalTransactions(userId));
        if (hasTransactionFilters(filters) || !cached) return false;
        if (!isSufficientTransactionHistoryPage(cached.limit)) return false;
        seedProvisionalResource(resourceKeys.transactions(userId, 'all', transactionFilterKey(filters)), userId, { transactions: cached.transactions, nextCursor: cached.nextCursor }, cacheTimestamp(cached.fetchedAt), token, routeGeneration, authEpoch, evidenceEpoch, generation);
      }
      await seedCategories();
      if (groupId) return resourceReady(resourceKeys.group(userId, groupId)) && resourceReady(resourceKeys.transactions(userId, groupId, transactionFilterKey(filters)));
      return resourceReady(resourceKeys.transactions(userId, 'all', transactionFilterKey(filters)));
    }
    const cached = await seedActivity(groupId || 'all');
    return Boolean(cached && resourceReady(resourceKeys.activity(userId, groupId || 'all')));
  }
  if (groupId && (pathname === `/groups/${groupId}` || pathname === `/groups/${encodeURIComponent(groupId)}`)) {
    const cached = await seedGroup(groupId, ['group', 'balances', 'transactions']);
    return Boolean(cached?.group && cached.members && cached.balances !== undefined && cached.transactions !== undefined
      && resourceReady(resourceKeys.group(userId, groupId))
      && resourceReady(resourceKeys.balances(userId, groupId))
      && resourceReady(resourceKeys.transactions(userId, groupId, 'overview')));
  }
  if (groupId && pathname.endsWith('/manage')) {
    const cached = await seedGroup(groupId, ['group']);
    return Boolean(cached?.group && cached.members && resourceReady(resourceKeys.group(userId, groupId)));
  }
  if (groupId && pathname.endsWith('/transactions')) {
    const filters = readTransactionFilters(search);
    const cached = await seedGroup(groupId, ['group']);
    if (hasTransactionFilters(filters) || !cached?.group || !cached.members || cached.transactions === undefined || !isSufficientTransactionHistoryPage(cached.transactionsLimit)) return false;
    seedProvisionalResource(resourceKeys.transactions(userId, groupId, transactionFilterKey(filters)), userId, { transactions: cached.transactions, nextCursor: cached.transactionsNextCursor }, cacheTimestamp(cached.cachedAtByResource?.transactions || cached.cachedAt), token, routeGeneration, authEpoch, evidenceEpoch, generation);
    await seedCategories();
    return resourceReady(resourceKeys.group(userId, groupId)) && resourceReady(resourceKeys.transactions(userId, groupId, transactionFilterKey(filters)));
  }
  if (groupId && pathname.endsWith('/settle')) {
    const cached = await seedGroup(groupId, ['group', 'balances']);
    return Boolean(cached?.group && cached.members && cached.balances && resourceReady(resourceKeys.group(userId, groupId)) && resourceReady(resourceKeys.balances(userId, groupId)));
  }
  const editMatch = pathname.match(/\/expense\/([^/]+)$/);
  if (editMatch && editMatch[1] !== 'new') {
    await seedHome(); await seedCategories();
    const detailGroupId = await seedExpenseDetail(decodeRoutePart(editMatch[1]));
    const cachedGroup = groupId || detailGroupId ? await seedGroup(groupId || detailGroupId!, ['group']) : undefined;
    return Boolean(detailGroupId && cachedGroup?.group && cachedGroup.members && resourceReady(resourceKeys.expenseDetail(userId, decodeRoutePart(editMatch[1]))) && resourceReady(resourceKeys.group(userId, groupId || detailGroupId)));
  }
  const detailMatch = pathname.match(/\/expenses\/([^/]+)$/);
  if (detailMatch) {
    const detailGroupId = await seedExpenseDetail(decodeRoutePart(detailMatch[1]));
    const cachedGroup = detailGroupId ? await seedGroup(detailGroupId, ['group']) : undefined;
    return Boolean(detailGroupId && cachedGroup?.group && cachedGroup.members && resourceReady(resourceKeys.expenseDetail(userId, decodeRoutePart(detailMatch[1]))) && resourceReady(resourceKeys.group(userId, detailGroupId)));
  }
  if (pathname.includes('/scheduled-expense/')) {
    await seedHome();
    const cached = groupId ? await seedGroup(groupId, ['group']) : undefined;
    return pathname.endsWith('/new') && Boolean(cached?.group && cached.members && resourceReady(resourceKeys.group(userId, groupId!)));
  }
  if (pathname.includes('/expense/') || pathname === '/expense/new') {
    const groups = await seedHome(); await seedCategories();
    const cached = groupId ? await seedGroup(groupId, ['group']) : undefined;
    if (groupId) return Boolean(cached?.group && cached.members && resourceReady(resourceKeys.group(userId, groupId)));
    return Boolean(groups && resourceReady(resourceKeys.groups(userId)));
  }
  // Unknown private routes must fail closed. A future route should opt into
  // provisional startup with an explicit cache contract rather than silently
  // mounting its private tree without restored essential data.
  return false;
}

const activateProvisionalOffline = async (trust: OfflineTrustRecord, expectedEvidenceEpoch: number, route: AuthBootstrapRoute | undefined, authEpoch: number, token: number, routeGeneration: number, generation: number) => {
  if (!provisionalRestoreIsCurrent(token, routeGeneration, authEpoch, expectedEvidenceEpoch, generation) || !isOfflineTrustUsable(trust) || !cachedTrustMatches(clerkEvidence.userId, trust) || authLifecycle.status === 'authenticated') return authLifecycle;
  if (!(await trustRevisionIsCurrent(trust))) return authLifecycle;
  if (!offlineActivationMemoryIsCurrent(trust, expectedEvidenceEpoch, generation, authEpoch) || !provisionalRestoreIsCurrent(token, routeGeneration, authEpoch, expectedEvidenceEpoch, generation) || !(await trustRevisionIsCurrent(trust)) || !offlineActivationMemoryIsCurrent(trust, expectedEvidenceEpoch, generation, authEpoch)) return authLifecycle;
  const user = { id: trust.userId, email: trust.email, personId: trust.personId };
  if (!provisionalRestoreIsCurrent(token, routeGeneration, authEpoch, expectedEvidenceEpoch, generation)) return authLifecycle;
  verifiedIdentity = user;
  verifiedClerkUserId = trust.clerkUserId;
  clerkUserIdHydrated = true;
  setResourceIdentity(user.id);
  if (!provisionalRestoreIsCurrent(token, routeGeneration, authEpoch, expectedEvidenceEpoch, generation)) return authLifecycle;
  seedResource('identity', '', { ...offline(user), authoritative: false }, Date.now(), { offline: true });
  clearAuthRequired();
  const restored = await deadline(
    restoreProvisionalRouteCache(user.id, user.personId, route, token, routeGeneration, authEpoch, expectedEvidenceEpoch, generation).then((ready) => ({ ready })),
    2_000,
    () => { if (token === startupCacheToken) startupCacheToken += 1; return { ready: false, timedOut: true }; },
  );
  if (!provisionalRouteIsCurrent(routeGeneration, authEpoch, expectedEvidenceEpoch, generation) || getAuthLifecycle().status === 'authenticated' || getAuthLifecycle().status === 'trusted-offline') return authLifecycle;
  setAuthLifecycle({ status: 'provisional', privateCacheAvailable: restored.ready, ...(route ? { privateCacheRouteKey: provisionalRouteKey(route) } : {}) });
  if (typeof navigator !== 'undefined' && navigator.onLine === false) signalOffline();
  return authLifecycle;
};

const startProvisionalRestore = (route: AuthBootstrapRoute | undefined, authEpoch: number, evidenceEpoch: number, force = false) => {
  const restoringProvisionalRoute = authLifecycle.status === 'provisional' || authLifecycle.status === 'trusted-offline' || authLifecycle.status === 'restoring' || authLifecycle.status === 'reverifying' || authLifecycle.status === 'checking';
  const hasRouteContract = Boolean(route || provisionalRestoreRequest?.route);
  // The development auth bypass still needs this path: /api/me is unavailable
  // on a cold offline reload, so the route cache must be restored before it can
  // fall back to the normal online lifecycle.
  if ((verifiedIdentity && (!restoringProvisionalRoute || !hasRouteContract)) || authBlocked || getSessionLogoutInProgress() || hasPendingAccountDeletion()) return Promise.resolve(authLifecycle);
  const effectiveRoute = route || provisionalRestoreRequest?.route;
  const key = provisionalRestoreKey(authEpoch, evidenceEpoch, effectiveRoute);
  if (provisionalRestoreRequest?.key === key && !force) return provisionalRestoreRequest.promise;
  if (provisionalRestoreRequest) startupCacheToken += 1;
  if (effectiveRoute && authLifecycle.status !== 'authenticated') setAuthLifecycle({ ...authLifecycle, privateCacheAvailable: undefined, privateCacheRouteKey: provisionalRouteKey(effectiveRoute) });
  const token = startupCacheToken;
  const routeGeneration = ++provisionalRouteGeneration;
  const generation = captureSessionGeneration();
  const request = (async () => {
    const trustRead = await boundedTrustRead();
    if (trustRead.timedOut || !trustRead.record || !isOfflineTrustUsable(trustRead.record) || !cachedTrustMatches(clerkEvidence.userId, trustRead.record)) {
      if (trustRead.record && clerkEvidence.userId && trustRead.record.clerkUserId !== clerkEvidence.userId) requestTrustRevocation();
      return authLifecycle;
    }
    return activateProvisionalOffline(trustRead.record, evidenceEpoch, effectiveRoute, authEpoch, token, routeGeneration, generation);
  })().catch(() => authLifecycle);
  provisionalRestoreRequest = { key, route: effectiveRoute, routeGeneration, promise: request };
  return request;
};

const settleClerkRestorationDeadline = async (expectedEvidenceEpoch: number, route?: AuthBootstrapRoute) => {
  if (!isClerkEvidenceEpochCurrent(expectedEvidenceEpoch)) return authLifecycle;
  if ((clerkEvidence.isLoaded && !isIncompleteSignedInEvidence(clerkEvidence)) || isDevelopmentAuthBypass) return authLifecycle;
  const trustRead = await boundedTrustRead();
  if (!isClerkEvidenceEpochCurrent(expectedEvidenceEpoch) || isDevelopmentAuthBypass) return authLifecycle;
  if (pendingSharedAuthInvalidation && !isCompleteSignedInEvidence(clerkEvidence)) {
    // A shared marker is a durable fence, not evidence that Clerk is signed
    // out. Keep the cold/incomplete provider state retryable until the target
    // user and session tuple is complete.
    if (hasRetainedPrivateSession()) setAuthLifecycle({ status: 'restoring' });
    else setAuthLifecycle({ status: 'checking' });
    scheduleClerkRestorationRetry(expectedEvidenceEpoch);
    return authLifecycle;
  }
  // A loaded user ID is already authoritative evidence of an account switch
  // for restoration purposes.  Do not let a stale A trust record win while
  // Clerk is still withholding B's session ID.
  if (trustRead.record && clerkEvidence.userId && trustRead.record.clerkUserId !== clerkEvidence.userId) {
    requestTrustRevocation();
    await ensureTrustRevoked();
    if (!isClerkEvidenceEpochCurrent(expectedEvidenceEpoch)) return authLifecycle;
    setVerificationUnavailable(new ApiError('The current Clerk account differs from the retained account. Complete verification before viewing private data.', { status: 401, code: 'IDENTITY_MISMATCH' }), route);
    return authLifecycle;
  }
  // A live, already-authoritative session is stronger than the durable trust
  // record for retention during a phone wake.  The record is required for a
  // cold start, but a slow/missing IDB read must not turn a transient Clerk
  // restoration deadline into a private-data eviction.
  if (authLifecycle.status !== 'provisional' && authLifecycle.status !== 'trusted-offline' && hasRetainedPrivateSession(clerkEvidence.userId)) {
    setAuthLifecycle({ status: 'restoring' });
    scheduleClerkRestorationRetry(expectedEvidenceEpoch);
    return authLifecycle;
  }
  if (!trustRead.timedOut && trustRead.record && isOfflineTrustUsable(trustRead.record) && !getSessionLogoutInProgress() && !hasPendingAccountDeletion() && !authBlocked) {
    return activateTrustedOffline(trustRead.record, expectedEvidenceEpoch, route || provisionalRestoreRequest?.route);
  }
  if (!isClerkEvidenceEpochCurrent(expectedEvidenceEpoch)) return authLifecycle;
  setVerificationUnavailable(new ApiError('Clerk did not finish restoring before the verification deadline. Retry verification.', { code: 'VERIFICATION_TIMEOUT', networkFailure: true }), route);
  scheduleClerkRestorationRetry(expectedEvidenceEpoch);
  return authLifecycle;
};

const clerkEvidenceKey = (evidence: ClerkAuthEvidence) => `${evidence.isLoaded}:${evidence.isSignedIn}:${evidence.userId || ''}:${evidence.sessionId || ''}`;

const startClerkRestorationDeadline = (timeoutMs = AUTH_BOOTSTRAP_DEADLINE_MS, expectedEvidenceEpoch = clerkEvidenceEpoch, route?: AuthBootstrapRoute) => {
  if (clerkRestorationPromise) return clerkRestorationPromise;
  let promise!: Promise<AuthLifecycle>;
  let resolvePromise!: (value: AuthLifecycle) => void;
  promise = new Promise<AuthLifecycle>((resolve) => {
    resolvePromise = resolve;
    clerkRestorationResolve = resolve;
    clerkRestorationTimer = setTimeout(() => {
      clerkRestorationTimer = undefined;
      if (isClerkEvidenceEpochCurrent(expectedEvidenceEpoch)) clerkRestorationSettledKey = clerkEvidenceKey(clerkEvidence);
      void settleClerkRestorationDeadline(expectedEvidenceEpoch, route).then((result) => {
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
const scheduleClerkRestorationRetry = (expectedEvidenceEpoch: number) => {
  if (clerkRestorationRetryTimer || clerkRestorationRetryAttempts >= 3) return;
  const delay = Math.min(4_000, 250 * (2 ** clerkRestorationRetryAttempts));
  clerkRestorationRetryAttempts += 1;
  clerkRestorationRetryTimer = setTimeout(() => {
    clerkRestorationRetryTimer = undefined;
    if (!isClerkEvidenceEpochCurrent(expectedEvidenceEpoch) || clerkEvidence.isLoaded && !isIncompleteSignedInEvidence(clerkEvidence)) return;
    clerkRestorationSettledKey = undefined;
    if (hasRetainedPrivateSession()) setAuthLifecycle({ status: 'restoring' });
    else setAuthLifecycle({ status: 'checking' });
    void startClerkRestorationDeadline(AUTH_BOOTSTRAP_DEADLINE_MS, expectedEvidenceEpoch);
  }, delay);
};
const cancelClerkRestorationDeadline = () => {
  if (clerkRestorationTimer) { clearTimeout(clerkRestorationTimer); clerkRestorationTimer = undefined; }
  if (clerkRestorationRetryTimer) { clearTimeout(clerkRestorationRetryTimer); clerkRestorationRetryTimer = undefined; }
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
function coordinateAuthBootstrapImpl(evidence: ClerkAuthEvidence, options: { networkOnly?: boolean; startupFallbackMs?: number; force?: boolean; route?: AuthBootstrapRoute } = {}) {
  const nextEvidence = { ...evidence, userId: evidence.userId || undefined, sessionId: evidence.sessionId || undefined };
  const evidenceChanged = clerkEvidenceKnown && clerkEvidenceKey(clerkEvidence) !== clerkEvidenceKey(nextEvidence);
  if (evidenceChanged) {
    const previousEvidence = clerkEvidence;
    cancelAuthVerificationIntent();
    clerkEvidenceEpoch += 1;
    cancelClerkProbes();
    const nextIsCompleteSignedIn = nextEvidence.isLoaded && nextEvidence.isSignedIn === true && Boolean(nextEvidence.userId && nextEvidence.sessionId);
    const knownPreviousClerkUserId = verifiedClerkUserId || previousEvidence.userId;
    // userId is meaningful even when sessionId is still being restored.  A
    // partial B tuple must therefore evict A immediately rather than being
    // treated as a same-session restoration window.
    const knownPositiveMismatch = Boolean(nextEvidence.isLoaded && nextEvidence.isSignedIn === true && nextEvidence.userId && knownPreviousClerkUserId && nextEvidence.userId !== knownPreviousClerkUserId);
    const authoritativeSignedOut = nextEvidence.isLoaded && nextEvidence.isSignedIn === false && !nextEvidence.userId;
    // A provider wake, session renewal, or temporary unload for the same
    // account still advances the API epoch to fence in-flight requests. It is
    // not an identity loss, though, so identity-bound notification state must
    // remain usable across that ordinary transition.
    const sameAccountTransition = !knownPositiveMismatch && !authoritativeSignedOut && (
      Boolean(knownPreviousClerkUserId && nextEvidence.userId && knownPreviousClerkUserId === nextEvidence.userId)
      || Boolean(verifiedIdentity && verifiedClerkUserId)
    );
    advanceAuthEpoch({
      reason: knownPositiveMismatch ? 'account-switch' : sameAccountTransition ? 'same-account' : 'auth-required',
      ...(knownPreviousClerkUserId ? { previousClerkUserId: knownPreviousClerkUserId } : {}),
      ...(nextEvidence.userId ? { clerkUserId: nextEvidence.userId } : {}),
    });
    cancelClerkRestorationDeadline();
    clerkRestorationRetryAttempts = 0;
    if (knownPositiveMismatch) {
      broadcastSessionCoordination({ type: 'auth-invalidation', reason: 'account-switch', previousClerkUserId: knownPreviousClerkUserId, clerkUserId: nextEvidence.userId });
      requestTrustRevocation();
      verifiedIdentity = undefined;
      verifiedClerkUserId = undefined;
      clerkUserIdHydrated = false;
      authBlocked = true;
      blockResourceIdentity(new ApiError('The Clerk account changed. Verify the current account before viewing private data.', { status: 401, code: 'IDENTITY_MISMATCH' }));
      setAuthLifecycle({ status: 'checking' });
    } else if (authoritativeSignedOut && verifiedIdentity && authLifecycle.status === 'authenticated') {
      // Ending the Clerk session is not an application logout. Keep the
      // already verified application session and its private view alive.
      verifiedClerkUserId = undefined;
      clerkUserIdHydrated = false;
      setAuthLifecycle({ status: 'authenticated' });
    } else if (!nextIsCompleteSignedIn && hasRetainedPrivateSession()) {
      // Clerk can transiently unload or publish a partial user while a mobile
      // browser wakes. Keep the already verified same-user view fenced in
      // place; only complete positive evidence can prove an account switch.
      setAuthLifecycle({ status: 'restoring' });
    } else if (nextIsCompleteSignedIn && hasRetainedPrivateSession(nextEvidence.userId)) {
      setAuthLifecycle({ status: 'reverifying' });
    }
  }
  clerkEvidence = nextEvidence;
  clerkEvidenceKnown = true;
  clerkEvidenceAuthoritative = true;
  const pendingTargetMismatch = pendingSharedAuthInvalidation
    && isCompleteSignedInEvidence(clerkEvidence)
    && pendingSharedAuthInvalidation.clerkUserId !== undefined
    && clerkEvidence.userId !== pendingSharedAuthInvalidation.clerkUserId;
  if (pendingTargetMismatch) {
    holdSharedAuthInvalidation(pendingSharedAuthInvalidation!, true);
    return Promise.resolve(authLifecycle);
  }
  if (pendingSharedAuthInvalidation && isCompleteSignedInEvidence(clerkEvidence) && authLifecycle.status === 'verification-unavailable') {
    authBlocked = true;
    setAuthLifecycle({ status: 'checking' });
  }
  if (getSessionLogoutInProgress()) {
    recoverAfterClerkSignOutFailure(undefined, true);
    // Do not let an old same-session wake probe through an adopted logout.
    if (getSessionLogoutInProgress()) return Promise.resolve(authLifecycle);
  }
  const evidenceEpoch = clerkEvidenceEpoch;
  const evidenceIncomplete = !clerkEvidence.isLoaded || isIncompleteSignedInEvidence(clerkEvidence);
  if (evidenceIncomplete && !isDevelopmentAuthBypass) {
    void startProvisionalRestore(options.route, getAuthEpoch(), evidenceEpoch, options.force);
    if (clerkRestorationSettledKey === clerkEvidenceKey(clerkEvidence) && !options.force) return Promise.resolve(authLifecycle);
    if (options.force) { clerkRestorationSettledKey = undefined; clerkRestorationRetryAttempts = 0; if (clerkRestorationRetryTimer) { clearTimeout(clerkRestorationRetryTimer); clerkRestorationRetryTimer = undefined; } }
    // Incomplete evidence is retryable provider restoration. A retained
    // verified view stays visible; a cold start remains blocked until the
    // provider supplies complete evidence or trusted offline fallback wins.
    if (isIncompleteSignedInEvidence(clerkEvidence) && !hasRetainedPrivateSession()) setAuthLifecycle({ status: 'checking' });
    else if (authLifecycle.status !== 'trusted-offline' && hasRetainedPrivateSession()) setAuthLifecycle({ status: 'restoring' });
    return startClerkRestorationDeadline(options.startupFallbackMs, evidenceEpoch, options.route);
  }
  clerkRestorationSettledKey = undefined;
  clerkRestorationRetryAttempts = 0;

  const resolveDeadline = clerkRestorationResolve;
  cancelClerkRestorationDeadline();
  if (isDefinitivelySignedOut(clerkEvidence.isLoaded, clerkEvidence.isSignedIn) && !isDevelopmentAuthBypass) {
    // Clerk is identity bootstrap only. A valid BillSplit session remains
    // authoritative after the provider's shorter session has ended.
    if (verifiedIdentity && authLifecycle.status === 'authenticated') {
      resolveDeadline?.(authLifecycle);
      return Promise.resolve(authLifecycle);
    }
    const appSessionProbe = getMe({ networkOnly: true, expectedAuthEpoch: getAuthEpoch(), expectedClerkEvidenceEpoch: evidenceEpoch, deferConnectionFailure: true, preserveAuthenticatedOnProtocolFailure: true });
    const result = appSessionProbe.then(() => authLifecycle).catch(() => { markSignedOut(); return authLifecycle; });
    void result.then((value) => resolveDeadline?.(value));
    return result;
  }
  if (clerkEvidence.isLoaded && clerkEvidence.isSignedIn !== true && !isDevelopmentAuthBypass) {
    setVerificationUnavailable(new ApiError('Clerk loaded without a usable signed-in identity.', { code: 'VERIFICATION_UNAVAILABLE' }), options.route);
    resolveDeadline?.(authLifecycle);
    return Promise.resolve(authLifecycle);
  }
  if (!isDevelopmentAuthBypass && !clerkEvidence.userId) {
    setVerificationUnavailable(new ApiError('The current Clerk identity is unavailable for verification.', { code: 'VERIFICATION_UNAVAILABLE' }), options.route);
    resolveDeadline?.(authLifecycle);
    return Promise.resolve(authLifecycle);
  }
  void startProvisionalRestore(options.route, getAuthEpoch(), evidenceEpoch, options.force);
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

export function coordinateAuthBootstrap(evidence: ClerkAuthEvidence, options: { networkOnly?: boolean; startupFallbackMs?: number; force?: boolean; route?: AuthBootstrapRoute; retry?: boolean } = {}) {
  if (options.force && !options.retry) cancelForegroundRetry();
  // The React effect and connectivity listeners can observe the same
  // transition in either order. Claim a scheduled intent before doing any
  // work so a fast App bootstrap also settles the scheduler's waiters instead
  // of leaving its 50ms timer around to issue a second /me.
  if (options.route) activeAuthRoute = { pathname: options.route.pathname, search: options.route.search || '' };
  const route = options.route || activeAuthRoute;
  const intent = claimAuthVerificationIntent();
  const routeOptions = route ? { ...options, route } : options;
  const mergedOptions = { ...routeOptions, ...(intent?.networkOnly ? { networkOnly: true } : {}), ...(intent?.force ? { force: true } : {}) };
  const request = coordinateAuthBootstrapImpl(evidence, mergedOptions);
  if (intent) void request.then((result) => intent.waiters.forEach((waiter) => waiter(result)), () => intent.waiters.forEach((waiter) => waiter(authLifecycle)));
  return request;
}

export const getClerkAuthEvidence = () => clerkEvidence;
export function requestAuthProbe(options: { networkOnly?: boolean; startupFallbackMs?: number; route?: AuthBootstrapRoute; force?: boolean; retry?: boolean } = {}) {
  if (!clerkEvidenceKnown) return Promise.resolve(authLifecycle);
  const route = options.route || activeAuthRoute;
  return coordinateAuthBootstrap(clerkEvidence, route ? { ...options, route } : options);
}

/** The single foreground operation. All wake/connectivity signals reconcile
 * durable coordination first, then enter the coalesced auth intent queue. */
export function resumeAuthVerification(options: { networkOnly?: boolean; startupFallbackMs?: number; force?: boolean; route?: AuthBootstrapRoute } = {}) {
  hydrateSessionCoordination();
  if (getSessionLogoutInProgress()) return Promise.resolve(authLifecycle);
  if (hasPendingAccountDeletion()) {
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('billsplit-account-deletion-pending'));
    return Promise.resolve(authLifecycle);
  }
  return scheduleAuthVerification({ ...options, networkOnly: options.networkOnly ?? true });
}

/** Queue foreground/connectivity auth intent in one place. */
const foregroundRetryDelay = (attempt: number) => Math.min(4_000, 250 * (2 ** Math.max(0, Math.min(attempt, 4))));
function scheduleForegroundRetry() {
  if (foregroundRetryTimer || !isForeground() || getSessionLogoutInProgress() || hasPendingAccountDeletion() || foregroundRetryAttempts >= FOREGROUND_RETRY_MAX_ATTEMPTS) return;
  const delay = Math.max(0, foregroundRetryCooldownUntil - Date.now());
  foregroundRetryTimer = scheduleForegroundRetryTimer(() => {
    foregroundRetryTimer = undefined;
    if (!isForeground() || getSessionLogoutInProgress() || hasPendingAccountDeletion()) return;
    void scheduleAuthVerification({ networkOnly: true, force: true, retry: true });
  }, delay);
}
const armForegroundRetry = () => {
  if (foregroundRetryAttempts >= FOREGROUND_RETRY_MAX_ATTEMPTS) return;
  foregroundRetryCooldownUntil = Date.now() + foregroundRetryDelay(foregroundRetryAttempts);
  foregroundRetryAttempts += 1;
  scheduleForegroundRetry();
};
const requestForegroundRetry = () => {
  foregroundRetryRequested = true;
  armForegroundRetry();
};
export function scheduleAuthVerification(options: { networkOnly?: boolean; startupFallbackMs?: number; route?: AuthBootstrapRoute; force?: boolean; retry?: boolean } = {}) {
  hydrateSessionCoordination();
  if (getSessionLogoutInProgress() || hasPendingAccountDeletion()) { cancelForegroundRetry(); return Promise.resolve(authLifecycle); }
  if (authLifecycle.status === 'unauthenticated' || (clerkEvidenceKnown && clerkEvidence.isLoaded && clerkEvidence.isSignedIn === false)) { cancelForegroundRetry(); return Promise.resolve(authLifecycle); }
  if (foregroundResumeOperation) return foregroundResumeOperation.promise;
  if (options.force && !options.retry) cancelForegroundRetry();
  const retryingUnavailable = authLifecycle.status === 'verification-unavailable';
  if (retryingUnavailable && !isRetryableVerificationFailure(authLifecycle.error)) { cancelForegroundRetry(); return Promise.resolve(authLifecycle); }
  if (!isForeground()) return Promise.resolve(authLifecycle);
  const restorationSettled = Boolean(clerkRestorationSettledKey && clerkRestorationSettledKey === clerkEvidenceKey(clerkEvidence));
  const force = options.force === true || restorationSettled;
  if (retryingUnavailable && !force && Date.now() < foregroundRetryCooldownUntil) {
    scheduleForegroundRetry();
    return Promise.resolve(authLifecycle);
  }
  if (options.route) activeAuthRoute = { pathname: options.route.pathname, search: options.route.search || '' };
  const route = options.route || activeAuthRoute;
  authIntentNetworkOnly ||= options.networkOnly === true;
  authIntentForce ||= force;
  if (authIntentTimer) clearTimeout(authIntentTimer);
  return new Promise<AuthLifecycle>((resolve) => {
    authIntentWaiters.add(resolve);
    authIntentTimer = setTimeout(() => {
      authIntentTimer = undefined;
       const networkOnly = authIntentNetworkOnly;
       const force = authIntentForce;
       authIntentNetworkOnly = false;
       authIntentForce = false;
      const waiters = [...authIntentWaiters];
      authIntentWaiters.clear();
      const resumeId = ++authResumeSequence;
      activeAuthResumeId = resumeId;
      if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('billsplit-auth-resume-started', { detail: { resumeId } }));
      const operation = requestAuthProbe({ startupFallbackMs: options.startupFallbackMs, ...(networkOnly ? { networkOnly: true } : {}), ...(force ? { force: true } : {}), ...(options.retry ? { retry: true } : {}), ...(route ? { route } : {}) }).then((result) => {
          if (foregroundRetryRequested && result.status !== 'unauthenticated' && result.status !== 'verification-unavailable') scheduleForegroundRetry();
          else if (result.status === 'authenticated' || result.status === 'trusted-offline' || result.status === 'provisional') cancelForegroundRetry();
          else if (result.status === 'verification-unavailable' && isRetryableVerificationFailure(result.error) && isForeground()) { foregroundRetryRequested = true; armForegroundRetry(); }
          else cancelForegroundRetry();
          if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('billsplit-auth-resumed', { detail: { status: result.status, resumeId, result, userId: getVerifiedUserId(), authEpoch: authInvalidationGeneration } }));
          waiters.forEach((waiter) => waiter(result));
          return result;
        }, () => { cancelForegroundRetry(); waiters.forEach((waiter) => waiter(authLifecycle)); return authLifecycle; });
      foregroundResumeOperation = { resumeId, promise: operation };
      void operation.finally(() => { if (foregroundResumeOperation?.resumeId === resumeId) foregroundResumeOperation = undefined; if (activeAuthResumeId === resumeId) activeAuthResumeId = undefined; });
    }, 50);
  });
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
const awaitWithAbort = <T>(promise: Promise<T>, signal?: AbortSignal) => {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason || new DOMException('The request was aborted.', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason || new DOMException('The request was aborted.', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
};

export async function getMe(options: { networkOnly?: boolean; signal?: AbortSignal; clerkUserId?: string; expectedUserId?: string; expectedAuthEpoch?: number; expectedClerkEvidenceEpoch?: number; startupFallbackMs?: number; deferConnectionFailure?: boolean; preserveAuthenticatedOnProtocolFailure?: boolean; preferLiveAuthenticatedStatus?: boolean; route?: AuthBootstrapRoute } = {}): Promise<CachedResult<CurrentUser>> {
  if (clerkEvidenceKnown && (!clerkEvidence.isLoaded || isIncompleteSignedInEvidence(clerkEvidence)) && !isDevelopmentAuthBypass) {
    throw new ApiError('Clerk is still restoring; authoritative verification has not started.', { code: 'CLERK_LOADING', networkFailure: true });
  }
  const authGeneration = options.expectedAuthEpoch ?? authInvalidationGeneration;
  const evidenceGeneration = options.expectedClerkEvidenceEpoch ?? clerkEvidenceEpoch;
  const key = `${authGeneration}:${evidenceGeneration}:${options.clerkUserId || ''}:${options.expectedUserId || ''}`;
  if (identityRequest && identityRequest.key === key) return awaitWithAbort(identityRequest.promise, options.signal);
  if ((isMutationBarrierActive() || getSessionLogoutInProgress()) && (authLifecycle.status === 'authenticated' || authLifecycle.status === 'trusted-offline')) throw new ApiError('Logout is in progress. Try again after signing in.', { status: 401, code: 'AUTH_REQUIRED' });
  const generation = captureSessionGeneration();
  const authInvalidationBaseline = captureAuthInvalidationNonce();
  const request = (async () => {
    const controller = new AbortController();
    clerkProbeControllers.add(controller);
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
      assertAuthCommitAllowed(generation, true);
      transport = apiWithMeta<CurrentUser>('/me', { signal }, authGeneration);
      const result = await deadline(transport, options.startupFallbackMs ?? AUTH_BOOTSTRAP_DEADLINE_MS, () => {
        throw new ApiError('Verification is taking too long. Check your connection and retry.', { networkFailure: true, code: 'NETWORK_TIMEOUT' });
      });
      assertAuthEvidence(authGeneration, evidenceGeneration);
      assertAuthCommitAllowed(generation);
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
      releaseLocalLogoutBarrier(generation);
      assertAuthCommitAllowed(generation);
       // This is the sole trust write. A timeout or CAS miss is non-fatal to
      // the authoritative session, but it grants no durable offline trust.
       if (options.clerkUserId && result.clerkUserId === options.clerkUserId && result.userId === user.id && (!options.expectedUserId || options.expectedUserId === user.id)) {
         if (!expectedTrustRead.timedOut) await boundedTrustWrite(saveOfflineTrust({ userId: user.id, email: user.email, personId: user.personId, clerkUserId: options.clerkUserId!, verifiedAt: new Date().toISOString(), idleExpiresAt: user.idleExpiresAt }, generation, () => authGeneration === authInvalidationGeneration && isClerkEvidenceEpochCurrent(evidenceGeneration) && !getSessionLogoutInProgress(), expectedTrustRead.record?.revision ?? 0));
        assertAuthEvidence(authGeneration, evidenceGeneration);
        verifiedClerkUserId = options.clerkUserId;
        clerkUserIdHydrated = true;
       }
       assertAuthEvidence(authGeneration, evidenceGeneration);
       assertAuthCommitAllowed(generation);
       // An invalidation already published before this authoritative probe is
       // the transition which this new commit supersedes. Mark its nonce as
       // consumed so delayed BC delivery cannot revoke the new session; a
       // nonce published after the baseline remains actionable.
       consumeAuthInvalidationNonce(authInvalidationBaseline);
       if (pendingSharedAuthInvalidation?.nonce === authInvalidationBaseline) pendingSharedAuthInvalidation = undefined;
       // A pending provisional route read may still be inside IndexedDB after
      // /me wins. Fence it before publishing the authoritative session so it
      // cannot seed over the refresh that follows authentication.
      startupCacheToken += 1;
      provisionalRouteGeneration += 1;
      provisionalRestoreRequest = undefined;
      verifiedIdentity = user;
      setResourceIdentity(user.id);
      seedResource('identity', '', user, Date.now(), { offline: false });
      clearAuthRequired();
      releaseMutationBarrier();
      setAuthLifecycle({ status: 'authenticated' });
      cancelForegroundRetry();
      foregroundRetryRequested = false;
      if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('billsplit-authenticated', { detail: { userId: user.id, authEpoch: authGeneration, resumeId: activeAuthResumeId } }));
      return { ...user, authoritative: true };
    } catch (error) {
      if (!isNetwork(error) && !isRetryableConnectionError(error)) throw error;
      // A timeout can win the bounded race before fetch itself rejects, so
      // make the connection decision here as well as in the transport catch.
      const browserOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
      const cachedRead = await boundedTrustRead();
      const cached = cachedRead.timedOut ? undefined : cachedRead.record;
      if (authGeneration !== authInvalidationGeneration || !isClerkEvidenceEpochCurrent(evidenceGeneration) || getSessionLogoutInProgress() || authBlocked || !isSessionGenerationCurrent(generation)) throw error;
      const liveSessionAllowed = options.preserveAuthenticatedOnProtocolFailure
        && verifiedIdentity
        && verifiedClerkUserId
        && (!options.clerkUserId || verifiedClerkUserId === options.clerkUserId)
        && (!options.expectedUserId || verifiedIdentity.id === options.expectedUserId);
      if (liveSessionAllowed && !(cached && isOfflineTrustUsable(cached) && cachedTrustMatches(options.clerkUserId, cached))) {
        assertAuthEvidence(authGeneration, evidenceGeneration);
        assertAuthCommitAllowed(generation);
        setAuthLifecycle({ status: 'authenticated' });
        if (browserOffline) signalOffline(); else signalReconnectRequired();
        requestForegroundRetry();
        return { ...verifiedIdentity!, authoritative: true };
      }
      const offlineCacheAllowed = cached && isOfflineTrustUsable(cached) && cachedTrustMatches(options.clerkUserId, cached);
      if (offlineCacheAllowed) {
        if (!(await trustRevisionIsCurrent(cached))) throw error;
        assertAuthEvidence(authGeneration, evidenceGeneration);
        assertAuthCommitAllowed(generation);
        if (options.route) {
          await activateTrustedOffline(cached, evidenceGeneration, options.route);
          return { ...offline({ id: cached.userId, email: cached.email, personId: cached.personId }), authoritative: false };
        }
        const result = { ...offline({ id: cached.userId, email: cached.email, personId: cached.personId }), authoritative: false };
        assertAuthEvidence(authGeneration, evidenceGeneration);
        verifiedIdentity = { id: cached.userId, email: cached.email, personId: cached.personId };
        verifiedClerkUserId = cached.clerkUserId;
        clerkUserIdHydrated = true;
        setResourceIdentity(cached.userId);
        seedResource('identity', '', result, Date.now(), { offline: true });
        // A foreground revalidation of an already authenticated session may
        // lose transport without losing its verified live identity. Preserve
        // that lifecycle; cold/retained startup still promotes to trust.
        const retainedAuthenticated = options.preferLiveAuthenticatedStatus || options.preserveAuthenticatedOnProtocolFailure && options.expectedClerkEvidenceEpoch === undefined;
        if (retainedAuthenticated) { setAuthLifecycle({ status: 'authenticated' }); requestForegroundRetry(); }
        else if (authLifecycle.status !== 'authenticated') setAuthLifecycle({ status: 'trusted-offline' });
        if (browserOffline) signalOffline(); else signalReconnectRequired();
        return result;
      }
      if (!options.deferConnectionFailure) browserOffline ? signalOffline() : signalReconnectRequired();
      throw error;
    } finally {
      // Abort is cleanup only. The raced promise remains observed so a late
      // completion cannot become an unhandled rejection or a state decision.
      controller.abort();
      clerkProbeControllers.delete(controller);
      void transport?.catch(() => undefined);
    }
  })();
  const tracked = request.finally(() => { if (identityRequest?.promise === tracked) identityRequest = undefined; });
  identityRequest = { key, promise: tracked };
  return await awaitWithAbort(tracked, options.signal);
}

export async function initializeAuthLifecycle(options: { networkOnly?: boolean; clerkUserId?: string; startupFallbackMs?: number; clerkLoaded?: boolean; signedIn?: boolean; clerkEvidenceEpoch?: number; route?: AuthBootstrapRoute } = {}): Promise<AuthLifecycle> {
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
    return startClerkRestorationDeadline(options.startupFallbackMs, options.clerkEvidenceEpoch ?? clerkEvidenceEpoch, options.route);
  }
  if (!isDevelopmentAuthBypass && options.clerkLoaded === true && options.signedIn === false) { markSignedOut(); return authLifecycle; }
  // This is deliberately captured before any await. Clerk transitions and
  // revocation advance the epoch, invalidating every already-running init.
  let authEpoch = getAuthEpoch();
  const evidenceEpoch = options.clerkEvidenceEpoch ?? clerkEvidenceEpoch;
  // A foreground hint and the React Clerk effect must share one probe. The
  // networkOnly bit changes the optimization, not the request identity.
  const key = `${authEpoch}:${options.clerkUserId || ''}:${provisionalRouteKey(options.route)}`;
  if (authLifecycleRequest?.key === key) return authLifecycleRequest.promise;
  const browserOnline = typeof navigator === 'undefined' || navigator.onLine !== false;
  // `checking` is entered by the online transition. It must never take the
  // durable trust record fast path: only an authoritative /api/me response
  // may resolve this probe back to connected/authenticated.
  const forceReverify = options.networkOnly === true || (connectionState.status === 'checking' && browserOnline);
  const previousUsableLifecycle = authLifecycle.status === 'authenticated' || authLifecycle.status === 'trusted-offline' || authLifecycle.status === 'provisional' || authLifecycle.status === 'restoring' || authLifecycle.status === 'reverifying' ? authLifecycle.status : undefined;
  const previousLiveLifecycle = previousUsableLifecycle === 'authenticated' || previousUsableLifecycle === 'restoring' || previousUsableLifecycle === 'reverifying';
  const currentSessionMatches = Boolean(verifiedIdentity && verifiedClerkUserId && (options.clerkUserId === undefined || verifiedClerkUserId === options.clerkUserId));
  if (options.networkOnly === true && currentSessionMatches && (authLifecycle.status === 'authenticated' || authLifecycle.status === 'trusted-offline')) setAuthLifecycle({ status: 'reverifying' });
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
  const requestedRouteKey = options.route ? provisionalRestoreKey(authEpoch, evidenceEpoch, options.route) : undefined;
  const requestedRouteIsCurrent = () => !requestedRouteKey || !provisionalRestoreRequest || provisionalRestoreRequest.key === requestedRouteKey;
  const setRouteScopedVerificationUnavailable = (error: unknown, preserveRetainedSession = false) => {
    if (requestedRouteIsCurrent()) setVerificationUnavailable(error, options.route, preserveRetainedSession);
  };
  if (!currentSessionMatches && requestedRouteIsCurrent()) setAuthLifecycle({ status: 'checking', ...(options.route ? { privateCacheAvailable: undefined, privateCacheRouteKey: provisionalRouteKey(options.route) } : {}) });
  const sessionGeneration = captureSessionGeneration();
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
        authEpoch = advanceAuthEpoch({ reason: 'identity-mismatch', previousClerkUserId: trust.clerkUserId, clerkUserId: options.clerkUserId });
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
        const routeKey = options.route ? provisionalRestoreKey(authEpoch, evidenceEpoch, options.route) : undefined;
        const routeRequest = routeKey && provisionalRestoreRequest?.key === routeKey ? provisionalRestoreRequest : undefined;
        if (options.route && routeRequest) {
          await routeRequest.promise;
          assertAuthEvidence(authEpoch, evidenceEpoch);
          if (authLifecycle.status === 'provisional' || authLifecycle.status === 'trusted-offline') return authLifecycle;
        }
        // A route restore is authoritative for whether a provisional private
        // tree may mount. Never fall through to the old trusted-offline fast
        // path when this route's request is absent or has been superseded by
        // a newer route generation.
        if (options.route && options.route.pathname !== '/settings') {
          if (provisionalRestoreRequest && provisionalRestoreRequest.key !== routeKey) return authLifecycle;
          if (authLifecycle.status !== 'provisional') setAuthLifecycle({ status: 'provisional', privateCacheAvailable: false });
          return authLifecycle;
        }
        signalOffline();
        assertAuthEvidence(authEpoch, evidenceEpoch);
        assertAuthCommitAllowed(sessionGeneration);
        if (!(await trustRevisionIsCurrent(trust))) return authLifecycle;
        if (!offlineActivationMemoryIsCurrent(trust, evidenceEpoch, sessionGeneration, authEpoch) || !(await trustRevisionIsCurrent(trust)) || !offlineActivationMemoryIsCurrent(trust, evidenceEpoch, sessionGeneration, authEpoch)) return authLifecycle;
        const user = { id: trust.userId, email: trust.email, personId: trust.personId };
        if (!offlineActivationMemoryIsCurrent(trust, evidenceEpoch, sessionGeneration, authEpoch)) return authLifecycle;
        verifiedIdentity = user;
        verifiedClerkUserId = trust.clerkUserId;
        clerkUserIdHydrated = true;
        setResourceIdentity(user.id);
        if (!offlineActivationMemoryIsCurrent(trust, evidenceEpoch, sessionGeneration, authEpoch)) return authLifecycle;
        seedResource('identity', '', { ...offline(user), authoritative: false }, Date.now(), { offline: true });
        setAuthLifecycle({ status: 'trusted-offline' });
        return authLifecycle;
      }
      const expectedUserId = currentSessionMatches ? verifiedIdentity?.id : undefined;
      try {
        await getMe({ networkOnly: forceReverify, clerkUserId: options.clerkUserId, expectedUserId, expectedAuthEpoch: authEpoch, expectedClerkEvidenceEpoch: evidenceEpoch, startupFallbackMs: options.startupFallbackMs, deferConnectionFailure: true, preserveAuthenticatedOnProtocolFailure: previousLiveLifecycle && currentSessionMatches, preferLiveAuthenticatedStatus: options.clerkEvidenceEpoch === undefined && previousUsableLifecycle === 'authenticated', route: options.route });
      } catch (error) {
        // A Clerk session can be valid while the application cookie is absent
        // (first visit, expiry, or a cleared cookie). Bootstrap exactly here;
        // ordinary API calls never use Clerk as an authentication fallback.
        if (!options.clerkUserId || !(error instanceof ApiError) || error.status !== 401 || !isAuthEpochCurrent(authEpoch) || !isClerkEvidenceEpochCurrent(evidenceEpoch)) throw error;
        await bootstrapApplicationSession();
        await getMe({ networkOnly: false, clerkUserId: options.clerkUserId, expectedUserId, expectedAuthEpoch: authEpoch, expectedClerkEvidenceEpoch: evidenceEpoch, startupFallbackMs: options.startupFallbackMs, deferConnectionFailure: true, route: options.route });
      }
      assertAuthEvidence(authEpoch, evidenceEpoch);
      return authLifecycle;
    } catch (error) {
      // A stale init is intentionally silent. The newer lifecycle owns all
      // visible state and resource decisions.
      if (!isAuthEpochCurrent(authEpoch) || !isClerkEvidenceEpochCurrent(evidenceEpoch) || error instanceof StaleAuthInitializationError) return authLifecycle;
      if (error instanceof ApiError && error.code === 'IDENTITY_MISMATCH') {
        assertAuthEvidence(authEpoch, evidenceEpoch);
        requestTrustRevocation();
        setVerificationUnavailable(error, options.route);
      } else if (error instanceof ApiError && (error.status === 401 || error.code === 'AUTH_REQUIRED' || error.code === 'AUTH_INVALID') && options.clerkLoaded !== true) {
        assertAuthEvidence(authEpoch, evidenceEpoch);
        setAuthLifecycle({ status: 'unauthenticated' });
      } else if (isRetryableConnectionError(error) && error instanceof ApiError && error.networkFailure && (forceReverify || connectionState.status === 'checking') && (currentSessionMatches || previousUsableLifecycle)) {
        // A failed foreground revalidation must settle to a bounded,
        // explicitly offline-safe state when the active trust record exists.
        const trustRead = await boundedTrustRead();
        const trust = trustRead.timedOut ? undefined : trustRead.record;
        assertAuthEvidence(authEpoch, evidenceEpoch);
        if (trust && isOfflineTrustUsable(trust) && cachedTrustMatches(options.clerkUserId, trust) && !(options.clerkEvidenceEpoch === undefined && previousUsableLifecycle === 'authenticated')) await activateTrustedOffline(trust, evidenceEpoch, options.route);
         else if (previousUsableLifecycle === 'authenticated' && currentSessionMatches) {
           setAuthLifecycle({ status: 'authenticated' });
           requestForegroundRetry();
        } else {
          setRouteScopedVerificationUnavailable(error);
          if (browserOnline) signalReconnectRequired(); else signalOffline();
        }
      } else if (isRetryableConnectionError(error) && (currentSessionMatches || previousUsableLifecycle)) {
        // Expiry blocks a fresh offline bootstrap, but never strands a live
        // authoritative session or its queue while a refresh is unavailable.
        assertAuthEvidence(authEpoch, evidenceEpoch);
        if (browserOnline) signalReconnectRequired(); else signalOffline();
        const trustRead = await boundedTrustRead();
        assertAuthEvidence(authEpoch, evidenceEpoch);
        const trustedFallback = !trustRead.timedOut && trustRead.record && isOfflineTrustUsable(trustRead.record) && cachedTrustMatches(options.clerkUserId, trustRead.record);
        if (trustedFallback && previousUsableLifecycle === 'provisional') await activateTrustedOffline(trustRead.record!, evidenceEpoch, options.route);
         else if (previousUsableLifecycle && trustedFallback && authLifecycle.status !== previousUsableLifecycle) {
           setAuthLifecycle({ status: previousUsableLifecycle });
           if (previousUsableLifecycle === 'authenticated') requestForegroundRetry();
         } else if (!trustedFallback && previousUsableLifecycle === 'authenticated' && currentSessionMatches) {
           setAuthLifecycle({ status: 'authenticated' });
           requestForegroundRetry();
         }
        else if (!trustedFallback) setRouteScopedVerificationUnavailable(error, true);
     } else if (authLifecycle.status !== 'unauthenticated') {
         assertAuthEvidence(authEpoch, evidenceEpoch);
         setRouteScopedVerificationUnavailable(error);
      }
      return authLifecycle;
    }
  })().finally(() => { if (authLifecycleRequest?.promise === request) authLifecycleRequest = undefined; });
  authLifecycleRequest = { key, promise: request };
  return request;
}

/**
 * A failed Clerk sign-out may release only the exact barrier this tab started.
 * A newer/adopted barrier belongs to another tab and must continue fencing
 * stale responses while that tab's cleanup and masking work proceeds.
 */
export const recoverAfterClerkSignOutFailure = (cause?: unknown, automatic = false) => {
  const generation = getSessionGeneration();
  const locallyOwnedGeneration = getLocallyOwnedLogoutGeneration();
  const activeBarrier = getSessionLogoutInProgress();
  const context = logoutRecoveryContext?.generation === generation ? logoutRecoveryContext : undefined;
  const signedOut = isDefinitivelySignedOut(clerkEvidence.isLoaded, clerkEvidence.isSignedIn);
  const completeNewSession = clerkEvidence.isLoaded && clerkEvidence.isSignedIn === true && Boolean(clerkEvidence.userId && clerkEvidence.sessionId) && Boolean(context?.adoptedSessionId) && clerkEvidence.sessionId !== context?.adoptedSessionId;
  const cleanupCompleted = context?.cleanupCompleted === true || completedLogoutCleanupGeneration === generation;
  const canRecoverBarrier = activeBarrier && cleanupCompleted && (signedOut || completeNewSession);
  const ownsActiveBarrier = activeBarrier && locallyOwnedGeneration === generation;
  cancelAuthVerificationIntent();
  if (automatic && activeBarrier && !canRecoverBarrier) return false;
  const recoveredNewSession = canRecoverBarrier && completeNewSession;
  if (canRecoverBarrier && clearSessionLogout(generation, true, true)) {
    releaseMutationBarrier(generation);
    resumeOutboxAfterFailedLogout();
    logoutRecoveryContext = undefined;
  } else if (!activeBarrier) {
    // Cleanup may already have rolled back this tab's barrier before the
    // provider callback reached us. There is no remote barrier to preserve.
    releaseMutationBarrier(generation);
    resumeOutboxAfterFailedLogout();
  } else if (ownsActiveBarrier && rollbackSessionLogout(generation, true)) {
    // This tab may release only the exact barrier it started. The local data
    // remains cleared when cleanup completed, so auth stays blocked until the
    // provider sign-out is retried successfully.
    releaseMutationBarrier(generation);
    resumeOutboxAfterFailedLogout();
  }
  authBlocked = true;
  authState = { required: true, code: 'AUTH_REQUIRED' };
  const message = cause instanceof Error ? cause.message : 'Clerk sign-out could not be completed';
  if (recoveredNewSession) {
    authBlocked = false;
    allowIdentityVerification();
    authState = { required: false };
    setAuthLifecycle({ status: 'checking' });
  } else setAuthLifecycle({ status: 'unauthenticated', ...(automatic ? {} : { error: new ClerkSignOutFailure(message) }) });
  if (!automatic && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('billsplit-signout-retryable'));
  return canRecoverBarrier || !activeBarrier;
};

/** Finalize a successful Clerk sign-out only after local cleanup has completed. */
export const finalizeSuccessfulClerkSignOut = () => {
  const generation = getSessionGeneration();
  const cleared = clearSessionLogout(generation, true, true);
  if (cleared) {
    releaseMutationBarrier(generation);
    logoutRecoveryContext = undefined;
  }
  return cleared;
};

export async function clearEverythingForLogout(broadcast = true, receivedGeneration?: number) {
  const generation = receivedGeneration ?? startSessionLogout(broadcast);
  if (completedLogoutCleanupGeneration !== undefined && completedLogoutCleanupGeneration !== generation) completedLogoutCleanupGeneration = undefined;
  if (!logoutRecoveryContext || logoutRecoveryContext.generation !== generation) logoutRecoveryContext = { generation, adoptedSessionId: clerkEvidence.sessionId, cleanupCompleted: false };
  else if (receivedGeneration === undefined && !logoutRecoveryContext.adoptedSessionId) logoutRecoveryContext.adoptedSessionId = clerkEvidence.sessionId;
  if (receivedGeneration !== undefined && !isSessionGenerationCurrent(receivedGeneration)) return;
  beginLocalLogoutCleanup(generation);
  // This marker is intentionally independent of the private cache. Start it
  // before quiescing, but await it before clearing cached state. That keeps
  // the bounded outbox shutdown from being delayed by IndexedDB scheduling.
  const notificationRevocation = revokeNotificationIdentity().catch(() => undefined);
  // Invalidate in-flight authentication immediately, before waiting for the
  // outbox or IndexedDB cleanup. The final advance below also invalidates any
  // work that somehow started during the destructive boundary.
  advanceAuthEpoch({ reason: 'logout' });
  cancelAuthVerificationIntent();
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
    await notificationRevocation;
    // Logout revokes private trust and cache but deliberately preserves the
    // durable new-expense outbox. It is user-scoped and cannot replay until
    // the same internal account is authoritatively verified again.
    await clearCachedData();
  } catch (error) {
    // Keep the current authenticated UI visible when storage is unavailable.
    // Release the lock barrier so retry is possible; the session generation
    // remains advanced so old responses cannot repopulate private caches.
    cancelLocalLogoutCleanup(generation);
    releaseMutationBarrier(generation);
    resumeOutboxAfterFailedLogout();
    if (receivedGeneration === undefined) rollbackSessionLogout(generation);
    throw error;
  }
  verifiedIdentity = undefined;
  verifiedClerkUserId = undefined;
  clerkUserIdHydrated = true;
  authBlocked = true;
  advanceAuthEpoch({ reason: 'logout' });
  resetResourceIdentity();
  authState = { required: true, code: 'AUTH_REQUIRED' };
  if (logoutRecoveryContext?.generation === generation) logoutRecoveryContext.cleanupCompleted = true;
  completedLogoutCleanupGeneration = generation;
  completeLocalLogoutCleanup(generation);
  if (getSessionLogoutInProgress() && (isDefinitivelySignedOut(clerkEvidence.isLoaded, clerkEvidence.isSignedIn) || clerkEvidence.isLoaded && clerkEvidence.isSignedIn === true && Boolean(clerkEvidence.userId && clerkEvidence.sessionId))) recoverAfterClerkSignOutFailure(undefined, true);
  clearReconnectRequired();
  setAuthLifecycle({ status: 'unauthenticated' });
  if (typeof localStorage !== 'undefined') {
    try { localStorage.removeItem('dev-email'); } catch { /* Storage can be disabled. */ }
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('billsplit-cache-cleared', { detail: { clearOutbox: true, generation } }));
  broadcastSessionCoordination({ type: 'cache-clear', reason: 'cache-clear', generation, clearOutbox: true });
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
    if (result.userId) { const responseUserId = result.userId; persisted = await persistGroupsResponse({ userId: responseUserId, groups: result.data.groups, cachedAt: new Date().toISOString() }, requestGeneration, generation); }
    return persisted ? result.data : { ...result.data, stale: true };
  } catch (error) {
    assertRequestGeneration(generation);
    if (!isNetwork(error) || !identity) throw error;
    const cached = await cacheRead(() => readGroups(identity.user.id));
    if (cached) return offline({ groups: cached.groups });
    throw error;
  }
}

export async function getGroup(id: string, signal?: AbortSignal): Promise<CachedResult<GroupResponse>> {
  const generation = captureSessionGeneration();
  const identity = await requireIdentityForCache(signal);
  const requestMutationGeneration = identity ? (await cacheRead(() => readMutationGeneration(identity.user.id)) ?? 0) : 0;
  try {
    const result = await apiWithMeta<{ group: Group; members: GroupMember[]; historicalParticipants?: HistoricalParticipant[]; splitDefault?: GroupSplitDefault | null; currentPersonId?: string | null }>(`/groups/${id}`, { signal });
    assertRequestGeneration(generation); assertResponseIdentity(result.userId, identity);
    const data = { ...result.data, currentPersonId: groupCurrentPersonId(result.data.members, result.data.currentPersonId, identity?.user.personId), historicalParticipants: result.data.historicalParticipants || result.data.members.map((member) => ({ ...member, status: member.removedAt ? 'removed' as const : 'active' as const })), splitDefault: result.data.splitDefault ?? null };
    const persisted = result.userId ? await persistGroupResponse(result.userId, id, { group: data.group, members: data.members, historicalParticipants: data.historicalParticipants, splitDefault: data.splitDefault, currentPersonId: data.currentPersonId }, requestMutationGeneration, generation) : true;
    return persisted ? data : { ...data, stale: true };
  } catch (error) {
    assertRequestGeneration(generation);
    if (isGroupAuthorizationLoss(error)) { await evictRevokedGroup(id, identity); throw error; }
    if (!isNetwork(error) || !identity) throw error;
    const cached = await cacheRead(() => readGroupSnapshot(identity.user.id, id));
    if (cached?.group && cached.members) return offline({ group: cached.group, members: cached.members, currentPersonId: groupCurrentPersonId(cached.members, cached.currentPersonId, identity.user.personId), historicalParticipants: cached.historicalParticipants || cached.members.map((member) => ({ ...member, status: member.removedAt ? 'removed' as const : 'active' as const })), splitDefault: cached.splitDefault ?? null });
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

export async function updateGroupSplitDefault(id: string, input: GroupSplitDefaultInput) {
  return api<{ splitDefault: GroupSplitDefault }>(`/groups/${id}/split-default`, { method: 'PUT', body: JSON.stringify(input) });
}
export async function getGroupSplitDefaultSuggestion(id: string, signal?: AbortSignal) {
  return (await apiWithMeta<{ suggestion: GroupSplitDefault | null }>(`/groups/${id}/split-default-suggestion`, { signal })).data;
}
export async function deleteGroupSplitDefault(id: string) {
  return api<void>(`/groups/${id}/split-default`, { method: 'DELETE' });
}

export async function deleteGroup(id: string) {
  return api<void>(`/groups/${id}`, { method: 'DELETE' });
}

export async function deleteAccount(clerkUserId: string, options: { recovery?: boolean } = {}) {
  const currentClerkUserId = requireClerkUserId(clerkUserId);
  const pending = readPendingAccountDeletion();
  if (hasPendingAccountDeletion() && !pending) throw new Error('The pending account deletion marker is invalid and was not used. Explicitly discard it before starting a new deletion.');
  // This write is deliberately before the destructive request. If storage is
  // unavailable, no server mutation is dispatched and no provider cleanup can
  // be reached by the marker-driven recovery path.
  if (pending && pending.clerkUserId !== currentClerkUserId) throw new Error('The provider identity changed while account deletion was pending. Sign in with the original account to continue.');
  if (options.recovery && !pending) throw new Error('Account deletion recovery requires a valid pending marker.');
  if (pending && pending.phase !== 'server-pending') return;
  if (!pending) markAccountDeletionPending(currentClerkUserId);
  await api<void>('/account', { method: 'DELETE', body: JSON.stringify({ confirmation: 'DELETE MY ACCOUNT' }), headers: { [ACCOUNT_DELETION_EXPECTED_CLERK_USER_ID_HEADER]: currentClerkUserId } }, undefined, options.recovery ? { accountDeletionRecovery: { clerkUserId: currentClerkUserId } } : undefined);
  // A lost response can leave this phase behind. The server DELETE is
  // idempotent for the authenticated tombstoned identity, so retrying this
  // phase is safe until this marker update succeeds.
  writePendingAccountDeletion('server-deleted', currentClerkUserId);
  broadcastSessionCoordination({ type: 'account-deletion', reason: 'account-deletion', clerkUserId: currentClerkUserId, phase: 'server-deleted' });
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
export async function createTargetedGroupInvitation(groupId: string, personId: string, email: string) {
  return api<{ invitation: GroupInvitation }>(`/groups/${groupId}/members/${personId}/invitation`, { method: 'POST', body: JSON.stringify({ email }) });
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
  const requestMutationGeneration = identity ? (await cacheRead(() => readMutationGeneration(identity.user.id)) ?? 0) : 0;
  try {
     const options = { limit: 50, ...filters };
     const query = new URLSearchParams(pageParams(options));
     for (const [key, value] of expenseFilterQuery(filters).entries()) query.set(key, value);
     const result = await apiWithMeta<ExpensePage>(`/groups/${id}/expenses?${query}`, { signal });
    assertRequestGeneration(generation); assertResponseIdentity(result.userId, identity);
      if (result.userId && !hasExpenseFilters(filters)) { const persisted = await persistExpenseResponse(result.userId, id, result.data.expenses, requestMutationGeneration, generation); if (!persisted) return { ...result.data, stale: true }; const reconciled = await cacheRead(() => reconcileOutboxItems(result.userId!, id, result.data.expenses, generation, authEpoch)); if (reconciled) { await invalidateForMutation.expenseChanged(id, undefined, result.userId, generation); if (typeof window !== 'undefined') window.dispatchEvent(new Event('billsplit-outbox-changed')); } }
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
  const requestMutationGeneration = identity ? (await cacheRead(() => readMutationGeneration(identity.user.id)) ?? 0) : 0;
  try {
    const result = await apiWithMeta<{ balances: Record<string, Balances> }>(`/groups/${id}/balances`, { signal });
    assertRequestGeneration(generation); assertResponseIdentity(result.userId, identity);
    const persisted = result.userId ? await persistBalanceResponse(result.userId, id, result.data.balances, requestMutationGeneration, generation) : true;
    return persisted ? result.data : { ...result.data, stale: true };
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

export type TransactionPageOptions = TransactionFilters & { limit?: number; cursor?: string };
export async function getTransactionPage(groupId: string, options: TransactionPageOptions = {}, signal?: AbortSignal): Promise<CachedResult<TransactionPage>> {
  const generation = captureSessionGeneration();
  const authEpoch = getAuthEpoch();
  const expectedUserId = getVerifiedUserId();
  const requestMutationGeneration = expectedUserId ? (await cacheRead(() => readMutationGeneration(expectedUserId)) ?? 0) : 0;
  const query = new URLSearchParams(pageParams({ limit: options.limit ?? 25, cursor: options.cursor }));
  for (const [key, value] of transactionFilterQuery(options).entries()) query.set(key, value);
  try {
    const result = await apiWithMeta<TransactionPage>(`/groups/${groupId}/transactions?${query}`, { signal });
    assertRequestGeneration(generation);
    if (!isAuthEpochCurrent(authEpoch)) return { ...result.data, stale: true };
    if (result.userId && expectedUserId && result.userId !== expectedUserId) {
      signalAuthRequired('IDENTITY_MISMATCH');
      throw new ApiError('The verified identity changed; cached data was not used.', { status: 401, code: 'IDENTITY_MISMATCH' });
    }
    const firstUnfilteredPage = options.cursor === undefined && !hasTransactionFilters(options);
    if (result.userId && firstUnfilteredPage) {
      const persisted = await persistTransactionResponse(result.userId!, groupId, result.data.transactions, result.data.nextCursor, options.limit ?? 25, requestMutationGeneration, generation);
      if (persisted === false || !isAuthEpochCurrent(authEpoch)) return { ...result.data, stale: true };
    }
    return result.data;
  }
  catch (error) { if (isGroupAuthorizationLoss(error)) await evictRevokedGroupForCurrentUser(groupId); throw error; }
}

/** Cache only the unfiltered first history page. Cursor and filtered requests
 * deliberately use the network path above and never fall back to this row. */
export async function getTransactions(groupId: string, signal?: AbortSignal, filters: TransactionFilters = {}): Promise<CachedResult<TransactionPage>> {
  const generation = captureSessionGeneration();
  const authEpoch = getAuthEpoch();
  const identity = await requireIdentityForCache(signal);
  const requestMutationGeneration = identity ? (await cacheRead(() => readMutationGeneration(identity.user.id)) ?? 0) : 0;
  const limit = TRANSACTION_HISTORY_PAGE_LIMIT;
  const filtered = hasTransactionFilters(filters);
  const query = new URLSearchParams({ limit: String(limit) });
  for (const [key, value] of transactionFilterQuery(filters).entries()) query.set(key, value);
  try {
    const result = await apiWithMeta<TransactionPage>(`/groups/${groupId}/transactions?${query}`, { signal });
    assertRequestGeneration(generation); assertResponseIdentity(result.userId, identity);
    if (result.userId && !filtered) {
      const persisted = await persistTransactionResponse(result.userId!, groupId, result.data.transactions, result.data.nextCursor, limit, requestMutationGeneration, generation);
      const expenseRows = result.data.transactions.filter((item): item is Extract<Transaction, { kind: 'expense' }> => item.kind === 'expense');
      const reconciled = await cacheRead(() => reconcileOutboxItems(result.userId!, groupId, expenseRows, generation, authEpoch));
      if (groupId && reconciled) { await invalidateForMutation.expenseChanged(groupId, undefined, result.userId, generation); if (typeof window !== 'undefined') window.dispatchEvent(new Event('billsplit-outbox-changed')); }
      if (persisted === false) return { ...result.data, stale: true };
    }
    return result.data;
  } catch (error) {
    assertRequestGeneration(generation);
    if (isGroupAuthorizationLoss(error)) { await evictRevokedGroup(groupId, identity); throw error; }
    if (!isNetwork(error) || !identity) throw error;
    if (filtered) throw error;
    const cached = await cacheRead(() => readGroupSnapshot(identity.user.id, groupId));
    if (cached?.transactions && isSufficientTransactionHistoryPage(cached.transactionsLimit)) return offline({ transactions: cached.transactions, nextCursor: cached.transactionsNextCursor });
    throw error;
  }
}

/** Reconcile only expenses returned by an authorized transaction query. The
 * global endpoint can contain rows from several groups, so each group must be
 * reconciled independently before its pending outbox rows are removed. */
async function reconcileTransactionExpenses(userId: string, expenses: Array<Pick<Expense, 'groupId' | 'createdBy'> & { clientOperationId?: string | null }>, requestedGroupId: string | undefined, generation: number, authEpoch: number): Promise<boolean | undefined> {
  const expensesByGroup = new Map<string, typeof expenses>();
  for (const expense of expenses) {
    if (!expense.groupId || expense.createdBy !== userId || requestedGroupId && expense.groupId !== requestedGroupId) continue;
    const groupExpenses = expensesByGroup.get(expense.groupId) || [];
    groupExpenses.push(expense);
    expensesByGroup.set(expense.groupId, groupExpenses);
  }
  let changed = false;
  for (const [groupId, groupExpenses] of expensesByGroup) {
    if (!isSessionGenerationCurrent(generation) || !isAuthEpochCurrent(authEpoch)) return undefined;
    const removed = await cacheRead(() => reconcileOutboxItems(userId, groupId, groupExpenses, generation, authEpoch));
    if (!isSessionGenerationCurrent(generation) || !isAuthEpochCurrent(authEpoch)) return undefined;
    if (!removed) continue;
    await invalidateForMutation.expenseChanged(groupId, undefined, userId, generation);
    if (!isSessionGenerationCurrent(generation) || !isAuthEpochCurrent(authEpoch)) return undefined;
    changed = true;
  }
  return changed;
}

/** Canonical history API. A selected group remains scoped to its snapshot;
 * only the all-groups first page gets the account-scoped global cache. */
export async function getGlobalTransactionPage(groupId: string | undefined, options: TransactionPageOptions = {}, signal?: AbortSignal): Promise<CachedResult<TransactionPage>> {
  const generation = captureSessionGeneration();
  const authEpoch = getAuthEpoch();
  const identity = await requireIdentityForCache(signal);
  const requestMutationGeneration = identity ? (await cacheRead(() => readMutationGeneration(identity.user.id)) ?? 0) : 0;
  const filtered = hasTransactionFilters(options);
  const query = new URLSearchParams(pageParams({ limit: options.limit ?? 25, cursor: options.cursor }));
  for (const [key, value] of transactionFilterQuery(options).entries()) query.set(key, value);
  if (groupId) query.set('group', groupId);
  try {
    const result = await apiWithMeta<TransactionPage>(`/transactions?${query}`, { signal });
    assertRequestGeneration(generation); assertResponseIdentity(result.userId, identity);
    if (!isAuthEpochCurrent(authEpoch)) return { ...result.data, stale: true };
    const firstUnfiltered = options.cursor === undefined && !filtered;
    if (result.userId && firstUnfiltered) {
      const saved = groupId
        ? await cacheWrite(() => updateGroupSnapshotIfGenerationMatches(result.userId!, groupId, { transactions: result.data.transactions, transactionsNextCursor: result.data.nextCursor, transactionsLimit: options.limit ?? 25 }, requestMutationGeneration, generation))
        : await cacheWrite(() => saveGlobalTransactions({ userId: result.userId!, transactions: result.data.transactions, nextCursor: result.data.nextCursor, limit: options.limit ?? 25, fetchedAt: new Date().toISOString() }, generation, requestMutationGeneration));
      if (saved === false || !isAuthEpochCurrent(authEpoch)) return { ...result.data, stale: true };
      const expenseRows = result.data.transactions.filter((item): item is Extract<Transaction, { kind: 'expense' }> => item.kind === 'expense');
      const reconciled = await reconcileTransactionExpenses(result.userId!, expenseRows, groupId, generation, authEpoch);
      if (reconciled === undefined) return { ...result.data, stale: true };
      if (reconciled && typeof window !== 'undefined') window.dispatchEvent(new Event('billsplit-outbox-changed'));
    }
    return result.data;
  } catch (error) {
    assertRequestGeneration(generation);
    if (groupId && isGroupAuthorizationLoss(error)) { await evictRevokedGroup(groupId, identity); throw error; }
    if (!isNetwork(error) || !identity || filtered || options.cursor !== undefined) throw error;
    if (groupId) {
      const cached = await cacheRead(() => readGroupSnapshot(identity.user.id, groupId));
      if (cached?.transactions && isSufficientTransactionHistoryPage(cached.transactionsLimit)) return offline({ transactions: cached.transactions, nextCursor: cached.transactionsNextCursor });
    } else {
      const cached = await cacheRead(() => readGlobalTransactions(identity.user.id));
      if (cached && isSufficientTransactionHistoryPage(cached.limit)) return offline({ transactions: cached.transactions, nextCursor: cached.nextCursor });
    }
    throw error;
  }
}

export async function getSettlements(id: string, signal?: AbortSignal): Promise<CachedResult<SettlementPage>> {
  const generation = captureSessionGeneration();
  const identity = await requireIdentityForCache(signal);
  const requestMutationGeneration = identity ? (await cacheRead(() => readMutationGeneration(identity.user.id)) ?? 0) : 0;
  try {
     const result = await apiWithMeta<SettlementPage>(`/groups/${id}/settlements?limit=50`, { signal });
    assertRequestGeneration(generation); assertResponseIdentity(result.userId, identity);
     const persisted = result.userId ? await persistSettlementResponse(result.userId, id, result.data.settlements, requestMutationGeneration, generation) : true;
     return persisted ? result.data : { ...result.data, stale: true };
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
  const requestMutationGeneration = identity ? (await cacheRead(() => readMutationGeneration(identity.user.id)) ?? 0) : 0;
  try {
    const result = await apiWithMeta<{ expense: Expense; history: Array<{ id: string; revision: number; createdAt: string }> }>(`/expenses/${id}`, { signal });
    assertRequestGeneration(generation); assertResponseIdentity(result.userId, identity);
    const persisted = result.userId ? await persistExpenseDetailsResponse({ userId: result.userId!, expenseId: id, expense: result.data.expense, history: result.data.history, fetchedAt: new Date().toISOString() }, requestMutationGeneration, generation) : true;
    return persisted ? result.data : { ...result.data, stale: true };
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
    if (result.userId) await persistActivityResponse({ userId: result.userId!, groupId: id || 'all', activity: data.activity, fetchedAt: new Date().toISOString() }, generation, requestMutationGeneration);
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
    if (result.userId) await persistCategoriesResponse({ userId: result.userId!, categories: result.data.categories, fetchedAt: new Date().toISOString() }, generation, requestMutationGeneration);
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
  const authenticatedPersonId = await cachedPersonIdForUser(userId);
  return cached?.group && cached.members ? { data: { group: cached.group, members: cached.members, currentPersonId: groupCurrentPersonId(cached.members, cached.currentPersonId, authenticatedPersonId), historicalParticipants: cached.historicalParticipants || cached.members.map((member) => ({ ...member, status: member.removedAt ? 'removed' as const : 'active' as const })), splitDefault: cached.splitDefault ?? null }, fetchedAt: cacheTimestamp(cached.cachedAtByResource?.group || cached.cachedAt), offline: true } : undefined;
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
export async function hydrateTransactions(userId: string, id: string) {
  const cached = await cacheRead(() => readGroupSnapshot(userId, id));
  return cached?.transactions && isSufficientTransactionHistoryPage(cached.transactionsLimit) ? { data: { transactions: cached.transactions, nextCursor: cached.transactionsNextCursor }, fetchedAt: cacheTimestamp(cached.cachedAtByResource?.transactions || cached.cachedAt), offline: true } : undefined;
}
export async function hydrateGlobalTransactions(userId: string) {
  const cached = await cacheRead(() => readGlobalTransactions(userId));
  return cached && isSufficientTransactionHistoryPage(cached.limit) ? { data: { transactions: cached.transactions, nextCursor: cached.nextCursor }, fetchedAt: cacheTimestamp(cached.fetchedAt), offline: true } : undefined;
}
/** The overview has its own exact resource key and only renders five rows.
 * Keep it separate from the full history hydrator so the overview can use the
 * same persisted group snapshot without inventing a second cache format. */
export async function hydrateTransactionOverview(userId: string, id: string) {
  const cached = await cacheRead(() => readGroupSnapshot(userId, id));
  return cached?.transactions ? { data: { transactions: cached.transactions.slice(0, 5), nextCursor: cached.transactionsNextCursor }, fetchedAt: cacheTimestamp(cached.cachedAtByResource?.transactions || cached.cachedAt), offline: true } : undefined;
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

if (typeof window !== 'undefined') window.addEventListener('billsplit-cache-cleared', (event) => {
  // Logout and cross-tab coordination perform their own fenced cleanup before
  // dispatching this UI/cache notification. Only the manual local Settings
  // event (which has no detail) needs the local auth invalidation here.
  if ((event as CustomEvent<{ generation?: number; type?: string }>).detail?.generation !== undefined || (event as CustomEvent<{ type?: string }>).detail?.type === 'cache-clear') return;
  startupCacheToken += 1;
  advanceAuthEpoch({ reason: 'cache-clear' });
  cancelAuthVerificationIntent();
  cancelClerkProbes();
  verifiedIdentity = undefined;
  verifiedClerkUserId = undefined;
  clerkUserIdHydrated = true;
});
if (typeof window !== 'undefined') window.addEventListener('billsplit-resource-invalidated', () => { startupCacheToken += 1; });
subscribeSessionCoordination((message) => {
  if (message.type === 'auth-invalidation' && message.reason === 'account-switch') {
    if (!clerkEvidenceKnown || !clerkEvidence.isLoaded || isIncompleteSignedInEvidence(clerkEvidence)) {
      // A cold-start replay is only a shared fence until Clerk tells us which
      // account this tab actually has. Never turn that ordering window into a
      // terminal verification failure or cancel the first provider bootstrap.
      holdSharedAuthInvalidation(message);
      return;
    }
    const completeTargetEvidence = Boolean(
      message.clerkUserId
      && clerkEvidenceAuthoritative
      && clerkEvidence.isLoaded
      && clerkEvidence.isSignedIn === true
      && clerkEvidence.userId === message.clerkUserId
      && clerkEvidence.sessionId,
    );
    // A target-labelled transition may already have arrived after this tab
    // completed its own A -> B provider transition. Do not revoke B's valid
    // probe (or turn a blocked/reverifying B tab terminal); its old-data fence
    // is already satisfied because it has no retained A identity, or it is
    // explicitly bound to the same target Clerk user.
    if (completeTargetEvidence && (!verifiedClerkUserId || verifiedClerkUserId === message.clerkUserId)) {
      if (authLifecycle.status === 'verification-unavailable') {
        void Promise.resolve().then(() => coordinateAuthBootstrap(clerkEvidence, { networkOnly: true, force: true }));
      }
      return;
    }
    if (message.clerkUserId && isCompleteSignedInEvidence(clerkEvidence) && (clerkEvidence.userId !== message.clerkUserId || verifiedClerkUserId !== undefined && verifiedClerkUserId !== message.clerkUserId)) {
      holdSharedAuthInvalidation(message, true);
      return;
    }
    // A message without a target, or one whose target is not this tab's
    // complete provider evidence, is intentionally conservative: recipients
    // still on the previous account or on incomplete evidence mask immediately.
    // The sender includes previousClerkUserId so the message records which
    // account is being invalidated rather than treating the target as the old
    // identity. Nonce delivery deduplication makes the BC/storage pair one
    // transition, while persisted latest state protects delayed commits.
    revokeForClerkSessionChange(false);
    return;
  }
  if (message.type === 'account-deletion') {
    if (message.clerkUserId && clerkEvidenceKnown && clerkEvidence.isLoaded && clerkEvidence.isSignedIn === true && clerkEvidence.userId && clerkEvidence.userId !== message.clerkUserId) return;
    requestTrustRevocation();
    cancelAuthVerificationIntent();
    cancelClerkRestorationDeadline();
    advanceAuthEpoch({ reason: 'account-deletion', clerkUserId: message.clerkUserId });
    authBlocked = true;
    blockResourceIdentity(new ApiError('Account deletion is in progress.', { status: 401, code: 'AUTH_REQUIRED' }));
    setAuthLifecycle({ status: 'verification-unavailable', error: new ApiError('Account deletion is in progress.', { code: 'AUTH_REQUIRED' }) });
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('billsplit-account-deletion-pending'));
    return;
  }
  if (message.type === 'cache-clear') {
    startupCacheToken += 1;
    advanceAuthEpoch({ reason: 'cache-clear' });
    cancelAuthVerificationIntent();
    cancelClerkProbes();
    verifiedIdentity = undefined;
    verifiedClerkUserId = undefined;
    clerkUserIdHydrated = true;
    resetResourceIdentity();
    blockResourceIdentity(new ApiError('Cached private data was cleared in another tab.', { status: 401, code: 'AUTH_REQUIRED' }));
    setAuthLifecycle({ status: 'checking' });
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('billsplit-cache-cleared', { detail: message }));
  }
});
subscribeSessionLogout((generation) => {
  if (isSessionLogoutAdopted()) logoutRecoveryContext = { generation, adoptedSessionId: clerkEvidence.sessionId, cleanupCompleted: false };
  void clearEverythingForLogout(false, generation);
});
