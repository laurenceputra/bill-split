import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const cli = createRequire(import.meta.url).resolve('@playwright/test/cli');
const wrapper = pathToFileURL(path.join(root, 'tests/e2e/web-server-wrapper.mjs')).href;
const reporter = path.join(root, 'tests/e2e/environment-reporter.mjs');

function run(args: string[], cwd: string) {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env: { ...process.env, CI: '1' } });
    let output = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });
}

it.each(['timeout', 'teardown', 'runtime', 'zero', 'nonzero', 'signal', 'spawn-error'])('exercises the wrapper through real Playwright: %s', async (scenario) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'e2e-boundary-'));
  const marker = path.join(directory, 'test-results/e2e-environment-failure.json');
  try {
    // No browser fixture: only the actual Playwright webServer lifecycle runs.
    writeFileSync(path.join(directory, 'smoke.spec.cjs'), `const { test } = require(${JSON.stringify(path.join(root, 'node_modules/@playwright/test'))}); test('smoke', async () => { ${scenario === 'runtime' ? `require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ type: 'runtime-failure' }));` : ''} });`);
    const source = scenario === 'zero' ? 'process.exit(0)' : scenario === 'nonzero' ? 'process.exit(7)' : scenario === 'signal' ? "process.kill(process.pid, 'SIGTERM')" : scenario === 'timeout' ? `setInterval(() => {}, 1000); process.on('SIGTERM', () => { require('node:fs').mkdirSync('test-results', { recursive: true }); if (!require('node:fs').existsSync(${JSON.stringify(marker)})) require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({type:'setup-failure'})); process.exit(1); });` : "require('node:http').createServer((req, res) => res.end('ok')).listen(0, '127.0.0.1', function() { require('node:fs').writeFileSync('port', String(this.address().port)); });";
    // Ready cases use stdout readiness, with the wrapper probing the published port.
    const ready = ['teardown', 'runtime'].includes(scenario);
    const url = ready ? undefined : 'http://127.0.0.1:1';
    const script = `import { runWebServer } from ${JSON.stringify(wrapper)}; ${ready ? `import { readFileSync, existsSync } from 'node:fs'; import { spawn } from 'node:child_process'; const server = spawn(process.execPath, ['-e', ${JSON.stringify(source)}], {stdio:'inherit'}); while (!existsSync('port')) await new Promise(r => setTimeout(r, 10)); const url = 'http://127.0.0.1:' + readFileSync('port','utf8'); process.on('SIGTERM', () => server.kill('SIGTERM')); await runWebServer({cwd:process.cwd(), args:['-e', 'setInterval(() => {}, 1000)'], url}); await fetch(url); console.log('BOUNDARY_READY');` : `await runWebServer({cwd:process.cwd(), command:${JSON.stringify(scenario === 'spawn-error' ? '/nonexistent/e2e-server' : process.execPath)}, args:['-e', ${JSON.stringify(source)}], url:${JSON.stringify(url)}});`}`;
    writeFileSync(path.join(directory, 'server.mjs'), script);
    writeFileSync(path.join(directory, 'playwright.config.cjs'), `module.exports = { testDir:'.', reporter:[[${JSON.stringify(reporter)}]], webServer:{ command:${JSON.stringify(`"${process.execPath}" server.mjs`)}, ${ready ? "wait:{stdout:/BOUNDARY_READY/}," : `url:${JSON.stringify(url)},`} timeout:2000, gracefulShutdown:{signal:'SIGTERM',timeout:5000} } };`);
    const result = await run([cli, 'test', '--config', 'playwright.config.cjs'], directory);
    expect(result.code, result.output).toBe(scenario === 'teardown' ? 0 : 1);
    if (scenario === 'timeout') expect(JSON.parse(readFileSync(marker, 'utf8')).type).toBe('startup-timeout');
    if (scenario === 'teardown') expect(existsSync(marker)).toBe(false);
    if (['zero', 'nonzero', 'signal', 'spawn-error'].includes(scenario)) expect(JSON.parse(readFileSync(marker, 'utf8')).type).toBe('runtime-failure');
    if (scenario === 'runtime') {
      const listed = await run([cli, 'test', '--config', 'playwright.config.cjs', '--list'], directory);
      expect(listed.code, listed.output).toBe(0);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 20_000);
