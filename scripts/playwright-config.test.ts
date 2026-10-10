import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error Node types are not shipped to the browser build.
import { readFileSync } from 'node:fs';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('Playwright config contracts', () => {
  it('keeps CI browser failures independent and uploads server diagnostics', () => {
    const workflow = readFileSync(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8');
    const job = workflow.match(/^  date-controls:\s*\n([\s\S]*?)(?=^  [\w-]+:|$(?![\s\S]))/m)?.[1] ?? '';
    expect(job).toMatch(/fail-fast:\s*false/);
    const matrixEntries = [...job.matchAll(/^\s*-\s*project:\s*([^\s]+)\s*\n\s*browser:\s*([^\s]+)/gm)]
      .map((entry) => ({ project: entry[1], browser: entry[2] }));
    expect(matrixEntries).toEqual(expect.arrayContaining([
      { project: 'chromium', browser: 'chromium' },
      { project: 'date-controls-webkit', browser: 'webkit' },
    ]));
    const dateCommand = job.split('\n').find((line) => /^\s*-\s*run:/.test(line) && /tests\/e2e\/date-controls\.spec\.ts/.test(line)) ?? '';
    expect(dateCommand).toMatch(/(?:test:e2e|playwright\s+test)\s/);
    expect(dateCommand).toMatch(/--project(?:=|\s+)\$\{\{\s*matrix\.project\s*\}\}/);
    expect(dateCommand).toMatch(/--workers(?:=|\s+)1(?:\s|$)/);
    expect(job).toMatch(/if:\s*(?:\$\{\{\s*)?failure\(\)/);
    expect(job).toMatch(/name:\s*date-controls-diagnostics-.*matrix\.project/);
    expect(job).toContain('wrangler-logs/');
  });

  it('ignores unvalidated local browser overrides in the default config', async () => {
    vi.stubEnv('BILLSPLIT_PLAYWRIGHT_EXECUTABLE_PATH', '/unvalidated/browser');
    vi.stubEnv('BILLSPLIT_PLAYWRIGHT_VALIDATED_EXECUTABLE_PATH', '/validated/browser');
    vi.stubEnv('BILLSPLIT_PLAYWRIGHT_VALIDATED_OVERRIDE', '1');
    const { default: config } = await import('../playwright.config');
    expect(config.use?.launchOptions).toBeUndefined();
    for (const project of config.projects ?? []) {
      expect(project.use?.launchOptions).toBeUndefined();
    }
  });

  it('requires a validated wrapper handoff for the local config', async () => {
    vi.stubEnv('BILLSPLIT_PLAYWRIGHT_VALIDATED_OVERRIDE', '');
    await expect(import('../playwright.local.config')).rejects.toThrow(/validated browser handoff/);
  });

  it('applies the validated override only to Chromium', async () => {
    vi.stubEnv('BILLSPLIT_PLAYWRIGHT_VALIDATED_EXECUTABLE_PATH', '/validated/browser');
    vi.stubEnv('BILLSPLIT_PLAYWRIGHT_VALIDATED_OVERRIDE', '1');
    const { default: config } = await import('../playwright.local.config');
    expect(config.projects?.find((project) => project.name === 'chromium')?.use?.launchOptions)
      .toEqual({ executablePath: '/validated/browser' });
    expect(config.projects?.find((project) => project.name === 'date-controls-webkit')?.use?.launchOptions).toBeUndefined();
  });

  it('covers date controls in Chromium and scoped WebKit with failure diagnostics', async () => {
    const { default: config } = await import('../playwright.config');
    expect(config.projects).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'chromium', use: expect.objectContaining({ browserName: 'chromium' }) }),
      expect.objectContaining({ name: 'date-controls-webkit', testMatch: '**/date-controls.spec.ts', use: expect.objectContaining({ browserName: 'webkit' }) }),
    ]));
    expect(config.use).toMatchObject({ trace: 'retain-on-failure', screenshot: 'only-on-failure' });
    expect(config.use?.serviceWorkers).not.toBe('block');
    for (const project of config.projects ?? []) expect(project.use?.serviceWorkers).not.toBe('block');
    const fixtures = readFileSync(new URL('../tests/e2e/fixtures.ts', import.meta.url), 'utf8');
    expect(fixtures).not.toMatch(/(?:['"]serviceWorkers['"]|\bserviceWorkers)\s*:\s*['"]block['"]/);
    expect(config.webServer).toMatchObject({
      reuseExistingServer: false,
      gracefulShutdown: { signal: 'SIGTERM', timeout: expect.any(Number) },
      stdout: 'pipe', stderr: 'pipe',
    });
  });
});
