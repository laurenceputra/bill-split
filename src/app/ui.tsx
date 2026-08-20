import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useRef, type ReactNode } from 'react';
import { getNavigationContext } from './navigation';

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
  return <div className="app-shell"><TopBar /><main className="app-main">{children}</main><BottomNav /></div>;
}

export function TopBar() {
  return <header className="top-bar"><div className="top-bar__inner"><Link className="brand" to="/"><span className="brand-mark" aria-hidden="true">B</span>BillSplit</Link>{import.meta.env.DEV && <label className="dev-identity"><span>Local identity</span><input aria-label="Local identity email" defaultValue={localStorage.getItem('dev-email') || 'dev@example.com'} onChange={(event) => localStorage.setItem('dev-email', event.target.value)} /></label>}</div></header>;
}

export function BottomNav() {
  const location = useLocation();
  const navigate = useNavigate();
  const context = getNavigationContext(location.pathname);
  const onAdd = () => navigate(context.addPath || '/?new=1');
  const isGroups = location.pathname === '/';
  const isActivity = Boolean(context.activityPath && location.pathname === context.activityPath);

  return <nav className="bottom-nav" aria-label="Primary navigation">
    <Link className="nav-item" to={context.groupsPath} aria-current={isGroups ? 'page' : undefined}><Icon name="groups" /><span>Groups</span></Link>
    {context.activityPath ? <Link className="nav-item" to={context.activityPath} aria-current={isActivity ? 'page' : undefined}><Icon name="activity" /><span>Activity</span></Link> : <button className="nav-item" type="button" disabled title="Open a group to view activity"><Icon name="activity" /><span>Activity</span></button>}
    <button className="nav-item nav-item--add" type="button" onClick={onAdd}><Icon name="add" /><span>Add</span></button>
    <Link className="nav-item" to={context.morePath}><Icon name="more" /><span>{context.groupId ? 'Settle' : 'More'}</span></Link>
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
