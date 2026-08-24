import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { SignInButton, SignUpButton, useAuth, useClerk, useUser } from '@clerk/react';
import type { Activity as ActivityItem, AuditEvent, Balances, Currency, Expense, Group, GroupInvitation, GroupMember, HistoricalParticipant, RecurrenceFrequency, ScheduledExpense, ScheduledExpenseStatus, Settlement, SplitMethod, Transaction, Weekday } from '../shared/types';
import { currencyOptions, scheduledExpenseInput, type ExpenseInput, type ScheduledExpenseInput } from '../shared/schemas';
import { checkedSumMinor, formatMoney, parseMoney } from '../domain/money';
 import { acceptInvitation, ApiError, api, changeScheduledExpenseStatus, completePendingAccountDeletion, coordinateAuthBootstrap, createGroupInvitation, createScheduledExpense, deleteAccount, deleteGroup, discardInvalidPendingAccountDeletion, finishLocalCleanupAfterExternalProviderDeletion, getActivity, getActivityPage, getAuditPage, getAuthLifecycle, getBalances, getCategories, getCategorySuggestion, getExpenseDetails, getExpensePage, getExpenses, getExportPage, getGroup, getGroupCsvExportPage, getGroupExportPage, getGroupSettlementCsvExportPage, getGroups, getMe, getOwnerInvitations, getPendingAccountDeletionClerkUserId, getPendingAccountDeletionPhase, getPendingInvitations, getScheduledExpense, getScheduledExpensePage, getScheduledExpenses, getSettlementDetails, getSettlementPage, getSettlements, getTransactionPage, getTransactions, hasInvalidPendingAccountDeletion, hasPendingAccountDeletion, hasRetainedPrivateSession, hydrateActivity, hydrateBalances, hydrateCategories, hydrateExpenseDetails, hydrateExpenses, hydrateGroup, hydrateGroups, hydrateIdentity, hydrateSettlements, hydrateTransactionOverview, hydrateTransactions, isPrivateCacheRouteCurrent, leaveGroup, rejectInvitation, removeGroupMember, restoreExpense, restoreSettlement, revokeForClerkSessionChange, revokeGroupInvitation, transferGroupOwnership, updateGroup, updateScheduledExpense, updateSettlement, getTrustedOfflineClerkUserId, getVerifiedClerkUserId, isDefinitivelySignedOut, isDevelopmentAuthBypass, isIncompleteLoadedSignedInEvidence, recoverAfterClerkSignOutFailure, resetForClerkSessionChange, shouldReverifyTrustedOffline, shouldStartAuthCheck, subscribeAuthLifecycle, clearEverythingForLogout } from './api';
import { ACCOUNT_DELETION_CONFIRMATION } from '../shared/schemas';
import { allocationMetadataByPerson, allocationSplits, allocationStateFromSplits, amountFieldClass, amountInputClass, amountInputLength, currentPayerSelection, formServerVersion, hasNewerServerVersion, isExpenseConflict, normalizeSinglePayer, previewAllocation, settlementSuggestion, settlementSuggestionFingerprint, type AllocationState } from './form-helpers';
import { Button, Field, InstallAction, Layout, Modal, Money, PublicShell, Status, Surface, connectionStatusLabel, useAuthLifecycle, useConnectionState, useOnlineStatus } from './ui';
import { discardOutboxItem, enqueueExpense, flushOutbox, getOutboxSnapshot, initializeOutbox, retryOutboxItem, statusLabel, subscribeOutbox, type ExpenseOutboxItem } from './outbox';
import { clearCachedData } from './idb';
import { getResourceSnapshot, invalidateForMutation, invalidateResource, revalidate, RESOURCE_FRESHNESS, resourceKeys, resourceViewState, useResource, useResourceIdentityEpoch, type ResourceSnapshot } from './resource-cache';
import { groupBalanceDisplays, personalBalances } from './group-balance';
import { expenseDetailPath, getNavigationContext, settlementDetailPath, transactionActivityPath } from './navigation';
import { captureSessionGeneration, getSessionLogoutInProgress, subscribeSessionState } from './session';
import { browserTimezone, formatScheduleDate, otherTimezoneValue, previewScheduleDates, scheduleContinuationText, scheduleSummary, timezoneLabel, timezoneOptions, timezoneSelectValue as timezoneSelectValueForState, timezoneValueFromSelection, weekdayLabels } from './scheduled-expense';
import { categoryOptions } from './categories';
import { localDateForTimeZone } from '../domain/recurrence';
import { appendUniquePage, createPageRequestScope } from './pagination';
import { assembleCsvPages, collectPagedAccountExport, collectPagedExport, collectPagedGroupExport } from './export';
import { expenseFilterCount, expenseFilterKey, hasExpenseFilters, readExpenseFilters, writeExpenseFilters, type ExpenseFilters } from './expense-filters';
import { hasTransactionFilters, readTransactionFilters, transactionFilterCount, transactionFilterKey, writeTransactionFilters, type TransactionFilters } from './transaction-filters';
import { transactionDate, transactionKey, transactionPeople, transactionTitle, transactionTypeLabel } from './transaction-ui';

const today = () => new Date().toISOString().slice(0, 10);
const operationId = () => crypto.randomUUID();
const errorText = (error: unknown) => error instanceof ApiError && error.networkFailure ? (error.reconnectRequired ? 'Connection issue. Retry when the connection is available; your pending expense remains retryable.' : 'You appear to be offline. Only new expenses can be queued; edits, deletes, settlements, and membership changes require a connection.') : error instanceof Error ? error.message : 'Something went wrong';
function Loading() { return <p className="muted" role="status" aria-live="polite">Loading…</p>; }
function VerificationUnavailable({ onRetry }: { onRetry: () => void }) {
  const connection = useConnectionState();
  const title = connection.status === 'offline' ? 'You are offline' : connection.status === 'connection-issue' ? 'Connection issue' : 'Verification is unavailable';
  return <PublicShell showAuthActions={false}><div className="public-status" role="alert" aria-live="assertive"><h1>{title}</h1><p className="muted">BillSplit could not verify this browser for private access. Retry when the connection is available; the app will not treat an unverified account as signed out.</p><Button type="button" variant="secondary" onClick={onRetry}>Retry verification</Button></div></PublicShell>;
}
function PrivateCacheUnavailable({ onRetry }: { onRetry: () => void }) {
  return <PublicShell showAuthActions={false}><div className="public-status" role="status" aria-live="polite"><h1>This page is not cached</h1><p className="muted">There is no trusted local copy of this private page yet. Connect to verify your session and load it, then it will be available for trusted-device startup.</p><Button type="button" variant="secondary" onClick={onRetry}>Retry verification</Button></div></PublicShell>;
}

function PublicLanding({ logoutError, accountDeletionNotice }: { logoutError?: unknown; accountDeletionNotice?: boolean } = {}) {
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
        {logoutError ? <div className="error" role="alert"><strong>Logout needs another try.</strong> <span>{errorText(logoutError)}</span> <Button type="button" variant="secondary" disabled={retryingSignOut} onClick={() => void retrySignOut}>{retryingSignOut ? 'Retrying…' : 'Retry logout'}</Button></div> : null}{accountDeletionNotice ? <p className="cache-status" role="status">BillSplit data and local cleanup are complete. This Clerk client could not delete the Clerk account; manage that Clerk account separately.</p> : null}<section className="landing-note"><h2>Private, even when offline</h2><p>Your signed-in browser may keep recent group data and queued expenses locally for trusted-device offline use. Clerk session tokens are never stored by BillSplit, and syncing still requires an active Clerk session. Clear everything from Settings before handing off a device.</p></section>
    </div>
  </PublicShell>;
}
function ErrorBox({ error, id = 'resource-error', onRetry, retryLabel = 'Retry' }: { error: unknown; id?: string; onRetry?: () => void; retryLabel?: string }) {
  const connection = useConnectionState();
  return <div className="error" id={id} role="alert" aria-live="assertive"><span>{errorText(error)}</span>{onRetry && connection.status !== 'offline' ? <Button type="button" variant="secondary" onClick={onRetry}>{retryLabel}</Button> : null}</div>;
}
const connectionBannerLabel = (status: ReturnType<typeof useConnectionState>['status']) => status === 'checking' ? 'Checking connection' : status === 'connection-issue' ? 'Connection issue' : 'Offline';
function ConnectionBanner({ detail }: { detail: string }) {
  const connection = useConnectionState();
  const label = connectionBannerLabel(connection.status);
  return <p className={`offline-banner connection-banner connection-banner--${connection.status}`} role={connection.status === 'connection-issue' ? 'alert' : 'status'}>{label} · {detail}</p>;
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
  const connection = useConnectionState();
  // A no-data private resource cannot recover while the cached identity is stale.
  if (resource.data === undefined && getResourceSnapshot('identity').error !== undefined) return null;
  if (resource.data === undefined) {
    if (resourceViewState(resource) === 'error') return <ErrorBox error={resource.error} onRetry={connection.status === 'offline' ? undefined : retry} id={`${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-error`} />;
    return resource.loading || resource.status === 'idle' ? <Loading /> : null;
  }
  if (resource.revalidating) return <p className="cache-status" role="status">Refreshing {label}…</p>;
  if (resource.error || resource.stale || resource.offline) return <p className="cache-status" role="status">Showing cached {label}; it may be out of date. {retry && connection.status !== 'offline' ? <button className="inline-action" type="button" onClick={retry}>Retry</button> : null}</p>;
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

function PendingInvitations({ userId, online }: { userId?: string; online: boolean }) {
  const invitationsResource = useResource<{ invitations: GroupInvitation[] }>(resourceKeys.invitations(userId || 'pending'), userId, (signal) => getPendingInvitations(signal), RESOURCE_FRESHNESS.invitations);
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState<unknown>();
  const invitations = invitationsResource.data?.invitations || [];
  const respond = async (invitation: GroupInvitation, action: 'accept' | 'reject') => {
    if (!online || busyId) return;
    setBusyId(invitation.id); setError(undefined);
    try {
      if (action === 'accept') {
        await acceptInvitation(invitation.id);
        await invalidateForMutation.invitationsChanged(invitation.groupId, userId);
        await invalidateForMutation.groupChanged(invitation.groupId, userId);
        window.location.assign(`/groups/${encodeURIComponent(invitation.groupId)}`);
      } else {
        await rejectInvitation(invitation.id);
        await invalidateForMutation.invitationsChanged(undefined, userId);
      }
    } catch (cause) { setError(cause); }
    finally { setBusyId(undefined); }
  };
  if (!invitations.length && !error) return null;
  return <Surface className="invitations"><div className="section-title"><h2>Pending invitations</h2><span className="muted">Matched to your verified email</span></div>{invitations.map((invitation) => <div className="row" key={invitation.id}><span><strong>{invitation.email}</strong><small>Expires {new Date(invitation.expiresAt).toLocaleDateString()}</small></span><div className="actions"><Button type="button" disabled={!online || busyId === invitation.id} onClick={() => void respond(invitation, 'accept')}>{busyId === invitation.id ? 'Working…' : 'Accept'}</Button><Button type="button" variant="secondary" disabled={!online || busyId === invitation.id} onClick={() => void respond(invitation, 'reject')}>Reject</Button></div></div>)}{error ? <ErrorBox error={error} id="invitation-response-error" /> : null}{!online ? <p className="muted">Invitation responses require a connection.</p> : null}</Surface>;
}

function GroupSettings({ group, groupId, userId, online, role, onDeleted, onLeft }: { group: Group; groupId: string; userId: string; online: boolean; role: 'owner' | 'member'; onDeleted: () => void; onLeft: () => void }) {
  const [name, setName] = useState(group.name);
  const [currency, setCurrency] = useState<Currency>(group.currency);
  const [busy, setBusy] = useState<'save' | 'delete' | 'leave'>();
  const [error, setError] = useState<unknown>();
  useEffect(() => { setName(group.name); setCurrency(group.currency); }, [group.currency, group.name]);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!online || busy || !name.trim()) return;
    setBusy('save'); setError(undefined);
    try {
      await updateGroup(groupId, { name: name.trim(), currency });
      await invalidateForMutation.groupChanged(groupId, userId, captureSessionGeneration());
    } catch (cause) { setError(cause); }
    finally { setBusy(undefined); }
  };
  const remove = async () => {
    if (!online || busy) return;
    const confirmation = window.prompt(`Type the group name exactly to delete “${group.name}”. This is a soft-delete and can be purged after 30 days.`, '');
    if (confirmation !== group.name) return;
    setBusy('delete'); setError(undefined);
    try {
      const generation = captureSessionGeneration();
      await deleteGroup(groupId);
      await invalidateForMutation.groupDeleted(groupId, userId, generation);
      onDeleted();
    } catch (cause) { setError(cause); setBusy(undefined); }
  };
  const leave = async () => {
    if (!online || busy || !confirm(`Leave ${group.name}? You will lose access to this group. Historical transactions are retained for the group.`)) return;
    setBusy('leave'); setError(undefined);
    try { const generation = captureSessionGeneration(); await leaveGroup(groupId); await invalidateForMutation.groupLeft(groupId, userId, generation); onLeft(); }
    catch (cause) { setError(cause); setBusy(undefined); }
  };
  if (role === 'member') return <section className="group-settings"><div className="section-title"><h2>Group settings</h2><span className="muted">Member · online-only</span></div><p className="muted">You can leave this group at any time. The owner must transfer ownership before leaving.</p><div className="actions"><Button type="button" variant="danger" disabled={!online || Boolean(busy)} onClick={() => void leave()}>{busy === 'leave' ? 'Leaving…' : 'Leave group'}</Button></div>{error ? <ErrorBox error={error} id="group-settings-error" /> : null}</section>;
  return <section className="group-settings"><div className="section-title"><h2>Group settings</h2><span className="muted">Owner · online-only</span></div><p className="muted">Changing the default currency does not convert existing expenses or settlements. Existing transactions keep their original currency.</p><form onSubmit={save} aria-describedby={error ? 'group-settings-error' : undefined}><Field label="Group name"><input required value={name} onChange={(event) => setName(event.target.value)} /></Field><Field label="Default currency"><CurrencySelect value={currency} onChange={setCurrency} /></Field><Button type="submit" disabled={!online || busy === 'save'}>{busy === 'save' ? 'Saving…' : 'Save settings'}</Button></form><div className="actions"><Button type="button" variant="danger" disabled={!online || Boolean(busy)} onClick={() => void remove()}>{busy === 'delete' ? 'Deleting…' : 'Delete group'}</Button></div>{error ? <ErrorBox error={error} id="group-settings-error" /> : null}<p className="muted">Deleting a group is a soft-delete. It is retained for 30 days before cleanup and removes it from your active groups.</p></section>;
}

async function saveDownload(blob: Blob, filename: string) {
  const picker = (window as Window & { showSaveFilePicker?: (options: unknown) => Promise<{ createWritable: () => Promise<{ write: (value: Blob) => Promise<void>; close: () => Promise<void> }> }> }).showSaveFilePicker;
  if (picker) {
    try { const handle = await picker({ suggestedName: filename }); const writable = await handle.createWritable(); await writable.write(blob); await writable.close(); return; } catch (error) { if (error instanceof DOMException && error.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
}

function GroupExports({ groupId, online }: { groupId: string; online: boolean }) {
  const [busy, setBusy] = useState<'json' | 'csv' | 'settlements'>();
  const [progress, setProgress] = useState('');
  const [error, setError] = useState<unknown>();
  const controller = useRef<AbortController>();
  const cancel = () => controller.current?.abort();
  const exportJson = async () => {
    if (!online || busy) return; setBusy('json'); setError(undefined); setProgress('Starting…'); const abort = new AbortController(); controller.current = abort;
     try { const result = await collectPagedGroupExport((cursors, signal) => getGroupExportPage(groupId, { limit: 50, ...cursors }, signal), abort.signal, (count) => setProgress(`Fetched page ${count}`)); await saveDownload(new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), ...result })], { type: 'application/json' }), 'billsplit-group.json'); }
    catch (cause) { if (!(cause instanceof DOMException && cause.name === 'AbortError')) setError(cause); else setProgress('Cancelled'); }
    finally { controller.current = undefined; setBusy(undefined); }
  };
  const exportCsv = async () => {
    if (!online || busy) return; setBusy('csv'); setError(undefined); setProgress('Starting…'); const abort = new AbortController(); controller.current = abort;
      try { const pages = await collectPagedExport(async (cursor, signal) => { const page = await getGroupCsvExportPage(groupId, { limit: 100, cursor }, signal); return { items: [await page.blob.text()], nextCursor: page.nextCursor }; }, abort.signal, (count) => setProgress(`Fetched page ${count}`)); await saveDownload(new Blob([assembleCsvPages(pages, 'date,description,amount_minor,currency,payers,splits')], { type: 'text/csv;charset=utf-8' }), 'billsplit-expenses.csv'); }
    catch (cause) { if (!(cause instanceof DOMException && cause.name === 'AbortError')) setError(cause); else setProgress('Cancelled'); }
    finally { controller.current = undefined; setBusy(undefined); }
  };
  const exportSettlements = async () => {
    if (!online || busy) return; setBusy('settlements'); setError(undefined); setProgress('Starting…'); const abort = new AbortController(); controller.current = abort;
      try { const pages = await collectPagedExport(async (cursor, signal) => { const page = await getGroupSettlementCsvExportPage(groupId, { limit: 100, cursor }, signal); return { items: [await page.blob.text()], nextCursor: page.nextCursor }; }, abort.signal, (count) => setProgress(`Fetched page ${count}`)); await saveDownload(new Blob([assembleCsvPages(pages, 'date,from_person,to_person,amount_minor,currency,note')], { type: 'text/csv;charset=utf-8' }), 'billsplit-settlements.csv'); }
    catch (cause) { if (!(cause instanceof DOMException && cause.name === 'AbortError')) setError(cause); else setProgress('Cancelled'); }
    finally { controller.current = undefined; setBusy(undefined); }
  };
  return <section className="export-controls"><div className="section-title"><h2>Export</h2><span className="muted">Paged, connection required</span></div><p className="muted">Exports fetch bounded pages and can be cancelled before download.</p><div className="actions"><Button type="button" variant="secondary" disabled={!online || Boolean(busy)} onClick={() => void exportJson()}>{busy === 'json' ? 'Exporting JSON…' : 'Export JSON'}</Button><Button type="button" variant="secondary" disabled={!online || Boolean(busy)} onClick={() => void exportCsv()}>{busy === 'csv' ? 'Exporting expenses CSV…' : 'Export expenses CSV'}</Button><Button type="button" variant="secondary" disabled={!online || Boolean(busy)} onClick={() => void exportSettlements()}>{busy === 'settlements' ? 'Exporting settlements CSV…' : 'Export settlements CSV'}</Button>{busy ? <Button type="button" variant="danger" onClick={cancel}>Cancel</Button> : null}</div>{progress ? <p className="cache-status" role="status">{progress}</p> : null}{error ? <ErrorBox error={error} id="export-error" /> : null}</section>;
}

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
      <PendingInvitations userId={me.data?.id} online={online && !offlineView} />
      {formMode === 'friend' && <Surface><h2>Add friend</h2><p className="muted">Use the exact email your friend uses to sign in with Clerk to link them to this shared group ledger. Clerk verifies and asserts their identity; it does not grant group access. Leave it blank for a ledger-only friend; no email means they cannot log in to this ledger.</p><form onSubmit={createFriend} aria-describedby={createError ? 'create-friend-error' : undefined}><Field label="Friend name"><input id="friend-name" required aria-invalid={Boolean(createError)} aria-describedby={createError ? 'create-friend-error' : undefined} value={friendName} onChange={(event) => { setCreateError(undefined); setFriendName(event.target.value); }} /></Field><Field label="Email (optional)"><input id="friend-email" className="email" type="email" value={friendEmail} onChange={(event) => { setCreateError(undefined); setFriendEmail(event.target.value); }} /></Field><Field label="Default currency"><CurrencySelect value={friendCurrency} onChange={(value) => { setCreateError(undefined); setFriendCurrency(value); }} /></Field>{createError ? <ErrorBox error={createError} id="create-friend-error" /> : null}<Button disabled={offlineView || submitting} type="submit">{submitting ? 'Adding…' : 'Add friend'}</Button></form></Surface>}
     {formMode === 'group' && <Surface><h2>New group</h2><p className="muted">Create a group for three or more people, then add friends from the group page.</p><form onSubmit={createGroup} aria-describedby={createError ? 'create-group-error' : undefined}><Field label="Group name"><input id="group-name" required aria-invalid={Boolean(createError)} aria-describedby={createError ? 'create-group-error' : undefined} value={name} onChange={(event) => { setCreateError(undefined); setName(event.target.value); }} /></Field><Field label="Default currency"><CurrencySelect value={currency} onChange={(value) => { setCreateError(undefined); setCurrency(value); }} /></Field>{createError ? <ErrorBox error={createError} id="create-group-error" /> : null}<Button disabled={offlineView || submitting} type="submit">{submitting ? 'Creating…' : 'Create group'}</Button></form></Surface>}
      {offlineView ? <ConnectionBanner detail="showing your last verified groups. Friend and group creation require a connection; Add Expense remains available from cached groups." /> : null}{groupsResource.data !== undefined ? <CachedIdentityNotice resource={me} id="groups-identity-error" /> : null}{groupsResource.data === undefined && me.error ? <ErrorBox error={me.error} onRetry={retryFor(resourceKeys.identity(), '')} id="identity-error" retryLabel="Retry identity check" /> : null}
     {groupsResource.data === undefined && !me.error ? <ResourceNotice resource={groupsResource} label="groups" retry={retryFor(resourceKeys.groups(me.data?.id || 'pending'), me.data?.id)} /> : groupsResource.data !== undefined ? <><ResourceNotice resource={groupsResource} label="groups" retry={retryFor(resourceKeys.groups(me.data?.id || 'pending'), me.data?.id)} />{groups.length ? <div className="cards">{groups.map((group) => <Link className="card" to={`/groups/${group.id}`} key={group.id}><strong className="card__name">{group.memberCount === 2 && group.counterpartName ? group.counterpartName : group.name}</strong><div className="card__balances">{groupBalanceDisplays(group.balanceSummaries, group.currency).map((display, index) => display.kind === 'balance' ? <span className="card__balance" key={`${display.currency}-${index}`}><span className="card__balance-label">{display.label}</span><span className="card__balance-money"><Money amountMinor={display.amountMinor} currency={display.currency} tone={display.label === 'You are owed' ? 'positive' : 'debt'} /><small>{display.currency}</small></span></span> : <span className={`card__balance card__balance--${display.kind}`} key={`${display.label}-${index}`}><span className="card__balance-label">{display.label}</span><small>{display.currency}</small></span>)}</div></Link>)}</div> : <Empty>No groups yet. Add a friend or create a group to get started.</Empty>}</> : null}
  </Layout>;
}

