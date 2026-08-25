/**
 * This value is deliberately not private storage.  It is a small, persistent
 * coordination barrier: every tab must observe a logout before it is allowed
 * to commit a response to a private IndexedDB store.
 */
export const SESSION_GENERATION_KEY = 'billsplit-session-generation';
export const SESSION_LOGOUT_KEY = 'billsplit-logout-in-progress';
export const SESSION_CHANNEL = 'billsplit-auth';
const SESSION_COORDINATION_KEY = 'billsplit-auth-coordination';
const SESSION_AUTH_INVALIDATION_KEY = 'billsplit-auth-invalidation';

export type SessionCoordinationMessage = {
  type: 'logout-start' | 'logout-clear' | 'logout-rollback' | 'auth-invalidation' | 'account-deletion' | 'cache-clear';
  generation: number;
  reason?: 'account-switch' | 'account-deletion' | 'cache-clear';
  userId?: string;
  clerkUserId?: string;
  previousClerkUserId?: string;
  clearOutbox?: boolean;
  phase?: string;
  nonce?: string;
};
type SessionMessage = SessionCoordinationMessage & { owner?: string };
type SessionListener = (generation: number) => void;
type CoordinationListener = (message: SessionCoordinationMessage) => void;

const listeners = new Set<SessionListener>();
const coordinationListeners = new Set<() => void>();
const messageListeners = new Set<CoordinationListener>();
let generation = 0;
let logoutInProgress = false;
let logoutWasAdopted = false;
let locallyStartedLogoutGeneration: number | undefined;
let localCleanupGeneration: number | undefined;
let deferredLogoutClearGeneration: number | undefined;
let channel: BroadcastChannel | undefined;
const owner = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `tab-${Date.now()}-${Math.random()}`;
const processedCoordinationNonces = new Set<string>();
let latestAuthInvalidation: SessionMessage | undefined;
const pendingCoordinationMessages = new Map<string, SessionCoordinationMessage>();

const rememberAuthInvalidation = (message: SessionMessage) => {
  if (message.type === 'auth-invalidation' && message.reason === 'account-switch') latestAuthInvalidation = message;
};
const markCoordinationNonceProcessed = (nonce: string) => {
  processedCoordinationNonces.add(nonce);
  if (processedCoordinationNonces.size > 256) {
    const oldest = processedCoordinationNonces.values().next().value;
    if (oldest) processedCoordinationNonces.delete(oldest);
  }
};

const acceptCoordinationMessage = (message: SessionMessage) => {
  if (!message.nonce || message.owner === owner || processedCoordinationNonces.has(message.nonce)) return false;
  markCoordinationNonceProcessed(message.nonce);
  rememberAuthInvalidation(message);
  return true;
};

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
const notifyMessage = (message: SessionCoordinationMessage) => {
  if (!messageListeners.size && message.nonce) pendingCoordinationMessages.set(message.nonce, message);
  else messageListeners.forEach((listener) => listener(message));
};
const reconcileStoredCoordination = () => {
  if (typeof localStorage === 'undefined') return;
  for (const key of [SESSION_COORDINATION_KEY, SESSION_AUTH_INVALIDATION_KEY]) {
    try {
      const message = JSON.parse(localStorage.getItem(key) || 'null') as SessionMessage | null;
      if (!message || !acceptCoordinationMessage(message)) continue;
      if (message.type !== 'logout-start' && message.type !== 'logout-clear' && message.type !== 'logout-rollback') notifyMessage(message);
    } catch { /* Ignore malformed or unavailable coordination storage. */ }
  }
};

/** Hydrate both barriers before authentication or private resources are started. */
export const hydrateSessionCoordination = () => {
  const storedGeneration = readStoredGeneration();
  if (storedGeneration > generation) generation = storedGeneration;
  if (storedGeneration > (locallyStartedLogoutGeneration ?? -1)) locallyStartedLogoutGeneration = undefined;
  const storedLogout = readStoredLogout();
  if (storedLogout !== logoutInProgress) {
    logoutInProgress = storedLogout;
    notifyCoordination();
  }
  if (storedLogout && generation !== locallyStartedLogoutGeneration && !logoutWasAdopted) {
    locallyStartedLogoutGeneration = undefined;
    logoutWasAdopted = true;
    listeners.forEach((listener) => listener(generation));
  }
  reconcileStoredCoordination();
  return { generation, logoutInProgress };
};

const notifyExternalGeneration = (next: number) => {
  if (!Number.isSafeInteger(next) || next < 0) return;
  const changed = next > generation || !logoutInProgress;
  if (!changed) return;
  if (next > generation) generation = next;
  if (locallyStartedLogoutGeneration !== next) locallyStartedLogoutGeneration = undefined;
  logoutWasAdopted = true;
  logoutInProgress = true;
  notifyCoordination();
  listeners.forEach((listener) => listener(generation));
};

