import { hasActiveMutations } from './mutation-quiescence';
import { acquireReloadGate, getReloadBlockReason, getReloadSafetyState, RELOAD_IDLE_MS, observeReloadInteractions, ownsReloadGate, releaseReloadGate, subscribeReloadSafety } from './reload-safety';

const PROTOCOL = 'BILLSPLIT_UPDATE_V1';
const CHECK_INTERVAL_MS = 30 * 60_000;
const CLUSTER_THROTTLE_MS = 30_000;
const CHECK_TIMEOUT_MS = 15_000;
const RETRY_MS = 15_000;
export type UpdatePhase = 'initializing' | 'unsupported' | 'idle' | 'checking' | 'installing' | 'no-update' | 'ready' | 'blocked' | 'applying' | 'check-error' | 'install-error' | 'offline' | 'deferred';
export type ServiceWorkerUpdateState = Readonly<{
  phase: UpdatePhase; updateReady: boolean; applying: boolean; blocked: boolean;
  blockerReason?: string; lastCheck?: number; lastSuccess?: number; error?: string;
  manualError?: string;
  offline?: boolean;
}>;
const initialState: ServiceWorkerUpdateState = Object.freeze({ phase: 'initializing', updateReady: false, applying: false, blocked: false });
let state = initialState;
let registration: ServiceWorkerRegistration | undefined;
let waiting: ServiceWorker | undefined;
let waitingTarget: string | undefined;
let prepared: { worker: ServiceWorker; target: string; attempt: string; token: string } | undefined;
type Attempt = { worker: ServiceWorker; target: string; attempt: string };
let requested: Attempt | undefined;
let activationIntent: Attempt | undefined;
let deferredTarget: string | undefined;
let expectedControllerTarget: string | undefined;
let verifyingController: ServiceWorker | undefined;
let pageBuild: string | undefined;
let hadController = false;
let reloaded = false;
let autoApply = false;
let safetyIntegrated = false;
export type ServiceWorkerUpdateOptions = { autoApply?: boolean; safetyIntegrated?: boolean };
let configuration: ServiceWorkerUpdateOptions = {};
let generation = 0;
let nextCheck = 0;
let failures = 0;
let checkPromise: Promise<void> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let manualRevision: number | undefined;
let manualExpires = 0;
let safetyQueued = false;
type IdentityCheck = { worker: ServiceWorker; tries: number; timer?: ReturnType<typeof setTimeout> };
let waitingIdentity: IdentityCheck | undefined;
let controllerIdentity: IdentityCheck | undefined;
let attemptTimer: ReturnType<typeof setTimeout> | undefined;
const cleanups: Array<() => void> = [];
const listeners = new Set<() => void>();
const retiredAttempts = new Set<string>();
const retire = (attempt: string) => {
  retiredAttempts.add(attempt);
  if (retiredAttempts.size > 256) retiredAttempts.delete(retiredAttempts.values().next().value!);
};
const setState = (patch: Partial<ServiceWorkerUpdateState>) => {
  state = Object.freeze({ ...state, ...patch });
  listeners.forEach((listener) => listener());
};
const phase = (value: UpdatePhase, extra: Partial<ServiceWorkerUpdateState> = {}) => setState({ phase: value, applying: value === 'applying', blocked: value === 'blocked' || value === 'deferred', error: undefined, blockerReason: undefined, ...extra });
export const getServiceWorkerUpdateState = () => state;
export const subscribeServiceWorkerUpdate = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const visible = () => typeof document !== 'undefined' && document.visibilityState === 'visible';
const offline = () => typeof navigator !== 'undefined' && navigator.onLine === false;
/** Compatibility helper; focus is activity, not persistent draft ownership. */
export const hasActiveForm = () => typeof document !== 'undefined' && Boolean((document.activeElement as Element | null)?.closest?.('form'));
const preparationReason = (manual = false) => !safetyIntegrated ? 'Waiting for reload protection to initialize' : (manual && Date.now() < manualExpires && manualRevision === getReloadSafetyState().revision ? getReloadSafetyState().reason : getReloadBlockReason()) ?? (hasActiveMutations() ? 'Saving changes' : undefined);
const localReason = () => !visible() ? 'Waiting for this tab to be visible' : preparationReason(manualRevision !== undefined);
export const canApplyServiceWorkerUpdate = () => !localReason();
const send = (worker: ServiceWorker, type: string, extra: Record<string, unknown> = {}) => worker.postMessage({ protocol: PROTOCOL, type, ...extra });
const matchesAttempt = (attempt: Attempt | undefined, worker: ServiceWorker, data: { target: string; attempt: string }) => attempt?.worker === worker && attempt.target === data.target && attempt.attempt === data.attempt;
const settledPhase = (reason?: string) => {
  if (verifyingController || deferredTarget) phase('deferred', { updateReady: false, blockerReason: verifyingController ? reason || 'Verifying the activated update' : localReason() || reason });
  else if (prepared || requested) phase('applying', { updateReady: true });
  else if (waiting) phase(reason || localReason() || !waitingTarget ? 'blocked' : 'ready', { updateReady: true, blockerReason: reason || (!waitingTarget ? 'Verifying the waiting update' : localReason()) });
  else phase('idle', { updateReady: false });
};
// Discovery is independent of activation: a late network result cannot hide
// an actual held/requested update or its protected controller verification.
const discoveryPhase = (value: UpdatePhase, extra: Partial<ServiceWorkerUpdateState> = {}) => {
  if (requested || prepared || verifyingController || deferredTarget) { settledPhase(); setState(extra); }
  else phase(value, extra);
};
const manualBlockHelp = (reason?: string) => {
  const safety = getReloadSafetyState();
  if (safety.operations || hasActiveMutations()) return `${reason || 'Saving changes'}. Let ongoing operations finish, then try Update now again.`;
  if (safety.reason) return `${reason || safety.reason}. Save or discard this unfinished work, then try Update now again.`;
  return `${reason || 'The update cannot apply yet'}. Try Update now again when this tab is ready.`;
};
const cancelPrepared = () => {
  const old = prepared;
  prepared = undefined;
  manualRevision = undefined;
  if (old) {
    if (matchesAttempt(requested, old.worker, old)) clearRequest();
    if (matchesAttempt(activationIntent, old.worker, old)) activationIntent = undefined;
    retire(old.attempt);
    try { send(old.worker, 'CANCEL', { target: old.target, attempt: old.attempt }); } catch { /* Lease expires even if worker stopped. */ }
    releaseReloadGate(old.token);
    settledPhase();
  }
};
const clearRequest = (cancel = false) => {
  const old = requested;
  requested = undefined;
  if (cancel) manualRevision = undefined;
  clearTimeout(attemptTimer);
  attemptTimer = undefined;
  if (old) {
    retire(old.attempt);
    if (cancel) { try { send(old.worker, 'CANCEL', { target: old.target, attempt: old.attempt }); } catch { /* Worker deadline is authoritative. */ } }
  }
};
const scheduleRetry = (delay = RETRY_MS + Math.floor(Math.random() * 5_000)) => {
  if (retryTimer || !registration) return;
  retryTimer = setTimeout(() => { retryTimer = undefined; considerApply(); }, delay);
};
const reloadSafely = () => {
  if (!deferredTarget || verifyingController || reloaded) return;
  const reason = localReason();
  if (reason) { phase('deferred', { updateReady: false, blockerReason: reason }); scheduleIdle(); return; }
  reloaded = true;
  window.location.reload();
};
function considerApply() {
  reconcileWaiting(false);
  if (verifyingController) { identify(verifyingController, 'controller'); return; }
  if (deferredTarget) { reloadSafely(); return; }
  if (!waiting || !autoApply || requested || prepared) return;
  if (retryTimer) return;
  if (!canApplyServiceWorkerUpdate()) {
    phase('blocked', { updateReady: true, blockerReason: localReason() });
    scheduleIdle();
    return;
  }
  applyServiceWorkerUpdate(false);
}
const scheduleIdle = () => {
  clearTimeout(idleTimer);
  idleTimer = undefined;
  const remaining = getReloadSafetyState().lastInteraction + RELOAD_IDLE_MS - Date.now();
  if (remaining > 0) idleTimer = setTimeout(() => { idleTimer = undefined; considerApply(); }, remaining);
};
const identify = (worker: ServiceWorker, kind: 'waiting' | 'controller', force = false) => {
  let check = kind === 'waiting' ? waitingIdentity : controllerIdentity;
  if (check?.worker !== worker) {
    clearTimeout(check?.timer);
    check = { worker, tries: 0 };
    if (kind === 'waiting') waitingIdentity = check;
    else controllerIdentity = check;
  }
  if (check.timer && !force) return;
  clearTimeout(check.timer);
  if (force) check.tries = 0;
  const captured = check;
  try { send(worker, 'IDENTIFY'); } catch { /* Retry with bounded backoff. */ }
  const stillNeeded = () => kind === 'waiting' ? waiting === worker && !waitingTarget : verifyingController === worker;
  if (!stillNeeded()) return;
  captured.timer = setTimeout(() => {
    captured.timer = undefined;
    if (!stillNeeded()) return;
    captured.tries += 1;
    settledPhase(kind === 'waiting' ? 'Could not verify the waiting update; retrying' : 'Could not verify the activated update; retrying');
    identify(worker, kind);
  }, Math.min(60_000, 3_000 * 2 ** Math.min(captured.tries, 5)));
};
const reconcileWaiting = (show = true, forceIdentity = false) => {
  const candidate = registration?.waiting;
  const next = candidate && candidate !== navigator.serviceWorker.controller && candidate.state !== 'redundant' && candidate.state !== 'activated' ? candidate : undefined;
  if (waiting !== next) {
    const old = waiting;
    if (old && next !== old && !activationIntent) manualRevision = undefined;
    if (requested?.worker === old) clearRequest(true);
    if (prepared?.worker === old && (!activationIntent || old?.state === 'redundant')) cancelPrepared();
    waiting = next;
    waitingTarget = undefined;
    clearTimeout(waitingIdentity?.timer);
    waitingIdentity = undefined;
  }
  if (!next) {
    if (show || ['ready', 'blocked', 'applying'].includes(state.phase)) settledPhase();
    else if (!prepared && !requested) setState({ updateReady: false });
    return;
  }
  if (!waitingTarget) identify(next, 'waiting', forceIdentity);
  if (show) settledPhase();
  if (show && !prepared && !requested) scheduleIdle();
};
const observeWaiting = () => reconcileWaiting();

