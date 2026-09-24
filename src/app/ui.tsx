import { Link, useLocation, useNavigate } from 'react-router-dom';
import { cloneElement, isValidElement, useEffect, useId, useRef, useState, useSyncExternalStore, type ReactElement, type ReactNode, type SyntheticEvent } from 'react';
import { SignInButton, SignUpButton, useUser } from '@clerk/react';
import { getNavigationContext, getTransactionNavigation } from './navigation';
import { consumeInstallPrompt, getInstallState, initializeInstallUX, shouldShowTopbarInstall, subscribeInstall } from './install';
import { getOutboxSnapshot, initializeOutbox, subscribeOutbox } from './outbox';
import { getAuthLifecycle, getAuthState, getConnectionState, requestAuthProbe, sanitizeReturnTo, subscribeAuthLifecycle, subscribeAuthState, subscribeConnectionState, type AuthLifecycle, type ConnectionState } from './api';
import { applyServiceWorkerUpdate, getServiceWorkerUpdateState, subscribeServiceWorkerUpdate } from './service-worker';

export type IconName = 'groups' | 'activity' | 'settings' | 'add' | 'more' | 'check' | 'warning' | 'close';
const SERVER_INSTALL_STATE = Object.freeze({ mode: 'installed' as const, installed: true, canPrompt: false, showIosHelp: false });
let modalScrollLocks = 0;
let modalPreviousOverflow = '';

export function Icon({ name, className = 'nav-icon' }: { name: IconName; className?: string }) {
  if (name === 'add') return <svg className={className} viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>;
  if (name === 'check') return <svg className={className} viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>;
  if (name === 'warning') return <svg className={className} viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4 3.5 19h17L12 4Z" /><path d="M12 9v4m0 3h.01" /></svg>;
  if (name === 'close') return <svg className={className} viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>;
  if (name === 'activity') return <svg className={className} viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19V9m5 10V5m6 14v-7m5 7V3" /></svg>;
  if (name === 'settings') return <svg className={className} viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z" /><path d="m19 13.5 1.2 1-.9 1.6-1.5-.4a7.5 7.5 0 0 1-1.2 1.2l.4 1.5-1.6.9-1-1.2a7.5 7.5 0 0 1-1.7.2l-.7 1.4h-1.8l-.7-1.4a7.5 7.5 0 0 1-1.7-.2l-1 1.2-1.6-.9.4-1.5a7.5 7.5 0 0 1-1.2-1.2l-1.5.4-.9-1.6 1.2-1a7.5 7.5 0 0 1-.2-1.7l-1.4-.7v-1.8l1.4-.7a7.5 7.5 0 0 1 .2-1.7l-1.2-1 .9-1.6 1.5.4a7.5 7.5 0 0 1 1.2-1.2l-.4-1.5 1.6-.9 1 1.2a7.5 7.5 0 0 1 1.7-.2l.7-1.4h1.8l.7 1.4a7.5 7.5 0 0 1 1.7.2l1-1.2 1.6.9-.4 1.5a7.5 7.5 0 0 1 1.2 1.2l1.5-.4.9 1.6-1.2 1a7.5 7.5 0 0 1 .2 1.7l1.4.7v1.8l-1.4.7c0 .6-.1 1.2-.2 1.7Z" /></svg>;
  if (name === 'more') return <svg className={className} viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></svg>;
  return <svg className={className} viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20V8l8-4 8 4v12M8 20v-5h8v5M3 20h18" /></svg>;
}

export function LogoMark({ className = '' }: { className?: string }) {
  return <img className={`brand-logo ${className}`.trim()} src="/icons/logo-400.png" alt="" aria-hidden="true" />;
}

function Brand({ link = false }: { link?: boolean }) {
  const content = <><LogoMark /><span>BillSplit</span></>;
  return link ? <Link className="brand" to="/">{content}</Link> : <span className="brand">{content}</span>;
}

export function Button({ children, variant = 'primary', loading = false, className = '', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'quiet'; loading?: boolean }) {
  return <button {...props} className={`ui-button ${variant === 'primary' ? '' : `button--${variant}`} ${className}`.trim()} aria-busy={loading || undefined} disabled={loading || props.disabled}>{loading ? <span className="button__loading" aria-hidden="true" /> : null}{children}</button>;
}

