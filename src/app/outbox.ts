import { api, ApiError, getAuthEpoch, getAuthLifecycle, getConnectionState, getVerifiedUserId, hasRetainedPrivateSession, resumeAuthVerification, isAuthEpochCurrent, isUsableConnection, subscribeAuthLifecycle, subscribeConnectionState } from './api';
import {
  claimOutboxItem, discardOutboxIfIdle, isOfflineTrustUsable, listOutbox, markOutboxAuthRequired, readOfflineTrust, readOutboxItem, rebindOutboxAuthEpoch,
  reactivateAuthRequired, recoverStaleSyncing, releaseOutboxClaimIfOwned, removeOutboxIfOwned, resetOutboxIfIdle, saveOutboxItem, updateOutboxIfOwned,
  type ExpenseOutboxItem, type OutboxOperationScope, type OutboxStatus,
} from './idb';
import type { ExpenseInput } from '../shared/schemas';
import { invalidateForMutation } from './resource-cache';
import { registerLogoutCoordinator } from './logout-coordination';
import { captureSessionGeneration, getSessionLogoutInProgress, subscribeSessionLogout } from './session';

export type { ExpenseOutboxItem } from './idb';
export const OUTBOX_LEASE_MS = 30_000;
export const OUTBOX_REQUEST_TIMEOUT_MS = 15_000;
export const OUTBOX_IDB_DEADLINE_MS = 500;
export const OUTBOX_LOGOUT_DEADLINE_MS = 750;

type OutboxListener = () => void;
const listeners = new Set<OutboxListener>();
const owner = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `tab-${Date.now()}-${Math.random()}`;
let flushPromise: Promise<void> | undefined;
let initialized = false;
let initializationPromise: Promise<void> | undefined;
let snapshot: ExpenseOutboxItem[] = [];
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let connectionRecoveryTimer: ReturnType<typeof setTimeout> | undefined;
let connectionRecoveryPromise: Promise<void> | undefined;
let connectionRecoveryAttempts = 0;
const resumeRecoveryPromises = new Map<number, Promise<void>>();
const completedResumeIds = new Set<number>();
let flushAgain = false;
let logoutQuiescing = getSessionLogoutInProgress();
const activeControllers = new Set<AbortController>();
const activeClaims = new Set<string>();
const leaseRecoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
let scheduleTimer = (callback: () => void, delay: number) => setTimeout(callback, delay);
let clearTimer = (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer);
export const RETRY_BASE_DELAY_MS = 1_000;
export const RETRY_MAX_DELAY_MS = 60_000;

const notify = () => listeners.forEach((listener) => listener());
const canFlush = () => getAuthLifecycle().status === 'authenticated' && isUsableConnection();
const currentOutboxUserId = () => getAuthLifecycle().status === 'authenticated' ? getVerifiedUserId() : undefined;
const bounded = <T>(promise: Promise<T>, timeoutMs = OUTBOX_IDB_DEADLINE_MS): Promise<T | undefined> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), timeoutMs); });
  void promise.catch(() => undefined);
  return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
};
type BoundedResult<T> = { timedOut: false; value: T } | { timedOut: true; late: Promise<T> };
const boundedResult = <T>(promise: Promise<T>, timeoutMs = OUTBOX_IDB_DEADLINE_MS): Promise<BoundedResult<T>> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = promise;
  void late.catch(() => undefined);
  const timeout = new Promise<BoundedResult<T>>((resolve) => { timer = setTimeout(() => resolve({ timedOut: true, late }), timeoutMs); });
  return Promise.race([late.then((value) => ({ timedOut: false, value } as const)), timeout]).finally(() => { if (timer) clearTimeout(timer); });
};
export const retryDelay = (attempts: number) => Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * (2 ** Math.max(0, Math.min(attempts - 1, 6))));
const scheduleRetry = (attempts: number) => {
  const delay = retryDelay(attempts);
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = scheduleTimer(() => { retryTimer = undefined; void flushOutbox(); }, delay);
};
export const cancelScheduledRetry = () => {
  if (retryTimer) { clearTimer(retryTimer); retryTimer = undefined; }
  if (connectionRecoveryTimer) { clearTimer(connectionRecoveryTimer); connectionRecoveryTimer = undefined; }
};
export function setRetrySchedulerForTests(schedule: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>, clear: (timer: ReturnType<typeof setTimeout>) => void) { const previous = { schedule: scheduleTimer, clear: clearTimer }; scheduleTimer = schedule; clearTimer = clear; return () => { scheduleTimer = previous.schedule; clearTimer = previous.clear; }; }

