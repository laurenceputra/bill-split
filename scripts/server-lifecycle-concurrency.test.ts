import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

const lifecycle = pathToFileURL(path.resolve(import.meta.dirname, '../tests/e2e/server-lifecycle.mjs')).href;
const classification = pathToFileURL(path.resolve(import.meta.dirname, '../tests/e2e/startup-classification.mjs')).href;

function bounded(promise: Promise<void>, stage: string, timeout: number) {
  const result = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Writer ${stage} timed out`)), timeout);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
  // Completion can fail while the caller is still awaiting the barrier.
  void result.catch(() => undefined);
  return result;
}

// Own every child before awaiting the barrier, including when a peer fails.
function writers(marker: string, preserving: boolean[], count = 1, { fault = '', timeout = 8_000 } = {}) {
  const children: { child: ReturnType<typeof spawn>; ready: Promise<void>; done: Promise<void>; reaped: Promise<void> }[] = [];
  const ready = (async () => {
    for (const [index, preserve] of preserving.entries()) {
      const source = `import { recordServerFailure } from ${JSON.stringify(lifecycle)};
      import { setupFailure, classifyTermination } from ${JSON.stringify(classification)};
      process.on('message', () => {
        for (let i = 0; i < ${count}; i++) recordServerFailure(${JSON.stringify(marker)},
          ${preserve ? 'setupFailure()' : "classifyTermination({signal:'SIGTERM', ready:false})"},
          ${JSON.stringify(`Demo writer ${index}: `)} + 'x'.repeat(65536), {preserve:${preserve}});
        process.disconnect();
      }); process.send('ready');`;
      const faultySource = fault === 'exit' ? 'process.exit(7)' : fault === 'readiness' ? 'setInterval(() => {}, 1000)' : "process.send('ready'); setInterval(() => {}, 1000)";
      const child = spawn(process.execPath, ['--input-type=module', '-e', index === 0 && fault ? faultySource : source], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      const reaped = new Promise<void>((resolve) => child.once('close', () => resolve()));
      const done = bounded(new Promise<void>((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Writer exited ${code}`)));
      }), 'completion', timeout * 2);
      const ready = bounded(new Promise<void>((resolve, reject) => {
        child.once('message', () => resolve());
        child.once('error', reject);
        child.once('close', () => reject(new Error('Writer exited before barrier')));
      }), 'readiness', timeout);
      children.push({ child, ready, done, reaped });
    }
    await Promise.all(children.map(({ ready }) => ready));
  })();
  void ready.catch(() => undefined);
  const cleanup = async () => {
    for (const { child } of children) {
      // Killing first lets Node close IPC as part of reaping. Explicitly
      // disconnecting first can suppress the child's 'close' event.
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await Promise.all(children.map(({ reaped }) => reaped));
    for (const { child } of children) {
      if (child.connected) child.disconnect();
    }
  };
  return { children, ready, cleanup };
}

it.each(['setup-first', 'timeout-first', 'racing'])('keeps the authoritative timeout across processes: %s', async (order) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'e2e-atomic-'));
  const group = writers(path.join(directory, 'failure.json'), [true, false]);
  try {
    const marker = path.join(directory, 'failure.json');
    await group.ready;
    const { children } = group;
    if (order === 'racing') {
      children.forEach(({ child }) => child.send('go'));
      await Promise.all(children.map(({ done }) => done));
    } else {
      const first = order === 'setup-first' ? 0 : 1;
      children[first].child.send('go');
      await children[first].done;
      children[1 - first].child.send('go');
      await children[1 - first].done;
    }
    expect(JSON.parse(readFileSync(marker, 'utf8')).type).toBe('startup-timeout');
    expect(readdirSync(directory)).toEqual(['failure.json']);
  } finally {
    await group.cleanup();
    rmSync(directory, { recursive: true, force: true });
  }
}, 20_000);

it.each([true, false])('publishes only complete JSON during concurrent writes (preserve=%s)', async (preserve) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'e2e-atomic-'));
  const group = writers(path.join(directory, 'failure.json'), [preserve, preserve, preserve, preserve], 100);
  let observer: ReturnType<typeof setInterval> | undefined;
  try {
    const marker = path.join(directory, 'failure.json');
    await group.ready;
    const { children } = group;
    const observed = new Set<string>();
    const errors: unknown[] = [];
    observer = setInterval(() => {
      if (!existsSync(marker)) return;
      try {
        const failure = JSON.parse(readFileSync(marker, 'utf8'));
        expect(failure.type).toBe(preserve ? 'setup-failure' : 'startup-timeout');
        expect(failure.detail).toMatch(/^Demo writer [0-3]: x{65536}$/);
        observed.add(failure.detail);
      } catch (error) { errors.push(error); }
    }, 1);
    children.forEach(({ child }) => child.send('go'));
    await Promise.all(children.map(({ done }) => done));
    clearInterval(observer);
    const failure = JSON.parse(readFileSync(marker, 'utf8'));
    expect(failure.detail).toMatch(/^Demo writer [0-3]: x{65536}$/);
    expect(errors).toEqual([]);
    expect(observed.size).toBeGreaterThan(0);
    if (preserve) expect([...observed]).toEqual([failure.detail]);
    expect(readdirSync(directory)).toEqual(['failure.json']);
  } finally {
    clearInterval(observer);
    await group.cleanup();
    rmSync(directory, { recursive: true, force: true });
  }
}, 20_000);

it.each(['exit', 'readiness', 'completion'])('reaps all writers after a harness failure: %s', async (fault) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'e2e-atomic-'));
  const group = writers(path.join(directory, 'failure.json'), [true, true], 1, { fault, timeout: 2_000 });
  try {
    const run = async () => {
      try {
        await group.ready;
        group.children.forEach(({ child }) => child.send('go'));
        await Promise.all(group.children.map(({ done }) => done));
      } finally {
        await group.cleanup();
      }
    };
    await expect(run()).rejects.toThrow(fault === 'exit' ? /Writer exited/ : /timed out/);
    expect(group.children).toHaveLength(2);
    for (const { child } of group.children) {
      expect(child.connected).toBe(false);
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    }
  } finally {
    await group.cleanup();
    rmSync(directory, { recursive: true, force: true });
  }
}, 20_000);
