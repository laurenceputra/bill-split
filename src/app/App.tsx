import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { SignInButton, SignUpButton, useAuth, useClerk } from '@clerk/react';
import type { Activity as ActivityItem, Balances, Currency, Expense, Group, GroupMember, RecurrenceFrequency, ScheduledExpense, ScheduledExpenseStatus, Settlement, SplitMethod, Weekday } from '../shared/types';
import { currencyOptions, type ExpenseInput, type ScheduledExpenseInput } from '../shared/schemas';
import { checkedSumMinor, formatMoney, parseMoney } from '../domain/money';
import { ApiError, api, changeScheduledExpenseStatus, createScheduledExpense, getActivity, getAuthLifecycle, getBalances, getExpenseDetails, getExpenses, getGroup, getGroups, getMe, getScheduledExpense, getScheduledExpenses, getSettlements, hydrateActivity, hydrateBalances, hydrateExpenseDetails, hydrateExpenses, hydrateGroup, hydrateGroups, hydrateIdentity, hydrateSettlements, updateScheduledExpense, getTrustedOfflineClerkUserId, initializeAuthLifecycle, isDefinitivelySignedOut, isDevelopmentAuthBypass, isMeaningfulClerkSessionTransition, isTrustedOfflineClerkUserIdHydrated, markSignedOut, recoverAfterClerkSignOutFailure, resetForClerkSessionChange, revokeForClerkSessionChange, shouldRevokeForOfflineClerkUser, shouldReverifyTrustedOffline, shouldStartAuthCheck, subscribeAuthLifecycle, clearEverythingForLogout } from './api';
import { allocationMetadataByPerson, allocationSplits, allocationStateFromSplits, amountFieldClass, amountInputClass, amountInputLength, currentPayerSelection, formServerVersion, hasNewerServerVersion, isExpenseConflict, normalizeSinglePayer, previewAllocation, settlementSuggestion, settlementSuggestionFingerprint, type AllocationState } from './form-helpers';
import { Button, Field, InstallAction, Layout, Modal, Money, PublicShell, Status, Surface, useOnlineStatus } from './ui';
import { discardOutboxItem, enqueueExpense, flushOutbox, getOutboxSnapshot, initializeOutbox, retryOutboxItem, statusLabel, subscribeOutbox, type ExpenseOutboxItem } from './outbox';
import { clearCachedData } from './idb';
import { getResourceSnapshot, invalidateForMutation, invalidateResource, revalidate, RESOURCE_FRESHNESS, resourceKeys, resourceViewState, useResource, useResourceIdentityEpoch, type ResourceSnapshot } from './resource-cache';
import { groupBalanceDisplays } from './group-balance';
import { activityDetailPath, expenseDetailPath } from './navigation';
import { captureSessionGeneration, getSessionLogoutInProgress, subscribeSessionState } from './session';
import { browserTimezone, previewScheduleDates, scheduleSummary, weekdayLabels } from './scheduled-expense';
import { localDateForTimeZone } from '../domain/recurrence';

const today = () => new Date().toISOString().slice(0, 10);
const operationId = () => crypto.randomUUID();
const errorText = (error: unknown) => error instanceof ApiError && error.networkFailure ? (error.reconnectRequired ? 'Connection failed while online. Reconnect or check your session; your pending expense remains retryable.' : 'You appear to be offline. Only new expenses can be queued; edits, deletes, settlements, and membership changes require a connection.') : error instanceof Error ? error.message : 'Something went wrong';
function Loading() { return <p className="muted" role="status" aria-live="polite">Loading…</p>; }

function PublicLanding({ logoutError }: { logoutError?: unknown } = {}) {
  const location = useLocation();
  const { signOut } = useClerk();
  const [retryingSignOut, setRetryingSignOut] = useState(false);
  const returnTo = `${location.pathname}${location.search}${location.hash}`;
  const retrySignOut = async () => {
    setRetryingSignOut(true);
    try { await signOut({ redirectUrl: '/' }); }
    catch (cause) { recoverAfterClerkSignOutFailure(cause); setRetryingSignOut(false); }
  };
  return <PublicShell returnTo={returnTo}>
    <div className="landing-page">
       <section className="landing-hero" aria-labelledby="landing-title">
        <div className="landing-hero__copy"><p className="eyebrow">Private shared expenses</p><h1 id="landing-title">Know who paid. Know what is still owed.</h1><p className="landing-lede">BillSplit keeps shared expenses clear for friends, trips, and households—without making you do the math twice.</p><div className="landing-actions"><SignInButton mode="modal" fallbackRedirectUrl={returnTo}><button className="button landing-primary public-sign-in" type="button">Sign in securely</button></SignInButton><SignUpButton mode="modal" fallbackRedirectUrl={returnTo}><button className="button button--secondary" type="button">Sign up</button></SignUpButton><InstallAction label="Install BillSplit" /></div><p className="landing-privacy">Private by design · email verification codes · no advertising</p></div>
        <div className="ledger-preview" aria-hidden="true"><div className="ledger-preview__top"><span>Weekend away</span><span>USD</span></div><div className="ledger-preview__row"><span>Alex paid dinner</span><strong>$84.00</strong></div><div className="ledger-preview__row"><span>Sam owes Alex</span><strong className="ledger-preview__positive">$28.00</strong></div><div className="ledger-preview__line" /><div className="ledger-preview__total"><span>Still owed</span><strong>$28.00</strong></div></div>
      </section>
      <section className="landing-proof" aria-label="Why BillSplit"><div><strong>Clear ledgers</strong><span>See payments, splits, and balances together.</span></div><div><strong>Less chasing</strong><span>Know the next fair payment at a glance.</span></div><div><strong>Works offline</strong><span>Capture a new expense when signal drops.</span></div></section>
       {logoutError ? <div className="error" role="alert"><strong>Logout needs another try.</strong> <span>{errorText(logoutError)}</span> <Button type="button" variant="secondary" disabled={retryingSignOut} onClick={() => void retrySignOut}>{retryingSignOut ? 'Retrying…' : 'Retry logout'}</Button></div> : null}<section className="landing-note"><h2>Private, even when offline</h2><p>Your signed-in browser may keep recent group data and queued expenses locally for trusted-device offline use. Clerk session tokens are never stored by BillSplit, and syncing still requires an active Clerk session. Clear everything from Settings before handing off a device.</p></section>
    </div>
  </PublicShell>;
}
function ErrorBox({ error, id = 'resource-error', onRetry, retryLabel = 'Try again' }: { error: unknown; id?: string; onRetry?: () => void; retryLabel?: string }) {
  return <div className="error" id={id} role="alert" aria-live="assertive"><span>{errorText(error)}</span>{onRetry ? <Button type="button" variant="secondary" onClick={onRetry}>{retryLabel}</Button> : null}</div>;
}
function Empty({ children }: { children: ReactNode }) { return <div className="empty">{children}</div>; }
function retryFor<T>(key: string, userId: string | undefined, identityFailure = false) {
  return () => {
    if (identityFailure || key === resourceKeys.identity() || userId === undefined) {
      void revalidate<T>(resourceKeys.identity(), '', { force: true, reason: 'auth-restored' }).catch(() => undefined);
    } else if (userId !== undefined) {
      void revalidate<T>(key, userId, { force: true, reason: 'route' }).catch(() => undefined);
    }
  };
}
function ResourceNotice<T>({ resource, label, retry }: { resource: ResourceSnapshot<T>; label: string; retry?: () => void }) {
  // A no-data private resource cannot recover while the cached identity is stale.
  if (resource.data === undefined && getResourceSnapshot('identity').error !== undefined) return null;
  if (resource.data === undefined) {
    if (resourceViewState(resource) === 'error') return <ErrorBox error={resource.error} onRetry={retry} id={`${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-error`} />;
    return resource.loading || resource.status === 'idle' ? <Loading /> : null;
  }
  if (resource.revalidating) return <p className="cache-status" role="status">Refreshing {label}…</p>;
  if (resource.error || resource.stale || resource.offline) return <p className="cache-status" role="status">Showing cached {label}; it may be out of date. {retry ? <button className="inline-action" type="button" onClick={retry}>Retry</button> : null}</p>;
  return null;
}
function CachedIdentityNotice({ resource, id }: { resource: ResourceSnapshot<unknown>; id: string }) {
  return resource.error ? <ErrorBox error={resource.error} onRetry={retryFor(resourceKeys.identity(), '')} id={id} retryLabel="Retry identity check" /> : null;
}
function CurrencySelect({ value, onChange }: { value: Currency; onChange: (value: Currency) => void }) {
  return <select value={value} onChange={(event) => onChange(event.target.value as Currency)}>{currencyOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>;
}
const nameOf = (members: GroupMember[], id: string) => members.find((member) => member.personId === id)?.name || `Unknown member (${id})`;
const moneyInput = (minor: number) => (minor / 100).toFixed(2);

function Home() {
  const online = useOnlineStatus();
  const me = useResource(resourceKeys.identity(), '', (signal) => getMe({ signal }), RESOURCE_FRESHNESS.expenses, hydrateIdentity);
  const groupsResource = useResource<{ groups: Group[] }>(resourceKeys.groups(me.data?.id || 'pending'), me.data?.id, (signal) => getGroups(signal), RESOURCE_FRESHNESS.groups, me.data?.id ? () => hydrateGroups(me.data!.id) : undefined);
  const groups = groupsResource.data?.groups || [];
  const offline = Boolean(groupsResource.offline || me.offline);
  const [formMode, setFormMode] = useState<'friend' | 'group'>();
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState<Currency>('USD');
  const [friendName, setFriendName] = useState('');
  const [friendEmail, setFriendEmail] = useState('');
  const [friendCurrency, setFriendCurrency] = useState<Currency>('USD');
  const [friendOperation] = useState(operationId);
  const [submitting, setSubmitting] = useState(false);
  const submitLock = useRef(false);
  const [createError, setCreateError] = useState<unknown>();
  const [searchParams, setSearchParams] = useSearchParams();
  const nav = useNavigate();
  const newGroupRequested = searchParams.get('new') === '1';
  const addFriendRequested = searchParams.get('friend') === '1';
  const offlineView = offline || !online;

  useEffect(() => {
    if (newGroupRequested || addFriendRequested) {
      setFormMode(newGroupRequested ? 'group' : 'friend');
      const next = new URLSearchParams(searchParams);
      next.delete('new');
      next.delete('friend');
      setSearchParams(next, { replace: true });
    }
  }, [addFriendRequested, newGroupRequested, searchParams, setSearchParams]);

  const createGroup = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting || submitLock.current) return;
    if (!name.trim()) { setCreateError(new Error('Enter a group name.')); return; }
    setCreateError(undefined);
    submitLock.current = true;
    setSubmitting(true);
    const generation = captureSessionGeneration();
    try {
      const result = await api<{ group: Group }>('/groups', { method: 'POST', body: JSON.stringify({ name, currency }) });
      if (!result.group) throw new Error('The group was not created. Try again.');
      await invalidateForMutation.groupCreated(me.data?.id, generation); nav(`/groups/${result.group.id}`);
    } catch (cause) { setCreateError(cause); }
    finally { submitLock.current = false; setSubmitting(false); }
  };

  const createFriend = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting || submitLock.current) return;
    if (!friendName.trim()) { setCreateError(new Error('Enter a friend name.')); return; }
    setCreateError(undefined);
    submitLock.current = true;
    setSubmitting(true);
    const generation = captureSessionGeneration();
    try {
      const result = await api<{ group: Group }>('/friends', { method: 'POST', body: JSON.stringify({ name: friendName, email: friendEmail.trim() || undefined, currency: friendCurrency, client_operation_id: friendOperation }) });
      if (!result.group) throw new Error('The friend group was not created. Try again.');
      await invalidateForMutation.groupCreated(me.data?.id, generation); nav(`/groups/${result.group.id}`);
    } catch (cause) { setCreateError(cause); }
    finally { submitLock.current = false; setSubmitting(false); }
  };

  return <Layout>
    <div className="page-title"><div><p className="eyebrow">Private expenses</p><h1>Friends &amp; groups</h1></div><div className="home-actions"><Button disabled={offlineView || submitting} onClick={() => { setCreateError(undefined); setFormMode((current) => current === 'friend' ? undefined : 'friend'); }}>+ Add friend</Button><Button disabled={offlineView || submitting} onClick={() => { setCreateError(undefined); setFormMode((current) => current === 'group' ? undefined : 'group'); }} variant="secondary">New group</Button></div></div>
      {formMode === 'friend' && <Surface><h2>Add friend</h2><p className="muted">Use the exact email your friend uses to sign in with Clerk to link them to this shared group ledger. Clerk verifies and asserts their identity; it does not grant group access. Leave it blank for a ledger-only friend; no email means they cannot log in to this ledger.</p><form onSubmit={createFriend} aria-describedby={createError ? 'create-friend-error' : undefined}><Field label="Friend name"><input id="friend-name" required aria-invalid={Boolean(createError)} aria-describedby={createError ? 'create-friend-error' : undefined} value={friendName} onChange={(event) => { setCreateError(undefined); setFriendName(event.target.value); }} /></Field><Field label="Email (optional)"><input id="friend-email" className="email" type="email" value={friendEmail} onChange={(event) => { setCreateError(undefined); setFriendEmail(event.target.value); }} /></Field><Field label="Default currency"><CurrencySelect value={friendCurrency} onChange={(value) => { setCreateError(undefined); setFriendCurrency(value); }} /></Field>{createError ? <ErrorBox error={createError} id="create-friend-error" /> : null}<Button disabled={offlineView || submitting} type="submit">{submitting ? 'Adding…' : 'Add friend'}</Button></form></Surface>}
     {formMode === 'group' && <Surface><h2>New group</h2><p className="muted">Create a group for three or more people, then add friends from the group page.</p><form onSubmit={createGroup} aria-describedby={createError ? 'create-group-error' : undefined}><Field label="Group name"><input id="group-name" required aria-invalid={Boolean(createError)} aria-describedby={createError ? 'create-group-error' : undefined} value={name} onChange={(event) => { setCreateError(undefined); setName(event.target.value); }} /></Field><Field label="Default currency"><CurrencySelect value={currency} onChange={(value) => { setCreateError(undefined); setCurrency(value); }} /></Field>{createError ? <ErrorBox error={createError} id="create-group-error" /> : null}<Button disabled={offlineView || submitting} type="submit">{submitting ? 'Creating…' : 'Create group'}</Button></form></Surface>}
     {offlineView ? <p className="offline-banner" role="status">Offline · showing your last verified groups. Friend and group creation require a connection; Add Expense remains available from cached groups.</p> : null}{groupsResource.data !== undefined ? <CachedIdentityNotice resource={me} id="groups-identity-error" /> : null}{groupsResource.data === undefined && me.error ? <ErrorBox error={me.error} onRetry={retryFor(resourceKeys.identity(), '')} id="identity-error" retryLabel="Retry identity check" /> : null}
     {groupsResource.data === undefined && !me.error ? <ResourceNotice resource={groupsResource} label="groups" retry={retryFor(resourceKeys.groups(me.data?.id || 'pending'), me.data?.id)} /> : groupsResource.data !== undefined ? <><ResourceNotice resource={groupsResource} label="groups" retry={retryFor(resourceKeys.groups(me.data?.id || 'pending'), me.data?.id)} />{groups.length ? <div className="cards">{groups.map((group) => <Link className="card" to={`/groups/${group.id}`} key={group.id}><strong className="card__name">{group.memberCount === 2 && group.counterpartName ? group.counterpartName : group.name}</strong><div className="card__balances">{groupBalanceDisplays(group.balanceSummaries, group.currency).map((display, index) => display.kind === 'balance' ? <span className="card__balance" key={`${display.currency}-${index}`}><span className="card__balance-label">{display.label}</span><span className="card__balance-money"><Money amountMinor={display.amountMinor} currency={display.currency} tone={display.label === 'You are owed' ? 'positive' : 'debt'} /><small>{display.currency}</small></span></span> : <span className={`card__balance card__balance--${display.kind}`} key={`${display.label}-${index}`}><span className="card__balance-label">{display.label}</span><small>{display.currency}</small></span>)}</div></Link>)}</div> : <Empty>No groups yet. Add a friend or create a group to get started.</Empty>}</> : null}
  </Layout>;
}

