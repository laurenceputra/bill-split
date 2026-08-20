import React from 'react'; import { createRoot } from 'react-dom/client'; import { BrowserRouter } from 'react-router-dom'; import './theme/theme.css'; import { App } from './App';
import { initializeInstallUX } from './install';
createRoot(document.getElementById('root')!).render(<React.StrictMode><BrowserRouter><App/></BrowserRouter></React.StrictMode>);
initializeInstallUX();
if('serviceWorker' in navigator) window.addEventListener('load',()=>navigator.serviceWorker.register('/sw.js').then((registration) => { registration.update().catch(() => undefined); }).catch(()=>undefined));
