// Sources and all relative dependencies are loaded from checksum-verified,
// vendored Git snapshots, not reimplemented using the modern update core.
// @ts-expect-error fixture-only Vite historical source resolver
import { observeServiceWorkerRegistration, applyServiceWorkerUpdate, getServiceWorkerUpdateState } from 'historical:src/app/service-worker.ts';
// @ts-expect-error fixture-only Vite historical source resolver
import { runMutation, hasActiveMutations } from 'historical:src/app/mutation-quiescence.ts';

export function legacyUpdates(registration: ServiceWorkerRegistration, unsupported = false) {
  if (!unsupported) observeServiceWorkerRegistration(registration);
  let finish: (() => void) | undefined;
  return {
    check: () => registration.update(),
    apply: () => unsupported ? false : applyServiceWorkerUpdate(),
    state: () => unsupported ? { updateReady: Boolean(registration.waiting), phase: 'unsupported' } : getServiceWorkerUpdateState(),
    holdMutation: () => { void runMutation(() => new Promise<void>((resolve) => { finish = resolve; })); },
    releaseMutation: () => finish?.(),
    safety: () => ({ operations: hasActiveMutations() ? 1 : 0 }),
  };
}
