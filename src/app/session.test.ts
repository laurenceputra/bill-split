import { afterEach, describe, expect, it, vi } from 'vitest';

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe('persisted logout coordination', () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('hydrates the logout barrier in a new tab before private work can start', async () => {
    vi.stubGlobal('localStorage', storage());
    vi.stubGlobal('window', { addEventListener: vi.fn() });
    vi.resetModules();
    const first = await import('./session');
    const listener = vi.fn();
    first.subscribeSessionState(listener);

    const generation = first.startSessionLogout(false);
    expect(first.getSessionLogoutInProgress()).toBe(true);
    expect(listener).toHaveBeenCalled();

    vi.resetModules();
    const second = await import('./session');
    expect(second.getSessionLogoutInProgress()).toBe(true);
    expect(second.captureSessionGeneration()).toBe(generation);

    second.rollbackSessionLogout(generation, false);
    expect(first.getSessionLogoutInProgress()).toBe(false);
    expect(second.getSessionLogoutInProgress()).toBe(false);
  });
});
