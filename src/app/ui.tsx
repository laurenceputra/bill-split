import { Link, useLocation } from 'react-router-dom';
import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { getNavigationContext } from './navigation';
import { consumeInstallPrompt, getInstallState, initializeInstallUX, shouldShowTopbarInstall, subscribeInstall } from './install';
import { getOutboxSnapshot, initializeOutbox, subscribeOutbox } from './outbox';
import { authBootstrapUrl, getAuthState, getConnectionState, subscribeAuthState, subscribeConnectionState } from './api';

type IconName = 'groups' | 'activity' | 'add' | 'more';
const SERVER_INSTALL_STATE = Object.freeze({ mode: 'installed' as const, installed: true, canPrompt: false, showIosHelp: false });
let modalScrollLocks = 0;
let modalPreviousOverflow = '';

function Icon({ name }: { name: IconName }) {
  if (name === 'add') return <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>;
  if (name === 'activity') return <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19V9m5 10V5m6 14v-7m5 7V3" /></svg>;
  if (name === 'more') return <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></svg>;
  return <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20V8l8-4 8 4v12M8 20v-5h8v5M3 20h18" /></svg>;
}

export function Button({ children, variant = 'primary', className = '', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' }) {
  return <button className={`${variant === 'primary' ? '' : `button--${variant}`} ${className}`.trim()} {...props}>{children}</button>;
}

export function AppShell({ children }: { children: ReactNode }) {
  return <div className="app-shell"><a className="skip-link" href="#main-content">Skip to main content</a><TopBar /><AuthBanner /><main className="app-main" id="main-content" tabIndex={-1}>{children}</main><BottomNav /></div>;
}

export function PublicShell({ children, returnTo = '/' }: { children: ReactNode; returnTo?: string }) {
  return <div className="public-shell"><a className="skip-link" href="#public-main-content">Skip to main content</a><header className="public-header"><Link className="brand" to="/"><span className="brand-mark" aria-hidden="true">B</span>BillSplit</Link><a className="public-sign-in" href={authBootstrapUrl(returnTo)}>Sign in</a></header><main className="public-main" id="public-main-content" tabIndex={-1}>{children}</main></div>;
}

export function useOnlineStatus() {
  return useSyncExternalStore((onChange) => { window.addEventListener('online', onChange); window.addEventListener('offline', onChange); return () => { window.removeEventListener('online', onChange); window.removeEventListener('offline', onChange); }; }, () => navigator.onLine, () => true);
}

function useInstall() {
  useEffect(() => initializeInstallUX(), []);
  return useSyncExternalStore(subscribeInstall, getInstallState, () => SERVER_INSTALL_STATE);
}

function useAuthRequired() {
  return useSyncExternalStore(subscribeAuthState, getAuthState, () => ({ required: false }));
}

function useReconnectRequired() {
  return useSyncExternalStore(subscribeConnectionState, getConnectionState, () => ({ reconnectRequired: false }));
}

function useOutbox() {
  useEffect(() => { void initializeOutbox(); }, []);
  return useSyncExternalStore(subscribeOutbox, getOutboxSnapshot, () => []);
}

export function InstallAction({ showStatus = false, label = 'Install' }: { showStatus?: boolean; label?: string } = {}) {
  const install = useInstall();
  const [showHelp, setShowHelp] = useState(false);
  if (install.installed) return showStatus ? <p className="muted" role="status">BillSplit is installed on this device.</p> : null;
  if (install.mode === 'prompting') {
    return showStatus
      ? <p className="muted install-status" role="status">Opening the browser install prompt…</p>
      : <div className="install-control"><button className="install-action" type="button" disabled aria-busy="true">{label}</button></div>;
  }
  if (!shouldShowTopbarInstall(install)) {
    if (!showStatus) return null;
    const message = install.mode === 'dismissed'
      ? 'Install prompt dismissed. Use your browser menu whenever you want to install BillSplit.'
      : install.mode === 'accepted'
        ? 'Installation was accepted. If BillSplit is not on your Home Screen, use your browser menu to finish installing it.'
      : install.mode === 'error'
        ? 'Native install could not be opened. Use your browser menu to install BillSplit.'
        : 'Native install cannot be triggered here. Use your browser menu to install BillSplit.';
    return <p className="muted install-status" role="status">{message}</p>;
  }

  const ios = install.mode === 'ios-manual';
  return <>
    <div className="install-control"><button className="install-action" type="button" onClick={() => { if (install.mode === 'native-prompt-available') void consumeInstallPrompt(); else setShowHelp(true); }}>{label}</button></div>
    {ios && showHelp ? <Modal title="Install BillSplit" description="Add BillSplit to your Home Screen for a faster, app-like experience." onClose={() => setShowHelp(false)}><ol className="install-instructions"><li>Open the <strong>Share</strong> menu in your browser.</li><li>Choose <strong>Add to Home Screen</strong>.</li><li>Confirm by tapping <strong>Add</strong>.</li></ol></Modal> : null}
  </>;
}

function AuthBanner() {
  const online = useOnlineStatus();
  const auth = useAuthRequired();
  const reconnect = useReconnectRequired();
  if (!auth.required && !reconnect.reconnectRequired) return null;
  const message = auth.required ? 'Your secure session has expired. Reconnect to continue syncing; queued expenses remain on this device.' : 'The connection failed while you are online. Reconnect or check your session; queued expenses remain on this device.';
  return <div className="auth-banner" role="alert"><span>{message}</span><button type="button" disabled={!online} onClick={() => { if (online) window.location.assign(authBootstrapUrl(`${window.location.pathname}${window.location.search}${window.location.hash}`)); }}>{online ? 'Reconnect' : 'Reconnect when online'}</button></div>;
}

export function TopBar() {
  const online = useOnlineStatus();
  const outbox = useOutbox();
  const unsynced = outbox.length;
  return <header className="top-bar"><div className="top-bar__inner"><Link className="brand" to="/"><span className="brand-mark" aria-hidden="true">B</span>BillSplit</Link><DesktopNav /><div className="top-bar__actions"><span className={`network-indicator ${online ? 'network-indicator--online' : 'network-indicator--offline'}`} role="status">{online ? 'Online' : 'Offline'}{unsynced ? ` · ${unsynced} pending` : ''}</span><div className="install-slot"><InstallAction /></div>{import.meta.env.DEV && <label className="dev-identity"><span>Local identity</span><input aria-label="Local identity email" defaultValue={localStorage.getItem('dev-email') || 'dev@example.com'} onChange={(event) => localStorage.setItem('dev-email', event.target.value)} /></label>}</div></div></header>;
}

function DesktopNav() {
  const location = useLocation();
  const context = getNavigationContext(location.pathname);
  return <nav className="desktop-nav" aria-label="Primary navigation">
    <Link className="desktop-nav__item" to={context.primaryPath} aria-current={context.activeSection === 'groups' ? 'page' : undefined}>Groups</Link>
    {context.activityPath ? <Link className="desktop-nav__item" to={context.activityPath} aria-current={context.activeSection === 'activity' ? 'page' : undefined}>Activity</Link> : null}
    <Link className="desktop-nav__item desktop-nav__add" to={context.addPath} aria-current={context.activeSection === 'add' ? 'page' : undefined}><Icon name="add" /><span>{context.addLabel}</span></Link>
    {context.groupId ? <Link className="desktop-nav__item" to={context.morePath} aria-current={context.activeSection === 'settle' ? 'page' : undefined}>Settle</Link> : null}
    <Link className="desktop-nav__item" to="/settings" aria-current={context.activeSection === 'settings' ? 'page' : undefined}>Settings</Link>
  </nav>;
}

export function BottomNav() {
  const location = useLocation();
  const context = getNavigationContext(location.pathname);

  return <nav className="bottom-nav" aria-label="Primary navigation">
    <Link className="nav-item" to={context.groupsPath} aria-current={context.activeSection === 'groups' ? 'page' : undefined}><Icon name="groups" /><span>Groups</span></Link>
    {context.activityPath ? <Link className="nav-item" to={context.activityPath} aria-current={context.activeSection === 'activity' ? 'page' : undefined}><Icon name="activity" /><span>Activity</span></Link> : <button className="nav-item" type="button" disabled title="Open a group to view activity"><Icon name="activity" /><span>Activity</span></button>}
    <Link className="nav-item nav-item--add" to={context.addPath} aria-label={context.addLabel} aria-current={context.activeSection === 'add' ? 'page' : undefined}><span className="nav-item__capsule"><Icon name="add" /><span>Add</span></span></Link>
    {context.groupId ? <Link className="nav-item" to={context.morePath} aria-current={context.activeSection === 'settle' ? 'page' : undefined}><Icon name="more" /><span>Settle</span></Link> : <Link className="nav-item" to={context.morePath} aria-current={context.activeSection === 'settings' ? 'page' : undefined}><Icon name="more" /><span>Settings</span></Link>}
  </nav>;
}

export function Layout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}