const leaseKey = (item: Pick<ExpenseOutboxItem, 'userId' | 'clientOperationId'>) => `${item.userId}:${item.clientOperationId}`;
const clearLeaseRecovery = (item: Pick<ExpenseOutboxItem, 'userId' | 'clientOperationId'>) => {
  const key = leaseKey(item);
  const timer = leaseRecoveryTimers.get(key);
  if (timer) clearTimer(timer);
  leaseRecoveryTimers.delete(key);
};
const scheduleLeaseRecovery = (item: Pick<ExpenseOutboxItem, 'userId' | 'clientOperationId' | 'leaseExpiresAt'>) => {
  clearLeaseRecovery(item);
  if (item.leaseExpiresAt === undefined) return;
  const key = leaseKey(item);
  const timer = scheduleTimer(() => {
    leaseRecoveryTimers.delete(key);
    if (logoutQuiescing || getSessionLogoutInProgress()) return;
    const authEpoch = getAuthLifecycle().status === 'authenticated' && currentOutboxUserId() === item.userId ? getAuthEpoch() : undefined;
    const allowed = authEpoch === undefined ? undefined : () => isAuthEpochCurrent(authEpoch) && getAuthLifecycle().status === 'authenticated' && currentOutboxUserId() === item.userId;
    void recoverStaleSyncing(item.userId, undefined, authEpoch, allowed || (() => true)).then(() => refreshOutbox()).then(() => {
      if (canFlush() && (typeof document === 'undefined' || document.visibilityState === 'visible')) return flushOutbox();
      return undefined;
    }).catch(() => undefined);
  }, Math.max(0, item.leaseExpiresAt - Date.now()) + 1);
  leaseRecoveryTimers.set(key, timer);
};

const hasQueuedWork = () => snapshot.some((item) => item.status === 'pending' || item.status === 'syncing' || item.status === 'auth-required');
const scheduleConnectionRecovery = (delay = retryDelay(connectionRecoveryAttempts + 1)) => {
  // The in-memory snapshot is intentionally cleared while authentication is
  // checking, so it is not a durable indication that the queue is empty.
  // Let the recovery pass reload IDB before deciding whether there is work.
  if (connectionRecoveryTimer || logoutQuiescing || getSessionLogoutInProgress()) return;
  connectionRecoveryTimer = scheduleTimer(() => {
    connectionRecoveryTimer = undefined;
    void recoverConnection();
  }, delay);
};

/**
 * Reverify the live identity before allowing the queue to send. This is also
 * used as a polling fallback: browsers and embedded webviews do not always
 * deliver an `online` event when connectivity returns.
 */
export async function recoverConnection(options: { resumeId?: number; alreadyVerified?: boolean } = {}) {
  if (connectionRecoveryPromise || logoutQuiescing || getSessionLogoutInProgress()) return;
  // Auth-resume completion is ordered through handleAuthenticatedUser. Do not
  // consume its ID here: the authenticated event may still be reactivating
  // auth-required rows in IndexedDB.
  if (options.resumeId !== undefined && options.alreadyVerified) return;
  // Rebuild the queue from its durable per-user store first. In particular,
  // this handles authenticated/trusted-offline -> checking -> failed probe ->
  // trusted-offline, where the visible snapshot is deliberately revoked while
  // the identity is being checked.
  await refreshOutbox();
  if (!hasQueuedWork()) return;
  const lifecycle = getAuthLifecycle().status;
  if (lifecycle !== 'authenticated' && lifecycle !== 'trusted-offline') return;
  connectionRecoveryPromise = (async () => {
    const browserOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
    if (browserOffline) {
      connectionRecoveryAttempts += 1;
      scheduleConnectionRecovery(retryDelay(connectionRecoveryAttempts));
      return;
    }
    try {
      if (!options.alreadyVerified) await resumeAuthVerification({ networkOnly: true, startupFallbackMs: OUTBOX_REQUEST_TIMEOUT_MS });
      if (getAuthLifecycle().status === 'authenticated' && isUsableConnection()) {
        connectionRecoveryAttempts = 0;
        await flushOutbox();
      } else {
        connectionRecoveryAttempts += 1;
        scheduleConnectionRecovery(retryDelay(connectionRecoveryAttempts));
      }
    } catch {
      connectionRecoveryAttempts += 1;
      scheduleConnectionRecovery(retryDelay(connectionRecoveryAttempts));
    }
  })().finally(() => { connectionRecoveryPromise = undefined; });
  await connectionRecoveryPromise;
}
export async function refreshOutbox() {
  if (logoutQuiescing || getSessionLogoutInProgress()) return;
  // Keep the matching queue visible while Clerk is waking, but never reload
  // or send it until the lifecycle is authenticated again.
  if ((getAuthLifecycle().status === 'restoring' || getAuthLifecycle().status === 'reverifying') && hasRetainedPrivateSession()) return;
  let next: ExpenseOutboxItem[] = [];
  const capturedEpoch = getAuthEpoch();
  try {
    const lifecycle = getAuthLifecycle().status;
    let trust;
    if (lifecycle === 'provisional' || lifecycle === 'trusted-offline') {
      const trustRead = await boundedResult(readOfflineTrust());
      if (trustRead.timedOut) { void trustRead.late.then(() => refreshOutbox()).catch(() => undefined); return; }
      trust = trustRead.value;
    }
    const userId = lifecycle === 'authenticated' ? currentOutboxUserId() : trust && isOfflineTrustUsable(trust) ? trust.userId : undefined;
    if (userId) {
       const listed = await boundedResult(listOutbox(userId));
       // A storage deadline is not an empty result. Keep the last visible
       // snapshot until a real list completes.
       if (listed.timedOut) { void listed.late.then(() => refreshOutbox()).catch(() => undefined); return; }
       next = listed.value;
      if (!isAuthEpochCurrent(capturedEpoch) || (lifecycle === 'authenticated' && currentOutboxUserId() !== userId)) return;
    }
  } catch { /* Keep an unavailable cache from breaking the shell. */ }
  for (const item of next) item.status === 'syncing' ? scheduleLeaseRecovery(item) : clearLeaseRecovery(item);
  for (const item of snapshot) if (!next.some((current) => leaseKey(current) === leaseKey(item))) clearLeaseRecovery(item);
  if (JSON.stringify(next) !== JSON.stringify(snapshot)) { snapshot = next; notify(); }
}
const updateSnapshot = (item: ExpenseOutboxItem | undefined) => { if (!item || (getAuthLifecycle().status === 'authenticated' && currentOutboxUserId() !== item.userId)) return; item.status === 'syncing' ? scheduleLeaseRecovery(item) : clearLeaseRecovery(item); snapshot = snapshot.some((current) => current.userId === item.userId && current.clientOperationId === item.clientOperationId) ? snapshot.map((current) => current.userId === item.userId && current.clientOperationId === item.clientOperationId ? item : current) : [...snapshot, item]; notify(); };
export const subscribeOutbox = (listener: OutboxListener) => { listeners.add(listener); void initializeOutbox(); return () => { listeners.delete(listener); }; };
export const getOutboxSnapshot = () => snapshot;
export const pendingCount = () => snapshot.length;