export function Avatar({ name, src, size = 'md' }: { name: string; src?: string; size?: 'sm' | 'md' | 'lg' }) {
  const initials = name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || '?';
  return <span className={`avatar avatar--${size}`} role="img" aria-label={name}>{src ? <img src={src} alt="" /> : initials}</span>;
}

export function AvatarStack({ people, max = 4 }: { people: Array<{ name: string; src?: string }>; max?: number }) {
  const visible = people.slice(0, max);
  const remaining = Math.max(0, people.length - visible.length);
  return <span className="avatar-stack" aria-label={`${people.length} ${people.length === 1 ? 'person' : 'people'}`}>{visible.map((person) => <Avatar key={`${person.name}-${person.src || ''}`} {...person} size="sm" />)}{remaining ? <span className="avatar avatar--sm avatar--overflow" aria-label={`${remaining} more people`}>+{remaining}</span> : null}</span>;
}

export function Notice({ children, tone = 'neutral', role = 'status', className = '' }: { children: ReactNode; tone?: 'positive' | 'debt' | 'warning' | 'neutral'; role?: 'status' | 'alert'; className?: string }) {
  return <div className={`notice ui-notice notice--${tone} ${className}`.trim()} role={role}>{children}</div>;
}

export function Card({ children, className = '', as: Component = 'article' }: { children: ReactNode; className?: string; as?: 'article' | 'div' | 'section' }) {
  return <Component className={`card-surface ui-card-surface ${className}`.trim()}>{children}</Component>;
}

export function PageHeader({ eyebrow, title, description, actions, className = '', headingId }: { eyebrow?: ReactNode; title: ReactNode; description?: ReactNode; actions?: ReactNode; className?: string; headingId?: string }) {
  const generatedHeadingId = useId();
  const resolvedHeadingId = headingId || generatedHeadingId;
  const composedClassName = className.split(/\s+/).filter((token) => token && token !== 'page-title').join(' ');
  return <header className={`page-header ui-page-header ${composedClassName}`.trim()} aria-labelledby={resolvedHeadingId}><div>{eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}<h1 id={resolvedHeadingId}>{title}</h1>{description ? <p className="page-header__description">{description}</p> : null}</div>{actions ? <div className="page-header__actions ui-page-header__actions">{actions}</div> : null}</header>;
}

export function SectionHeader({ title, description, actions, className = '', level = 2 }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; className?: string; level?: 2 | 3 | 4 }) {
  const Heading = `h${level}` as 'h2' | 'h3' | 'h4';
  return <div className={`section-header ui-section-header ${className}`.trim()}><div><Heading>{title}</Heading>{description ? <p className="muted">{description}</p> : null}</div>{actions ? <div className="section-header__actions ui-section-header__actions">{actions}</div> : null}</div>;
}

/** A titled macro surface. The section remains the semantic boundary and the
 * caller decides whether its body is a list, state, or route composition. */
export function MacroSection({ title, description, actions, children, className = '', region }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string; region?: 'frequent' | 'admin' }) {
  const headingId = useId();
  return <section className={`ui-macro-section ${className}`.trim()} data-flow-region={region} aria-labelledby={headingId}><div className="ui-macro-section__header"><h2 id={headingId} className="ui-macro-section__heading">{title}</h2>{description ? <p className="ui-macro-section__description">{description}</p> : null}{actions ? <div className="ui-section-header__actions">{actions}</div> : null}</div><div className="ui-macro-section__body">{children}</div></section>;
}

export function LedgerList({ children, className = '', label, as: Component = 'ul' }: { children?: ReactNode; className?: string; label?: string; as?: 'ul' | 'div' }) {
  return <Component className={`ui-ledger-list ${className.split(/\s+/).filter((token) => token && token !== 'list').join(' ')}`.trim()} aria-label={label} role={Component === 'div' ? 'list' : undefined}>{children}</Component>;
}

export function LedgerRow({ children, className = '', as: Component = 'li' }: { children?: ReactNode; className?: string; as?: 'div' | 'li' | 'article' }) {
  return <Component className={`ui-ledger-row ${className.split(/\s+/).filter((token) => token && token !== 'row').join(' ')}`.trim()} role={Component === 'div' || Component === 'article' ? 'listitem' : undefined}>{children}</Component>;
}

