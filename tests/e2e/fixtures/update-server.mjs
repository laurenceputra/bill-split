import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { finalizeServiceWorker } from '../../../scripts/finalize-service-worker.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const repository = resolve(root, '../../..');
export async function createUpdateServer({ historical = false } = {}) {
  const temporary = await mkdtemp(resolve(tmpdir(), 'billsplit-update-'));
  const artifacts = {};
  try {
    for (const version of ['A', 'B']) {
      const directory = resolve(temporary, version);
      await build({ configFile: false, root, publicDir: resolve(repository, 'public'), logLevel: 'error', define: { __BUILD__: JSON.stringify(version), __LEGACY__: JSON.stringify(historical && version === 'A') }, build: { outDir: directory, emptyOutDir: true, target: 'esnext' } });
      artifacts[version] = { directory, ...await finalizeServiceWorker(directory) };
    }
  } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
  let version = 'A';
  let fault;
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
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
      let data = await readFile(resolve(artifacts[version].directory, `.${file}`));
      if (historical && version === 'A' && pathname === '/sw.js') data = await readFile(resolve(root, 'legacy-sw.js'));
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
