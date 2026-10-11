// Deliberately a core integration fixture, not the authenticated application.
import { applyServiceWorkerUpdate, configureServiceWorkerUpdates, observeServiceWorkerRegistration, checkForUpdates, getServiceWorkerUpdateState } from '../../../src/app/service-worker';
import { createReloadBlocker, runProtectedOperation, getReloadSafetyState } from '../../../src/app/reload-safety';
import { legacyUpdates } from './legacy-update-client';

declare const __BUILD__: string;
declare const __LEGACY__: boolean;
declare const __UNSUPPORTED__: boolean;
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
if (!__LEGACY__) configureServiceWorkerUpdates({ safetyIntegrated: true, autoApply: true });
const registration = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
if (!__LEGACY__) observeServiceWorkerRegistration(registration);
if (!__LEGACY__) {
  const button = document.createElement('button');
  button.id = 'update-now';
  button.textContent = 'Update now';
  button.addEventListener('click', () => applyServiceWorkerUpdate(true));
  document.body.append(button);
}
const legacy = __LEGACY__ ? legacyUpdates(registration, __UNSUPPORTED__) : undefined;
const productionStorage = async () => __LEGACY__
  // @ts-expect-error fixture-only pinned source resolver
  ? import('oldest:src/app/idb.ts') : import('../../../src/app/idb');
Object.assign(window, {
  fixture: {
    productionOutbox: async () => (await productionStorage()).listOutbox('demo-user'),
    enqueueProduction: async () => {
      const storage = await productionStorage();
      const payload = { description: 'Sample expense', amount_minor: 123, currency: 'USD' as const, date: '2026-01-02', category: 'Other', client_operation_id: 'demo-operation', payers: [{ person_id: '00000000-0000-4000-8000-000000000001', amount_minor: 123 }], splits: [{ person_id: '00000000-0000-4000-8000-000000000001', amount_minor: 123 }] };
      const current = await import('../../../src/shared/schemas');
      // @ts-expect-error fixture-only pinned historical source resolver
      const historical = await import('oldest:src/shared/schemas.ts');
      current.expenseInput.parse(payload); historical.expenseInput.parse(payload);
      current.assertFinancialInput(payload); historical.assertFinancialInput(payload);
      return storage.saveOutboxItem({ clientOperationId: 'demo-operation', userId: 'demo-user', groupId: 'demo-group', payload, display: { description: payload.description, amountMinor: 123, currency: 'USD', date: payload.date }, createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', status: 'pending', attempts: 0, authEpoch: 0 });
    },
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
    ...legacy,
  },
});