/** Manual checks bypass discovery throttle, never the reload safety barrier. */
export function checkForUpdates(manual = true): Promise<void> {
  setState({ offline: offline() });
  if (!registration) { phase(typeof navigator === 'undefined' || !navigator.serviceWorker ? 'unsupported' : 'initializing'); return Promise.resolve(); }
  reconcileWaiting(false, manual);
  if (verifyingController) identify(verifyingController, 'controller', manual);
  if (checkPromise) return checkPromise;
  if (!manual && Date.now() < nextCheck) return Promise.resolve();
  if (offline()) { if (waiting || requested || prepared || verifyingController || deferredTarget) settledPhase(); else phase('offline', { updateReady: false }); return Promise.resolve(); }
  const current = registration;
  const captured = generation;
  nextCheck = Date.now() + CLUSTER_THROTTLE_MS;
  discoveryPhase('checking', { lastCheck: Date.now(), updateReady: Boolean(waiting || requested || prepared) });
  checkPromise = (async () => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let removeInstallListener: (() => void) | undefined;
    let expired = false;
    let installingStarted = false;
    try {
      // A deadline rejects the check but never treats a late install as success.
      const work = (async () => {
        await current.update();
        if (expired || captured !== generation) return;
        const installing = current.installing;
        if (installing && installing.state !== 'installed' && installing.state !== 'activated') {
          installingStarted = true;
          discoveryPhase('installing');
          await new Promise<void>((resolve, reject) => {
            const changed = () => {
              if (installing.state === 'redundant') reject(new Error('The update could not be installed.'));
              else if (installing.state === 'installed' || installing.state === 'activated') resolve();
            };
            installing.addEventListener('statechange', changed);
            removeInstallListener = () => installing.removeEventListener('statechange', changed);
            changed();
          });
        } else if (installing?.state === 'redundant') { installingStarted = true; throw new Error('The update could not be installed.'); }
      })();
      void work.catch(() => undefined);
      await Promise.race([work, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('The update check timed out.')), CHECK_TIMEOUT_MS); })]);
      if (captured !== generation) return;
      failures = 0;
      setState({ lastSuccess: Date.now() });
      reconcileWaiting(false);
      if (waiting || prepared || requested || verifyingController || deferredTarget) settledPhase();
      else phase('no-update', { updateReady: false });
    } catch (error) {
      if (captured !== generation) return;
      failures += 1;
      reconcileWaiting(false);
      nextCheck = Date.now() + Math.min(CHECK_INTERVAL_MS, CLUSTER_THROTTLE_MS * 2 ** Math.min(failures, 6));
      discoveryPhase(offline() ? 'offline' : installingStarted ? 'install-error' : 'check-error', { error: error instanceof Error ? error.message : 'Could not check for updates', offline: offline(), updateReady: Boolean(waiting || requested || prepared) });
    } finally {
      clearTimeout(timeout);
      expired = true;
      removeInstallListener?.();
      if (captured === generation) checkPromise = undefined;
    }
  })();
  return checkPromise;
}

