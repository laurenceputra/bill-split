import { afterEach, describe, expect, it, vi } from 'vitest';
import { beginMutationBarrier, MutationBlockedError, releaseMutationBarrier, runMutation, withExclusiveMutationLock } from './mutation-quiescence';
import { captureSessionGeneration, rollbackSessionLogout, startSessionLogout } from './session';

type Pending = { mode: 'shared' | 'exclusive'; callback: () => Promise<unknown>; resolve: (value: unknown) => void; reject: (error: unknown) => void };

function mockedLocks() {
  const pending: Pending[] = [];
  let readers = 0;
  let writer = false;
  const pump = () => {
    if (writer || !pending.length) return;
    if (pending[0].mode === 'exclusive') {
      if (readers) return;
      const next = pending.shift()!;
      writer = true;
      void next.callback().then(next.resolve, next.reject).finally(() => { writer = false; pump(); });
      return;
    }
    while (pending[0]?.mode === 'shared') {
      const next = pending.shift()!;
      readers += 1;
      void next.callback().then(next.resolve, next.reject).finally(() => { readers -= 1; pump(); });
    }
  };
  return {
    request: (name: string, options: { mode: 'shared' | 'exclusive' }, callback: () => Promise<unknown>) => {
      expect(name).toBe('billsplit-api-mutations');
      return new Promise<unknown>((resolve, reject) => { pending.push({ mode: options.mode, callback, resolve, reject }); pump(); });
    },
  };
}

describe('mutation Web Locks ordering', () => {
  afterEach(() => {
    releaseMutationBarrier();
    rollbackSessionLogout(captureSessionGeneration(), false);
    vi.unstubAllGlobals();
  });

  it('finishes shared mutation work before logout and blocks a later mutation', async () => {
    vi.stubGlobal('navigator', { locks: mockedLocks() });
    const events: string[] = [];
    let releaseMutation!: () => void;
    const mutationHold = new Promise<void>((resolve) => { releaseMutation = resolve; });
    const mutation = runMutation(async () => { events.push('mutation-start'); await mutationHold; events.push('mutation-end'); });
    await vi.waitFor(() => expect(events).toEqual(['mutation-start']));

    const generation = startSessionLogout(false);
    beginMutationBarrier(generation);
    const logout = withExclusiveMutationLock(async () => { events.push('logout'); });
    const newMutation = runMutation(async () => { events.push('new-mutation'); });
    await Promise.resolve();
    expect(events).toEqual(['mutation-start']);

    releaseMutation();
    await mutation;
    await logout;
    await expect(newMutation).rejects.toBeInstanceOf(MutationBlockedError);
    expect(events).toEqual(['mutation-start', 'mutation-end', 'logout']);
  });
});
