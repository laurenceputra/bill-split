import type { NotificationPreferences, NotificationStatus } from '../shared/types';
import { ApiError, getAuthEpoch, getNotificationStatus, isAuthEpochCurrent, putNotificationSubscription, removeNotificationSubscription, subscribeAuthEpoch, updateNotificationPreferences, type AuthEpochTransition } from './api';
import { readNotificationIdentity, revokeNotificationIdentity, setNotificationIdentity, type NotificationIdentityFence } from './notification-identity';
import { setNotificationBadge } from './notification-badge';
import { captureSessionGeneration, isSessionGenerationCurrent } from './session';
import { flushOutbox } from './outbox';

export type NotificationCapability = 'checking' | 'supported' | 'unavailable' | 'needs-install' | 'default' | 'denied' | 'disabled' | 'enabled' | 'error';
export type NotificationSnapshot = Readonly<{
  capability: NotificationCapability;
  permission: NotificationPermission | 'unsupported';
  status?: NotificationStatus;
  deviceSubscribed?: boolean;
  error?: unknown;
}>;

const initial: NotificationSnapshot = { capability: 'checking', permission: 'unsupported' };
let snapshot = initial;
let activeUserId: string | undefined;
let listeners = new Set<() => void>();
let notificationOperationTail: Promise<void> | undefined;
let initialized = false;
let localBadgeCount = 0;
let identityAdmissionRequired = false;
let enableInFlight = false;

const notify = () => listeners.forEach((listener) => listener());
const setSnapshot = (next: NotificationSnapshot) => {
  snapshot = Object.freeze(next);
  notify();
};
const permission = (): NotificationPermission | 'unsupported' => {
  if (typeof Notification === 'undefined') return 'unsupported';
  try { return Notification.permission; } catch { return 'unsupported'; }
};
export const isIosDevice = () => typeof navigator !== 'undefined' && /iphone|ipad|ipod/i.test(navigator.userAgent || '') || typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1 && /macintosh/i.test(navigator.userAgent || '');
export const isStandalonePwa = () => {
  if (typeof navigator !== 'undefined' && (navigator as Navigator & { standalone?: boolean }).standalone === true) return true;
  try { return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches; }
  catch { return false; }
};
export const notificationSupported = () => typeof window !== 'undefined' && typeof navigator !== 'undefined' && 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
export const notificationNeedsInstall = () => isIosDevice() && !isStandalonePwa();
export const getNotificationSnapshot = () => snapshot;
export const subscribeNotifications = (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); };

/** Convert URL-safe VAPID material without using deprecated escape/atob tricks. */
export function base64UrlToUint8Array(value: string) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('The VAPID public key is not valid base64url.');
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
  const decoded = atob(padded);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

const capabilityFor = (status?: NotificationStatus, deviceSubscribed = false): NotificationCapability => {
  if (notificationNeedsInstall()) return 'needs-install';
  if (!notificationSupported() || !status?.enabled) return 'unavailable';
  const currentPermission = permission();
  if (currentPermission === 'denied') return 'denied';
  if (currentPermission === 'default') return 'default';
  return deviceSubscribed ? 'enabled' : 'supported';
};
const readyRegistration = async () => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('The service worker is not ready.')), 5_000); });
  return Promise.race([navigator.serviceWorker.ready, timeout]).finally(() => { if (timer) clearTimeout(timer); });
};
const serializedSubscription = (subscription: PushSubscription) => {
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new Error('The browser returned an incomplete push subscription.');
  return { endpoint: json.endpoint, expirationTime: json.expirationTime ?? null, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } };
};

/** All identity-affecting notification operations share this queue. The first
 * operation starts synchronously when the queue is idle, which preserves the
 * browser's transient user activation for requestPermission(). */
