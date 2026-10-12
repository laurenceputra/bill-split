import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { invalidateCachedGroups, updateGroupSnapshot, updateGroupsSnapshot } from './idb';
import { captureSessionGeneration, isSessionGenerationCurrent } from './session';
import type { Balances, Group, GroupResponse } from '../shared/types';
import { clearPersonalBalances, getPersonalBalance, stalePersonalBalances, usePersonalBalances } from './personal-balances';

/** The shortest freshness window used by the application. */
export const MIN_RESOURCE_FRESHNESS_MS = 30_000;
export const RESOURCE_FRESHNESS = Object.freeze({
  groups: 60_000,
  group: 300_000,
  members: 300_000,
  expenses: 30_000,
  balances: 30_000,
  settlements: 30_000,
  transactions: 30_000,
  scheduledExpenses: 30_000,
  activity: 30_000,
  insights: 30_000,
  expenseDetail: 30_000,
  expenseHistory: 30_000,
  invitations: 30_000,
  audit: 30_000,
  settlementDetail: 30_000,
});

export type ResourceStatus = 'idle' | 'loading' | 'ready' | 'error' | 'auth-blocked';
export type ResourceKey = string;
export interface ResourceSnapshot<T> {
  readonly userId: string;
  readonly data?: T;
  readonly fetchedAt?: number;
  readonly status: ResourceStatus;
  readonly loading: boolean;
  readonly revalidating: boolean;
  readonly stale: boolean;
  readonly offline: boolean;
  readonly error?: unknown;
}
export type ResourceViewState = 'loading' | 'error' | 'ready';
export type ResourceLoader<T> = (signal?: AbortSignal) => Promise<T>;
export type ResourceHydrator<T> = () => Promise<{ data: T; fetchedAt?: number; offline?: boolean } | undefined>;
export interface ResourceOptions { skipWhenOffline?: boolean }
export type RevalidateReason = 'route' | 'focus' | 'online' | 'visibility' | 'mutation' | 'auth-restored' | 'identity-check';
export interface RevalidateOptions { force?: boolean; reason?: RevalidateReason }

type Entry<T> = { snapshot: ResourceSnapshot<T>; loader?: ResourceLoader<T>; hydrate?: ResourceHydrator<T>; hydrationPromise?: Promise<void>; ttl: number; promise?: Promise<T>; controller?: AbortController; generation: number; forcePending?: RevalidateOptions; listeners: Set<() => void>; visible: number; evicted?: boolean; evictionTimer?: ReturnType<typeof setTimeout> };
const entries = new Map<ResourceKey, Entry<unknown>>();
const identityListeners = new Set<() => void>();
let activeUserId: string | undefined;
let identityEpoch = 0;
let coordinatorInstalled = false;
let coordinatorTimer: ReturnType<typeof setTimeout> | undefined;
let coordinatorIdentityCheck = false;
let authResumeSuppressedUntil = 0;
const pendingInvalidationUsers = new Map<string, number>();
const invalidatedBalanceGroups = new Map<string, Set<string>>();
const balanceHintKey = 'billsplit-balance-hint';
const seenBalanceHints = new Set<string>();
const balanceChannel = typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(balanceHintKey) : undefined;
export function receiveBalanceHint(value: unknown) {
  const hint = value as { id?: string; userId?: string; groupId?: string } | null;
  if (!hint || typeof hint.id !== 'string' || typeof hint.userId !== 'string' || hint.userId !== activeUserId || typeof hint.groupId !== 'string' || seenBalanceHints.has(hint.id)) return;
  seenBalanceHints.add(hint.id);
  if (seenBalanceHints.size > 256) seenBalanceHints.delete(seenBalanceHints.values().next().value!);
  stalePersonalBalances(hint.userId, hint.groupId);
  for (const key of [resourceKeys.groups(hint.userId), resourceKeys.balances(hint.userId, hint.groupId)]) {
    const resource = entries.get(key);
    if (!resource) continue;
    resource.generation++; resource.controller?.abort();
    resource.forcePending = { force: true, reason: 'mutation' };
    resource.snapshot = stable({ ...resource.snapshot, stale: true }); notify(resource);
    if (resource.visible > 0) void revalidate(key, hint.userId, resource.forcePending).catch(() => undefined);
  }
}
if (balanceChannel) balanceChannel.onmessage = (event) => receiveBalanceHint(event.data);
if (typeof window !== 'undefined') window.addEventListener('storage', (event) => { if (event.key === balanceHintKey && event.newValue) { try { receiveBalanceHint(JSON.parse(event.newValue)); } catch { /* Ignore malformed hints. */ } } });
function broadcastBalanceHint(userId: string, groupId: string) {
  const hint = { id: crypto.randomUUID(), userId, groupId };
  seenBalanceHints.add(hint.id); balanceChannel?.postMessage(hint);
  try { localStorage.setItem(balanceHintKey, JSON.stringify(hint)); } catch { /* Optional cross-tab enhancement. */ }
}
let balancePollTimer: ReturnType<typeof setInterval> | undefined;
function updateBalancePolling() {
  const eligible = authLifecycleReady && !!activeUserId && online() && isVisible() && [...entries].some(([key, resource]) => resource.visible > 0 && (key.startsWith('groups:') || key.startsWith('balances:')));
  if (!eligible && balancePollTimer) { clearInterval(balancePollTimer); balancePollTimer = undefined; }
  if (eligible && !balancePollTimer) balancePollTimer = setInterval(() => {
    if (!authLifecycleReady || !online() || !isVisible() || !activeUserId) { updateBalancePolling(); return; }
    for (const [key, resource] of entries) if (resource.visible > 0 && resource.snapshot.userId === activeUserId && (key.startsWith('groups:') || key.startsWith('balances:'))) void revalidate(key, activeUserId, { force: true, reason: 'focus' }).catch(() => undefined);
  }, 30_000);
}
// A browser foreground refresh must wait for Clerk and /api/me. Node tests
// have no provider, so direct cache tests retain their existing behavior.
let authLifecycleReady = typeof window === 'undefined';

