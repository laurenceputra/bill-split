import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { configuredPersistDir, runPersistDirSelfCheck, verifySafePersistDir } from './persist-dir.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const wrangler = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');
runPersistDirSelfCheck();
const persistTo = await verifySafePersistDir(configuredPersistDir());

const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, env: process.env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};

run(npm, ['run', 'build']);
run(process.execPath, ['tests/e2e/prepare-db.mjs']);

const server = spawn(wrangler, [
  'dev', 'tests/e2e/worker-entry.ts', '--env', 'dev', '--local', '--port', '8788', '--persist-to', persistTo,
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
  process.exit(code ?? (signal ? 1 : 0));
});