function enqueueNotificationOperation<T>(expectedUserId: string | undefined, expectedGeneration: number, expectedAuthEpoch: number, operation: () => Promise<T>, force = false) {
  const run = () => {
    if (!force && (activeUserId !== expectedUserId || !isSessionGenerationCurrent(expectedGeneration) || !isAuthEpochCurrent(expectedAuthEpoch))) return Promise.resolve(undefined as T);
    return operation();
  };
  let result: Promise<T>;
  if (notificationOperationTail) result = notificationOperationTail.then(run);
  else {
    try { result = run(); } catch (error) { result = Promise.reject(error); }
  }
  const settled = result.then(() => undefined, () => undefined);
  notificationOperationTail = settled;
  void settled.finally(() => { if (notificationOperationTail === settled) notificationOperationTail = undefined; });
  return result;
}

const operationIsCurrent = (userId: string | undefined, generation: number, authEpoch: number) => activeUserId === userId && isSessionGenerationCurrent(generation) && isAuthEpochCurrent(authEpoch);
const identityFence = (sessionGeneration: number, authEpoch: number): NotificationIdentityFence => ({ sessionGeneration, authEpoch });
const hasValidIdentityFor = (marker: Awaited<ReturnType<typeof readNotificationIdentity>> | undefined, userId: string) => marker?.userId === userId && marker.revoked === false && Number.isSafeInteger(marker.revision) && marker.revision > 0;
const isNotificationAuthError = (error: unknown) => error instanceof ApiError && (error.code === 'AUTH_REQUIRED' || error.code === 'AUTH_INVALID' || error.code === 'IDENTITY_MISMATCH' || error.status === 401 || error.status === 403);
const isNotificationTransientError = (error: unknown) => {
  if (error instanceof ApiError) return error.networkFailure || error.reconnectRequired || error.status === 408 || error.status === 425 || error.status === 429 || (error.status !== undefined && error.status >= 500);
  return typeof navigator !== 'undefined' && navigator.onLine === false;
};

const queueIdentityRevocation = () => {
  const generation = captureSessionGeneration();
  const authEpoch = getAuthEpoch();
  return enqueueNotificationOperation(undefined, generation, authEpoch, () => revokeNotificationIdentity(), true);
};

// API auth invalidation is synchronous. Clear the in-memory identity before
// any old promise can resume, then put the durable revoke behind the current
// marker write in the same operation queue. An API epoch also advances for
// ordinary same-account Clerk startup/wake transitions; those transitions
// fence old writes but must not revoke a still-valid push identity.
subscribeAuthEpoch((transition: AuthEpochTransition) => {
  if (transition.reason === 'same-account' || transition.reason === 'cache-clear') return;
  activeUserId = undefined;
  identityAdmissionRequired = true;
  void queueIdentityRevocation().catch(() => undefined);
});

async function loadStatus(isCurrent: () => boolean = () => true) {
  if (notificationNeedsInstall()) { setSnapshot({ capability: 'needs-install', permission: permission() }); return undefined; }
  if (!notificationSupported()) { setSnapshot({ capability: 'unavailable', permission: 'unsupported' }); return undefined; }
  try {
    const status = await getNotificationStatus();
    if (!isCurrent()) return undefined;
    setSnapshot({ capability: capabilityFor(status), permission: permission(), status, deviceSubscribed: false });
    return status;
  } catch (error) {
    if (isCurrent()) setSnapshot({ capability: 'error', permission: permission(), error });
    return undefined;
  }
}

