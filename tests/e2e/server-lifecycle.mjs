import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function exitStatus({ stopping, code }) {
  return stopping ? 0 : code || 1;
}

export function exitDetail(name, { code, signal, ready }) {
  return `${name} exited unexpectedly: code=${code ?? 'null'}, signal=${signal ?? 'none'}, ready=${ready}`;
}

export function recordServerFailure(marker, classification, detail, { preserve = false } = {}) {
  const failure = { ...classification, recordedAt: new Date().toISOString(), detail };
  console.error(`[E2E environment failure] ${JSON.stringify(failure)}`);
  try {
    if (preserve && existsSync(marker)) return;
    mkdirSync(path.dirname(marker), { recursive: true });
    writeFileSync(marker, JSON.stringify(failure, null, 2));
  } catch { /* Exit status remains authoritative even if diagnostics cannot be written. */ }
}
