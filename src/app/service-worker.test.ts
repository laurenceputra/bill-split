import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyServiceWorkerUpdate, cancelServiceWorkerUpdate, checkForUpdates, configureServiceWorkerUpdates, disposeServiceWorkerUpdates, getServiceWorkerUpdateState, observeServiceWorkerRegistration } from './service-worker';
import { createReloadBlocker, getReloadSafetyState, recordReloadInteraction } from './reload-safety';

const protocol = 'BILLSPLIT_UPDATE_V1';
const target = 'bill-split-shell-next';
function fixture(hasController = true, hasWaiting = false, autoApply = false) {
  const worker = Object.assign(new EventTarget(), { postMessage: vi.fn(), state: 'installed' });
  const controller = Object.assign(new EventTarget(), { postMessage: vi.fn() });
  const serviceWorker = Object.assign(new EventTarget(), { controller: hasController ? controller : null });
  const registration = Object.assign(new EventTarget(), { waiting: hasWaiting ? worker : null, installing: null as unknown, update: vi.fn(async (): Promise<void> => undefined) });
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible', activeElement: null });
  const window = Object.assign(new EventTarget(), { location: { reload: vi.fn() } });
  vi.stubGlobal('navigator', { serviceWorker, onLine: true });
  vi.stubGlobal('document', document);
  vi.stubGlobal('window', window);
  vi.stubGlobal('crypto', { randomUUID: () => 'test-attempt-123' });
  const message = (data: Record<string, unknown>, source: EventTarget = worker) => {
    const event = new Event('message');
    Object.assign(event, { data: { protocol, target, ...data }, source });
    serviceWorker.dispatchEvent(event);
  };
  observeServiceWorkerRegistration(registration as unknown as ServiceWorkerRegistration, { autoApply, safetyIntegrated: true });
  return { worker, controller, serviceWorker, registration, document, window, message };
}
beforeEach(() => { vi.useFakeTimers(); recordReloadInteraction(); });
afterEach(() => { disposeServiceWorkerUpdates(); configureServiceWorkerUpdates({ safetyIntegrated: false, autoApply: false }); vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('service-worker discovery', () => {
  it('checks startup once, coalesces resume clusters, and allows manual bypass', async () => {
    const f = fixture();
    await checkForUpdates();
    expect(f.registration.update).toHaveBeenCalledTimes(1);
    expect(getServiceWorkerUpdateState().phase).toBe('no-update');
    expect(getServiceWorkerUpdateState().lastSuccess).toBeDefined();
    observeServiceWorkerRegistration(f.registration as unknown as ServiceWorkerRegistration);
    f.window.dispatchEvent(new Event('focus'));
    f.window.dispatchEvent(new Event('pageshow'));
    f.document.dispatchEvent(new Event('visibilitychange'));
    expect(f.registration.update).toHaveBeenCalledTimes(1);
    await checkForUpdates(true);
    expect(f.registration.update).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(f.registration.update).toHaveBeenCalledTimes(3);
  });

  it('reconnect checks without authenticated API state and backs off failures', async () => {
    const f = fixture(); await checkForUpdates();
    f.registration.update.mockRejectedValue(new Error('network error'));
    await checkForUpdates(true);
    expect(getServiceWorkerUpdateState().phase).toBe('check-error');
    const lastSuccess = getServiceWorkerUpdateState().lastSuccess;
    f.window.dispatchEvent(new Event('online'));
    expect(f.registration.update).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    f.window.dispatchEvent(new Event('online'));
    await checkForUpdates(false);
    expect(f.registration.update).toHaveBeenCalledTimes(3);
    expect(getServiceWorkerUpdateState().lastSuccess).toBe(lastSuccess);
    Object.assign(navigator, { onLine: false });
    await checkForUpdates(true);
    expect(getServiceWorkerUpdateState().phase).toBe('offline');
    expect(f.registration.update).toHaveBeenCalledTimes(3);
  });

  it('does not equate update() resolution with successful installation', async () => {
    const f = fixture(); await checkForUpdates();
    const installing = Object.assign(new EventTarget(), { state: 'installing' });
    f.registration.installing = installing;
    const check = checkForUpdates();
    await Promise.resolve(); await Promise.resolve();
    expect(getServiceWorkerUpdateState().phase).toBe('installing');
    installing.state = 'redundant'; installing.dispatchEvent(new Event('statechange'));
    await check;
    expect(getServiceWorkerUpdateState().phase).toBe('install-error');
  });

  it('bounds checks and ignores late completion after disposal', async () => {
    const f = fixture(); await checkForUpdates();
    let resolve!: () => void;
    f.registration.update.mockImplementation(() => new Promise<void>((done) => { resolve = done; }));
    const check = checkForUpdates();
    await vi.advanceTimersByTimeAsync(15_000); await check;
    expect(getServiceWorkerUpdateState().phase).toBe('check-error');
    disposeServiceWorkerUpdates();
    resolve(); await Promise.resolve(); await Promise.resolve();
    expect(getServiceWorkerUpdateState().phase).toBe('initializing');
  });
});
describe('page-side update preparation', () => {
  it('never reloads activation intent before controller verification, including a failed skipWaiting release', async () => {
    const f = fixture(true, true); await checkForUpdates();
    f.message({ type: 'IDENTITY' }); await vi.advanceTimersByTimeAsync(5_000);
    f.message({ type: 'PREPARE', attempt: 'failed-activation', leaseMs: 10_000 });
    f.message({ type: 'ACTIVATING', attempt: 'failed-activation' });
    expect(applyServiceWorkerUpdate()).toBe(false);
    f.message({ type: 'RELEASE', attempt: 'failed-activation', reason: 'skipWaiting failed' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.window.location.reload).not.toHaveBeenCalled();
    expect(getServiceWorkerUpdateState().phase).not.toBe('deferred');
    expect(getReloadSafetyState().gated).toBe(false);
  });

  it('a losing simultaneous request release cannot cancel the winning passive preparation', async () => {
    const f = fixture(true, true); await checkForUpdates();
    vi.stubGlobal('crypto', { randomUUID: () => 'losing-request-B' });
    f.message({ type: 'IDENTITY' }); await vi.advanceTimersByTimeAsync(5_000);
    expect(applyServiceWorkerUpdate()).toBe(true);
    f.message({ type: 'PREPARE', attempt: 'winning-attempt-A', leaseMs: 10_000 });
    f.message({ type: 'RELEASE', attempt: 'losing-request-B', target: 'bill-split-shell-wrong' });
    expect(getReloadSafetyState().gated).toBe(true);
    f.message({ type: 'RELEASE', attempt: 'losing-request-B' });
    expect(getReloadSafetyState().gated).toBe(true);
    expect(getServiceWorkerUpdateState().phase).toBe('applying');
    expect(applyServiceWorkerUpdate()).toBe(false);
    f.message({ type: 'VALIDATE', attempt: 'winning-attempt-A' });
    expect(f.worker.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'ACK', round: 'final', ready: true }));
    f.message({ type: 'RELEASE', attempt: 'winning-attempt-A' });
    expect(getReloadSafetyState().gated).toBe(false);
  });

  it('passive hide cancellation leaves a truthful non-applying state even when RELEASE arrives late', async () => {
    const f = fixture(true, true); await checkForUpdates();
    f.message({ type: 'IDENTITY' }); await vi.advanceTimersByTimeAsync(5_000);
    f.message({ type: 'PREPARE', attempt: 'hidden-passive', leaseMs: 10_000 });
    f.document.visibilityState = 'hidden'; f.document.dispatchEvent(new Event('visibilitychange'));
    expect(getServiceWorkerUpdateState().phase).toBe('blocked');
    f.message({ type: 'RELEASE', attempt: 'hidden-passive' });
    expect(getServiceWorkerUpdateState().applying).toBe(false);
    f.document.visibilityState = 'visible'; f.document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(20_000);
    f.message({ type: 'PREPARE', attempt: 'resumed-passive', leaseMs: 10_000 });
    expect(getReloadSafetyState().gated).toBe(true);
    cancelServiceWorkerUpdate();
    expect(getServiceWorkerUpdateState().applying).toBe(false);
  });

  it('retries lost waiting/controller identities with backoff and manual recovery', async () => {
    const f = fixture(true, true); await checkForUpdates();
    expect(getServiceWorkerUpdateState().phase).toBe('blocked');
    expect(getServiceWorkerUpdateState().blockerReason).toContain('Verifying');
    const count = () => f.worker.postMessage.mock.calls.filter(([data]) => data.type === 'IDENTIFY').length;
    const before = count();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(count()).toBeGreaterThan(before);
    const retried = count(); await checkForUpdates(true);
    expect(count()).toBeGreaterThan(retried);
    f.message({ type: 'IDENTITY' }); await vi.advanceTimersByTimeAsync(5_000);
    f.message({ type: 'PREPARE', attempt: 'identity-recovery', leaseMs: 10_000 });
    f.message({ type: 'ACTIVATING', attempt: 'identity-recovery' });
    f.serviceWorker.controller = f.worker;
    f.serviceWorker.dispatchEvent(new Event('controllerchange'));
    const controllerBefore = count();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(count()).toBeGreaterThan(controllerBefore);
    expect(f.window.location.reload).not.toHaveBeenCalled();
    f.message({ type: 'IDENTITY' });
    expect(f.window.location.reload).toHaveBeenCalledTimes(1);
  });

  it('clears obsolete waiting workers after removal, redundancy, checks, and before apply', async () => {
    const f = fixture(true, true, true); await checkForUpdates();
    f.message({ type: 'IDENTITY' });
    f.worker.state = 'redundant';
    expect(applyServiceWorkerUpdate()).toBe(false);
    expect(getServiceWorkerUpdateState().updateReady).toBe(false);
    f.registration.waiting = null;
    await checkForUpdates(true); await vi.advanceTimersByTimeAsync(30_000);
    expect(getServiceWorkerUpdateState().phase).toBe('no-update');
    expect(f.worker.postMessage.mock.calls.some(([data]) => data.type === 'REQUEST')).toBe(false);
  });

  it('reports the loaded HTML build, never the newer controller generation', async () => {
    const f = fixture(true, true); disposeServiceWorkerUpdates();
    Object.assign(f.document, { querySelector: () => ({ getAttribute: () => 'bill-split-shell-loaded-old' }) });
    observeServiceWorkerRegistration(f.registration as unknown as ServiceWorkerRegistration, { safetyIntegrated: true });
    f.message({ type: 'PROBE_BUILD', scan: 'scan-123' }, f.controller);
    expect(f.controller.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'BUILD_REPORT', scan: 'scan-123', build: 'bill-split-shell-loaded-old' }));
  });

  it('accepts integration configuration before registration and cancels when the owner disables it', async () => {
    const f = fixture(true, true); disposeServiceWorkerUpdates();
    vi.stubGlobal('crypto', { randomUUID: () => 'configured-attempt' });
    configureServiceWorkerUpdates({ safetyIntegrated: true, autoApply: true });
    observeServiceWorkerRegistration(f.registration as unknown as ServiceWorkerRegistration);
    await checkForUpdates(); f.message({ type: 'IDENTITY' });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'REQUEST', attempt: 'configured-attempt' }));
    f.message({ type: 'PREPARE', attempt: 'configured-attempt', leaseMs: 10_000 });
    expect(getReloadSafetyState().gated).toBe(true);
    configureServiceWorkerUpdates({ safetyIntegrated: false });
    expect(getReloadSafetyState().gated).toBe(false);
    expect(f.worker.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'CANCEL', attempt: 'configured-attempt' }));
  });

  it('fails closed until all application safety integrations explicitly enable preparation', async () => {
    const f = fixture(true, true, true); await checkForUpdates();
    observeServiceWorkerRegistration(f.registration as unknown as ServiceWorkerRegistration, { safetyIntegrated: false });
    f.message({ type: 'IDENTITY' }); await vi.advanceTimersByTimeAsync(5_000);
    expect(applyServiceWorkerUpdate()).toBe(false);
    f.message({ type: 'PREPARE', attempt: 'unintegrated-attempt', leaseMs: 10_000 });
    expect(f.worker.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'ACK', ready: false }));
    expect(getReloadSafetyState().gated).toBe(false);
  });

  it('manual check is allowed while dirty but neither manual nor automatic apply forces reload', async () => {
    const release = createReloadBlocker('Unsaved expense');
    const f = fixture(true, true, true); await checkForUpdates();
    f.message({ type: 'IDENTITY' });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(applyServiceWorkerUpdate()).toBe(false);
    expect(f.worker.postMessage.mock.calls.some(([data]) => data.type === 'REQUEST')).toBe(false);
    expect(f.window.location.reload).not.toHaveBeenCalled();
    release();
  });

  it('all prepare requests require local five-second inactivity, including passive tabs', async () => {
    const f = fixture(true, true); await checkForUpdates();
    f.message({ type: 'IDENTITY' });
    f.message({ type: 'PREPARE', attempt: 'remote-attempt', leaseMs: 10_000 });
    expect(f.worker.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'ACK', ready: false }));
    await vi.advanceTimersByTimeAsync(5_000);
    f.message({ type: 'PREPARE', attempt: 'remote-attempt', leaseMs: 10_000 });
    expect(f.worker.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'ACK', ready: true }));
    expect(getReloadSafetyState().gated).toBe(true);
    f.document.dispatchEvent(new Event('input'));
    expect(getReloadSafetyState().gated).toBe(false);
    expect(f.worker.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'CANCEL', attempt: 'remote-attempt' }));
    f.message({ type: 'VALIDATE', attempt: 'remote-attempt' });
    expect(f.worker.postMessage).not.toHaveBeenLastCalledWith(expect.objectContaining({ type: 'ACK', ready: true, round: 'final' }));
  });

  it('cancellation cannot later acquire a gate and stale messages cannot release a newer gate', async () => {
    const f = fixture(true, true); await checkForUpdates();
    f.message({ type: 'IDENTITY' }); await vi.advanceTimersByTimeAsync(5_000);
    expect(applyServiceWorkerUpdate()).toBe(true);
    f.message({ type: 'PREPARE', attempt: 'test-attempt-123', leaseMs: 10_000 });
    cancelServiceWorkerUpdate();
    expect(getReloadSafetyState().gated).toBe(false);
    f.message({ type: 'PREPARE', attempt: 'test-attempt-123', leaseMs: 10_000 });
    expect(getReloadSafetyState().gated).toBe(false);
    f.message({ type: 'VALIDATE', attempt: 'test-attempt-123' });
    f.message({ type: 'PREPARE', attempt: 'newer-attempt', leaseMs: 10_000 });
    f.message({ type: 'RELEASE', attempt: 'test-attempt-123' });
    expect(getReloadSafetyState().gated).toBe(true);
    f.message({ type: 'RELEASE', attempt: 'newer-attempt' });
    expect(getReloadSafetyState().gated).toBe(false);
  });

  it('ignores unrelated worker messages and releases a passive gate when its lease expires', async () => {
    const f = fixture(true, true); await checkForUpdates();
    f.message({ type: 'IDENTITY' }); await vi.advanceTimersByTimeAsync(5_000);
    f.message({ type: 'PREPARE', attempt: 'lease-attempt', leaseMs: 10_000 }, f.controller);
    expect(getReloadSafetyState().gated).toBe(false);
    f.message({ type: 'PREPARE', attempt: 'lease-attempt', leaseMs: 10_000 });
    expect(getReloadSafetyState().gated).toBe(true);
    f.message({ type: 'VALIDATE', attempt: 'lease-attempt', target: 'bill-split-shell-wrong' });
    expect(f.worker.postMessage).not.toHaveBeenLastCalledWith(expect.objectContaining({ type: 'ACK', round: 'final' }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(getReloadSafetyState().gated).toBe(false);
    expect(f.worker.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'CANCEL', attempt: 'lease-attempt' }));
  });

  it('reloads an actual activated target once and defers if a draft appears', async () => {
    const f = fixture(true, true); await checkForUpdates();
    f.message({ type: 'IDENTITY' }); await vi.advanceTimersByTimeAsync(5_000);
    f.message({ type: 'PREPARE', attempt: 'remote-attempt', leaseMs: 10_000 });
    f.message({ type: 'ACTIVATING', attempt: 'remote-attempt' });
    const release = createReloadBlocker('Unsaved refund');
    f.serviceWorker.controller = f.worker;
    f.serviceWorker.dispatchEvent(new Event('controllerchange'));
    f.message({ type: 'IDENTITY' });
    expect(getServiceWorkerUpdateState().phase).toBe('deferred');
    expect(f.window.location.reload).not.toHaveBeenCalled();
    release(); await vi.advanceTimersByTimeAsync(20_000);
    expect(f.window.location.reload).toHaveBeenCalledTimes(1);
    f.serviceWorker.dispatchEvent(new Event('controllerchange')); f.message({ type: 'IDENTITY' });
    expect(f.window.location.reload).toHaveBeenCalledTimes(1);
  });

  it('never reloads on first install or an unverified controller', async () => {
    const f = fixture(false); await checkForUpdates(); await vi.advanceTimersByTimeAsync(5_000);
    f.serviceWorker.controller = f.controller;
    f.serviceWorker.dispatchEvent(new Event('controllerchange'));
    f.message({ type: 'IDENTITY' }, f.controller);
    expect(f.window.location.reload).not.toHaveBeenCalled();
    f.serviceWorker.dispatchEvent(new Event('controllerchange'));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.window.location.reload).not.toHaveBeenCalled();
  });
});