/** Reconcile only an already-granted browser permission; it never prompts. */
export function reconcileNotifications(userId: string) {
  if (identityAdmissionRequired && activeUserId !== userId) return Promise.resolve();
  activeUserId = userId;
  const requestedGeneration = captureSessionGeneration();
  const requestedAuthEpoch = getAuthEpoch();
  return enqueueNotificationOperation(userId, requestedGeneration, requestedAuthEpoch, async () => {
    if (notificationNeedsInstall()) { setSnapshot({ capability: 'needs-install', permission: permission() }); return; }
    if (!notificationSupported()) { setSnapshot({ capability: 'unavailable', permission: 'unsupported' }); return; }
    let hadValidIdentity = false;
    try {
      // A matching marker is already a valid local fence. Keep it in place
      // while a routine status probe is offline or transiently unavailable;
      // revoking first would turn a recoverable connectivity failure into an
      // unnecessary notification logout. A missing or different marker is
      // fail-closed before the request, as is an authentication mismatch.
      const marker = await readNotificationIdentity().catch(() => undefined);
      hadValidIdentity = hasValidIdentityFor(marker, userId);
      if (!hadValidIdentity) await revokeNotificationIdentity();

      let status: Awaited<ReturnType<typeof getNotificationStatus>>;
      try {
        status = await getNotificationStatus();
      } catch (error) {
        if (!operationIsCurrent(userId, requestedGeneration, requestedAuthEpoch)) return;
        if (!hadValidIdentity || isNotificationAuthError(error) || !isNotificationTransientError(error)) await revokeNotificationIdentity().catch(() => undefined);
        setSnapshot({ capability: 'error', permission: permission(), error });
        return;
      }
       if (!operationIsCurrent(userId, requestedGeneration, requestedAuthEpoch)) return;
      if (permission() === 'default') { await revokeNotificationIdentity().catch(() => undefined); setSnapshot({ capability: status.enabled ? 'default' : 'unavailable', permission: 'default', status }); return; }
      if (permission() === 'denied') { await revokeNotificationIdentity().catch(() => undefined); setSnapshot({ capability: status.enabled ? 'denied' : 'unavailable', permission: 'denied', status }); return; }
      const subscription = await (await readyRegistration()).pushManager.getSubscription();
       if (!operationIsCurrent(userId, requestedGeneration, requestedAuthEpoch)) return;
      if (!subscription) {
        await revokeNotificationIdentity().catch(() => undefined);
      } else {
          await setNotificationIdentity(userId, identityFence(requestedGeneration, requestedAuthEpoch));
          if (!operationIsCurrent(userId, requestedGeneration, requestedAuthEpoch)) return;
         try { await putNotificationSubscription(serializedSubscription(subscription)); }
         catch (error) {
           // Preserve an already valid local fence across a transient server
           // failure. The next foreground pass can repair the subscription;
           // auth failures and non-transient failures still revoke it.
           if (!hadValidIdentity || isNotificationAuthError(error) || !isNotificationTransientError(error)) {
             await removeNotificationSubscription(subscription.endpoint).catch(() => undefined);
             await revokeNotificationIdentity().catch(() => undefined);
           }
           throw error;
         }
          if (!operationIsCurrent(userId, requestedGeneration, requestedAuthEpoch)) return;
       }
      const refreshed = await getNotificationStatus();
       if (!operationIsCurrent(userId, requestedGeneration, requestedAuthEpoch)) return;
      setSnapshot({ capability: capabilityFor(refreshed, Boolean(subscription)), permission: permission(), status: refreshed, deviceSubscribed: Boolean(subscription) });
     } catch (error) {
        if (!operationIsCurrent(userId, requestedGeneration, requestedAuthEpoch)) return;
       if (!hadValidIdentity || isNotificationAuthError(error) || !isNotificationTransientError(error)) await revokeNotificationIdentity().catch(() => undefined);
       setSnapshot({ capability: 'error', permission: permission(), error });
     }
  });
}

/** This function is called from a button handler. Keep the permission call on
 * the synchronous gesture path; do not move it into startup reconciliation. */