export function applyServiceWorkerUpdate(manual = true) {
  if (manual && !requested && !prepared) { manualRevision = getReloadSafetyState().revision; manualExpires = Date.now() + 10_000; setState({ manualError: undefined }); }
  reconcileWaiting(false);
  if (verifyingController) {
    if (manual) setState({ manualError: 'Verifying the activated update before refreshing. Verification will retry automatically; try Update now again if it does not finish.' });
    identify(verifyingController, 'controller', manual);
    return false;
  }
  if (deferredTarget) {
    reloadSafely();
    if (!reloaded && manual) { setState({ manualError: manualBlockHelp(localReason()) }); manualRevision = undefined; }
    return reloaded;
  }
  if (!waiting || !waitingTarget || requested || prepared) {
    if (!requested && !prepared) {
      manualRevision = undefined;
      if (manual) setState({ manualError: waiting ? 'Verifying the installed update before applying it. Verification will retry automatically; try Update now again if it does not finish.' : 'No installed update is available. Check for updates when connected.' });
      if (waiting) identify(waiting, 'waiting', manual);
    }
    return false;
  }
  if (!canApplyServiceWorkerUpdate()) { const reason = localReason(); manualRevision = undefined; phase('blocked', { updateReady: true, blockerReason: reason, ...(manual ? { manualError: manualBlockHelp(reason) } : {}) }); scheduleIdle(); return false; }
  if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') { manualRevision = undefined; phase('blocked', { blockerReason: 'Safe update coordination is unavailable', manualError: manual ? 'Safe update coordination is unavailable' : undefined }); return false; }
  requested = { worker: waiting, target: waitingTarget, attempt: crypto.randomUUID() };
  const attempt = requested;
  phase('applying', { updateReady: true });
  try {
    send(attempt.worker, 'REQUEST', { target: attempt.target, attempt: attempt.attempt });
    attemptTimer = setTimeout(() => {
      if (requested !== attempt) return;
      clearRequest(true);
      if (matchesAttempt(prepared, attempt.worker, attempt)) cancelPrepared();
      settledPhase('Other tabs did not finish preparing the update');
      if (manual) setState({ manualError: 'Finish work in other open tabs, then try Update now again.' });
      scheduleRetry();
    }, 9_000);
    return true;
  } catch {
    clearRequest();
    manualRevision = undefined;
    phase('blocked', { blockerReason: 'Could not contact the update worker', updateReady: true, ...(manual ? { manualError: 'Could not contact the update worker. Try Update now again.' } : {}) });
    scheduleRetry();
    return false;
  }
}

