/**
 * A deliberately small, token-free identity fence shared with the service
 * worker.  It is separate from the private application cache so clearing
 * cached data cannot accidentally make an old push credential usable again.
 */
import { getAuthEpoch, isAuthEpochCurrent } from './api';
import { captureSessionGeneration, isSessionGenerationCurrent } from './session';

export const NOTIFICATION_STATE_DB = 'bill-split-notification-state';
export const NOTIFICATION_STATE_VERSION = 1;
export const NOTIFICATION_IDENTITY_STORE = 'identity';
export const NOTIFICATION_BADGE_STORE = 'badge';

export type NotificationIdentityMarker = {
  key: 'current';
  userId: string | null;
  revoked: boolean;
  revision: number;
  updatedAt: string;
};

export type NotificationIdentityFence = { sessionGeneration: number; authEpoch: number };
const captureFence = (): NotificationIdentityFence => ({ sessionGeneration: captureSessionGeneration(), authEpoch: getAuthEpoch() });
const fenceIsCurrent = (fence: NotificationIdentityFence) => isSessionGenerationCurrent(fence.sessionGeneration) && isAuthEpochCurrent(fence.authEpoch);

const openState = (): Promise<IDBDatabase> => {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('Notification identity storage is unavailable.'));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(NOTIFICATION_STATE_DB, NOTIFICATION_STATE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(NOTIFICATION_IDENTITY_STORE)) request.result.createObjectStore(NOTIFICATION_IDENTITY_STORE, { keyPath: 'key' });
      if (!request.result.objectStoreNames.contains(NOTIFICATION_BADGE_STORE)) request.result.createObjectStore(NOTIFICATION_BADGE_STORE, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Notification identity storage is unavailable.'));
    request.onblocked = () => reject(new Error('Notification identity storage is busy.'));
  });
};

// API auth invalidation can request a revocation while an enrollment write is
// still committing. Serialize every marker write so that a revocation cannot
// be overtaken by a stale setNotificationIdentity call (or vice versa).
let identityWriteTail: Promise<void> | undefined;
const serializeIdentityWrite = <T>(operation: () => Promise<T>) => {
  const run = identityWriteTail ? identityWriteTail.then(operation) : operation();
  const settled = run.then(() => undefined, () => undefined);
  identityWriteTail = settled;
  void settled.finally(() => { if (identityWriteTail === settled) identityWriteTail = undefined; });
  return run;
};

const current = async () => {
  const db = await openState();
  return new Promise<NotificationIdentityMarker | undefined>((resolve, reject) => {
    const tx = db.transaction(NOTIFICATION_IDENTITY_STORE, 'readonly');
    const request = tx.objectStore(NOTIFICATION_IDENTITY_STORE).get('current');
    request.onsuccess = () => resolve(request.result as NotificationIdentityMarker | undefined);
    tx.oncomplete = () => db.close();
    tx.onerror = () => { db.close(); reject(tx.error || new Error('Notification identity storage is unavailable.')); };
    tx.onabort = () => { db.close(); reject(tx.error || new Error('Notification identity storage is unavailable.')); };
  });
};

const write = (userId: string | null, revoked: boolean, fence?: NotificationIdentityFence) => serializeIdentityWrite(async () => {
  // Revocation is destructive and must always be allowed to run. Enrollment
  // carries the generation and API epoch captured before its async work.
  if (!revoked && !fenceIsCurrent(fence || captureFence())) return false;
  const db = await openState();
  return new Promise<boolean>((resolve, reject) => {
    const tx = db.transaction(NOTIFICATION_IDENTITY_STORE, 'readwrite');
    const store = tx.objectStore(NOTIFICATION_IDENTITY_STORE);
    const read = store.get('current');
    read.onsuccess = () => {
      if (!revoked && !fenceIsCurrent(fence || captureFence())) {
        tx.abort();
        return;
      }
      const previous = read.result as NotificationIdentityMarker | undefined;
      store.put({ key: 'current', userId, revoked, revision: (previous?.revision || 0) + 1, updatedAt: new Date().toISOString() } satisfies NotificationIdentityMarker);
    };
    tx.oncomplete = () => { db.close(); resolve(true); };
    tx.onerror = () => { db.close(); reject(tx.error || new Error('Notification identity storage is unavailable.')); };
    tx.onabort = () => { db.close(); if (!revoked && !fenceIsCurrent(fence || captureFence())) resolve(false); else reject(tx.error || new Error('Notification identity storage is unavailable.')); };
  });
});

export const readNotificationIdentity = current;
export const setNotificationIdentity = (userId: string, fence?: NotificationIdentityFence) => write(userId, false, fence);
/** Revoke first; never depend on the server or a Clerk token for this fence. */
export const revokeNotificationIdentity = () => write(null, true);