export async function initializeOutbox() {
  if (logoutQuiescing || getSessionLogoutInProgress()) return;
  if (!initialized) {
    initialized = true;
    initializationPromise = (async () => { try { const userId = currentOutboxUserId(); await bounded(recoverStaleSyncing(userId)); } catch { /* surfaced when enqueueing; UI remains usable online. */ } await refreshOutbox(); })();
  }
  if (initializationPromise) await initializationPromise;
  return flushOutbox();
}

export async function enqueueExpense(input: { userId: string; groupId: string; payload: ExpenseInput; display: ExpenseOutboxItem['display']; clientOperationId: string }): Promise<ExpenseOutboxItem> {
  if (logoutQuiescing || getSessionLogoutInProgress()) throw new ApiError('Logout is in progress. Try again after signing in.', { code: 'AUTH_REQUIRED', status: 401 });
  const lifecycle = getAuthLifecycle().status;
  const trustedUserId = lifecycle === 'provisional' || lifecycle === 'trusted-offline' ? (await bounded(readOfflineTrust())) : undefined;
  const allowedUserId = lifecycle === 'authenticated' ? currentOutboxUserId() : trustedUserId && isOfflineTrustUsable(trustedUserId) ? trustedUserId.userId : undefined;
  if (allowedUserId !== input.userId) throw new ApiError('The verified account changed before this expense was queued.', { code: 'IDENTITY_MISMATCH', status: 401 });
   const generation = captureSessionGeneration();
   const authEpoch = getAuthEpoch();
   const now = new Date().toISOString();
    const item: ExpenseOutboxItem = { ...input, authEpoch, createdAt: now, updatedAt: now, status: 'pending', attempts: 0, deliveryUncertain: false };
   const saved = await saveOutboxItem(item, generation, authEpoch, () => isAuthEpochCurrent(authEpoch) && getAuthLifecycle().status === lifecycle && allowedUserId === input.userId && (lifecycle !== 'authenticated' || currentOutboxUserId() === input.userId));
   if (!saved) throw new ApiError('The verified account changed before this expense was queued.', { code: 'IDENTITY_MISMATCH', status: 401 });
   snapshot = [...snapshot.filter((existing) => !(existing.userId === item.userId && existing.clientOperationId === item.clientOperationId)), item].sort((a, b) => a.createdAt.localeCompare(b.createdAt)); notify();
  await invalidateForMutation.expenseChanged(item.groupId, undefined, item.userId, generation);
  return item;
}

const errorDetails = (error: ApiError) => ({ code: error.code, message: error.message, status: error.status });
const isRetryable = (error: ApiError) => error.networkFailure || error.code === 'NETWORK_TIMEOUT' || error.status === 408 || error.status === 429 || (error.status !== undefined && error.status >= 500);
const scopeFor = (item: Pick<ExpenseOutboxItem, 'userId'>, expectedAuthEpoch: number): OutboxOperationScope => ({ userId: item.userId, expectedAuthEpoch });
const scopeForCurrentAuthenticatedUser = (item: Pick<ExpenseOutboxItem, 'userId'>, scope: OutboxOperationScope): OutboxOperationScope => {
  const currentEpoch = getAuthEpoch();
  return getAuthLifecycle().status === 'authenticated' && currentOutboxUserId() === item.userId && currentEpoch !== scope.expectedAuthEpoch
    ? { ...scope, rebindAuthEpoch: currentEpoch }
    : scope;
};