function GroupPage() {
  const online = useOnlineStatus();
  const { id = '' } = useParams();
  const me = useResource(resourceKeys.identity(), '', (signal) => getMe({ signal }), RESOURCE_FRESHNESS.expenses, hydrateIdentity);
  const userId = me.data?.id || 'pending';
  const groupResource = useResource<{ group: Group; members: GroupMember[] }>(resourceKeys.group(userId, id), me.data?.id, (signal) => getGroup(id, signal), RESOURCE_FRESHNESS.group, me.data?.id ? () => hydrateGroup(me.data!.id, id) : undefined);
   const expensesResource = useResource<{ expenses: Expense[] }>(resourceKeys.expenses(userId, id), me.data?.id, (signal) => getExpenses(id, signal), RESOURCE_FRESHNESS.expenses, me.data?.id ? () => hydrateExpenses(me.data!.id, id) : undefined);
   const scheduledResource = useResource<{ scheduledExpenses: ScheduledExpense[] }>(resourceKeys.scheduledExpenses(userId, id), me.data?.id, (signal) => getScheduledExpenses(id, signal), RESOURCE_FRESHNESS.scheduledExpenses);
  const balancesResource = useResource<{ balances: Record<string, Balances> }>(resourceKeys.balances(userId, id), me.data?.id, (signal) => getBalances(id, signal), RESOURCE_FRESHNESS.balances, me.data?.id ? () => hydrateBalances(me.data!.id, id) : undefined);
  const settlementsResource = useResource<{ settlements: Settlement[] }>(resourceKeys.settlements(userId, id), me.data?.id, (signal) => getSettlements(id, signal), RESOURCE_FRESHNESS.settlements, me.data?.id ? () => hydrateSettlements(me.data!.id, id) : undefined);
  const group = groupResource.data?.group;
  const members = groupResource.data?.members || [];
  const expenses = expensesResource.data?.expenses || [];
  const settlements = settlementsResource.data?.settlements || [];
  const balances = balancesResource.data?.balances || {};
  const currentPersonId = me.data?.personId || '';
  const currentUserId = me.data?.id || '';
  const [personName, setPersonName] = useState('');
  const [personEmail, setPersonEmail] = useState('');
  const [addingPerson, setAddingPerson] = useState(false);
  const [addingPersonSubmitting, setAddingPersonSubmitting] = useState(false);
  const [addPersonError, setAddPersonError] = useState<unknown>();
  const [pending, setPending] = useState<ExpenseOutboxItem[]>([]);
  const error = groupResource.error || me.error;
   const offline = Boolean(groupResource.offline || expensesResource.offline || balancesResource.offline || settlementsResource.offline || me.offline);
   const refreshing = [groupResource, expensesResource, balancesResource, settlementsResource, scheduledResource].some((resource) => resource.revalidating);
   const partialErrors = [groupResource, expensesResource, balancesResource, settlementsResource, scheduledResource].filter((resource) => resource.error);
  useEffect(() => { setPending(getOutboxSnapshot().filter((item) => item.userId === currentUserId && item.groupId === id)); }, [id, currentUserId]);
  useEffect(() => { const unsubscribe = subscribeOutbox(() => setPending(getOutboxSnapshot().filter((item) => item.userId === currentUserId && item.groupId === id))); return () => { unsubscribe(); }; }, [id, currentUserId]);

  if (error && !group) return <Layout><ErrorBox error={error} onRetry={me.error ? retryFor(resourceKeys.identity(), '') : retryFor(resourceKeys.group(userId, id), me.data?.id)} id="group-error" /><Link className="back" to="/">← Groups</Link></Layout>;
  if (!group) return <Layout><Loading /></Layout>;
  const offlineView = offline || !online;
  const addPerson = async (event: FormEvent) => {
    event.preventDefault();
     if (addingPersonSubmitting) return;
     if (!personName.trim()) { setAddPersonError(new Error('Enter a friend name.')); return; }
     setAddPersonError(undefined);
     setAddingPersonSubmitting(true);
     const generation = captureSessionGeneration();
     try { await api(`/groups/${id}/people`, { method: 'POST', body: JSON.stringify({ name: personName, email: personEmail.trim() || undefined }) }); setPersonName(''); setPersonEmail(''); setAddingPerson(false); await invalidateForMutation.groupChanged(id, currentUserId, generation); }
    catch (cause) { setAddPersonError(cause); }
    finally { setAddingPersonSubmitting(false); }
  };
  const memberLabel = (personId: string) => personId === currentPersonId ? 'You' : nameOf(members, personId);

   return <Layout>
     <Link to="/" className="back">← Groups</Link>
      <div className="page-title"><div><p className="eyebrow">{group.currency} group</p><h1>{group.name}</h1></div><div className="expense-heading__actions"><Link className="button button--secondary" to={`/groups/${id}/scheduled-expense/new`}>+ Schedule expense</Link><Link className="button" to={`/groups/${id}/expense/new`}>+ Add expense</Link></div></div>
       {offlineView ? <p className="offline-banner" role="status">Offline · stale data is available. Only new expenses can be captured; settle, activity, exports, and member changes require a connection.</p> : null}{me.error ? <CachedIdentityNotice resource={me} id="group-identity-error" /> : null}{groupResource.error && (!me.error || groupResource.data !== undefined) ? <ResourceNotice resource={groupResource} label="group" retry={retryFor(resourceKeys.group(userId, id), me.data?.id)} /> : null}{refreshing ? <p className="cache-status" role="status">Refreshing group data…</p> : null}{partialErrors.length ? <p className="cache-status" role="status">Some group data could not refresh; cached sections remain visible.</p> : null}
        <div className="actions"><Link to={`/groups/${id}/settle`}>Settle up</Link><Link to={`/groups/${id}/activity`}>Activity</Link>{!offlineView ? <><a href={`/api/groups/${id}/export.csv`}>CSV export</a><a href={`/api/groups/${id}/export.json`}>JSON export</a></> : null}</div>
      <div className="group-overview-grid">
           <section className="stack stack--content"><h2>Balances</h2>{!me.error || balancesResource.data !== undefined ? <ResourceNotice resource={balancesResource} label="balances" retry={retryFor(resourceKeys.balances(userId, id), me.data?.id)} /> : null}{balancesResource.data !== undefined && !Object.keys(balances).length ? <Empty>Everyone is settled up.</Empty> : Object.entries(balances).map(([currencyKey, balance]) => <div key={currencyKey}><h3>{currencyKey}</h3>{balance.simplified.length ? <div className="list">{balance.simplified.map((item) => <div className="row" key={`${currencyKey}-${item.fromPersonId}-${item.toPersonId}`}><span>{item.fromPersonId === currentPersonId ? 'You' : item.fromName} owes {item.toPersonId === currentPersonId ? 'You' : item.toName}<Status tone="debt">Debt</Status></span><Money amountMinor={item.amountMinor} currency={currencyKey} tone="debt" /></div>)}</div> : <Empty>Everyone is settled up.</Empty>}</div>)}</section>
          <section><div className="section-title"><h2>People</h2>{!offlineView && group.role === 'owner' && <Button variant="secondary" onClick={() => { setAddPersonError(undefined); setAddingPerson((current) => !current); }}>{addingPerson ? 'Cancel' : '+ Add friend'}</Button>}</div>{!offlineView && addingPerson && <form onSubmit={addPerson} aria-describedby={addPersonError ? 'add-person-error' : undefined}><Field label="Friend name"><input id="person-name" required aria-invalid={Boolean(addPersonError)} aria-describedby={addPersonError ? 'add-person-error' : undefined} value={personName} onChange={(event) => { setAddPersonError(undefined); setPersonName(event.target.value); }} /></Field><Field label="Email (optional)"><input id="person-email" className="email" type="email" value={personEmail} onChange={(event) => { setAddPersonError(undefined); setPersonEmail(event.target.value); }} /></Field>{addPersonError ? <ErrorBox error={addPersonError} id="add-person-error" /> : null}<Button disabled={addingPersonSubmitting} type="submit">{addingPersonSubmitting ? 'Adding…' : 'Add friend'}</Button></form>}<div className="chips">{members.map((member) => <span className="chip" key={member.personId}>{member.personId === currentPersonId ? 'You' : member.name}{member.email ? <small className="email"> · {member.email}</small> : null}</span>)}</div></section>
     </div>
         <div className="group-ledger">
           <ScheduleList groupId={id} schedules={scheduledResource.data?.scheduledExpenses || []} resource={scheduledResource} online={!offlineView} userId={currentUserId} />
           <section><h2>Recent expenses</h2>{!me.error || expensesResource.data !== undefined ? <ResourceNotice resource={expensesResource} label="expenses" retry={retryFor(resourceKeys.expenses(userId, id), me.data?.id)} /> : null}{expensesResource.data !== undefined && !expenses.length && !pending.length ? <Empty>No expenses yet.</Empty> : expenses.length || pending.length ? <div className="list">{pending.map((item) => <PendingExpenseRow key={item.clientOperationId} item={item} />)}{expenses.map((expense) => { const path = expenseDetailPath(expense.groupId, expense.id); const content = <><span>{expense.description}<small>{expense.date} · {expense.currency}</small></span><Money amountMinor={expense.amountMinor} currency={expense.currency} /></>; return path ? <Link className="row" to={path} key={expense.id}>{content}</Link> : <div className="row" key={expense.id}>{content}</div>; })}</div> : null}</section>
         <section><h2>Recent settlements</h2>{!me.error || settlementsResource.data !== undefined ? <ResourceNotice resource={settlementsResource} label="settlements" retry={retryFor(resourceKeys.settlements(userId, id), me.data?.id)} /> : null}{settlementsResource.data !== undefined && settlements.length ? <div className="list">{settlements.map((settlement) => <div className="row" key={settlement.id}><span>{settlement.date}<small>{memberLabel(settlement.fromPersonId)} paid {memberLabel(settlement.toPersonId)}</small><Status tone="positive">Paid</Status></span><Money amountMinor={settlement.amountMinor} currency={settlement.currency} tone="positive" /></div>)}</div> : settlementsResource.data !== undefined ? <Empty>No settlements yet.</Empty> : null}</section>
     </div>
   </Layout>;
}

