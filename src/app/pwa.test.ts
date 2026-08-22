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
const outbox = read('./outbox.ts');

describe('standalone PWA contract', () => {
  it('keeps standalone manifest behavior and includes iOS install metadata', () => {
    expect(manifest.display).toBe('standalone');
    expect(manifest.display_override).toEqual(['standalone', 'minimal-ui']);
    expect(html).toContain('<meta name="apple-mobile-web-app-capable" content="yes" />');
    expect(html).toContain('<meta name="apple-mobile-web-app-title" content="BillSplit" />');
    expect(html).toContain('<meta name="apple-mobile-web-app-status-bar-style" content="default" />');
  });

  it('updates the shell cache and registers the worker before the load event', () => {
    expect(serviceWorker).toContain("const CACHE = '__BILLSPLIT_CACHE_VERSION__';");
    expect(serviceWorker).toContain('const SHELL_FILES = __BILLSPLIT_SHELL_ASSETS__;');
    expect(serviceWorker).toContain("requiredFetch(new Request('/', { cache: 'no-store' })");
    expect(serviceWorker).toContain('const cachedNavigation = (async () =>');
    for (const path of ["pathname === '/api'", "pathname === '/cdn-cgi'", "pathname === '/sign-in'", "pathname === '/sign-up'"]) expect(serviceWorker).toContain(path);
    expect(main).toContain("register('/sw.js', { updateViaCache: 'none' })");
    expect(main).not.toContain("addEventListener('load'");
    expect(main).toContain("typeof navigator === 'undefined'");
  });

  it('does not start authenticated work at outbox import time and gates focus flushes', () => {
    expect(outbox).not.toContain("if (typeof window !== 'undefined') {\n  void initializeOutbox();");
    expect(outbox).toContain("getAuthLifecycle().status === 'authenticated'");
    expect(outbox).toContain("window.addEventListener('focus'");
    expect(outbox).toContain("window.addEventListener('billsplit-authenticated'");
    expect(outbox).toContain('handleAuthenticatedUser(userId)');
  });
});