const now = () => Date.now();
const online = () => typeof navigator === 'undefined' || navigator.onLine !== false;
const isVisible = () => typeof document === 'undefined' || document.visibilityState === 'visible';
const isIdentityKey = (key: ResourceKey) => key === 'identity';
const stable = <T>(snapshot: ResourceSnapshot<T>) => Object.freeze(snapshot);
const notify = <T>(entry: Entry<T>) => entry.listeners.forEach((listener) => listener());
const signalResourceInvalidated = () => { if (typeof window !== 'undefined') window.dispatchEvent(new Event('billsplit-resource-invalidated')); };
const idleSnapshot = <T>(userId: string): ResourceSnapshot<T> => stable({ userId, status: 'idle', loading: false, revalidating: false, stale: false, offline: !online() });

/** A resource with no data is never an empty successful result. */
export function resourceViewState<T>(snapshot: ResourceSnapshot<T>): ResourceViewState {
  if (snapshot.data !== undefined) return 'ready';
  if (snapshot.error && !snapshot.loading && snapshot.status !== 'idle') return 'error';
  return 'loading';
}

function entry<T>(key: ResourceKey, userId: string, ttl: number): Entry<T> {
  const existing = entries.get(key) as Entry<T> | undefined;
  if (existing) return existing;
  const created: Entry<T> = { snapshot: idleSnapshot<T>(userId), ttl: Math.max(MIN_RESOURCE_FRESHNESS_MS, ttl), generation: 0, listeners: new Set(), visible: 0 };
  entries.set(key, created as Entry<unknown>);
  return created;
}

export function setResourceIdentity(userId: string | undefined) {
  if (activeUserId === userId) return;
  activeUserId = userId;
  identityEpoch += 1;
  clearResourceCache();
  clearPersonalBalances(); updateBalancePolling();
  identityListeners.forEach((listener) => listener());
}
export function resetResourceIdentity() { if (activeUserId !== undefined) identityEpoch += 1; activeUserId = undefined; clearResourceCache(); identityListeners.forEach((listener) => listener()); }
export function blockResourceIdentity(error: unknown) {
  identityEpoch += 1;
  activeUserId = undefined;
  clearResourceCache(undefined, 'identity');
  const identity = entry<unknown>('identity', 'identity', MIN_RESOURCE_FRESHNESS_MS);
  identity.controller?.abort(); identity.generation += 1; identity.promise = undefined; identity.hydrationPromise = undefined; identity.forcePending = undefined;
  const { data: _revokedData, fetchedAt: _revokedFetchedAt, ...revokedIdentity } = identity.snapshot;
  identity.snapshot = stable({ ...revokedIdentity, status: 'auth-blocked', loading: false, revalidating: false, stale: true, offline: false, error });
  notify(identity); identityListeners.forEach((listener) => listener());
}
export function allowIdentityVerification() {
  const identity = entries.get('identity');
  if (!identity || identity.snapshot.status !== 'auth-blocked') return;
  identity.snapshot = stable({ ...identity.snapshot, status: 'idle', loading: false, revalidating: false, stale: false, error: undefined });
  notify(identity);
}
export function setResourceAuthLifecycleReady(ready: boolean) { authLifecycleReady = ready; updateBalancePolling(); }
export const getResourceIdentity = () => activeUserId;
export const getResourceIdentityEpoch = () => identityEpoch;
export function useResourceIdentityEpoch() { return useSyncExternalStore(subscribeResourceIdentity, getResourceIdentityEpoch, () => 0); }
export const subscribeResourceIdentity = (listener: () => void) => { identityListeners.add(listener); return () => identityListeners.delete(listener); };

export function getResourceSnapshot<T>(key: ResourceKey, userId = activeUserId || '') {
  return entry<T>(key, isIdentityKey(key) ? 'identity' : userId, MIN_RESOURCE_FRESHNESS_MS).snapshot;
}
export function configureResource<T>(key: ResourceKey, userId: string, loader: ResourceLoader<T>, ttl = MIN_RESOURCE_FRESHNESS_MS) {
  const resource = entry<T>(key, userId, ttl);
  if (!resource.visible) resource.evicted = false;
  resource.loader = loader;
  resource.ttl = Math.max(MIN_RESOURCE_FRESHNESS_MS, ttl);
  return resource.snapshot;
}
export function subscribeResource<T>(key: ResourceKey, listener: () => void, userId = activeUserId || '') {
  const resource = entry<T>(key, isIdentityKey(key) ? 'identity' : userId, MIN_RESOURCE_FRESHNESS_MS);
  if (!resource.visible) resource.evicted = false;
  if (resource.evictionTimer) { clearTimeout(resource.evictionTimer); resource.evictionTimer = undefined; }
  resource.listeners.add(listener);
  resource.visible += 1;
  updateBalancePolling();
  return () => {
    resource.listeners.delete(listener); resource.visible = Math.max(0, resource.visible - 1);
    updateBalancePolling();
    if (!resource.visible && !resource.listeners.size && !resource.evictionTimer) resource.evictionTimer = setTimeout(() => { if (!resource.visible && !resource.listeners.size) { resource.controller?.abort(); resource.generation += 1; resource.loader = undefined; resource.hydrate = undefined; resource.evictionTimer = undefined; entries.delete(key); } }, 5 * 60_000);
  };
}