function PendingExpenseRow({ item }: { item: ExpenseOutboxItem }) {
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const syncing = item.status === 'syncing' && (item.leaseExpiresAt === undefined || item.leaseExpiresAt > Date.now());
  const cannotDiscard = syncing || Boolean(item.deliveryUncertain);
  const explanation = syncing ? 'An in-flight server write cannot be safely cancelled.' : item.deliveryUncertain ? 'The server may have committed this expense; retry or wait for reconciliation.' : undefined;
  const retry = async () => { setError(undefined); setBusy(true); try { await retryOutboxItem(item.clientOperationId); } catch (cause) { setError(cause); } finally { setBusy(false); } };
  const discard = async () => { if (!confirm('Discard this pending expense?')) return; setError(undefined); setBusy(true); try { await discardOutboxItem(item.clientOperationId); } catch (cause) { setError(cause); } finally { setBusy(false); } };
  return <div className="row pending-row"><span>{item.display.description}<small>{item.display.date} · {item.display.currency} · <Status tone={item.status === 'failed' ? 'debt' : 'positive'}>{statusLabel(item.status, item.deliveryUncertain)}</Status></small>{item.lastError ? <small>{item.lastError.message}</small> : null}{explanation ? <small>{explanation}</small> : null}{error ? <ErrorBox error={error} id={`pending-error-${item.clientOperationId}`} /> : null}</span><div className="pending-row__actions"><Money amountMinor={item.display.amountMinor} currency={item.display.currency} /><Button disabled={syncing || busy} type="button" variant="secondary" onClick={() => void retry()}>Retry</Button><Button disabled={cannotDiscard || busy} title={explanation} type="button" variant="danger" onClick={() => void discard()}>Discard</Button></div></div>;
}

function ScheduleStatus({ status }: { status: ScheduledExpenseStatus }) {
  const tone = status === 'active' ? 'positive' : 'debt';
  return <Status tone={tone}>{status[0].toUpperCase() + status.slice(1)}</Status>;
}

function ScheduleList({ groupId, schedules, resource, online, userId }: { groupId: string; schedules: ScheduledExpense[]; resource: ResourceSnapshot<{ scheduledExpenses: ScheduledExpense[] }>; online: boolean; userId: string }) {
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState<unknown>();
  const updateStatus = async (schedule: ScheduledExpense, action: 'pause' | 'resume' | 'cancel') => {
    if (action === 'cancel' && !confirm(`Cancel “${schedule.description}”? Future occurrences will not be generated.`)) return;
    setBusyId(schedule.id); setError(undefined);
     try { await changeScheduledExpenseStatus(schedule.id, action, schedule.version); await invalidateForMutation.scheduledExpenseChanged(groupId, userId, schedule.id); }
    catch (cause) { setError(cause); }
    finally { setBusyId(undefined); }
  };
  return <section aria-labelledby="scheduled-expenses-heading"><div className="section-title"><h2 id="scheduled-expenses-heading">Scheduled expenses</h2><span className="muted">Online-only</span></div>{resource.data === undefined ? <ResourceNotice resource={resource} label="scheduled expenses" retry={retryFor(resourceKeys.scheduledExpenses(userId, groupId), userId)} /> : schedules.length ? <div className="list">{schedules.map((schedule) => <div className="row schedule-row" key={schedule.id}><span><strong>{schedule.description}</strong><small>{scheduleSummary(schedule.frequency, schedule.interval, schedule.weekdays)} · {schedule.timezone}</small><small>{schedule.nextOccurrenceDate ? `Next occurrence ${schedule.nextOccurrenceDate}` : 'No future occurrences'}</small><small><ScheduleStatus status={schedule.status} />{schedule.blockedReason ? ` ${schedule.blockedReason}` : null}</small></span><div className="schedule-row__actions"><Money amountMinor={schedule.amountMinor} currency={schedule.currency} /><Link className="button button--secondary" to={`/groups/${groupId}/scheduled-expense/${schedule.id}`}>Edit</Link>{schedule.status === 'active' ? <Button type="button" variant="secondary" disabled={!online || busyId === schedule.id} onClick={() => void updateStatus(schedule, 'pause')}>Pause</Button> : schedule.status === 'paused' || schedule.status === 'blocked' ? <Button type="button" variant="secondary" disabled={!online || busyId === schedule.id} onClick={() => void updateStatus(schedule, 'resume')}>Resume</Button> : null}{schedule.status !== 'cancelled' ? <Button type="button" variant="danger" disabled={!online || busyId === schedule.id} onClick={() => void updateStatus(schedule, 'cancel')}>Cancel</Button> : null}</div></div>)}</div> : <Empty>No recurring expenses yet.</Empty>}{error ? <ErrorBox error={error} id="scheduled-expense-mutation-error" /> : null}{!online ? <p className="cache-status">Schedule management requires a connection. Existing schedules are not stored for offline use.</p> : null}</section>;
}

