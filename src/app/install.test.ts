import { describe, expect, it, vi } from 'vitest';
import { consumeInstallPrompt, getInstallState, initializeInstallUX, isIOS, isStandalone, subscribeInstall } from './install';

describe('install helpers', () => {
  it('are safe when browser display APIs are unavailable', () => {
    expect(isStandalone()).toBe(false);
    expect(isIOS()).toBe(false);
  });

  it('keeps a stable snapshot and only notifies for real transitions', async () => {
    const fakeNavigator = { userAgent: '', platform: '', maxTouchPoints: 0 };
    const fakeWindow = new EventTarget() as EventTarget & { matchMedia: () => { matches: boolean }; navigator: typeof fakeNavigator };
    fakeWindow.matchMedia = () => ({ matches: false });
    fakeWindow.navigator = fakeNavigator;
    vi.stubGlobal('window', fakeWindow);
    vi.stubGlobal('navigator', fakeNavigator);

    const initial = getInstallState();
    expect(getInstallState()).toBe(initial);
    let notifications = 0;
    const unsubscribe = subscribeInstall(() => { notifications += 1; });
    initializeInstallUX();
    expect(getInstallState()).toBe(initial);
    expect(notifications).toBe(0);

    const promptEvent = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
      prompt: vi.fn(async () => undefined),
      userChoice: Promise.resolve({ outcome: 'dismissed' as const, platform: 'test' }),
    });
    fakeWindow.dispatchEvent(promptEvent);
    const promptState = getInstallState();
    expect(promptState.canPrompt).toBe(true);
    expect(getInstallState()).toBe(promptState);
    expect(notifications).toBe(1);

    fakeWindow.dispatchEvent(Object.assign(new Event('beforeinstallprompt', { cancelable: true }), promptEvent));
    expect(getInstallState()).toBe(promptState);
    expect(notifications).toBe(1);

    await expect(consumeInstallPrompt()).resolves.toBe(false);
    const dismissedState = getInstallState();
    expect(dismissedState.canPrompt).toBe(false);
    expect(getInstallState()).toBe(dismissedState);
    expect(notifications).toBe(2);

    fakeWindow.dispatchEvent(new Event('appinstalled'));
    const installedState = getInstallState();
    expect(installedState.installed).toBe(true);
    expect(getInstallState()).toBe(installedState);
    expect(notifications).toBe(3);
    fakeWindow.dispatchEvent(new Event('appinstalled'));
    expect(getInstallState()).toBe(installedState);
    expect(notifications).toBe(3);

    unsubscribe();
    vi.unstubAllGlobals();
  });
});
