const badgeValue = (value: number) => Math.min(99, Math.max(1, Math.floor(value)));

export function setNotificationBadge(value: number) {
  if (typeof navigator === 'undefined') return false;
  const setter = (navigator as Navigator & { setAppBadge?: (value?: number) => Promise<void> }).setAppBadge;
  if (typeof setter !== 'function') return false;
  try { void setter.call(navigator, badgeValue(value)).catch(() => undefined); return true; }
  catch { return false; }
}

export function clearNotificationBadge() {
  if (typeof navigator === 'undefined') return false;
  const clearer = (navigator as Navigator & { clearAppBadge?: () => Promise<void> }).clearAppBadge;
  if (typeof clearer === 'function') {
    try { void clearer.call(navigator).catch(() => undefined); } catch { /* Optional API. */ }
  }
  const worker = navigator.serviceWorker;
  try {
    if (worker?.controller) worker.controller.postMessage({ type: 'CLEAR_NOTIFICATION_BADGE' });
    else if (worker) void worker.ready.then((registration) => registration.active?.postMessage({ type: 'CLEAR_NOTIFICATION_BADGE' })).catch(() => undefined);
  } catch { /* Worker may not be active yet. */ }
  return typeof clearer === 'function';
}
