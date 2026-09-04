import React from 'react'; import { createRoot } from 'react-dom/client'; import { BrowserRouter } from 'react-router-dom'; import './theme/theme.css'; import { App } from './App';
import { ClerkProvider } from '@clerk/react';
import { AppErrorBoundary } from './ErrorBoundary';
import { initializeInstallUX } from './install';
import { observeServiceWorkerRegistration } from './service-worker';
import { initializeNotifications } from './notifications';

export function registerServiceWorker() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  // A dev worker would cache Vite's module graph and interfere with HMR.
  // Production still uses the finalized worker copied from public/.
  if (import.meta.env.DEV) return;
  try {
    void navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then(observeServiceWorkerRegistration).catch(() => undefined);
  } catch {
    // A restricted browser can throw before returning the registration promise.
  }
}

registerServiceWorker();
initializeInstallUX();
initializeNotifications();
// Clerk reads VITE_CLERK_PUBLISHABLE_KEY from the Vite environment. Keeping
// the key implicit here follows the current ClerkProvider setup and avoids a
// second client-side configuration source.
createRoot(document.getElementById('root')!).render(<React.StrictMode><ClerkProvider><AppErrorBoundary><BrowserRouter><App/></BrowserRouter></AppErrorBoundary></ClerkProvider></React.StrictMode>);
