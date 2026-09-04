import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { base64UrlToUint8Array, disableNotifications, enableNotifications, getNotificationSnapshot, initializeNotifications, isStandalonePwa, notificationNeedsInstall, reconcileNotifications, saveNotificationPreferences } from './notifications';
import { clearNotificationBadge, setNotificationBadge } from './notification-badge';
import { readNotificationIdentity, revokeNotificationIdentity, setNotificationIdentity } from './notification-identity';
import { ApiError, coordinateAuthBootstrap, getAuthEpoch, resetForClerkSessionChange } from './api';

const { getStatus, putSubscription, removeSubscription, updatePreferences } = vi.hoisted(() => ({
  getStatus: vi.fn(async () => ({ enabled: true, publicKey: 'BGsX0fLhLEJH-Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU', subscriptionCount: 0, preferences: { moneyChanges: true, scheduledEvents: true, detailLevel: 'generic' as const } })),
  putSubscription: vi.fn(async () => undefined),
  removeSubscription: vi.fn(async () => undefined),
  updatePreferences: vi.fn(async (preferences: { moneyChanges: boolean; scheduledEvents: boolean; detailLevel: 'generic' | 'detailed' }) => preferences),
}));
vi.mock('./api', async () => ({ ...(await vi.importActual<typeof import('./api')>('./api')), getNotificationStatus: getStatus, putNotificationSubscription: putSubscription, removeNotificationSubscription: removeSubscription, updateNotificationPreferences: updatePreferences }));

afterEach(() => vi.unstubAllGlobals());

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
};

let authenticatedNotificationListener: ((event: Event) => void) | undefined;