type PayerRow = { personId: string; amount: string };
type ExpenseErrorTarget = 'description' | 'amount' | 'participants' | 'payers' | 'allocation' | 'form';
type ExpenseFormError = { error: unknown; target: ExpenseErrorTarget };

function ExpenseForm() {
  const online = useOnlineStatus();
  const { id = '', expenseId, scheduledExpenseId } = useParams();
  const location = useLocation();
  const scheduleMode = location.pathname.includes('/scheduled-expense');
  const nav = useNavigate();
  const meResource = useResource(resourceKeys.identity(), '', (signal) => getMe({ signal }), RESOURCE_FRESHNESS.expenses, hydrateIdentity);
  const formUserId = meResource.data?.id || 'pending';
  const groupResource = useResource<{ group: Group; members: GroupMember[] }>(resourceKeys.group(formUserId, id), meResource.data?.id, (signal) => getGroup(id, signal), RESOURCE_FRESHNESS.group, meResource.data?.id ? () => hydrateGroup(meResource.data!.id, id) : undefined);
  const detailResource = useResource<{ expense: Expense; history: Array<{ id: string; revision: number; createdAt: string }> }>(resourceKeys.expenseDetail(formUserId, expenseId || 'new'), meResource.data?.id, async (signal) => expenseId ? getExpenseDetails(expenseId, signal) : { expense: undefined as unknown as Expense, history: [] }, RESOURCE_FRESHNESS.expenseDetail, expenseId && meResource.data?.id ? () => hydrateExpenseDetails(meResource.data!.id, expenseId) : undefined);
  const scheduleResource = useResource<{ scheduledExpense: ScheduledExpense }>(resourceKeys.scheduledExpense(formUserId, scheduledExpenseId || 'new'), meResource.data?.id, async (signal) => scheduledExpenseId ? getScheduledExpense(scheduledExpenseId, signal) : { scheduledExpense: undefined as unknown as ScheduledExpense }, RESOURCE_FRESHNESS.scheduledExpenses);
  const group = groupResource.data?.group;
  const members = groupResource.data?.members || [];
  const currentPersonId = meResource.data?.personId || '';
  const currentUserId = meResource.data?.id || '';
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState<Currency>('USD');
   const [date, setDate] = useState(() => localDateForTimeZone(new Date(), browserTimezone()));
  const [endDate, setEndDate] = useState('');
  const [frequency, setFrequency] = useState<RecurrenceFrequency>('monthly');
  const [interval, setInterval] = useState('1');
  const [weekdays, setWeekdays] = useState<Weekday[]>([]);
  const [timezone, setTimezone] = useState(browserTimezone);
  const [category, setCategory] = useState('');
  const [notes, setNotes] = useState('');
  const [method, setMethod] = useState<SplitMethod>('equal');
  const [selected, setSelected] = useState<string[]>([]);
  const [allocationValues, setAllocationValues] = useState<AllocationState>({});
  const [existingSplitMetadata, setExistingSplitMetadata] = useState<Record<string, Record<string, unknown>>>({});
  const [payerRows, setPayerRows] = useState<PayerRow[]>([]);
  const [version, setVersion] = useState<number>();
  const [operation] = useState(operationId);
  const [payersOpen, setPayersOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<ExpenseFormError>();
  const [dirty, setDirty] = useState(false);
  const [updatedElsewhere, setUpdatedElsewhere] = useState(false);
  const [formReady, setFormReady] = useState(false);
  const routeKey = `${formUserId}:${id}:${scheduleMode ? `schedule:${scheduledExpenseId || 'new'}` : `expense:${expenseId || 'new'}`}`;
  const initializedRoute = useRef<string | undefined>(undefined);
  const initializedVersion = useRef<number | undefined>(undefined);
  const markDirty = () => { setDirty(true); setFormError(undefined); };

  useEffect(() => {
    if (initializedRoute.current === routeKey) return;
    initializedRoute.current = undefined;
    initializedVersion.current = undefined;
    setFormReady(false);
    setDirty(false);
    setUpdatedElsewhere(false);
    setFormError(undefined);
  }, [routeKey]);

  useEffect(() => {
    const groupResult = groupResource.data;
    const me = meResource.data;
     const expense = detailResource.data?.expense;
     const schedule = scheduleResource.data?.scheduledExpense;
     if (!groupResult || !me || (expenseId && !expense) || (scheduledExpenseId && !schedule)) return;

     const serverVersion = formServerVersion(scheduleMode, expense?.version, schedule?.version);
     if (initializedRoute.current === routeKey) {
        if (serverVersion === initializedVersion.current || (!expense && !schedule && initializedVersion.current === undefined)) return;
       if (dirty) {
         if (hasNewerServerVersion(initializedVersion.current, serverVersion, true)) setUpdatedElsewhere(true);
         return;
       }
      initializedRoute.current = undefined;
    }

     const loadedMethod = (expense || schedule)?.splits[0]?.metadata?.method;
    const nextMethod: SplitMethod = loadedMethod === 'exact' || loadedMethod === 'percentage' || loadedMethod === 'shares' ? loadedMethod : 'equal';
     setCurrency(expense?.currency ?? schedule?.currency ?? groupResult.group.currency);
     if (expense || schedule) {
       const record = expense || schedule!;
       setDescription(record.description); setAmount(moneyInput(record.amountMinor)); setDate('date' in record ? record.date : record.startDate); setCategory('category' in record ? record.category || '' : ''); setNotes('notes' in record ? record.notes || '' : ''); setMethod(nextMethod); setSelected(record.splits.map((split) => split.personId)); setAllocationValues(allocationStateFromSplits(record.splits, nextMethod)); setExistingSplitMetadata(allocationMetadataByPerson(record.splits)); setVersion(record.version); setPayerRows(record.payers.map((payer) => ({ personId: payer.personId, amount: moneyInput(payer.amountMinor) })));
       if ('startDate' in record) { setEndDate(record.endDate || ''); setFrequency(record.frequency); setInterval(String(record.interval)); setWeekdays(record.weekdays); setTimezone(record.timezone); }
     } else {
      const payer = currentPayerSelection(me.personId, groupResult.members);
       const defaultTimezone = browserTimezone(); setDescription(''); setAmount(''); setDate(scheduleMode ? localDateForTimeZone(new Date(), defaultTimezone) : today()); setEndDate(''); setFrequency('monthly'); setInterval('1'); setWeekdays([]); setTimezone(defaultTimezone); setCategory(''); setNotes(''); setMethod('equal'); setAllocationValues({}); setExistingSplitMetadata({}); setVersion(undefined); setSelected(groupResult.members.map((member) => member.personId)); setPayerRows(payer ? [{ personId: payer, amount: '' }] : []);
    }
    initializedRoute.current = routeKey;
     initializedVersion.current = expense?.version ?? schedule?.version;
    setDirty(false);
    setUpdatedElsewhere(false);
    setFormReady(true);
   }, [detailResource.data, dirty, expenseId, groupResource.data, meResource.data, routeKey, scheduleMode, scheduleResource.data, scheduledExpenseId]);

   const resourceError = meResource.error || groupResource.error || (expenseId && detailResource.error) || (scheduledExpenseId && scheduleResource.error);
  const routeReady = initializedRoute.current === routeKey && formReady;
   if (resourceError && !(group && routeReady)) return <Layout><ErrorBox error={resourceError} onRetry={retryFor(expenseId ? resourceKeys.expenseDetail(formUserId, expenseId) : scheduledExpenseId ? resourceKeys.scheduledExpense(formUserId, scheduledExpenseId) : resourceKeys.group(formUserId, id), meResource.data?.id, Boolean(meResource.error))} id="expense-resource-error" /></Layout>;
  if (!group) return <Layout><Loading /></Layout>;
  if (!routeReady) return <Layout><Loading /></Layout>;
  const offlineData = Boolean(groupResource.offline || meResource.offline || detailResource.offline);
   const editUnavailable = scheduleMode ? !online : Boolean(expenseId) && (!online || offlineData);
  const amountMinor = (() => { try { return parseMoney(amount, currency); } catch { return 0; } })();
  const preview = previewAllocation(amountMinor, selected, method, allocationValues, currency);
  const isYou = (personId: string) => personId === currentPersonId;
  const setAmountAndPayer = (value: string) => { markDirty(); setAmount(value); if (payerRows.length === 1) setPayerRows((rows) => rows.map((row) => ({ ...row, amount: value }))); };
  const toggleSplit = (personId: string) => { markDirty(); setSelected((current) => current.includes(personId) ? current.filter((idValue) => idValue !== personId) : [...current, personId]); };
  const updateAllocation = (personId: string, value: string) => { markDirty(); setAllocationValues((current) => ({ ...current, [personId]: value })); };
  const addPayer = () => { const personId = members.find((member) => !payerRows.some((payer) => payer.personId === member.personId))?.personId; if (personId) { markDirty(); setPayerRows((rows) => [...rows, { personId, amount: '' }]); } };
  const removePayer = (index: number) => { markDirty(); setPayerRows((rows) => normalizeSinglePayer(rows.filter((_, rowIndex) => rowIndex !== index), amount)); };
  const resetToServer = () => { setDirty(false); setUpdatedElsewhere(false); setFormError(undefined); };
  const payerIsFullTotal = payerRows.length === 1 && amount.trim() !== '' && amountMinor > 0 && (() => { try { return parseMoney(payerRows[0].amount, currency) === amountMinor; } catch { return false; } })();
  const payerSummary = payerRows.length === 1 ? `Paid by ${isYou(payerRows[0].personId) ? 'You' : nameOf(members, payerRows[0].personId)}` : payerRows.length ? `Paid by ${payerRows.length} people` : 'Choose who paid';
   const payerSummaryDetail = payerRows.length === 1 ? (payerIsFullTotal ? 'Entire total' : 'Amount needs review') : payerRows.length ? 'Configure exact amounts' : 'Choose a payer';
   const scheduleDraft = { startDate: date, endDate: endDate || null, frequency, interval: Number(interval) || 1, weekdays };
   const schedulePreview = scheduleMode ? (() => { try { return previewScheduleDates(scheduleDraft, localDateForTimeZone(new Date(), timezone.trim() || 'UTC'), 5); } catch { return previewScheduleDates(scheduleDraft, today(), 5); } })() : [];

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true); setFormError(undefined);
    let target: ExpenseErrorTarget = 'form';
    try {
      target = 'description';
      if (!description.trim()) throw new Error('Add a short description.');
      target = 'amount';
      if (!amount) throw new Error('Enter an expense amount.');
      const cents = parseMoney(amount, currency);
      target = 'participants';
      if (!selected.length) throw new Error('Select at least one participant.');
      target = 'payers';
      const payers = payerRows.map((payer) => ({ person_id: payer.personId, amount_minor: parseMoney(payer.amount || '0', currency) }));
      if (checkedSumMinor(payers.map((payer) => payer.amount_minor)) !== cents) throw new Error('Payer amounts must equal the expense total.');
      target = 'allocation';
      if (preview.error || preview.remainingMinor !== 0) throw new Error(preview.error || 'Split amounts must equal the expense total.');
      target = 'form';
       const splits = allocationSplits(selected, method, preview, allocationValues, existingSplitMetadata);
       if (scheduleMode) {
         target = 'form';
         const scheduleInterval = Number(interval);
         if (!Number.isSafeInteger(scheduleInterval) || scheduleInterval < 1 || scheduleInterval > 366) throw new Error('Enter an interval from 1 to 366.');
         if (frequency === 'weekly' && !weekdays.length) throw new Error('Choose at least one weekday for a weekly schedule.');
         if (frequency !== 'weekly' && weekdays.length) throw new Error('Weekdays are only used for weekly schedules.');
         if (endDate && endDate < date) throw new Error('End date must not precede the start date.');
         const scheduleInput: ScheduledExpenseInput = { description: description.trim(), amount_minor: cents, currency, start_date: date, end_date: endDate || null, frequency, interval: scheduleInterval, weekdays: frequency === 'weekly' ? weekdays : [], timezone: timezone.trim() || 'UTC', payers, splits, version, client_operation_id: scheduledExpenseId ? undefined : operation };
          if (scheduledExpenseId) await updateScheduledExpense(scheduledExpenseId, scheduleInput);
         else await createScheduledExpense(id, scheduleInput);
         await invalidateForMutation.scheduledExpenseChanged(id, currentUserId, scheduledExpenseId);
         nav(`/groups/${id}`);
       } else {
       const input = { description: description.trim(), amount_minor: cents, currency, date, category: category.trim() || null, notes: notes || null, payers, splits, version, client_operation_id: expenseId ? undefined : operation };
        if (expenseId) { const generation = captureSessionGeneration(); await api(`/expenses/${expenseId}`, { method: 'PUT', body: JSON.stringify(input) }); await invalidateForMutation.expenseChanged(id, expenseId, currentUserId, generation); }
        else {
         const me = currentUserId ? { id: currentUserId } : await getMe();
         const payload = input as ExpenseInput;
         await enqueueExpense({ userId: me.id, groupId: id, payload, clientOperationId: operation, display: { description: payload.description, amountMinor: payload.amount_minor, currency: payload.currency, date: payload.date } });
          await flushOutbox();
        }
         nav(`/groups/${id}`);
        }
        } catch (cause) {
        if (expenseId && currentUserId && cause instanceof ApiError && isExpenseConflict(cause.status, cause.code)) {
         const detailKey = resourceKeys.expenseDetail(currentUserId, expenseId);
         invalidateResource(detailKey, currentUserId, { revalidate: false });
          void revalidate(detailKey, currentUserId, { force: true, reason: 'mutation' }).catch(() => undefined);
        }
        if (scheduledExpenseId && currentUserId && cause instanceof ApiError && (cause.status === 409 || cause.code === 'CONFLICT')) {
          const scheduleKey = resourceKeys.scheduledExpense(currentUserId, scheduledExpenseId);
          invalidateResource(scheduleKey, currentUserId, { revalidate: false });
          void revalidate(scheduleKey, currentUserId, { force: true, reason: 'mutation' }).catch(() => undefined);
        }
        setSubmitting(false); setFormError({ error: cause, target });
      }
   };

  return <Layout>
        <div className="page-title expense-heading"><div><Link to={`/groups/${id}`} className="back">← <span className="back__label">{group.name}</span></Link><p className="eyebrow">{scheduleMode ? (scheduledExpenseId ? 'Edit scheduled expense' : 'New scheduled expense') : expenseId ? 'Edit expense' : 'New expense'}</p><h1>{scheduleMode ? (scheduledExpenseId ? 'Edit recurring expense' : 'Schedule an expense') : expenseId ? 'Edit expense' : 'Add expense'}</h1></div><div className="expense-heading__actions"><Link className="button button--secondary" to={`/groups/${id}`}>Cancel</Link></div></div>{meResource.error ? <CachedIdentityNotice resource={meResource} id="expense-identity-error" /> : null}{groupResource.error ? <ResourceNotice resource={groupResource} label="group details" retry={retryFor(resourceKeys.group(formUserId, id), meResource.data?.id)} /> : null}{expenseId && detailResource.error ? <ResourceNotice resource={detailResource} label="expense form data" retry={retryFor(resourceKeys.expenseDetail(formUserId, expenseId), meResource.data?.id)} /> : null}{scheduledExpenseId && scheduleResource.error ? <ResourceNotice resource={scheduleResource} label="scheduled expense form data" retry={retryFor(resourceKeys.scheduledExpense(formUserId, scheduledExpenseId), meResource.data?.id)} /> : null}
        {updatedElsewhere ? <div className="offline-banner updated-elsewhere" role="status"><span>Updated elsewhere. Your changes are preserved.</span><Button type="button" variant="secondary" onClick={resetToServer}>Reload</Button></div> : null}{editUnavailable ? <p className="offline-banner" role="status">{scheduleMode ? 'Schedule management is online-only. Reconnect before saving changes.' : 'Editing expenses is online-only. Reconnect before saving changes.'}</p> : null}<form className="expense-form reading-width" onSubmit={submit} aria-describedby={formError ? 'expense-form-error' : preview.error ? 'allocation-error' : undefined}>
         <Field label="Amount and currency" className={amountFieldClass(amount)}><CurrencySelect value={currency} onChange={(value) => { markDirty(); setCurrency(value); }} /><input id="expense-amount" className={amountInputClass(amount)} data-amount-length={amountInputLength(amount)} required inputMode="decimal" aria-label="Expense amount" aria-invalid={formError?.target === 'amount'} aria-describedby={formError?.target === 'amount' ? 'expense-form-error' : undefined} placeholder="0.00" value={amount} onChange={(event) => setAmountAndPayer(event.target.value)} /></Field>
         <Field label="Description" className="field--compact"><input id="expense-description" required aria-invalid={formError?.target === 'description'} aria-describedby={formError?.target === 'description' ? 'expense-form-error' : undefined} placeholder="What was this for?" value={description} onChange={(event) => { markDirty(); setDescription(event.target.value); }} /></Field>
       <button className="summary-row" type="button" aria-invalid={formError?.target === 'payers'} aria-describedby={formError?.target === 'payers' ? 'expense-form-error' : undefined} onClick={() => setPayersOpen(true)}><span><span className="summary-row__label">{payerSummary}</span><small>{payerSummaryDetail}</small></span><strong>Change</strong></button>
       <fieldset aria-describedby={formError?.target === 'participants' ? 'expense-form-error' : undefined}><legend>Split between</legend><div className="participant-list">{members.map((member) => { const active = selected.includes(member.personId); return <button className="participant-row" type="button" aria-pressed={active} aria-invalid={formError?.target === 'participants'} key={member.personId} onClick={() => toggleSplit(member.personId)}><span className="participant-row__name"><span className="checkmark" aria-hidden="true">✓</span><span className="participant-row__label">{member.name}</span>{isYou(member.personId) ? <small>You</small> : null}</span>{active && method === 'equal' ? <span className="allocation-row__amount">{formatMoney(preview.allocations[member.personId] || 0, currency)}</span> : null}</button>; })}</div></fieldset>
       <div className="secondary-fields"><Field label="Split method" className="field--compact"><select value={method} onChange={(event) => { markDirty(); setMethod(event.target.value as SplitMethod); }}><option value="equal">Equal</option><option value="exact">Exact amounts</option><option value="percentage">Percentage</option><option value="shares">Shares</option></select></Field>
          {method !== 'equal' && <div className="allocation-list">{members.filter((member) => selected.includes(member.personId)).map((member) => <div className="allocation-row" key={member.personId}><span className="allocation-row__person"><span>{member.name}{isYou(member.personId) ? ' · You' : ''}</span><span className="allocation-row__amount">{preview.allocations[member.personId] !== undefined ? formatMoney(preview.allocations[member.personId], currency) : '—'}</span></span><input className={amountInputClass(allocationValues[member.personId] || '')} data-amount-length={amountInputLength(allocationValues[member.personId] || '')} required inputMode="decimal" aria-label={`${member.name} ${method} value`} aria-invalid={formError?.target === 'allocation' || Boolean(preview.error)} aria-describedby={formError?.target === 'allocation' ? 'expense-form-error' : preview.error ? 'allocation-error' : undefined} placeholder={method === 'exact' ? '0.00' : method === 'percentage' ? '%' : 'Shares'} value={allocationValues[member.personId] || ''} onChange={(event) => updateAllocation(member.personId, event.target.value)} /></div>)}<p className="allocation-summary" role="status">{method === 'exact' ? `Remaining ${formatMoney(preview.remainingMinor ?? amountMinor, currency)}` : method === 'percentage' ? `Remaining ${preview.remainingPercent ?? 100}%` : `Total shares ${preview.totalValue || 0}`}</p>{preview.error ? <p className="error" id="allocation-error" role="alert">{preview.error}</p> : null}</div>}
           {scheduleMode ? <><div className="form-row"><Field label="Start date" className="field--compact"><input required type="date" value={date} onChange={(event) => { markDirty(); setDate(event.target.value); }} /></Field><Field label="End date (optional)" className="field--compact"><input type="date" value={endDate} min={date} onChange={(event) => { markDirty(); setEndDate(event.target.value); }} /></Field></div><div className="form-row"><Field label="Repeats" className="field--compact"><select value={frequency} onChange={(event) => { markDirty(); setFrequency(event.target.value as RecurrenceFrequency); if (event.target.value !== 'weekly') setWeekdays([]); }}><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select></Field><Field label="Every (interval)" className="field--compact"><input required type="number" min="1" max="366" value={interval} onChange={(event) => { markDirty(); setInterval(event.target.value); }} /></Field></div>{frequency === 'weekly' ? <fieldset><legend>On weekdays</legend><div className="weekday-list">{weekdayLabels.map((day) => <label className="checkbox-row" key={day.value}><input type="checkbox" checked={weekdays.includes(day.value)} onChange={() => { markDirty(); setWeekdays((current) => current.includes(day.value) ? current.filter((value) => value !== day.value) : [...current, day.value].sort((a, b) => a - b)); }} />{day.label}</label>)}</div></fieldset> : null}<Field label="Creator timezone (IANA)" className="field--compact"><input required value={timezone} onChange={(event) => { markDirty(); setTimezone(event.target.value); }} /><small className="muted">Defaults to this browser’s timezone. Dates are calendar dates in this timezone.</small></Field><div className="schedule-preview"><strong>Next dates</strong>{schedulePreview.length ? <ol>{schedulePreview.map((previewDate) => <li key={previewDate}>{previewDate}</li>)}</ol> : <p className="muted">No occurrences match these settings.</p>}</div><p className="muted">Only future occurrences use edits. Already generated expenses stay in the ledger; creating or changing a schedule never enters the expense outbox.</p></> : <><div className="form-row"><Field label="Date" className="field--compact"><input required type="date" value={date} onChange={(event) => { markDirty(); setDate(event.target.value); }} /></Field><Field label="Category (optional)" className="field--compact"><input className="category" value={category} onChange={(event) => { markDirty(); setCategory(event.target.value); }} /></Field></div><Field label="Notes (optional)" className="field--compact"><textarea className="notes" rows={3} value={notes} onChange={(event) => { markDirty(); setNotes(event.target.value); }} /></Field></>}
      </div>
         {formError ? <ErrorBox error={formError.error} id="expense-form-error" /> : null}<Button className="full-width-button" disabled={submitting || editUnavailable} type="submit">{submitting ? 'Saving…' : scheduleMode ? scheduledExpenseId ? 'Save schedule' : 'Create schedule' : expenseId ? 'Save changes' : 'Save expense'}</Button>
    </form>
       {payersOpen && <Modal title="Who paid?" description="Use one payer for a quick entry, or add people and enter exact amounts." onClose={() => setPayersOpen(false)}><div className="payer-list">{payerRows.map((payer, index) => <div className={`payer-row${payerRows.length > 1 ? ' payer-row--removable' : ''}`} key={`${payer.personId}-${index}`}><select aria-label={`Payer ${index + 1}: ${isYou(payer.personId) ? 'You' : nameOf(members, payer.personId)}`} aria-invalid={formError?.target === 'payers'} aria-describedby={formError?.target === 'payers' ? 'expense-form-error' : undefined} value={payer.personId} onChange={(event) => { markDirty(); setPayerRows((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, personId: event.target.value } : row)); }}>{members.filter((member) => !payerRows.some((other, otherIndex) => other.personId === member.personId && otherIndex !== index)).map((member) => <option key={member.personId} value={member.personId}>{member.name}{isYou(member.personId) ? ' · You' : ''}</option>)}</select><input className={amountInputClass(payer.amount)} data-amount-length={amountInputLength(payer.amount)} required inputMode="decimal" aria-label={`Amount paid by ${isYou(payer.personId) ? 'You' : nameOf(members, payer.personId)} (payer ${index + 1})`} aria-invalid={formError?.target === 'payers'} aria-describedby={formError?.target === 'payers' ? 'expense-form-error' : undefined} placeholder="Amount" value={payer.amount} onChange={(event) => { markDirty(); setPayerRows((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, amount: event.target.value } : row)); }} />{payerRows.length > 1 && <Button type="button" variant="secondary" aria-label={`Remove payer ${isYou(payer.personId) ? 'You' : nameOf(members, payer.personId)} (payer ${index + 1})`} onClick={() => removePayer(index)}>Remove</Button>}</div>)}</div><p className="allocation-summary" role="status">Payers total {formatMoney(payerRows.reduce((sum, payer) => { try { return sum + parseMoney(payer.amount || '0', currency); } catch { return sum; } }, 0), currency)} of {formatMoney(amountMinor, currency)}</p><Button className="full-width-button" type="button" variant="secondary" onClick={addPayer}>+ Add payer</Button><Button className="full-width-button" type="button" onClick={() => setPayersOpen(false)}>Done</Button></Modal>}
  </Layout>;
}

