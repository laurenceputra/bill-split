import React from 'react'; import { createRoot } from 'react-dom/client'; import { BrowserRouter } from 'react-router-dom'; import './theme/theme.css'; import { App } from './App';
import { AppErrorBoundary } from './ErrorBoundary';
import { initializeInstallUX } from './install';
initializeInstallUX();
createRoot(document.getElementById('root')!).render(<React.StrictMode><AppErrorBoundary><BrowserRouter><App/></BrowserRouter></AppErrorBoundary></React.StrictMode>);
if('serviceWorker' in navigator) window.addEventListener('load',()=>navigator.serviceWorker.register('/sw.js').then((registration) => { registration.update().catch(() => undefined); }).catch(()=>undefined));