/** A null key disables this consumer without registering or changing a shared resource. */
export function useResource<T>(key: ResourceKey | null, userId: string | undefined, loader: ResourceLoader<T>, ttl = MIN_RESOURCE_FRESHNESS_MS, hydrate?: ResourceHydrator<T>, options: ResourceOptions = {}) {
  usePersonalBalances();
  const resolvedUser = key !== null && isIdentityKey(key) ? 'identity' : userId || activeUserId || '';
  const disabledOffline = !online();
  const disabledSnapshot = useMemo(() => idleSnapshot<T>(resolvedUser), [resolvedUser, disabledOffline]);
  const resource = key === null ? undefined : entry<T>(key, resolvedUser, ttl);
  if (resource) {
    if (!resource.visible) resource.evicted = false;
    resource.loader = loader;
    resource.hydrate = hydrate;
    resource.ttl = Math.max(MIN_RESOURCE_FRESHNESS_MS, ttl);
  }
  const snapshot = useSyncExternalStore(
    (listener) => key === null ? () => undefined : subscribeResource<T>(key, listener, resolvedUser),
    () => resource?.snapshot ?? disabledSnapshot,
    () => resource?.snapshot ?? disabledSnapshot,
  );
  useEffect(() => {
    if (key === null || !resource || !resolvedUser || !isVisible()) return;
    if (!isIdentityKey(key)) {
      const identity = entries.get('identity');
      if (identity && (identity.snapshot.status === 'idle' || identity.snapshot.revalidating || identity.snapshot.stale || !isResourceFresh(identity.snapshot, identity.ttl))) return;
    }
    if (resource.snapshot.status === 'idle' && resource.hydrate && !resource.hydrationPromise) {
      let generation = resource.generation;
      resource.hydrationPromise = resource.hydrate().then((cached) => {
        if (generation !== resource.generation || !cached || resource.snapshot.status !== 'idle') return;
        if (isIdentityKey(key) && cached.data && typeof cached.data === 'object' && 'id' in cached.data) { setResourceIdentity(String((cached.data as { id: string }).id)); generation = resource.generation; }
        resource.snapshot = stable({ userId: resolvedUser, data: cached.data, fetchedAt: cached.fetchedAt ?? now(), status: 'ready', loading: false, revalidating: false, stale: false, offline: cached.offline === true && !online() });
        notify(resource);
      }).catch(() => undefined).finally(() => {
        if (generation !== resource.generation) return;
        resource.hydrationPromise = undefined;
        const missed = resource.snapshot.status === 'idle';
        if (missed) resource.snapshot = stable({ ...resource.snapshot });
        notify(resource);
        if (missed && resource.visible > 0 && isVisible() && !options.skipWhenOffline) void revalidate<T>(key, resolvedUser, resource.forcePending || { reason: 'route' });
      });
    }
    if (resource.hydrationPromise || options.skipWhenOffline) return;
    const due = snapshot.fetchedAt !== undefined && !isResourceFresh(snapshot, resource.ttl);
    if (snapshot.status !== 'auth-blocked' && (snapshot.status === 'idle' || (due || snapshot.stale) && !snapshot.revalidating && !snapshot.error && (!snapshot.offline || online()))) void revalidate<T>(key, resolvedUser, resource.forcePending || { reason: 'route' });
  }, [key, resolvedUser, snapshot.status, snapshot.stale, snapshot.revalidating, snapshot.fetchedAt, resource?.ttl, options.skipWhenOffline]);
  const canonical = key?.startsWith(`balances:${resolvedUser}:`) ? getPersonalBalance(resolvedUser, key.slice(`balances:${resolvedUser}:`.length)) : undefined;
  const breakdown = snapshot.data as { balances?: Record<string, Balances>; ledgerRevision?: number } | undefined;
  const breakdownRevision = breakdown?.ledgerRevision ?? Object.values(breakdown?.balances || {})[0]?.personalBalance?.ledgerRevision;
  const behind = !!canonical && (canonical.stale || (breakdownRevision ?? -1) < canonical.snapshot.ledgerRevision);
  const refreshedRevision = useRef<number>();
  useEffect(() => {
    if (behind && canonical && !canonical.stale && key && !snapshot.revalidating && !snapshot.error && refreshedRevision.current !== canonical.snapshot.ledgerRevision) {
      refreshedRevision.current = canonical.snapshot.ledgerRevision;
      void revalidate(key, resolvedUser, { force: true, reason: 'focus' }).catch(() => undefined);
    }
  }, [behind, canonical?.snapshot.ledgerRevision, key, resolvedUser, snapshot.revalidating, snapshot.error]);
  return behind ? { ...snapshot, stale: true } : snapshot;
}

export function isResourceFresh<T>(snapshot: ResourceSnapshot<T>, ttl = MIN_RESOURCE_FRESHNESS_MS, at = now()) {
  return snapshot.data !== undefined && snapshot.fetchedAt !== undefined && at - snapshot.fetchedAt < Math.max(MIN_RESOURCE_FRESHNESS_MS, ttl);
}

export function seedResource<T>(key: ResourceKey, userId: string, data: T, fetchedAt = now(), options: { offline?: boolean } = {}) {
  const scopedUserId = isIdentityKey(key) ? 'identity' : userId;
  const resource = entry<T>(key, scopedUserId, MIN_RESOURCE_FRESHNESS_MS);
  resource.evicted = false;
  resource.snapshot = stable({ userId: scopedUserId, data, fetchedAt, status: 'ready', loading: false, revalidating: false, stale: false, offline: options.offline === true });
  notify(resource);
}

export function invalidateResource(key: ResourceKey, userId = activeUserId || '', options: { revalidate?: boolean } = {}) {
  if (key === resourceKeys.groups(userId) || key.startsWith(`balances:${userId}:`)) {
    if (key.startsWith(`balances:${userId}:`)) {
      const groups = invalidatedBalanceGroups.get(userId) || new Set<string>();
      groups.add(key.slice(`balances:${userId}:`.length)); invalidatedBalanceGroups.set(userId, groups);
    }
    stalePersonalBalances(userId, key.startsWith('balances:') ? key.slice(`balances:${userId}:`.length) : undefined);
  }
  const resource = entry<unknown>(key, userId, MIN_RESOURCE_FRESHNESS_MS);
  resource.generation += 1;
  resource.controller?.abort();
  resource.forcePending = { force: true, reason: 'mutation' };
  resource.snapshot = stable({ ...resource.snapshot, stale: true, error: undefined, revalidating: false, loading: false });
  notify(resource);
  signalResourceInvalidated();
  if (options.revalidate !== false && resource.visible > 0) void revalidate(key, userId, resource.forcePending);
}

