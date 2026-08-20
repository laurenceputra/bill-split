import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { getNavigationContext } from './navigation';
import { consumeInstallPrompt, getInstallState, initializeInstallUX, subscribeInstall } from './install';
import { getOutboxSnapshot, initializeOutbox, subscribeOutbox } from './outbox';
import { getAuthState, getConnectionState, subscribeAuthState, subscribeConnectionState } from './api';

type IconName = 'groups' | 'activity' | 'add' | 'more';

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
  return <div className="app-shell"><TopBar /><AuthBanner /><main className="app-main">{children}</main><BottomNav /></div>;
}

export function useOnlineStatus() {
  return useSyncExternalStore((onChange) => { window.addEventListener('online', onChange); window.addEventListener('offline', onChange); return () => { window.removeEventListener('online', onChange); window.removeEventListener('offline', onChange); }; }, () => navigator.onLine, () => true);
}

function useInstall() {
  useEffect(() => initializeInstallUX(), []);
  return useSyncExternalStore(subscribeInstall, getInstallState, () => ({ installed: true, canPrompt: false, showIosHelp: false }));
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

export function InstallAction({ showStatus = false }: { showStatus?: boolean } = {}) {
  const install = useInstall();
  const [showHelp, setShowHelp] = useState(false);
  if (install.installed) return showStatus ? <p className="muted" role="status">BillSplit is installed on this device.</p> : null;
  return <div className="install-control"><button className="install-action" type="button" onClick={async () => { if (install.canPrompt) await consumeInstallPrompt(); else setShowHelp((value) => !value); }}>Install BillSplit</button>{(install.showIosHelp || showHelp) ? <span className="install-help">{install.showIosHelp ? <>Share <span aria-hidden="true">→</span> Add to Home Screen</> : 'Follow your browser instructions'}</span> : null}</div>;
}

function AuthBanner() {
  const online = useOnlineStatus();
  const auth = useAuthRequired();
  const reconnect = useReconnectRequired();
  if (!auth.required && !reconnect.reconnectRequired) return null;
  const message = auth.required ? 'Your secure session has expired. Reconnect to continue syncing; queued expenses remain on this device.' : 'The connection failed while you are online. Reconnect or check your session; queued expenses remain on this device.';
  return <div className="auth-banner" role="alert"><span>{message}</span><button type="button" disabled={!online} onClick={() => { if (online) window.location.assign(window.location.href); }}>{online ? 'Reconnect' : 'Reconnect when online'}</button></div>;
}

export function TopBar() {
  const online = useOnlineStatus();
  const outbox = useOutbox();
  const unsynced = outbox.length;
  return <header className="top-bar"><div className="top-bar__inner"><Link className="brand" to="/"><span className="brand-mark" aria-hidden="true">B</span>BillSplit</Link><div className="top-bar__actions"><span className={`network-indicator ${online ? 'network-indicator--online' : 'network-indicator--offline'}`} role="status">{online ? 'Online' : 'Offline'}{unsynced ? ` · ${unsynced} pending` : ''}</span><InstallAction />{import.meta.env.DEV && <label className="dev-identity"><span>Local identity</span><input aria-label="Local identity email" defaultValue={localStorage.getItem('dev-email') || 'dev@example.com'} onChange={(event) => localStorage.setItem('dev-email', event.target.value)} /></label>}</div></div></header>;
}

export function BottomNav() {
  const online = useOnlineStatus();
  const location = useLocation();
  const navigate = useNavigate();
  const context = getNavigationContext(location.pathname);
  const onAdd = () => navigate(context.addPath || '/?new=1');
  const isGroups = location.pathname === '/';
  const isActivity = Boolean(context.activityPath && location.pathname === context.activityPath);
  const isMore = location.pathname === context.morePath;

  return <nav className="bottom-nav" aria-label="Primary navigation">
    <Link className="nav-item" to={context.groupsPath} aria-current={isGroups ? 'page' : undefined}><Icon name="groups" /><span>Groups</span></Link>
    {context.activityPath && online ? <Link className="nav-item" to={context.activityPath} aria-current={isActivity ? 'page' : undefined}><Icon name="activity" /><span>Activity</span></Link> : <button className="nav-item" type="button" disabled title={online ? 'Open a group to view activity' : 'Activity requires a connection'}><Icon name="activity" /><span>Activity</span></button>}
    <button className="nav-item nav-item--add" type="button" onClick={onAdd}><Icon name="add" /><span>Add</span></button>
    {context.groupId && !online ? <button className="nav-item" type="button" disabled title="Settlements require a connection"><Icon name="more" /><span>Settle</span></button> : <Link className="nav-item" to={context.morePath} aria-current={isMore ? 'page' : undefined}><Icon name="more" /><span>{context.groupId ? 'Settle' : 'More'}</span></Link>}
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

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    previousFocus.current = document.activeElement as HTMLElement | null;
    const focusable = dialogRef.current?.querySelector<HTMLElement>('button, input, select, textarea, [tabindex]:not([tabindex="-1"])');
    focusable?.focus();
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
    return () => { document.removeEventListener('keydown', onKeyDown); previousFocus.current?.focus(); };
  }, []);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="modal-sheet" role="dialog" aria-modal="true" aria-labelledby="modal-title" ref={dialogRef}>
      <div className="modal-header"><h2 id="modal-title">{title}</h2><Button type="button" variant="secondary" onClick={onClose} aria-label="Close">Close</Button></div>
      {children}
    </div>
  </div>;
}