export async function enableNotifications(userId?: string) {
  if (notificationNeedsInstall()) { setSnapshot({ capability: 'needs-install', permission: permission() }); return false; }
  if (!notificationSupported()) { setSnapshot({ capability: 'unavailable', permission: 'unsupported' }); return false; }
  // This lock is set before requesting permission so a second click cannot
  // start another prompt while the first one is pending. It must not be
  // implemented with the operation queue: waiting for that queue would lose
  // iOS's transient user activation before requestPermission() is called.
  if (enableInFlight) return false;
  const enrollmentUserId = userId || activeUserId;
  if (!enrollmentUserId) { setSnapshot({ capability: 'error', permission: permission(), error: new Error('An authenticated account is required to enroll notifications.') }); return false; }
  if (identityAdmissionRequired && activeUserId !== enrollmentUserId) return false;
  activeUserId = enrollmentUserId;
  const enrollmentGeneration = captureSessionGeneration();
  const enrollmentAuthEpoch = getAuthEpoch();
  if (permission() === 'denied') { setSnapshot({ capability: 'denied', permission: 'denied' }); return false; }
  enableInFlight = true;
  try {
    // This call must remain on the button handler's synchronous path. In
    // particular, do not move it into enqueueNotificationOperation(), since
    // an in-flight reconciliation would otherwise insert a promise turn first
    // and Safari would reject the request as lacking transient activation.
    let permissionRequest: Promise<NotificationPermission>;
    try { permissionRequest = Notification.requestPermission(); }
    catch (error) {
      if (operationIsCurrent(enrollmentUserId, enrollmentGeneration, enrollmentAuthEpoch)) setSnapshot({ capability: 'error', permission: permission(), error });
      return false;
    }
    let granted: NotificationPermission;
    try { granted = await permissionRequest; }
    catch (error) {
      if (operationIsCurrent(enrollmentUserId, enrollmentGeneration, enrollmentAuthEpoch)) setSnapshot({ capability: 'error', permission: permission(), error });
      return false;
    }
    if (!operationIsCurrent(enrollmentUserId, enrollmentGeneration, enrollmentAuthEpoch)) return false;
    if (granted !== 'granted') { setSnapshot({ capability: granted === 'denied' ? 'denied' : 'default', permission: granted }); return false; }
    return (await enqueueNotificationOperation(enrollmentUserId, enrollmentGeneration, enrollmentAuthEpoch, async () => {
    if (!operationIsCurrent(enrollmentUserId, enrollmentGeneration, enrollmentAuthEpoch)) return false;
    let subscription: PushSubscription | undefined;
    let serialized: ReturnType<typeof serializedSubscription> | undefined;
    let serverSetupAttempted = false;
    try {
       const status = await loadStatus(() => operationIsCurrent(enrollmentUserId, enrollmentGeneration, enrollmentAuthEpoch));
       if (!operationIsCurrent(enrollmentUserId, enrollmentGeneration, enrollmentAuthEpoch)) return false;
      if (!status?.publicKey) { setSnapshot({ capability: 'unavailable', permission: 'granted', status }); return false; }
      // Write the fence before opening/subscribing the browser credential. A
      // missing marker is unsafe in the worker, including on first enrollment.
       await setNotificationIdentity(enrollmentUserId, identityFence(enrollmentGeneration, enrollmentAuthEpoch));
       if (!operationIsCurrent(enrollmentUserId, enrollmentGeneration, enrollmentAuthEpoch)) { await revokeNotificationIdentity(); return false; }
      const registration = await readyRegistration();
       if (!operationIsCurrent(enrollmentUserId, enrollmentGeneration, enrollmentAuthEpoch)) { await revokeNotificationIdentity(); return false; }
      subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToUint8Array(status.publicKey) });
      serialized = serializedSubscription(subscription);
       if (!operationIsCurrent(enrollmentUserId, enrollmentGeneration, enrollmentAuthEpoch)) throw new Error('The authenticated account changed before notification enrollment completed.');
      serverSetupAttempted = true;
      await putNotificationSubscription(serialized);
       if (!operationIsCurrent(enrollmentUserId, enrollmentGeneration, enrollmentAuthEpoch)) throw new Error('The authenticated account changed before notification enrollment completed.');
      const next = { ...status, subscriptionCount: Math.max(1, status.subscriptionCount) };
      setSnapshot({ capability: 'enabled', permission: 'granted', status: next, deviceSubscribed: true });
      return true;
    } catch (error) {
      if (serverSetupAttempted && serialized) await removeNotificationSubscription(serialized.endpoint).catch(() => undefined);
      if (subscription) await subscription.unsubscribe().catch(() => false);
      await revokeNotificationIdentity().catch(() => undefined);
       if (operationIsCurrent(enrollmentUserId, enrollmentGeneration, enrollmentAuthEpoch)) setSnapshot({ capability: 'error', permission: 'granted', error });
       return false;
     }
    })) === true;
  } finally {
    enableInFlight = false;
  }
}

