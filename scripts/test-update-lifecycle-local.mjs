import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { assertAutomaticDiscoveryAllowed, discoverChromiumExecutable, formatSelectedBrowser, runPlaywrightProcess, signalExitCode } from './playwright-browser-resolver.mjs';

assertAutomaticDiscoveryAllowed({ ci: process.env.CI });
const selected = await discoverChromiumExecutable({ cacheRoot: process.env.PLAYWRIGHT_BROWSERS_PATH || '/ms-playwright' });
console.log(formatSelectedBrowser(selected));
const require = createRequire(import.meta.url);
const result = await runPlaywrightProcess({
  spawnProcess: spawn,
  command: process.execPath,
  args: [require.resolve('@playwright/test/cli'), 'test', '--config', fileURLToPath(new URL('../tests/e2e/fixtures/update-playwright.config.ts', import.meta.url)), ...process.argv.slice(2)],
  options: { env: { ...process.env, UPDATE_FIXTURE_BROWSER: selected.path }, stdio: 'inherit' },
});
process.exitCode = result.signal ? signalExitCode(result.signal) : result.code ?? 1;