/** Remove a resource rather than merely marking its old value stale. This is
 * used when authorization has ended: back navigation must not render the
 * revoked group's private data while a new request is pending. */
export function evictResource(key: ResourceKey, userId = activeUserId || '') {
  const resource = entries.get(key);
  if (!resource || (userId && resource.snapshot.userId !== userId)) return;
  resource.controller?.abort();
  resource.generation += 1;
  resource.promise = undefined;
  resource.hydrationPromise = undefined;
  resource.forcePending = undefined;
  resource.loader = undefined;
  resource.hydrate = undefined;
  resource.evicted = true;
  resource.snapshot = idleSnapshot(resource.snapshot.userId);
  notify(resource);
  signalResourceInvalidated();
  if (!resource.visible && !resource.listeners.size) entries.delete(key);
}

export function evictResourcePrefix(prefix: string, userId = activeUserId || '') {
  for (const key of [...entries.keys()]) if (key.startsWith(prefix)) evictResource(key, userId);
}

export function evictGroupResources(groupId: string, userId: string) {
  const exact = [
    resourceKeys.group(userId, groupId), resourceKeys.members(userId, groupId),
    resourceKeys.expenses(userId, groupId), resourceKeys.credits(userId, groupId), resourceKeys.balances(userId, groupId),
    resourceKeys.settlements(userId, groupId), resourceKeys.scheduledExpenses(userId, groupId),
    resourceKeys.transactions(userId, groupId),
    resourceKeys.transactions(userId, 'all'),
    resourceKeys.activity(userId, groupId), resourceKeys.audit(userId, groupId),
    resourceKeys.groupInvitations(userId, groupId),
    resourceKeys.invitations(userId),
  ];
  for (const key of exact) evictResource(key, userId);
  evictResourcePrefix(`expenses:${userId}:${groupId}:`, userId);
  evictResourcePrefix(`credits:${userId}:${groupId}:`, userId);
  evictResourcePrefix(`transactions:${userId}:${groupId}:`, userId);
  evictResourcePrefix(`audit-entity:${userId}:${groupId}:`, userId);
  evictResourcePrefix(`transactions:${userId}:`, userId);
  // Detail resources do not include a group ID in their key. Evict details
  // whose loaded payload identifies this group, as well as schedule details.
  for (const [key, resource] of entries) {
    if (resource.snapshot.userId !== userId || resource.snapshot.data === undefined) continue;
    const data = resource.snapshot.data as { expense?: { groupId?: string }; settlement?: { groupId?: string }; credit?: { groupId?: string }; scheduledExpense?: { groupId?: string } };
    if (data.expense?.groupId === groupId || data.settlement?.groupId === groupId || data.credit?.groupId === groupId || data.scheduledExpense?.groupId === groupId) evictResource(key, userId);
  }
  evictResource(resourceKeys.activity(userId, 'all'), userId);
  evictResource(resourceKeys.groups(userId), userId);
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('billsplit-group-revoked', { detail: { groupId } }));
}

function invalidateScheduledDetailsForGroup(groupId: string, userId: string) {
  const list = entries.get(resourceKeys.scheduledExpenses(userId, groupId));
  const scheduledIds = new Set(
    ((list?.snapshot.data as { scheduledExpenses?: Array<{ id?: string }> } | undefined)?.scheduledExpenses || [])
      .map((scheduled) => scheduled.id)
      .filter((id): id is string => typeof id === 'string'),
  );
  for (const [key, resource] of entries) {
    if (resource.snapshot.userId !== userId || resource.snapshot.data === undefined) continue;
    const data = resource.snapshot.data as { scheduledExpense?: { groupId?: string } };
    const scheduleId = key.startsWith(`scheduled-expense:${userId}:`) ? key.slice(`scheduled-expense:${userId}:`.length) : undefined;
    if (data.scheduledExpense?.groupId === groupId || scheduleId !== undefined && scheduledIds.has(scheduleId)) invalidateResource(key, userId);
  }
}

export function invalidateResources(keys: Iterable<ResourceKey>, userId = activeUserId || '') {
  for (const key of keys) invalidateResource(key, userId);
}
/** Apply a server-confirmed group-settings response without disturbing ledger resources. */
export function patchResourceData<T>(key: ResourceKey, userId: string, patch: (data: T) => T) {
  const resource = entries.get(key);
  if (!resource || resource.snapshot.userId !== userId || resource.snapshot.data === undefined) return false;
  resource.snapshot = stable({ ...resource.snapshot, data: patch(resource.snapshot.data as T), fetchedAt: now(), stale: false, offline: false, error: undefined });
  notify(resource);
  return true;
}
/** Apply a server-confirmed group discriminator before its background refresh. */
export async function applyConfirmedGroup(groupId: string, userId: string, group: Group, generation = captureSessionGeneration()) {
  if (!isSessionGenerationCurrent(generation)) return;
  // Abort/fence a GET that started before the mutation. The persisted
  // mutation generation below protects the same race in IndexedDB.
  invalidateResource(resourceKeys.group(userId, groupId), userId, { revalidate: false });
  invalidateResource(resourceKeys.groups(userId), userId, { revalidate: false });
  patchResourceData<GroupResponse>(resourceKeys.group(userId, groupId), userId, (data) => ({ ...data, group }));
  patchResourceData<{ groups: Group[] }>(resourceKeys.groups(userId), userId, (data) => ({ ...data, groups: data.groups.map((candidate) => candidate.id === groupId ? { ...candidate, ...group } : candidate) }));
  await invalidatePersistedCaches(userId, generation, { groups: false });
  try { await updateGroupSnapshot(userId, groupId, { group }, generation); } catch { /* Private cache is an enhancement, not a mutation failure. */ }
  try { await updateGroupsSnapshot(userId, groupId, group, generation); } catch { /* Private cache is an enhancement, not a mutation failure. */ }
}
export function invalidateResourcePrefix(prefix: string, userId = activeUserId || '', options: { revalidate?: boolean } = {}) {
  for (const [key, resource] of entries) if (key.startsWith(prefix) && (!userId || resource.snapshot.userId === userId)) invalidateResource(key, userId, options);
}

