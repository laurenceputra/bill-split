import type { ServiceWorkerUpdateState } from './service-worker';
import { createElement } from 'react';

/** Pure presentation shared by the live controls and responsive state fixtures. */
export function UpdateStatus({ update, settings = false, onCheck }: { update: ServiceWorkerUpdateState; settings?: boolean; onCheck: () => void }) {
  if (!settings && !update.updateReady && !update.applying && !update.blocked) return null;
  const messages = {
    initializing: 'App updates are initializing.', unsupported: 'App updates are not supported in this browser.',
    idle: 'Check for a newer BillSplit version.', checking: 'Checking for updates…', installing: 'Downloading the app update…',
    'no-update': 'BillSplit is up to date.', ready: 'Update ready. It will apply when all tabs are safe and idle.',
    blocked: `Update waiting: ${update.blockerReason || 'finish your current work in all tabs'}.`,
    applying: 'Applying update…', 'check-error': 'Could not check for updates. Retry when connected.',
    'install-error': 'The app update could not download. Retry when connected.', offline: 'Updates are unavailable offline.',
    deferred: 'Refresh waiting until your work is safe.',
  };
  const disabled = ['initializing', 'unsupported', 'checking', 'installing', 'applying', 'offline'].includes(update.phase);
  return createElement('div', { className: 'update-control' },
    createElement('span', { role: 'status' }, messages[update.phase]),
    settings ? createElement('button', { className: 'update-action', type: 'button', disabled, onClick: onCheck }, update.phase === 'check-error' || update.phase === 'install-error' ? 'Retry update check' : 'Check for updates') : null,
    settings ? createElement('small', null, update.lastSuccess ? `Last successful check: ${new Date(update.lastSuccess).toLocaleString()}` : 'No successful update check yet.') : null);
}
