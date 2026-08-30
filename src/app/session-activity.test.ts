import { afterEach, describe, expect, it, vi } from 'vitest';
import { APPLICATION_SESSION_ACTIVITY_THROTTLE_MS } from '../shared/session-policy';
import { createSessionActivityScheduler, SESSION_ACTIVITY_STORAGE_KEY } from './session-activity';

const trusted = () => {
  const event = new Event('pointerdown');
  Object.defineProperty(event, 'isTrusted', { value: true });
  return event;
};

describe('foreground session activity', () => {
  afterEach(() => vi.useRealTimers());

  it('renews on a visible opening and then on trusted interaction after the client throttle', async () => {
    vi.useFakeTimers();
    const windowTarget = new EventTarget();
    const documentTarget = new EventTarget();
    const values = new Map<string, string>();
    let visible = true;
    let online = true;
    let timestamp = APPLICATION_SESSION_ACTIVITY_THROTTLE_MS;
    const renew = vi.fn(async () => undefined);
    const scheduler = createSessionActivityScheduler({
      isAuthenticated: () => true,
      isOnline: () => online,
      isVisible: () => visible,
      renew,
      windowTarget,
      documentTarget,
      storage: { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) },
      now: () => timestamp,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(renew).toHaveBeenCalledOnce();

    windowTarget.dispatchEvent(new Event('pointerdown'));
    expect(renew).toHaveBeenCalledOnce();
    timestamp += APPLICATION_SESSION_ACTIVITY_THROTTLE_MS;
    windowTarget.dispatchEvent(trusted());
    await Promise.resolve();
    await Promise.resolve();
    expect(renew).toHaveBeenCalledTimes(2);

    scheduler.dispose();
  });

  it('does not renew from hidden/background or untrusted events', async () => {
    const windowTarget = new EventTarget();
    const documentTarget = new EventTarget();
    const renew = vi.fn(async () => undefined);
    let visible = false;
    const scheduler = createSessionActivityScheduler({
      isAuthenticated: () => true,
      isOnline: () => true,
      isVisible: () => visible,
      renew,
      windowTarget,
      documentTarget,
      storage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    });
    documentTarget.dispatchEvent(new Event('visibilitychange'));
    windowTarget.dispatchEvent(new Event('pageshow'));
    windowTarget.dispatchEvent(new Event('pointerdown'));
    windowTarget.dispatchEvent(new Event('keydown'));
    expect(renew).not.toHaveBeenCalled();

    visible = true;
    documentTarget.dispatchEvent(new Event('visibilitychange'));
    expect(renew).toHaveBeenCalledOnce();
    scheduler.dispose();
  });

  it('clears only its failed activity marker so a later explicit signal can retry', async () => {
    const windowTarget = new EventTarget();
    const values = new Map([[SESSION_ACTIVITY_STORAGE_KEY, '0']]);
    let rejectRenew!: (error: Error) => void;
    const renew = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectRenew = reject; }));
    const scheduler = createSessionActivityScheduler({
      isAuthenticated: () => true,
      isOnline: () => true,
      isVisible: () => true,
      renew,
      windowTarget,
      storage: { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) },
      now: () => APPLICATION_SESSION_ACTIVITY_THROTTLE_MS,
    });
    rejectRenew(new Error('offline'));
    await Promise.resolve();
    await Promise.resolve();
    expect(values.has(SESSION_ACTIVITY_STORAGE_KEY)).toBe(false);
    windowTarget.dispatchEvent(trusted());
    expect(renew).toHaveBeenCalledTimes(2);
    scheduler.dispose();
  });
});
