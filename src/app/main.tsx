import React from 'react'; import { createRoot } from 'react-dom/client'; import { BrowserRouter } from 'react-router-dom'; import './theme/theme.css'; import { App } from './App';
import { AppErrorBoundary } from './ErrorBoundary';
import { initializeInstallUX } from './install';

export function registerServiceWorker() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  try {
    void navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then((registration) => registration.update().catch(() => undefined)).catch(() => undefined);
  } catch {
    // A restricted browser can throw before returning the registration promise.
  }
}

registerServiceWorker();
initializeInstallUX();
createRoot(document.getElementById('root')!).render(<React.StrictMode><AppErrorBoundary><BrowserRouter><App/></BrowserRouter></AppErrorBoundary></React.StrictMode>);