export function Disclosure({ summary, children, className = '', open, onToggle, region }: { summary: ReactNode; children?: ReactNode; className?: string; open?: boolean; onToggle?: (event: SyntheticEvent<HTMLDetailsElement>) => void; region?: 'frequent' | 'admin' }) {
  return <details className={`ui-disclosure ${className}`.trim()} data-flow-region={region} open={open} onToggle={onToggle}><summary>{summary}</summary>{children}</details>;
}

export function FormSurface({ children, className = '', as: Component = 'section' }: { children?: ReactNode; className?: string; as?: 'section' | 'div' | 'article' }) {
  return <Component className={`ui-form-surface ${className.split(/\s+/).filter((token) => token && token !== 'surface').join(' ')}`.trim()}>{children}</Component>;
}

export function ActionGroup({ children, className = '', region }: { children: ReactNode; className?: string; region?: 'frequent' | 'admin' }) {
  return <div className={`ui-action-group ${className}`.trim()} data-flow-region={region}>{children}</div>;
}

export function ResourceState({ state, children, label, action, className = '' }: { state: 'loading' | 'cached' | 'offline' | 'empty' | 'error'; children?: ReactNode; label?: string; action?: ReactNode; className?: string }) {
  const message = state === 'loading' ? `Loading${label ? ` ${label}` : ''}…` : state === 'cached' ? `Showing cached${label ? ` ${label}` : ''}; it may be out of date.` : state === 'offline' ? `${label || 'This resource'} is unavailable offline.` : state === 'empty' ? `No ${label || 'items'} yet.` : `Could not load${label ? ` ${label}` : ''}.`;
  return <div className={`ui-resource-state ui-resource-state--${state} ${className}`.trim()} role={state === 'error' ? 'alert' : 'status'} aria-live="polite"><span>{children || message}</span>{action ? <span className="ui-action-group">{action}</span> : null}</div>;
}

export function EmptyState({ children, title, className = '' }: { children?: ReactNode; title?: ReactNode; className?: string }) {
  return <div className={`empty-state ui-empty-state ${className}`.trim()} role="status">{title ? <h2>{title}</h2> : null}{children}</div>;
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <span className={`skeleton ${className}`.trim()} aria-hidden="true" />;
}

/**
 * A data-free private-shaped shell for the short interval before auth is
 * authoritative. It intentionally does not use AppShell: TopBar and
 * AuthBanner can read private/session state and expose controls while that
 * state is still being verified.
 */
export function AuthLoadingShell() {
  return <div className="app-shell shell-frame shell-frame--app auth-loading-shell">
    <a className="skip-link" href="#main-content">Skip to main content</a>
    <header className="top-bar shell-header"><div className="top-bar__inner">
      <span aria-hidden="true"><Brand /></span>
      <div className="auth-loading-nav" aria-hidden="true"><Skeleton className="skeleton--nav-link" /><Skeleton className="skeleton--nav-link" /><Skeleton className="skeleton--nav-add" /><Skeleton className="skeleton--nav-link" /></div>
      <div className="auth-loading-actions" aria-hidden="true"><Skeleton className="skeleton--status" /><Skeleton className="skeleton--install" /></div>
    </div></header>
    <main className="app-main shell-main" id="main-content" tabIndex={-1} aria-busy="true">
      <div className="auth-loading-content">
        <div className="auth-loading-visual" aria-hidden="true"><Skeleton className="skeleton--eyebrow" /><Skeleton className="skeleton--title" /><Skeleton className="skeleton--paragraph" /><div className="skeleton--surface"><Skeleton className="skeleton--section-title" /><Skeleton className="skeleton--row" /><Skeleton className="skeleton--row" /></div></div>
        <p className="auth-loading-status" role="status" aria-live="polite">Loading…</p>
      </div>
    </main>
     <nav className="bottom-nav shell-nav" aria-hidden="true"><span className="nav-item"><span className="nav-item__content"><span className="nav-item__icon"><Skeleton className="skeleton--nav-icon" /></span><span className="nav-item__label"><Skeleton className="skeleton--nav-label" /></span></span></span><span className="nav-item"><span className="nav-item__content"><span className="nav-item__icon"><Skeleton className="skeleton--nav-icon" /></span><span className="nav-item__label"><Skeleton className="skeleton--nav-label" /></span></span></span><span className="nav-item nav-item--add"><span className="nav-item__capsule"><span className="nav-item__content"><span className="nav-item__icon"><Skeleton className="skeleton--nav-icon" /></span><span className="nav-item__label"><Skeleton className="skeleton--nav-label" /></span></span></span></span><span className="nav-item"><span className="nav-item__content"><span className="nav-item__icon"><Skeleton className="skeleton--nav-icon" /></span><span className="nav-item__label"><Skeleton className="skeleton--nav-label" /></span></span></span></nav>
  </div>;
}

