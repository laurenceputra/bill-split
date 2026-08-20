import { api, ApiError, getMe } from './api';
import {
  claimOutboxItem, discardOutboxIfIdle, listOutbox, markOutboxAuthRequired, readLastVerifiedIdentity, readOutboxItem,
  reactivateAuthRequired, recoverStaleSyncing, removeOutboxIfOwned, resetOutboxIfIdle, saveOutboxItem, updateOutboxIfOwned,
  type ExpenseOutboxItem, type OutboxStatus,
} from './idb';
import type { ExpenseInput } from '../shared/schemas';
import { invalidateForMutation } from './resource-cache';

export type { ExpenseOutboxItem } from './idb';
export const OUTBOX_LEASE_MS = 30_000;
export const OUTBOX_REQUEST_TIMEOUT_MS = 15_000;

type OutboxListener = () => void;
const listeners = new Set<OutboxListener>();
const owner = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `tab-${Date.now()}-${Math.random()}`;
let flushPromise: Promise<void> | undefined;
let initialized = false;
let initializationPromise: Promise<void> | undefined;
let snapshot: ExpenseOutboxItem[] = [];
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let flushAgain = false;
let scheduleTimer = (callback: () => void, delay: number) => setTimeout(callback, delay);
let clearTimer = (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer);
export const RETRY_BASE_DELAY_MS = 1_000;
export const RETRY_MAX_DELAY_MS = 60_000;

const notify = () => listeners.forEach((listener) => listener());
export const retryDelay = (attempts: number) => Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * (2 ** Math.max(0, Math.min(attempts - 1, 6))));
const scheduleRetry = (attempts: number) => {
  const delay = retryDelay(attempts);
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = scheduleTimer(() => { retryTimer = undefined; void flushOutbox(); }, delay);
};
export const cancelScheduledRetry = () => { if (retryTimer) { clearTimer(retryTimer); retryTimer = undefined; } };
export function setRetrySchedulerForTests(schedule: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>, clear: (timer: ReturnType<typeof setTimeout>) => void) { const previous = { schedule: scheduleTimer, clear: clearTimer }; scheduleTimer = schedule; clearTimer = clear; return () => { scheduleTimer = previous.schedule; clearTimer = previous.clear; }; }
export async function refreshOutbox() { let next: ExpenseOutboxItem[] = []; try { const identity = await readLastVerifiedIdentity(); next = identity ? await listOutbox(identity.userId) : []; } catch { /* Keep an unavailable cache from breaking the shell. */ } if (JSON.stringify(next) !== JSON.stringify(snapshot)) { snapshot = next; notify(); } }
const updateSnapshot = (item: ExpenseOutboxItem | undefined) => { if (!item) return; snapshot = snapshot.some((current) => current.clientOperationId === item.clientOperationId) ? snapshot.map((current) => current.clientOperationId === item.clientOperationId ? item : current) : [...snapshot, item]; notify(); };
export const subscribeOutbox = (listener: OutboxListener) => { listeners.add(listener); void initializeOutbox(); return () => { listeners.delete(listener); }; };
export const getOutboxSnapshot = () => snapshot;
export const pendingCount = () => snapshot.length;

export async function initializeOutbox() {
  if (!initialized) {
    initialized = true;
    initializationPromise = (async () => { try { await recoverStaleSyncing(); } catch { /* surfaced when enqueueing; UI remains usable online. */ } await refreshOutbox(); })();
  }
  if (initializationPromise) await initializationPromise;
  return flushOutbox();
}

export async function enqueueExpense(input: { userId: string; groupId: string; payload: ExpenseInput; display: ExpenseOutboxItem['display']; clientOperationId: string }): Promise<ExpenseOutboxItem> {
  const now = new Date().toISOString();
  const item: ExpenseOutboxItem = { ...input, createdAt: now, updatedAt: now, status: 'pending', attempts: 0, deliveryUncertain: false };
  await saveOutboxItem(item);
  snapshot = [...snapshot.filter((existing) => existing.clientOperationId !== item.clientOperationId), item].sort((a, b) => a.createdAt.localeCompare(b.createdAt)); notify();
  return item;
}

const errorDetails = (error: ApiError) => ({ code: error.code, message: error.message, status: error.status });
const isRetryable = (error: ApiError) => error.networkFailure || error.code === 'NETWORK_TIMEOUT' || error.status === 408 || error.status === 429 || (error.status !== undefined && error.status >= 500);

async function syncItem(item: ExpenseOutboxItem, timeoutMs = OUTBOX_REQUEST_TIMEOUT_MS) {
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return undefined;
  const claimed = await claimOutboxItem(item.clientOperationId, owner, Date.now(), OUTBOX_LEASE_MS);
  if (!claimed) return undefined;
  updateSnapshot(claimed);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      await updateOutboxIfOwned(claimed.clientOperationId, owner, { status: 'pending', leaseOwner: undefined, leaseExpiresAt: undefined });
      return undefined;
    }
    await api(`/groups/${claimed.groupId}/expenses`, { method: 'POST', body: JSON.stringify(claimed.payload), signal: controller.signal, headers: { 'X-BillSplit-Expected-User-Id': claimed.userId } });
    invalidateForMutation.expenseChanged(claimed.groupId, undefined, claimed.userId);
    const removed = await removeOutboxIfOwned(claimed.clientOperationId, owner);
    if (removed) { snapshot = snapshot.filter((current) => current.clientOperationId !== claimed.clientOperationId); notify(); }
    else await refreshOutbox();
    return 'removed' as const;
  } catch (error) {
    const apiError = timedOut ? new ApiError('The sync request timed out.', { code: 'NETWORK_TIMEOUT', networkFailure: true }) : error instanceof ApiError ? error : new ApiError('Unable to sync expense.', { networkFailure: true, code: 'NETWORK_ERROR' });
    const ambiguous = apiError.status === undefined || apiError.networkFailure || apiError.code === 'NETWORK_TIMEOUT' || apiError.status === 408 || apiError.status === 429 || (apiError.status !== undefined && apiError.status >= 500);
    const status: OutboxStatus = apiError.status === 401 || apiError.code === 'AUTH_REQUIRED' || apiError.code === 'AUTH_INVALID' || apiError.code === 'IDENTITY_MISMATCH' ? 'auth-required' : isRetryable(apiError) ? 'pending' : 'failed';
    const updated = await updateOutboxIfOwned(claimed.clientOperationId, owner, { status, deliveryUncertain: ambiguous, leaseOwner: undefined, leaseExpiresAt: undefined, lastError: errorDetails(apiError) });
    if (ambiguous) invalidateForMutation.expenseChanged(claimed.groupId, undefined, claimed.userId);
    if (updated) updateSnapshot(updated); else await refreshOutbox();
    return status;
  } finally { clearTimeout(timer); }
}