function ExpenseDetail() {
  const online = useOnlineStatus();
  const { id, expenseId = '' } = useParams();
  const nav = useNavigate();
  const me = useResource(resourceKeys.identity(), '', (signal) => getMe({ signal }), RESOURCE_FRESHNESS.expenses, hydrateIdentity);
  const detailsResource = useResource<{ expense: Expense; history: Array<{ id: string; revision: number; createdAt: string }> }>(resourceKeys.expenseDetail(me.data?.id || 'pending', expenseId), me.data?.id, (signal) => getExpenseDetails(expenseId, signal), RESOURCE_FRESHNESS.expenseDetail, me.data?.id ? () => hydrateExpenseDetails(me.data!.id, expenseId) : undefined);
  const expense = detailsResource.data?.expense;
  const history = detailsResource.data?.history || [];
  const groupResource = useResource<{ group: Group; members: GroupMember[] }>(resourceKeys.group(me.data?.id || 'pending', expense?.groupId || id || 'unknown'), me.data?.id, (signal) => getGroup(expense?.groupId || id || '', signal), RESOURCE_FRESHNESS.group, me.data?.id ? () => hydrateGroup(me.data!.id, expense?.groupId || id || '') : undefined);
  const members = groupResource.data?.members || [];
  const error = detailsResource.error || groupResource.error || me.error;
  const offlineData = Boolean(detailsResource.offline || groupResource.offline || me.offline);
  const [deleteError, setDeleteError] = useState<unknown>();
  const [deleting, setDeleting] = useState(false);
  useEffect(() => { if (expense && !id) nav(`/groups/${expense.groupId}/expenses/${expenseId}`, { replace: true }); }, [expense, expenseId, id, nav]);
  if (!expense && error) return <Layout><ErrorBox error={error} onRetry={retryFor(resourceKeys.expenseDetail(me.data?.id || 'pending', expenseId), me.data?.id, Boolean(me.error))} id="expense-detail-error" /></Layout>;
  if (!expense) return <Layout><Loading /></Layout>;
  const remove = async () => { if (!confirm('Delete this expense?')) return; setDeleteError(undefined); setDeleting(true); const generation = captureSessionGeneration(); try { await api(`/expenses/${expense.id}?version=${expense.version}`, { method: 'DELETE' }); await invalidateForMutation.expenseChanged(expense.groupId, expense.id, me.data?.id, generation); nav(`/groups/${expense.groupId}`); } catch (cause) { setDeleteError(cause); } finally { setDeleting(false); } };
   return <Layout><Link to={`/groups/${expense.groupId}`} className="back">← Group</Link><div className="page-title"><div><p className="eyebrow">{expense.date}</p><h1>{expense.description}</h1></div><Money amountMinor={expense.amountMinor} currency={expense.currency} size="large" /></div>{me.error ? <CachedIdentityNotice resource={me} id="expense-detail-identity-error" /> : null}{!me.error || detailsResource.data !== undefined ? <ResourceNotice resource={detailsResource} label="expense details" retry={retryFor(resourceKeys.expenseDetail(me.data?.id || 'pending', expenseId), me.data?.id)} /> : null}{!me.error || groupResource.data !== undefined ? <ResourceNotice resource={groupResource} label="member names" retry={retryFor(resourceKeys.group(me.data?.id || 'pending', expense.groupId), me.data?.id)} /> : null}<section className="reading-width"><h2>Payers</h2><div className="list">{expense.payers.map((payer) => <div className="row" key={payer.personId}><span>{nameOf(members, payer.personId)}</span><Money amountMinor={payer.amountMinor} currency={expense.currency} /></div>)}</div><h2>Split</h2><div className="list">{expense.splits.map((split) => <div className="row" key={split.personId}><span>{nameOf(members, split.personId)}</span><Money amountMinor={split.amountMinor} currency={expense.currency} /></div>)}</div>{expense.category ? <p className="muted category">Category: {expense.category}</p> : null}{expense.notes ? <p className="muted notes">{expense.notes}</p> : null}</section>{online && !offlineData ? <div className="actions"><Link className="button" to={`/groups/${expense.groupId}/expense/${expense.id}`}>Edit</Link><Button variant="danger" disabled={deleting} onClick={remove}>{deleting ? 'Deleting…' : 'Delete'}</Button>{deleteError ? <ErrorBox error={deleteError} id="expense-delete-error" /> : null}</div> : <p className="offline-banner" role="status">Editing and deleting expenses require a connection.</p>}<section className="reading-width"><h2>History</h2>{history.length ? <div className="list">{history.map((item) => <div className="row" key={item.id}><span>Revision {item.revision}</span><small>{item.createdAt}</small></div>)}</div> : <Empty>No edits yet.</Empty>}</section></Layout>;
}