export function AppShell({ children }: { children: ReactNode }) {
  const nestedMain = isValidElement<{ className?: string; 'aria-labelledby'?: string; children?: ReactNode }>(children) && children.type === 'main' ? children : undefined;
  const nestedProps = nestedMain?.props;
  return <div className="app-shell shell-frame shell-frame--app"><a className="skip-link" href="#main-content">Skip to main content</a><TopBar /><AuthBanner /><main className={`app-main shell-main${nestedProps?.className ? ` ${nestedProps.className}` : ''}`} id="main-content" tabIndex={-1} aria-labelledby={nestedProps?.['aria-labelledby']}>{nestedMain ? nestedMain.props.children : children}</main><BottomNav /></div>;
}

export function PublicShell({ children, returnTo = '/', showAuthActions = true }: { children: ReactNode; returnTo?: string; showAuthActions?: boolean }) {
  const safeReturnTo = sanitizeReturnTo(returnTo);
  return <div className="public-shell shell-frame shell-frame--public"><a className="skip-link" href="#public-main-content">Skip to main content</a><header className="public-header shell-header"><Brand link />{showAuthActions ? <span className="public-auth-actions"><SignInButton mode="modal" fallbackRedirectUrl={safeReturnTo}><button className="public-sign-in" type="button">Sign in</button></SignInButton><SignUpButton mode="modal" fallbackRedirectUrl={safeReturnTo}><button className="public-sign-up" type="button">Sign up</button></SignUpButton></span> : null}</header><main className="public-main shell-main" id="public-main-content" tabIndex={-1}>{children}</main></div>;
}

export function useConnectionState(): ConnectionState {
  return useSyncExternalStore(subscribeConnectionState, getConnectionState, () => ({ status: 'checking' as const, reconnectRequired: false }));
}

/** Compatibility helper for controls: only a verified usable connection is online. */
export function useOnlineStatus() {
  const connection = useConnectionState();
  const auth = useSyncExternalStore(subscribeAuthLifecycle, getAuthLifecycle, () => ({ status: 'checking' as const }));
  return connection.status === 'connected' && auth.status === 'authenticated';
}

export function useAuthLifecycle(): AuthLifecycle {
  return useSyncExternalStore(subscribeAuthLifecycle, getAuthLifecycle, () => ({ status: 'checking' as const }));
}

export const connectionStatusLabel = (status: ConnectionState['status']) => ({
  connected: 'Connected',
  checking: 'Checking connection',
  'connection-issue': 'Connection issue',
  offline: 'Offline',
}[status]);

function useInstall() {
  useEffect(() => initializeInstallUX(), []);
  return useSyncExternalStore(subscribeInstall, getInstallState, () => SERVER_INSTALL_STATE);
}

function useAuthRequired() {
  return useSyncExternalStore(subscribeAuthState, getAuthState, () => ({ required: false }));
}

function useOutbox() {
  useEffect(() => { void initializeOutbox(); }, []);
  return useSyncExternalStore(subscribeOutbox, getOutboxSnapshot, () => []);
}

function useServiceWorkerUpdate() {
  return useSyncExternalStore(subscribeServiceWorkerUpdate, getServiceWorkerUpdateState, () => ({ updateReady: false, applying: false, blocked: false }));
}

// Keep the shell renderable in isolated/static states (for example, a route
// placeholder rendered before the Clerk provider is mounted). The application
// normally always has the provider, but the navigation does not need to make
// the cached/loading surface impossible to render without it.
function useOptionalUser() {
  try {
    return useUser().user;
  } catch {
    return undefined;
  }
}

