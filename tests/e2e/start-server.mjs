import path from 'node:path';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { E2E_PORT } from './config.mjs';
import { configuredPersistDir, runPersistDirSelfCheck, verifySafePersistDir } from './persist-dir.mjs';
import { runtimeFailure, setupFailure } from './startup-classification.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const environmentFailurePath = path.join(root, 'test-results', 'e2e-environment-failure.json');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const wrangler = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');

const recordFailure = (classification, detail) => {
  try {
    // The wrapper writes the external pre-readiness termination marker before
    // forwarding SIGTERM. Do not replace that classification when a blocked
    // synchronous setup command resumes and observes the forwarded signal.
    if (process.env.BILLSPLIT_E2E_WRAPPED === '1' && existsSync(environmentFailurePath)) return;
    mkdirSync(path.dirname(environmentFailurePath), { recursive: true });
    writeFileSync(environmentFailurePath, JSON.stringify({ ...classification, recordedAt: new Date().toISOString(), detail }, null, 2));
  } catch {
    // The original process status remains the authoritative failure signal.
  }
};

mkdirSync(path.dirname(environmentFailurePath), { recursive: true });
if (process.env.BILLSPLIT_E2E_WRAPPED !== '1') {
  try { unlinkSync(environmentFailurePath); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
}
let persistTo;
try {
  runPersistDirSelfCheck();
  persistTo = await verifySafePersistDir(configuredPersistDir());
} catch (error) {
  recordFailure(runtimeFailure(), `E2E server preflight failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const run = (command, args, env = process.env) => {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' });
  if (result.error) {
    recordFailure(setupFailure(), `${command} failed to start: ${result.error.message}`);
    throw result.error;
  }
  if (result.status !== 0) {
    recordFailure(setupFailure(), `${command} exited with status ${result.status}`);
    process.exit(result.status ?? 1);
  }
};

// The browser audit supplies X-Dev-Email at the context boundary. This
// build-only hint lets the app start its normal /api/me lifecycle without a
// real Clerk browser session; the Worker accepts the header only for the
// exact development environment.
run(npm, ['run', 'build'], { ...process.env, VITE_DEV_AUTH_BYPASS: 'true' });
run(process.execPath, ['tests/e2e/prepare-db.mjs']);

const server = spawn(wrangler, [
  'dev', 'tests/e2e/worker-entry.ts', '--env', 'dev', '--local', '--port', String(E2E_PORT), '--persist-to', persistTo,
  '--config', 'wrangler.toml', '--show-interactive-dev-session=false',
], { cwd: root, env: process.env, stdio: 'inherit' });

let stopping = false;
const stop = (signal) => {
  if (stopping) return;
  stopping = true;
  server.kill(signal);
};
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
server.on('exit', (code, signal) => {
  if (stopping) process.exit(0);
  recordFailure(runtimeFailure(), `Wrangler dev exited unexpectedly${code === null ? ` from ${signal || 'an unknown signal'}` : ` with status ${code}`}`);
  process.exit(code ?? (signal ? 1 : 0));
});
