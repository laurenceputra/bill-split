// @ts-expect-error Node types are not shipped to the browser build.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const baseConfig = readFileSync(new URL('../playwright.config.ts', import.meta.url), 'utf8');
const localConfig = readFileSync(new URL('../playwright.local.config.ts', import.meta.url), 'utf8');

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