const post = (message: SessionMessage) => {
  try { channel?.postMessage({ ...message, owner }); } catch { /* BroadcastChannel is an optional enhancement. */ }
};

const postCoordination = (message: SessionCoordinationMessage) => {
  const nextMessage = { ...message, owner, nonce: message.nonce || `${Date.now()}:${Math.random()}` };
  rememberAuthInvalidation(nextMessage);
  acceptCoordinationMessage(nextMessage);
  post(nextMessage);
  if (typeof localStorage !== 'undefined' && nextMessage.type === 'auth-invalidation' && nextMessage.reason === 'account-switch') {
    try { localStorage.setItem(SESSION_AUTH_INVALIDATION_KEY, JSON.stringify(nextMessage)); }
    catch { /* BroadcastChannel remains the best-effort immediate path. */ }
  }
  // Do not make a destructive marker write depend on the best-effort storage
  // fallback. BroadcastChannel is immediate; localStorage is the suspended-tab
  // replay and may be unavailable or throw synchronously in test/webview
  // storage shims.
  if (typeof localStorage !== 'undefined') setTimeout(() => {
    try {
      localStorage.setItem(SESSION_COORDINATION_KEY, JSON.stringify(nextMessage));
      if (nextMessage.type === 'auth-invalidation' && nextMessage.reason === 'account-switch') localStorage.setItem(SESSION_AUTH_INVALIDATION_KEY, JSON.stringify(nextMessage));
    }
    catch { /* BroadcastChannel or the in-memory tab remains the fallback. */ }
  });
};

export const broadcastSessionCoordination = (message: Omit<SessionCoordinationMessage, 'generation'> & { generation?: number }) => {
  postCoordination({ ...message, generation: message.generation ?? getSessionGeneration() });
};