export function ServiceWorkerUpdate() {
  const update = useServiceWorkerUpdate();
  if (!update.updateReady && !update.applying && !update.blocked) return null;
  const message = update.applying ? 'Applying update…' : update.blocked ? 'Finish your current entry before updating.' : 'A new BillSplit version is ready.';
  return <div className="update-control" role="status" aria-live="polite"><span>{message}</span>{!update.applying ? <button className="update-action" type="button" onClick={() => { applyServiceWorkerUpdate(); }}>{update.blocked ? 'Apply when ready' : 'Update'}</button> : null}</div>;
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
  const connection = useConnectionState();
  const auth = useAuthRequired();
  const lifecycle = useAuthLifecycle();
  const restoring = lifecycle.status === 'restoring';
  const reverifying = lifecycle.status === 'reverifying';
  const provisional = lifecycle.status === 'provisional';
  const trustedOffline = lifecycle.status === 'trusted-offline';
  if (!auth.required && !restoring && !reverifying && !provisional && !trustedOffline && connection.status !== 'connection-issue' && connection.status !== 'checking') return null;
  if (restoring || reverifying || provisional || trustedOffline) {
    const message = restoring ? 'Restoring your session…' : reverifying ? 'Checking your session…' : provisional ? 'Showing your trusted cached data while your session is verified…' : 'Trusted offline · New expenses can be saved on this device and will sync after verification.';
    return <div className="auth-banner auth-banner--checking" role="status" aria-live="polite">{message}</div>;
  }
  const checking = !auth.required && connection.status === 'checking';
  const message = auth.required ? 'Your secure session has expired. Sign in again to continue syncing; queued expenses remain on this device.' : checking ? 'Checking connection before resuming sync; queued expenses remain on this device.' : 'Connection issue. Retry to revalidate; queued expenses remain on this device.';
  const returnTo = sanitizeReturnTo(`${window.location.pathname}${window.location.search}${window.location.hash}`);
   const retry = () => { void requestAuthProbe({ networkOnly: true }); };
  return <div className={`auth-banner${checking ? ' auth-banner--checking' : ''}`} role={checking ? 'status' : 'alert'}><span>{message}</span>{auth.required ? <SignInButton mode="modal" fallbackRedirectUrl={returnTo}><button type="button">Sign in</button></SignInButton> : checking ? <Button type="button" variant="secondary" onClick={retry}>Retry connection</Button> : <Button type="button" onClick={retry}>Retry connection</Button>}</div>;
}

