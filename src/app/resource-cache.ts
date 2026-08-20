import { useEffect, useSyncExternalStore } from 'react';
import { invalidateCachedGroups } from './idb';

/** The shortest freshness window used by the application. */
export const MIN_RESOURCE_FRESHNESS_MS = 30_000;
export const RESOURCE_FRESHNESS = Object.freeze({
  groups: 60_000,
  group: 300_000,
  members: 300_000,
  expenses: 30_000,
  balances: 30_000,
  settlements: 30_000,
  activity: 30_000,
  expenseDetail: 30_000,
  expenseHistory: 30_000,
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
export type RevalidateReason = 'route' | 'focus' | 'online' | 'visibility' | 'mutation' | 'auth-restored' | 'identity-check';
export interface RevalidateOptions { force?: boolean; reason?: RevalidateReason }

type Entry<T> = { snapshot: ResourceSnapshot<T>; loader?: ResourceLoader<T>; hydrate?: ResourceHydrator<T>; hydrationPromise?: Promise<void>; ttl: number; promise?: Promise<T>; controller?: AbortController; generation: number; forcePending?: RevalidateOptions; listeners: Set<() => void>; visible: number; evictionTimer?: ReturnType<typeof setTimeout> };
const entries = new Map<ResourceKey, Entry<unknown>>();
const identityListeners = new Set<() => void>();
let activeUserId: string | undefined;
let identityEpoch = 0;
let visible = typeof document === 'undefined' || document.visibilityState === 'visible';
let coordinatorInstalled = false;
let coordinatorTimer: ReturnType<typeof setTimeout> | undefined;
let coordinatorIdentityCheck = false;

const now = () => Date.now();
const online = () => typeof navigator === 'undefined' || navigator.onLine !== false;
const isVisible = () => typeof document === 'undefined' || document.visibilityState === 'visible';
const isIdentityKey = (key: ResourceKey) => key === 'identity';
const stable = <T>(snapshot: ResourceSnapshot<T>) => Object.freeze(snapshot);
const notify = <T>(entry: Entry<T>) => entry.listeners.forEach((listener) => listener());
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
  identityListeners.forEach((listener) => listener());
}
export function resetResourceIdentity() { if (activeUserId !== undefined) identityEpoch += 1; activeUserId = undefined; clearResourceCache(); identityListeners.forEach((listener) => listener()); }
export function blockResourceIdentity(error: unknown) {
  identityEpoch += 1;
  activeUserId = undefined;
  clearResourceCache(undefined, 'identity');
  const identity = entry<unknown>('identity', 'identity', MIN_RESOURCE_FRESHNESS_MS);
  identity.controller?.abort(); identity.generation += 1; identity.promise = undefined; identity.hydrationPromise = undefined; identity.forcePending = undefined;
  identity.snapshot = stable({ ...identity.snapshot, status: 'auth-blocked', loading: false, revalidating: false, stale: true, offline: false, error });
  notify(identity); identityListeners.forEach((listener) => listener());
}
export function allowIdentityVerification() {
  const identity = entries.get('identity');
  if (!identity || identity.snapshot.status !== 'auth-blocked') return;
  identity.snapshot = stable({ ...identity.snapshot, status: 'idle', loading: false, revalidating: false, stale: false, error: undefined });
  notify(identity);
}
export const getResourceIdentity = () => activeUserId;
export const getResourceIdentityEpoch = () => identityEpoch;
export function useResourceIdentityEpoch() { return useSyncExternalStore(subscribeResourceIdentity, getResourceIdentityEpoch, () => 0); }
export const subscribeResourceIdentity = (listener: () => void) => { identityListeners.add(listener); return () => identityListeners.delete(listener); };

export function getResourceSnapshot<T>(key: ResourceKey, userId = activeUserId || '') {
  return entry<T>(key, isIdentityKey(key) ? 'identity' : userId, MIN_RESOURCE_FRESHNESS_MS).snapshot;
}
export function configureResource<T>(key: ResourceKey, userId: string, loader: ResourceLoader<T>, ttl = MIN_RESOURCE_FRESHNESS_MS) {
  const resource = entry<T>(key, userId, ttl);
  resource.loader = loader;
  resource.ttl = Math.max(MIN_RESOURCE_FRESHNESS_MS, ttl);
  return resource.snapshot;
}
export function subscribeResource<T>(key: ResourceKey, listener: () => void, userId = activeUserId || '') {
  const resource = entry<T>(key, isIdentityKey(key) ? 'identity' : userId, MIN_RESOURCE_FRESHNESS_MS);
  if (resource.evictionTimer) { clearTimeout(resource.evictionTimer); resource.evictionTimer = undefined; }
  resource.listeners.add(listener);
  resource.visible += 1;
  return () => {
    resource.listeners.delete(listener); resource.visible = Math.max(0, resource.visible - 1);
    if (!resource.visible && !resource.listeners.size && !resource.evictionTimer) resource.evictionTimer = setTimeout(() => { if (!resource.visible && !resource.listeners.size) { resource.controller?.abort(); resource.generation += 1; resource.loader = undefined; resource.hydrate = undefined; resource.evictionTimer = undefined; entries.delete(key); } }, 5 * 60_000);
  };
}

export function useResource<T>(key: ResourceKey, userId: string | undefined, loader: ResourceLoader<T>, ttl = MIN_RESOURCE_FRESHNESS_MS, hydrate?: ResourceHydrator<T>) {
  const resolvedUser = isIdentityKey(key) ? 'identity' : userId || activeUserId || '';
  const resource = entry<T>(key, resolvedUser, ttl);
  resource.loader = loader;
  resource.hydrate = hydrate;
  resource.ttl = Math.max(MIN_RESOURCE_FRESHNESS_MS, ttl);
  const snapshot = useSyncExternalStore(
    (listener) => subscribeResource<T>(key, listener, resolvedUser),
    () => resource.snapshot,
    () => resource.snapshot,
  );
  useEffect(() => {
    if (!resolvedUser || !isVisible()) return;
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
        if (missed && isVisible()) void revalidate<T>(key, resolvedUser, resource.forcePending || { reason: 'route' });
      });
    }
    if (resource.hydrationPromise) return;
    const due = snapshot.fetchedAt !== undefined && !isResourceFresh(snapshot, resource.ttl);
    if (snapshot.status !== 'auth-blocked' && (snapshot.status === 'idle' || (due || snapshot.stale) && !snapshot.revalidating && !snapshot.error && (!snapshot.offline || online()))) void revalidate<T>(key, resolvedUser, resource.forcePending || { reason: 'route' });
  }, [key, resolvedUser, snapshot.status, snapshot.stale, snapshot.revalidating, snapshot.fetchedAt, resource.ttl]);
  return snapshot;
}

