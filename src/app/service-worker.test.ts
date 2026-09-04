import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyServiceWorkerUpdate, canApplyServiceWorkerUpdate, getServiceWorkerUpdateState, observeServiceWorkerRegistration } from './service-worker';

afterEach(() => vi.unstubAllGlobals());

describe('service-worker update lifecycle', () => {
  it('signals a waiting worker but does not apply it while a form is focused', () => {
    const waiting = { postMessage: vi.fn() };
    const registration = Object.assign(new EventTarget(), { waiting, installing: null }) as unknown as ServiceWorkerRegistration;
    const serviceWorker = Object.assign(new EventTarget(), { controller: {} });
    vi.stubGlobal('navigator', { serviceWorker });
    vi.stubGlobal('document', { activeElement: { closest: () => ({}) } });

    observeServiceWorkerRegistration(registration);
    expect(getServiceWorkerUpdateState().updateReady).toBe(true);
    expect(canApplyServiceWorkerUpdate()).toBe(false);
    expect(applyServiceWorkerUpdate()).toBe(false);
    expect(waiting.postMessage).not.toHaveBeenCalled();
  });

  it('posts the explicit apply message once the page is quiescent', () => {
    const waiting = { postMessage: vi.fn() };
    const registration = Object.assign(new EventTarget(), { waiting, installing: null }) as unknown as ServiceWorkerRegistration;
    const serviceWorker = Object.assign(new EventTarget(), { controller: {} });
    vi.stubGlobal('navigator', { serviceWorker });
    vi.stubGlobal('document', { activeElement: null });

    observeServiceWorkerRegistration(registration);
    expect(applyServiceWorkerUpdate()).toBe(true);
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    expect(getServiceWorkerUpdateState().applying).toBe(true);
  });
});