export function SplitTransactionControl({ groupId, online, compact = false, mobileNav = false, className = '', active = false, primaryCurrent = false, primaryAriaLabel }: { groupId?: string; online?: boolean; compact?: boolean; mobileNav?: boolean; className?: string; active?: boolean; primaryCurrent?: boolean; primaryAriaLabel?: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const detectedOnline = useOnlineStatus();
  const navigation = getTransactionNavigation(groupId, online ?? detectedOnline);
  const [selection, setSelection] = useState('');
  const selectId = useId();
  const alternativesAvailable = navigation.options.some((option) => !option.disabled && option.path);
  const menuDisabled = !alternativesAvailable;
  const unavailableReason = navigation.options.some((option) => option.label.includes('(online only)'))
    ? 'Refunds and payments require a connection.'
    : 'Choose a group first to record a refund or payment.';
  const menuLabel = menuDisabled ? `More transaction types unavailable: ${unavailableReason}` : 'Choose transaction type';
  const menuTitle = menuDisabled ? unavailableReason : 'Choose transaction type';
  const descriptionId = `${selectId}-description`;
  const chooseTransaction = (value: string) => {
    const option = navigation.options.find((candidate) => candidate.value === value);
    setSelection('');
    if (!option || option.disabled || !option.path) return;
    navigate(option.path);
  };
  useEffect(() => { setSelection(''); }, [location.pathname, location.search, groupId, online]);
  return <div className={`split-transaction-control${className ? ` ${className}` : ''}${active ? ' split-transaction-control--active' : ''}`} role="group" aria-label="Add transaction">
    <Link className="split-transaction-control__primary" data-primary-action="true" to={navigation.primaryPath} aria-label={primaryAriaLabel ?? navigation.primaryAriaLabel} aria-current={primaryCurrent ? 'page' : undefined}>{mobileNav ? <span className="nav-item__content"><span className="nav-item__icon"><svg className="nav-item__glyph nav-item__glyph--add" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3v14M3 10h14" /></svg></span><span className="nav-item__label">Add</span></span> : compact ? 'Add expense' : navigation.primaryLabel}</Link>
    <select id={selectId} className="split-transaction-control__menu" aria-label={menuLabel} title={menuTitle} aria-describedby={menuDisabled ? descriptionId : undefined} disabled={menuDisabled} value={selection} onChange={(event) => chooseTransaction(event.target.value)}>
      <option value="">More transaction types</option>
      {navigation.options.map((option) => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
    </select>
    {menuDisabled ? <span id={descriptionId} className="sr-only">{unavailableReason}</span> : null}
  </div>;
}

export function TopBar() {
  const connection = useConnectionState();
  const outbox = useOutbox();
  const user = useOptionalUser();
  const unsynced = outbox.length;
  const identityName = user?.fullName || user?.firstName || user?.primaryEmailAddress?.emailAddress || 'Signed-in user';
  return <header className="top-bar shell-header"><div className="top-bar__inner"><Brand link /><DesktopNav /><div className="top-bar__actions"><span className={`network-indicator network-indicator--${connection.status}`} role="status">{connectionStatusLabel(connection.status)}{unsynced ? ` · ${unsynced} pending` : ''}</span><ServiceWorkerUpdate /><div className="install-slot"><InstallAction /></div><span className="desktop-user-avatar"><Avatar name={identityName} src={user?.imageUrl} size="sm" /></span>{import.meta.env.DEV && <label className="dev-identity"><span>Local identity</span><input aria-label="Local identity email" defaultValue={localStorage.getItem('dev-email') || 'dev@example.com'} onChange={(event) => localStorage.setItem('dev-email', event.target.value)} /></label>}</div></div></header>;
}

function DesktopNav() {
  const location = useLocation();
  const online = useOnlineStatus();
  const context = getNavigationContext(location.pathname, location.search);
  return <nav className="desktop-nav" aria-label="Primary navigation">
    <Link className="desktop-nav__item" to={context.primaryPath} aria-current={context.activeSection === 'groups' ? 'page' : undefined}>Groups</Link>
     <Link className="desktop-nav__item" to={context.historyPath} aria-current={context.activeSection === 'activity' ? 'page' : undefined}>History</Link>
     <SplitTransactionControl className="desktop-nav__add" groupId={context.groupContext?.id} online={online} compact active={context.activeSection === 'add' || context.activeSection === 'settle'} primaryCurrent={context.primaryIsCurrent} />
     <Link className="desktop-nav__item" to="/settings" aria-current={context.activeSection === 'settings' ? 'page' : undefined}>Settings</Link>
  </nav>;
}

export function BottomNav() {
  const location = useLocation();
  const online = useOnlineStatus();
  const context = getNavigationContext(location.pathname, location.search);

  return <nav className="bottom-nav shell-nav" aria-label="Primary navigation">
    <Link className="nav-item" to={context.groupsPath} aria-current={context.activeSection === 'groups' ? 'page' : undefined}><span className="nav-item__content"><span className="nav-item__icon"><Icon name="groups" /></span><span className="nav-item__label">Groups</span></span></Link>
    <Link className="nav-item" to={context.historyPath} aria-current={context.activeSection === 'activity' ? 'page' : undefined}><span className="nav-item__content"><span className="nav-item__icon"><Icon name="activity" /></span><span className="nav-item__label">History</span></span></Link>
    <div className={`nav-item nav-item--add${context.activeSection === 'add' || context.activeSection === 'settle' ? ' nav-item--add--active' : ''}`}><SplitTransactionControl className="nav-item__capsule" groupId={context.groupContext?.id} online={online} compact mobileNav active={context.activeSection === 'add' || context.activeSection === 'settle'} primaryCurrent={context.primaryIsCurrent} /></div>
    <Link className="nav-item" to={context.morePath} aria-current={context.activeSection === 'settings' ? 'page' : undefined}><span className="nav-item__content"><span className="nav-item__icon"><Icon name="settings" /></span><span className="nav-item__label">Settings</span></span></Link>
  </nav>;
}

export function Layout({ children }: { children: ReactNode }) {
  const location = useLocation();
  const routeClass = location.pathname === '/' ? 'home' : location.pathname === '/activity' ? 'history' : location.pathname === '/settings' ? 'settings' : location.pathname.includes('/manage') ? 'group-management' : location.pathname.includes('/credit') || location.pathname.includes('/refund') ? 'credit' : location.pathname.includes('/settle') || location.pathname.includes('/settlements') ? 'settlement' : location.pathname.includes('/expense') || location.pathname.includes('/scheduled-expense') ? 'expense' : location.pathname.match(/^\/groups\/(?!new$)[^/]+$/) ? 'group-overview' : 'default';
  useEffect(() => {
    let frame = 0;
    let timeout = 0;
    let observer: MutationObserver | undefined;
    const setTimer = (callback: () => void, delay: number) => typeof window.setTimeout === 'function'
      ? window.setTimeout(callback, delay)
      : globalThis.setTimeout(callback, delay) as unknown as number;
    const clearTimer = (handle: number) => {
      if (typeof window.clearTimeout === 'function') window.clearTimeout(handle);
      else globalThis.clearTimeout(handle);
    };
    const scheduleFrame = (callback: () => void) => typeof window.requestAnimationFrame === 'function'
      ? window.requestAnimationFrame(callback)
      : (typeof globalThis.queueMicrotask === 'function' ? (globalThis.queueMicrotask(callback), 0) : setTimer(callback, 0));
    const cancelFrame = (handle: number) => {
      if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(handle);
      else clearTimer(handle);
    };
    let targetId = location.hash.slice(1);
    try { targetId = decodeURIComponent(targetId); } catch { /* Keep the raw hash when it is malformed. */ }
    const restore = () => {
      if (!location.hash) {
        if (typeof window.scrollTo === 'function') window.scrollTo(0, 0);
        return true;
      }
      const target = document.getElementById(targetId);
      if (!(target instanceof HTMLElement)) return false;
      if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'start', inline: 'nearest' });
      if (typeof target.focus === 'function') target.focus({ preventScroll: true });
      observer?.disconnect();
      if (timeout) clearTimer(timeout);
      return true;
    };
    frame = scheduleFrame(() => {
      if (restore() || !location.hash) return;
      observer = new MutationObserver(() => { restore(); });
      observer.observe(document.body, { childList: true, subtree: true });
      timeout = setTimer(() => { observer?.disconnect(); }, 2_000);
    });
    return () => { cancelFrame(frame); observer?.disconnect(); if (timeout) clearTimer(timeout); };
  }, [location.pathname, location.search, location.hash]);
  return <AppShell><div className={`route-view route-view--${routeClass}`}>{children}</div></AppShell>;
}

export function Surface({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <Card as="div" className={`ui-surface ${className.split(/\s+/).filter((token) => token && token !== 'surface').join(' ')}`.trim()}>{children}</Card>;
}

export function Field({ label, children, className = '', error, errorId }: { label: string; children: ReactNode; className?: string; error?: string; errorId?: string }) {
  const childProps = isValidElement(children) ? (children as ReactElement<Record<string, unknown>>).props : undefined;
  const describedBy = typeof childProps?.['aria-describedby'] === 'string' ? childProps['aria-describedby'] : undefined;
  const resolvedErrorId = errorId || describedBy?.split(/\s+/)[0] || `${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-error`;
  const describedByTokens = describedBy?.split(/\s+/).filter(Boolean) || [];
  const describedChild = error && isValidElement(children) ? cloneElement(children as ReactElement<Record<string, unknown>>, { 'aria-invalid': true, 'aria-describedby': [...new Set([...describedByTokens, resolvedErrorId])].join(' ') }) : children;
  return <label className={`field ${className}`.trim()}><span>{label}</span>{describedChild}{error ? <small id={resolvedErrorId} className="field-error" role="alert">{error}</small> : null}</label>;
}

export function Money({ amountMinor, currency, tone, size = 'normal' }: { amountMinor: number; currency: string; tone?: 'positive' | 'debt'; size?: 'normal' | 'large' }) {
  return <strong className={`money money--${size}${tone ? ` money--${tone}` : ''}`}>{new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amountMinor / 100)}</strong>;
}

export function Status({ children, tone }: { children: ReactNode; tone: 'positive' | 'debt' | 'warning' | 'neutral' }) {
  return <span className={`status ui-status status--${tone}`}>{children}</span>;
}

export function Modal({ title, description, children, onClose, className = '' }: { title: string; description?: ReactNode; children: ReactNode; onClose: () => void; className?: string }) {
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
  return <div className="modal-backdrop ui-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className={`modal-sheet ui-modal ${className}`.trim()} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined} tabIndex={-1} ref={dialogRef}>
      <div className="modal-header"><h2 id={titleId}>{title}</h2><Button type="button" variant="secondary" onClick={onClose} aria-label="Close">Close</Button></div>
      {description ? <div id={descriptionId} className="modal-description">{description}</div> : null}
      {children}
    </div>
  </div>;
}
