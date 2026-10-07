// Faithful minimal page-side update adapter from 53bda1d (pre reliable-update
// protocol): explicit action, 250ms form blur guard, local mutation guard, and
// requester-only guarded controllerchange reload. No persistent draft barrier.
export function legacyUpdates(registration: ServiceWorkerRegistration, busy: () => boolean) {
  let requested = false;
  let recentForm: Element | null = null;
  let timer: ReturnType<typeof setTimeout>;
  const safe = () => !busy() && !recentForm && !document.activeElement?.closest('form');
  document.addEventListener('focusin', (event) => {
    const form = (event.target as Element).closest('form');
    if (form) { clearTimeout(timer); recentForm = form; }
  });
  document.addEventListener('focusout', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { if (!document.activeElement?.closest('form')) recentForm = null; }, 250);
  });
  document.addEventListener('submit', () => { clearTimeout(timer); recentForm = null; });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!requested) return;
    requested = false;
    if (safe()) location.reload();
  });
  return {
    check: () => registration.update(),
    apply: () => {
      if (!registration.waiting || !safe()) return false;
      requested = true;
      registration.waiting.postMessage({ type: 'SKIP_WAITING' });
      return true;
    },
    state: () => ({ updateReady: Boolean(registration.waiting) }),
  };
}
