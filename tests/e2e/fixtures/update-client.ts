// Deliberately a core integration fixture, not the authenticated application.
import { configureServiceWorkerUpdates, observeServiceWorkerRegistration, checkForUpdates, getServiceWorkerUpdateState } from '../../../src/app/service-worker';
import { createReloadBlocker, runProtectedOperation, getReloadSafetyState } from '../../../src/app/reload-safety';

declare const __BUILD__: string;
const loads = Number(sessionStorage.getItem('loads') || 0) + 1;
sessionStorage.setItem('loads', String(loads));
document.querySelector('#build')!.textContent = __BUILD__;
let releaseDraft: (() => void) | undefined;
const input = document.querySelector<HTMLInputElement>('#draft')!;
input.addEventListener('input', () => {
  if (input.value && !releaseDraft) releaseDraft = createReloadBlocker('Unsaved fixture profile');
  if (!input.value) { releaseDraft?.(); releaseDraft = undefined; }
});
let finishMutation: (() => void) | undefined;
const openDB = () => new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open('update-fixture', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('outbox', { keyPath: 'id' });
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
async function outbox(write = false) {
  const db = await openDB();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('outbox', write ? 'readwrite' : 'readonly');
      const request = write ? tx.objectStore('outbox').put({ id: 'queued-operation', status: 'queued', amount: 123 }) : tx.objectStore('outbox').getAll();
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}
configureServiceWorkerUpdates({ safetyIntegrated: true, autoApply: true });
const registration = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
observeServiceWorkerRegistration(registration);
Object.assign(window, {
  fixture: {
    check: () => checkForUpdates(),
    state: getServiceWorkerUpdateState,
    safety: getReloadSafetyState,
    loads: () => loads,
    enqueue: () => runProtectedOperation(() => outbox(true), 'Queuing fixture operation'),
    outbox: () => outbox(),
    holdMutation: () => {
      void runProtectedOperation(() => new Promise<void>((resolve) => { finishMutation = resolve; }), 'Held fixture write');
    },
    releaseMutation: () => finishMutation?.(),
  },
});
