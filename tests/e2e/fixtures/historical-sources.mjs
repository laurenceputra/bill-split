import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

export const historicalManifest = JSON.parse(readFileSync(new URL('./historical/manifest.json', import.meta.url), 'utf8'));

// The manifest is also the explicit path whitelist. Never resolve arbitrary
// virtual imports against the checkout or silently substitute modern modules.
export function assertHistoricalSource(snapshot, path, bytes) {
  if (!Object.hasOwn(historicalManifest, snapshot) || !Object.hasOwn(historicalManifest[snapshot].files, path)) {
    throw new Error(`Historical source is not in the provenance manifest: ${snapshot}:${path}`);
  }
  const expected = historicalManifest[snapshot].files[path];
  if (bytes.length !== expected.bytes || createHash('sha256').update(bytes).digest('hex') !== expected.sha256) {
    throw new Error(`Historical source checksum mismatch: ${snapshot}:${path}`);
  }
  return bytes.toString('utf8');
}

export async function readHistoricalSource(snapshot, path) {
  // Check membership before constructing a filesystem URL (including prototype
  // keys and traversal paths); verify raw bytes before any transpilation.
  if (!Object.hasOwn(historicalManifest, snapshot) || !Object.hasOwn(historicalManifest[snapshot].files, path)) {
    throw new Error(`Historical source is not in the provenance manifest: ${snapshot}:${path}`);
  }
  const bytes = await readFile(new URL(`./historical/${snapshot}/${path}`, import.meta.url));
  return assertHistoricalSource(snapshot, path, bytes);
}

export async function verifyHistoricalFixtures() {
  await Promise.all(Object.entries(historicalManifest).flatMap(([snapshot, { files }]) =>
    Object.keys(files).map((path) => readHistoricalSource(snapshot, path))));
}