export function cancelServiceWorkerUpdate() {
  const active = Boolean(requested || prepared || activationIntent);
  clearRequest(true);
  cancelPrepared();
  manualRevision = undefined;
  if (active || state.applying) settledPhase();
}

const onMessage = (event: MessageEvent) => {
  const data = event.data;
  const worker = event.source as ServiceWorker | null;
  if (data?.protocol !== PROTOCOL || !worker || typeof data.target !== 'string' || !data.target.startsWith('bill-split-shell-')) return;
  if (data.type === 'PROBE_BUILD' && worker === navigator.serviceWorker.controller && typeof data.scan === 'string') {
    try { send(worker, 'BUILD_REPORT', { target: data.target, scan: data.scan, build: pageBuild ?? null }); } catch { /* Unknown builds retain their assets. */ }
    return;
  }
  if (data.type === 'IDENTITY') {
    if (worker === waiting && worker === registration?.waiting && worker.state !== 'redundant') { waitingTarget = data.target; clearTimeout(waitingIdentity?.timer); waitingIdentity = undefined; settledPhase(); considerApply(); }
    else if (worker === navigator.serviceWorker.controller && worker === verifyingController && hadController) {
      if (expectedControllerTarget && expectedControllerTarget !== data.target) return;
      clearTimeout(controllerIdentity?.timer); controllerIdentity = undefined;
      verifyingController = undefined;
      deferredTarget = data.target;
      activationIntent = undefined;
      reloadSafely();
    }
    return;
  }
  if (typeof data.attempt !== 'string' || data.attempt.length < 8 || data.attempt.length > 128) return;
  // Passive tabs may not have observed updatefound yet. Only their actual
  // registration.waiting worker is permitted to acquire a barrier.
  if (worker !== registration?.waiting && worker !== prepared?.worker && worker !== requested?.worker) return;
  if (data.type === 'PREPARE') {
    if (retiredAttempts.has(data.attempt)) {
      try { send(worker, 'ACK', { target: data.target, attempt: data.attempt, round: 'prepare', ready: false }); } catch { /* Fail closed. */ }
      return;
    }
    if (data.target !== waitingTarget && waiting === worker) return;
    const token = `${data.target}:${data.attempt}`;
    const ownManual = matchesAttempt(requested, worker, data) && manualRevision !== undefined;
    const ready = !preparationReason(ownManual) && !prepared && typeof data.leaseMs === 'number' && data.leaseMs > 0 && data.leaseMs <= 10_000 && acquireReloadGate(token, data.leaseMs, ownManual ? manualRevision : undefined);
    if (ready) {
      prepared = { worker, target: data.target, attempt: data.attempt, token };
      phase('applying', { updateReady: true });
    }
    try { send(worker, 'ACK', { target: data.target, attempt: data.attempt, round: 'prepare', ready: Boolean(ready) }); } catch { cancelPrepared(); }
    return;
  }
  const matches = prepared?.worker === worker && prepared.target === data.target && prepared.attempt === data.attempt;
  if (data.type === 'VALIDATE' && matches) {
    const ready = ownsReloadGate(prepared!.token) && !preparationReason(manualRevision !== undefined);
    try { send(worker, 'ACK', { target: data.target, attempt: data.attempt, round: 'final', ready }); } catch { cancelPrepared(); }
  } else if (data.type === 'RELEASE' && (matches || matchesAttempt(requested, worker, data))) {
    const manual = manualRevision !== undefined;
    retire(data.attempt);
    if (matchesAttempt(requested, worker, data)) clearRequest();
    if (matches) cancelPrepared();
    if (matchesAttempt(activationIntent, worker, data)) activationIntent = undefined;
    settledPhase(data.reason || 'Another tab is not ready');
    manualRevision = undefined;
    if (manual) setState({ manualError: 'Finish work in other open tabs, then try Update now again.' });
    scheduleRetry();
  } else if (data.type === 'ACTIVATING' && matches) {
    if (!ownsReloadGate(prepared!.token) || preparationReason(manualRevision !== undefined)) { cancelServiceWorkerUpdate(); return; }
    // The controller identity is verified again on controllerchange.
    activationIntent = { worker, target: data.target, attempt: data.attempt };
  }
};
const onControllerChange = () => {
  const controller = navigator.serviceWorker.controller;
  if (!controller) return;
  if (!hadController) { hadController = true; return; } // First install is not an update reload.
  clearRequest();
  waiting = undefined;
  waitingTarget = undefined;
  // An unprepared late tab must also refresh eventually, but only after its
  // drafts/operations settle. Never trust an unrelated message as activation.
  deferredTarget = undefined;
  expectedControllerTarget = activationIntent?.target;
  verifyingController = controller;
  phase('deferred', { updateReady: false, blockerReason: localReason() || 'Verifying the activated update' });
  identify(controller, 'controller', true);
};

