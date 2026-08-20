export type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
};

export type InstallState = Readonly<{ installed: boolean; canPrompt: boolean; showIosHelp: boolean }>;
const listeners = new Set<() => void>();
let deferredPrompt: InstallPromptEvent | undefined;
let installed = false;
let initialized = false;

export const isStandalone = () => typeof window !== 'undefined' && (Boolean(window.matchMedia?.('(display-mode: standalone)').matches) || (window.navigator as Navigator & { standalone?: boolean }).standalone === true);
export const isIOS = () => typeof navigator !== 'undefined' && (/iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) && !isStandalone();
const notify = () => listeners.forEach((listener) => listener());
const createSnapshot = (nextInstalled: boolean, canPrompt: boolean, showIosHelp: boolean): InstallState => Object.freeze({ installed: nextInstalled, canPrompt, showIosHelp });
let snapshot: InstallState = createSnapshot(false, false, false);

const updateSnapshot = () => {
  const nextInstalled = installed || isStandalone();
  installed = nextInstalled;
  const next = createSnapshot(nextInstalled, Boolean(deferredPrompt), !nextInstalled && !deferredPrompt && isIOS());
  if (snapshot.installed === next.installed && snapshot.canPrompt === next.canPrompt && snapshot.showIosHelp === next.showIosHelp) return;
  snapshot = next;
  notify();
};

export const getInstallState = (): InstallState => snapshot;

export function initializeInstallUX() {
  if (typeof window === 'undefined') return () => undefined;
  if (initialized) return () => undefined;
  initialized = true;
  installed = isStandalone();
  updateSnapshot();
  const beforeInstallPrompt = (event: Event) => { event.preventDefault(); deferredPrompt = event as InstallPromptEvent; updateSnapshot(); };
  const appInstalled = () => { installed = true; deferredPrompt = undefined; updateSnapshot(); };
  window.addEventListener('beforeinstallprompt', beforeInstallPrompt);
  window.addEventListener('appinstalled', appInstalled);
  return () => { window.removeEventListener('beforeinstallprompt', beforeInstallPrompt); window.removeEventListener('appinstalled', appInstalled); };
}

export const subscribeInstall = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const consumeInstallPrompt = async () => {
  if (!deferredPrompt) return false;
  const prompt = deferredPrompt;
  try { await prompt.prompt(); const choice = await prompt.userChoice; return choice.outcome === 'accepted'; }
  catch { return false; }
  finally { deferredPrompt = undefined; updateSnapshot(); }
};