const initialize = () => {
  hydrateSessionCoordination();
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return;
  try {
    channel = new BroadcastChannel(SESSION_CHANNEL);
    channel.addEventListener('message', (event: MessageEvent<SessionMessage>) => {
      if (!event.data || !acceptCoordinationMessage(event.data)) return;
      if (event.data.type === 'logout-start') notifyExternalGeneration(event.data.generation);
       if ((event.data.type === 'logout-clear' || event.data.type === 'logout-rollback') && event.data.generation === generation) {
         finishSessionLogoutWithCoordination(false, generation, false, true);
       }
      if (event.data.type !== 'logout-start' && event.data.type !== 'logout-clear' && event.data.type !== 'logout-rollback') notifyMessage(event.data);
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
       if (event.newValue === null) finishSessionLogoutWithCoordination(false, generation, false, true);
      else notifyExternalGeneration(Number(event.newValue) || generation);
    }
    if (event.key === SESSION_COORDINATION_KEY && event.newValue) {
      try {
        const message = JSON.parse(event.newValue) as SessionMessage;
        if (acceptCoordinationMessage(message) && message.type !== 'logout-start' && message.type !== 'logout-clear' && message.type !== 'logout-rollback') notifyMessage(message);
      } catch { /* Ignore malformed cross-tab hints. */ }
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

export const getSessionLogoutInProgress = () => hydrateSessionCoordination().logoutInProgress || localCleanupGeneration !== undefined;
export const beginLocalLogoutCleanup = (expectedGeneration: number) => {
  hydrateSessionCoordination();
  if (generation !== expectedGeneration) return false;
  localCleanupGeneration = expectedGeneration;
  return true;
};
export const completeLocalLogoutCleanup = (expectedGeneration: number) => {
  if (localCleanupGeneration !== expectedGeneration) return false;
  localCleanupGeneration = undefined;
  if (deferredLogoutClearGeneration === expectedGeneration) {
    deferredLogoutClearGeneration = undefined;
    return finishSessionLogoutWithCoordination(false, expectedGeneration, true, true);
  }
  return true;
};
export const cancelLocalLogoutCleanup = (expectedGeneration: number) => {
  if (localCleanupGeneration !== expectedGeneration) return false;
  localCleanupGeneration = undefined;
  return true;
};
export const isSessionLogoutAdopted = () => { hydrateSessionCoordination(); return logoutWasAdopted; };
export const getLocallyOwnedLogoutGeneration = () => {
  hydrateSessionCoordination();
  return logoutInProgress && !logoutWasAdopted ? locallyStartedLogoutGeneration : undefined;
};

const readLatestAuthInvalidation = () => {
  let latest = latestAuthInvalidation;
  if (typeof localStorage !== 'undefined') {
    try {
      const stored = JSON.parse(localStorage.getItem(SESSION_AUTH_INVALIDATION_KEY) || 'null') as SessionMessage | null;
      if (stored?.type === 'auth-invalidation' && stored.reason === 'account-switch') latest = stored;
    } catch { /* Ignore unavailable coordination storage. */ }
  }
  return latest;
};

/** Capture the shared invalidation baseline before an authoritative probe. */
export const captureAuthInvalidationNonce = () => readLatestAuthInvalidation()?.nonce;
/** Consume only the baseline which was captured before the authoritative commit. */
export const consumeAuthInvalidationNonce = (nonce: string | undefined) => {
  if (!nonce) return;
  markCoordinationNonceProcessed(nonce);
  if (latestAuthInvalidation?.nonce !== nonce || typeof localStorage === 'undefined') return;
  latestAuthInvalidation = undefined;
  try {
    const storedInvalidation = JSON.parse(localStorage.getItem(SESSION_AUTH_INVALIDATION_KEY) || 'null') as SessionMessage | null;
    if (storedInvalidation?.nonce === nonce) localStorage.removeItem(SESSION_AUTH_INVALIDATION_KEY);
    const storedCoordination = JSON.parse(localStorage.getItem(SESSION_COORDINATION_KEY) || 'null') as SessionMessage | null;
    if (storedCoordination?.type === 'auth-invalidation' && storedCoordination.nonce === nonce) localStorage.removeItem(SESSION_COORDINATION_KEY);
  } catch { /* The in-memory nonce is still consumed for this tab. */ }
};

/** Advance the barrier before stopping sync and clearing private data. */
export function startSessionLogout(broadcast = true) {
  const next = Math.max(getSessionGeneration() + 1, 1);
  generation = next;
  logoutInProgress = true;
  logoutWasAdopted = false;
  locallyStartedLogoutGeneration = next;
  try { localStorage.setItem(SESSION_GENERATION_KEY, String(next)); } catch { /* The in-memory barrier still protects this tab. */ }
  try { localStorage.setItem(SESSION_LOGOUT_KEY, String(next)); } catch { /* The in-memory barrier still protects this tab. */ }
  notifyCoordination();
  listeners.forEach((listener) => listener(generation));
  if (broadcast) postCoordination({ type: 'logout-start', generation: next });
  return next;
}

export const subscribeSessionLogout = (listener: SessionListener) => {
  listeners.add(listener);
  if (logoutInProgress) listener(generation);
  return () => listeners.delete(listener);
};

export const subscribeSessionState = (listener: () => void) => {
  coordinationListeners.add(listener);
  return () => coordinationListeners.delete(listener);
};

function finishSessionLogout(broadcast: boolean, expectedGeneration: number, force = false) {
  return finishSessionLogoutWithCoordination(broadcast, expectedGeneration, force, false);
}
function finishSessionLogoutWithCoordination(broadcast: boolean, expectedGeneration: number, force = false, fromCoordination = false) {
  if (getSessionGeneration() !== expectedGeneration) return false;
  if (localCleanupGeneration === expectedGeneration && !force) {
    deferredLogoutClearGeneration = expectedGeneration;
    return false;
  }
  if (logoutWasAdopted && !force && !fromCoordination) return false;
  try { localStorage.removeItem(SESSION_LOGOUT_KEY); }
  catch {
    try { localStorage.setItem(SESSION_LOGOUT_KEY, '0'); } catch { /* Memory still reflects the authoritative result. */ }
  }
  logoutInProgress = false;
  logoutWasAdopted = false;
  locallyStartedLogoutGeneration = undefined;
  localCleanupGeneration = undefined;
  deferredLogoutClearGeneration = undefined;
  notifyCoordination();
  if (broadcast) postCoordination({ type: 'logout-clear', generation: expectedGeneration });
  return true;
}

/** Clear the barrier only after a fresh, authoritative /api/me response. */
export const clearSessionLogout = (expectedGeneration = getSessionGeneration(), broadcast = true, force = false) => finishSessionLogout(broadcast, expectedGeneration, force);

/** Roll back a started logout when local destructive cleanup failed before Clerk navigation. */
export const rollbackSessionLogout = (expectedGeneration: number, broadcast = true) => {
  if (getLocallyOwnedLogoutGeneration() !== expectedGeneration) return false;
  const cleared = finishSessionLogout(false, expectedGeneration);
  if (cleared && broadcast) postCoordination({ type: 'logout-rollback', generation: expectedGeneration });
  if (cleared) deferredLogoutClearGeneration = undefined;
  return cleared;
};

/** Used by a tab that received the barrier through an external channel. */
export const adoptSessionGeneration = (next: number) => notifyExternalGeneration(next);

export const subscribeSessionCoordination = (listener: CoordinationListener) => {
  messageListeners.add(listener);
  if (pendingCoordinationMessages.size) {
    const pending = [...pendingCoordinationMessages.values()];
    pendingCoordinationMessages.clear();
    pending.forEach((message) => listener(message));
  }
  return () => messageListeners.delete(listener);
};

export class SessionGenerationMismatchError extends Error {
  constructor() {
    super('The local session changed before private data could be cached.');
    this.name = 'SessionGenerationMismatchError';
  }
}

export function assertSessionGeneration(captured: number) {
  if (!isSessionGenerationCurrent(captured)) throw new SessionGenerationMismatchError();
}