function MemberDirectory({ groupId, userId, members, online, owner }: { groupId: string; userId: string; members: GroupMember[]; online: boolean; owner: boolean }) {
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<unknown>();
  const remove = async (member: GroupMember) => {
    if (!owner || !online || busy || !confirm(`Remove ${member.name} from this group? Historical transactions remain visible.`)) return;
    setBusy(`remove:${member.personId}`); setError(undefined);
    try { await removeGroupMember(groupId, member.personId); await invalidateForMutation.groupChanged(groupId, userId, captureSessionGeneration()); }
    catch (cause) { setError(cause); }
    finally { setBusy(undefined); }
  };
  const transfer = async (member: GroupMember) => {
    if (!owner || !online || busy || !member.linked || member.role === 'owner' || !confirm(`Transfer ownership to ${member.name}? You will become a member.`)) return;
    setBusy(`transfer:${member.personId}`); setError(undefined);
    try { await transferGroupOwnership(groupId, member.personId); await invalidateForMutation.groupChanged(groupId, userId, captureSessionGeneration()); }
    catch (cause) { setError(cause); }
    finally { setBusy(undefined); }
  };
  return <>
    <ul className="member-list" aria-label="Group members">{members.map((member) => <li className="member-row" key={member.personId}>
      <div className="member-row__identity"><strong>{member.name}</strong>{member.email ? <span className="email">{member.email}</span> : <span className="muted">No email linked</span>}<span className="muted">Role: {member.role === 'owner' ? 'Owner' : 'Member'}{member.linked ? '' : ' · ledger-only'}</span></div>
      {owner && member.role !== 'owner' ? <div className="member-row__actions" aria-label={`Actions for ${member.name}`}><Button type="button" variant="danger" disabled={!online || Boolean(busy)} onClick={() => void remove(member)}>Remove</Button>{member.linked ? <Button type="button" variant="secondary" disabled={!online || Boolean(busy)} onClick={() => void transfer(member)}>Transfer ownership</Button> : null}</div> : null}
    </li>)}</ul>{error ? <ErrorBox error={error} id="member-management-error" /> : null}
  </>;
}

function OwnerMemberControls({ groupId, userId, online }: { groupId: string; userId: string; online: boolean }) {
  const effectiveOnline = online && (typeof navigator === 'undefined' || navigator.onLine !== false);
  const invitationsResource = useResource<{ invitations: GroupInvitation[] }>(resourceKeys.groupInvitations(userId, groupId), userId, (signal) => getOwnerInvitations(groupId, signal), RESOURCE_FRESHNESS.invitations, undefined, { skipWhenOffline: !effectiveOnline });
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<unknown>();
  const [inviteError, setInviteError] = useState<unknown>();
  const invitations = invitationsResource.data?.invitations || [];
  const invite = async (event: FormEvent) => {
    event.preventDefault(); if (!effectiveOnline || busy) return;
    setBusy('invite'); setInviteError(undefined);
    try { await createGroupInvitation(groupId, email.trim()); setEmail(''); await invalidateForMutation.invitationsChanged(groupId, userId); }
    catch (cause) { setInviteError(cause); }
    finally { setBusy(undefined); }
  };
  const revoke = async (invitation: GroupInvitation) => {
    if (!effectiveOnline || busy || !confirm(`Revoke the invitation for ${invitation.email}?`)) return;
    setBusy(invitation.id); setError(undefined);
    try { await revokeGroupInvitation(groupId, invitation.id); await invalidateForMutation.invitationsChanged(groupId, userId); }
    catch (cause) { setError(cause); }
    finally { setBusy(undefined); }
  };
  const offlineWithoutCache = !effectiveOnline && invitationsResource.data === undefined;
  return <section aria-labelledby="invitations-heading"><div className="section-title"><h2 id="invitations-heading">Invitations</h2><span className="muted">Owner · online-only</span></div><form onSubmit={invite} aria-describedby={inviteError ? 'invite-error' : undefined}><Field label="Invite by email"><input className="email" type="email" required value={email} onChange={(event) => { setInviteError(undefined); setEmail(event.target.value); }} /></Field><Button type="submit" disabled={!effectiveOnline || busy === 'invite'}>{busy === 'invite' ? 'Inviting…' : 'Invite'}</Button></form>{inviteError ? <ErrorBox error={inviteError} id="invite-error" /> : null}{offlineWithoutCache ? <p className="cache-status">Invitations aren’t cached on this device and need a connection.</p> : <ResourceNotice resource={invitationsResource} label="invitations" retry={retryFor(resourceKeys.groupInvitations(userId, groupId), userId)} />}{invitationsResource.data !== undefined ? invitations.length ? <div className="list">{invitations.map((invitation) => { const pending = !invitation.revokedAt && !invitation.acceptedAt && !invitation.rejectedAt && Date.parse(invitation.expiresAt) > Date.now(); return <div className="row" key={invitation.id}><span>{invitation.email}<small>{invitation.acceptedAt ? 'Accepted' : invitation.revokedAt ? 'Revoked' : invitation.rejectedAt ? 'Rejected' : pending ? `Pending · expires ${new Date(invitation.expiresAt).toLocaleDateString()}` : 'Expired'}</small></span>{pending ? <Button type="button" variant="secondary" disabled={!effectiveOnline || busy === invitation.id} onClick={() => void revoke(invitation)}>Revoke</Button> : null}</div>; })}</div> : <Empty>No invitations yet.</Empty> : null}{error ? <ErrorBox error={error} id="invitation-management-error" /> : null}{invitationsResource.data !== undefined && !effectiveOnline ? <p className="cache-status">Showing cached invitations; they may be out of date. Invitation changes require a connection.</p> : null}</section>;
}

function AddFriendForm({ groupId, userId, online }: { groupId: string; userId: string; online: boolean }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!online || busy) return;
    if (!name.trim()) { setError(new Error('Enter a friend name.')); return; }
    setBusy(true); setError(undefined);
    try { await api(`/groups/${groupId}/people`, { method: 'POST', body: JSON.stringify({ name: name.trim(), email: email.trim() || undefined }) }); setName(''); setEmail(''); setOpen(false); await invalidateForMutation.groupChanged(groupId, userId, captureSessionGeneration()); }
    catch (cause) { setError(cause); }
    finally { setBusy(false); }
  };
  return <section aria-labelledby="add-friend-heading"><div className="section-title"><h2 id="add-friend-heading">Add friend</h2><Button type="button" variant="secondary" disabled={!online} onClick={() => { setError(undefined); setOpen((current) => !current); }}>{open ? 'Cancel' : 'Add friend'}</Button></div>{open ? <form onSubmit={submit} aria-describedby={error ? 'add-person-error' : undefined}><Field label="Friend name"><input required value={name} onChange={(event) => { setError(undefined); setName(event.target.value); }} /></Field><Field label="Email (optional)"><input className="email" type="email" value={email} onChange={(event) => { setError(undefined); setEmail(event.target.value); }} /></Field>{error ? <ErrorBox error={error} id="add-person-error" /> : null}<Button type="submit" disabled={!online || busy}>{busy ? 'Adding…' : 'Add friend'}</Button></form> : <p className="muted">Add a ledger-only friend or link the email they use to sign in.</p>}</section>;
}

function ExpenseFilterDisclosure({ filterKey, filterCount, offline, children }: { filterKey: string; filterCount: number; offline: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(filterCount > 0);
  useEffect(() => {
    if (filterCount > 0) setOpen(true);
  }, [filterCount, filterKey]);
  return <details className="expense-filters-disclosure" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}><summary id="expense-filter-heading">Find expenses{filterCount ? ` · ${filterCount} active filter${filterCount === 1 ? '' : 's'}` : ''}</summary>{offline ? <p className="cache-status">Server filtering is unavailable offline. Clear the URL filters or reconnect to search.</p> : null}{children}</details>;
}

function GroupManagementPage() {
  const online = useOnlineStatus();
  const { id = '' } = useParams();
  const nav = useNavigate();
  const me = useResource(resourceKeys.identity(), '', (signal) => getMe({ signal }), RESOURCE_FRESHNESS.expenses, hydrateIdentity);
  const userId = me.data?.id || 'pending';
  const groupResource = useResource<{ group: Group; members: GroupMember[] }>(resourceKeys.group(userId, id), me.data?.id, (signal) => getGroup(id, signal), RESOURCE_FRESHNESS.group, me.data?.id ? () => hydrateGroup(me.data!.id, id) : undefined);
  const group = groupResource.data?.group;
  const members = groupResource.data?.members || [];
  const offline = Boolean(me.offline || groupResource.offline) || !online;
  useEffect(() => {
    if (!group || typeof window === 'undefined' || !window.location.hash) return;
    const target = document.getElementById(window.location.hash.slice(1));
    if (target instanceof HTMLElement) window.requestAnimationFrame(() => target.focus({ preventScroll: true }));
  }, [group, id]);
  if ((me.error || groupResource.error) && !group) return <Layout><ErrorBox error={me.error || groupResource.error} onRetry={me.error ? retryFor(resourceKeys.identity(), '') : retryFor(resourceKeys.group(userId, id), me.data?.id)} id="group-manage-error" retryLabel={me.error ? 'Retry identity check' : 'Retry'} /><Link className="back" to={`/groups/${id}`}>← Back to group</Link></Layout>;
  if (!group) return <Layout><Loading /></Layout>;
  const owner = group.role === 'owner';
  return <Layout><Link className="back" to={`/groups/${id}`}>← <span className="back__label">Back to {group.memberCount === 2 && group.counterpartName ? group.counterpartName : group.name}</span></Link><div className="page-title"><div><p className="eyebrow">Group management</p><h1>Manage group</h1></div></div>{offline ? <ConnectionBanner detail="cached group data is available. Member changes, invitations, exports, and settings require a connection." /> : null}<ResourceNotice resource={groupResource} label="group" retry={retryFor(resourceKeys.group(userId, id), me.data?.id)} /><section id="people" tabIndex={-1} aria-labelledby="people-heading"><div className="section-title"><h2 id="people-heading">People</h2><span className="muted">{owner ? 'Owner controls' : 'Members can view this list'}</span></div><MemberDirectory groupId={id} userId={userId} members={members} online={!offline} owner={owner} /></section>{owner ? <AddFriendForm groupId={id} userId={userId} online={!offline} /> : null}{owner ? <OwnerMemberControls groupId={id} userId={userId} online={!offline} /> : null}<GroupExports groupId={id} online={!offline} /><div id="settings" tabIndex={-1}><GroupSettings group={group} groupId={id} userId={userId} online={!offline} role={owner ? 'owner' : 'member'} onDeleted={() => nav('/')} onLeft={() => nav('/')} /></div></Layout>;
}

function GroupOverview() {
  const online = useOnlineStatus();
  const { id = '' } = useParams();
  const me = useResource(resourceKeys.identity(), '', (signal) => getMe({ signal }), RESOURCE_FRESHNESS.expenses, hydrateIdentity);
  const userId = me.data?.id || 'pending';
  const groupResource = useResource<{ group: Group; members: GroupMember[] }>(resourceKeys.group(userId, id), me.data?.id, (signal) => getGroup(id, signal), RESOURCE_FRESHNESS.group, me.data?.id ? () => hydrateGroup(me.data!.id, id) : undefined);
  const transactionsResource = useResource<{ transactions: Transaction[]; nextCursor?: string }>(resourceKeys.transactions(userId, id, 'overview'), me.data?.id, (signal) => getTransactionPage(id, { limit: 5 }, signal), RESOURCE_FRESHNESS.transactions, me.data?.id ? () => hydrateTransactionOverview(me.data!.id, id) : undefined);
  const scheduledResource = useResource<{ scheduledExpenses: ScheduledExpense[]; nextCursor?: string }>(resourceKeys.scheduledExpenses(userId, id), me.data?.id, (signal) => getScheduledExpenses(id, signal), RESOURCE_FRESHNESS.scheduledExpenses);
  const balancesResource = useResource<{ balances: Record<string, Balances> }>(resourceKeys.balances(userId, id), me.data?.id, (signal) => getBalances(id, signal), RESOURCE_FRESHNESS.balances, me.data?.id ? () => hydrateBalances(me.data!.id, id) : undefined);
  const group = groupResource.data?.group;
  const members = groupResource.data?.members || [];
  const balances = balancesResource.data?.balances || {};
  const currentPersonId = me.data?.personId || '';
  const currentUserId = me.data?.id || '';
  const outbox = useSyncExternalStore(subscribeOutbox, getOutboxSnapshot, () => []);
  const pending = outbox.filter((item) => item.userId === currentUserId && item.groupId === id);
  const transactions = transactionsResource.data?.transactions || [];
  const offline = Boolean(groupResource.offline || transactionsResource.offline || balancesResource.offline || scheduledResource.offline || me.offline) || !online;
  const refreshing = [groupResource, transactionsResource, balancesResource, scheduledResource].some((resource) => resource.revalidating);
  if ((groupResource.error || me.error) && !group) return <Layout><ErrorBox error={groupResource.error || me.error} onRetry={me.error ? retryFor(resourceKeys.identity(), '') : retryFor(resourceKeys.group(userId, id), me.data?.id)} id="group-error" /><Link className="back" to="/">← Groups</Link></Layout>;
  if (!group) return <Layout><Loading /></Layout>;
  const displayName = group.memberCount === 2 && group.counterpartName ? group.counterpartName : group.name;
  const balanceDisplays = personalBalances(balances, currentPersonId, group.currency);
  return <Layout><Link to="/" className="back">← Groups</Link><div className="page-title"><div><p className="eyebrow">{group.memberCount === 2 ? 'Friend group' : `${group.currency} group`}</p><h1>{displayName}</h1></div><div className="expense-heading__actions"><Link className="button" to={`/groups/${id}/expense/new`}>+ Add expense</Link><Link className="button button--secondary" to={`/groups/${id}/settle`}>Settle up</Link></div></div>{offline ? <ConnectionBanner detail="showing cached group data. New expenses can be captured; history, schedules, and management need a connection." /> : null}{me.error ? <CachedIdentityNotice resource={me} id="group-identity-error" /> : null}{groupResource.error ? <ResourceNotice resource={groupResource} label="group" retry={retryFor(resourceKeys.group(userId, id), me.data?.id)} /> : null}{refreshing ? <p className="cache-status" role="status">Refreshing group data…</p> : null}
     <section aria-labelledby="balances-heading" className="compact-balances"><h2 id="balances-heading">Your balances</h2>{balancesResource.data !== undefined ? <ResourceNotice resource={balancesResource} label="balances" retry={retryFor(resourceKeys.balances(userId, id), me.data?.id)} /> : balancesResource.error ? <ErrorBox error={balancesResource.error} onRetry={online ? retryFor(resourceKeys.balances(userId, id), me.data?.id) : undefined} id="balances-error" /> : null}<div className="balance-cards">{balancesResource.data === undefined ? <p className="cache-status">Balances are unavailable until this group’s balance data is loaded.</p> : balanceDisplays.map((display, index) => <div className={`balance-card balance-card--${display.kind}`} key={`${display.currency}-${index}`}><span className="balance-card__currency">{display.currency}</span><strong>{display.label}</strong>{display.kind === 'balance' ? <Money amountMinor={display.amountMinor} currency={display.currency} tone={display.label === 'You are owed' ? 'positive' : 'debt'} /> : null}</div>)}</div><details className="balance-breakdown"><summary>View full group breakdown</summary>{balancesResource.data === undefined ? <p className="cache-status">Balance details are unavailable.</p> : Object.keys(balances).length ? Object.entries(balances).map(([currencyKey, balance]) => <div key={currencyKey}><h3>{currencyKey}</h3>{balance.simplified.length ? <div className="list">{balance.simplified.map((item) => <div className="row" key={`${currencyKey}-${item.fromPersonId}-${item.toPersonId}`}><span>{item.fromPersonId === currentPersonId ? 'You' : item.fromName} owes {item.toPersonId === currentPersonId ? 'You' : item.toName}<Status tone="debt">Debt</Status></span><Money amountMinor={item.amountMinor} currency={currencyKey} tone="debt" /></div>)}</div> : <Empty>Everyone is settled up.</Empty>}</div>) : <Empty>Everyone is settled up.</Empty>}</details></section>
     <section aria-labelledby="recent-transactions-heading"><div className="section-title"><h2 id="recent-transactions-heading">Recent transactions</h2><Link className="inline-action" to={`/groups/${id}/transactions`}>View all transactions</Link></div>{transactionsResource.data !== undefined ? <ResourceNotice resource={transactionsResource} label="transactions" retry={retryFor(resourceKeys.transactions(userId, id, 'overview'), me.data?.id)} /> : transactionsResource.error ? <ErrorBox error={transactionsResource.error} onRetry={online ? retryFor(resourceKeys.transactions(userId, id, 'overview'), me.data?.id) : undefined} id="overview-transactions-error" /> : null}{pending.length ? <section className="pending-transactions" aria-labelledby="pending-transactions-heading"><h3 id="pending-transactions-heading">Waiting to sync · {pending.length}</h3><div className="list">{pending.map((item) => <PendingExpenseRow key={item.clientOperationId} item={item} />)}</div></section> : null}{transactionsResource.data === undefined ? <p className="cache-status">Recent transactions are unavailable until this group’s transaction data is loaded.</p> : !transactions.length && !pending.length ? <Empty>No transactions yet.</Empty> : transactions.length ? <div className="list transaction-list">{transactions.map((transaction) => <TransactionRow key={transactionKey(transaction)} groupId={id} transaction={transaction} />)}</div> : null}</section>
    <CompactScheduleList groupId={id} schedules={scheduledResource.data?.scheduledExpenses || []} resource={scheduledResource} online={!offline} userId={currentUserId} />
    <section aria-labelledby="people-summary-heading"><div className="section-title"><h2 id="people-summary-heading">People</h2><span className="muted">{members.length} {members.length === 1 ? 'person' : 'people'}</span></div><p className="people-summary-compact">{members.slice(0, 4).map((member) => member.personId === currentPersonId ? 'You' : member.name).join(', ')}{members.length > 4 ? ` +${members.length - 4} more` : ''}</p><Link className="inline-action" to={`/groups/${id}/manage#people`}>Manage people</Link></section>
    <nav className="actions group-tools" aria-label="Group tools"><Link className="button button--secondary" to={`/groups/${id}/activity`}>Group activity</Link><Link className="button button--secondary" to={`/groups/${id}/manage#settings`}>Group settings</Link></nav>
  </Layout>;
}