const reconcileLateClaim = async (claim: ExpenseOutboxItem, generation: number, scope: OutboxOperationScope) => {
  try {
    const releaseScope = scopeForCurrentAuthenticatedUser(claim, scope);
    const released = await releaseOutboxClaimIfOwned(claim.clientOperationId, owner, claim.leaseExpiresAt ?? 0, claim.attempts, Date.now(), generation, releaseScope);
    if (!released) { await refreshOutbox(); return; }
    updateSnapshot(released);
    if (getAuthLifecycle().status === 'authenticated' && currentOutboxUserId() === claim.userId && canFlush() && !logoutQuiescing && !getSessionLogoutInProgress() && (typeof document === 'undefined' || document.visibilityState === 'visible')) void flushOutbox();
    else await refreshOutbox();
  } catch { await refreshOutbox(); }
};

async function syncItem(item: ExpenseOutboxItem, timeoutMs = OUTBOX_REQUEST_TIMEOUT_MS) {
  if (logoutQuiescing || getSessionLogoutInProgress()) return undefined;
  const generation = captureSessionGeneration();
  const authEpoch = getAuthEpoch();
  if (!isAuthEpochCurrent(authEpoch) || !canFlush()) return undefined;
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return undefined;
   const claimResult = await boundedResult(claimOutboxItem(item.clientOperationId, owner, Date.now(), OUTBOX_LEASE_MS, generation, scopeFor(item, authEpoch)));
    if (claimResult.timedOut) { void claimResult.late.then((lateClaim) => lateClaim ? reconcileLateClaim(lateClaim, generation, scopeFor(item, authEpoch)) : undefined).catch(() => undefined); return undefined; }
   const claimed = claimResult.value;
   if (!claimed) return undefined;
   const scope = scopeFor(claimed, authEpoch);
  activeClaims.add(claimed.clientOperationId);
   if (logoutQuiescing || getSessionLogoutInProgress() || !isAuthEpochCurrent(authEpoch) || !canFlush()) {
      await bounded(updateOutboxIfOwned(claimed.clientOperationId, owner, { status: 'pending', leaseOwner: undefined, leaseExpiresAt: undefined }, Date.now(), generation, scopeForCurrentAuthenticatedUser(claimed, scope)));
     activeClaims.delete(claimed.clientOperationId);
     return undefined;
   }
  updateSnapshot(claimed);
  const controller = new AbortController();
  activeControllers.add(controller);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
       await bounded(updateOutboxIfOwned(claimed.clientOperationId, owner, { status: 'pending', leaseOwner: undefined, leaseExpiresAt: undefined }, Date.now(), generation, scopeForCurrentAuthenticatedUser(claimed, scope)));
      return undefined;
    }
     // This second check is immediately before dispatch. A trusted-offline
     // lifecycle can queue rows, but it can never send them.
      if (!isAuthEpochCurrent(authEpoch) || getAuthLifecycle().status !== 'authenticated' || currentOutboxUserId() !== claimed.userId || logoutQuiescing || getSessionLogoutInProgress()) {
         await bounded(updateOutboxIfOwned(claimed.clientOperationId, owner, { status: 'pending', leaseOwner: undefined, leaseExpiresAt: undefined }, Date.now(), generation, scopeForCurrentAuthenticatedUser(claimed, scope)));
       return undefined;
     }
      const request = api(`/groups/${claimed.groupId}/expenses`, { method: 'POST', body: JSON.stringify(claimed.payload), signal: controller.signal, headers: { 'X-BillSplit-Expected-User-Id': claimed.userId } }, authEpoch);
     // Abort is only an accelerator. Race the logical deadline as well: a
     // fetch/IDB implementation may ignore AbortSignal forever.
     const timeout = new Promise<never>((_resolve, reject) => setTimeout(() => reject(new ApiError('The sync request timed out.', { code: 'NETWORK_TIMEOUT', networkFailure: true })), timeoutMs));
     void request.catch(() => undefined);
     await Promise.race([request, timeout]);
        if (!isAuthEpochCurrent(authEpoch)) {
          // The transport has settled now, so another tab may safely claim it.
          // Until this point the old lease deliberately remains in place.
            if (!logoutQuiescing && !getSessionLogoutInProgress()) {
              const settledScope = scopeForCurrentAuthenticatedUser(claimed, scope);
              const updated = await bounded(updateOutboxIfOwned(claimed.clientOperationId, owner, { status: 'pending', leaseOwner: undefined, leaseExpiresAt: undefined }, Date.now(), generation, settledScope));
              if (updated && settledScope.rebindAuthEpoch !== undefined && canFlush()) void flushOutbox();
            }
          return undefined;
        }
      await bounded(invalidateForMutation.expenseChanged(claimed.groupId, undefined, claimed.userId, generation));
       const removedResult = await boundedResult(removeOutboxIfOwned(claimed.clientOperationId, owner, Date.now(), generation, scope));
       if (removedResult.timedOut) { void removedResult.late.then(() => refreshOutbox()).catch(() => undefined); await refreshOutbox(); return undefined; }
       const removed = removedResult.value;
     if (removed) { snapshot = snapshot.filter((current) => !(current.userId === claimed.userId && current.clientOperationId === claimed.clientOperationId)); notify(); }
    else await refreshOutbox();
    return 'removed' as const;
     } catch (error) {
      if (logoutQuiescing || getSessionLogoutInProgress()) return undefined;
      if (!isAuthEpochCurrent(authEpoch)) {
        // Catch means the transport is settled (including an abort). Do not
        // release this lease from the auth-downgrade observer itself.
        const currentAuthWasRevoked = getAuthLifecycle().status === 'unauthenticated' && error instanceof ApiError && (error.status === 401 || error.status === 403 || error.code === 'AUTH_REQUIRED' || error.code === 'AUTH_INVALID');
        const settledPatch = currentAuthWasRevoked
          ? { status: 'auth-required' as const, lastError: { code: 'AUTH_REQUIRED', message: 'Sign in to sync this expense.', status: 401 }, leaseOwner: undefined, leaseExpiresAt: undefined }
          : { status: 'pending' as const, leaseOwner: undefined, leaseExpiresAt: undefined };
          const settledScope = scopeForCurrentAuthenticatedUser(claimed, scope);
          const updated = await bounded(updateOutboxIfOwned(claimed.clientOperationId, owner, settledPatch, Date.now(), generation, settledScope));
         if (updated) {
           updateSnapshot(updated);
           if (settledScope.rebindAuthEpoch !== undefined && canFlush() && !logoutQuiescing && !getSessionLogoutInProgress()) void flushOutbox();
         }
         return currentAuthWasRevoked ? 'auth-required' as const : undefined;
      }
     const apiError = timedOut ? new ApiError('The sync request timed out.', { code: 'NETWORK_TIMEOUT', networkFailure: true }) : error instanceof ApiError ? error : new ApiError('Unable to sync expense.', { networkFailure: true, code: 'NETWORK_ERROR' });
     const ambiguous = apiError.status === undefined || apiError.networkFailure || apiError.code === 'NETWORK_TIMEOUT' || apiError.status === 408 || apiError.status === 429 || (apiError.status !== undefined && apiError.status >= 500);
      const status: OutboxStatus = apiError.status === 401 || apiError.status === 403 || apiError.code === 'AUTH_REQUIRED' || apiError.code === 'AUTH_INVALID' || apiError.code === 'IDENTITY_MISMATCH' || apiError.code === 'AUTH_IDENTITY_CONFLICT' ? 'auth-required' : isRetryable(apiError) ? 'pending' : 'failed';
      // A timed-out send is delivery-uncertain. Keep the lease until it
      // expires so another tab cannot immediately duplicate a possibly
      // committed idempotent operation.
      const patch = timedOut
        ? { status: 'syncing' as const, deliveryUncertain: true, leaseOwner: owner, leaseExpiresAt: Date.now() + OUTBOX_LEASE_MS, lastError: errorDetails(apiError) }
        : { status, deliveryUncertain: ambiguous, leaseOwner: undefined, leaseExpiresAt: undefined, lastError: errorDetails(apiError) };
       const updated = await bounded(updateOutboxIfOwned(claimed.clientOperationId, owner, patch, Date.now(), generation, scope));
      if (ambiguous) await bounded(invalidateForMutation.expenseChanged(claimed.groupId, undefined, claimed.userId, generation));
    if (updated) updateSnapshot(updated); else await refreshOutbox();
    return status;
     } finally { clearTimeout(timer); activeControllers.delete(controller); activeClaims.delete(claimed.clientOperationId); }
}