/** State owners can configure protection before async registration completes. */
export function configureServiceWorkerUpdates(options: ServiceWorkerUpdateOptions) {
  configuration = { ...configuration, ...options };
  autoApply = options.autoApply ?? autoApply;
  safetyIntegrated = options.safetyIntegrated ?? safetyIntegrated;
  if (!safetyIntegrated) cancelServiceWorkerUpdate();
  considerApply();
}

/** Idempotent setup. Enable automatic application only after blocker integration. */
export function observeServiceWorkerRegistration(next: ServiceWorkerRegistration, options: ServiceWorkerUpdateOptions = {}) {
  if (registration === next) {
    autoApply = options.autoApply ?? autoApply;
    safetyIntegrated = options.safetyIntegrated ?? safetyIntegrated;
    if (prepared && localReason()) cancelServiceWorkerUpdate();
    considerApply();
    return;
  }
  disposeServiceWorkerUpdates();
  if (typeof document === 'undefined' || typeof window === 'undefined' || typeof navigator === 'undefined' || !navigator.serviceWorker?.addEventListener || !document.addEventListener || typeof next.update !== 'function') {
    phase('unsupported', { blockerReason: 'Safe update coordination is unavailable' });
    return;
  }
  registration = next;
  pageBuild = document.querySelector?.('meta[name="billsplit-build"]')?.getAttribute('content') ?? undefined;
  autoApply = options.autoApply ?? configuration.autoApply ?? false;
  safetyIntegrated = options.safetyIntegrated ?? configuration.safetyIntegrated ?? false;
  hadController = Boolean(navigator.serviceWorker.controller);
  const listen = (target: EventTarget, type: string, listener: EventListener) => {
    target.addEventListener(type, listener);
    cleanups.push(() => target.removeEventListener(type, listener));
  };
  cleanups.push(observeReloadInteractions(document));
  cleanups.push(subscribeReloadSafety(() => {
    if (safetyQueued) return;
    safetyQueued = true;
    const captured = generation;
    queueMicrotask(() => {
      safetyQueued = false;
      if (captured !== generation) return;
      if (manualRevision !== undefined && manualRevision !== getReloadSafetyState().revision) cancelServiceWorkerUpdate();
      if (prepared && !ownsReloadGate(prepared.token)) { if (!preparationReason()) scheduleRetry(); cancelServiceWorkerUpdate(); }
      scheduleIdle();
      considerApply();
    });
  }));
  listen(navigator.serviceWorker, 'message', onMessage as EventListener);
  listen(navigator.serviceWorker, 'controllerchange', onControllerChange);
  const resume = () => { if (visible()) { void checkForUpdates(false); considerApply(); } };
  listen(window, 'focus', resume);
  listen(window, 'pageshow', resume);
  listen(window, 'online', () => { setState({ offline: false }); void checkForUpdates(false); considerApply(); });
  listen(window, 'offline', () => { setState({ offline: true }); if (!waiting && !prepared && !requested && !verifyingController && !deferredTarget) phase('offline'); });
  listen(window, 'pagehide', cancelServiceWorkerUpdate);
  listen(document, 'visibilitychange', () => { if (visible()) resume(); });
  listen(next, 'updatefound', () => {
    const installing = next.installing;
    if (!installing) return;
    discoveryPhase('installing');
    const changed = () => {
      if (installing.state === 'installed') observeWaiting();
      else if (installing.state === 'redundant') discoveryPhase('install-error', { error: 'The update could not be installed.' });
    };
    listen(installing, 'statechange', changed);
    changed();
  });
  const interval = setInterval(() => { if (visible()) void checkForUpdates(false); }, CHECK_INTERVAL_MS);
  cleanups.push(() => clearInterval(interval));
  phase('idle');
  observeWaiting();
  void checkForUpdates(false);
}
export function disposeServiceWorkerUpdates() {
  generation += 1;
  cancelServiceWorkerUpdate();
  cleanups.splice(0).forEach((cleanup) => cleanup());
  clearTimeout(idleTimer); clearTimeout(retryTimer); clearTimeout(waitingIdentity?.timer); clearTimeout(controllerIdentity?.timer); clearTimeout(attemptTimer);
   idleTimer = undefined; retryTimer = undefined; waitingIdentity = undefined; controllerIdentity = undefined; attemptTimer = undefined;
  registration = undefined; waiting = undefined; waitingTarget = undefined;
  requested = undefined; activationIntent = undefined; deferredTarget = undefined; verifyingController = undefined; checkPromise = undefined;
  expectedControllerTarget = undefined;
  manualRevision = undefined; manualExpires = 0;
  retiredAttempts.clear();
  nextCheck = 0; failures = 0; reloaded = false; autoApply = false; safetyIntegrated = false;
  state = initialState;
  listeners.forEach((listener) => listener());
}
export function serviceWorkerRegistrationFailed(error?: unknown) {
  phase(typeof navigator === 'undefined' || !navigator.serviceWorker ? 'unsupported' : 'check-error', { error: error instanceof Error ? error.message : 'Could not initialize app updates' });
}
