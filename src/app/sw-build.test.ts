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

const worker = `const CACHE = '__BILLSPLIT_CACHE_VERSION__';\nconst SHELL_FILES = __BILLSPLIT_SHELL_ASSETS__;`;

async function fixture(assetBody = 'app') {
  const root = await mkdtemp(resolve(tmpdir(), 'bill-split-sw-'));
  await mkdir(resolve(root, 'assets'), { recursive: true });
  await mkdir(resolve(root, 'icons'), { recursive: true });
  await writeFile(resolve(root, 'index.html'), '<div id="root"></div><script type="module" src="/assets/app-123.js"></script><link rel="stylesheet" href="/assets/app-123.css">');
  await writeFile(resolve(root, 'assets/app-123.js'), assetBody);
  await writeFile(resolve(root, 'assets/app-123.css'), 'css');
  await writeFile(resolve(root, 'manifest.webmanifest'), '{}');
  await writeFile(resolve(root, 'icons/icon.svg'), 'svg');
  await writeFile(resolve(root, 'icons/icon-192.png'), 'png');
  await writeFile(resolve(root, 'icons/icon-512.png'), 'png');
  await writeFile(resolve(root, 'sw.js'), worker);
  return root;
}

describe('production service-worker finalizer', () => {
  it('injects exact hashed assets and a content-derived version without placeholders', async () => {
    const root = await fixture();
    const result = await finalizeServiceWorker(root);
    const output = await readFile(resolve(root, 'sw.js'), 'utf8');
    expect(result.assets).toEqual(['/','/index.html','/manifest.webmanifest','/icons/icon.svg','/icons/icon-192.png','/icons/icon-512.png','/assets/app-123.js','/assets/app-123.css']);
    expect(output).toContain(result.version);
    expect(output).toContain('/assets/app-123.js');
    expect(output).not.toMatch(/__BILLSPLIT_/);
    expect(output).toMatch(/const CACHE = "bill-split-shell-[a-f0-9]{20}";/);
    expect(output).toContain('const SHELL_FILES = ["/","/index.html","/manifest.webmanifest","/icons/icon.svg","/icons/icon-192.png","/icons/icon-512.png","/assets/app-123.js","/assets/app-123.css"];');
  });

  it('changes the version when a shell asset changes', async () => {
    const first = await fixture('first');
    const second = await fixture('second');
    const firstVersion = (await finalizeServiceWorker(first)).version;
    const secondVersion = (await finalizeServiceWorker(second)).version;
    expect(firstVersion).not.toBe(secondVersion);
  });

  it('does not partially finalize a worker when a generated dependency is missing', async () => {
    const root = await fixture();
    const before = await readFile(resolve(root, 'sw.js'), 'utf8');
    await rm(resolve(root, 'assets/app-123.css'));
    await expect(finalizeServiceWorker(root)).rejects.toThrow();
    await expect(readFile(resolve(root, 'sw.js'), 'utf8')).resolves.toBe(before);
  });
});