async function markAuthRequired(userId: string, error: ApiError, expectedAuthEpoch: number) {
  if (currentOutboxUserId() !== userId) return;
  await bounded(recoverStaleSyncing(userId, expectedAuthEpoch));
  await bounded(markOutboxAuthRequired(userId, errorDetails(error), expectedAuthEpoch));
  await refreshOutbox();
}

export async function flushOutbox(timeoutMs = OUTBOX_REQUEST_TIMEOUT_MS) {
   if (!canFlush() || logoutQuiescing || getSessionLogoutInProgress()) {
     if (!logoutQuiescing && !getSessionLogoutInProgress() && (getAuthLifecycle().status === 'authenticated' || getAuthLifecycle().status === 'trusted-offline')) scheduleConnectionRecovery();
     return;
   }
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
  if (flushPromise) { flushAgain = true; return flushPromise; }
  cancelScheduledRetry();
  const flushEpoch = getAuthEpoch();
  flushPromise = (async () => {
    try {
       if (!canFlush() || logoutQuiescing || getSessionLogoutInProgress()) return;
         const lifecycle = getAuthLifecycle().status;
         let trust;
         if (lifecycle === 'trusted-offline') {
           const trustRead = await boundedResult(readOfflineTrust());
           if (trustRead.timedOut) { void trustRead.late.then(() => refreshOutbox()).catch(() => undefined); return; }
           trust = trustRead.value;
         }
         const authenticatedUserId = lifecycle === 'authenticated' ? currentOutboxUserId() : undefined;
         if ((!trust || !isOfflineTrustUsable(trust)) && !authenticatedUserId) return;
       if (!canFlush() || logoutQuiescing || getSessionLogoutInProgress()) return;
       if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
        if (!isAuthEpochCurrent(flushEpoch)) return;
          const userId = lifecycle === 'authenticated' ? currentOutboxUserId() : trust && isOfflineTrustUsable(trust) ? trust.userId : undefined;
          if (!userId || !isAuthEpochCurrent(flushEpoch)) return;
          if (lifecycle === 'authenticated') {
            const rebound = await boundedResult(rebindOutboxAuthEpoch(userId, flushEpoch, () => isAuthEpochCurrent(flushEpoch) && getAuthLifecycle().status === 'authenticated' && currentOutboxUserId() === userId));
            if (rebound.timedOut) { try { await rebound.late; } catch { return; } }
          }
           const listed = await boundedResult(listOutbox(userId));
          if (listed.timedOut) { void listed.late.then(() => refreshOutbox()).catch(() => undefined); return; }
          const items = listed.value.filter((item) => item.status === 'pending' || item.status === 'syncing');
      for (const item of items) {
        if (logoutQuiescing || (typeof document !== 'undefined' && document.visibilityState !== 'visible')) break;
        const result = await syncItem(item, timeoutMs);
        if (result === 'auth-required') break;
        if (result === 'pending') { scheduleRetry(item.attempts + 1); break; }
      }
      await refreshOutbox();
    } catch (error) {
      if (isAuthEpochCurrent(flushEpoch) && error instanceof ApiError && (error.status === 401 || error.status === 403 || error.code === 'AUTH_REQUIRED' || error.code === 'AUTH_INVALID' || error.code === 'IDENTITY_MISMATCH' || error.code === 'AUTH_IDENTITY_CONFLICT')) {
          const lifecycle = getAuthLifecycle().status;
          const trust = lifecycle === 'trusted-offline' ? await bounded(readOfflineTrust()) : undefined;
          const userId = lifecycle === 'authenticated' ? currentOutboxUserId() : trust && isOfflineTrustUsable(trust) ? trust.userId : undefined;
         if (userId && isAuthEpochCurrent(flushEpoch)) await markAuthRequired(userId, error, flushEpoch);
      } else if (error instanceof ApiError && isRetryable(error)) {
          try { const lifecycle = getAuthLifecycle().status; const trust = lifecycle === 'trusted-offline' ? await bounded(readOfflineTrust()) : undefined; const userId = lifecycle === 'authenticated' ? currentOutboxUserId() : trust && isOfflineTrustUsable(trust) ? trust.userId : undefined; const items = userId ? (await bounded(listOutbox(userId)) || []) : []; if (items.length) scheduleRetry(Math.max(...items.map((item) => item.attempts || 1))); } catch { /* IndexedDB availability is reported by the enqueue path. */ }
      }
    } finally {
      const rerun = flushAgain; flushAgain = false; flushPromise = undefined;
      if (rerun && !logoutQuiescing) Promise.resolve().then(() => flushOutbox(timeoutMs));
    }
  })();
  return flushPromise;
}