export function Surface({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`surface ${className}`.trim()}>{children}</div>;
}

export function Field({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  return <label className={`field ${className}`.trim()}><span>{label}</span>{children}</label>;
}

export function Money({ amountMinor, currency, tone, size = 'normal' }: { amountMinor: number; currency: string; tone?: 'positive' | 'debt'; size?: 'normal' | 'large' }) {
  return <strong className={`money money--${size}${tone ? ` money--${tone}` : ''}`}>{new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amountMinor / 100)}</strong>;
}

export function Status({ children, tone }: { children: ReactNode; tone: 'positive' | 'debt' }) {
  return <span className={`status status--${tone}`}>{children}</span>;
}

export function Modal({ title, description, children, onClose }: { title: string; description?: ReactNode; children: ReactNode; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const titleId = useId();
  const descriptionId = useId();
  onCloseRef.current = onClose;
  useEffect(() => {
    previousFocus.current = document.activeElement as HTMLElement | null;
    if (modalScrollLocks === 0) modalPreviousOverflow = document.body.style.overflow;
    modalScrollLocks += 1;
    document.body.style.overflow = 'hidden';
    const focusable = dialogRef.current?.querySelector<HTMLElement>('button, input, select, textarea, [tabindex]:not([tabindex="-1"])');
    (focusable || dialogRef.current)?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current();
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const items = [...dialogRef.current.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((item) => !item.hasAttribute('disabled'));
      if (!items.length) return;
      const first = items[0]; const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('keydown', onKeyDown); modalScrollLocks = Math.max(0, modalScrollLocks - 1); if (!modalScrollLocks) document.body.style.overflow = modalPreviousOverflow; previousFocus.current?.focus(); };
  }, []);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="modal-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined} tabIndex={-1} ref={dialogRef}>
      <div className="modal-header"><h2 id={titleId}>{title}</h2><Button type="button" variant="secondary" onClick={onClose} aria-label="Close">Close</Button></div>
      {description ? <div id={descriptionId} className="modal-description">{description}</div> : null}
      {children}
    </div>
  </div>;
}
