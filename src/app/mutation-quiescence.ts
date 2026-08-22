import { captureSessionGeneration, getSessionLogoutInProgress, isSessionGenerationCurrent, subscribeSessionLogout } from './session';

/** All state-changing API requests share this lock; logout takes it exclusively. */
export const MUTATION_LOCK_NAME = 'billsplit-api-mutations';
export const MUTATION_QUIESCE_DEADLINE_MS = 750;

export class MutationBlockedError extends Error {
  readonly code = 'LOGOUT_IN_PROGRESS';

  constructor() {
    super('A logout is in progress. Try again after signing in.');
    this.name = 'MutationBlockedError';
  }
}

type MutationTask = Promise<unknown>;
let logoutBarrierGeneration: number | undefined;
const activeMutations = new Set<MutationTask>();

const locks = () => typeof navigator !== 'undefined' && typeof navigator.locks?.request === 'function' ? navigator.locks : undefined;

const assertMutationAllowed = (capturedGeneration: number) => {
  // Requests captured before the barrier are already-dispatched work and must
  // be allowed to settle. New requests, including requests queued behind an
  // exclusive Web Lock, are rejected before they can reach the server.
  if (getSessionLogoutInProgress() || (logoutBarrierGeneration !== undefined && capturedGeneration >= logoutBarrierGeneration)) throw new MutationBlockedError();
  if (!isSessionGenerationCurrent(capturedGeneration) && logoutBarrierGeneration === undefined) throw new MutationBlockedError();
};

const track = <T>(task: () => Promise<T>) => {
  let tracked!: Promise<T>;
  tracked = (async () => {
    try { return await task(); }
    finally { activeMutations.delete(tracked); }
  })();
  activeMutations.add(tracked);
  return tracked;
};

export const beginMutationBarrier = (generation: number) => {
  if (logoutBarrierGeneration === undefined || generation > logoutBarrierGeneration) logoutBarrierGeneration = generation;
};

export const isMutationBarrierActive = () => logoutBarrierGeneration !== undefined;

/** Release only after a newly verified session, or when destructive logout failed. */
export const releaseMutationBarrier = (generation?: number) => {
  if (generation === undefined || logoutBarrierGeneration === generation) logoutBarrierGeneration = undefined;
};

export const runMutation = <T>(operation: () => Promise<T>) => {
  const capturedGeneration = captureSessionGeneration();
  return track(async () => {
    const lockManager = locks();
    if (!lockManager) {
      assertMutationAllowed(capturedGeneration);
      return operation();
    }
    return lockManager.request(MUTATION_LOCK_NAME, { mode: 'shared' }, async () => {
      assertMutationAllowed(capturedGeneration);
      return operation();
    });
  });
};

/**
 * The Web Locks exclusive request is the quiescence barrier. The fallback
 * waits for the same-tab registry; storage/BroadcastChannel session barriers
 * stop new work in other tabs, but cannot observe a remote fetch settlement.
 */
export const withExclusiveMutationLock = async <T>(operation: () => Promise<T>) => {
  const lockManager = locks();
  const wait = lockManager
    ? lockManager.request(MUTATION_LOCK_NAME, { mode: 'exclusive' }, operation)
    : Promise.allSettled([...activeMutations]).then(operation);
  void wait.catch(() => undefined);
  const timeout = new Promise<undefined>((resolve) => setTimeout(resolve, MUTATION_QUIESCE_DEADLINE_MS));
  return Promise.race([wait, timeout]) as Promise<T | undefined>;
};

subscribeSessionLogout((generation) => beginMutationBarrier(generation));

if (typeof window !== 'undefined') {
  window.addEventListener('billsplit-authenticated', () => releaseMutationBarrier());
}