export function isResourceFresh<T>(snapshot: ResourceSnapshot<T>, ttl = MIN_RESOURCE_FRESHNESS_MS, at = now()) {
  return snapshot.data !== undefined && snapshot.fetchedAt !== undefined && at - snapshot.fetchedAt < Math.max(MIN_RESOURCE_FRESHNESS_MS, ttl);
}

export function readResource<T>(key: ResourceKey, userId = activeUserId || ''): T | undefined {
  return getResourceSnapshot<T>(key, userId).data;
}

export function seedResource<T>(key: ResourceKey, userId: string, data: T, fetchedAt = now(), options: { offline?: boolean } = {}) {
  const scopedUserId = isIdentityKey(key) ? 'identity' : userId;
  const resource = entry<T>(key, scopedUserId, MIN_RESOURCE_FRESHNESS_MS);
  resource.snapshot = stable({ userId: scopedUserId, data, fetchedAt, status: 'ready', loading: false, revalidating: false, stale: false, offline: options.offline === true });
  notify(resource);
}

export function invalidateResource(key: ResourceKey, userId = activeUserId || '', options: { revalidate?: boolean } = {}) {
  const resource = entry<unknown>(key, userId, MIN_RESOURCE_FRESHNESS_MS);
  resource.generation += 1;
  resource.controller?.abort();
  resource.forcePending = { force: true, reason: 'mutation' };
  resource.snapshot = stable({ ...resource.snapshot, stale: true, error: undefined, revalidating: false, loading: false });
  notify(resource);
  if (options.revalidate !== false && resource.visible > 0) void revalidate(key, userId, resource.forcePending);
}

export function invalidateResources(keys: Iterable<ResourceKey>, userId = activeUserId || '') { for (const key of keys) invalidateResource(key, userId); }

