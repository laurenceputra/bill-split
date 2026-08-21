import { lstat } from 'node:fs/promises';
import path from 'node:path';

const TMP_DIR = path.resolve('/tmp');
const SAFE_NAME = /^bill-split-playwright-[A-Za-z0-9._-]+$/;

export function assertSafePersistDir(value) {
  const resolved = path.resolve(value);
  const parent = path.dirname(resolved);
  const name = path.basename(resolved);
  if (parent !== TMP_DIR || !SAFE_NAME.test(name)) {
    throw new Error(`Refusing unsafe BILLSPLIT_E2E_PERSIST_DIR: ${resolved}. Use a direct /tmp/bill-split-playwright-* child.`);
  }
  return resolved;
}

export async function verifySafePersistDir(value) {
  const resolved = assertSafePersistDir(value);
  try {
    const stats = await lstat(resolved);
    if (stats.isSymbolicLink()) throw new Error(`Refusing symbolic-link BILLSPLIT_E2E_PERSIST_DIR: ${resolved}`);
    if (!stats.isDirectory()) throw new Error(`Refusing non-directory BILLSPLIT_E2E_PERSIST_DIR: ${resolved}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return resolved;
}

export function runPersistDirSelfCheck() {
  for (const value of ['/tmp/bill-split-playwright-d1', '/tmp/bill-split-playwright-check-123']) {
    assertSafePersistDir(value);
  }
  for (const value of ['/', '/tmp', '/workspace/bill-split', '/tmp/arbitrary', '/tmp/bill-split-playwright-../workspace']) {
    let rejected = false;
    try { assertSafePersistDir(value); } catch { rejected = true; }
    if (!rejected) throw new Error(`Persist-directory safety self-check accepted unsafe path: ${value}`);
  }
}

export function configuredPersistDir() {
  return assertSafePersistDir(process.env.BILLSPLIT_E2E_PERSIST_DIR || '/tmp/bill-split-playwright-d1');
}