async function markAuthRequired(userId: string, error: ApiError) {
  await recoverStaleSyncing();
  await markOutboxAuthRequired(userId, errorDetails(error));
  await refreshOutbox();
}

export async function flushOutbox(timeoutMs = OUTBOX_REQUEST_TIMEOUT_MS) {
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
  if (flushPromise) { flushAgain = true; return flushPromise; }
  cancelScheduledRetry();
  flushPromise = (async () => {
    try {
      const identity = await getMe({ networkOnly: true });
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      const items = (await listOutbox(identity.id)).filter((item) => item.status === 'pending' || item.status === 'syncing');
      for (const item of items) {
        if (typeof document !== 'undefined' && document.visibilityState !== 'visible') break;
        const result = await syncItem(item, timeoutMs);
        if (result === 'auth-required') break;
        if (result === 'pending') { scheduleRetry(item.attempts + 1); break; }
      }
      await refreshOutbox();
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.code === 'AUTH_REQUIRED' || error.code === 'AUTH_INVALID' || error.code === 'IDENTITY_MISMATCH')) {
        const identity = await readLastVerifiedIdentity();
        if (identity) await markAuthRequired(identity.userId, error);
      } else if (error instanceof ApiError && isRetryable(error)) {
        try { const identity = await readLastVerifiedIdentity(); const items = identity ? await listOutbox(identity.userId) : []; if (items.length) scheduleRetry(Math.max(...items.map((item) => item.attempts || 1))); } catch { /* IndexedDB availability is reported by the enqueue path. */ }
      }
    } finally {
      const rerun = flushAgain; flushAgain = false; flushPromise = undefined;
      if (rerun) Promise.resolve().then(() => flushOutbox(timeoutMs));
    }
  })();
  return flushPromise;
}

export class OutboxBusyError extends Error { constructor() { super('This expense is currently syncing. An in-flight server write cannot be safely cancelled.'); this.name = 'OutboxBusyError'; } }
export class OutboxDeliveryUncertainError extends Error { constructor() { super('Delivery is uncertain because the server may have committed this expense. Retry or wait for reconciliation; it cannot be discarded safely.'); this.name = 'OutboxDeliveryUncertainError'; } }

export async function retryOutboxItem(clientOperationId: string) {
  let item = await readOutboxItem(clientOperationId);
  if (!item) return;
  if (item.status === 'syncing' && item.leaseExpiresAt !== undefined && item.leaseExpiresAt > Date.now()) throw new OutboxBusyError();
  const reset = await resetOutboxIfIdle(clientOperationId);
  if (!reset) throw new OutboxBusyError();
  await refreshOutbox();
  return flushOutbox();
}

export async function discardOutboxItem(clientOperationId: string) {
  const current = await readOutboxItem(clientOperationId);
  if (!current) return;
  if (current?.deliveryUncertain) throw new OutboxDeliveryUncertainError();
  const removed = await discardOutboxIfIdle(clientOperationId);
  if (!removed) {
    const latest = await readOutboxItem(clientOperationId);
    if (!latest) return;
    if (latest?.deliveryUncertain) throw new OutboxDeliveryUncertainError();
    throw new OutboxBusyError();
  }
  snapshot = snapshot.filter((item) => item.clientOperationId !== clientOperationId); notify();
}

export function statusLabel(status: OutboxStatus, deliveryUncertain = false) {
  return deliveryUncertain ? 'Delivery uncertain · Retry' : status === 'syncing' ? 'Syncing' : status === 'auth-required' ? 'Sign in to sync' : status === 'failed' ? 'Sync failed' : 'Waiting to sync';
}

export async function handleAuthenticatedUser(userId: string) {
  const changed = await reactivateAuthRequired(userId);
  await refreshOutbox();
  return changed ? flushOutbox() : undefined;
}

if (typeof window !== 'undefined') {
  void initializeOutbox();
  window.addEventListener('online', () => { if (document.visibilityState === 'visible') void flushOutbox(); });
  window.addEventListener('focus', () => { if (document.visibilityState === 'visible') void flushOutbox(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void flushOutbox(); });
  window.addEventListener('billsplit-outbox-changed', () => void refreshOutbox());
  window.addEventListener('billsplit-cache-cleared', () => void refreshOutbox());
  window.addEventListener('billsplit-authenticated', (event) => { const userId = (event as CustomEvent<{ userId?: string }>).detail?.userId; if (userId) void handleAuthenticatedUser(userId); });
}