export function clearResourceCache(userId?: string, preserveKey?: ResourceKey) {
  for (const [key, resource] of entries) {
    if (key === preserveKey) continue;
    if (userId && resource.snapshot.userId !== userId) continue;
    if (resource.snapshot.data !== undefined || resource.snapshot.status !== 'idle' || resource.promise || resource.hydrationPromise) {
      const next = idleSnapshot(resource.snapshot.userId);
      resource.snapshot = next;
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
  if (!resource.loader || !isVisible()) return resource.snapshot.data;
  if (isIdentityKey(key) && resource.snapshot.status === 'auth-blocked' && options.reason !== 'auth-restored') return resource.snapshot.data;
  if (!online() && resource.snapshot.data !== undefined) return resource.snapshot.data;
  const force = options.force === true || (isIdentityKey(key) && options.reason === 'identity-check');
  if (!force && isResourceFresh(resource.snapshot, resource.ttl)) return resource.snapshot.data;
  if (resource.promise) { if (force) resource.forcePending = options; return resource.promise; }
  if (!isVisible()) return resource.snapshot.data;
  const generation = resource.generation;
  const retryingFromAuthBlocked = isIdentityKey(key) && resource.snapshot.status === 'auth-blocked' && options.reason === 'auth-restored';
  resource.forcePending = undefined;
  const hasData = resource.snapshot.data !== undefined;
  resource.snapshot = stable({ ...resource.snapshot, status: hasData ? 'ready' : 'loading', loading: !hasData, revalidating: hasData, stale: hasData ? true : resource.snapshot.stale, offline: false, error: undefined });
  notify(resource);
  resource.controller = new AbortController();
  resource.promise = (async () => { if (!isVisible()) throw new DOMException('Hidden document', 'AbortError'); return resource.loader!(resource.controller!.signal); })().then((data) => {
    if (generation !== resource.generation) return data;
    const metadata = data && typeof data === 'object' ? data as { offline?: boolean; stale?: boolean } : {};
    resource.snapshot = stable({ userId, data, fetchedAt: now(), status: 'ready', loading: false, revalidating: false, stale: metadata.stale === true, offline: metadata.offline === true });
    notify(resource);
    return data;
  }).catch((error: unknown) => {
    if (generation !== resource.generation) return resource.snapshot.data as T;
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
  }).finally(() => { if (generation === resource.generation) resource.controller = undefined; const pending = resource.forcePending; resource.promise = undefined; if (pending && resource.visible > 0 && isVisible()) void revalidate(key, resource.snapshot.userId, pending); });
  return resource.promise;
}

export function trackVisibleResource(key: ResourceKey, userId = activeUserId || '') {
  const resource = entry<unknown>(key, userId, MIN_RESOURCE_FRESHNESS_MS);
  if (resource.evictionTimer) { clearTimeout(resource.evictionTimer); resource.evictionTimer = undefined; }
  resource.visible += 1;
  return () => { resource.visible = Math.max(0, resource.visible - 1); };
}

function foregroundRefresh(identityCheck = false) {
  if (!isVisible() || !online()) return;
  const identity = entries.get('identity');
  const identityDue = identity && identity.snapshot.status !== 'auth-blocked' && (identityCheck || !isResourceFresh(identity.snapshot, identity.ttl) || identity.snapshot.stale || identity.snapshot.status === 'idle');
  const refreshPrivate = () => {
    if (!identity || identity.snapshot.status !== 'ready' || identity.snapshot.error) return;
    for (const [key, resource] of entries) {
    if (key === 'identity' || resource.visible <= 0 || resource.snapshot.status === 'auth-blocked') continue;
    if (resource.forcePending || (resource.snapshot.fetchedAt !== undefined && now() - resource.snapshot.fetchedAt >= resource.ttl) || (resource.snapshot.stale && (!resource.snapshot.offline || online())) || resource.snapshot.status === 'idle' || resource.snapshot.status === 'error') void revalidate(key, resource.snapshot.userId, resource.forcePending || { reason: 'focus' });
    }
  };
  if (identityDue && identity?.visible) void revalidate('identity', 'identity', { reason: identityCheck ? 'identity-check' : 'focus' }).finally(refreshPrivate); else if (!identityDue) refreshPrivate();
}
export function initializeForegroundCoordinator() {
  if (coordinatorInstalled || typeof window === 'undefined') return;
  coordinatorInstalled = true;
  const schedule = (identityCheck = false) => { coordinatorIdentityCheck ||= identityCheck; if (coordinatorTimer) clearTimeout(coordinatorTimer); coordinatorTimer = setTimeout(() => { coordinatorTimer = undefined; const check = coordinatorIdentityCheck; coordinatorIdentityCheck = false; foregroundRefresh(check); }, 100); };
  document.addEventListener('visibilitychange', () => {
    visible = isVisible();
    if (!visible) {
      for (const resource of entries.values()) if (resource.controller) {
        resource.controller.abort(); resource.generation += 1; resource.forcePending = resource.forcePending?.force ? resource.forcePending : { reason: 'visibility' };
        resource.snapshot = stable({ ...resource.snapshot, status: resource.snapshot.data === undefined ? 'idle' : 'ready', loading: false, revalidating: false, stale: true, error: undefined });
        notify(resource);
      }
    } else schedule(true);
  });
  window.addEventListener('focus', () => { if (isVisible()) schedule(true); });
  window.addEventListener('pageshow', () => { if (isVisible()) schedule(true); });
  window.addEventListener('online', () => { if (isVisible()) schedule(); });
}
export const isDocumentVisible = () => visible && isVisible();

export const resourceKey = (resource: string, scope = '') => `${resource}:${scope}`;
export const resourceKeys = Object.freeze({
  identity: () => 'identity' as ResourceKey,
  groups: (userId: string) => resourceKey('groups', userId),
  group: (userId: string, groupId: string) => resourceKey('group', `${userId}:${groupId}`),
  members: (userId: string, groupId: string) => resourceKey('members', `${userId}:${groupId}`),
  expenses: (userId: string, groupId: string) => resourceKey('expenses', `${userId}:${groupId}`),
  balances: (userId: string, groupId: string) => resourceKey('balances', `${userId}:${groupId}`),
  settlements: (userId: string, groupId: string) => resourceKey('settlements', `${userId}:${groupId}`),
  activity: (userId: string, groupId: string) => resourceKey('activity', `${userId}:${groupId}`),
  expenseDetail: (userId: string, expenseId: string) => resourceKey('expense-detail', `${userId}:${expenseId}`),
});
export const useCachedResource = useResource;
export const resourceCache = Object.freeze({
  getSnapshot: getResourceSnapshot,
  subscribe: subscribeResource,
  configure: configureResource,
  seed: seedResource,
  revalidate,
  invalidate: invalidateResource,
  invalidateMany: invalidateResources,
  clear: clearResourceCache,
});
const invalidatePersistedGroups = async (userId: string) => {
  try { await invalidateCachedGroups(userId); } catch { /* Private cache is an enhancement, not a mutation failure. */ }
};
export const invalidateForMutation = {
  groupCreated: async (userId?: string) => { if (!userId) return; invalidateResource(resourceKeys.groups(userId), userId); await invalidatePersistedGroups(userId); },
  groupChanged: async (groupId: string, userId?: string) => { if (!userId) return; invalidateResources([resourceKeys.groups(userId), resourceKeys.group(userId, groupId), resourceKeys.members(userId, groupId), resourceKeys.activity(userId, groupId), resourceKeys.balances(userId, groupId)], userId); await invalidatePersistedGroups(userId); },
  expenseChanged: async (groupId: string, expenseId?: string, userId?: string) => { if (!userId) return; invalidateResources([resourceKeys.groups(userId), resourceKeys.expenses(userId, groupId), resourceKeys.balances(userId, groupId), resourceKeys.activity(userId, groupId), resourceKeys.settlements(userId, groupId), ...(expenseId ? [resourceKeys.expenseDetail(userId, expenseId)] : [])], userId); await invalidatePersistedGroups(userId); },
  settlementChanged: async (groupId: string, userId?: string) => { if (!userId) return; invalidateResources([resourceKeys.groups(userId), resourceKeys.settlements(userId, groupId), resourceKeys.balances(userId, groupId), resourceKeys.activity(userId, groupId)], userId); await invalidatePersistedGroups(userId); },
};

initializeForegroundCoordinator();
if (typeof window !== 'undefined') window.addEventListener('billsplit-cache-cleared', () => clearResourceCache());
if (typeof window !== 'undefined') window.addEventListener('billsplit-auth-restored', () => allowIdentityVerification());