export class OutboxBusyError extends Error { constructor() { super('This expense is currently syncing. An in-flight server write cannot be safely cancelled.'); this.name = 'OutboxBusyError'; } }
export class OutboxDeliveryUncertainError extends Error { constructor() { super('Delivery is uncertain because the server may have committed this expense. Retry or wait for reconciliation; it cannot be discarded safely.'); this.name = 'OutboxDeliveryUncertainError'; } }
export class OutboxStorageTimeoutError extends Error { constructor() { super('Offline storage did not respond before the deadline. The operation was not confirmed; retry.'); this.name = 'OutboxStorageTimeoutError'; } }

export async function retryOutboxItem(clientOperationId: string) {
  const userId = currentOutboxUserId();
  if (!userId) throw new OutboxStorageTimeoutError();
  let scope: OutboxOperationScope = { userId, expectedAuthEpoch: getAuthEpoch() };
  const currentResult = await boundedResult(readOutboxItem(clientOperationId, scope));
  if (currentResult.timedOut) throw new OutboxStorageTimeoutError();
   let item = currentResult.value;
   if (!item) {
     const unboundResult = await boundedResult(readOutboxItem(clientOperationId, { userId }));
     if (unboundResult.timedOut) throw new OutboxStorageTimeoutError();
     item = unboundResult.value;
   }
   if (!item) return;
   if (item.authEpoch !== undefined && item.authEpoch !== scope.expectedAuthEpoch && (item.status === 'auth-required' || item.status === 'failed')) {
    scope = { userId, expectedAuthEpoch: item.authEpoch, rebindAuthEpoch: getAuthEpoch() };
  }
  if (item.status === 'syncing' && item.leaseExpiresAt !== undefined && item.leaseExpiresAt > Date.now()) throw new OutboxBusyError();
  const resetResult = await boundedResult(resetOutboxIfIdle(clientOperationId, Date.now(), scope));
  if (resetResult.timedOut) { void resetResult.late.then(() => refreshOutbox()).catch(() => undefined); throw new OutboxStorageTimeoutError(); }
  let reset = resetResult.value;
  // Authentication callbacks can finish the same row between the initial
  // read and this CAS transaction. If the row is no longer actively leased,
  // retry once against the current epoch instead of misreporting a benign
  // callback race as a busy write.
  if (!reset && getAuthEpoch() !== scope.expectedAuthEpoch && currentOutboxUserId() === userId) {
    const currentScope = { userId, expectedAuthEpoch: getAuthEpoch() } satisfies OutboxOperationScope;
    const retryReset = await boundedResult(resetOutboxIfIdle(clientOperationId, Date.now(), currentScope));
    if (retryReset.timedOut) { void retryReset.late.then(() => refreshOutbox()).catch(() => undefined); throw new OutboxStorageTimeoutError(); }
    reset = retryReset.value;
  }
  if (!reset && flushPromise) {
    const flushResult = await boundedResult(flushPromise, OUTBOX_IDB_DEADLINE_MS);
    if (!flushResult.timedOut) {
      const currentScope = { userId, expectedAuthEpoch: getAuthEpoch() } satisfies OutboxOperationScope;
      const retryReset = await boundedResult(resetOutboxIfIdle(clientOperationId, Date.now(), currentScope));
      if (retryReset.timedOut) { void retryReset.late.then(() => refreshOutbox()).catch(() => undefined); throw new OutboxStorageTimeoutError(); }
      reset = retryReset.value;
    }
  }
  if (!reset) throw new OutboxBusyError();
  await refreshOutbox();
  return flushOutbox();
}

