import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ServiceWorkerUpdateState } from './service-worker';
import { ServiceWorkerUpdate } from './ui';

const state = vi.hoisted(() => ({ phase: 'idle', updateReady: false, applying: false, blocked: false, lastSuccess: undefined, blockerReason: undefined } as { -readonly [K in keyof ServiceWorkerUpdateState]: ServiceWorkerUpdateState[K] }));
vi.mock('./service-worker', () => ({ getServiceWorkerUpdateState: () => state, subscribeServiceWorkerUpdate: () => () => undefined, checkForUpdates: vi.fn() }));

describe('App update controls', () => {
  it.each([true, false])('limits the live region to status text (settings: %s)', (settings) => {
    state.phase = 'ready'; state.updateReady = true; state.applying = false; state.blocked = false; state.lastSuccess = 1;
    const markup = renderToStaticMarkup(createElement(ServiceWorkerUpdate, { settings }));
    expect(markup.match(/role="status"/g)).toHaveLength(1);
    expect(markup).not.toContain('aria-live');
    expect(markup).toContain('<div class="update-control"><span role="status">Update ready. It will apply when all tabs are safe and idle.</span>');
    if (settings) {
      expect(markup).toMatch(/<\/span><button[^>]*>Check for updates<\/button><small>Last successful check: [^<]+<\/small><\/div>$/);
    } else {
      expect(markup).toMatch(/<\/span><\/div>$/);
    }
    state.updateReady = false; state.lastSuccess = undefined;
  });

  it.each(['initializing', 'unsupported', 'checking', 'installing', 'applying', 'offline'] as const)('disables checking during %s', (phase) => {
    state.phase = phase;
    const markup = renderToStaticMarkup(createElement(ServiceWorkerUpdate, { settings: true }));
    expect(markup).toMatch(/<button[^>]+disabled/);
    expect(markup).not.toContain('Apply when ready');
  });

  it('allows discovery while a draft blocks activation and explains the blocker', () => {
    state.phase = 'blocked'; state.blocked = true; state.blockerReason = 'Unsaved refund';
    const markup = renderToStaticMarkup(createElement(ServiceWorkerUpdate, { settings: true }));
    expect(markup).toContain('Unsaved refund');
    expect(markup).toContain('Check for updates');
    expect(markup).not.toMatch(/<button[^>]+disabled/);
    expect(markup).not.toContain('Apply when ready');
  });

  it('offers retry without an enabled force-refresh action', () => {
    state.phase = 'check-error'; state.blocked = false;
    const markup = renderToStaticMarkup(createElement(ServiceWorkerUpdate, { settings: true }));
    expect(markup).toContain('Retry update check');
    expect(markup).toContain('No successful update check yet');
  });
});