function Settle() {
  const online = useOnlineStatus();
  const { id = '' } = useParams();
  const nav = useNavigate();
  const me = useResource(resourceKeys.identity(), '', (signal) => getMe({ signal }), RESOURCE_FRESHNESS.expenses, hydrateIdentity);
  const settleUserId = me.data?.id || 'pending';
  const groupResource = useResource<{ group: Group; members: GroupMember[] }>(resourceKeys.group(settleUserId, id), me.data?.id, (signal) => getGroup(id, signal), RESOURCE_FRESHNESS.group, me.data?.id ? () => hydrateGroup(me.data!.id, id) : undefined);
  const balancesResource = useResource<{ balances: Record<string, Balances> }>(resourceKeys.balances(settleUserId, id), me.data?.id, (signal) => getBalances(id, signal), RESOURCE_FRESHNESS.balances, me.data?.id ? () => hydrateBalances(me.data!.id, id) : undefined);
  const members = groupResource.data?.members || [];
  const group = groupResource.data?.group;
  const balances = balancesResource.data?.balances || {};
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState<Currency>('USD');
  const currentPersonId = me.data?.personId || '';
  const [operation] = useState(operationId);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>();
  const [dirty, setDirty] = useState(false);
  const settlementRouteKey = `${settleUserId}:${id}`;
  const initializedRoute = useRef<string | undefined>(undefined);
  const initializedSuggestion = useRef<string | undefined>(undefined);
  const markDirty = () => setDirty(true);
  const offlineData = Boolean(me.offline || groupResource.offline || balancesResource.offline);
  const suggestion = group && me.data && balancesResource.data ? settlementSuggestion(balancesResource.data.balances, me.data.personId, group.currency) : undefined;
  const fallbackFrom = suggestion?.fromPersonId || members[0]?.personId || '';
  const fallbackTo = suggestion?.toPersonId || members.find((member) => member.personId !== fallbackFrom)?.personId || '';
  const suggestionFingerprint = group ? settlementSuggestionFingerprint(suggestion, group.currency, fallbackFrom, fallbackTo) : '';

  useEffect(() => {
    if (!group || !me.data || !balancesResource.data) return;
    const routeChanged = initializedRoute.current !== settlementRouteKey;
    if (!routeChanged && dirty) return;
    if (!routeChanged && initializedSuggestion.current === suggestionFingerprint) return;
    setCurrency(suggestion?.currency || group.currency); setFrom(fallbackFrom); setTo(fallbackTo); setAmount(suggestion ? moneyInput(suggestion.amountMinor) : '');
    initializedRoute.current = settlementRouteKey;
    initializedSuggestion.current = suggestionFingerprint;
    setDirty(false);
  }, [balancesResource.data, dirty, fallbackFrom, fallbackTo, group, me.data, settlementRouteKey, suggestion, suggestionFingerprint]);
  const resourceError = error || me.error || groupResource.error || balancesResource.error;
  if (!group) return <Layout>{resourceError ? <ErrorBox error={resourceError} onRetry={retryFor(resourceError === balancesResource.error ? resourceKeys.balances(settleUserId, id) : resourceKeys.group(settleUserId, id), me.data?.id, Boolean(me.error))} id="settle-resource-error" /> : <Loading />}</Layout>;
   if (!online || offlineData) return <Layout><Link to={`/groups/${id}`} className="back">← <span className="back__label">{group.name}</span></Link><div className="page-title"><div><p className="eyebrow">{balancesResource.data ? 'Cached balance' : 'Balance unavailable'}</p><h1>Settle up</h1></div></div>{me.error ? <CachedIdentityNotice resource={me} id="settle-identity-error" /> : null}<p className="offline-banner" role="status">Settlements are online-only. Reconnect to submit; {balancesResource.data ? 'cached balances remain available.' : 'no verified cached balances are available on this device.'}</p><ResourceNotice resource={balancesResource} label="balances" retry={retryFor(resourceKeys.balances(settleUserId, id), me.data?.id)} />{balancesResource.data ? Object.entries(balances).map(([currencyKey, balance]) => <section className="reading-width" key={currencyKey}><h2>Balances <small>({currencyKey})</small></h2>{balance.simplified.length ? <div className="list">{balance.simplified.map((item) => <div className="row" key={`${currencyKey}-${item.fromPersonId}-${item.toPersonId}`}><span>{item.fromPersonId === currentPersonId ? 'You' : item.fromName} owes {item.toPersonId === currentPersonId ? 'You' : item.toName}</span><Money amountMinor={item.amountMinor} currency={currencyKey} tone="debt" /></div>)}</div> : <Empty>Everyone is settled up.</Empty>}</section>) : null}</Layout>;
    if (balancesResource.data === undefined) return <Layout><Link to={`/groups/${id}`} className="back">← <span className="back__label">{group.name}</span></Link><div className="page-title"><div><p className="eyebrow">Balance required</p><h1>Settle up</h1></div></div>{me.error ? <CachedIdentityNotice resource={me} id="settle-identity-error" /> : null}{!me.error ? <ResourceNotice resource={balancesResource} label="balances" retry={retryFor(resourceKeys.balances(settleUserId, id), me.data?.id)} /> : null}</Layout>;
   const submit = async (event: FormEvent) => { event.preventDefault(); if (submitting) return; setSubmitting(true); setError(undefined); const generation = captureSessionGeneration(); try { await api(`/groups/${id}/settlements`, { method: 'POST', body: JSON.stringify({ from_person_id: from, to_person_id: to, amount_minor: parseMoney(amount, currency), currency, date: today(), client_operation_id: operation }) }); await invalidateForMutation.settlementChanged(id, me.data?.id, generation); nav(`/groups/${id}`); } catch (cause) { setSubmitting(false); setError(cause); } };
      const resetSuggestion = () => { setCurrency(suggestion?.currency || group.currency); setFrom(fallbackFrom); setTo(fallbackTo); setAmount(suggestion ? moneyInput(suggestion.amountMinor) : ''); initializedRoute.current = settlementRouteKey; initializedSuggestion.current = suggestionFingerprint; setDirty(false); };
       return <Layout><Link to={`/groups/${id}`} className="back">← <span className="back__label">{group.name}</span></Link><div className="page-title"><div><p className="eyebrow">{currentPersonId ? 'Suggested from your balance' : 'Payment'}</p><h1>Settle up</h1></div></div>{me.error ? <CachedIdentityNotice resource={me} id="settle-identity-error" /> : null}<p className="muted">Record a payment. Partial settlements are supported.</p><ResourceNotice resource={balancesResource} label="balances" retry={retryFor(resourceKeys.balances(settleUserId, id), me.data?.id)} /><form className="reading-width" onSubmit={submit} aria-describedby={error ? 'settlement-form-error' : undefined}><Field label="Who paid?"><select value={from} onChange={(event) => { setError(undefined); markDirty(); setFrom(event.target.value); }}>{members.map((member) => <option key={member.personId} value={member.personId}>{member.name}{member.personId === currentPersonId ? ' · You' : ''}</option>)}</select></Field><Field label="Who received?"><select value={to} onChange={(event) => { setError(undefined); markDirty(); setTo(event.target.value); }}>{members.filter((member) => member.personId !== from).map((member) => <option key={member.personId} value={member.personId}>{member.name}{member.personId === currentPersonId ? ' · You' : ''}</option>)}</select></Field><Field label="Currency"><CurrencySelect value={currency} onChange={(value) => { setError(undefined); markDirty(); setCurrency(value); }} /></Field><Field label={`Amount (${currency})`}><input className={amountInputClass(amount)} data-amount-length={amountInputLength(amount)} required inputMode="decimal" aria-invalid={Boolean(error)} value={amount} onChange={(event) => { setError(undefined); markDirty(); setAmount(event.target.value); }} /></Field>{dirty ? <Button className="full-width-button" type="button" variant="secondary" onClick={resetSuggestion}>Reset to current suggestion</Button> : null}{error ? <ErrorBox error={error} id="settlement-form-error" /> : null}<Button className="full-width-button" disabled={submitting} type="submit">{submitting ? 'Recording…' : 'Record payment'}</Button></form></Layout>;
}

