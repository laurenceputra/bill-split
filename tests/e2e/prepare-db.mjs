import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { configuredPersistDir, runPersistDirSelfCheck, verifySafePersistDir } from './persist-dir.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
runPersistDirSelfCheck();
const persistTo = await verifySafePersistDir(configuredPersistDir());
const wrangler = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');

await rm(persistTo, { recursive: true, force: true });

const run = (args) => {
  const result = spawnSync(wrangler, args, { cwd: root, env: process.env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};

const localArgs = ['--env', 'dev', '--local', '--persist-to', persistTo, '--config', 'wrangler.toml'];
run(['d1', 'migrations', 'apply', 'bill-split', ...localArgs]);
run(['d1', 'execute', 'bill-split', ...localArgs, '--file', 'tests/e2e/fixture.sql']);
console.log(`E2E D1 prepared in isolated persistence directory: ${persistTo}`);
