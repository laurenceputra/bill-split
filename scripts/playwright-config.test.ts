// @ts-expect-error Node types are not shipped to the browser build.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const baseConfig = readFileSync(new URL('../playwright.config.ts', import.meta.url), 'utf8');
const localConfig = readFileSync(new URL('../playwright.local.config.ts', import.meta.url), 'utf8');
const workflow = readFileSync(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8');
const dateSuite = readFileSync(new URL('../tests/e2e/date-controls.spec.ts', import.meta.url), 'utf8');
const fixtures = readFileSync(new URL('../tests/e2e/fixtures.ts', import.meta.url), 'utf8');

describe('Playwright config isolation', () => {
  it('keeps the default config independent of all local browser override variables', () => {
    expect(baseConfig).not.toContain('BILLSPLIT_');
    expect(baseConfig).not.toContain('launchOptions');
  });

  it('makes the local config require the wrapper handoff', () => {
    expect(localConfig).toContain('requireValidatedPlaywrightLaunchOptions');
    expect(localConfig).toContain('./playwright.config');
  });
});

describe('Date-control CI isolation experiment', () => {
  it('runs both browser projects in independent single-worker jobs and retains both diagnostics', () => {
    const dateJob = workflow.split('\n  date-controls:\n')[1];
    expect(dateJob).toBeDefined();
    expect(dateJob).toContain('fail-fast: false');
    expect(dateJob).toMatch(/- project: chromium\s+browser: chromium/);
    expect(dateJob).toMatch(/- project: date-controls-webkit\s+browser: webkit/);
    expect(dateJob).toContain('npm run test:e2e -- tests/e2e/date-controls.spec.ts --project=${{ matrix.project }} --workers=1');
    expect(dateJob).toContain('if: failure()');
    expect(dateJob).toContain('name: date-controls-diagnostics-${{ matrix.project }}');
    expect(dateJob).toContain('wrangler-logs/');
    expect(baseConfig).toContain("{ name: 'chromium', use: { browserName: 'chromium' } }");
    expect(baseConfig).toContain("{ name: 'date-controls-webkit', testMatch: '**/date-controls.spec.ts', use: { browserName: 'webkit' } }");
    expect(baseConfig).toContain("command: 'node tests/e2e/web-server-wrapper.mjs'");
    expect(baseConfig).toContain('reuseExistingServer: false');
  });

  it('does not disable service workers for the date suite', () => {
    expect(baseConfig).not.toContain('serviceWorkers:');
    expect(dateSuite).not.toContain('serviceWorkers:');
    expect(fixtures).not.toMatch(/serviceWorkers:\s*['"]block['"]/);
    expect(workflow.split('\n  date-controls:\n')[1]).not.toMatch(/serviceWorkers|--config[= ]/);
  });
});
