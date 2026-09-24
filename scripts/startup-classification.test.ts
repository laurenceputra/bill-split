import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// @ts-expect-error Node-only E2E harness module.
import { classifyTermination, runtimeFailure, setupFailure } from '../tests/e2e/startup-classification.mjs';

const e2eRoot = path.resolve(import.meta.dirname, '../tests/e2e');

describe('E2E startup classification', () => {
  it('keeps setup failures distinct from runtime/environment failures', () => {
    expect(setupFailure()).toEqual({ type: 'setup-failure', category: 'setup/code' });
    expect(runtimeFailure()).toEqual({ type: 'runtime-failure', category: 'runtime/environment' });
  });

  it('classifies an external pre-readiness termination as a startup timeout only', () => {
    expect(classifyTermination({ signal: 'SIGTERM', ready: false })).toEqual({ type: 'startup-timeout', category: 'runtime/environment' });
    expect(classifyTermination({ signal: 'SIGTERM', ready: true })).toBeUndefined();
    expect(classifyTermination({ signal: 'SIGINT', ready: false })).toBeUndefined();
  });
});

describe('E2E selector architecture', () => {
  it('does not retain removed compatibility-class selectors', () => {
    for (const file of readdirSync(e2eRoot).filter((entry) => /\.(?:ts|mjs|js)$/.test(entry))) {
      const source = readFileSync(path.join(e2eRoot, file), 'utf8');
      expect(source, file).not.toMatch(/\.(?:page-title|list|surface|empty|section-title)(?![-\w])/);
    }
  });

  it('uses semantic or primitive hooks for the migrated accessibility assertions', () => {
    const source = readFileSync(path.join(e2eRoot, 'accessibility.spec.ts'), 'utf8');
    expect(source).toContain('.ui-page-header h1');
    expect(source).toContain('.ui-empty-state');
    expect(source).toContain('.ui-ledger-list');
    expect(source).toContain('.ui-form-surface form');
  });
});