export async function discardOutboxItem(clientOperationId: string) {
  const userId = currentOutboxUserId();
  if (!userId) throw new OutboxStorageTimeoutError();
  const scope = { userId, expectedAuthEpoch: getAuthEpoch() } satisfies OutboxOperationScope;
  const currentResult = await boundedResult(readOutboxItem(clientOperationId, scope));
  if (currentResult.timedOut) throw new OutboxStorageTimeoutError();
  const current = currentResult.value;
  if (!current) return;
  if (current?.deliveryUncertain) throw new OutboxDeliveryUncertainError();
   const removedResult = await boundedResult(discardOutboxIfIdle(clientOperationId, Date.now(), scope));
   if (removedResult.timedOut) { void removedResult.late.then(() => refreshOutbox()).catch(() => undefined); throw new OutboxStorageTimeoutError(); }
   const removed = removedResult.value;
   if (!removed) {
     const latestResult = await boundedResult(readOutboxItem(clientOperationId, scope));
     if (latestResult.timedOut) throw new OutboxStorageTimeoutError();
     const latest = latestResult.value;
    if (!latest) return;
    if (latest?.deliveryUncertain) throw new OutboxDeliveryUncertainError();
    throw new OutboxBusyError();
  }
  snapshot = snapshot.filter((item) => item.clientOperationId !== clientOperationId); notify();
}

export function statusLabel(status: OutboxStatus, deliveryUncertain = false) {
  return deliveryUncertain ? 'Delivery uncertain · Retry' : status === 'syncing' ? 'Syncing' : status === 'auth-required' ? 'Sign in to sync' : status === 'failed' ? 'Sync failed' : 'Waiting to sync';
}

export async function handleAuthenticatedUser(userId: string, eventEpoch = getAuthEpoch(), resumeId?: number) {
  if (resumeId !== undefined) {
    if (completedResumeIds.has(resumeId)) return;
    const existing = resumeRecoveryPromises.get(resumeId);
    if (existing) return existing;
    const ordered = (async () => {
      if (getSessionLogoutInProgress() || !isAuthEpochCurrent(eventEpoch) || getAuthLifecycle().status !== 'authenticated' || currentOutboxUserId() !== userId) return;
      logoutQuiescing = false;
      const rebound = await boundedResult(rebindOutboxAuthEpoch(userId, eventEpoch, () => isAuthEpochCurrent(eventEpoch) && getAuthLifecycle().status === 'authenticated' && currentOutboxUserId() === userId));
      if (rebound.timedOut) { try { await rebound.late; } catch { return; } }
      const reactivation = await boundedResult(reactivateAuthRequired(userId, () => isAuthEpochCurrent(eventEpoch) && getAuthLifecycle().status === 'authenticated', eventEpoch));
      // A bounded IDB wait is only a caller deadline. Reactivation may still
      // be committing auth-required rows; do not mark this resume complete or
      // flush the old snapshot until that late transaction has settled.
      if (reactivation.timedOut) {
        try { await reactivation.late; } catch { return; }
      }
      if (!isAuthEpochCurrent(eventEpoch) || getAuthLifecycle().status !== 'authenticated') return;
      await refreshOutbox();
      if (isAuthEpochCurrent(eventEpoch) && getAuthLifecycle().status === 'authenticated') await flushOutbox();
    })().finally(() => {
      resumeRecoveryPromises.delete(resumeId);
      completedResumeIds.add(resumeId);
      if (completedResumeIds.size > 64) completedResumeIds.delete(completedResumeIds.values().next().value!);
    });
    resumeRecoveryPromises.set(resumeId, ordered);
    return ordered;
  }
  // A successful, newly verified session is the only event that may release
  // the logout barrier and allow queued writes to resume.
  if (getSessionLogoutInProgress() || !isAuthEpochCurrent(eventEpoch) || getAuthLifecycle().status !== 'authenticated' || currentOutboxUserId() !== userId) return;
  logoutQuiescing = false;
  const rebound = await boundedResult(rebindOutboxAuthEpoch(userId, eventEpoch, () => isAuthEpochCurrent(eventEpoch) && getAuthLifecycle().status === 'authenticated' && currentOutboxUserId() === userId));
  if (rebound.timedOut) { try { await rebound.late; } catch { return; } }
  const reactivation = await boundedResult(reactivateAuthRequired(userId, () => isAuthEpochCurrent(eventEpoch) && getAuthLifecycle().status === 'authenticated', eventEpoch));
  if (reactivation.timedOut) {
    try { await reactivation.late; } catch { return; }
  }
  const changed = reactivation.timedOut ? undefined : reactivation.value;
  if (!isAuthEpochCurrent(eventEpoch) || getAuthLifecycle().status !== 'authenticated') return;
  // This is deliberately reached from the post-verification lifecycle event,
  // not during module evaluation. It recovers stale leases and starts the
  // first flush as soon as the authenticated identity is durable.
  await initializeOutbox();
  if (!isAuthEpochCurrent(eventEpoch)) return;
  await refreshOutbox();
  return changed ? flushOutbox() : undefined;
}