function Activity() {
  const online = useOnlineStatus();
  const { id = '' } = useParams();
  const me = useResource(resourceKeys.identity(), '', (signal) => getMe({ signal }), RESOURCE_FRESHNESS.expenses, hydrateIdentity);
  const activity = useResource<{ activity: ActivityItem[] }>(resourceKeys.activity(me.data?.id || 'pending', id), me.data?.id, (signal) => getActivity(id, signal), RESOURCE_FRESHNESS.activity, me.data?.id ? () => hydrateActivity(me.data!.id, id) : undefined);
  const items = activity.data?.activity || [];
  const typeLabel = (type: ActivityItem['type']) => ({ expense: 'Expense', settlement: 'Settlement', expense_revision: 'Expense edited', settlement_revision: 'Settlement edited', expense_deleted: 'Expense deleted', settlement_deleted: 'Settlement deleted' })[type];
  const titleFor = (item: ActivityItem) => item.type.startsWith('settlement') ? `${item.fromName || 'Unknown member'} paid ${item.toName || 'unknown member'}` : item.label || 'Expense';
  const descriptionFor = (item: ActivityItem) => item.type.startsWith('settlement') ? (item.label || '') : item.label || '';
  const dateFor = (item: ActivityItem) => item.transactionDate || item.createdAt.slice(0, 10);
  const row = (item: ActivityItem) => <span><strong>{titleFor(item)}</strong><small>{typeLabel(item.type)} · {dateFor(item)}</small>{descriptionFor(item) && descriptionFor(item) !== titleFor(item) ? <small className="activity-description">{descriptionFor(item)}</small> : null}</span>;
  const itemRow = (item: ActivityItem) => {
    const content = <>{row(item)}{item.amountMinor != null && item.currency ? <Money amountMinor={item.amountMinor} currency={item.currency} /> : null}</>;
      const path = activityDetailPath(id, item);
      return path ? <Link className="row" to={path} key={`${item.type}-${item.id}`}>{content}</Link> : <div className="row" key={`${item.type}-${item.id}`}>{content}</div>;
  };
   return <Layout><Link to={`/groups/${id}`} className="back">← Group</Link><h1>Activity</h1>{!online || activity.offline ? <p className="offline-banner" role="status">Offline · showing cached activity.</p> : null}{me.error && activity.data !== undefined ? <CachedIdentityNotice resource={me} id="activity-identity-error" /> : null}{me.error && activity.data === undefined ? <ErrorBox error={me.error} onRetry={retryFor(resourceKeys.identity(), '')} id="activity-identity-error" retryLabel="Retry identity check" /> : null}{!me.error || activity.data !== undefined ? <ResourceNotice resource={activity} label="activity" retry={retryFor(resourceKeys.activity(me.data?.id || 'pending', id), me.data?.id)} /> : null}{activity.data !== undefined && items.length ? <div className="list reading-width">{items.map(itemRow)}</div> : activity.data !== undefined ? <Empty>No activity yet.</Empty> : null}</Layout>;
}