function TransactionRow({ groupId, transaction }: { groupId: string; transaction: Transaction }) {
  const path = transaction.kind === 'expense' ? expenseDetailPath(groupId, transaction.id) : settlementDetailPath(groupId, transaction.id);
  const content = <><span><strong>{transactionTypeLabel(transaction)} · {transactionTitle(transaction)}</strong><small>{transactionDate(transaction)}{transactionPeople(transaction) ? ` · ${transactionPeople(transaction)}` : ''}</small></span><Money amountMinor={transaction.amountMinor} currency={transaction.currency} tone={transaction.kind === 'settlement' ? 'positive' : undefined} /></>;
  return path ? <Link className="row transaction-row" to={path}>{content}</Link> : <div className="row transaction-row">{content}</div>;
}

function TransactionFilterDisclosure({ filterKey, filterCount, offline, children }: { filterKey: string; filterCount: number; offline: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(filterCount > 0);
  useEffect(() => { if (filterCount > 0) setOpen(true); }, [filterCount, filterKey]);
  return <details className="transaction-filters-disclosure" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}><summary>Search and filters{filterCount ? ` · ${filterCount} active filter${filterCount === 1 ? '' : 's'}` : ''}</summary>{offline ? <p className="cache-status">Server filters are unavailable offline. Reconnect to search history.</p> : null}{children}</details>;
}

