export type InstallPromptEvent = Event & {
  prompt: () => void | Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
};

export type InstallMode =
  | 'installed'
  | 'native-prompt-available'
  | 'ios-manual'
  | 'manual-browser'
  | 'prompting'
  | 'accepted'
  | 'dismissed'
  | 'error';

export type InstallState = Readonly<{
  mode: InstallMode;
  installed: boolean;
  canPrompt: boolean;
  showIosHelp: boolean;
}>;

const listeners = new Set<() => void>();
let deferredPrompt: InstallPromptEvent | undefined;
let installed = false;
let terminalMode: 'accepted' | 'dismissed' | 'error' | undefined;
let prompting = false;
let promptInFlight: Promise<boolean> | undefined;
let initializedWindow: Window | undefined;
let removeWindowListeners: (() => void) | undefined;

export const isStandalone = () => typeof window !== 'undefined' && (Boolean(window.matchMedia?.('(display-mode: standalone)').matches) || (window.navigator as Navigator & { standalone?: boolean }).standalone === true);
export const isIOS = () => typeof navigator !== 'undefined' && (/iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) && !isStandalone();

const notify = () => listeners.forEach((listener) => listener());
const createSnapshot = (mode: InstallMode): InstallState => Object.freeze({
  mode,
  installed: mode === 'installed',
  canPrompt: mode === 'native-prompt-available',
  showIosHelp: mode === 'ios-manual',
});
let snapshot: InstallState = createSnapshot('manual-browser');

const environmentMode = (): InstallMode => {
  if (installed || isStandalone()) return 'installed';
  if (prompting) return 'prompting';
  if (deferredPrompt) return 'native-prompt-available';
  if (terminalMode) return terminalMode;
  return isIOS() ? 'ios-manual' : 'manual-browser';
};

const updateSnapshot = () => {
  const next = createSnapshot(environmentMode());
  if (snapshot.mode === next.mode) return;
  snapshot = next;
  notify();
};

export const getInstallState = (): InstallState => snapshot;
export const shouldShowTopbarInstall = (state: InstallState) => state.mode === 'native-prompt-available' || state.mode === 'ios-manual' || state.mode === 'prompting';
export const topbarInstallSlot = (state: InstallState): 'cta' | 'placeholder' => shouldShowTopbarInstall(state) ? 'cta' : 'placeholder';

export function initializeInstallUX() {
  if (typeof window === 'undefined') return () => undefined;
  if (initializedWindow === window) return () => undefined;

  removeWindowListeners?.();
  const currentWindow = window;
  initializedWindow = currentWindow;
  deferredPrompt = undefined;
  terminalMode = undefined;
  prompting = false;
  installed = isStandalone();
  updateSnapshot();

  const beforeInstallPrompt = (event: Event) => {
    event.preventDefault();
    if (isIOS()) {
      updateSnapshot();
      return;
    }
    deferredPrompt = event as InstallPromptEvent;
    terminalMode = undefined;
    updateSnapshot();
  };
  const appInstalled = () => {
    installed = true;
    deferredPrompt = undefined;
    terminalMode = undefined;
    updateSnapshot();
  };
  currentWindow.addEventListener('beforeinstallprompt', beforeInstallPrompt);
  currentWindow.addEventListener('appinstalled', appInstalled);
  removeWindowListeners = () => {
    currentWindow.removeEventListener('beforeinstallprompt', beforeInstallPrompt);
    currentWindow.removeEventListener('appinstalled', appInstalled);
    if (initializedWindow === currentWindow) {
      initializedWindow = undefined;
      removeWindowListeners = undefined;
    }
  };
  return removeWindowListeners;
}

export const subscribeInstall = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export const consumeInstallPrompt = async () => {
  if (promptInFlight) return promptInFlight;
  if (!deferredPrompt) return false;

  const prompt = deferredPrompt;
  deferredPrompt = undefined;
  prompting = true;
  updateSnapshot();

  const result = (async () => {
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      if (choice.outcome === 'accepted') {
        terminalMode = 'accepted';
        return true;
      }
      terminalMode = 'dismissed';
      return false;
    } catch {
      terminalMode = 'error';
      return false;
    } finally {
      prompting = false;
      promptInFlight = undefined;
      updateSnapshot();
    }
  })();
  promptInFlight = result;
  return result;
};
