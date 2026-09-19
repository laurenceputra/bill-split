import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import {
  DEFAULT_PLAYWRIGHT_BROWSERS_PATH,
  PLAYWRIGHT_EXECUTABLE_ENV,
  PLAYWRIGHT_VALIDATED_EXECUTABLE_ENV,
  PLAYWRIGHT_VALIDATED_MARKER,
  PLAYWRIGHT_VALIDATED_MARKER_ENV,
  assertAutomaticDiscoveryAllowed,
  discoverChromiumExecutable,
  formatSelectedBrowser,
  runPlaywrightProcess,
  signalExitCode,
  validatePlaywrightExecutablePath,
} from './playwright-browser-resolver.mjs';

const explicitPath = process.env[PLAYWRIGHT_EXECUTABLE_ENV];

function fail(message) {
  console.error(`[test:e2e:local] ${message}`);
  process.exitCode = 1;
}

let selected;
try {
  if (explicitPath !== undefined) {
    if (!explicitPath.trim()) {
      throw new Error(`${PLAYWRIGHT_EXECUTABLE_ENV} was provided but is empty.`);
    }
    const path = await validatePlaywrightExecutablePath(explicitPath.trim());
    selected = { path, revision: 'explicit', kind: 'explicit' };
    console.log(`[test:e2e:local] Using explicit executable path: ${path}`);
  } else {
    assertAutomaticDiscoveryAllowed({ ci: process.env.CI, explicitPath });
    selected = await discoverChromiumExecutable({
      cacheRoot: process.env.PLAYWRIGHT_BROWSERS_PATH || DEFAULT_PLAYWRIGHT_BROWSERS_PATH,
    });
    console.log(formatSelectedBrowser(selected));
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const require = createRequire(import.meta.url);
const playwrightCli = require.resolve('@playwright/test/cli');
const localConfig = fileURLToPath(new URL('../playwright.local.config.ts', import.meta.url));
const childEnv = { ...process.env, [PLAYWRIGHT_VALIDATED_EXECUTABLE_ENV]: selected.path, [PLAYWRIGHT_VALIDATED_MARKER_ENV]: PLAYWRIGHT_VALIDATED_MARKER };
delete childEnv[PLAYWRIGHT_EXECUTABLE_ENV];

try {
  const result = await runPlaywrightProcess({
    spawnProcess: spawn,
    command: process.execPath,
    args: [playwrightCli, 'test', '--config', localConfig, ...process.argv.slice(2)],
    options: { env: childEnv, stdio: 'inherit' },
  });
  process.exitCode = result.signal ? signalExitCode(result.signal) : result.code ?? 1;
} catch (error) {
  console.error(`[test:e2e:local] Could not start Playwright: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
