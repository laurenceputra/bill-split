import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const CACHE_PLACEHOLDER = '__BILLSPLIT_CACHE_VERSION__';
const ASSETS_PLACEHOLDER = '__BILLSPLIT_SHELL_ASSETS__';
const ENTRY_ASSETS_PLACEHOLDER = '__BILLSPLIT_ENTRY_ASSETS__';
const INTEGRITY_PLACEHOLDER = '__BILLSPLIT_SHELL_INTEGRITY__';
const HASHED_ASSET = /^\/assets\/[a-zA-Z0-9._-]+\.(?:js|css|svg|png|webp|woff2?)$/;
const SHELL_FILES = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-16.png', '/icons/icon-32.png', '/icons/logo-400.png', '/icons/apple-touch-icon.png', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-192.png', '/icons/icon-maskable-512.png'];

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

  // Include lazy chunks and their styles/fonts, not just index.html's imports.
  const generatedAssets = (await readdir(resolve(distDirectory, 'assets')))
    .map((name) => `/assets/${name}`).filter((path) => HASHED_ASSET.test(path)).sort();
  const shellAssets = [...new Set([...SHELL_FILES, ...appAssets, ...generatedAssets])];
  const source = await readFile(workerPath, 'utf8');
  const placeholders = [CACHE_PLACEHOLDER, ASSETS_PLACEHOLDER, ENTRY_ASSETS_PLACEHOLDER, INTEGRITY_PLACEHOLDER];
  if (placeholders.some((placeholder) => !source.includes(placeholder))) throw new Error('dist/sw.js is missing the service-worker finalizer placeholders.');
  const hash = createHash('sha256');
  // Policy changes need a fresh cache even when the application is unchanged.
  hash.update(source);
  const contents = new Map();
  for (const path of shellAssets) {
    const filePath = resolve(distDirectory, path === '/' || path === '/index.html' ? 'index.html' : `.${path}`);
    hash.update(path);
    const bytes = await readFile(filePath);
    contents.set(path, bytes);
    hash.update(bytes);
  }
  const version = `bill-split-shell-${hash.digest('hex').slice(0, 20)}`;
  // The immutable page identity describes its loaded HTML, not a later controller.
  const meta = `<meta name="billsplit-build" content="${version}">`;
  const identifiedHtml = /<head(?:\s[^>]*)?>/i.test(html) ? html.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${meta}`) : `${meta}${html}`;
  const identifiedBytes = Buffer.from(identifiedHtml);
  contents.set('/', identifiedBytes);
  contents.set('/index.html', identifiedBytes);
  const integrity = Object.fromEntries([...contents].map(([path, bytes]) => [path, { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }]));
  const generated = source
    .replaceAll(`'${CACHE_PLACEHOLDER}'`, JSON.stringify(version))
    .replaceAll(ASSETS_PLACEHOLDER, JSON.stringify(shellAssets))
    .replaceAll(ENTRY_ASSETS_PLACEHOLDER, JSON.stringify(appAssets))
    .replaceAll(INTEGRITY_PLACEHOLDER, JSON.stringify(integrity));
  if (placeholders.some((placeholder) => generated.includes(placeholder))) {
    throw new Error('Service-worker placeholders remained after finalization.');
  }
  await writeFile(workerPath, generated);
  await writeFile(indexPath, identifiedHtml);
  return { version, assets: shellAssets, integrity };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await finalizeServiceWorker();
}
