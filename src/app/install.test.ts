import { afterEach, describe, expect, it, vi } from 'vitest';
import { consumeInstallPrompt, getInstallState, initializeInstallUX, isIOS, isStandalone, shouldShowTopbarInstall, subscribeInstall, topbarInstallSlot } from './install';

type FakeNavigator = { userAgent: string; platform: string; maxTouchPoints: number; standalone?: boolean };

function setupBrowser(navigatorOverrides: Partial<FakeNavigator> = {}) {
  const fakeNavigator: FakeNavigator = { userAgent: '', platform: '', maxTouchPoints: 0, ...navigatorOverrides };
  const fakeWindow = new EventTarget() as EventTarget & { matchMedia: () => { matches: boolean }; navigator: FakeNavigator };
  fakeWindow.matchMedia = () => ({ matches: false });
  fakeWindow.navigator = fakeNavigator;
  vi.stubGlobal('window', fakeWindow);
  vi.stubGlobal('navigator', fakeNavigator);
  initializeInstallUX();
  return { fakeWindow, fakeNavigator };
}

function promptEvent(outcome: 'accepted' | 'dismissed', prompt = vi.fn(async () => undefined)) {
  return Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
    prompt,
    userChoice: Promise.resolve({ outcome, platform: 'test' }),
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('install helpers', () => {
  it('are safe when browser display APIs are unavailable', () => {
    expect(isStandalone()).toBe(false);
    expect(isIOS()).toBe(false);
  });

  it('detects iOS manual installation and unsupported browser modes', () => {
    setupBrowser({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' });
    expect(getInstallState().mode).toBe('ios-manual');
    expect(getInstallState().showIosHelp).toBe(true);
    expect(shouldShowTopbarInstall(getInstallState())).toBe(true);

    setupBrowser({ platform: 'MacIntel', maxTouchPoints: 5 });
    expect(getInstallState().mode).toBe('ios-manual');

    setupBrowser({ standalone: true });
    expect(getInstallState().mode).toBe('installed');
    expect(shouldShowTopbarInstall(getInstallState())).toBe(false);

    setupBrowser();
    expect(getInstallState().mode).toBe('manual-browser');
    expect(getInstallState().canPrompt).toBe(false);
    expect(shouldShowTopbarInstall(getInstallState())).toBe(false);
    expect(topbarInstallSlot(getInstallState())).toBe('placeholder');
  });

  it('keeps stable snapshots and only notifies for real transitions', async () => {
    const { fakeWindow } = setupBrowser();
    const initial = getInstallState();
    expect(getInstallState()).toBe(initial);
    let notifications = 0;
    const unsubscribe = subscribeInstall(() => { notifications += 1; });

    const prompt = vi.fn(async () => undefined);
    const event = promptEvent('dismissed', prompt);
    fakeWindow.dispatchEvent(event);
    const available = getInstallState();
    expect(available.mode).toBe('native-prompt-available');
    expect(topbarInstallSlot(available)).toBe('cta');
    expect(getInstallState()).toBe(available);
    expect(notifications).toBe(1);

    fakeWindow.dispatchEvent(event);
    expect(getInstallState()).toBe(available);
    expect(notifications).toBe(1);

    const consuming = consumeInstallPrompt();
    expect(getInstallState().mode).toBe('prompting');
    await consuming;
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(getInstallState().mode).toBe('dismissed');
    expect(notifications).toBe(3); // available -> prompting -> dismissed
    unsubscribe();
  });

  it('invokes the native prompt once and waits for appinstalled after acceptance', async () => {
    const { fakeWindow } = setupBrowser();
    const prompt = vi.fn(async () => undefined);
    fakeWindow.dispatchEvent(promptEvent('accepted', prompt));

    await expect(consumeInstallPrompt()).resolves.toBe(true);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(getInstallState().mode).toBe('accepted');
    expect(getInstallState().installed).toBe(false);
    expect(topbarInstallSlot(getInstallState())).toBe('placeholder');
    await expect(consumeInstallPrompt()).resolves.toBe(false);
    expect(prompt).toHaveBeenCalledTimes(1);

    fakeWindow.dispatchEvent(promptEvent('dismissed'));
    expect(getInstallState().mode).toBe('native-prompt-available');
    fakeWindow.dispatchEvent(new Event('appinstalled'));
    expect(getInstallState().mode).toBe('installed');
    expect(getInstallState().installed).toBe(true);
  });

  it('transitions a rejected native prompt to error without retrying automatically', async () => {
    const { fakeWindow } = setupBrowser();
    const prompt = vi.fn(async () => { throw new Error('prompt failed'); });
    fakeWindow.dispatchEvent(promptEvent('accepted', prompt));

    await expect(consumeInstallPrompt()).resolves.toBe(false);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(getInstallState().mode).toBe('error');
    await expect(consumeInstallPrompt()).resolves.toBe(false);
    expect(prompt).toHaveBeenCalledTimes(1);

    fakeWindow.dispatchEvent(promptEvent('accepted', prompt));
    expect(getInstallState().mode).toBe('native-prompt-available');
  });

  it('allows a later beforeinstallprompt event after dismissal', async () => {
    const { fakeWindow } = setupBrowser();
    fakeWindow.dispatchEvent(promptEvent('dismissed'));
    await consumeInstallPrompt();
    expect(getInstallState().mode).toBe('dismissed');

    fakeWindow.dispatchEvent(promptEvent('accepted'));
    expect(getInstallState().mode).toBe('native-prompt-available');
  });
});