function Settings() {
  const online = useOnlineStatus();
  const [outbox, setOutbox] = useState<ExpenseOutboxItem[]>(getOutboxSnapshot());
  const [outboxReady, setOutboxReady] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState<unknown>();
  const [logoutError, setLogoutError] = useState<unknown>();
  const { signOut } = useClerk();
  useEffect(() => {
    let active = true;
    const unsubscribe = subscribeOutbox(() => setOutbox(getOutboxSnapshot()));
    void initializeOutbox().then(() => { if (active) setOutboxReady(true); }).catch(() => undefined);
    return () => { active = false; unsubscribe(); };
  }, []);

  const clearCache = async () => {
    if (!confirm('Clear cached identity, groups, snapshots, and recent preferences? Pending and uncertain expenses will be preserved.')) return;
    setClearing(true); setMessage(''); setError(undefined);
    try {
      await clearCachedData();
      window.dispatchEvent(new Event('billsplit-cache-cleared'));
      setMessage('Cached account and group data cleared. Pending expenses were preserved.');
    } catch (cause) { setError(cause); }
    finally { setClearing(false); }
  };

  const logout = async () => {
    if (outbox.length && !confirm(`You have ${outbox.length} unsynced expense${outbox.length === 1 ? '' : 's'}. Logging out will permanently delete them from this device. Continue?`)) return;
    setClearing(true); setError(undefined); setLogoutError(undefined);
    try {
      await clearEverythingForLogout();
      try {
        await signOut({ redirectUrl: '/' });
      } catch (cause) {
        recoverAfterClerkSignOutFailure(cause);
        throw cause;
      }
    } catch (cause) { setLogoutError(cause); setClearing(false); }
  };

  return <Layout>
    <div className="page-title"><div><p className="eyebrow">More</p><h1>Settings</h1></div></div>
    <section><h2>Device</h2><p className="muted" role="status">{online ? 'Online' : 'Offline'} · {outbox.length ? `${outbox.length} expense${outbox.length === 1 ? '' : 's'} pending` : 'No expenses pending'}</p><InstallAction showStatus /></section>
    <section><h2>Pending expenses</h2>{outbox.length ? <div className="list">{outbox.map((item) => <div className="row" key={item.clientOperationId}><span>{item.display.description}<small>{statusLabel(item.status, item.deliveryUncertain)}</small></span><strong>{item.display.currency} {(item.display.amountMinor / 100).toFixed(2)}</strong></div>)}</div> : <p className="muted">New expenses sync automatically when you are online and signed in.</p>}</section>
     <section><h2>Trusted-device offline access</h2><p className="muted">After a verified visit, this browser keeps a private copy of your identity and recent group data so you can capture new expenses offline. It never stores a Clerk token, and replay still requires an active Clerk session. Only use this on a device you trust.</p></section>
     <section><h2>Local data</h2><p className="muted">Clear cached identity, groups, snapshots, and recent preferences without deleting pending or uncertain outbox expenses. Resolve those from the queue controls before removing them.</p><Button variant="secondary" disabled={clearing} onClick={() => void clearCache}>{clearing ? 'Clearing…' : 'Clear cached data'}</Button>{message ? <p className="muted" role="status">{message}</p> : null}{error ? <ErrorBox error={error} /> : null}</section>
       <section><h2>Account</h2><p className="muted">Logging out clears all local account data and pending expenses before Clerk ends the session.</p>{logoutError ? <div className="error" id="logout-error" role="alert" aria-live="assertive"><strong>Logout was not completed.</strong> <span>{errorText(logoutError)}</span></div> : null}<Button variant="danger" disabled={!outboxReady || clearing} onClick={() => void logout}>{outboxReady ? clearing ? 'Clearing local data…' : 'Log out' : 'Checking pending expenses…'}</Button></section>
   </Layout>;
}

function PrivateRoutes() {
  const identityEpoch = useResourceIdentityEpoch();
  return <Routes key={identityEpoch}><Route path="/" element={<Home />} /><Route path="/settings" element={<Settings />} /><Route path="/groups/:id" element={<GroupPage />} /><Route path="/groups/:id/expense/new" element={<ExpenseForm />} /><Route path="/groups/:id/expense/:expenseId" element={<ExpenseForm />} /><Route path="/groups/:id/scheduled-expense/new" element={<ExpenseForm />} /><Route path="/groups/:id/scheduled-expense/:scheduledExpenseId" element={<ExpenseForm />} /><Route path="/groups/:id/expenses/:expenseId" element={<ExpenseDetail />} /><Route path="/expenses/:expenseId" element={<ExpenseDetail />} /><Route path="/groups/:id/settle" element={<Settle />} /><Route path="/groups/:id/activity" element={<Activity />} /><Route path="*" element={<Navigate to="/" replace />} /></Routes>;
}

export function App() {
  const location = useLocation();
  const { isLoaded, isSignedIn, userId, sessionId } = useAuth();
  const auth = useSyncExternalStore(subscribeAuthLifecycle, getAuthLifecycle, () => ({ status: 'checking' as const }));
  const logoutInProgress = useSyncExternalStore(subscribeSessionState, getSessionLogoutInProgress, () => false);
  const clerkSessionRef = useRef<string>();
  const offlineStartedBeforeClerkRef = useRef(false);
  const online = typeof navigator === 'undefined' || navigator.onLine !== false;
  useEffect(() => {
    if (!shouldStartAuthCheck(online, isLoaded) && !isDevelopmentAuthBypass) return;
    if (!isLoaded && !online) {
      offlineStartedBeforeClerkRef.current = true;
      void initializeAuthLifecycle();
      return;
    }
    const sessionKey = userId && sessionId ? `${userId}:${sessionId}` : undefined;
    const currentClerkUserId = typeof userId === 'string' ? userId : undefined;
    const providerChangedAfterOfflineStart = offlineStartedBeforeClerkRef.current;
    const providerTransitionPending = providerChangedAfterOfflineStart && auth.status === 'checking';
    if (!providerTransitionPending) offlineStartedBeforeClerkRef.current = false;
    const sessionChanged = isMeaningfulClerkSessionTransition(clerkSessionRef.current, sessionKey);
    const clerkUserIdHydrated = isTrustedOfflineClerkUserIdHydrated();
    const cachedOfflineClerkUserId = providerChangedAfterOfflineStart && clerkUserIdHydrated ? getTrustedOfflineClerkUserId() : undefined;
    const offlineAccountChanged = shouldRevokeForOfflineClerkUser(providerChangedAfterOfflineStart, isSignedIn === true, currentClerkUserId, cachedOfflineClerkUserId, clerkUserIdHydrated);
    const sessionTransition = sessionChanged || offlineAccountChanged;
    if (online && sessionTransition) resetForClerkSessionChange();
    else if (!online && sessionTransition) revokeForClerkSessionChange();
    if (isSignedIn && sessionKey) clerkSessionRef.current = sessionKey;
    if ((isSignedIn === true || !online || isDevelopmentAuthBypass) && !(sessionTransition && !online)) void initializeAuthLifecycle({ ...(shouldReverifyTrustedOffline(online, isLoaded === true, isSignedIn === true, auth.status) ? { networkOnly: true } : {}), ...(currentClerkUserId ? { clerkUserId: currentClerkUserId } : {}) });
    else if (!isDevelopmentAuthBypass && isDefinitivelySignedOut(isLoaded === true, isSignedIn)) {
      clerkSessionRef.current = undefined;
      markSignedOut();
    }
  }, [auth.status, isLoaded, isSignedIn, online, sessionId, userId]);
  useEffect(() => {
    if (!isSignedIn && !isDevelopmentAuthBypass && auth.status !== 'trusted-offline') return;
    const retry = () => { if (navigator.onLine !== false) void initializeAuthLifecycle({ networkOnly: auth.status === 'trusted-offline', ...(typeof userId === 'string' ? { clerkUserId: userId } : {}) }); };
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, [auth.status, isSignedIn, userId]);
  const returnTo = `${location.pathname}${location.search}${location.hash}`;
  if (logoutInProgress) return <PublicShell returnTo={returnTo}><div className="public-status" aria-live="polite"><p className="muted">Signing out securely…</p></div></PublicShell>;
  if (auth.status === 'checking') return <PublicShell returnTo={returnTo}><div className="public-status" aria-live="polite"><Loading /></div></PublicShell>;
  if (auth.status === 'unauthenticated') return <PublicLanding logoutError={auth.error instanceof Error && auth.error.name === 'ClerkSignOutFailure' ? auth.error : undefined} />;
  return <PrivateRoutes />;
}