describe('notification client capability and permission gates', () => {
  it('converts URL-safe VAPID material to the exact bytes', () => {
    expect([...base64UrlToUint8Array('AAECAwQF')]).toEqual([0, 1, 2, 3, 4, 5]);
    expect(() => base64UrlToUint8Array('not base64!')).toThrow();
  });

  it('does not request permission during default-permission reconciliation', async () => {
    const requestPermission = vi.fn(async () => 'granted' as NotificationPermission);
    const NotificationMock = Object.assign(function Notification() {}, { permission: 'default' as NotificationPermission, requestPermission });
    vi.stubGlobal('Notification', NotificationMock);
    vi.stubGlobal('window', { Notification: NotificationMock, PushManager: class {}, matchMedia: () => ({ matches: false }) });
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0', maxTouchPoints: 0, serviceWorker: {} });
    await reconcileNotifications('user-1');
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('gates iOS browser tabs on standalone installation before permission', async () => {
    const requestPermission = vi.fn(async () => 'granted' as NotificationPermission);
    const NotificationMock = Object.assign(function Notification() {}, { permission: 'default' as NotificationPermission, requestPermission });
    vi.stubGlobal('Notification', NotificationMock);
    vi.stubGlobal('window', { Notification: NotificationMock, PushManager: class {}, matchMedia: () => ({ matches: false }) });
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone)', maxTouchPoints: 5, serviceWorker: {} });
    expect(isStandalonePwa()).toBe(false);
    expect(notificationNeedsInstall()).toBe(true);
    await expect(enableNotifications('user-1')).resolves.toBe(false);
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('writes a revocation marker that is independent of the private cache', async () => {
    await setNotificationIdentity('user-a');
    await revokeNotificationIdentity();
    await expect(readNotificationIdentity()).resolves.toMatchObject({ userId: null, revoked: true });
  });

  it('writes the identity marker before first browser enrollment completes', async () => {
    await new Promise<void>((resolve) => { const request = indexedDB.deleteDatabase('bill-split-notification-state'); request.onsuccess = request.onerror = request.onblocked = () => resolve(); });
    const requestPermission = vi.fn(async () => 'granted' as NotificationPermission);
    const NotificationMock = Object.assign(function Notification() {}, { permission: 'default' as NotificationPermission, requestPermission });
    const subscription = { toJSON: () => ({ endpoint: 'https://push.example.test/new', expirationTime: null, keys: { p256dh: 'client', auth: 'auth' } }), unsubscribe: vi.fn(async () => true) };
    let resolveSubscription!: (value: typeof subscription) => void;
    const subscribe = vi.fn(() => new Promise<typeof subscription>((resolve) => { resolveSubscription = resolve; }));
    const ready = Promise.resolve({ pushManager: { getSubscription: vi.fn(async () => null), subscribe } });
    vi.stubGlobal('Notification', NotificationMock);
    vi.stubGlobal('window', { Notification: NotificationMock, PushManager: class {}, matchMedia: () => ({ matches: false }) });
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0', maxTouchPoints: 0, serviceWorker: { ready } });
    getStatus.mockClear(); putSubscription.mockClear();
    const enrollment = enableNotifications('first-user');
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledOnce());
    await expect(readNotificationIdentity()).resolves.toMatchObject({ userId: 'first-user', revoked: false });
    resolveSubscription(subscription);
    await expect(enrollment).resolves.toBe(true);
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(putSubscription).toHaveBeenCalledOnce();
  });

  it('serializes reconcile and disable so disable cannot overtake an in-flight reconcile', async () => {
    const status = deferred<Awaited<ReturnType<typeof getStatus>>>();
    getStatus.mockClear();
    getStatus.mockImplementationOnce(() => status.promise);
    const getSubscription = vi.fn(async () => null);
    const NotificationMock = Object.assign(function Notification() {}, { permission: 'granted' as NotificationPermission, requestPermission: vi.fn() });
    vi.stubGlobal('Notification', NotificationMock);
    vi.stubGlobal('window', { Notification: NotificationMock, PushManager: class {}, matchMedia: () => ({ matches: false }) });
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0', maxTouchPoints: 0, serviceWorker: { ready: Promise.resolve({ pushManager: { getSubscription } }) } });
    const first = reconcileNotifications('coordinator-user');
    const second = disableNotifications('coordinator-user');
    expect(getSubscription).not.toHaveBeenCalled();
    status.resolve({ enabled: true, publicKey: 'valid', subscriptionCount: 0, preferences: { moneyChanges: true, scheduledEvents: true, detailLevel: 'generic' } });
    await first;
    await expect(second).resolves.toBe(true);
    expect(getSubscription).toHaveBeenCalledTimes(2);
  });

  it('drops a stale reconcile when the authenticated user changes before its first response', async () => {
    const firstStatus = deferred<Awaited<ReturnType<typeof getStatus>>>();
    getStatus.mockClear();
    getStatus.mockImplementationOnce(() => firstStatus.promise);
    const NotificationMock = Object.assign(function Notification() {}, { permission: 'default' as NotificationPermission, requestPermission: vi.fn() });
    vi.stubGlobal('Notification', NotificationMock);
    vi.stubGlobal('window', { Notification: NotificationMock, PushManager: class {}, matchMedia: () => ({ matches: false }) });
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0', maxTouchPoints: 0, serviceWorker: { ready: Promise.resolve({ pushManager: { getSubscription: vi.fn(async () => null) } }) } });
    const stale = reconcileNotifications('old-user');
    await vi.waitFor(() => expect(getStatus).toHaveBeenCalledOnce());
    const current = reconcileNotifications('new-user');
    firstStatus.resolve({ enabled: true, publicKey: 'valid', subscriptionCount: 0, preferences: { moneyChanges: true, scheduledEvents: true, detailLevel: 'generic' } });
    await Promise.all([stale, current]);
    expect(getStatus).toHaveBeenCalledTimes(2);
  });

  it('preserves a matching identity through an offline status failure', async () => {
    await setNotificationIdentity('offline-user');
    getStatus.mockClear();
    getStatus.mockRejectedValueOnce(new ApiError('Network connection unavailable.', { networkFailure: true, code: 'NETWORK_ERROR' }));
    const NotificationMock = Object.assign(function Notification() {}, { permission: 'granted' as NotificationPermission, requestPermission: vi.fn() });
    vi.stubGlobal('Notification', NotificationMock);
    vi.stubGlobal('window', { Notification: NotificationMock, PushManager: class {}, matchMedia: () => ({ matches: false }) });
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0', maxTouchPoints: 0, onLine: false, serviceWorker: {} });

    await reconcileNotifications('offline-user');
    await expect(readNotificationIdentity()).resolves.toMatchObject({ userId: 'offline-user', revoked: false });
    expect(getStatus).toHaveBeenCalledOnce();
  });

  it('preserves a matching identity through a transient status failure while online', async () => {
    await setNotificationIdentity('transient-user');
    getStatus.mockClear();
    getStatus.mockRejectedValueOnce(new ApiError('Request failed (503)', { status: 503, code: 'SERVER_ERROR' }));
    const NotificationMock = Object.assign(function Notification() {}, { permission: 'granted' as NotificationPermission, requestPermission: vi.fn() });
    vi.stubGlobal('Notification', NotificationMock);
    vi.stubGlobal('window', { Notification: NotificationMock, PushManager: class {}, matchMedia: () => ({ matches: false }) });
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0', maxTouchPoints: 0, onLine: true, serviceWorker: {} });

    await reconcileNotifications('transient-user');
    await expect(readNotificationIdentity()).resolves.toMatchObject({ userId: 'transient-user', revoked: false });
    expect(getStatus).toHaveBeenCalledOnce();
  });

  it('keeps the notification identity through a real same-account Clerk auth transition', async () => {
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: 'same-account-user', email: 'same@example.test', personId: 'same-person' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'X-BillSplit-User-Id': 'same-account-user', 'X-BillSplit-Clerk-User-Id': 'same-clerk-user' },
    })));

    await expect(coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'same-clerk-user', sessionId: 'same-session-a' })).resolves.toMatchObject({ status: 'authenticated' });
    await setNotificationIdentity('same-account-user');

    // This is the provider/API transition path, not a direct notification
    // state mutation. The API epoch advances for the new Clerk session, but
    // the account identity remains the same and the push marker stays valid.
    const epochBeforeTransition = getAuthEpoch();
    await expect(coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'same-clerk-user', sessionId: 'same-session-b' })).resolves.toMatchObject({ status: 'authenticated' });
    expect(getAuthEpoch()).toBeGreaterThan(epochBeforeTransition);
    await expect(readNotificationIdentity()).resolves.toMatchObject({ userId: 'same-account-user', revoked: false });
  });

  it('revokes the prior identity before reconciling a different account', async () => {
    await setNotificationIdentity('prior-user');
    getStatus.mockClear();
    getStatus.mockResolvedValue({ enabled: true, publicKey: 'valid', subscriptionCount: 0, preferences: { moneyChanges: true, scheduledEvents: true, detailLevel: 'generic' } });
    const NotificationMock = Object.assign(function Notification() {}, { permission: 'granted' as NotificationPermission, requestPermission: vi.fn() });
    vi.stubGlobal('Notification', NotificationMock);
    vi.stubGlobal('window', { Notification: NotificationMock, PushManager: class {}, matchMedia: () => ({ matches: false }) });
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0', maxTouchPoints: 0, serviceWorker: { ready: Promise.resolve({ pushManager: { getSubscription: vi.fn(async () => null) } }) } });

    await reconcileNotifications('next-user');
    await expect(readNotificationIdentity()).resolves.toMatchObject({ userId: null, revoked: true });
    expect(getStatus).toHaveBeenCalled();
  });

  it('revokes and fences an enrollment when the account changes during browser subscription', async () => {
    getStatus.mockImplementation(async () => ({ enabled: true, publicKey: 'BGsX0fLhLEJH-Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU', subscriptionCount: 0, preferences: { moneyChanges: true, scheduledEvents: true, detailLevel: 'generic' as const } }));
    const requestPermission = vi.fn(async () => 'granted' as NotificationPermission);
    const NotificationMock = Object.assign(function Notification() {}, { permission: 'granted' as NotificationPermission, requestPermission });
    const subscription = { toJSON: () => ({ endpoint: 'https://push.example.test/race', expirationTime: null, keys: { p256dh: 'client', auth: 'auth' } }), unsubscribe: vi.fn(async () => true) };
    let resolveSubscription!: (value: typeof subscription) => void;
    const subscribe = vi.fn(() => new Promise<typeof subscription>((resolve) => { resolveSubscription = resolve; }));
    vi.stubGlobal('Notification', NotificationMock);
    vi.stubGlobal('window', { Notification: NotificationMock, PushManager: class {}, matchMedia: () => ({ matches: false }) });
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0', maxTouchPoints: 0, serviceWorker: { ready: Promise.resolve({ pushManager: { getSubscription: vi.fn(async () => null), subscribe } }) } });
    putSubscription.mockClear();

    const enrollment = enableNotifications('before-switch');
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledOnce());
    resetForClerkSessionChange(false, 'after-switch');
    resolveSubscription(subscription);

    await expect(enrollment).resolves.toBe(false);
    expect(putSubscription).not.toHaveBeenCalled();
    await expect(readNotificationIdentity()).resolves.toMatchObject({ userId: null, revoked: true });
  });

  it('requests permission synchronously while reconciliation is in flight', async () => {
    const status = deferred<Awaited<ReturnType<typeof getStatus>>>();
    getStatus.mockClear();
    getStatus.mockImplementationOnce(() => status.promise);
    const requestPermission = vi.fn(async () => 'granted' as NotificationPermission);
    const NotificationMock = Object.assign(function Notification() {}, { permission: 'default' as NotificationPermission, requestPermission });
    vi.stubGlobal('Notification', NotificationMock);
    const addEventListener = vi.fn((type: string, listener: (event: Event) => void) => { if (type === 'billsplit-authenticated') authenticatedNotificationListener = listener; });
    vi.stubGlobal('window', { Notification: NotificationMock, PushManager: class {}, matchMedia: () => ({ matches: false }), addEventListener });
    vi.stubGlobal('document', { addEventListener: vi.fn() });
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0', maxTouchPoints: 0, serviceWorker: {} });

    initializeNotifications();
    authenticatedNotificationListener?.({ detail: { userId: 'activation-race-user', authEpoch: getAuthEpoch() } } as unknown as Event);
    const reconciliation = reconcileNotifications('activation-race-user');
    await vi.waitFor(() => expect(getStatus).toHaveBeenCalledOnce());
    let reconciliationSettled = false;
    void reconciliation.then(() => { reconciliationSettled = true; });
    const enablement = enableNotifications('activation-race-user');
    const duplicateEnablement = enableNotifications('activation-race-user');

    expect(reconciliationSettled).toBe(false);
    expect(requestPermission).toHaveBeenCalledOnce();
    await expect(duplicateEnablement).resolves.toBe(false);
    status.resolve({ enabled: true, publicKey: 'valid', subscriptionCount: 0, preferences: { moneyChanges: true, scheduledEvents: true, detailLevel: 'generic' } });
    await Promise.all([reconciliation, enablement]);
  });

  it('does not enroll when the account changes while permission is pending', async () => {
    const permissionResult = deferred<NotificationPermission>();
    const requestPermission = vi.fn(() => permissionResult.promise);
    const NotificationMock = Object.assign(function Notification() {}, { permission: 'default' as NotificationPermission, requestPermission });
    vi.stubGlobal('Notification', NotificationMock);
    vi.stubGlobal('window', { Notification: NotificationMock, PushManager: class {}, matchMedia: () => ({ matches: false }) });
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0', maxTouchPoints: 0, serviceWorker: {} });
    putSubscription.mockClear();
    await setNotificationIdentity('prompt-old-user');
    authenticatedNotificationListener?.({ detail: { userId: 'prompt-old-user', authEpoch: getAuthEpoch() } } as unknown as Event);

    const enrollment = enableNotifications('prompt-old-user');
    expect(requestPermission).toHaveBeenCalledOnce();
    resetForClerkSessionChange(false, 'prompt-new-clerk-user');
    permissionResult.resolve('granted');

    await expect(enrollment).resolves.toBe(false);
    expect(putSubscription).not.toHaveBeenCalled();
    await vi.waitFor(async () => expect(await readNotificationIdentity()).toMatchObject({ userId: null, revoked: true }));
  });

  it('does not commit an old account preference response into the new account snapshot', async () => {
    const preferences = { moneyChanges: true, scheduledEvents: true, detailLevel: 'generic' as const };
    const nextPreferences = { moneyChanges: false, scheduledEvents: true, detailLevel: 'detailed' as const };
    const response = deferred<typeof nextPreferences>();
    updatePreferences.mockClear();
    updatePreferences.mockImplementationOnce(() => response.promise);
    const NotificationMock = Object.assign(function Notification() {}, { permission: 'granted' as NotificationPermission, requestPermission: vi.fn() });
    vi.stubGlobal('Notification', NotificationMock);
    vi.stubGlobal('window', { Notification: NotificationMock, PushManager: class {}, matchMedia: () => ({ matches: false }) });
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0', maxTouchPoints: 0, serviceWorker: { ready: Promise.resolve({ pushManager: { getSubscription: vi.fn(async () => null) } }) } });

    authenticatedNotificationListener?.({ detail: { userId: 'preference-old-user', authEpoch: getAuthEpoch() } } as unknown as Event);
    await reconcileNotifications('preference-old-user');
    const save = saveNotificationPreferences(preferences);
    await vi.waitFor(() => expect(updatePreferences).toHaveBeenCalledOnce());
    resetForClerkSessionChange(false, 'preference-new-clerk-user');
    response.resolve(nextPreferences);

    await expect(save).resolves.toBeUndefined();
    expect(getNotificationSnapshot()).toMatchObject({ capability: 'checking', permission: 'unsupported' });
    expect(getNotificationSnapshot().status).toBeUndefined();
  });

  it('uses App Badging only when the optional APIs exist and clears through the worker', () => {
    const setAppBadge = vi.fn(async () => undefined);
    const clearAppBadge = vi.fn(async () => undefined);
    const postMessage = vi.fn();
    vi.stubGlobal('navigator', { setAppBadge, clearAppBadge, serviceWorker: { controller: { postMessage } } });
    expect(setNotificationBadge(4)).toBe(true);
    expect(clearNotificationBadge()).toBe(true);
    expect(setAppBadge).toHaveBeenCalledWith(4);
    expect(clearAppBadge).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledWith({ type: 'CLEAR_NOTIFICATION_BADGE' });
  });
});
