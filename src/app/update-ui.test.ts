import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ServiceWorkerUpdateState } from './service-worker';
import { ServiceWorkerUpdate } from './ui';
import { UpdateStatus } from './update-status';

const state = vi.hoisted(() => ({ phase: 'idle', updateReady: false, applying: false, blocked: false, lastSuccess: undefined, blockerReason: undefined } as { -readonly [K in keyof ServiceWorkerUpdateState]: ServiceWorkerUpdateState[K] }));
vi.mock('./service-worker', () => ({ getServiceWorkerUpdateState: () => state, subscribeServiceWorkerUpdate: () => () => undefined, checkForUpdates: vi.fn() }));

describe('App update controls', () => {
  it.each(['ready', 'blocked'] as const)('disables offline discovery independently of %s installed application', (phase) => {
    const update: ServiceWorkerUpdateState = { phase, updateReady: true, applying: false, blocked: phase === 'blocked', offline: true };
    const markup = renderToStaticMarkup(createElement(UpdateStatus, { update, settings: true, onCheck: () => undefined, onApply: () => undefined }));
    expect(markup.match(/class="button button--secondary update-action"/g)).toHaveLength(2);
    expect(markup).toMatch(/<button[^>]*>Update now<\/button>/);
    expect(markup).toMatch(/<button[^>]*disabled[^>]*>Check for updates<\/button>/);
    expect(markup).toContain('The installed update can still use Update now.');
  });
  it('shows verification help without unrelated discard advice', () => {
    const update: ServiceWorkerUpdateState = { phase: 'deferred', updateReady: false, applying: false, blocked: true, manualError: 'Verifying the activated update. Verification will retry automatically.' };
    const markup = renderToStaticMarkup(createElement(UpdateStatus, { update, onCheck: () => undefined }));
    expect(markup).toContain('Verification will retry automatically.');
    expect(markup).not.toContain('discard');
  });
  it.each([true, false])('limits the live region to status text (settings: %s)', (settings) => {
    state.phase = 'ready'; state.updateReady = true; state.applying = false; state.blocked = false; state.lastSuccess = 1;
    const markup = renderToStaticMarkup(createElement(ServiceWorkerUpdate, { settings }));
    expect(markup.match(/role="status"/g) ?? []).toHaveLength(settings ? 1 : 0);
    expect(markup).not.toContain('aria-live');
    expect(markup).toContain('Update now');
    if (settings) {
      expect(markup).toContain('An app update is available.');
    } else {
      expect(markup).not.toContain('available');
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
    expect(markup).not.toContain('Unsaved refund');
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
