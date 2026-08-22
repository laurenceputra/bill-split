import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const CACHE_PLACEHOLDER = '__BILLSPLIT_CACHE_VERSION__';
const ASSETS_PLACEHOLDER = '__BILLSPLIT_SHELL_ASSETS__';
const HASHED_ASSET = /^\/assets\/[a-zA-Z0-9._-]+\.(?:js|css|svg|png|webp|woff2?)$/;
const SHELL_FILES = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png'];

function extractAssets(html) {
  const assets = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/gi)].flatMap((match) => {
    try {
      const url = new URL(match[1], 'https://billsplit.invalid');
      return url.origin === 'https://billsplit.invalid' && HASHED_ASSET.test(url.pathname) ? [url.pathname] : [];
    } catch {
      return [];
    }
  });
  return [...new Set(assets)];
}

export async function finalizeServiceWorker(distDirectory = resolve('dist')) {
  const indexPath = resolve(distDirectory, 'index.html');
  const workerPath = resolve(distDirectory, 'sw.js');
  const html = await readFile(indexPath, 'utf8');
  const appAssets = extractAssets(html);
  if (!appAssets.length) throw new Error('dist/index.html does not contain a hashed app asset.');

  const shellAssets = [...SHELL_FILES, ...appAssets];
  const hash = createHash('sha256');
  for (const path of shellAssets) {
    const filePath = resolve(distDirectory, path === '/' || path === '/index.html' ? 'index.html' : `.${path}`);
    hash.update(path);
    hash.update(await readFile(filePath));
  }
  const version = `bill-split-shell-${hash.digest('hex').slice(0, 20)}`;
  const source = await readFile(workerPath, 'utf8');
  if (!source.includes(CACHE_PLACEHOLDER) || !source.includes(ASSETS_PLACEHOLDER)) {
    throw new Error('dist/sw.js is missing the service-worker finalizer placeholders.');
  }
  const generated = source
    .replaceAll(`'${CACHE_PLACEHOLDER}'`, JSON.stringify(version))
    .replaceAll(ASSETS_PLACEHOLDER, JSON.stringify(shellAssets));
  if (generated.includes(CACHE_PLACEHOLDER) || generated.includes(ASSETS_PLACEHOLDER)) {
    throw new Error('Service-worker placeholders remained after finalization.');
  }
  await writeFile(workerPath, generated);
  return { version, assets: shellAssets };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await finalizeServiceWorker();
}
