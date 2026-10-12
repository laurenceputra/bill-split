import type { ServiceWorkerUpdateState } from './service-worker';
import { createElement } from 'react';

/** Pure presentation shared by the live controls and responsive state fixtures. */
export function UpdateStatus({ update, settings = false, onCheck, onApply }: { update: ServiceWorkerUpdateState; settings?: boolean; onCheck: () => void; onApply?: () => void }) {
  if (!settings && !update.updateReady && !update.applying && !update.blocked) return null;
  const messages = {
    initializing: 'App updates are initializing.', unsupported: 'App updates are not supported in this browser.',
    idle: 'Check for a newer BillSplit version.', checking: 'Checking for updates…', installing: 'Downloading the app update…',
    'no-update': 'BillSplit is up to date.', ready: 'An app update is available.',
    blocked: 'An app update is available.',
    applying: 'Updating…', 'check-error': 'Could not check for updates. Retry when connected.',
    'install-error': 'The app update could not download. Retry when connected.', offline: 'Updates are unavailable offline.',
    deferred: 'An app update is available.',
  };
  const disabled = update.offline || ['initializing', 'unsupported', 'checking', 'installing', 'applying', 'offline'].includes(update.phase);
  return createElement('div', { className: 'update-control', ...(settings ? { style: { flexDirection: 'column', alignItems: 'flex-start', overflowWrap: 'anywhere' } } : {}) },
    settings || update.applying ? createElement('span', { role: 'status', ...(settings ? { style: { whiteSpace: 'normal', overflow: 'visible', maxWidth: '100%' } } : {}) }, messages[update.phase]) : null,
    (update.updateReady || update.phase === 'deferred') && !update.applying ? createElement('button', { className: 'button button--secondary update-action', type: 'button', onClick: onApply }, 'Update now') : null,
    update.manualError ? createElement('span', { role: 'status', ...(settings ? { style: { whiteSpace: 'normal', overflow: 'visible', maxWidth: '100%' } } : {}) }, update.manualError) : null,
    settings && update.offline ? createElement('small', null, update.updateReady || update.phase === 'deferred' ? 'Offline: checking for new updates requires a connection. The installed update can still use Update now.' : 'Offline: checking for new updates requires a connection.') : null,
    settings ? createElement('button', { className: 'button button--secondary update-action', type: 'button', disabled, onClick: onCheck }, update.phase === 'check-error' || update.phase === 'install-error' ? 'Retry update check' : 'Check for updates') : null,
    settings ? createElement('small', null, update.lastSuccess ? `Last successful check: ${new Date(update.lastSuccess).toLocaleString()}` : 'No successful update check yet.') : null,
    settings ? createElement('details', { className: 'update-diagnostics', style: { minWidth: 0, width: '100%', overflowWrap: 'anywhere' } },
      createElement('summary', null, 'Update diagnostics and recovery'),
      createElement('dl', null,
        createElement('dt', null, 'Page build'), createElement('dd', null, update.pageBuild || 'Unavailable'),
        createElement('dt', null, 'Active worker build'), createElement('dd', null, update.activeBuild || 'Unavailable (older workers may not report a build)'),
        createElement('dt', null, 'Waiting worker build'), createElement('dd', null, update.waitingBuild || (update.updateReady ? 'Not yet verified' : 'None reported'))),
      createElement('p', null, 'If an update stays waiting, finish writes and save work in every open BillSplit tab or app window. Older tabs cannot acknowledge a safe update.'),
      createElement('a', { href: '/api/app-update-recovery', target: '_blank', rel: 'noopener noreferrer' }, 'Open update recovery instructions'),
      createElement('small', { style: { display: 'block', marginTop: '0.5rem' } }, 'Opens a new tab so unfinished work stays here. Requires a connection. Close the recovery tab too when closing all BillSplit tabs and app windows. Recovery never clears local data or forces other tabs to refresh.')) : null);
}
