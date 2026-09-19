import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
// @ts-expect-error Node types are not shipped to the browser build.
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error This Node-only resolver is not part of the browser build.
import {
  assertAutomaticDiscoveryAllowed,
  discoverChromiumExecutable,
  requireValidatedPlaywrightLaunchOptions,
  resolveChromiumExecutable,
  runPlaywrightProcess,
  signalExitCode,
  validatePlaywrightExecutablePath,
} from './playwright-browser-resolver.mjs';

const temporaryDirectories: string[] = [];

async function createCache() {
  const cacheRoot = await mkdtemp(join(tmpdir(), 'bill-split-playwright-resolver-'));
  temporaryDirectories.push(cacheRoot);
  return cacheRoot;
}

async function createExecutable(cacheRoot: string, directory: string, executable: string, executableMode = 0o755) {
  const executablePath = join(cacheRoot, directory, executable);
  await mkdir(join(cacheRoot, directory), { recursive: true });
  await writeFile(executablePath, '#!/bin/sh\n');
  await chmod(executablePath, executableMode);
  return executablePath;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Playwright Chromium cache resolver', () => {
  it('orders numeric revisions and prefers headless shell over a newer full browser', () => {
    const cacheRoot = '/tmp/fake-playwright';
    const headless = resolveChromiumExecutable({
      cacheRoot,
      entries: ['chromium-12000', 'chromium_headless_shell-9', 'chromium_headless_shell-10', 'chromium-99999'],
      platform: 'linux',
      arch: 'x64',
      availablePaths: [
        join(cacheRoot, 'chromium_headless_shell-9', 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
        join(cacheRoot, 'chromium_headless_shell-10', 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
      ],
    });
    expect(headless).toMatchObject({ kind: 'headless', revision: '10' });

    const full = resolveChromiumExecutable({
      cacheRoot,
      entries: ['chromium-100', 'chromium-99'],
      platform: 'linux',
      arch: 'x64',
      availablePaths: [
        join(cacheRoot, 'chromium-99', 'chrome-linux64', 'chrome'),
        join(cacheRoot, 'chromium-100', 'chrome-linux64', 'chrome'),
      ],
    });
    expect(full).toMatchObject({ kind: 'full', revision: '100' });
  });

  it('uses current arm64 layouts and does not select an x64-only path', async () => {
    const cacheRoot = await createCache();
    const arm64Path = await createExecutable(cacheRoot, 'chromium-1243/chrome-linux-arm64', 'chrome');
    await mkdir(join(cacheRoot, 'chromium-1244/chrome-linux64'), { recursive: true });
    const selected = await discoverChromiumExecutable({ cacheRoot, arch: 'arm64' });
    expect(selected.path).toBe(arm64Path);
    expect(selected.revision).toBe('1243');
  });

  it('supports current arm64 headless-shell layout and prefers it over full fallback', async () => {
    const cacheRoot = await createCache();
    const headlessPath = await createExecutable(cacheRoot, 'chromium_headless_shell-1243/chrome-headless-shell-linux-arm64', 'chrome-headless-shell');
    await createExecutable(cacheRoot, 'chromium-9999/chrome-linux-arm64', 'chrome');
    const selected = await discoverChromiumExecutable({ cacheRoot, arch: 'arm64' });
    expect(selected.path).toBe(headlessPath);
    expect(selected.kind).toBe('headless');
  });

  it('falls back to the highest usable full-browser revision', async () => {
    const cacheRoot = await createCache();
    await createExecutable(cacheRoot, 'chromium_headless_shell-1243/chrome-headless-shell-linux64', 'chrome-headless-shell', 0o644);
    const fullPath = await createExecutable(cacheRoot, 'chromium-1242/chrome-linux64', 'chrome');
    const selected = await discoverChromiumExecutable({ cacheRoot, arch: 'x64' });
    expect(selected.path).toBe(fullPath);
    expect(selected.revision).toBe('1242');
    expect(selected.kind).toBe('full');
  });

  it('rejects missing, non-executable, and unsupported paths', async () => {
    const cacheRoot = await createCache();
    await expect(discoverChromiumExecutable({ cacheRoot, arch: 'x64' })).rejects.toThrow(/No usable Chromium executable/);
    await createExecutable(cacheRoot, 'chromium-1243/chrome-linux64', 'chrome', 0o644);
    await expect(discoverChromiumExecutable({ cacheRoot, arch: 'x64' })).rejects.toThrow(/accessible regular executable/);
    await expect(discoverChromiumExecutable({ cacheRoot, platform: 'darwin', arch: 'x64' })).rejects.toThrow(/darwin\/x64/);
  });

  it.each([
    ['yes', true],
    ['TRUE', true],
    ['1', true],
    [undefined, false],
    ['false', false],
    ['0', false],
  ])('handles CI=%s for automatic discovery', (ci, refuses) => {
    const check = () => assertAutomaticDiscoveryAllowed({ ci });
    if (refuses) expect(check).toThrow(/Refusing automatic browser discovery/);
    else expect(check).not.toThrow();
    expect(() => assertAutomaticDiscoveryAllowed({ ci, explicitPath: '/tmp/chrome' })).not.toThrow();
  });

  it('requires the local config handoff and ignores public or incomplete overrides', () => {
    expect(() => requireValidatedPlaywrightLaunchOptions({ BILLSPLIT_PLAYWRIGHT_EXECUTABLE_PATH: '/ambient/chrome' })).toThrow(/validated browser handoff/);
    expect(() => requireValidatedPlaywrightLaunchOptions({ BILLSPLIT_PLAYWRIGHT_VALIDATED_EXECUTABLE_PATH: '/private/chrome' })).toThrow(/validated browser handoff/);
    expect(requireValidatedPlaywrightLaunchOptions({ BILLSPLIT_PLAYWRIGHT_VALIDATED_OVERRIDE: '1', BILLSPLIT_PLAYWRIGHT_VALIDATED_EXECUTABLE_PATH: '/private/chrome' })).toEqual({ launchOptions: { executablePath: '/private/chrome' } });
  });

  it('validates an explicit executable override without changing the cache', async () => {
    const cacheRoot = await createCache();
    const executablePath = await createExecutable(cacheRoot, 'explicit', 'chrome');
    await expect(validatePlaywrightExecutablePath(executablePath)).resolves.toBe(executablePath);
    await expect(validatePlaywrightExecutablePath(join(cacheRoot, 'missing'))).rejects.toThrow(/regular executable file/);
  });

  it('resolves normal child exits and removes signal listeners', async () => {
    const child = new EventEmitter();
    const parent = new EventEmitter();
    const promise = runPlaywrightProcess({
      spawnProcess: () => child,
      processObject: parent,
      command: 'playwright',
    });
    child.emit('close', 0, null);
    await expect(promise).resolves.toEqual({ code: 0, signal: null });
    expect(parent.listenerCount('SIGINT')).toBe(0);
    expect(parent.listenerCount('SIGTERM')).toBe(0);
  });

  it('rejects spawn errors and removes signal listeners', async () => {
    const child = new EventEmitter();
    const parent = new EventEmitter();
    const promise = runPlaywrightProcess({ spawnProcess: () => child, processObject: parent, command: 'playwright' });
    const error = new Error('spawn failed');
    child.emit('error', error);
    await expect(promise).rejects.toBe(error);
    expect(parent.listenerCount('SIGINT')).toBe(0);
    expect(parent.listenerCount('SIGTERM')).toBe(0);
  });

  it('forwards termination signals and maps signal exits to shell codes', async () => {
    const child = new EventEmitter() as EventEmitter & { kill: (signal: string) => void };
    child.kill = vi.fn();
    const parent = new EventEmitter();
    const promise = runPlaywrightProcess({ spawnProcess: () => child, processObject: parent, command: 'playwright' });
    parent.emit('SIGTERM');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close', null, 'SIGTERM');
    await expect(promise).resolves.toEqual({ code: null, signal: 'SIGTERM' });
    expect(signalExitCode('SIGINT')).toBe(130);
    expect(signalExitCode('SIGTERM')).toBe(143);
    expect(parent.listenerCount('SIGTERM')).toBe(0);
  });
});
