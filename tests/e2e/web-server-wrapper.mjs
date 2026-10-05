import path from 'node:path';
import { mkdir, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BASE_URL } from './config.mjs';
import { classifyTermination, runtimeFailure } from './startup-classification.mjs';
import { exitDetail, exitStatus, recordServerFailure } from './server-lifecycle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export async function runWebServer({ cwd = root, command = process.execPath, args = ['tests/e2e/start-server.mjs'], url = BASE_URL, marker = path.join(cwd, 'test-results', 'e2e-environment-failure.json') } = {}) {
  await mkdir(path.dirname(marker), { recursive: true });
  try { await unlink(marker); } catch (error) { if (error?.code !== 'ENOENT') throw error; }

  const recordFailure = (classification, detail) => {
    recordServerFailure(marker, classification, detail, { preserve: true });
  };

  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

  let stopping = false;
  let ready = false;
  let child;
  try {
    child = spawn(command, args, { cwd, env: { ...process.env, BILLSPLIT_E2E_WRAPPED: '1' }, stdio: 'inherit' });
  } catch (error) {
    recordFailure(runtimeFailure(), `E2E web-server wrapper could not start: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    const classification = classifyTermination({ signal, ready });
    if (classification) {
      // Playwright signals the whole process group. The child's synchronous setup
      // may record its own failure first; this authoritative timeout must win.
      recordServerFailure(marker, classification, `Playwright terminated the E2E server: signal=${signal}, ready=${ready}, url=${url}`);
    }
    child.kill(signal);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  child.on('error', (error) => {
    recordFailure(runtimeFailure(), `E2E server process failed to start: ${error.message}`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    if (!stopping) recordFailure(runtimeFailure(), exitDetail('E2E server process', { code, signal, ready }));
    process.exit(exitStatus({ stopping, code }));
  });

  // Playwright owns the public readiness timeout. This probe only tells the
  // wrapper whether a later SIGTERM is normal teardown or a readiness timeout.
  void (async () => {
    while (!stopping && !ready) {
      try {
        await fetch(url, { signal: AbortSignal.timeout(1_000) });
        ready = true;
        return;
      } catch {
        await sleep(100);
      }
    }
  })();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runWebServer();
