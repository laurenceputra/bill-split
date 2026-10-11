import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { posix } from 'node:path';
import { transform } from 'esbuild';
import { appUpdateRecoveryResponse } from '../../../src/worker/app-update-recovery.ts';
import { finalizeServiceWorker } from '../../../scripts/finalize-service-worker.mjs';
import { readHistoricalSource, verifyHistoricalFixtures } from './historical-sources.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const repository = resolve(root, '../../..');
const historicalPlugin = {
  name: 'pinned-historical-sources',
  resolveId(source, importer) {
    if (/^(historical|oldest):/.test(source)) return `\0${source}`;
    if (/^\0(historical|oldest):/.test(importer || '') && source.startsWith('.')) {
      const [prefix, file] = importer.split(':');
      const path = posix.normalize(posix.join(posix.dirname(file), source));
      return `${prefix}:${path.endsWith('.ts') ? path : `${path}.ts`}`;
    }
  },
  async load(id) {
    if (!/^\0(historical|oldest):/.test(id)) return;
    const separator = id.indexOf(':');
    return (await transform(await readHistoricalSource(id.slice(1, separator), id.slice(separator + 1)), { loader: 'ts', format: 'esm' })).code;
  },
};
export async function createUpdateServer({ historical = false, unsupported = false } = {}) {
  await verifyHistoricalFixtures();
  const temporary = await mkdtemp(resolve(tmpdir(), 'billsplit-update-'));
  const artifacts = {};
  try {
    for (const version of ['A', 'B']) {
      const directory = resolve(temporary, version);
      await build({ configFile: false, plugins: [historicalPlugin], root, publicDir: resolve(repository, 'public'), logLevel: 'error', define: { __BUILD__: JSON.stringify(version), __LEGACY__: JSON.stringify(historical && version === 'A'), __UNSUPPORTED__: JSON.stringify(unsupported && version === 'A') }, build: { outDir: directory, emptyOutDir: true, target: 'esnext' } });
      artifacts[version] = { directory, ...await finalizeServiceWorker(directory) };
    }
  } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
  let version = 'A';
  let fault;
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/api/app-update-recovery' && ['GET', 'HEAD'].includes(request.method)) {
      const recovery = appUpdateRecoveryResponse(request.method, new Headers({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' }));
      response.writeHead(recovery.status, Object.fromEntries(recovery.headers));
      response.end(await recovery.text()); return;
    }
    response.setHeader('Cache-Control', 'no-cache');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'");
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (pathname === '/__billsplit_shell__.bin') response.setHeader('Cache-Control', 'no-cache, no-transform');
    if (pathname === '/sw.js') response.setHeader('Service-Worker-Allowed', '/');
    const entry = artifacts[version].assets.find((asset) => asset.endsWith('.js'));
    if ((fault === 'worker-error' && pathname === '/sw.js') || (fault === 'missing-entry' && pathname === entry)) {
      response.writeHead(503); response.end('Controlled unavailable artifact'); return;
    }
    try {
      const file = pathname === '/' ? '/index.html' : pathname;
      if (file.includes('..')) throw new Error('Invalid path');
      // Immutable prior deployment assets remain available to old lazy imports.
      let data;
      try { data = await readFile(resolve(artifacts[version].directory, `.${file}`)); }
      catch (error) {
        if (!pathname.startsWith('/assets/') || version !== 'B') throw error;
        data = await readFile(resolve(artifacts.A.directory, `.${file}`));
      }
      if (historical && version === 'A' && pathname === '/sw.js') data = Buffer.from((await readHistoricalSource(unsupported ? 'oldest' : 'historical', 'public/sw.js')).replaceAll('__BILLSPLIT_CACHE_VERSION__', 'bill-split-shell-historical-A').replaceAll('__BILLSPLIT_SHELL_ASSETS__', JSON.stringify(artifacts.A.assets.filter((asset) => !asset.endsWith('.bin')))));
      // Model Cloudflare's ordinary HTML injection without altering the canonical asset.
      if (file.endsWith('.html')) data = Buffer.concat([data, Buffer.from('<script data-edge-injection>window.edgeInjected = true;</script>')]);
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
      const extension = file.slice(file.lastIndexOf('.'));
      response.setHeader('Content-Type', types[extension] || 'application/octet-stream');
      response.end(fault === 'mismatch-entry' && pathname === entry ? Buffer.from('/* corrupted finalized entry */') : data);
    } catch { response.writeHead(404); response.end('Not found'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    artifacts,
    publish(next, failure) { version = next; fault = failure; },
    async close() { await new Promise((resolve) => server.close(resolve)); await rm(temporary, { recursive: true, force: true }); },
  };
}
