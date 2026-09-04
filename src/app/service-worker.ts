import { hasActiveMutations } from './mutation-quiescence';

export type ServiceWorkerUpdateState = Readonly<{
  updateReady: boolean;
  applying: boolean;
  blocked: boolean;
}>;

const initialState: ServiceWorkerUpdateState = Object.freeze({ updateReady: false, applying: false, blocked: false });
let state = initialState;
let registration: ServiceWorkerRegistration | undefined;
let reloadAfterControllerChange = false;
let recentlyActiveForm: HTMLFormElement | undefined;
let formActivityTimer: ReturnType<typeof setTimeout> | undefined;
let trackedDocument: Document | undefined;
const listeners = new Set<() => void>();

const notify = () => listeners.forEach((listener) => listener());
const setState = (next: ServiceWorkerUpdateState) => {
  if (state.updateReady === next.updateReady && state.applying === next.applying && state.blocked === next.blocked) return;
  state = Object.freeze(next);
  notify();
};

/** An editing control is enough reason to leave a waiting worker alone. */
export const hasActiveForm = () => {
  if (typeof document === 'undefined') return false;
  const active = document.activeElement as Element | null;
  return Boolean(active?.closest?.('form') || recentlyActiveForm);
};

export const canApplyServiceWorkerUpdate = () => !hasActiveMutations() && !hasActiveForm();
export const getServiceWorkerUpdateState = () => state;
export const subscribeServiceWorkerUpdate = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

const onControllerChange = () => {
  if (!reloadAfterControllerChange) return;
  reloadAfterControllerChange = false;
  if (!canApplyServiceWorkerUpdate()) {
    setState({ updateReady: false, applying: false, blocked: true });
    return;
  }
  window.location.reload();
};

const trackFormActivity = () => {
  if (typeof document === 'undefined' || trackedDocument === document || typeof document.addEventListener !== 'function') return;
  trackedDocument = document;
  document.addEventListener('focusin', (event) => {
    const form = (event.target as Element | null)?.closest?.('form') as HTMLFormElement | null;
    if (!form) return;
    if (formActivityTimer) clearTimeout(formActivityTimer);
    recentlyActiveForm = form;
  });
  document.addEventListener('focusout', () => {
    if (formActivityTimer) clearTimeout(formActivityTimer);
    // Keep the form protected through the click that caused the blur. This
    // prevents an Update button from making a focused edit look quiescent.
    formActivityTimer = setTimeout(() => {
      const active = document.activeElement as Element | null;
      if (!active?.closest?.('form')) recentlyActiveForm = undefined;
      formActivityTimer = undefined;
    }, 250);
  });
  document.addEventListener('submit', () => {
    if (formActivityTimer) clearTimeout(formActivityTimer);
    recentlyActiveForm = undefined;
    formActivityTimer = undefined;
  });
};

/** Attach the page-side lifecycle to a successfully registered worker. */
export function observeServiceWorkerRegistration(next: ServiceWorkerRegistration) {
  registration = next;
  trackFormActivity();
  if (next.waiting) setState({ updateReady: true, applying: false, blocked: false });

  next.addEventListener('updatefound', () => {
    const installing = next.installing;
    if (!installing) return;
    installing.addEventListener('statechange', () => {
      if (installing.state === 'installed' && navigator.serviceWorker.controller) {
        setState({ updateReady: true, applying: false, blocked: false });
      }
    });
  });
  navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
}

/** Apply only from an explicit user action, after the page is quiescent. */
export function applyServiceWorkerUpdate() {
  const waiting = registration?.waiting;
  if (!waiting) {
    // If activation won a race with a new mutation, the new controller is
    // already installed. Keep the explicit action available for a later,
    // safe reload rather than leaving the page on the old code indefinitely.
    if (!state.blocked || !canApplyServiceWorkerUpdate()) return false;
    window.location.reload();
    return true;
  }
  if (!canApplyServiceWorkerUpdate()) {
    setState({ updateReady: true, applying: false, blocked: true });
    return false;
  }
  reloadAfterControllerChange = true;
  setState({ updateReady: true, applying: true, blocked: false });
  try {
    waiting.postMessage({ type: 'SKIP_WAITING' });
    return true;
  } catch {
    reloadAfterControllerChange = false;
    setState({ updateReady: true, applying: false, blocked: true });
    return false;
  }
}