async function quiesceForLogout() {
  logoutQuiescing = true;
  flushAgain = false;
  cancelScheduledRetry();
  for (const controller of activeControllers) controller.abort();
  if (flushPromise) await bounded(flushPromise, OUTBOX_LOGOUT_DEADLINE_MS);
}

function resumeAfterFailedLogout() {
  logoutQuiescing = false;
  void refreshOutbox();
}

registerLogoutCoordinator(quiesceForLogout, resumeAfterFailedLogout);
subscribeSessionLogout(() => { void quiesceForLogout(); });

if (typeof window !== 'undefined') {
  // Foreground signals are owned by the auth coordinator.  This event is the
  // completion edge of that one operation, so pageshow/focus/visibility storms
  // cannot create a second probe or flush loop.
  window.addEventListener('billsplit-auth-resumed', (event) => {
    const detail = (event as CustomEvent<{ status?: string; resumeId?: number; userId?: string; authEpoch?: number }>).detail;
    if (detail?.status === 'authenticated' && detail.resumeId !== undefined && detail.userId && detail.authEpoch !== undefined && document.visibilityState === 'visible' && !logoutQuiescing) void handleAuthenticatedUser(detail.userId, detail.authEpoch, detail.resumeId);
  });
  window.addEventListener('billsplit-outbox-changed', () => void refreshOutbox());
  window.addEventListener('billsplit-cache-cleared', (event) => { if ((event as CustomEvent<{ clearOutbox?: boolean }>).detail?.clearOutbox) { snapshot = []; notify(); } void refreshOutbox(); });
  window.addEventListener('billsplit-authenticated', (event) => { const detail = (event as CustomEvent<{ userId?: string; authEpoch?: number; resumeId?: number }>).detail; if (detail?.userId && detail.authEpoch !== undefined && !logoutQuiescing) void handleAuthenticatedUser(detail.userId, detail.authEpoch, detail.resumeId); });
}

subscribeConnectionState(() => {
  if (getConnectionState().status === 'connected') {
    connectionRecoveryAttempts = 0;
    if (connectionRecoveryTimer) { clearTimer(connectionRecoveryTimer); connectionRecoveryTimer = undefined; }
    if (typeof document === 'undefined' || document.visibilityState === 'visible') void flushOutbox();
  } else if (getAuthLifecycle().status === 'authenticated' || getAuthLifecycle().status === 'trusted-offline') {
    scheduleConnectionRecovery(getConnectionState().status === 'checking' ? 0 : undefined);
  }
});

// Auth downgrades abort an in-flight send and cancel any work which might
// otherwise be restarted by a stale completion.
subscribeAuthLifecycle(() => {
  const lifecycleStatus = getAuthLifecycle().status;
  const authenticatedUserId = currentOutboxUserId();
  const retainedTransition = (lifecycleStatus === 'provisional' || lifecycleStatus === 'restoring' || lifecycleStatus === 'reverifying') && hasRetainedPrivateSession();
  if ((lifecycleStatus === 'authenticated' && (!authenticatedUserId || snapshot.some((item) => item.userId !== authenticatedUserId))) || (!retainedTransition && lifecycleStatus !== 'authenticated' && lifecycleStatus !== 'trusted-offline')) {
    if (snapshot.length) { snapshot = []; notify(); }
  }
  if (getAuthLifecycle().status === 'authenticated' || getAuthLifecycle().status === 'trusted-offline') {
    // Authenticated writes start from the stable authenticated lifecycle
    // event below.  Starting a flush from this transition as well races that
    // event and can trigger reconnect verification twice.
    void refreshOutbox().then(() => { if (!isUsableConnection() && getAuthLifecycle().status === 'trusted-offline') scheduleConnectionRecovery(); }).catch(() => scheduleConnectionRecovery());
    return;
  }
  flushAgain = false;
  cancelScheduledRetry();
  for (const controller of activeControllers) controller.abort();
  // Abort is only an accelerator. The request owns its lease until its
  // transport settles (or IndexedDB lease expiry permits recovery); releasing
  // it here would let a second tab send the same operation concurrently.
  void refreshOutbox();
});

// Kept as a named call shape for the authenticated event contract. The
// optional epoch argument is what prevents stale Clerk events from syncing.
// handleAuthenticatedUser(userId)