export function clearResourceCache(userId?: string, preserveKey?: ResourceKey) {
  clearPersonalBalances(); pendingInvalidationUsers.clear();
  invalidatedBalanceGroups.clear();
  if (balancePollTimer) { clearInterval(balancePollTimer); balancePollTimer = undefined; }
  for (const [key, resource] of entries) {
    if (key === preserveKey) continue;
    if (userId && resource.snapshot.userId !== userId) continue;
    if (resource.snapshot.data !== undefined || resource.snapshot.status !== 'idle' || resource.promise || resource.hydrationPromise) {
      resource.snapshot = idleSnapshot(resource.snapshot.userId);
      resource.controller?.abort();
      resource.generation += 1;
      resource.promise = undefined;
      resource.hydrationPromise = undefined;
      notify(resource);
    }
    if (!resource.visible) entries.delete(key);
  }
}

export async function revalidate<T>(key: ResourceKey, userId = activeUserId || '', options: RevalidateOptions = {}): Promise<T | undefined> {
  const resource = entry<T>(key, userId, MIN_RESOURCE_FRESHNESS_MS);
  if (pendingInvalidationUsers.has(userId)) return resource.snapshot.data;
  if (!authLifecycleReady && options.reason !== 'auth-restored') return resource.snapshot.data;
  if (resource.evicted || !resource.loader || !isVisible()) return resource.snapshot.data;
  if (isIdentityKey(key) && resource.snapshot.status === 'auth-blocked' && options.reason !== 'auth-restored') return resource.snapshot.data;
  // A cold offline visit has no useful request to make. Leave the resource
  // idle so the route can render its expected unavailable state instead of a
  // network error (cached resources still return their last value here).
  if (!online()) return resource.snapshot.data;
  const force = options.force === true || (isIdentityKey(key) && options.reason === 'identity-check');
  if (!force && isResourceFresh(resource.snapshot, resource.ttl)) return resource.snapshot.data;
  if (resource.promise) { if (force) resource.forcePending = options; return resource.promise; }
  const generation = resource.generation;
  const requestIdentityEpoch = identityEpoch;
  const requestSessionGeneration = captureSessionGeneration();
  const requestUserId = userId;
  const requestIsCurrent = () => generation === resource.generation && requestIdentityEpoch === identityEpoch && isSessionGenerationCurrent(requestSessionGeneration) && (isIdentityKey(key) || activeUserId === undefined || activeUserId === requestUserId);
  const retryingFromAuthBlocked = isIdentityKey(key) && resource.snapshot.status === 'auth-blocked' && options.reason === 'auth-restored';
  resource.forcePending = undefined;
  const hasData = resource.snapshot.data !== undefined;
  resource.snapshot = stable({ ...resource.snapshot, status: hasData ? 'ready' : 'loading', loading: !hasData, revalidating: hasData, stale: hasData ? true : resource.snapshot.stale, offline: false, error: undefined });
  notify(resource);
  resource.controller = new AbortController();
  resource.promise = (async () => { if (!isVisible()) throw new DOMException('Hidden document', 'AbortError'); return resource.loader!(resource.controller!.signal); })().then((data) => {
    if (!requestIsCurrent()) return data;
    const metadata = data && typeof data === 'object' ? data as { offline?: boolean; stale?: boolean } : {};
    resource.snapshot = stable({ userId, data, fetchedAt: now(), status: 'ready', loading: false, revalidating: false, stale: metadata.stale === true, offline: metadata.offline === true });
    notify(resource);
    return data;
  }).catch((error: unknown) => {
    if (!requestIsCurrent()) return resource.snapshot.data as T;
    if (retryingFromAuthBlocked) {
      resource.snapshot = stable({ ...resource.snapshot, status: 'auth-blocked', loading: false, revalidating: false, stale: true, offline: !online(), error });
      notify(resource);
      throw error;
    }
    if (error instanceof DOMException && error.name === 'AbortError') { resource.snapshot = stable({ ...resource.snapshot, loading: false, revalidating: false, stale: true, error: undefined }); notify(resource); return resource.snapshot.data as T; }
    const hasCurrent = resource.snapshot.data !== undefined;
    resource.snapshot = stable({ ...resource.snapshot, status: hasCurrent ? 'ready' : 'error', loading: false, revalidating: false, stale: true, offline: !online(), error });
    notify(resource);
    if (!hasCurrent) throw error;
    return resource.snapshot.data as T;
   }).finally(() => {
     // A mutation deliberately changes the resource generation while this
     // request is in flight. Its response must be ignored, but its queued
     // refresh must still run. Identity/session changes, unlike mutations,
     // must never revive an old user's request.
     if (resource.promise !== request) return;
     resource.controller = undefined;
     resource.promise = undefined;
     const pending = resource.forcePending;
     if (pending && resource.visible > 0 && isVisible() && requestIdentityEpoch === identityEpoch && isSessionGenerationCurrent(requestSessionGeneration) && (isIdentityKey(key) || activeUserId === undefined || activeUserId === requestUserId)) void revalidate(key, resource.snapshot.userId, pending).catch(() => undefined);
   });
   const request = resource.promise;
  return resource.promise;
}

