import { APPLICATION_SESSION_ACTIVITY_THROTTLE_MS } from '../shared/session-policy';

export const SESSION_ACTIVITY_STORAGE_KEY = 'billsplit-last-session-activity';

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type EventTargetLike = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

export type SessionActivitySchedulerOptions = {
  isAuthenticated: () => boolean;
  isOnline: () => boolean;
  isVisible: () => boolean;
  renew: () => Promise<unknown>;
  windowTarget?: EventTargetLike;
  documentTarget?: EventTargetLike;
  storage?: StorageLike;
  now?: () => number;
  isTrusted?: (event: Event) => boolean;
};

/**
 * Renewal is an explicit foreground activity signal, not a side effect of
 * resource traffic. There is no interval: a visible opening and trusted user
 * input are the only events which can request a renewal.
 */
export function createSessionActivityScheduler(options: SessionActivitySchedulerOptions) {
  const now = options.now || (() => Date.now());
  const storage = options.storage || (typeof localStorage === 'undefined' ? undefined : localStorage);
  const windowTarget = options.windowTarget || (typeof window === 'undefined' ? undefined : window);
  const documentTarget = options.documentTarget || (typeof document === 'undefined' ? undefined : document);
  let requestInFlight = false;
  let disposed = false;

  const request = () => {
    if (disposed || requestInFlight || !options.isAuthenticated() || !options.isOnline() || !options.isVisible()) return;
    const timestamp = now();
    let previous = 0;
    try { previous = Number(storage?.getItem(SESSION_ACTIVITY_STORAGE_KEY) || 0); } catch { /* Storage is optional. */ }
    if (Number.isFinite(previous) && timestamp - previous < APPLICATION_SESSION_ACTIVITY_THROTTLE_MS) return;
    try { storage?.setItem(SESSION_ACTIVITY_STORAGE_KEY, String(timestamp)); } catch { /* The server throttle remains authoritative. */ }
    requestInFlight = true;
    void options.renew().catch(() => {
      try {
        // Do not erase a newer tab's successful activity marker.
        if (storage?.getItem(SESSION_ACTIVITY_STORAGE_KEY) === String(timestamp)) storage.removeItem(SESSION_ACTIVITY_STORAGE_KEY);
      } catch { /* Retry on the next explicit foreground signal. */ }
    }).finally(() => { requestInFlight = false; });
  };

  const onVisibleOpening = () => { if (options.isVisible()) request(); };
  const onInteraction = (event: Event) => {
    if ((options.isTrusted || ((current) => current.isTrusted))(event)) request();
  };

  documentTarget?.addEventListener('visibilitychange', onVisibleOpening);
  windowTarget?.addEventListener('pageshow', onVisibleOpening);
  windowTarget?.addEventListener('focus', onVisibleOpening);
  windowTarget?.addEventListener('pointerdown', onInteraction);
  windowTarget?.addEventListener('touchstart', onInteraction);
  windowTarget?.addEventListener('keydown', onInteraction);
  request();

  return {
    request,
    dispose: () => {
      disposed = true;
      documentTarget?.removeEventListener('visibilitychange', onVisibleOpening);
      windowTarget?.removeEventListener('pageshow', onVisibleOpening);
      windowTarget?.removeEventListener('focus', onVisibleOpening);
      windowTarget?.removeEventListener('pointerdown', onInteraction);
      windowTarget?.removeEventListener('touchstart', onInteraction);
      windowTarget?.removeEventListener('keydown', onInteraction);
    },
  };
}