function TransactionHistoryPage() {
  const online = useOnlineStatus();
  const { id = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(() => readTransactionFilters(searchParams), [searchParams]);
  const filterSignature = transactionFilterKey(filters);
  const me = useResource(resourceKeys.identity(), '', (signal) => getMe({ signal }), RESOURCE_FRESHNESS.expenses, hydrateIdentity);
  const userId = me.data?.id || 'pending';
  const groupResource = useResource<{ group: Group; members: GroupMember[] }>(resourceKeys.group(userId, id), me.data?.id, (signal) => getGroup(id, signal), RESOURCE_FRESHNESS.group, me.data?.id ? () => hydrateGroup(me.data!.id, id) : undefined);
  const transactionsResource = useResource<{ transactions: Transaction[]; nextCursor?: string }>(resourceKeys.transactions(userId, id, filterSignature), me.data?.id, (signal) => getTransactions(id, signal, filters), RESOURCE_FRESHNESS.transactions, me.data?.id && !hasTransactionFilters(filters) ? () => hydrateTransactions(me.data!.id, id) : undefined);
  const categoriesResource = useResource<{ categories: string[] }>(resourceKeys.categories(userId), me.data?.id, (signal) => getCategories(signal), RESOURCE_FRESHNESS.expenses, me.data?.id ? () => hydrateCategories(me.data!.id) : undefined);
  const group = groupResource.data?.group;
  const members = groupResource.data?.members || [];
  const currentUserId = me.data?.id || '';
  const outbox = useSyncExternalStore(subscribeOutbox, getOutboxSnapshot, () => []);
  const pending = outbox.filter((item) => item.userId === currentUserId && item.groupId === id);
  const [rows, setRows] = useState<Transaction[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [pageError, setPageError] = useState<unknown>();
  const [draftFilters, setDraftFilters] = useState<TransactionFilters>(filters);
  const scopeKey = `${id}:${filterSignature}`;
  const scopeKeyRef = useRef(scopeKey); scopeKeyRef.current = scopeKey;
  const pageScope = useRef(createPageRequestScope());
  const cursorRef = useRef<string>();
  const offline = Boolean(groupResource.offline || transactionsResource.offline || me.offline) || !online;
  useEffect(() => { pageScope.current.reset(scopeKey); cursorRef.current = undefined; setRows([]); setCursor(undefined); setLoadingMore(false); setPageError(undefined); }, [scopeKey]);
  useEffect(() => { const page = transactionsResource.data; if (!page || scopeKeyRef.current !== scopeKey) return; pageScope.current.reset(scopeKey); cursorRef.current = page.nextCursor; setRows(page.transactions); setCursor(page.nextCursor); }, [scopeKey, transactionsResource.data]);
  useEffect(() => () => pageScope.current.dispose(), []);
  useEffect(() => { setDraftFilters(filters); }, [filterSignature]);
  useEffect(() => {
    if (searchParams.get('category') && filters.kind !== 'expense') setSearchParams(writeTransactionFilters(searchParams, filters), { replace: true });
  }, [filters, searchParams, setSearchParams]);
  if ((groupResource.error || me.error) && !group) return <Layout><ErrorBox error={groupResource.error || me.error} onRetry={me.error ? retryFor(resourceKeys.identity(), '') : retryFor(resourceKeys.group(userId, id), me.data?.id)} id="transactions-group-error" /><Link className="back" to={`/groups/${id}`}>← Back to group</Link></Layout>;
  if (!group) return <Layout><Loading /></Layout>;
  const filterCount = transactionFilterCount(filters);
  const categoryChoices = [...new Set([...(categoriesResource.data?.categories || []), ...rows.filter((row): row is Extract<Transaction, { kind: 'expense' }> => row.kind === 'expense').map((row) => row.category || '')].filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const applyFilters = (event: FormEvent) => { event.preventDefault(); setSearchParams(writeTransactionFilters(searchParams, draftFilters)); };
  const clearFilters = () => setSearchParams(writeTransactionFilters(searchParams, {}));
  const loadMore = async () => {
    if (!cursor || loadingMore || offline) return;
    const request = pageScope.current.begin(scopeKey, cursor); setLoadingMore(true); setPageError(undefined);
    try {
      const page = await getTransactionPage(id, { ...filters, limit: 25, cursor: request.cursor }, request.signal);
      if (!pageScope.current.isCurrent(request) || scopeKeyRef.current !== request.key || cursorRef.current !== request.cursor) return;
      cursorRef.current = page.nextCursor; setRows((current) => appendUniquePage(current, page.transactions, transactionKey)); setCursor(page.nextCursor);
    } catch (cause) { if (pageScope.current.isCurrent(request) && !(cause instanceof DOMException && cause.name === 'AbortError')) setPageError(cause); }
    finally { if (pageScope.current.isCurrent(request)) setLoadingMore(false); }
  };
  return <Layout><Link className="back" to={`/groups/${id}`}>← <span className="back__label">Back to {group.memberCount === 2 && group.counterpartName ? group.counterpartName : group.name}</span></Link><div className="page-title"><div><p className="eyebrow">Transaction history</p><h1>All transactions</h1></div></div>{offline && transactionsResource.offline ? <p className="offline-banner" role="status">Offline: showing the cached first page only. History is incomplete; filters and loading more need a connection.</p> : offline ? <ConnectionBanner detail="transaction history and server filters need a connection." /> : null}{me.error ? <CachedIdentityNotice resource={me} id="transactions-identity-error" /> : null}<TransactionFilterDisclosure filterKey={filterSignature} filterCount={filterCount} offline={offline}><form className="transaction-filters" onSubmit={applyFilters}><Field label="Search"><input type="search" value={draftFilters.q || ''} disabled={offline} onChange={(event) => setDraftFilters((current) => ({ ...current, q: event.target.value || undefined }))} /></Field><Field label="Kind"><select value={draftFilters.kind || ''} disabled={offline} onChange={(event) => setDraftFilters((current) => ({ ...current, kind: (event.target.value || undefined) as TransactionFilters['kind'], category: event.target.value === 'expense' ? current.category : undefined }))}><option value="">All transaction types</option><option value="expense">Expenses</option><option value="settlement">Settlements</option></select></Field><Field label="Person"><select value={draftFilters.person || ''} disabled={offline} onChange={(event) => setDraftFilters((current) => ({ ...current, person: event.target.value || undefined }))}><option value="">All people</option>{members.map((member) => <option key={member.personId} value={member.personId}>{member.name}</option>)}</select></Field>{draftFilters.kind === 'expense' ? <Field label="Category"><select value={draftFilters.category || ''} disabled={offline} onChange={(event) => setDraftFilters((current) => ({ ...current, category: event.target.value || undefined }))}><option value="">All categories</option>{categoryChoices.map((category) => <option key={category} value={category}>{category}</option>)}</select></Field> : null}<Field label="From date"><input type="date" value={draftFilters.from || ''} disabled={offline} onChange={(event) => setDraftFilters((current) => ({ ...current, from: event.target.value || undefined }))} /></Field><Field label="To date"><input type="date" value={draftFilters.to || ''} disabled={offline} onChange={(event) => setDraftFilters((current) => ({ ...current, to: event.target.value || undefined }))} /></Field><Field label="Currency"><select value={draftFilters.currency || ''} disabled={offline} onChange={(event) => setDraftFilters((current) => ({ ...current, currency: (event.target.value || undefined) as Currency }))}><option value="">All currencies</option>{currencyOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></Field><div className="actions"><Button type="submit" disabled={offline}>Apply filters</Button><Button type="button" variant="secondary" disabled={offline || filterCount === 0} onClick={clearFilters}>Clear</Button></div></form></TransactionFilterDisclosure>{!me.error || transactionsResource.data !== undefined ? <ResourceNotice resource={transactionsResource} label="transactions" retry={retryFor(resourceKeys.transactions(userId, id, filterSignature), me.data?.id)} /> : null}{pending.length ? <section className="pending-transactions" aria-labelledby="history-pending-heading"><h2 id="history-pending-heading">Waiting to sync · {pending.length}</h2><div className="list">{pending.map((item) => <PendingExpenseRow key={item.clientOperationId} item={item} />)}</div></section> : null}{transactionsResource.data !== undefined && !rows.length && !pending.length ? <Empty>No transactions match these filters.</Empty> : rows.length ? <section aria-labelledby="transaction-list-heading"><h2 id="transaction-list-heading" className="sr-only">Committed transactions</h2><div className="list transaction-list">{rows.map((transaction) => <TransactionRow key={transactionKey(transaction)} groupId={id} transaction={transaction} />)}</div></section> : null}{cursor ? <Button type="button" variant="secondary" disabled={offline || loadingMore} onClick={() => void loadMore()}>{loadingMore ? 'Loading…' : 'Load more transactions'}</Button> : null}{pageError && !offline ? <ErrorBox error={pageError} id="transaction-page-error" /> : null}</Layout>;
}

function GroupPage() {
  const online = useOnlineStatus();
  const { id = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(() => readExpenseFilters(searchParams), [searchParams]);
  const filterSignature = expenseFilterKey(filters);
  const me = useResource(resourceKeys.identity(), '', (signal) => getMe({ signal }), RESOURCE_FRESHNESS.expenses, hydrateIdentity);
  const userId = me.data?.id || 'pending';
  const groupResource = useResource<{ group: Group; members: GroupMember[] }>(resourceKeys.group(userId, id), me.data?.id, (signal) => getGroup(id, signal), RESOURCE_FRESHNESS.group, me.data?.id ? () => hydrateGroup(me.data!.id, id) : undefined);
  const expensesResource = useResource<{ expenses: Expense[]; nextCursor?: string }>(resourceKeys.expenses(userId, id, filterSignature), me.data?.id, (signal) => getExpenses(id, signal, filters), RESOURCE_FRESHNESS.expenses, me.data?.id && !hasExpenseFilters(filters) ? () => hydrateExpenses(me.data!.id, id) : undefined);
  const categoriesResource = useResource<{ categories: string[] }>(resourceKeys.categories(userId), me.data?.id, (signal) => getCategories(signal), RESOURCE_FRESHNESS.expenses, me.data?.id ? () => hydrateCategories(me.data!.id) : undefined);
  const scheduledResource = useResource<{ scheduledExpenses: ScheduledExpense[]; nextCursor?: string }>(resourceKeys.scheduledExpenses(userId, id), me.data?.id, (signal) => getScheduledExpenses(id, signal), RESOURCE_FRESHNESS.scheduledExpenses);
  const balancesResource = useResource<{ balances: Record<string, Balances> }>(resourceKeys.balances(userId, id), me.data?.id, (signal) => getBalances(id, signal), RESOURCE_FRESHNESS.balances, me.data?.id ? () => hydrateBalances(me.data!.id, id) : undefined);
  const settlementsResource = useResource<{ settlements: Settlement[]; nextCursor?: string }>(resourceKeys.settlements(userId, id), me.data?.id, (signal) => getSettlements(id, signal), RESOURCE_FRESHNESS.settlements, me.data?.id ? () => hydrateSettlements(me.data!.id, id) : undefined);
  const group = groupResource.data?.group;
  const members = groupResource.data?.members || [];
  const balances = balancesResource.data?.balances || {};
  const currentPersonId = me.data?.personId || '';
  const currentUserId = me.data?.id || '';
  const [expensePages, setExpensePages] = useState<Expense[]>([]);
  const [settlementPages, setSettlementPages] = useState<Settlement[]>([]);
  const [expenseCursor, setExpenseCursor] = useState<string>();
  const [settlementCursor, setSettlementCursor] = useState<string>();
  const [loadingMore, setLoadingMore] = useState<'expenses' | 'settlements'>();
  const [pageError, setPageError] = useState<unknown>();
  const [draftFilters, setDraftFilters] = useState<ExpenseFilters>(filters);
  const pageScopeKey = `${id}:${filterSignature}`;
  const pageScopeKeyRef = useRef(pageScopeKey); pageScopeKeyRef.current = pageScopeKey;
  const expensePageScope = useRef(createPageRequestScope());
  const settlementPageScope = useRef(createPageRequestScope());
  const expenseCursorRef = useRef<string>();
  const settlementCursorRef = useRef<string>();
  const expenses = expensePages;
  const settlements = settlementPages;
  const offline = Boolean(groupResource.offline || expensesResource.offline || balancesResource.offline || settlementsResource.offline || scheduledResource.offline || me.offline) || !online;
  const refreshing = [groupResource, expensesResource, balancesResource, settlementsResource, scheduledResource].some((resource) => resource.revalidating);
  const outbox = useSyncExternalStore(subscribeOutbox, getOutboxSnapshot, () => []);
  const pending = outbox.filter((item) => item.userId === currentUserId && item.groupId === id);
  useEffect(() => { expensePageScope.current.reset(pageScopeKey); settlementPageScope.current.reset(pageScopeKey); expenseCursorRef.current = undefined; settlementCursorRef.current = undefined; setExpensePages([]); setSettlementPages([]); setExpenseCursor(undefined); setSettlementCursor(undefined); setLoadingMore(undefined); setPageError(undefined); }, [pageScopeKey]);
  useEffect(() => { const page = expensesResource.data; if (!page || pageScopeKeyRef.current !== pageScopeKey) return; expensePageScope.current.reset(pageScopeKey); expenseCursorRef.current = page.nextCursor; setExpensePages(page.expenses); setExpenseCursor(page.nextCursor); }, [expensesResource.data, pageScopeKey]);
  useEffect(() => { const page = settlementsResource.data; if (!page || pageScopeKeyRef.current !== pageScopeKey) return; settlementPageScope.current.reset(pageScopeKey); settlementCursorRef.current = page.nextCursor; setSettlementPages(page.settlements); setSettlementCursor(page.nextCursor); }, [pageScopeKey, settlementsResource.data]);
  useEffect(() => () => { expensePageScope.current.dispose(); settlementPageScope.current.dispose(); }, []);
  useEffect(() => { setDraftFilters(filters); }, [filterSignature]);
  if ((groupResource.error || me.error) && !group) return <Layout><ErrorBox error={groupResource.error || me.error} onRetry={me.error ? retryFor(resourceKeys.identity(), '') : retryFor(resourceKeys.group(userId, id), me.data?.id)} id="group-error" /><Link className="back" to="/">← Groups</Link></Layout>;
  if (!group) return <Layout><Loading /></Layout>;
  const applyFilters = (event: FormEvent) => { event.preventDefault(); setSearchParams(writeExpenseFilters(searchParams, draftFilters)); };
  const clearFilters = () => setSearchParams(writeExpenseFilters(searchParams, {}));
  const loadMore = async (kind: 'expenses' | 'settlements') => {
    const cursor = kind === 'expenses' ? expenseCursor : settlementCursor; if (!cursor || loadingMore) return;
    const scope = kind === 'expenses' ? expensePageScope.current : settlementPageScope.current; const request = scope.begin(pageScopeKey, cursor); setLoadingMore(kind); setPageError(undefined);
    try {
      if (kind === 'expenses') { const page = await getExpensePage(id, { ...filters, cursor: request.cursor }, request.signal); if (!scope.isCurrent(request) || pageScopeKeyRef.current !== request.key || expenseCursorRef.current !== request.cursor) return; expenseCursorRef.current = page.nextCursor; setExpensePages((current) => appendUniquePage(current, page.expenses, (item) => item.id)); setExpenseCursor(page.nextCursor); }
      else { const page = await getSettlementPage(id, { cursor: request.cursor }, request.signal); if (!scope.isCurrent(request) || pageScopeKeyRef.current !== request.key || settlementCursorRef.current !== request.cursor) return; settlementCursorRef.current = page.nextCursor; setSettlementPages((current) => appendUniquePage(current, page.settlements, (item) => item.id)); setSettlementCursor(page.nextCursor); }
    } catch (cause) { if (scope.isCurrent(request) && !(cause instanceof DOMException && cause.name === 'AbortError')) setPageError(cause); }
    finally { if (scope.isCurrent(request)) setLoadingMore(undefined); }
  };
  const categoryChoices = [...new Set([...(categoriesResource.data?.categories || []), ...expenses.map((expense) => expense.category || '')].filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const memberLabel = (personId: string) => personId === currentPersonId ? 'You' : nameOf(members, personId);
  const filterCount = expenseFilterCount(filters);
  return <Layout><Link to="/" className="back">← Groups</Link><div className="page-title"><div><p className="eyebrow">{group.memberCount === 2 ? 'Friend group' : `${group.currency} group`}</p><h1>{group.memberCount === 2 && group.counterpartName ? group.counterpartName : group.name}</h1></div><div className="expense-heading__actions"><Link className="button" to={`/groups/${id}/expense/new`}>+ Add expense</Link><Link className="button button--secondary" to={`/groups/${id}/settle`}>Settle up</Link></div></div>{offline ? <ConnectionBanner detail="showing cached group data. New expenses can be captured; filters, settlements, schedules, and management need a connection." /> : null}{me.error ? <CachedIdentityNotice resource={me} id="group-identity-error" /> : null}{groupResource.error ? <ResourceNotice resource={groupResource} label="group" retry={retryFor(resourceKeys.group(userId, id), me.data?.id)} /> : null}{refreshing ? <p className="cache-status" role="status">Refreshing group data…</p> : null}
     <section aria-labelledby="recent-expenses-heading"><h2 id="recent-expenses-heading">Recent expenses</h2>{!me.error || expensesResource.data !== undefined ? <ResourceNotice resource={expensesResource} label="expenses" retry={retryFor(resourceKeys.expenses(userId, id, filterSignature), me.data?.id)} /> : null}{expensesResource.data !== undefined && !expenses.length && !pending.length ? <Empty>No expenses match the current filters.</Empty> : expenses.length || pending.length ? <div className="list">{pending.map((item) => <PendingExpenseRow key={item.clientOperationId} item={item} />)}{expenses.map((expense) => { const path = expenseDetailPath(expense.groupId, expense.id); const content = <><span>{expense.description}<small>{expense.date} · {expense.currency}</small></span><Money amountMinor={expense.amountMinor} currency={expense.currency} /></>; return path ? <Link className="row" to={path} key={expense.id}>{content}</Link> : <div className="row" key={expense.id}>{content}</div>; })}</div> : null}{expenseCursor ? <Button type="button" variant="secondary" disabled={loadingMore === 'expenses' || offline} onClick={() => void loadMore('expenses')}>{loadingMore === 'expenses' ? 'Loading…' : 'Load more expenses'}</Button> : null}</section>
     <section aria-labelledby="balances-heading"><h2 id="balances-heading">Balances</h2>{!me.error || balancesResource.data !== undefined ? <ResourceNotice resource={balancesResource} label="balances" retry={retryFor(resourceKeys.balances(userId, id), me.data?.id)} /> : null}{balancesResource.data !== undefined && !Object.keys(balances).length ? <Empty>Everyone is settled up.</Empty> : Object.entries(balances).map(([currencyKey, balance]) => <div key={currencyKey}><h3>{currencyKey}</h3>{balance.simplified.length ? <div className="list">{balance.simplified.map((item) => <div className="row" key={`${currencyKey}-${item.fromPersonId}-${item.toPersonId}`}><span>{item.fromPersonId === currentPersonId ? 'You' : item.fromName} owes {item.toPersonId === currentPersonId ? 'You' : item.toName}<Status tone="debt">Debt</Status></span><Money amountMinor={item.amountMinor} currency={currencyKey} tone="debt" /></div>)}</div> : <Empty>Everyone is settled up.</Empty>}</div>)}</section>
    <section className="expense-filters-disclosure" aria-labelledby="expense-filter-heading"><ExpenseFilterDisclosure filterKey={filterSignature} filterCount={filterCount} offline={offline}><form className="expense-filters" onSubmit={applyFilters}><Field label="Search description or notes"><input value={draftFilters.q || ''} disabled={offline} onChange={(event) => setDraftFilters((current) => ({ ...current, q: event.target.value }))} /></Field><Field label="Member"><select value={draftFilters.person || ''} disabled={offline} onChange={(event) => setDraftFilters((current) => ({ ...current, person: event.target.value || undefined }))}><option value="">All members</option>{members.map((member) => <option key={member.personId} value={member.personId}>{member.name}</option>)}</select></Field><Field label="Category"><select value={draftFilters.category || ''} disabled={offline} onChange={(event) => setDraftFilters((current) => ({ ...current, category: event.target.value || undefined }))}><option value="">All categories</option>{categoryChoices.map((category) => <option key={category} value={category}>{category}</option>)}</select></Field><Field label="From date"><input type="date" value={draftFilters.from || ''} disabled={offline} onChange={(event) => setDraftFilters((current) => ({ ...current, from: event.target.value || undefined }))} /></Field><Field label="To date"><input type="date" value={draftFilters.to || ''} disabled={offline} onChange={(event) => setDraftFilters((current) => ({ ...current, to: event.target.value || undefined }))} /></Field><Field label="Currency"><select value={draftFilters.currency || ''} disabled={offline} onChange={(event) => setDraftFilters((current) => ({ ...current, currency: event.target.value as Currency || undefined }))}><option value="">All currencies</option>{currencyOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></Field><div className="actions"><Button type="submit" disabled={offline}>Apply filters</Button><Button type="button" variant="secondary" onClick={clearFilters}>Clear</Button></div></form></ExpenseFilterDisclosure></section>
    <section aria-labelledby="recent-settlements-heading"><h2 id="recent-settlements-heading">Recent settlements</h2>{!me.error || settlementsResource.data !== undefined ? <ResourceNotice resource={settlementsResource} label="settlements" retry={retryFor(resourceKeys.settlements(userId, id), me.data?.id)} /> : null}{settlementsResource.data !== undefined && settlements.length ? <div className="list">{settlements.map((settlement) => { const path = settlementDetailPath(settlement.groupId, settlement.id); const content = <><span>{settlement.date}<small>{memberLabel(settlement.fromPersonId)} paid {memberLabel(settlement.toPersonId)}</small><Status tone="positive">Paid</Status></span><Money amountMinor={settlement.amountMinor} currency={settlement.currency} tone="positive" /></>; return path ? <Link className="row" to={path} key={settlement.id}>{content}</Link> : <div className="row" key={settlement.id}>{content}</div>; })}</div> : settlementsResource.data !== undefined ? <Empty>No settlements yet.</Empty> : null}{settlementCursor ? <Button type="button" variant="secondary" disabled={loadingMore === 'settlements' || offline} onClick={() => void loadMore('settlements')}>{loadingMore === 'settlements' ? 'Loading…' : 'Load more settlements'}</Button> : null}{pageError ? <ErrorBox error={pageError} id="group-page-error" /> : null}</section>
    <ScheduleList groupId={id} schedules={scheduledResource.data?.scheduledExpenses || []} resource={scheduledResource} online={!offline} userId={currentUserId} />
    <section aria-labelledby="people-summary-heading"><div className="section-title"><h2 id="people-summary-heading">People</h2><span className="muted">{members.length} {members.length === 1 ? 'person' : 'people'}</span></div><ul className="people-summary">{members.map((member) => <li key={member.personId}><strong>{member.personId === currentPersonId ? 'You' : member.name}</strong>{member.email ? <small className="email">{member.email}</small> : null}</li>)}</ul></section>
    <nav className="actions" aria-label="Group links"><Link to={`/activity?group=${encodeURIComponent(id)}`}>Activity</Link><Link className="button button--secondary" to={`/groups/${id}/manage`}>Manage group</Link></nav>
  </Layout>;
}

function PendingExpenseRow({ item }: { item: ExpenseOutboxItem }) {
  const connection = useConnectionState();
  const canMutate = useOnlineStatus();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const syncing = item.status === 'syncing' && (item.leaseExpiresAt === undefined || item.leaseExpiresAt > Date.now());
  const cannotDiscard = syncing || Boolean(item.deliveryUncertain);
  const explanation = syncing ? 'An in-flight server write cannot be safely cancelled.' : item.deliveryUncertain ? 'The server may have committed this expense; retry or wait for reconciliation.' : undefined;
  const retry = async () => { setError(undefined); setBusy(true); try { await retryOutboxItem(item.clientOperationId); } catch (cause) { setError(cause); } finally { setBusy(false); } };
  const discard = async () => { if (!confirm('Discard this pending expense?')) return; setError(undefined); setBusy(true); try { await discardOutboxItem(item.clientOperationId); } catch (cause) { setError(cause); } finally { setBusy(false); } };
  return <div className="row pending-row"><span>{item.display.description}<small>{item.display.date} · {item.display.currency} · <Status tone={item.status === 'failed' ? 'debt' : 'positive'}>{statusLabel(item.status, item.deliveryUncertain)}</Status></small>{item.lastError ? <small>{item.lastError.message}</small> : null}{explanation ? <small>{explanation}</small> : null}{error ? <ErrorBox error={error} id={`pending-error-${item.clientOperationId}`} /> : null}</span><div className="pending-row__actions"><Money amountMinor={item.display.amountMinor} currency={item.display.currency} />{connection.status !== 'offline' ? <Button disabled={!canMutate || syncing || busy} type="button" variant="secondary" onClick={() => void retry()}>Retry</Button> : null}<Button disabled={cannotDiscard || busy} title={explanation} type="button" variant="danger" onClick={() => void discard()}>Discard</Button></div></div>;
}

function ScheduleStatus({ status }: { status: ScheduledExpenseStatus }) {
  const tone = status === 'active' ? 'positive' : 'debt';
  return <Status tone={tone}>{status[0].toUpperCase() + status.slice(1)}</Status>;
}

type ScheduleListProps = { groupId: string; schedules: ScheduledExpense[]; resource: ResourceSnapshot<{ scheduledExpenses: ScheduledExpense[]; nextCursor?: string }>; online: boolean; userId: string };
function CompactScheduleList(props: ScheduleListProps) {
  const active = props.schedules.filter((schedule) => schedule.status === 'active');
  const next = active.map((schedule) => schedule.nextOccurrenceDate).filter((date): date is string => Boolean(date)).sort()[0];
  return <section className="scheduled-summary" aria-labelledby="scheduled-summary-heading"><div className="section-title"><h2 id="scheduled-summary-heading">Scheduled expenses</h2><span className="muted">{active.length} active{next ? ` · Next ${formatScheduleDate(next)}` : ''}</span></div><details><summary>View scheduled expenses and actions</summary><ScheduleList {...props} /></details></section>;
}

function ScheduleList({ groupId, schedules: initialSchedules, resource, online, userId }: ScheduleListProps) {
  const [schedules, setSchedules] = useState(initialSchedules);
  const [nextCursor, setNextCursor] = useState(resource.data?.nextCursor);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pageError, setPageError] = useState<unknown>();
  const scopeKey = `${userId}:${groupId}`;
  const scopeKeyRef = useRef(scopeKey);
  scopeKeyRef.current = scopeKey;
  const pageScope = useRef(createPageRequestScope());
  const cursorRef = useRef<string>();
  useEffect(() => {
    pageScope.current.reset(scopeKey);
    cursorRef.current = resource.data?.nextCursor;
    setSchedules(initialSchedules); setNextCursor(resource.data?.nextCursor);
    setLoadingMore(false); setPageError(undefined);
  }, [groupId, resource.data, scopeKey, userId]);
  useEffect(() => () => pageScope.current.dispose(), []);
  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    const request = pageScope.current.begin(scopeKey, nextCursor);
    setLoadingMore(true); setPageError(undefined);
    try {
      const page = await getScheduledExpensePage(groupId, { cursor: request.cursor }, request.signal);
      if (!pageScope.current.isCurrent(request) || scopeKeyRef.current !== request.key || cursorRef.current !== request.cursor) return;
      cursorRef.current = page.nextCursor;
      setSchedules((current) => appendUniquePage(current, page.scheduledExpenses, (item) => item.id));
      setNextCursor(page.nextCursor);
    } catch (cause) {
      if (pageScope.current.isCurrent(request) && !(cause instanceof DOMException && cause.name === 'AbortError')) setPageError(cause);
    }
    finally { if (pageScope.current.isCurrent(request)) setLoadingMore(false); }
  };
  return <><ScheduleListContent groupId={groupId} schedules={schedules} resource={resource} online={online} userId={userId} />{nextCursor ? <Button type="button" variant="secondary" disabled={!online || loadingMore} onClick={() => void loadMore()}>{loadingMore ? 'Loading…' : 'Load more scheduled expenses'}</Button> : null}{pageError && online ? <ErrorBox error={pageError} id="scheduled-expense-page-error" /> : pageError ? <p className="cache-status">Scheduled expenses could not be loaded while offline.</p> : null}</>;
}

function ScheduleListContent({ groupId, schedules, resource, online, userId }: ScheduleListProps) {
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState<unknown>();
  const updateStatus = async (schedule: ScheduledExpense, action: 'pause' | 'resume' | 'cancel') => {
    if (action === 'cancel' && !confirm(`Cancel “${schedule.description}”? Future occurrences will not be generated.`)) return;
    setBusyId(schedule.id); setError(undefined);
     try { const generation = captureSessionGeneration(); await changeScheduledExpenseStatus(schedule.id, action, schedule.version); await invalidateForMutation.scheduledExpenseChanged(groupId, userId, schedule.id, generation); }
    catch (cause) { setError(cause); }
    finally { setBusyId(undefined); }
  };
  const connection = useConnectionState();
  if (resource.data === undefined && connection.status === 'offline') return <section aria-labelledby="scheduled-expenses-heading"><div className="section-title"><h2 id="scheduled-expenses-heading">Scheduled expenses</h2><span className="muted">Online-only</span></div><p className="cache-status">Scheduled expenses need a connection and are not cached on this device.</p></section>;
  return <section aria-labelledby="scheduled-expenses-heading"><div className="section-title"><h2 id="scheduled-expenses-heading">Scheduled expenses</h2><span className="muted">Online-only</span></div>{resource.data === undefined ? <ResourceNotice resource={resource} label="scheduled expenses" retry={retryFor(resourceKeys.scheduledExpenses(userId, groupId), userId)} /> : schedules.length ? <div className="list">{schedules.map((schedule) => <div className="row schedule-row" key={schedule.id}><span><strong>{schedule.description}</strong><small>{scheduleSummary(schedule.frequency, schedule.interval, schedule.weekdays)} · {schedule.timezone}</small><small>{schedule.nextOccurrenceDate ? `Next occurrence ${formatScheduleDate(schedule.nextOccurrenceDate)}` : 'No future occurrences'}</small><small><ScheduleStatus status={schedule.status} />{schedule.blockedReason ? ` ${schedule.blockedReason}` : null}</small></span><div className="schedule-row__actions"><Money amountMinor={schedule.amountMinor} currency={schedule.currency} /><Link className="button button--secondary" to={`/groups/${groupId}/scheduled-expense/${schedule.id}`}>Edit</Link>{schedule.status === 'active' ? <Button type="button" variant="secondary" disabled={!online || busyId === schedule.id} onClick={() => void updateStatus(schedule, 'pause')}>Pause</Button> : schedule.status === 'paused' || schedule.status === 'blocked' ? <Button type="button" variant="secondary" disabled={!online || busyId === schedule.id} onClick={() => void updateStatus(schedule, 'resume')}>Resume</Button> : null}{schedule.status !== 'cancelled' ? <Button type="button" variant="danger" disabled={!online || busyId === schedule.id} onClick={() => void updateStatus(schedule, 'cancel')}>Cancel</Button> : null}</div></div>)}</div> : <Empty>No recurring expenses yet.</Empty>}{error ? <ErrorBox error={error} id="scheduled-expense-mutation-error" /> : null}{!online ? <p className="cache-status">Schedule management requires a connection. Existing schedules are not stored for offline use.</p> : null}</section>;
}

type PayerRow = { personId: string; amount: string };
type ExpenseErrorTarget = 'description' | 'amount' | 'participants' | 'payers' | 'allocation' | 'form';
type ExpenseFormError = { error: unknown; target: ExpenseErrorTarget };

function OneTimeOnlyDetails({ category, notes, customCategories = [], showNotes = true, suggested = false, onCategoryChange, onNotesChange }: { category: string; notes: string; customCategories?: string[]; showNotes?: boolean; suggested?: boolean; onCategoryChange: (value: string) => void; onNotesChange: (value: string) => void }) {
  const options = categoryOptions(customCategories);
  const custom = Boolean(category && !options.includes(category));
  const other = custom || category === 'Other';
  return <fieldset className="one-time-only-details" aria-describedby="one-time-only-details-help"><legend>Expense details</legend><p id="one-time-only-details-help" className="muted">{showNotes ? 'Categories are saved with expenses. Notes are saved for one-time expenses only. Choose a category to make future entries faster. Categories are private to your account.' : 'Categories are saved with scheduled expenses. Notes are available for one-time expenses only. Categories are private to your account.'}</p>{suggested ? <p className="muted" role="status">Suggested from past expenses.</p> : null}<Field label="Category" className="field--compact"><select value={custom ? 'Other' : category} onChange={(event) => onCategoryChange(event.target.value)}><option value="">Choose a category</option>{options.map((option) => <option key={option} value={option}>{option}</option>)}</select></Field>{other ? <Field label="Custom category" className="field--compact"><input className="category" required value={custom ? category : ''} onChange={(event) => onCategoryChange(event.target.value)} placeholder="Enter a category" /></Field> : null}{showNotes ? <Field label="Notes (optional)" className="field--compact"><textarea className="notes" rows={3} value={notes} onChange={(event) => onNotesChange(event.target.value)} /></Field> : null}</fieldset>;
}

function ExpenseForm() {
  const online = useOnlineStatus();
  const { id: routeGroupId = '', expenseId, scheduledExpenseId } = useParams();
  const [searchParams] = useSearchParams();
  const [targetGroupId, setTargetGroupId] = useState(() => routeGroupId || searchParams.get('group') || '');
  const id = targetGroupId;
  const legacyRecurring = !expenseId && !scheduledExpenseId && searchParams.get('recurrence') === '1';
  const [recurrenceEnabled, setRecurrenceEnabled] = useState(legacyRecurring);
  // Existing schedules are always recurring. New expenses start as one-time
  // entries and can opt into the same schedule API from this form.
  const scheduleMode = Boolean(scheduledExpenseId) || recurrenceEnabled;
  const nav = useNavigate();
  const meResource = useResource(resourceKeys.identity(), '', (signal) => getMe({ signal }), RESOURCE_FRESHNESS.expenses, hydrateIdentity);
  const formUserId = meResource.data?.id || 'pending';
  const groupsResource = useResource<{ groups: Group[] }>(resourceKeys.groups(formUserId), meResource.data?.id, (signal) => getGroups(signal), RESOURCE_FRESHNESS.groups, meResource.data?.id ? () => hydrateGroups(meResource.data!.id) : undefined);
  const categoriesResource = useResource<{ categories: string[] }>(resourceKeys.categories(formUserId), meResource.data?.id, (signal) => getCategories(signal), RESOURCE_FRESHNESS.expenses, meResource.data?.id ? () => hydrateCategories(meResource.data!.id) : undefined);
  const groupResource = useResource<{ group: Group; members: GroupMember[] }>(resourceKeys.group(formUserId, id || 'none'), meResource.data?.id, (signal) => id ? getGroup(id, signal) : Promise.resolve({ group: undefined as unknown as Group, members: [] }), RESOURCE_FRESHNESS.group, meResource.data?.id && id ? () => hydrateGroup(meResource.data!.id, id) : undefined);
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
  const [customTimezone, setCustomTimezone] = useState('');
  const [usingCustomTimezone, setUsingCustomTimezone] = useState(false);
  const [category, setCategory] = useState('');
  const [categoryTouched, setCategoryTouched] = useState(false);
  const [categorySuggestion, setCategorySuggestion] = useState<string>();
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
  const routeKey = `${formUserId}:${id}:${scheduledExpenseId ? `schedule:${scheduledExpenseId}` : `expense:${expenseId || 'new'}`}`;
  const timezoneLabelDate = useMemo(() => new Date(), []);
  const availableTimezoneOptions = useMemo(() => scheduleMode ? timezoneOptions(usingCustomTimezone ? [] : [timezone]) : [], [scheduleMode, timezone, usingCustomTimezone]);
  const timezoneSelectOptions = useMemo(() => availableTimezoneOptions.map((zone) => ({ zone, label: timezoneLabel(zone, timezoneLabelDate) })), [availableTimezoneOptions, timezoneLabelDate]);
  const timezoneSelectValue = timezoneSelectValueForState(timezone, availableTimezoneOptions, usingCustomTimezone);
  const selectedTimezone = timezoneValueFromSelection(timezoneSelectValue, customTimezone);
  const initializedRoute = useRef<string | undefined>(undefined);
  const initializedVersion = useRef<number | undefined>(undefined);
  const categoryTouchedRef = useRef(false);
  const suggestionRequest = useRef<AbortController>();
  const markDirty = () => { setDirty(true); setFormError(undefined); };

  useEffect(() => { if (routeGroupId) setTargetGroupId(routeGroupId); }, [routeGroupId]);
  useEffect(() => {
    if (!routeGroupId && !expenseId && !scheduledExpenseId && !targetGroupId) {
      const requested = searchParams.get('group');
      const first = groupsResource.data?.groups.find((group) => group.id === requested) || groupsResource.data?.groups[0];
      if (first) setTargetGroupId(first.id);
    }
  }, [expenseId, groupsResource.data, routeGroupId, scheduledExpenseId, searchParams, targetGroupId]);

  useEffect(() => {
    if (initializedRoute.current === routeKey) return;
    initializedRoute.current = undefined;
    initializedVersion.current = undefined;
    suggestionRequest.current?.abort();
    categoryTouchedRef.current = false;
    setCategoryTouched(false);
    setCategorySuggestion(undefined);
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
      // The global new-expense route intentionally uses a `group:none` resource
      // sentinel while the selector is loading. It is not usable form data.
      if (!groupResult?.group || !me || (expenseId && !expense) || (scheduledExpenseId && !schedule)) return;

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
         setDescription(record.description); setAmount(moneyInput(record.amountMinor)); setDate('date' in record ? record.date : record.startDate); setCategory('category' in record ? record.category || '' : ''); categoryTouchedRef.current = true; setCategoryTouched(true); setCategorySuggestion(undefined); setNotes('notes' in record ? record.notes || '' : ''); setMethod(nextMethod); setSelected(record.splits.map((split) => split.personId)); setAllocationValues(allocationStateFromSplits(record.splits, nextMethod)); setExistingSplitMetadata(allocationMetadataByPerson(record.splits)); setVersion(record.version); setPayerRows(record.payers.map((payer) => ({ personId: payer.personId, amount: moneyInput(payer.amountMinor) })));
        setRecurrenceEnabled(Boolean(schedule));
       if ('startDate' in record) { setEndDate(record.endDate || ''); setFrequency(record.frequency); setInterval(String(record.interval)); setWeekdays(record.weekdays); setTimezone(record.timezone); setCustomTimezone(''); setUsingCustomTimezone(false); }
      } else {
       const payer = currentPayerSelection(me.personId, groupResult.members);
         const defaultTimezone = browserTimezone(); setDescription(''); setAmount(''); setDate(scheduleMode ? localDateForTimeZone(new Date(), defaultTimezone) : today()); setRecurrenceEnabled(legacyRecurring); setEndDate(''); setFrequency('monthly'); setInterval('1'); setWeekdays([]); setTimezone(defaultTimezone); setCustomTimezone(''); setUsingCustomTimezone(false); setCategory(''); categoryTouchedRef.current = false; setCategoryTouched(false); setCategorySuggestion(undefined); setNotes(''); setMethod('equal'); setAllocationValues({}); setExistingSplitMetadata({}); setVersion(undefined); setSelected(groupResult.members.map((member) => member.personId)); setPayerRows(payer ? [{ personId: payer, amount: '' }] : []);
    }
    initializedRoute.current = routeKey;
     initializedVersion.current = expense?.version ?? schedule?.version;
    setDirty(false);
    setUpdatedElsewhere(false);
    setFormReady(true);
   }, [detailResource.data, dirty, expenseId, groupResource.data, meResource.data, routeKey, scheduleMode, scheduleResource.data, scheduledExpenseId]);

     const resourceError = meResource.error || groupResource.error || (expenseId && detailResource.error) || (scheduledExpenseId && scheduleResource.error);
     const isGlobalNewExpense = !routeGroupId && !expenseId && !scheduledExpenseId;
     const resourceErrorKey = meResource.error ? resourceKeys.identity() : groupResource.error ? resourceKeys.group(formUserId, id) : expenseId ? resourceKeys.expenseDetail(formUserId, expenseId) : scheduledExpenseId ? resourceKeys.scheduledExpense(formUserId, scheduledExpenseId) : resourceKeys.groups(formUserId);
     const routeReady = initializedRoute.current === routeKey && formReady;
     if (resourceError && !(group && routeReady)) return <Layout><ErrorBox error={resourceError} onRetry={retryFor(resourceErrorKey, meResource.data?.id, Boolean(meResource.error))} id="expense-resource-error" /></Layout>;
    if (!group && isGlobalNewExpense) return <Layout><div className="page-title"><div><p className="eyebrow">New expense</p><h1>Add expense</h1></div></div>{groupsResource.data?.groups.length ? <Field label="Group / person"><select required aria-label="Expense group" value={id} onChange={(event) => setTargetGroupId(event.target.value)}><option value="" disabled>Choose a group</option>{groupsResource.data.groups.map((option) => <option value={option.id} key={option.id}>{option.memberCount === 2 && option.counterpartName ? option.counterpartName : option.name}</option>)}</select></Field> : groupsResource.data !== undefined ? <Empty>No groups yet. <Link to="/?new=1">Create a group</Link> or <Link to="/?friend=1">add a friend</Link> to get started.</Empty> : <ResourceNotice resource={groupsResource} label="groups" retry={retryFor(resourceKeys.groups(formUserId), meResource.data?.id)} />}</Layout>;
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
    const recurring = scheduleMode || recurrenceEnabled;
    const scheduleDraft = { startDate: date, endDate: endDate || null, frequency, interval: Number(interval) || 1, weekdays };
      const schedulePreview = recurring ? (() => { try { return previewScheduleDates(scheduleDraft, localDateForTimeZone(new Date(), selectedTimezone.trim() || 'UTC'), 3); } catch { return previewScheduleDates(scheduleDraft, today(), 3); } })() : [];
   const newEntry = !expenseId && !scheduledExpenseId;
   const requestCategorySuggestion = async () => {
     if (!online || !newEntry || categoryTouchedRef.current || !description.trim()) return;
     const requestedDescription = description;
     suggestionRequest.current?.abort();
     const controller = new AbortController(); suggestionRequest.current = controller;
     try {
       const result = await getCategorySuggestion(requestedDescription, controller.signal);
       if (controller.signal.aborted || categoryTouchedRef.current || description.trim().toLowerCase() !== requestedDescription.trim().toLowerCase()) return;
       setCategorySuggestion(result.category || undefined);
       setCategory(result.category || '');
     } catch { /* Suggestions never block saving. */ }
     finally { if (suggestionRequest.current === controller) suggestionRequest.current = undefined; }
   };
   const manuallySetCategory = (value: string) => { categoryTouchedRef.current = true; setCategoryTouched(true); setCategorySuggestion(undefined); markDirty(); setCategory(value); };

   const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) return;
     setSubmitting(true); setFormError(undefined); const generation = captureSessionGeneration();
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
        if (recurring) {
         target = 'form';
         const scheduleInterval = Number(interval);
         if (!Number.isSafeInteger(scheduleInterval) || scheduleInterval < 1 || scheduleInterval > 366) throw new Error('Enter an interval from 1 to 366.');
         if (frequency === 'weekly' && !weekdays.length) throw new Error('Choose at least one weekday for a weekly schedule.');
         if (frequency !== 'weekly' && weekdays.length) throw new Error('Weekdays are only used for weekly schedules.');
         if (endDate && endDate < date) throw new Error('End date must not precede the start date.');
          if (category === 'Other') throw new Error('Enter a custom category.');
           const scheduleInput: ScheduledExpenseInput = scheduledExpenseInput.parse({ description: description.trim(), amount_minor: cents, currency, category: category.trim() || null, start_date: date, end_date: endDate || null, frequency, interval: scheduleInterval, weekdays: frequency === 'weekly' ? weekdays : [], timezone: selectedTimezone.trim(), payers, splits, version, client_operation_id: scheduledExpenseId ? undefined : operation });
          if (scheduledExpenseId) await updateScheduledExpense(scheduledExpenseId, scheduleInput);
         else await createScheduledExpense(id, scheduleInput);
          await invalidateForMutation.scheduledExpenseChanged(id, currentUserId, scheduledExpenseId, generation);
         nav(`/groups/${id}`);
       } else {
       if (category === 'Other') throw new Error('Enter a custom category.');
       const input = { description: description.trim(), amount_minor: cents, currency, date, category: category.trim() || null, notes: notes || null, payers, splits, version, client_operation_id: expenseId ? undefined : operation };
         if (expenseId) { await api(`/expenses/${expenseId}`, { method: 'PUT', body: JSON.stringify(input) }); await invalidateForMutation.expenseChanged(id, expenseId, currentUserId, generation); }
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
        <div className="page-title expense-heading"><div><Link to={routeGroupId ? `/groups/${id}` : '/'} className="back">← <span className="back__label">{routeGroupId ? group.name : 'Groups'}</span></Link><p className="eyebrow">{scheduleMode ? (scheduledExpenseId ? 'Edit scheduled expense' : 'New scheduled expense') : expenseId ? 'Edit expense' : 'New expense'}</p><h1>{scheduleMode ? (scheduledExpenseId ? 'Edit recurring expense' : 'Schedule an expense') : expenseId ? 'Edit expense' : 'Add expense'}</h1></div><div className="expense-heading__actions"><Link className="button button--secondary" to={routeGroupId ? `/groups/${id}` : '/'}>Cancel</Link></div></div>{meResource.error ? <CachedIdentityNotice resource={meResource} id="expense-identity-error" /> : null}{groupResource.error ? <ResourceNotice resource={groupResource} label="group details" retry={retryFor(resourceKeys.group(formUserId, id), meResource.data?.id)} /> : null}{expenseId && detailResource.error ? <ResourceNotice resource={detailResource} label="expense form data" retry={retryFor(resourceKeys.expenseDetail(formUserId, expenseId), meResource.data?.id)} /> : null}{scheduledExpenseId && scheduleResource.error ? <ResourceNotice resource={scheduleResource} label="scheduled expense form data" retry={retryFor(resourceKeys.scheduledExpense(formUserId, scheduledExpenseId), meResource.data?.id)} /> : null}
         {updatedElsewhere ? <div className="offline-banner updated-elsewhere" role="status"><span>Updated elsewhere. Your changes are preserved.</span><Button type="button" variant="secondary" onClick={resetToServer}>Reload</Button></div> : null}{editUnavailable ? <ConnectionBanner detail={scheduleMode ? 'Schedule management is online-only. Reconnect before saving changes.' : 'Editing expenses is online-only. Reconnect before saving changes.'} /> : null}<form className="expense-form reading-width" onSubmit={submit} aria-describedby={formError ? 'expense-form-error' : preview.error ? 'allocation-error' : undefined}>
          {!expenseId && !scheduledExpenseId ? <Field label="Group / person" className="field--compact"><select required aria-label="Expense group" value={id} onChange={(event) => { setTargetGroupId(event.target.value); setDirty(false); }}><option value="" disabled>Choose a group</option>{(groupsResource.data?.groups || []).map((option) => <option value={option.id} key={option.id}>{option.memberCount === 2 && option.counterpartName ? option.counterpartName : option.name}</option>)}</select></Field> : null}
          <Field label="Amount and currency" className={amountFieldClass(amount)}><CurrencySelect value={currency} onChange={(value) => { markDirty(); setCurrency(value); }} /><input id="expense-amount" className={amountInputClass(amount)} data-amount-length={amountInputLength(amount)} required inputMode="decimal" aria-label="Expense amount" aria-invalid={formError?.target === 'amount'} aria-describedby={formError?.target === 'amount' ? 'expense-form-error' : undefined} placeholder="0.00" value={amount} onChange={(event) => setAmountAndPayer(event.target.value)} /></Field>
           <Field label="Description" className="field--compact"><input id="expense-description" required aria-invalid={formError?.target === 'description'} aria-describedby={formError?.target === 'description' ? 'expense-form-error' : undefined} placeholder="What was this for?" value={description} onChange={(event) => { const value = event.target.value; markDirty(); setDescription(value); if (!categoryTouchedRef.current) { setCategorySuggestion(undefined); setCategory(''); } }} onBlur={() => void requestCategorySuggestion()} /></Field>{!expenseId && !scheduledExpenseId ? <label className="checkbox-row recurrence-toggle" htmlFor="repeat-expense"><input id="repeat-expense" type="checkbox" checked={recurrenceEnabled} onChange={(event) => { markDirty(); setRecurrenceEnabled(event.target.checked); }} /><span>Repeat this expense</span></label> : null}
       <button className="summary-row" type="button" aria-invalid={formError?.target === 'payers'} aria-describedby={formError?.target === 'payers' ? 'expense-form-error' : undefined} onClick={() => setPayersOpen(true)}><span><span className="summary-row__label">{payerSummary}</span><small>{payerSummaryDetail}</small></span><strong>Change</strong></button>
       <fieldset aria-describedby={formError?.target === 'participants' ? 'expense-form-error' : undefined}><legend>Split between</legend><div className="participant-list">{members.map((member) => { const active = selected.includes(member.personId); return <button className="participant-row" type="button" aria-pressed={active} aria-invalid={formError?.target === 'participants'} key={member.personId} onClick={() => toggleSplit(member.personId)}><span className="participant-row__name"><span className="checkmark" aria-hidden="true">✓</span><span className="participant-row__label">{member.name}</span>{isYou(member.personId) ? <small>You</small> : null}</span>{active && method === 'equal' ? <span className="allocation-row__amount">{formatMoney(preview.allocations[member.personId] || 0, currency)}</span> : null}</button>; })}</div></fieldset>
       <div className="secondary-fields"><Field label="Split method" className="field--compact"><select value={method} onChange={(event) => { markDirty(); setMethod(event.target.value as SplitMethod); }}><option value="equal">Equal</option><option value="exact">Exact amounts</option><option value="percentage">Percentage</option><option value="shares">Shares</option></select></Field>
          {method !== 'equal' && <div className="allocation-list">{members.filter((member) => selected.includes(member.personId)).map((member) => <div className="allocation-row" key={member.personId}><span className="allocation-row__person"><span>{member.name}{isYou(member.personId) ? ' · You' : ''}</span><span className="allocation-row__amount">{preview.allocations[member.personId] !== undefined ? formatMoney(preview.allocations[member.personId], currency) : '—'}</span></span><input className={amountInputClass(allocationValues[member.personId] || '')} data-amount-length={amountInputLength(allocationValues[member.personId] || '')} required inputMode="decimal" aria-label={`${member.name} ${method} value`} aria-invalid={formError?.target === 'allocation' || Boolean(preview.error)} aria-describedby={formError?.target === 'allocation' ? 'expense-form-error' : preview.error ? 'allocation-error' : undefined} placeholder={method === 'exact' ? '0.00' : method === 'percentage' ? '%' : 'Shares'} value={allocationValues[member.personId] || ''} onChange={(event) => updateAllocation(member.personId, event.target.value)} /></div>)}<p className="allocation-summary" role="status">{method === 'exact' ? `Remaining ${formatMoney(preview.remainingMinor ?? amountMinor, currency)}` : method === 'percentage' ? `Remaining ${preview.remainingPercent ?? 100}%` : `Total shares ${preview.totalValue || 0}`}</p>{preview.error ? <p className="error" id="allocation-error" role="alert">{preview.error}</p> : null}</div>}
             {scheduleMode ? <><div className="form-row"><Field label="Start date" className="field--compact"><input required type="date" value={date} onChange={(event) => { markDirty(); setDate(event.target.value); }} /></Field><Field label="End date (optional)" className="field--compact"><input type="date" value={endDate} min={date} onChange={(event) => { markDirty(); setEndDate(event.target.value); }} /></Field></div><div className="form-row"><Field label="Repeats" className="field--compact"><select value={frequency} onChange={(event) => { markDirty(); setFrequency(event.target.value as RecurrenceFrequency); if (event.target.value !== 'weekly') setWeekdays([]); }}><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select></Field><Field label="Every (interval)" className="field--compact"><input required type="number" min="1" max="366" value={interval} onChange={(event) => { markDirty(); setInterval(event.target.value); }} /></Field></div>{frequency === 'weekly' ? <fieldset><legend>On weekdays</legend><div className="weekday-list">{weekdayLabels.map((day) => <label className="checkbox-row" key={day.value}><input type="checkbox" checked={weekdays.includes(day.value)} onChange={() => { markDirty(); setWeekdays((current) => current.includes(day.value) ? current.filter((value) => value !== day.value) : [...current, day.value].sort((a, b) => a - b)); }} />{day.label}</label>)}</div></fieldset> : null}<Field label="Creator timezone" className="field--compact"><select id="creator-timezone" required value={timezoneSelectValue} aria-describedby="timezone-help" onChange={(event) => { markDirty(); if (event.target.value === otherTimezoneValue) { setUsingCustomTimezone(true); setCustomTimezone(''); } else { setUsingCustomTimezone(false); setCustomTimezone(''); setTimezone(event.target.value); } }}>{timezoneSelectOptions.map(({ zone, label }) => <option key={zone} value={zone}>{label}</option>)}<option value={otherTimezoneValue}>Other IANA timezone…</option></select>{usingCustomTimezone ? <input id="custom-timezone" required aria-label="Other IANA timezone" aria-describedby="timezone-help custom-timezone-help" placeholder="America/Los_Angeles" value={customTimezone} onChange={(event) => { markDirty(); setCustomTimezone(event.target.value); }} /> : null}<small id="timezone-help" className="muted">Choose an IANA timezone. Selected: {timezoneLabel(selectedTimezone || 'UTC', timezoneLabelDate)}. Dates are calendar dates in this timezone; the stored value remains the IANA ID.</small>{usingCustomTimezone ? <small id="custom-timezone-help" className="muted">Enter a valid IANA timezone ID, such as America/Los_Angeles.</small> : null}</Field><div className="schedule-preview"><strong>Next dates</strong>{schedulePreview.length ? <ol>{schedulePreview.map((previewDate) => <li key={previewDate}>{formatScheduleDate(previewDate)}</li>)}</ol> : <p className="muted">No occurrences match these settings.</p>}<p className="schedule-preview__continuation">{scheduleContinuationText(endDate, schedulePreview)}</p></div><p className="muted">Only future occurrences use edits. Already generated expenses stay in the ledger; occurrences affect balances only when posted. Creating or changing a schedule never enters the expense outbox.</p><OneTimeOnlyDetails category={category} customCategories={categoriesResource.data?.categories || []} notes={notes} showNotes={false} onCategoryChange={(value) => { markDirty(); setCategory(value); }} onNotesChange={(value) => { markDirty(); setNotes(value); }} /></> : <><div className="form-row"><Field label="Date" className="field--compact"><input required type="date" value={date} onChange={(event) => { markDirty(); setDate(event.target.value); }} /></Field></div>
              <OneTimeOnlyDetails category={category} customCategories={categoriesResource.data?.categories || []} notes={notes} suggested={Boolean(categorySuggestion && !categoryTouched && category === categorySuggestion)} onCategoryChange={manuallySetCategory} onNotesChange={(value) => { markDirty(); setNotes(value); }} /></>}
       </div>
         {formError ? <ErrorBox error={formError.error} id="expense-form-error" /> : null}<Button className="full-width-button" disabled={submitting || editUnavailable} type="submit">{submitting ? 'Saving…' : scheduleMode ? scheduledExpenseId ? 'Save schedule' : 'Create schedule' : expenseId ? 'Save changes' : 'Save expense'}</Button>
    </form>
       {payersOpen && <Modal title="Who paid?" description="Use one payer for a quick entry, or add people and enter exact amounts." onClose={() => setPayersOpen(false)}><div className="payer-list">{payerRows.map((payer, index) => <div className={`payer-row${payerRows.length > 1 ? ' payer-row--removable' : ''}`} key={`${payer.personId}-${index}`}><select aria-label={`Payer ${index + 1}: ${isYou(payer.personId) ? 'You' : nameOf(members, payer.personId)}`} aria-invalid={formError?.target === 'payers'} aria-describedby={formError?.target === 'payers' ? 'expense-form-error' : undefined} value={payer.personId} onChange={(event) => { markDirty(); setPayerRows((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, personId: event.target.value } : row)); }}>{members.filter((member) => !payerRows.some((other, otherIndex) => other.personId === member.personId && otherIndex !== index)).map((member) => <option key={member.personId} value={member.personId}>{member.name}{isYou(member.personId) ? ' · You' : ''}</option>)}</select><input className={amountInputClass(payer.amount)} data-amount-length={amountInputLength(payer.amount)} required inputMode="decimal" aria-label={`Amount paid by ${isYou(payer.personId) ? 'You' : nameOf(members, payer.personId)} (payer ${index + 1})`} aria-invalid={formError?.target === 'payers'} aria-describedby={formError?.target === 'payers' ? 'expense-form-error' : undefined} placeholder="Amount" value={payer.amount} onChange={(event) => { markDirty(); setPayerRows((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, amount: event.target.value } : row)); }} />{payerRows.length > 1 && <Button type="button" variant="secondary" aria-label={`Remove payer ${isYou(payer.personId) ? 'You' : nameOf(members, payer.personId)} (payer ${index + 1})`} onClick={() => removePayer(index)}>Remove</Button>}</div>)}</div><p className="allocation-summary" role="status">Payers total {formatMoney(payerRows.reduce((sum, payer) => { try { return sum + parseMoney(payer.amount || '0', currency); } catch { return sum; } }, 0), currency)} of {formatMoney(amountMinor, currency)}</p><Button className="full-width-button" type="button" variant="secondary" onClick={addPayer}>+ Add payer</Button><Button className="full-width-button" type="button" onClick={() => setPayersOpen(false)}>Done</Button></Modal>}
  </Layout>;
}

function auditSnapshot(snapshot: unknown) {
  if (!snapshot || typeof snapshot !== 'object') return 'Snapshot unavailable';
  const row = snapshot as Record<string, unknown>;
  const fields = ['description', 'amountMinor', 'currency', 'date', 'fromPersonId', 'toPersonId', 'note', 'deletedAt', 'version'];
  const values = fields.flatMap((field) => Object.prototype.hasOwnProperty.call(row, field) ? [`${field}: ${typeof row[field] === 'string' || typeof row[field] === 'number' || row[field] === null ? String(row[field]) : '[details hidden]'}`] : []);
  return values.length ? values.join(' · ') : 'No safe field differences available';
}

function AuditList({ groupId, entityId, userId }: { groupId: string; entityId: string; userId?: string }) {
  const resource = useResource<{ audit: AuditEvent[]; nextCursor?: string }>(resourceKeys.audit(userId || 'pending', groupId), userId, (signal) => getAuditPage(groupId, { limit: 50 }, signal), RESOURCE_FRESHNESS.audit);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>();
  const scopeKey = `${userId || 'pending'}:${groupId}:${entityId}`;
  const scopeKeyRef = useRef(scopeKey);
  scopeKeyRef.current = scopeKey;
  const pageScope = useRef(createPageRequestScope());
  const cursorRef = useRef<string>();
  useEffect(() => {
    pageScope.current.reset(scopeKey);
    cursorRef.current = resource.data?.nextCursor;
    setEvents(resource.data?.audit || []); setCursor(resource.data?.nextCursor);
    setLoading(false); setError(undefined);
  }, [groupId, resource.data, scopeKey, userId]);
  useEffect(() => () => pageScope.current.dispose(), []);
  const loadMore = async () => {
    if (!cursor || loading) return;
    const request = pageScope.current.begin(scopeKey, cursor);
    setLoading(true); setError(undefined);
    try {
      const page = await getAuditPage(groupId, { cursor: request.cursor }, request.signal);
      if (!pageScope.current.isCurrent(request) || scopeKeyRef.current !== request.key || cursorRef.current !== request.cursor) return;
      cursorRef.current = page.nextCursor;
      setEvents((current) => appendUniquePage(current, page.audit, (event) => event.id)); setCursor(page.nextCursor);
    } catch (cause) {
      if (pageScope.current.isCurrent(request) && !(cause instanceof DOMException && cause.name === 'AbortError')) setError(cause);
    }
    finally { if (pageScope.current.isCurrent(request)) setLoading(false); }
  };
  const matching = events.filter((event) => event.entityId === entityId);
  return <section className="reading-width audit"><h2>Audit history</h2><ResourceNotice resource={resource} label="audit history" />{matching.length ? <div className="list">{matching.map((event) => <div className="row audit-row" key={event.id}><span><strong>{event.action[0].toUpperCase() + event.action.slice(1)} · {event.entityType}</strong><small>Actor {event.actorName || 'Unknown user'} · {new Date(event.occurredAt).toLocaleString()} · version {event.version}</small>{event.before !== undefined ? <small>Before: {auditSnapshot(event.before)}</small> : null}{event.after !== undefined ? <small>After: {auditSnapshot(event.after)}</small> : null}</span></div>)}</div> : resource.data !== undefined ? <p className="muted">No audit events in the loaded pages yet.</p> : null}{cursor ? <Button type="button" variant="secondary" disabled={loading} onClick={() => void loadMore()}>{loading ? 'Loading…' : 'Load more audit events'}</Button> : null}{error ? <ErrorBox error={error} id="audit-error" /> : null}</section>;
}

function ExpenseDetail() {
  const online = useOnlineStatus(); const { id, expenseId = '' } = useParams(); const nav = useNavigate();
  const me = useResource(resourceKeys.identity(), '', (signal) => getMe({ signal }), RESOURCE_FRESHNESS.expenses, hydrateIdentity);
  const details = useResource<{ expense: Expense; history: Array<{ id: string; revision: number; createdAt: string }> }>(resourceKeys.expenseDetail(me.data?.id || 'pending', expenseId), me.data?.id, (signal) => getExpenseDetails(expenseId, signal), RESOURCE_FRESHNESS.expenseDetail, me.data?.id ? () => hydrateExpenseDetails(me.data!.id, expenseId) : undefined);
  const expense = details.data?.expense; const groupId = expense?.groupId || id || ''; const group = useResource<{ group: Group; members: GroupMember[] }>(resourceKeys.group(me.data?.id || 'pending', groupId), me.data?.id, (signal) => getGroup(groupId, signal), RESOURCE_FRESHNESS.group, me.data?.id && groupId ? () => hydrateGroup(me.data!.id, groupId) : undefined); const error = details.error || group.error || me.error;
  const [busy, setBusy] = useState(false); const [mutationError, setMutationError] = useState<unknown>();
  useEffect(() => { if (expense && !id) nav(`/groups/${expense.groupId}/expenses/${expenseId}`, { replace: true }); }, [expense, expenseId, id, nav]);
  if (!expense && error) return <Layout><ErrorBox error={error} onRetry={retryFor(resourceKeys.expenseDetail(me.data?.id || 'pending', expenseId), me.data?.id, Boolean(me.error))} id="expense-detail-error" /></Layout>; if (!expense) return <Layout><Loading /></Layout>;
  const restore = async () => { if (!online || busy) return; setBusy(true); setMutationError(undefined); const generation = captureSessionGeneration(); try { await restoreExpense(expense.id, expense.version); await invalidateForMutation.expenseChanged(expense.groupId, expense.id, me.data?.id, generation); } catch (cause) { setMutationError(cause); } finally { setBusy(false); } };
  const remove = async () => { if (!confirm('Delete this expense?')) return; setBusy(true); setMutationError(undefined); const generation = captureSessionGeneration(); try { await api(`/expenses/${expense.id}?version=${expense.version}`, { method: 'DELETE' }); await invalidateForMutation.expenseChanged(expense.groupId, expense.id, me.data?.id, generation); nav(`/groups/${expense.groupId}`); } catch (cause) { setMutationError(cause); } finally { setBusy(false); } };
  const members = group.data?.members || [];
  return <Layout><Link to={`/groups/${expense.groupId}`} className="back">← Group</Link><div className="page-title"><div><p className="eyebrow">{expense.deletedAt ? 'Deleted transaction' : expense.date}</p><h1>{expense.description}</h1></div><Money amountMinor={expense.amountMinor} currency={expense.currency} size="large" /></div>{expense.deletedAt ? <Surface><strong>Deleted expense</strong><p className="muted">The tombstone is retained for 30 days. Restore uses the loaded version and reports conflicts instead of overwriting changes.</p><Button disabled={!online || busy} onClick={() => void restore()}>{busy ? 'Restoring…' : 'Restore expense'}</Button></Surface> : null}<ResourceNotice resource={details} label="expense details" retry={retryFor(resourceKeys.expenseDetail(me.data?.id || 'pending', expenseId), me.data?.id)} /><ResourceNotice resource={group} label="member names" retry={retryFor(resourceKeys.group(me.data?.id || 'pending', expense.groupId), me.data?.id)} /><section className="reading-width"><h2>Payers</h2><div className="list">{expense.payers.map((payer) => <div className="row" key={payer.personId}><span>{nameOf(members, payer.personId)}{!members.some((member) => member.personId === payer.personId) ? ' · Removed' : ''}</span><Money amountMinor={payer.amountMinor} currency={expense.currency} /></div>)}</div><h2>Split</h2><div className="list">{expense.splits.map((split) => <div className="row" key={split.personId}><span>{nameOf(members, split.personId)}{!members.some((member) => member.personId === split.personId) ? ' · Removed' : ''}</span><Money amountMinor={split.amountMinor} currency={expense.currency} /></div>)}</div></section>{mutationError ? <ErrorBox error={mutationError} id="expense-mutation-error" /> : null}{!expense.deletedAt && online ? <div className="actions"><Link className="button" to={`/groups/${expense.groupId}/expense/${expense.id}`}>Edit</Link><Button variant="danger" disabled={busy} onClick={() => void remove()}>Delete</Button></div> : null}<AuditList groupId={expense.groupId} entityId={expense.id} userId={me.data?.id} /></Layout>;
}

function Settle() {
  const online = useOnlineStatus();
  const { id = '' } = useParams();
  const nav = useNavigate();
  const me = useResource(resourceKeys.identity(), '', (signal) => getMe({ signal }), RESOURCE_FRESHNESS.expenses, hydrateIdentity);
  const settleUserId = me.data?.id || 'pending';
  const groupResource = useResource<{ group: Group; members: GroupMember[]; historicalParticipants?: HistoricalParticipant[] }>(resourceKeys.group(settleUserId, id), me.data?.id, (signal) => getGroup(id, signal), RESOURCE_FRESHNESS.group, me.data?.id ? () => hydrateGroup(me.data!.id, id) : undefined);
  const balancesResource = useResource<{ balances: Record<string, Balances> }>(resourceKeys.balances(settleUserId, id), me.data?.id, (signal) => getBalances(id, signal), RESOURCE_FRESHNESS.balances, me.data?.id ? () => hydrateBalances(me.data!.id, id) : undefined);
   const historicalParticipants = groupResource.data?.historicalParticipants || (groupResource.data?.members || []).map((member) => ({ ...member, status: member.removedAt ? 'removed' as const : 'active' as const }));
   const members = historicalParticipants.map((participant) => ({ ...participant, name: participant.status === 'deleted' ? 'Deleted account' : `${participant.name}${participant.status === 'removed' ? ' · Removed' : ''}` }));
  const group = groupResource.data?.group;
  const balances = balancesResource.data?.balances || {};
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
   const [amount, setAmount] = useState('');
   const [currency, setCurrency] = useState<Currency>('USD');
   const [date, setDate] = useState(today);
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
   const fallbackFrom = suggestion?.fromPersonId || historicalParticipants[0]?.personId || '';
   const fallbackTo = suggestion?.toPersonId || historicalParticipants.find((member) => member.personId !== fallbackFrom)?.personId || '';
   const suggestionFingerprint = group ? settlementSuggestionFingerprint(suggestion, group.currency, fallbackFrom, fallbackTo) : '';

  useEffect(() => {
    if (!group || !me.data || !balancesResource.data) return;
    const routeChanged = initializedRoute.current !== settlementRouteKey;
    if (!routeChanged && dirty) return;
    if (!routeChanged && initializedSuggestion.current === suggestionFingerprint) return;
    setCurrency(suggestion?.currency || group.currency); setFrom(fallbackFrom); setTo(fallbackTo); setAmount(suggestion ? moneyInput(suggestion.amountMinor) : ''); if (routeChanged) setDate(today());
    initializedRoute.current = settlementRouteKey;
    initializedSuggestion.current = suggestionFingerprint;
    setDirty(false);
  }, [balancesResource.data, dirty, fallbackFrom, fallbackTo, group, me.data, settlementRouteKey, suggestion, suggestionFingerprint]);
  const resourceError = error || me.error || groupResource.error || balancesResource.error;
  if (!group) return <Layout>{resourceError ? <ErrorBox error={resourceError} onRetry={retryFor(resourceError === balancesResource.error ? resourceKeys.balances(settleUserId, id) : resourceKeys.group(settleUserId, id), me.data?.id, Boolean(me.error))} id="settle-resource-error" /> : <Loading />}</Layout>;
   if (!online || offlineData) return <Layout><Link to={`/groups/${id}`} className="back">← <span className="back__label">{group.name}</span></Link><div className="page-title"><div><p className="eyebrow">{balancesResource.data ? 'Cached balance' : 'Balance unavailable'}</p><h1>Settle up</h1></div></div>{me.error ? <CachedIdentityNotice resource={me} id="settle-identity-error" /> : null}<p className="offline-banner" role="status">Settlements are online-only. Reconnect to submit; {balancesResource.data ? 'cached balances remain available.' : 'no verified cached balances are available on this device.'}</p><ResourceNotice resource={balancesResource} label="balances" retry={retryFor(resourceKeys.balances(settleUserId, id), me.data?.id)} />{balancesResource.data ? Object.entries(balances).map(([currencyKey, balance]) => <section className="reading-width" key={currencyKey}><h2>Balances <small>({currencyKey})</small></h2>{balance.simplified.length ? <div className="list">{balance.simplified.map((item) => <div className="row" key={`${currencyKey}-${item.fromPersonId}-${item.toPersonId}`}><span>{item.fromPersonId === currentPersonId ? 'You' : item.fromName} owes {item.toPersonId === currentPersonId ? 'You' : item.toName}</span><Money amountMinor={item.amountMinor} currency={currencyKey} tone="debt" /></div>)}</div> : <Empty>Everyone is settled up.</Empty>}</section>) : null}</Layout>;
    if (balancesResource.data === undefined) return <Layout><Link to={`/groups/${id}`} className="back">← <span className="back__label">{group.name}</span></Link><div className="page-title"><div><p className="eyebrow">Balance required</p><h1>Settle up</h1></div></div>{me.error ? <CachedIdentityNotice resource={me} id="settle-identity-error" /> : null}{!me.error ? <ResourceNotice resource={balancesResource} label="balances" retry={retryFor(resourceKeys.balances(settleUserId, id), me.data?.id)} /> : null}</Layout>;
   const submit = async (event: FormEvent) => { event.preventDefault(); if (submitting) return; setSubmitting(true); setError(undefined); const generation = captureSessionGeneration(); try { await api(`/groups/${id}/settlements`, { method: 'POST', body: JSON.stringify({ from_person_id: from, to_person_id: to, amount_minor: parseMoney(amount, currency), currency, date, client_operation_id: operation }) }); await invalidateForMutation.settlementChanged(id, me.data?.id, generation); nav(`/groups/${id}`); } catch (cause) { setSubmitting(false); setError(cause); } };
      const resetSuggestion = () => { setCurrency(suggestion?.currency || group.currency); setFrom(fallbackFrom); setTo(fallbackTo); setAmount(suggestion ? moneyInput(suggestion.amountMinor) : ''); initializedRoute.current = settlementRouteKey; initializedSuggestion.current = suggestionFingerprint; setDirty(false); };
       return <Layout><Link to={`/groups/${id}`} className="back">← <span className="back__label">{group.name}</span></Link><div className="page-title"><div><p className="eyebrow">{currentPersonId ? 'Suggested from your balance' : 'Payment'}</p><h1>Settle up</h1></div></div>{me.error ? <CachedIdentityNotice resource={me} id="settle-identity-error" /> : null}<p className="muted">Record a payment. Partial settlements are supported.</p><ResourceNotice resource={balancesResource} label="balances" retry={retryFor(resourceKeys.balances(settleUserId, id), me.data?.id)} /><form className="reading-width" onSubmit={submit} aria-describedby={error ? 'settlement-form-error' : undefined}><Field label="Who paid?"><select value={from} onChange={(event) => { setError(undefined); markDirty(); setFrom(event.target.value); }}>{members.map((member) => <option key={member.personId} value={member.personId}>{member.name}{member.personId === currentPersonId ? ' · You' : ''}</option>)}</select></Field><Field label="Who received?"><select value={to} onChange={(event) => { setError(undefined); markDirty(); setTo(event.target.value); }}>{members.filter((member) => member.personId !== from).map((member) => <option key={member.personId} value={member.personId}>{member.name}{member.personId === currentPersonId ? ' · You' : ''}</option>)}</select></Field><Field label="Currency"><CurrencySelect value={currency} onChange={(value) => { setError(undefined); markDirty(); setCurrency(value); }} /></Field><Field label={`Amount (${currency})`}><input className={amountInputClass(amount)} data-amount-length={amountInputLength(amount)} required inputMode="decimal" aria-invalid={Boolean(error)} value={amount} onChange={(event) => { setError(undefined); markDirty(); setAmount(event.target.value); }} /></Field><Field label="Date"><input required type="date" value={date} onChange={(event) => { setError(undefined); markDirty(); setDate(event.target.value); }} /></Field>{dirty ? <Button className="full-width-button" type="button" variant="secondary" onClick={resetSuggestion}>Reset to current suggestion</Button> : null}{error ? <ErrorBox error={error} id="settlement-form-error" /> : null}<Button className="full-width-button" disabled={submitting} type="submit">{submitting ? 'Recording…' : 'Record payment'}</Button></form></Layout>;
}

function SettlementDetail() {
  const online = useOnlineStatus(); const { settlementId = '' } = useParams(); const nav = useNavigate(); const me = useResource(resourceKeys.identity(), '', (signal) => getMe({ signal }), RESOURCE_FRESHNESS.expenses, hydrateIdentity); const userId = me.data?.id;
   const detail = useResource<{ settlement: Settlement; history: Array<{ id: string; revision: number; createdAt: string }> }>(resourceKeys.settlementDetail(userId || 'pending', settlementId), userId, (signal) => getSettlementDetails(settlementId, signal), RESOURCE_FRESHNESS.settlementDetail); const settlement = detail.data?.settlement; const groupId = settlement?.groupId || ''; const group = useResource<{ group: Group; members: GroupMember[]; historicalParticipants?: HistoricalParticipant[] }>(resourceKeys.group(userId || 'pending', groupId), userId, (signal) => groupId ? getGroup(groupId, signal) : Promise.reject(new Error('Group unavailable')), RESOURCE_FRESHNESS.group); const members = group.data?.members || []; const historicalParticipants = group.data?.historicalParticipants || members.map((member) => ({ ...member, status: member.removedAt ? 'removed' as const : 'active' as const }));
  const [busy, setBusy] = useState(false); const [editing, setEditing] = useState(false); const [error, setError] = useState<unknown>(); const [from, setFrom] = useState(''); const [to, setTo] = useState(''); const [amount, setAmount] = useState(''); const [date, setDate] = useState(''); const [note, setNote] = useState('');
  useEffect(() => { if (settlement && !editing) { setFrom(settlement.fromPersonId); setTo(settlement.toPersonId); setAmount(moneyInput(settlement.amountMinor)); setDate(settlement.date); setNote(settlement.note || ''); } }, [editing, settlement]);
  if (!settlement && (detail.error || me.error)) return <Layout><ErrorBox error={detail.error || me.error} id="settlement-detail-error" /></Layout>; if (!settlement) return <Layout><Loading /></Layout>;
   const participantIds = [...new Set([settlement.fromPersonId, settlement.toPersonId, ...historicalParticipants.map((participant) => participant.personId)])]; const label = (personId: string) => { if (personId === me.data?.personId) return 'You'; const participant = historicalParticipants.find((candidate) => candidate.personId === personId); return participant ? (participant.status === 'deleted' ? 'Deleted account' : `${participant.name}${participant.status === 'removed' ? ' · Removed' : ''}`) : 'Removed'; };
  const restore = async () => { if (!online || busy) return; setBusy(true); setError(undefined); const generation = captureSessionGeneration(); try { await restoreSettlement(settlement.id, settlement.version); await invalidateForMutation.settlementChanged(settlement.groupId, userId, settlement.id, generation); } catch (cause) { setError(cause); } finally { setBusy(false); } };
  const remove = async () => { if (!confirm('Delete this settlement?')) return; setBusy(true); setError(undefined); const generation = captureSessionGeneration(); try { await api(`/settlements/${settlement.id}?version=${settlement.version}`, { method: 'DELETE' }); await invalidateForMutation.settlementChanged(settlement.groupId, userId, settlement.id, generation); nav(`/groups/${settlement.groupId}`); } catch (cause) { setError(cause); } finally { setBusy(false); } };
  const save = async (event: FormEvent) => { event.preventDefault(); if (!online || busy) return; setBusy(true); setError(undefined); const generation = captureSessionGeneration(); try { await updateSettlement(settlement.id, { from_person_id: from, to_person_id: to, amount_minor: parseMoney(amount, settlement.currency), currency: settlement.currency, date, note: note || null, version: settlement.version }); setEditing(false); await invalidateForMutation.settlementChanged(settlement.groupId, userId, settlement.id, generation); } catch (cause) { setError(cause); } finally { setBusy(false); } };
  return <Layout><Link to={`/groups/${settlement.groupId}`} className="back">← Group</Link><div className="page-title"><div><p className="eyebrow">{settlement.deletedAt ? 'Deleted transaction' : settlement.date}</p><h1>{label(settlement.fromPersonId)} paid {label(settlement.toPersonId)}</h1></div><Money amountMinor={settlement.amountMinor} currency={settlement.currency} size="large" tone="positive" /></div>{settlement.deletedAt ? <Surface><strong>Deleted settlement</strong><p className="muted">The tombstone is retained for 30 days and can be restored by an active group member.</p><Button disabled={!online || busy} onClick={() => void restore()}>{busy ? 'Restoring…' : 'Restore settlement'}</Button></Surface> : editing ? <Surface><form onSubmit={save}><Field label="Who paid?"><select value={from} onChange={(event) => setFrom(event.target.value)}>{participantIds.filter((personId) => personId !== to).map((personId) => <option key={personId} value={personId}>{label(personId)}</option>)}</select></Field><Field label="Who received?"><select value={to} onChange={(event) => setTo(event.target.value)}>{participantIds.filter((personId) => personId !== from).map((personId) => <option key={personId} value={personId}>{label(personId)}</option>)}</select></Field><Field label={`Amount (${settlement.currency})`}><input required inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} /></Field><Field label="Date"><input required type="date" value={date} onChange={(event) => setDate(event.target.value)} /></Field><Field label="Note (optional)"><textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} /></Field><div className="actions"><Button type="submit" disabled={!online || busy}>{busy ? 'Saving…' : 'Save changes'}</Button><Button type="button" variant="secondary" onClick={() => setEditing(false)}>Cancel</Button></div></form></Surface> : <div className="actions"><Button type="button" onClick={() => setEditing(true)} disabled={!online}>Edit settlement</Button><Button type="button" variant="danger" disabled={!online || busy} onClick={() => void remove()}>Delete</Button></div>}{error ? <ErrorBox error={error} id="settlement-mutation-error" /> : null}<ResourceNotice resource={detail} label="settlement details" /><AuditList groupId={settlement.groupId} entityId={settlement.id} userId={userId} /></Layout>;
}

function Activity() {
  const online = useOnlineStatus();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedGroupId = searchParams.get('group') || undefined;
  const me = useResource(resourceKeys.identity(), '', (signal) => getMe({ signal }), RESOURCE_FRESHNESS.expenses, hydrateIdentity);
  const groupsResource = useResource<{ groups: Group[] }>(resourceKeys.groups(me.data?.id || 'pending'), me.data?.id, (signal) => getGroups(signal), RESOURCE_FRESHNESS.groups, me.data?.id ? () => hydrateGroups(me.data!.id) : undefined);
   const activity = useResource<{ activity: ActivityItem[]; nextCursor?: string }>(resourceKeys.activity(me.data?.id || 'pending', selectedGroupId || 'all'), me.data?.id, (signal) => getActivity(selectedGroupId, signal), RESOURCE_FRESHNESS.activity, me.data?.id ? () => hydrateActivity(me.data!.id, selectedGroupId || 'all') : undefined);
    const [items, setItems] = useState<ActivityItem[]>([]); const [cursor, setCursor] = useState<string>(); const [loadingMore, setLoadingMore] = useState(false); const [pageError, setPageError] = useState<unknown>();
    const activityScopeKey = `${me.data?.id || 'pending'}:${selectedGroupId || 'all'}`;
    const activityScopeKeyRef = useRef(activityScopeKey);
    activityScopeKeyRef.current = activityScopeKey;
    const activityPageScope = useRef(createPageRequestScope());
    const activityCursorRef = useRef<string>();
    useEffect(() => {
      activityPageScope.current.reset(activityScopeKey);
      activityCursorRef.current = activity.data?.nextCursor;
      setItems(activity.data?.activity || []); setCursor(activity.data?.nextCursor);
      setLoadingMore(false); setPageError(undefined);
    }, [activity.data, activityScopeKey]);
    useEffect(() => () => activityPageScope.current.dispose(), []);
    const loadMore = async () => {
      if (!cursor || loadingMore) return;
      const request = activityPageScope.current.begin(activityScopeKey, cursor);
      setLoadingMore(true); setPageError(undefined);
      try {
        const page = await getActivityPage(selectedGroupId, { cursor: request.cursor }, request.signal);
        if (!activityPageScope.current.isCurrent(request) || activityScopeKeyRef.current !== request.key || activityCursorRef.current !== request.cursor) return;
        activityCursorRef.current = page.nextCursor;
        setItems((current) => appendUniquePage(current, page.activity, (item) => `${item.type}:${item.id}`)); setCursor(page.nextCursor);
      } catch (cause) {
        if (activityPageScope.current.isCurrent(request) && !(cause instanceof DOMException && cause.name === 'AbortError')) setPageError(cause);
      }
      finally { if (activityPageScope.current.isCurrent(request)) setLoadingMore(false); }
    };
  const typeLabel = (type: ActivityItem['type']) => ({ expense: 'Expense', settlement: 'Settlement', expense_revision: 'Expense edited', settlement_revision: 'Settlement edited', expense_deleted: 'Expense deleted', settlement_deleted: 'Settlement deleted' })[type];
  const titleFor = (item: ActivityItem) => item.type.startsWith('settlement') ? `${item.fromName || 'Unknown member'} paid ${item.toName || 'unknown member'}` : item.label || 'Expense';
  const descriptionFor = (item: ActivityItem) => item.type.startsWith('settlement') ? (item.label || '') : item.label || '';
  const dateFor = (item: ActivityItem) => item.transactionDate || item.createdAt.slice(0, 10);
  const row = (item: ActivityItem) => <span><strong>{titleFor(item)}</strong><small>{item.groupName ? `${item.groupName} · ` : ''}{typeLabel(item.type)} · {dateFor(item)}</small>{descriptionFor(item) && descriptionFor(item) !== titleFor(item) ? <small className="activity-description">{descriptionFor(item)}</small> : null}</span>;
  const itemRow = (item: ActivityItem) => {
    const content = <>{row(item)}{item.amountMinor != null && item.currency ? <Money amountMinor={item.amountMinor} currency={item.currency} /> : null}</>;
       const path = transactionActivityPath(item.groupId, item);
      return path ? <Link className="row" to={path} key={`${item.type}-${item.id}`}>{content}</Link> : <div className="row" key={`${item.type}-${item.id}`}>{content}</div>;
  };
      return <Layout><div className="page-title"><div><p className="eyebrow">Authorized groups</p><h1>Activity</h1></div></div><div className="activity-filter reading-width"><Field label="Filter by group"><select aria-label="Filter activity by group" value={selectedGroupId || ''} onChange={(event) => { const next = new URLSearchParams(searchParams); if (event.target.value) next.set('group', event.target.value); else next.delete('group'); setSearchParams(next); }}><option value="">All groups</option>{(groupsResource.data?.groups || []).map((group) => <option value={group.id} key={group.id}>{group.memberCount === 2 && group.counterpartName ? group.counterpartName : group.name}</option>)}</select></Field></div>{!online || activity.offline ? <p className="offline-banner" role="status">Offline · showing cached activity; this is only the first cached page.</p> : null}{me.error && activity.data !== undefined ? <CachedIdentityNotice resource={me} id="activity-identity-error" /> : null}{me.error && activity.data === undefined ? <ErrorBox error={me.error} onRetry={retryFor(resourceKeys.identity(), '')} id="activity-identity-error" retryLabel="Retry identity check" /> : null}{!me.error || activity.data !== undefined ? <ResourceNotice resource={activity} label="activity" retry={retryFor(resourceKeys.activity(me.data?.id || 'pending', selectedGroupId || 'all'), me.data?.id)} /> : null}{activity.data !== undefined && (items.length || cursor) ? <div className="list reading-width">{items.map(itemRow)}{cursor ? <Button type="button" variant="secondary" disabled={loadingMore || !online} onClick={() => void loadMore()}>{loadingMore ? 'Loading…' : 'Load more activity'}</Button> : null}</div> : activity.data !== undefined ? <Empty>No activity yet.</Empty> : null}{pageError ? <ErrorBox error={pageError} id="activity-page-error" /> : null}</Layout>;
}

function LegacyActivityRedirect() {
  const { id = '' } = useParams();
  return <Navigate to={`/activity?group=${encodeURIComponent(id)}`} replace />;
}

function Settings() {
  const connection = useConnectionState();
  const lifecycle = useAuthLifecycle();
  const online = connection.status === 'connected' && lifecycle.status === 'authenticated';
  const [outbox, setOutbox] = useState<ExpenseOutboxItem[]>(getOutboxSnapshot());
  const [outboxReady, setOutboxReady] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState<unknown>();
  const [logoutError, setLogoutError] = useState<unknown>();
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState('');
  const [exportError, setExportError] = useState<unknown>();
  const [deletionConfirmation, setDeletionConfirmation] = useState('');
   const [deletingAccount, setDeletingAccount] = useState(false);
   const [accountDeletionMessage, setAccountDeletionMessage] = useState('');
   const [accountDeletionError, setAccountDeletionError] = useState<unknown>();
   const [accountDeletionNotice, setAccountDeletionNotice] = useState(false);
  const exportController = useRef<AbortController>();
  const { signOut } = useClerk();
   const { user: clerkUser } = useUser();
   const { isLoaded: clerkLoaded, isSignedIn, userId } = useAuth();
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

  const removeAccount = async (event: FormEvent) => {
    event.preventDefault();
    if (!online || clearing || exporting || deletingAccount || deletionConfirmation !== ACCOUNT_DELETION_CONFIRMATION) return;
    setDeletingAccount(true); setAccountDeletionMessage(''); setAccountDeletionError(undefined);
    try {
       if (!clerkUser?.id || !userId || clerkUser.id !== userId) throw new Error('Clerk is still loading this account. Retry account deletion when the identity is available.');
       await deleteAccount(clerkUser.id);
       const result = await completePendingAccountDeletion(clerkUser, signOut, { clerkEvidence: { isLoaded: clerkLoaded === true, isSignedIn, userId } });
       if (result.clerkStatus === 'unsupported') { setAccountDeletionMessage('BillSplit data was deleted. This installed Clerk client cannot delete the Clerk account; manage that account separately.'); setAccountDeletionNotice(true); }
      else window.location.assign('/');
    } catch (cause) {
      setAccountDeletionError(cause);
    } finally { setDeletingAccount(false); setDeletionConfirmation(''); }
  };

  const exportAccount = async () => {
    if (!online || exporting) return;
    setExporting(true); setExportError(undefined); setExportProgress('Starting…');
    const abort = new AbortController(); exportController.current = abort;
    try {
      const groups = await collectPagedAccountExport(async (groupCursor, signal) => {
        const page = await getExportPage({ limit: 2, groupCursor }, signal);
        return { groups: page.groups, nextCursor: page.nextCursor };
      }, abort.signal, (count) => setExportProgress(`Fetched account export page ${count}`));
      await saveDownload(new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), groups })], { type: 'application/json' }), 'billsplit-account.json');
    } catch (cause) { if (!(cause instanceof DOMException && cause.name === 'AbortError')) setExportError(cause); else setExportProgress('Cancelled'); }
    finally { exportController.current = undefined; setExporting(false); }
  };

  return <Layout>
    <div className="page-title"><div><p className="eyebrow">More</p><h1>Settings</h1></div></div>
    <section><h2>Device</h2><p className="muted" role="status">{connectionStatusLabel(connection.status)} · {outbox.length ? `${outbox.length} expense${outbox.length === 1 ? '' : 's'} pending` : 'No expenses pending'}</p><InstallAction showStatus /></section>
    <section><h2>Pending expenses</h2>{outbox.length ? <div className="list">{outbox.map((item) => <div className="row" key={item.clientOperationId}><span>{item.display.description}<small>{statusLabel(item.status, item.deliveryUncertain)}</small></span><strong>{item.display.currency} {(item.display.amountMinor / 100).toFixed(2)}</strong></div>)}</div> : <p className="muted">New expenses sync automatically when you are online and signed in.</p>}</section>
     <section><h2>Trusted-device offline access</h2><p className="muted">After a verified visit, this browser keeps a private copy of your identity and recent group data so you can capture new expenses offline. It never stores a Clerk token, and replay still requires an active Clerk session. Only use this on a device you trust.</p></section>
     <section><h2>Local data</h2><p className="muted">Clear cached identity, groups, snapshots, and recent preferences without deleting pending or uncertain outbox expenses. Resolve those from the queue controls before removing them.</p><Button variant="secondary" disabled={clearing} onClick={() => void clearCache}>{clearing ? 'Clearing…' : 'Clear cached data'}</Button>{message ? <p className="muted" role="status">{message}</p> : null}{error ? <ErrorBox error={error} /> : null}</section>
        <section><h2>Account export</h2><p className="muted">Download all groups and their transactions as paged JSON. This is online-only, bounded per request, and can be cancelled before the file is written.</p><div className="actions"><Button type="button" variant="secondary" disabled={!online || exporting || clearing} onClick={() => void exportAccount}>{exporting ? 'Exporting account…' : 'Export account JSON'}</Button>{exporting ? <Button type="button" variant="danger" onClick={() => exportController.current?.abort()}>Cancel</Button> : null}</div>{exportProgress ? <p className="cache-status" role="status">{exportProgress}</p> : null}{exportError ? <ErrorBox error={exportError} id="account-export-error" /> : null}</section>
         <section><h2>Account</h2><p className="muted">Logging out clears all local account data and pending expenses before Clerk ends the session.</p>{logoutError ? <div className="error" id="logout-error" role="alert" aria-live="assertive"><strong>Logout was not completed.</strong> <span>{errorText(logoutError)}</span></div> : null}<Button variant="danger" disabled={!outboxReady || clearing || exporting || deletingAccount} onClick={() => void logout}>{outboxReady ? clearing ? 'Clearing local data…' : 'Log out' : 'Checking pending expenses…'}</Button></section>
     <section aria-labelledby="delete-account-heading"><h2 id="delete-account-heading">Delete BillSplit account</h2><p className="muted">This permanently removes your BillSplit personal identity, leaves active non-owned groups, revokes pending invitations, and clears private preferences. Financial rows, revisions, and audit name snapshots are retained so shared ledgers remain referentially intact.</p><p className="muted">You must transfer ownership or delete every active group you own first. Type <strong>{ACCOUNT_DELETION_CONFIRMATION}</strong> to continue. This action is online-only.</p><form onSubmit={removeAccount} aria-describedby={accountDeletionError ? 'account-deletion-error' : 'account-deletion-help'}><Field label="Typed confirmation"><input aria-describedby={accountDeletionError ? 'account-deletion-error' : 'account-deletion-help'} aria-invalid={Boolean(accountDeletionError)} required value={deletionConfirmation} onChange={(event) => { setDeletionConfirmation(event.target.value); setAccountDeletionError(undefined); }} /><span id="account-deletion-help" className="muted">Exact text required: {ACCOUNT_DELETION_CONFIRMATION}</span></Field>{accountDeletionError ? <ErrorBox error={accountDeletionError} id="account-deletion-error" /> : null}<Button type="submit" variant="danger" disabled={!online || !clerkUser?.id || clearing || exporting || deletingAccount || deletionConfirmation !== ACCOUNT_DELETION_CONFIRMATION}>{deletingAccount ? 'Deleting account…' : 'Delete BillSplit account'}</Button></form>{accountDeletionMessage ? <p className="muted" role="status">{accountDeletionMessage}</p> : null}</section>
   </Layout>;
}