export function trackVisibleResource(key: ResourceKey, userId = activeUserId || '') {
  const resource = entry<unknown>(key, userId, MIN_RESOURCE_FRESHNESS_MS);
  if (resource.evictionTimer) { clearTimeout(resource.evictionTimer); resource.evictionTimer = undefined; }
  resource.visible += 1;
  updateBalancePolling();
  return () => { resource.visible = Math.max(0, resource.visible - 1); updateBalancePolling(); };
}

function foregroundRefresh(identityCheck = false, forcePrivate = false) {
  if (!authLifecycleReady || !isVisible() || !online()) return Promise.resolve();
  const identity = entries.get('identity');
  // Identity verification is owned by the auth coordinator. Foreground cache
  // refresh may update private resources, but must never start a second /me
  // probe during the same wake event.
  const identityDue = identity && Date.now() >= authResumeSuppressedUntil && identity.snapshot.status !== 'auth-blocked' && (identityCheck || !isResourceFresh(identity.snapshot, identity.ttl) || identity.snapshot.stale || identity.snapshot.status === 'idle');
  const refreshStartedAt = identityEpoch;
  const refreshPrivate = () => {
    if (!identity || identity.snapshot.status !== 'ready' || identity.snapshot.error || refreshStartedAt !== identityEpoch) return;
    const requests: Promise<unknown>[] = [];
    for (const [key, resource] of entries) {
      if (key === 'identity' || resource.visible <= 0 || resource.snapshot.status === 'auth-blocked') continue;
      if (forcePrivate || resource.forcePending || (resource.snapshot.fetchedAt !== undefined && now() - resource.snapshot.fetchedAt >= resource.ttl) || (resource.snapshot.stale && (!resource.snapshot.offline || online())) || resource.snapshot.status === 'idle' || resource.snapshot.status === 'error') requests.push(revalidate(key, resource.snapshot.userId, forcePrivate ? { force: true, reason: 'auth-restored' } : resource.forcePending || { reason: 'focus' }).catch(() => undefined));
    }
    return Promise.all(requests).then(() => undefined);
  };
  if (identityDue && identity?.visible) return revalidate('identity', 'identity', { reason: identityCheck ? 'identity-check' : 'focus' }).then(refreshPrivate, refreshPrivate);
  if (!identityDue) return refreshPrivate();
  return Promise.resolve();
}
/** Force every currently visible private resource after a successful /me. */
export const refreshVisiblePrivateResources = () => foregroundRefresh(false, true);
export function initializeForegroundCoordinator() {
  if (coordinatorInstalled || typeof window === 'undefined') return;
  coordinatorInstalled = true;
  window.addEventListener('billsplit-auth-resume-started', () => { authResumeSuppressedUntil = Date.now() + 15_000; });
  window.addEventListener('billsplit-auth-resumed', () => { authResumeSuppressedUntil = Date.now() + 500; });
  const schedule = (identityCheck = false) => { coordinatorIdentityCheck ||= identityCheck; if (coordinatorTimer) clearTimeout(coordinatorTimer); coordinatorTimer = setTimeout(() => { coordinatorTimer = undefined; const check = coordinatorIdentityCheck; coordinatorIdentityCheck = false; foregroundRefresh(check); }, 100); };
  document.addEventListener('visibilitychange', () => {
    updateBalancePolling();
    if (!isVisible()) {
      for (const resource of entries.values()) if (resource.controller) {
        resource.controller.abort(); resource.generation += 1; resource.forcePending = resource.forcePending?.force ? resource.forcePending : { reason: 'visibility' };
        resource.snapshot = stable({ ...resource.snapshot, status: resource.snapshot.data === undefined ? 'idle' : 'ready', loading: false, revalidating: false, stale: true, error: undefined });
        notify(resource);
      }
    } else schedule();
  });
  window.addEventListener('focus', () => { if (isVisible()) schedule(); });
  window.addEventListener('pageshow', () => { if (isVisible()) schedule(); });
  window.addEventListener('online', () => { if (isVisible()) schedule(); });
  window.addEventListener('online', updateBalancePolling);
  window.addEventListener('offline', updateBalancePolling);
  window.addEventListener('billsplit-connection-restored', () => { if (isVisible()) schedule(); });
}

