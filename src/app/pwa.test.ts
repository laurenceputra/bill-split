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
const icon = (name: string) => readFileSync(new URL(`../../public/icons/${name}`, import.meta.url));

describe('standalone PWA contract', () => {
  it('uses local, correctly sized artwork with separate transparent and maskable icons', () => {
    const entries = manifest.icons as Array<{ src: string; sizes: string; purpose: string }>;
    for (const [name, size, purpose] of [
      ['icon-16.png', 16, 'favicon'], ['icon-32.png', 32, 'favicon'],
      ['logo-400.png', 400, 'brand'], ['icon-192.png', 192, 'any'],
      ['icon-512.png', 512, 'any'], ['icon-maskable-192.png', 192, 'maskable'],
      ['icon-maskable-512.png', 512, 'maskable'], ['apple-touch-icon.png', 180, 'apple'],
    ] as const) {
      const png = icon(name);
      expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect(png.readUInt32BE(16)).toBe(size);
      expect(png.readUInt32BE(20)).toBe(size);
      expect(png[25]).toBe(6); // RGBA; transparent artwork is not a white tile.
      if (purpose === 'any' || purpose === 'maskable') {
        expect(entries).toContainEqual(expect.objectContaining({ src: `/icons/${name}`, sizes: `${size}x${size}`, purpose }));
      }
    }
    expect(read('../../public/icons/icon.svg')).toContain('data:image/png;base64,');
    expect(html).toContain('/icons/apple-touch-icon.png');
    expect(ui).toContain('/icons/logo-400.png');
    expect(serviceWorker).toContain('/icons/logo-400.png');
  });
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

  it('keeps Background Sync feature-detected', () => {
    expect(serviceWorker).toContain("self.addEventListener('sync'");
    expect(outbox).toContain("billsplit-expense-outbox");
  });
});
