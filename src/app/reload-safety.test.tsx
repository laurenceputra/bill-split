import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireReloadGate, assertReloadOperationAllowed, beginProtectedOperation, createReloadBlocker, getReloadSafetyState, isReloadSafe, observeReloadInteractions, ownsReloadGate, recordReloadInteraction, releaseReloadGate, runProtectedOperation, subscribeReloadSafety } from './reload-safety';
import { useReloadBlocker } from './reload-safety-react';

afterEach(() => vi.useRealTimers());
const idle = async () => { recordReloadInteraction(); await vi.advanceTimersByTimeAsync(2_000); };
describe('reload safety', () => {
  it('requires two seconds of inactivity and invalidates prepared gates synchronously', async () => {
    vi.useFakeTimers();
    await idle();
    expect(acquireReloadGate('first', 10_000)).toBe(true);
    const target = new EventTarget();
    const dispose = observeReloadInteractions(target as Document);
    target.dispatchEvent(new Event('input'));
    expect(ownsReloadGate('first')).toBe(false);
    expect(isReloadSafe()).toBe(false);
    expect(acquireReloadGate('second', 10_000)).toBe(false);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(isReloadSafe()).toBe(false);
    expect(acquireReloadGate('second', 10_000)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(isReloadSafe()).toBe(true);
    dispose();
  });

  it('holds persistent draft ownership through blur and a failed save until explicitly clean', async () => {
    vi.useFakeTimers();
    function Draft({ dirty }: { dirty: boolean }) { useReloadBlocker(dirty, 'Unsaved profile'); return null; }
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<Draft dirty={false} />); });
    await idle();
    expect(isReloadSafe()).toBe(true);
    act(() => tree.update(<Draft dirty />));
    recordReloadInteraction(); // blur/activity does not clear semantic state.
    await vi.advanceTimersByTimeAsync(6_000);
    expect(getReloadSafetyState().reason).toBe('Unsaved profile');
    await expect(runProtectedOperation(async () => { throw new Error('Save failed'); })).rejects.toThrow('Save failed');
    expect(isReloadSafe()).toBe(false);
    act(() => tree.update(<Draft dirty={false} />));
    expect(isReloadSafe()).toBe(true);
    act(() => tree.unmount());
  });

  it('keeps the underlying operation protected after a caller timeout and rejects new work behind a gate', async () => {
    vi.useFakeTimers();
    await idle();
    let finish!: () => void;
    const work = runProtectedOperation(() => new Promise<void>((resolve) => { finish = resolve; }), 'Writing outbox');
    await Promise.race([work, Promise.resolve('caller deadline')]);
    expect(getReloadSafetyState().operations).toBe(1);
    expect(acquireReloadGate('attempt', 10_000)).toBe(false);
    finish(); await work;
    expect(acquireReloadGate('attempt', 10_000)).toBe(true);
    expect(() => beginProtectedOperation()).toThrow('being prepared');
    expect(releaseReloadGate('cancelled-old-attempt')).toBe(false);
    expect(ownsReloadGate('attempt')).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(() => assertReloadOperationAllowed()).not.toThrow();
    expect(ownsReloadGate('attempt')).toBe(false);
  });

  it('publishes blockers synchronously and makes release idempotent', async () => {
    vi.useFakeTimers(); await idle();
    const changed = vi.fn();
    const unsubscribe = subscribeReloadSafety(changed);
    const release = createReloadBlocker('Dialog open');
    expect(changed).toHaveBeenCalled();
    expect(isReloadSafe()).toBe(false);
    release(); release();
    expect(isReloadSafe()).toBe(true);
    unsubscribe();
  });
});