function LegacyScheduledExpenseRedirect() {
  const { id = '' } = useParams();
  return <Navigate to={{ pathname: `/groups/${id}/expense/new`, search: '?recurrence=1' }} replace />;
}

function PrivateRoutes() {
  const identityEpoch = useResourceIdentityEpoch();
  return <Routes key={identityEpoch}><Route path="/" element={<Home />} /><Route path="/settings" element={<Settings />} /><Route path="/activity" element={<Activity />} /><Route path="/expense/new" element={<ExpenseForm />} /><Route path="/groups/:id" element={<GroupOverview />} /><Route path="/groups/:id/transactions" element={<TransactionHistoryPage />} /><Route path="/groups/:id/manage" element={<GroupManagementPage />} /><Route path="/groups/:id/expense/new" element={<ExpenseForm />} /><Route path="/groups/:id/expense/:expenseId" element={<ExpenseForm />} /><Route path="/groups/:id/scheduled-expense/new" element={<LegacyScheduledExpenseRedirect />} /><Route path="/groups/:id/scheduled-expense/:scheduledExpenseId" element={<ExpenseForm />} /><Route path="/groups/:id/expenses/:expenseId" element={<ExpenseDetail />} /><Route path="/expenses/:expenseId" element={<ExpenseDetail />} /><Route path="/groups/:id/settle" element={<Settle />} /><Route path="/groups/:id/settlements/:settlementId" element={<SettlementDetail />} /><Route path="/groups/:id/activity" element={<LegacyActivityRedirect />} /><Route path="*" element={<Navigate to="/" replace />} /></Routes>;
}

