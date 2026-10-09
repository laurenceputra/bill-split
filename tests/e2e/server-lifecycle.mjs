import { closeSync, linkSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
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
  const temporary = `${marker}.${randomUUID()}.tmp`;
  let descriptor;
  let created = false;
  try {
    mkdirSync(path.dirname(marker), { recursive: true });
    descriptor = openSync(temporary, 'wx');
    created = true;
    writeFileSync(descriptor, JSON.stringify(failure, null, 2));
    closeSync(descriptor);
    descriptor = undefined;
    // Publish only complete JSON. A preserving writer must never replace a
    // marker published by another process between a check and publication.
    if (preserve) linkSync(temporary, marker);
    else renameSync(temporary, marker);
  } catch { /* Exit status remains authoritative even if diagnostics cannot be written. */ }
  finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* Best-effort diagnostic cleanup. */ }
    }
    if (created) {
      try { unlinkSync(temporary); } catch { /* Renamed already, or cleanup unavailable. */ }
    }
  }
}
