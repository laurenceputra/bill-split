import { describe, expect, it } from 'vitest';
// The application tsconfig intentionally does not include Node types; this
// test runs in Vitest's Node environment and exercises the production step.
// @ts-expect-error Node types are not shipped to the browser build.
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
// @ts-expect-error Node types are not shipped to the browser build.
import { tmpdir } from 'node:os';
// @ts-expect-error Node types are not shipped to the browser build.
import { resolve } from 'node:path';
// @ts-expect-error The Node build script has no browser declaration.
import { finalizeServiceWorker } from '../../scripts/finalize-service-worker.mjs';

const worker = `const CACHE = '__BILLSPLIT_CACHE_VERSION__';\nconst SHELL_FILES = __BILLSPLIT_SHELL_ASSETS__;\nconst ENTRY_ASSETS = __BILLSPLIT_ENTRY_ASSETS__;\nconst SHELL_INTEGRITY = __BILLSPLIT_SHELL_INTEGRITY__;`;
const icons = ['icon.svg', 'icon-16.png', 'icon-32.png', 'logo-400.png', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-192.png', 'icon-maskable-512.png'];

async function fixture(assetBody = 'app') {
  const root = await mkdtemp(resolve(tmpdir(), 'bill-split-sw-'));
  await mkdir(resolve(root, 'assets'), { recursive: true });
  await mkdir(resolve(root, 'icons'), { recursive: true });
  await writeFile(resolve(root, 'index.html'), '<div id="root"></div><script type="module" src="/assets/app-123.js"></script><link rel="stylesheet" href="/assets/app-123.css">');
  await writeFile(resolve(root, 'assets/app-123.js'), assetBody);
  await writeFile(resolve(root, 'assets/app-123.css'), 'css');
  await writeFile(resolve(root, 'manifest.webmanifest'), '{}');
  for (const icon of icons) await writeFile(resolve(root, 'icons', icon), icon);
  await writeFile(resolve(root, 'sw.js'), worker);
  return root;
}

describe('production service-worker finalizer', () => {
  it('injects exact hashed assets and a content-derived version without placeholders', async () => {
    const root = await fixture();
    const result = await finalizeServiceWorker(root);
    const output = await readFile(resolve(root, 'sw.js'), 'utf8');
    expect(result.assets).toEqual(['/', '/index.html', '/manifest.webmanifest', ...icons.map(icon => `/icons/${icon}`), '/assets/app-123.js', '/assets/app-123.css']);
    expect(output).toContain(result.version);
    expect(output).toContain('/assets/app-123.js');
    expect(output).not.toMatch(/__BILLSPLIT_/);
    expect(output).toMatch(/const CACHE = "bill-split-shell-[a-f0-9]{20}";/);
    expect(output).toContain(`const SHELL_FILES = ${JSON.stringify(result.assets)};`);
    expect(output).toContain(`const SHELL_INTEGRITY = ${JSON.stringify(result.integrity)};`);
    expect(await readFile(resolve(root, 'index.html'), 'utf8')).toContain(`<meta name="billsplit-build" content="${result.version}">`);
    expect(result.integrity['/']).toEqual(result.integrity['/index.html']);
  });

  it('changes the version when a shell asset changes', async () => {
    const first = await fixture('first');
    const second = await fixture('second');
    const firstVersion = (await finalizeServiceWorker(first)).version;
    const secondVersion = (await finalizeServiceWorker(second)).version;
    expect(firstVersion).not.toBe(secondVersion);
  });

  it('changes the version when only worker policy changes', async () => {
    const first = await fixture();
    const second = await fixture();
    await writeFile(resolve(second, 'sw.js'), `${worker}\n// new worker policy`);
    expect((await finalizeServiceWorker(first)).version).not.toBe((await finalizeServiceWorker(second)).version);
  });

  it.each(['index.html', 'manifest.webmanifest', 'icons/icon.svg'])('fingerprints %s bytes even when entry filenames do not change', async (path) => {
    const first = await fixture(); const second = await fixture();
    const original = await readFile(resolve(second, path), 'utf8');
    await writeFile(resolve(second, path), `${original}\nchanged bytes`);
    const a = await finalizeServiceWorker(first); const b = await finalizeServiceWorker(second);
    expect(a.version).not.toBe(b.version);
    expect(a.assets).toEqual(b.assets);
    const manifestPath = path === 'index.html' ? '/' : `/${path}`;
    expect(a.integrity[manifestPath].sha256).not.toBe(b.integrity[manifestPath].sha256);
  });

  it('includes lazy chunks and changes the version when they change', async () => {
    const first = await fixture();
    const second = await fixture();
    await writeFile(resolve(first, 'assets/lazy-456.js'), 'first lazy chunk');
    await writeFile(resolve(second, 'assets/lazy-456.js'), 'second lazy chunk');
    const result = await finalizeServiceWorker(first);
    expect(result.assets).toContain('/assets/lazy-456.js');
    expect(result.version).not.toBe((await finalizeServiceWorker(second)).version);
    const output = await readFile(resolve(first, 'sw.js'), 'utf8');
    expect(output).toContain('const ENTRY_ASSETS = ["/assets/app-123.js","/assets/app-123.css"];');
  });

  it('does not partially finalize a worker when a generated dependency is missing', async () => {
    const root = await fixture();
    const before = await readFile(resolve(root, 'sw.js'), 'utf8');
    await rm(resolve(root, 'assets/app-123.css'));
    await expect(finalizeServiceWorker(root)).rejects.toThrow();
    await expect(readFile(resolve(root, 'sw.js'), 'utf8')).resolves.toBe(before);
  });
});