export function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const { isLoaded, isSignedIn, userId, sessionId } = useAuth();
  const { signOut } = useClerk();
  const { user: clerkUser } = useUser();
  const auth = useSyncExternalStore(subscribeAuthLifecycle, getAuthLifecycle, () => ({ status: 'checking' as const }));
  const logoutInProgress = useSyncExternalStore(subscribeSessionState, getSessionLogoutInProgress, () => false);
  const clerkSessionRef = useRef<string>();
  const previousOnlineRef = useRef<boolean>();
  const previousClerkEvidenceRef = useRef<string>();
  const connection = useConnectionState();
  const online = connection.status === 'connected';
  const offline = connection.status === 'offline';
   const [pendingDeletion, setPendingDeletion] = useState(hasPendingAccountDeletion);
   const [pendingDeletionError, setPendingDeletionError] = useState<unknown>();
   const [pendingDeletionRetry, setPendingDeletionRetry] = useState(0);
   const [accountDeletionNotice, setAccountDeletionNotice] = useState(false);
  useEffect(() => {
    const onGroupRevoked = (event: Event) => {
      const groupId = (event as CustomEvent<{ groupId?: string }>).detail?.groupId;
      if (groupId && getNavigationContext(location.pathname).groupId === groupId) navigate('/', { replace: true });
    };
    window.addEventListener('billsplit-group-revoked', onGroupRevoked);
    return () => window.removeEventListener('billsplit-group-revoked', onGroupRevoked);
  }, [location.pathname, navigate]);
   const retryPendingDeletion = () => { setPendingDeletionError(undefined); setPendingDeletion(true); setPendingDeletionRetry((value) => value + 1); };
   const discardInvalidDeletionMarker = () => {
      if (!discardInvalidPendingAccountDeletion()) return;
      setPendingDeletionError(undefined);
      setPendingDeletion(false);
   };
   const finishExternalProviderCleanup = () => {
     const phase = getPendingAccountDeletionPhase();
     if (phase !== 'server-deleted' && phase !== 'local-cleared') return;
     if (!confirm('This only clears BillSplit data remaining in this browser. It does not delete or manage your Clerk account. Continue because the original Clerk account was deleted elsewhere?')) return;
     setPendingDeletionError(undefined);
     void finishLocalCleanupAfterExternalProviderDeletion({ confirmed: true, clerkEvidence: { isLoaded: isLoaded === true, isSignedIn, ...(userId ? { userId } : {}) } }).then(() => {
       setPendingDeletion(false);
       window.location.assign('/');
     }).catch((cause) => setPendingDeletionError(cause));
   };
  useEffect(() => {
    const onPending = () => setPendingDeletion(true);
    window.addEventListener('billsplit-account-deletion-pending', onPending);
    return () => window.removeEventListener('billsplit-account-deletion-pending', onPending);
  }, []);
  useEffect(() => {
    if (!pendingDeletion || !isLoaded || isSignedIn === undefined || (isSignedIn === true && !clerkUser)) return;
    let active = true;
   void (async () => {
       return completePendingAccountDeletion(clerkUser, signOut, { clerkEvidence: { isLoaded: isLoaded === true, isSignedIn, ...(userId ? { userId } : {}) } });
     })().then((result) => {
      if (!active) return;
        if (result.clerkStatus === 'signed-out') {
          setPendingDeletion(true);
          setPendingDeletionError(undefined);
        } else if (result.clerkStatus === 'unsupported') {
          setPendingDeletion(false);
          setPendingDeletionError(undefined);
          setAccountDeletionNotice(true);
        } else {
         setPendingDeletion(false);
         window.location.assign('/');
       }
    }).catch((cause) => { if (active) setPendingDeletionError(cause); });
    return () => { active = false; };
   }, [clerkUser, isLoaded, isSignedIn, pendingDeletion, pendingDeletionRetry, signOut, userId]);
  useEffect(() => {
    // Clerk owns restoration. The coordinator starts its bounded deadline;
    // the old `!isLoaded && !online` branch must never gate it, and this is
    // the only code path from React which can request an auth probe.
    if (pendingDeletion || (!shouldStartAuthCheck(online, isLoaded) && !isDevelopmentAuthBypass)) return;
    const sessionKey = userId && sessionId ? `${userId}:${sessionId}` : undefined;
    const currentClerkUserId = typeof userId === 'string' ? userId : undefined;
    const clerkEvidence = `${isLoaded}:${isSignedIn}:${currentClerkUserId || ''}:${sessionId || ''}`;
    const connectivityChanged = previousOnlineRef.current !== undefined && previousOnlineRef.current !== online;
    const clerkEvidenceChanged = previousClerkEvidenceRef.current !== undefined && previousClerkEvidenceRef.current !== clerkEvidence;
    previousOnlineRef.current = online;
    previousClerkEvidenceRef.current = clerkEvidence;
    // A failed verification is stable UI, not a reason to immediately start
    // another request when the effect rerenders. Explicit retry and the
    // evidence/connectivity listeners below are the retry edges.
    if (auth.status === 'verification-unavailable' && !connectivityChanged && !clerkEvidenceChanged) return;
    if (auth.status === 'unauthenticated' && !connectivityChanged && !clerkEvidenceChanged) return;
    const completeAccountMismatch = Boolean(isLoaded && isSignedIn === true && currentClerkUserId && getVerifiedClerkUserId() && currentClerkUserId !== getVerifiedClerkUserId());
    // Session rotation for the same Clerk user is a reverify, not an
    // account switch. Only complete positive user-ID mismatch is destructive.
    if (online && completeAccountMismatch) resetForClerkSessionChange();
    else if (offline && completeAccountMismatch) revokeForClerkSessionChange();
    if (isSignedIn && sessionKey) clerkSessionRef.current = sessionKey;
    if (!isDevelopmentAuthBypass && isDefinitivelySignedOut(isLoaded === true, isSignedIn)) {
      clerkSessionRef.current = undefined;
      void coordinateAuthBootstrap({ isLoaded: true, isSignedIn: false });
      return;
    }
    if (!(completeAccountMismatch && offline)) void coordinateAuthBootstrap({ isLoaded: isLoaded === true, isSignedIn, ...(currentClerkUserId ? { userId: currentClerkUserId } : {}), ...(sessionId ? { sessionId } : {}) }, { ...((connection.status === 'checking' || clerkEvidenceChanged && (shouldReverifyTrustedOffline(online, isLoaded === true, isSignedIn === true, auth.status) || auth.status === 'authenticated')) ? { networkOnly: true } : {}), route: { pathname: location.pathname, search: location.search } });
    }, [auth.status, connection.status, isLoaded, isSignedIn, location.pathname, location.search, offline, online, pendingDeletion, sessionId, userId]);
  const returnTo = `${location.pathname}${location.search}${location.hash}`;
    const sessionTransitionPending = Boolean(clerkSessionRef.current && userId && sessionId && clerkSessionRef.current !== `${userId}:${sessionId}`);
     const definitiveSignedOut = !isDevelopmentAuthBypass && isDefinitivelySignedOut(isLoaded === true, isSignedIn);
     const signOutRetryError = auth.status === 'unauthenticated' && auth.error instanceof Error && auth.error.name === 'ClerkSignOutFailure' ? auth.error : undefined;
     const retryVerification = () => void coordinateAuthBootstrap({ isLoaded: isLoaded === true, isSignedIn, ...(typeof userId === 'string' ? { userId } : {}), ...(sessionId ? { sessionId } : {}) }, { networkOnly: false, force: true, route: { pathname: location.pathname, search: location.search } });
    const cachedAuthLifecycle = auth.status === 'provisional' || auth.status === 'trusted-offline';
    const privateCacheRouteMatches = isPrivateCacheRouteCurrent(auth, location.pathname, location.search);
    const incompleteLoadedSignedInEvidence = isIncompleteLoadedSignedInEvidence(isLoaded === true, isSignedIn, userId || undefined, sessionId || undefined);
   // Clerk can expose B's user before it exposes B's session.  Do not render
   // A's private tree during that partial transition; the coordinator also
   // evicts A and revokes its offline trust in the same evidence epoch.
   const knownClerkIdentityMismatch = Boolean(isLoaded && isSignedIn === true && userId && getVerifiedClerkUserId() && userId !== getVerifiedClerkUserId());
   const retainedPrivateView = hasRetainedPrivateSession(incompleteLoadedSignedInEvidence ? undefined : (userId || undefined));
  // An authoritative /api/me response is sufficient for the live identity;
  // durable trust is an optional offline capability, not a second Loading
  // gate (a bounded IDB write may fail without invalidating the session).
  const authoritativeClerkIdentityReady = isDevelopmentAuthBypass || (auth.status === 'authenticated' && Boolean(userId) && getVerifiedClerkUserId() === userId) || (auth.status === 'trusted-offline' && !incompleteLoadedSignedInEvidence && (!userId || getTrustedOfflineClerkUserId() === userId));
   if (pendingDeletion) {
     const pendingPhase = getPendingAccountDeletionPhase();
     const pendingIdentity = getPendingAccountDeletionClerkUserId();
     const signedInToDifferentAccount = Boolean(isSignedIn && userId && pendingIdentity && userId !== pendingIdentity);
     const canSignInToRecover = pendingPhase === 'server-pending' || pendingPhase === 'server-deleted' || pendingPhase === 'local-cleared';
      return <PublicShell showAuthActions={false}><div className="public-status" aria-live="polite"><h1>Finishing account deletion…</h1><p className="muted">Private data will not be restored while this identity-bound deletion is pending.</p>{signedInToDifferentAccount ? <><p className="muted">This browser is signed in to a different Clerk account. Sign out, then sign in to the original account to continue.</p><Button type="button" variant="secondary" onClick={() => void signOut({ redirectUrl: '/' })}>Sign out this account</Button></> : canSignInToRecover && isLoaded && isSignedIn === false ? <><p className="muted">Sign in to the same Clerk account that started deletion. BillSplit data is already cleared; provider deletion will not be claimed until that account is verified.</p><SignInButton mode="modal" fallbackRedirectUrl={returnTo}><button className="button" type="button">Sign in to finish deletion</button></SignInButton>{pendingPhase !== 'server-pending' ? <><p className="muted">If that original Clerk account was deleted elsewhere, you may finish local cleanup here. This does not delete or manage Clerk.</p><Button type="button" variant="secondary" onClick={finishExternalProviderCleanup}>Finish local cleanup</Button></> : null}</> : null}{pendingDeletionError ? <><ErrorBox error={pendingDeletionError} id="account-deletion-recovery-error" />{hasInvalidPendingAccountDeletion() ? <Button type="button" variant="secondary" onClick={discardInvalidDeletionMarker}>Discard invalid recovery marker</Button> : <Button type="button" variant="secondary" onClick={retryPendingDeletion}>Retry cleanup</Button>}</> : <Loading />}</div></PublicShell>;
     }
     if (logoutInProgress) return <PublicShell returnTo={returnTo}><div className="public-status" aria-live="polite"><p className="muted">Signing out securely…</p></div></PublicShell>;
    // Clerk's loaded signed-out evidence is synchronous input to this render.
    // Do not wait for the coordinator effect before masking a private tree.
    // A failed provider sign-out has an explicit retry lifecycle and must keep
    // its existing error UI instead of being replaced by this fast path.
    if (signOutRetryError) return <PublicLanding logoutError={signOutRetryError} accountDeletionNotice={accountDeletionNotice} />;
    if (definitiveSignedOut) return <PublicLanding accountDeletionNotice={accountDeletionNotice} />;
    if (knownClerkIdentityMismatch) return <PublicShell returnTo={returnTo}><div className="public-status" aria-live="polite"><Loading /></div></PublicShell>;
   if (auth.status === 'checking') return <PublicShell returnTo={returnTo}><div className="public-status" aria-live="polite"><Loading /></div></PublicShell>;
  // Clerk can report signed-in before it has supplied both pieces of
  // session evidence. Keep the private route tree out of that bounded window
  // even if a previously trusted offline lifecycle is still visible.
  if (incompleteLoadedSignedInEvidence && auth.status !== 'verification-unavailable') {
    if (!retainedPrivateView) return <PublicShell returnTo={returnTo}><div className="public-status" aria-live="polite"><Loading /></div></PublicShell>;
  }
   if (auth.status === 'unauthenticated') return <PublicLanding logoutError={auth.error instanceof Error && auth.error.name === 'ClerkSignOutFailure' ? auth.error : undefined} accountDeletionNotice={accountDeletionNotice} />;
   if (cachedAuthLifecycle && location.pathname !== '/settings' && !privateCacheRouteMatches) {
     // A previous route's cache contract is never valid for this location.
     // Keep this synchronous guard ahead of PrivateRoutes while the new route
     // restore is in flight; an unspecified contract is fail-closed.
     if (!auth.privateCacheRouteKey) return <PrivateCacheUnavailable onRetry={retryVerification} />;
     return <PublicShell returnTo={returnTo}><div className="public-status" aria-live="polite"><Loading /></div></PublicShell>;
   }
   if (cachedAuthLifecycle && location.pathname !== '/settings' && auth.privateCacheAvailable === undefined) return <PublicShell returnTo={returnTo}><div className="public-status" aria-live="polite"><Loading /></div></PublicShell>;
   if (cachedAuthLifecycle && auth.privateCacheAvailable === false) return <PrivateCacheUnavailable onRetry={retryVerification} />;
   if (auth.status === 'verification-unavailable') return <VerificationUnavailable onRetry={retryVerification} />;
  if ((auth.status === 'restoring' || auth.status === 'reverifying') && !retainedPrivateView) return <PublicShell returnTo={returnTo}><div className="public-status" aria-live="polite"><Loading /></div></PublicShell>;
  if (auth.status === 'authenticated' && (sessionTransitionPending || !authoritativeClerkIdentityReady)) return <PublicShell returnTo={returnTo}><div className="public-status" aria-live="polite"><Loading /></div></PublicShell>;
  return <PrivateRoutes />;
}
