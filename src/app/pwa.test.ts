import { describe, expect, it } from 'vitest';
// The application tsconfig intentionally does not include Node types; this
// test runs in Vitest's Node environment and reads authored PWA files.
// @ts-expect-error Node types are not shipped to the browser build.
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const html = read('../../index.html');
const manifest = JSON.parse(read('../../public/manifest.webmanifest')) as Record<string, unknown>;
const serviceWorker = read('../../public/sw.js');
const main = read('./main.tsx');
const ui = read('./ui.tsx');
const outbox = read('./outbox.ts');

describe('standalone PWA contract', () => {
  it('keeps standalone manifest behavior and includes iOS install metadata', () => {
    expect(manifest.display).toBe('standalone');
    expect(manifest.display_override).toEqual(['standalone', 'minimal-ui']);
    expect(html).toContain('<meta name="apple-mobile-web-app-capable" content="yes" />');
    expect(html).toContain('<meta name="apple-mobile-web-app-title" content="BillSplit" />');
    expect(html).toContain('<meta name="apple-mobile-web-app-status-bar-style" content="default" />');
    expect(manifest.description).toBe('A private, simple way to split shared expenses.');
    expect(manifest.categories).toEqual(['finance', 'productivity']);
    expect(manifest.shortcuts).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Add expense', url: '/expense/new' })]));
  });

  it('updates the shell cache and registers the worker before the load event', () => {
    expect(serviceWorker).toContain("const CACHE = '__BILLSPLIT_CACHE_VERSION__';");
    expect(serviceWorker).toContain("const DEV_SHELL_FILES = ['/'");
    expect(serviceWorker).toContain("typeof __BILLSPLIT_SHELL_ASSETS__ === 'undefined'");
    expect(serviceWorker).toContain("requiredFetch(new Request('/', { cache: 'no-store' })");
    expect(serviceWorker).toContain('const cachedNavigation = (async () =>');
    for (const path of ["pathname === '/api'", "pathname === '/cdn-cgi'", "pathname === '/sign-in'", "pathname === '/sign-up'"]) expect(serviceWorker).toContain(path);
    expect(main).toContain("register('/sw.js', { updateViaCache: 'none' })");
    expect(main).not.toContain("addEventListener('load'");
    expect(main).toContain("typeof navigator === 'undefined'");
    expect(main).toContain('if (import.meta.env.DEV) return;');
    expect(main).toContain('observeServiceWorkerRegistration');
    expect(ui).toContain('A new BillSplit version is ready.');
    expect(ui).toContain('applyServiceWorkerUpdate()');
    expect(serviceWorker).toContain("event.data?.type !== 'SKIP_WAITING'");
  });

  it('does not start authenticated work at outbox import time and gates foreground recovery', () => {
    expect(outbox).not.toContain("if (typeof window !== 'undefined') {\n  void initializeOutbox();");
    expect(outbox).toContain("getAuthLifecycle().status === 'authenticated'");
    expect(outbox).toContain("window.addEventListener('billsplit-auth-resumed'");
    expect(outbox).toContain("window.addEventListener('billsplit-authenticated'");
    expect(outbox).toContain('handleAuthenticatedUser(userId)');
  });

  it('keeps push delivery and Background Sync feature-detected', () => {
    expect(serviceWorker).toContain("self.addEventListener('push'");
    expect(serviceWorker).toContain("self.addEventListener('notificationclick'");
    expect(serviceWorker).toContain("self.addEventListener('pushsubscriptionchange'");
    expect(serviceWorker).toContain("self.addEventListener('sync'");
    expect(serviceWorker).toContain('CLEAR_NOTIFICATION_BADGE');
    expect(outbox).toContain("billsplit-expense-outbox");
  });
});