export const resourceKey = (resource: string, scope = '') => `${resource}:${scope}`;
export const resourceKeys = Object.freeze({
  identity: () => 'identity' as ResourceKey,
  groups: (userId: string) => resourceKey('groups', userId),
  group: (userId: string, groupId: string) => resourceKey('group', `${userId}:${groupId}`),
  members: (userId: string, groupId: string) => resourceKey('members', `${userId}:${groupId}`),
  expenses: (userId: string, groupId: string, filterKey = '') => resourceKey('expenses', `${userId}:${groupId}${filterKey ? `:${filterKey}` : ''}`),
  credits: (userId: string, groupId: string, filterKey = '') => resourceKey('credits', `${userId}:${groupId}${filterKey ? `:${filterKey}` : ''}`),
  transactions: (userId: string, groupId: string, filterKey = '') => resourceKey('transactions', `${userId}:${groupId}${filterKey ? `:${filterKey}` : ''}`),
  balances: (userId: string, groupId: string) => resourceKey('balances', `${userId}:${groupId}`),
  settlements: (userId: string, groupId: string) => resourceKey('settlements', `${userId}:${groupId}`),
  scheduledExpenses: (userId: string, groupId: string) => resourceKey('scheduled-expenses', `${userId}:${groupId}`),
  scheduledExpense: (userId: string, scheduleId: string) => resourceKey('scheduled-expense', `${userId}:${scheduleId}`),
  activity: (userId: string, groupId: string) => resourceKey('activity', `${userId}:${groupId}`),
  insights: (userId: string, scope: string) => resourceKey('insights', `${userId}:${scope}`),
  invitations: (userId: string) => resourceKey('invitations', userId),
  groupInvitations: (userId: string, groupId: string) => resourceKey('group-invitations', `${userId}:${groupId}`),
  audit: (userId: string, groupId: string) => resourceKey('audit', `${userId}:${groupId}`),
  auditEntity: (userId: string, groupId: string, entityType: string, entityId: string) => resourceKey('audit-entity', `${userId}:${groupId}:${entityType}:${entityId}`),
  categories: (userId: string) => resourceKey('categories', userId),
  expenseDetail: (userId: string, expenseId: string) => resourceKey('expense-detail', `${userId}:${expenseId}`),
  settlementDetail: (userId: string, settlementId: string) => resourceKey('settlement-detail', `${userId}:${settlementId}`),
  creditDetail: (userId: string, creditId: string) => resourceKey('credit-detail', `${userId}:${creditId}`),
});
const invalidatePersistedCaches = async (userId: string, generation = captureSessionGeneration(), options: { activity?: boolean; categories?: boolean; groups?: boolean; groupId?: string; detailsGroupId?: string; transactions?: boolean; transactionGroupId?: string } = {}) => {
  try { await invalidateCachedGroups(userId, generation, options); } catch { /* Private cache is an enhancement, not a mutation failure. */ }
  if (!isSessionGenerationCurrent(generation)) return;
  // Only the shared-ledger operations acquire the groups gate. Other cache
  // writes (e.g. split defaults) must not release another operation's lease.
  if (options.transactionGroupId && !options.groups) {
    const outstanding = pendingInvalidationUsers.get(userId) || 0;
    if (outstanding > 1) { pendingInvalidationUsers.set(userId, outstanding - 1); return; }
    pendingInvalidationUsers.delete(userId);
  }
  if (pendingInvalidationUsers.has(userId)) return;
  const groups = invalidatedBalanceGroups.get(userId) || new Set<string>();
  if (options.transactionGroupId) groups.add(options.transactionGroupId);
  invalidatedBalanceGroups.delete(userId);
  for (const groupId of groups) broadcastBalanceHint(userId, groupId);
  for (const [key, resource] of entries) if (resource.snapshot.userId === userId && resource.visible > 0 && resource.snapshot.stale) void revalidate(key, userId, { force: true, reason: 'mutation' }).catch(() => undefined);
};
const invalidateSharedResources = invalidateResources;
export const invalidateForMutation = (() => {
  const invalidateResources = (keys: Iterable<ResourceKey>, userId: string) => {
    const list = [...keys];
    if (list.includes(resourceKeys.groups(userId))) pendingInvalidationUsers.set(userId, (pendingInvalidationUsers.get(userId) || 0) + 1);
    invalidateSharedResources(list, userId);
  };
  return {
  groupCreated: async (userId?: string, generation?: number) => { if (!userId) return; invalidateResource(resourceKeys.groups(userId), userId); await invalidatePersistedCaches(userId, generation); },
  groupChanged: async (groupId: string, userId?: string, generation?: number) => { if (!userId) return; invalidateResources([resourceKeys.groups(userId), resourceKeys.group(userId, groupId), resourceKeys.members(userId, groupId), resourceKeys.groupInvitations(userId, groupId), resourceKeys.transactions(userId, groupId), resourceKeys.transactions(userId, 'all'), resourceKeys.activity(userId, groupId), resourceKeys.activity(userId, 'all'), resourceKeys.audit(userId, groupId), resourceKeys.balances(userId, groupId), resourceKeys.scheduledExpenses(userId, groupId)], userId); invalidateResourcePrefix(`transactions:${userId}:`, userId); invalidateResourcePrefix(`insights:${userId}:`, userId); invalidateScheduledDetailsForGroup(groupId, userId); await invalidatePersistedCaches(userId, generation, { activity: true, transactions: true, transactionGroupId: groupId }); },
  splitDefaultChanged: async (groupId: string, splitDefault: Parameters<typeof updateGroupSnapshot>[2]['splitDefault'], userId?: string, generation?: number) => {
    if (!userId) return;
    const mutationGeneration = generation ?? captureSessionGeneration();
    if (!isSessionGenerationCurrent(mutationGeneration)) return;
    // Abort/fence a GET that was started before the server mutation. The
    // persisted mutation generation below protects the same race in IDB.
    invalidateResource(resourceKeys.group(userId, groupId), userId, { revalidate: false });
    patchResourceData<{ group: unknown; members: unknown[]; splitDefault?: Parameters<typeof updateGroupSnapshot>[2]['splitDefault'] }>(resourceKeys.group(userId, groupId), userId, (data) => ({ ...data, splitDefault }));
    await invalidatePersistedCaches(userId, mutationGeneration, { groups: false });
    try { await updateGroupSnapshot(userId, groupId, { splitDefault }, mutationGeneration); } catch { /* Local cache is an enhancement, not a mutation failure. */ }
  },
  groupDeleted: async (groupId: string, userId?: string, generation?: number) => { if (!userId) return; evictGroupResources(groupId, userId); invalidateResourcePrefix(`insights:${userId}:`, userId); await invalidatePersistedCaches(userId, generation, { activity: true, groups: true, groupId, transactions: true, transactionGroupId: groupId }); },
  groupLeft: async (groupId: string, userId?: string, generation?: number) => { if (!userId) return; evictGroupResources(groupId, userId); invalidateResourcePrefix(`insights:${userId}:`, userId); await invalidatePersistedCaches(userId, generation, { activity: true, groups: true, groupId, transactions: true, transactionGroupId: groupId }); },
  groupAccessRevoked: async (groupId: string, userId?: string, generation?: number) => { if (!userId) return; evictGroupResources(groupId, userId); invalidateResourcePrefix(`insights:${userId}:`, userId); await invalidatePersistedCaches(userId, generation, { activity: true, groups: true, groupId, transactions: true, transactionGroupId: groupId }); },
  expenseChanged: async (groupId: string, expenseId?: string, userId?: string, generation?: number) => { if (!userId) return; invalidateResources([resourceKeys.groups(userId), resourceKeys.expenses(userId, groupId), resourceKeys.credits(userId, groupId), resourceKeys.transactions(userId, groupId), resourceKeys.transactions(userId, 'all'), resourceKeys.balances(userId, groupId), resourceKeys.activity(userId, groupId), resourceKeys.activity(userId, 'all'), resourceKeys.audit(userId, groupId), resourceKeys.categories(userId), resourceKeys.settlements(userId, groupId), ...(expenseId ? [resourceKeys.expenseDetail(userId, expenseId), resourceKeys.auditEntity(userId, groupId, 'expense', expenseId)] : [])], userId); invalidateResourcePrefix(`expenses:${userId}:${groupId}:`, userId); invalidateResourcePrefix(`credits:${userId}:${groupId}:`, userId); invalidateResourcePrefix(`credit-detail:${userId}:`, userId); invalidateResourcePrefix(`transactions:${userId}:`, userId); invalidateResourcePrefix(`insights:${userId}:`, userId); await invalidatePersistedCaches(userId, generation, { activity: true, categories: true, transactions: true, detailsGroupId: groupId, transactionGroupId: groupId }); },
   settlementChanged: async (groupId: string, userId?: string, settlementIdOrGeneration?: string | number, generation?: number) => { if (!userId) return; const settlementId = typeof settlementIdOrGeneration === 'string' ? settlementIdOrGeneration : undefined; const mutationGeneration = typeof settlementIdOrGeneration === 'number' ? settlementIdOrGeneration : generation; invalidateResources([resourceKeys.groups(userId), resourceKeys.settlements(userId, groupId), resourceKeys.transactions(userId, groupId), resourceKeys.transactions(userId, 'all'), resourceKeys.balances(userId, groupId), resourceKeys.activity(userId, groupId), resourceKeys.activity(userId, 'all'), resourceKeys.audit(userId, groupId), ...(settlementId ? [resourceKeys.settlementDetail(userId, settlementId), resourceKeys.auditEntity(userId, groupId, 'settlement', settlementId)] : [])], userId); invalidateResourcePrefix(`transactions:${userId}:`, userId); await invalidatePersistedCaches(userId, mutationGeneration, { activity: true, transactions: true, transactionGroupId: groupId }); },
  creditChanged: async (groupId: string, userId?: string, creditId?: string, generation?: number) => { if (!userId) return; invalidateResources([resourceKeys.groups(userId), resourceKeys.expenses(userId, groupId), resourceKeys.credits(userId, groupId), resourceKeys.transactions(userId, groupId), resourceKeys.transactions(userId, 'all'), resourceKeys.balances(userId, groupId), resourceKeys.activity(userId, groupId), resourceKeys.activity(userId, 'all'), resourceKeys.audit(userId, groupId), ...(creditId ? [resourceKeys.creditDetail(userId, creditId), resourceKeys.auditEntity(userId, groupId, 'credit', creditId)] : [])], userId); invalidateResourcePrefix(`expenses:${userId}:${groupId}:`, userId); invalidateResourcePrefix(`expense-detail:${userId}:`, userId); invalidateResourcePrefix(`credits:${userId}:${groupId}:`, userId); invalidateResourcePrefix(`transactions:${userId}:`, userId); invalidateResourcePrefix(`insights:${userId}:`, userId); await invalidatePersistedCaches(userId, generation, { activity: true, transactions: true, detailsGroupId: groupId, transactionGroupId: groupId }); },
  invitationsChanged: async (groupId?: string, userId?: string) => { if (!userId) return; invalidateResources([resourceKeys.invitations(userId), ...(groupId ? [resourceKeys.groupInvitations(userId, groupId)] : [])], userId); },
  scheduledExpenseChanged: async (groupId: string, userId?: string, scheduledExpenseId?: string, generation?: number) => { if (!userId) return; invalidateResources([resourceKeys.scheduledExpenses(userId, groupId), resourceKeys.categories(userId), ...(scheduledExpenseId ? [resourceKeys.scheduledExpense(userId, scheduledExpenseId)] : [])], userId); await invalidatePersistedCaches(userId, generation, { categories: true, groups: false }); },
  profileChanged: async (userId: string, generation?: number, profile?: { personId: string; name: string; avatarMode?: 'initials' | 'gravatar'; avatarHash?: string; profileRevision?: number; updatedAt?: string }) => {
    if (profile) {
      patchResourceData<{ id: string; name: string; profileRevision?: number; updatedAt?: string }>(resourceKeys.identity(), '', (data) => data.id === userId ? { ...data, name: profile.name, ...(profile.avatarMode === undefined ? {} : { avatarMode: profile.avatarMode, avatarHash: profile.avatarHash }), ...(profile.profileRevision === undefined ? {} : { profileRevision: profile.profileRevision }), ...(profile.updatedAt ? { updatedAt: profile.updatedAt } : {}) } : data);
    } else invalidateResource(resourceKeys.identity(), '');
      for (const prefix of ['groups:', 'group:', 'members:', 'expenses:', 'credits:', 'transactions:', 'balances:', 'settlements:', 'scheduled-expenses:', 'scheduled-expense:', 'activity:', 'insights:', 'audit:', 'audit-entity:', 'expense-detail:', 'settlement-detail:', 'credit-detail:']) invalidateResourcePrefix(prefix, userId);
    await invalidatePersistedCaches(userId, generation, { groups: true, activity: true, transactions: true });
  },
  };
})();

initializeForegroundCoordinator();
if (typeof window !== 'undefined') window.addEventListener('billsplit-cache-cleared', () => clearResourceCache());
if (typeof window !== 'undefined') window.addEventListener('billsplit-authenticated', () => {
  allowIdentityVerification();
  // /api/me has just established the identity. Refresh visible stale private
  // resources, but do not force identity itself (that would issue a second
  // /me immediately after authentication).
  void refreshVisiblePrivateResources();
});
