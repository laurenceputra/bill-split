/**
 * This value is deliberately not private storage.  It is a small, persistent
 * coordination barrier: every tab must observe a logout before it is allowed
 * to commit a response to a private IndexedDB store.
 */
export const SESSION_GENERATION_KEY = 'billsplit-session-generation';
export const SESSION_LOGOUT_KEY = 'billsplit-logout-in-progress';
export const SESSION_CHANNEL = 'billsplit-auth';

type SessionMessage = { type: 'logout-start' | 'logout-clear' | 'logout-rollback'; generation: number };
type SessionListener = (generation: number) => void;

const listeners = new Set<SessionListener>();
const coordinationListeners = new Set<() => void>();
let generation = 0;
let logoutInProgress = false;
let channel: BroadcastChannel | undefined;

const readStoredGeneration = () => {
  if (typeof localStorage === 'undefined') return generation;
  try {
    const value = Number(localStorage.getItem(SESSION_GENERATION_KEY));
    return Number.isSafeInteger(value) && value >= 0 ? value : generation;
  } catch {
    return generation;
  }
};

const readStoredLogout = () => {
  if (typeof localStorage === 'undefined') return logoutInProgress;
  try { return localStorage.getItem(SESSION_LOGOUT_KEY) !== null && localStorage.getItem(SESSION_LOGOUT_KEY) !== '0'; }
  catch { return logoutInProgress; }
};

const notifyCoordination = () => coordinationListeners.forEach((listener) => listener());

/** Hydrate both barriers before authentication or private resources are started. */
export const hydrateSessionCoordination = () => {
  const storedGeneration = readStoredGeneration();
  if (storedGeneration > generation) generation = storedGeneration;
  const storedLogout = readStoredLogout();
  if (storedLogout !== logoutInProgress) {
    logoutInProgress = storedLogout;
    notifyCoordination();
  }
  return { generation, logoutInProgress };
};

const notifyExternalGeneration = (next: number) => {
  if (!Number.isSafeInteger(next) || next < 0) return;
  const changed = next > generation || !logoutInProgress;
  if (!changed) return;
  if (next > generation) generation = next;
  logoutInProgress = true;
  notifyCoordination();
  listeners.forEach((listener) => listener(generation));
};

const post = (message: SessionMessage) => {
  try { channel?.postMessage(message); } catch { /* BroadcastChannel is an optional enhancement. */ }
};

const initialize = () => {
  hydrateSessionCoordination();
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return;
  try {
    channel = new BroadcastChannel(SESSION_CHANNEL);
    channel.addEventListener('message', (event: MessageEvent<SessionMessage>) => {
      if (event.data?.type === 'logout-start') notifyExternalGeneration(event.data.generation);
      if ((event.data?.type === 'logout-clear' || event.data?.type === 'logout-rollback') && event.data.generation === generation) finishSessionLogout(false, generation);
    });
  } catch { /* localStorage is the fallback below. */ }
};

initialize();

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === SESSION_GENERATION_KEY && event.newValue) {
      const next = Number(event.newValue);
      notifyExternalGeneration(next);
    }
    if (event.key === SESSION_LOGOUT_KEY) {
      if (event.newValue === null) finishSessionLogout(false, generation);
      else notifyExternalGeneration(Number(event.newValue) || generation);
    }
  });
}

/** Read the latest shared value before starting or committing private work. */
export const getSessionGeneration = () => {
  hydrateSessionCoordination();
  return generation;
};

export const captureSessionGeneration = () => getSessionGeneration();

export const isSessionGenerationCurrent = (captured: number) => getSessionGeneration() === captured;

export const getSessionLogoutInProgress = () => hydrateSessionCoordination().logoutInProgress;

/** Advance the barrier before stopping sync and clearing private data. */
export function startSessionLogout(broadcast = true) {
  const next = Math.max(getSessionGeneration() + 1, 1);
  generation = next;
  logoutInProgress = true;
  try { localStorage.setItem(SESSION_GENERATION_KEY, String(next)); } catch { /* The in-memory barrier still protects this tab. */ }
  try { localStorage.setItem(SESSION_LOGOUT_KEY, String(next)); } catch { /* The in-memory barrier still protects this tab. */ }
  notifyCoordination();
  listeners.forEach((listener) => listener(generation));
  if (broadcast) post({ type: 'logout-start', generation: next });
  return next;
}

export const subscribeSessionLogout = (listener: SessionListener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const subscribeSessionState = (listener: () => void) => {
  coordinationListeners.add(listener);
  return () => coordinationListeners.delete(listener);
};

function finishSessionLogout(broadcast: boolean, expectedGeneration: number) {
  if (getSessionGeneration() !== expectedGeneration) return false;
  try { localStorage.removeItem(SESSION_LOGOUT_KEY); }
  catch {
    try { localStorage.setItem(SESSION_LOGOUT_KEY, '0'); } catch { /* Memory still reflects the authoritative result. */ }
  }
  logoutInProgress = false;
  notifyCoordination();
  if (broadcast) post({ type: 'logout-clear', generation: expectedGeneration });
  return true;
}

/** Clear the barrier only after a fresh, authoritative /api/me response. */
export const clearSessionLogout = (expectedGeneration = getSessionGeneration(), broadcast = true) => finishSessionLogout(broadcast, expectedGeneration);

/** Roll back a started logout when local destructive cleanup failed before Access navigation. */
export const rollbackSessionLogout = (expectedGeneration: number, broadcast = true) => {
  const cleared = finishSessionLogout(false, expectedGeneration);
  if (cleared && broadcast) post({ type: 'logout-rollback', generation: expectedGeneration });
  return cleared;
};

/** Used by a tab that received the barrier through an external channel. */
export const adoptSessionGeneration = (next: number) => notifyExternalGeneration(next);

export class SessionGenerationMismatchError extends Error {
  constructor() {
    super('The local session changed before private data could be cached.');
    this.name = 'SessionGenerationMismatchError';
  }
}

export function assertSessionGeneration(captured: number) {
  if (!isSessionGenerationCurrent(captured)) throw new SessionGenerationMismatchError();
}
