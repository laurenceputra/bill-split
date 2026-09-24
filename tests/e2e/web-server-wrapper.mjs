import path from 'node:path';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BASE_URL } from './config.mjs';
import { classifyTermination, runtimeFailure } from './startup-classification.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const marker = path.join(root, 'test-results', 'e2e-environment-failure.json');
await mkdir(path.dirname(marker), { recursive: true });
try { await unlink(marker); } catch (error) { if (error?.code !== 'ENOENT') throw error; }

const recordFailure = async (classification, detail) => {
  try { await writeFile(marker, JSON.stringify({ ...classification, recordedAt: new Date().toISOString(), detail }, null, 2)); } catch { /* Exit status remains authoritative. */ }
};

const markerExists = async () => {
  try {
    await readFile(marker, 'utf8');
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    return true;
  }
};

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

let stopping = false;
let ready = false;
let terminationMarker;
let child;
try {
  child = spawn(process.execPath, ['tests/e2e/start-server.mjs'], { cwd: root, env: { ...process.env, BILLSPLIT_E2E_WRAPPED: '1' }, stdio: 'inherit' });
} catch (error) {
  await recordFailure(runtimeFailure(), `E2E web-server wrapper could not start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const stop = (signal) => {
  if (stopping) return;
  stopping = true;
  const classification = classifyTermination({ signal, ready });
  if (classification) {
    terminationMarker = recordFailure(classification, `Playwright terminated the E2E server before ${BASE_URL} became ready`).then(() => child.kill(signal));
    return;
  }
  child.kill(signal);
};
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
child.on('error', async (error) => {
  await recordFailure(runtimeFailure(), `E2E server process failed to start: ${error.message}`);
  process.exitCode = 1;
});
child.on('exit', async (code, signal) => {
  await terminationMarker;
  if (!stopping && code !== 0 && !(await markerExists())) await recordFailure(runtimeFailure(), `E2E server process exited before Playwright could connect${code === null ? ` from ${signal || 'an unknown signal'}` : ` with status ${code}`}`);
  process.exit(stopping ? 0 : code ?? 1);
});

// Playwright owns the public readiness timeout. This probe only tells the
// wrapper whether a later SIGTERM is normal teardown or a readiness timeout.
void (async () => {
  while (!stopping && !ready) {
    try {
      await fetch(BASE_URL, { signal: AbortSignal.timeout(1_000) });
      ready = true;
      return;
    } catch {
      await sleep(100);
    }
  }
})();