export async function disableNotifications(userId = activeUserId) {
  if (!notificationSupported()) { setSnapshot({ capability: 'unavailable', permission: 'unsupported' }); return false; }
  const targetUser = userId;
  if (!targetUser || activeUserId !== targetUser) return false;
  const disableGeneration = captureSessionGeneration();
  const disableAuthEpoch = getAuthEpoch();
  return enqueueNotificationOperation(targetUser, disableGeneration, disableAuthEpoch, async () => {
    try {
    const subscription = await (await readyRegistration()).pushManager.getSubscription();
     if (!operationIsCurrent(targetUser, disableGeneration, disableAuthEpoch)) return false;
    if (subscription) {
      // Keep the browser subscription if server revocation fails; otherwise
      // there would be no endpoint left to retry and an orphaned server
      // credential could continue receiving pushes.
      await removeNotificationSubscription(subscription.endpoint);
       if (!operationIsCurrent(targetUser, disableGeneration, disableAuthEpoch)) return false;
      await subscription.unsubscribe().catch(() => false);
    }
    const status = snapshot.status;
    await revokeNotificationIdentity();
     if (!operationIsCurrent(targetUser, disableGeneration, disableAuthEpoch)) return false;
    setSnapshot({ capability: 'supported', permission: permission(), status: { ...(status || { enabled: true, publicKey: null, subscriptionCount: 0, preferences: { moneyChanges: true, scheduledEvents: true, detailLevel: 'generic' as const } }), subscriptionCount: Math.max(0, (status?.subscriptionCount ?? 0) - (subscription ? 1 : 0)) }, deviceSubscribed: false });
    return true;
  } catch (error) {
     if (operationIsCurrent(targetUser, disableGeneration, disableAuthEpoch)) {
      await revokeNotificationIdentity().catch(() => undefined);
      setSnapshot({ capability: 'error', permission: permission(), error });
    }
    return false;
  }
  });
}

export async function saveNotificationPreferences(preferences: NotificationPreferences) {
  try {
    const next = await updateNotificationPreferences(preferences);
    setSnapshot({ ...snapshot, capability: snapshot.deviceSubscribed ? 'enabled' : 'supported', status: snapshot.status ? { ...snapshot.status, preferences: next } : undefined, error: undefined });
    return next;
  } catch (error) {
    setSnapshot({ ...snapshot, capability: 'error', error });
    throw error;
  }
}

/** Install once at app startup. Foreground reconciliation is authoritative;
 * these listeners only ever call the no-prompt reconcile path. */
export function initializeNotifications() {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;
  const reconcile = () => { if (activeUserId) void reconcileNotifications(activeUserId); };
  window.addEventListener('focus', reconcile);
  window.addEventListener('pageshow', reconcile);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reconcile(); });
  window.addEventListener('billsplit-authenticated', (event) => {
    const detail = (event as CustomEvent<{ userId?: string; authEpoch?: number }>).detail;
    const userId = detail?.userId;
    if (userId && detail?.authEpoch !== undefined && isAuthEpochCurrent(detail.authEpoch)) {
      activeUserId = userId;
      identityAdmissionRequired = false;
      void reconcileNotifications(userId);
    }
  });
  window.addEventListener('billsplit-auth-required', () => {
    activeUserId = undefined;
    identityAdmissionRequired = true;
    void queueIdentityRevocation().catch(() => undefined);
  });
  navigator.serviceWorker?.addEventListener?.('message', (event) => {
    const message = (event as MessageEvent<{ type?: string; count?: number }>).data;
    if (message?.type === 'PUSH_SUBSCRIPTION_CHANGED' && activeUserId) void reconcileNotifications(activeUserId);
     if (message?.type === 'BILLSPLIT_OUTBOX_SYNC_HINT' && activeUserId) void flushOutbox().catch(() => undefined);
    if (message?.type === 'BILLSPLIT_NOTIFICATION_RECEIVED') {
      localBadgeCount = Number.isSafeInteger(message.count) && (message.count || 0) > 0 ? Math.min(99, message.count!) : Math.min(99, localBadgeCount + 1);
      setNotificationBadge(localBadgeCount);
    }
  });
}
