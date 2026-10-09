import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// @ts-expect-error Node-only E2E harness module.
import { classifyTermination, runtimeFailure, setupFailure } from '../tests/e2e/startup-classification.mjs';
// @ts-expect-error Node-only E2E harness module.
import { exitDetail, exitStatus, recordServerFailure } from '../tests/e2e/server-lifecycle.mjs';
// @ts-expect-error Node-only Playwright reporter.
import EnvironmentReporter from '../tests/e2e/environment-reporter.mjs';

const e2eRoot = path.resolve(import.meta.dirname, '../tests/e2e');

describe('E2E startup classification', () => {
  it.each(['zero', 'nonzero', 'signal', 'teardown', 'spawn-error'])('handles a real child process: %s', async (scenario) => {
    const source = scenario === 'signal' ? "process.kill(process.pid, 'SIGTERM')" : `process.exit(${scenario === 'nonzero' ? 7 : 0})`;
    const child = spawn(scenario === 'spawn-error' ? '/nonexistent/e2e-server' : process.execPath, ['-e', source]);
    const result = await new Promise<{ code: number | null; signal?: string | null; error?: Error }>((resolve) => {
      child.on('error', (error) => resolve({ code: null, error }));
      child.on('exit', (code, signal) => resolve({ code, signal }));
    });
    if (scenario === 'spawn-error') expect(result.error).toBeDefined();
    if (scenario === 'signal') expect(result.signal).toBe('SIGTERM');
    expect(exitStatus({ stopping: scenario === 'teardown', code: result.code })).toBe(scenario === 'teardown' ? 0 : scenario === 'nonzero' ? 7 : 1);
  });

  it.each([[0, null], [7, null], [null, 'SIGTERM'], [null, 'SIGKILL']])('fails unexpected exits (code=%s, signal=%s) but accepts expected teardown', (code, signal) => {
    expect(exitStatus({ stopping: false, code })).toBe(code || 1);
    expect(exitStatus({ stopping: true, code })).toBe(0);
    expect(exitDetail('server', { code, signal, ready: true })).toContain('ready=true');
    expect(exitDetail('server', { code, signal, ready: false })).toContain(`code=${code ?? 'null'}, signal=${signal ?? 'none'}, ready=false`);
  });

  it('logs failures immediately and preserves a pre-readiness timeout marker', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'e2e-lifecycle-'));
    const marker = path.join(directory, 'failure.json');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      recordServerFailure(marker, classifyTermination({ signal: 'SIGTERM', ready: false }), 'ready=false');
      recordServerFailure(marker, runtimeFailure(), 'code=0, signal=none, ready=true', { preserve: true });
      const failure = JSON.parse(readFileSync(marker, 'utf8'));
      expect(failure.type).toBe('startup-timeout');
      expect(Number.isNaN(Date.parse(failure.recordedAt))).toBe(false);
      expect(log).toHaveBeenCalledTimes(2);
      expect(log.mock.calls[1][0]).toContain('code=0, signal=none, ready=true');
      recordServerFailure(marker, setupFailure(), 'Demo replacement');
      expect(JSON.parse(readFileSync(marker, 'utf8')).type).toBe('setup-failure');
      expect(readdirSync(directory)).toEqual(['failure.json']);
    } finally {
      log.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('swallows publication failures and cleans completed temporary files', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'e2e-lifecycle-'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      // An existing directory cannot be replaced by either publication mode.
      for (const preserve of [false, true]) {
        expect(() => recordServerFailure(directory, setupFailure(), 'Demo unavailable marker', { preserve })).not.toThrow();
      }
      const prefix = `${path.basename(directory)}.`;
      expect(readdirSync(path.dirname(directory)).filter((file) => file.startsWith(prefix))).toEqual([]);
      expect(log).toHaveBeenCalledTimes(2);
    } finally {
      log.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('makes the standard runner fail when a runtime marker remains', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'e2e-reporter-'));
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(directory);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const reporter = new EnvironmentReporter();
      expect(reporter.onEnd()).toBeUndefined();
      reporter.onTestBegin();
      recordServerFailure(path.join(directory, 'test-results/e2e-environment-failure.json'), runtimeFailure(), 'unexpected zero exit');
      expect(reporter.onEnd()).toEqual({ status: 'failed' });
    } finally {
      cwd.mockRestore();
      log.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });
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
