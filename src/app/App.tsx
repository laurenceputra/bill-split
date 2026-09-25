import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { SignInButton, SignUpButton, useAuth, useClerk, useUser } from '@clerk/react';
import type { Activity as ActivityItem, AuditDisclosureEvent, Balances, Currency, Credit, Expense, Group, GroupInvitation, GroupMember, GroupResponse, GroupSplitDefault, HistoricalParticipant, RecurrenceFrequency, ScheduledExpense, ScheduledExpenseStatus, Settlement, SpendingInsightSummaryResponse, SpendingInsightTrends, SplitMethod, Transaction, Weekday } from '../shared/types';
import { deleteCredit, getCreditDetails, restoreCredit } from './api';
import { currencyOptions, groupSplitDefaultInput, scheduledExpenseInput, type ExpenseInput, type ScheduledExpenseInput } from '../shared/schemas';
import { checkedSumMinor, formatMoney, parseMoney } from '../domain/money';
import { acceptInvitation, ApiError, api, changeScheduledExpenseStatus, completePendingAccountDeletion, convertNamedToPeerGroup, convertPeerToNamedGroup, coordinateAuthBootstrap, createFriend, createGroup, createGroupInvitation, createTargetedGroupInvitation, createScheduledExpense, deleteAccount, deleteGroup, deleteGroupSplitDefault, discardInvalidPendingAccountDeletion, finalizeSuccessfulClerkSignOut, finishLocalCleanupAfterExternalProviderDeletion, getActivity, getActivityPage, getAuditEntityPage, getAuthLifecycle, getBalances, getCategories, getCategorySuggestion, getConnectionState, getExpenseDetails, getExportPage, getGlobalTransactionPage, getGroup, getGroupCsvExportPage, getGroupExportPage, getGroupSettlementCsvExportPage, getGroups, getMe, getOwnerInvitations, getPendingAccountDeletionClerkUserId, getPendingAccountDeletionPhase, getPendingInvitations, getScheduledExpense, getScheduledExpensePage, getScheduledExpenses, getSettlementDetails, getSpendingInsightSummary, getSpendingInsightTrends, getTransactionPage, hasInvalidPendingAccountDeletion, hasPendingAccountDeletion, hasRetainedPrivateSession, hydrateActivity, hydrateBalances, hydrateCategories, hydrateExpenseDetails, hydrateGlobalTransactions, hydrateGroup, hydrateGroups, hydrateIdentity, hydrateTransactionOverview, hydrateTransactions, isPrivateCacheRouteCurrent, leaveGroup, recordSessionActivity, rejectInvitation, removeGroupMember, restoreExpense, restoreSettlement, revokeAllApplicationSessions, revokeApplicationSession, revokeForClerkSessionChange, revokeGroupInvitation, resetForClerkSessionChange, transferGroupOwnership, updateDisplayName, updateGroup, updateGroupSplitDefault, updateScheduledExpense, updateSettlement, getTrustedOfflineClerkUserId, getVerifiedClerkUserId, getVerifiedUserId, isDefinitivelySignedOut, isDevelopmentAuthBypass, isIncompleteLoadedSignedInEvidence, recoverAfterClerkSignOutFailure, shouldReverifyTrustedOffline, shouldStartAuthCheck, subscribeAuthLifecycle, clearEverythingForLogout } from './api';
import { ACCOUNT_DELETION_CONFIRMATION } from '../shared/schemas';
import { allocationMetadataByPerson, allocationSplits, allocationStateFromSplits, amountFieldClass, amountInputClass, amountInputLength, currentPayerSelection, effectiveGroupSplitDefault, formServerVersion, groupSplitDefaultFromDraft, groupSplitDefaultSummary, hasNewerServerVersion, isCurrentSplitDefaultSave, isExpenseConflict, isSplitDefaultSaveLockedForScope, manuallySetSettlementEditAmount, neutralAllocationPreview, normalizeSinglePayer, previewAllocation, releaseSplitDefaultSaveLock, resolveGroupSplitDefault, settlementAmountForPair, settlementEditAmountState, settlementSuggestion, settlementSuggestionFingerprint, settlementSuggestionForPair, splitDefaultChoiceState, splitDefaultSaveOutcome, transitionSettlementEditAmount, type AllocationState, type FormSaveFence, type SettlementEditAmountState } from './form-helpers';
import { ActionGroup, AuthLoadingShell, Avatar, AvatarStack, Button, Disclosure, EmptyState, Field, FormSurface, InstallAction, Layout, LedgerList, LedgerRow, MacroSection, Modal, Money, PageHeader, PublicShell, ResourceState, SectionHeader, Skeleton, SplitTransactionControl, Status, Surface, connectionStatusLabel, useAuthLifecycle, useConnectionState, useOnlineStatus } from './ui';
import { discardOutboxItem, enqueueExpense, flushOutbox, getOutboxSnapshot, initializeOutbox, retryOutboxItem, statusLabel, subscribeOutbox, type ExpenseOutboxItem } from './outbox';
import { clearCachedData } from './idb';
import { applyConfirmedGroup, getResourceSnapshot, invalidateForMutation, invalidateResource, revalidate, RESOURCE_FRESHNESS, resourceKeys, resourceViewState, useResource, useResourceIdentityEpoch, type ResourceSnapshot } from './resource-cache';
import { balanceStatus, groupBalanceDisplays, personalBalances } from './group-balance';
import { creditDetailPath, expenseDetailPath, getNavigationContext, getTransactionNavigation, settlementDetailPath, transactionActivityPath } from './navigation';
import { broadcastSessionCoordination, captureSessionGeneration, getSessionLogoutInProgress, isSessionGenerationCurrent, subscribeSessionState } from './session';
import { browserTimezone, formatScheduleDate, otherTimezoneValue, previewScheduleDates, scheduleContinuationText, scheduleOverviewMetadata, scheduleSummary, timezoneLabel, timezoneOptions, timezoneSelectValue as timezoneSelectValueForState, timezoneValueFromSelection, weekdayLabels } from './scheduled-expense';
import { categoryOptions } from './categories';
import { sortOptionsByLabel } from './dropdown-options';
import { localDateForTimeZone } from '../domain/recurrence';
import { appendUniquePage, createPageRequestScope } from './pagination';
import { assembleCsvPages, collectPagedAccountExport, collectPagedExport, collectPagedGroupExport } from './export';
import { hasTransactionFilters, readTransactionFilters, transactionFilterCount, transactionFilterKey, writeTransactionFilters, type TransactionFilters } from './transaction-filters';
import { transactionCategory, transactionContext, transactionDate, transactionKey, transactionNote, transactionPeople, transactionTitle, transactionTypeLabel } from './transaction-ui';
import { expenseRefundSummary, refundActionLabel } from './expense-detail';
import { groupDisplayName, groupManagementKind } from './group-display';
import { createSessionActivityScheduler } from './session-activity';
import { getGroupCreditCsvExportPage } from './api';
import { localBrowserDate } from './credit-form';
import { categoryTrendStatus, effectiveInsightCurrency, insightActivitySpanText, insightCategoryColor, insightComparisonDateRange, insightCurrencies, insightDisplayedTrendMonths, insightTrendBarHeight, insightTrendDateRange, insightTrendMaximum, insightTrendMonthLabel, insightTrendMonths, insightTrendReferenceLabel, insightTrendValue, readInsightFilters, topCategoryTrends, validInsightRange, type InsightFilters } from './spending-insights';
import { RefundCreateRoute, RefundEditRoute } from './refund-form';

const today = () => localBrowserDate();
const operationId = () => crypto.randomUUID();
const errorText = (error: unknown) => error instanceof ApiError && error.networkFailure ? (error.reconnectRequired ? 'Connection issue. Retry when the connection is available; your pending expense remains retryable.' : 'You appear to be offline. Only new expenses can be queued; edits, deletes, settlements, and membership changes require a connection.') : error instanceof Error ? error.message : 'Something went wrong';
function Loading() { return <ResourceState state="loading" className="muted">Loading…</ResourceState>; }
function HomeLoadingPlaceholder() {
  return <div className="route-loading route-loading--home">
    <div className="route-loading__visual" aria-hidden="true">
      <div className="ui-page-header"><div className="route-loading__title"><Skeleton className="skeleton--eyebrow" /><Skeleton className="skeleton--title" /></div><div className="route-loading__actions"><Skeleton /><Skeleton /></div></div>
      <div className="route-loading__cards"><div className="route-loading__card"><div className="route-loading__card-copy"><Skeleton className="skeleton--line" /><Skeleton className="skeleton--line-short" /></div><div className="route-loading__card-side"><Skeleton className="skeleton--line" /><Skeleton className="skeleton--line-short" /></div></div><div className="route-loading__card"><div className="route-loading__card-copy"><Skeleton className="skeleton--line" /><Skeleton className="skeleton--line-short" /></div><div className="route-loading__card-side"><Skeleton className="skeleton--line" /><Skeleton className="skeleton--line-short" /></div></div></div>
    </div>
    <p className="auth-loading-status" role="status" aria-live="polite">Loading groups…</p>
  </div>;
}
function GroupOverviewLoadingPlaceholder() {
  return <div className="route-loading route-loading--group">
    <div className="route-loading__visual" aria-hidden="true">
      <Skeleton className="skeleton--back" />
       <div className="ui-page-header"><div className="route-loading__title"><Skeleton className="skeleton--title" /></div><div className="route-loading__actions route-loading__actions--expense"><Skeleton /><Skeleton /></div></div>
      <section className="route-loading__section"><Skeleton className="route-loading__section-title" /><div className="route-loading__balances"><div className="route-loading__balance"><Skeleton className="skeleton--line" /><Skeleton className="skeleton--amount" /></div><div className="route-loading__balance"><Skeleton className="skeleton--line" /><Skeleton className="skeleton--amount" /></div><div className="route-loading__balance"><Skeleton className="skeleton--line" /><Skeleton className="skeleton--amount" /></div></div></section>
      <section className="route-loading__section"><Skeleton className="route-loading__section-title" /><Skeleton className="skeleton--row" /><Skeleton className="skeleton--row" /><Skeleton className="skeleton--row" /></section>
    </div>
    <p className="auth-loading-status" role="status" aria-live="polite">Loading group…</p>
  </div>;
}
function GroupOverviewUnavailable({ connectionStatus }: { connectionStatus: ReturnType<typeof useConnectionState>['status'] }) {
  const offline = connectionStatus === 'offline';
  return <EmptyState title={offline ? 'Group unavailable offline' : 'Group unavailable'}><p className="muted">{offline ? 'This group is not cached on this device. Reconnect to load it.' : 'This group is unavailable while the connection is being checked or repaired. Reconnect to load it.'}</p><Link className="back" to="/">← Groups</Link></EmptyState>;
}
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
    try { await signOut({ redirectUrl: '/' }); finalizeSuccessfulClerkSignOut(); }
    catch (cause) { recoverAfterClerkSignOutFailure(cause); setRetryingSignOut(false); }
  };
  return <PublicShell returnTo={returnTo}>
    <div className="landing-page">
       <section className="landing-hero" aria-labelledby="landing-title">
        <div className="landing-hero__copy"><p className="eyebrow">Private shared expenses</p><h1 id="landing-title">Know who paid. Know what is still owed.</h1><p className="landing-lede">BillSplit keeps shared expenses clear for friends, trips, and households—without making you do the math twice.</p><div className="landing-actions"><SignInButton mode="modal" fallbackRedirectUrl={returnTo}><button className="button landing-primary public-sign-in" type="button">Sign in securely</button></SignInButton><SignUpButton mode="modal" fallbackRedirectUrl={returnTo}><button className="button button--secondary" type="button">Sign up</button></SignUpButton><InstallAction label="Install BillSplit" /></div><p className="landing-privacy">Private by design · email verification codes · no advertising</p></div>
        <div className="ledger-preview" aria-hidden="true"><div className="ledger-preview__top"><span>Weekend away</span><span>USD</span></div><div className="ledger-preview__row"><span>Alex paid dinner</span><strong>$84.00</strong></div><div className="ledger-preview__row"><span>Sam owes Alex</span><strong className="ledger-preview__positive">$28.00</strong></div><div className="ledger-preview__line" /><div className="ledger-preview__total"><span>Still owed</span><strong>$28.00</strong></div></div>
      </section>
      <section className="landing-proof" aria-label="Why BillSplit"><div><strong>Clear ledgers</strong><span>See payments, splits, and balances together.</span></div><div><strong>Less chasing</strong><span>Know the next fair payment at a glance.</span></div><div><strong>Works offline</strong><span>Capture a new expense when signal drops.</span></div></section>
        {logoutError ? <div className="error" role="alert"><strong>Logout needs another try.</strong> <span>{errorText(logoutError)}</span> <Button type="button" variant="secondary" disabled={retryingSignOut} onClick={() => void retrySignOut}>{retryingSignOut ? 'Retrying…' : 'Retry logout'}</Button></div> : null}{accountDeletionNotice ? <p className="cache-status" role="status">BillSplit data and local cleanup are complete. This Clerk client could not delete the Clerk account; manage that account separately.</p> : null}<section className="landing-note"><h2>Private, even when offline</h2><p>Your signed-in browser may keep recent group data and queued expenses locally for trusted-device offline use. Clerk session tokens are never stored by BillSplit, and syncing uses the server application session. Clear everything from Settings before handing off a device.</p></section>
    </div>
  </PublicShell>;
}
function ErrorBox({ error, id = 'resource-error', onRetry, retryLabel = 'Retry' }: { error: unknown; id?: string; onRetry?: () => void; retryLabel?: string }) {
  const connection = useConnectionState();
  return <div className="error ui-resource-state ui-resource-state--error" id={id} role="alert" aria-live="assertive"><span>{errorText(error)}</span>{onRetry && connection.status !== 'offline' ? <Button type="button" variant="secondary" onClick={onRetry}>{retryLabel}</Button> : null}</div>;
}
const connectionBannerLabel = (status: ReturnType<typeof useConnectionState>['status']) => status === 'checking' ? 'Checking connection' : status === 'connection-issue' ? 'Connection issue' : 'Offline';
function ConnectionBanner({ detail }: { detail: string }) {
  const connection = useConnectionState();
  const label = connectionBannerLabel(connection.status);
  return <p className={`offline-banner connection-banner connection-banner--${connection.status}`} role={connection.status === 'connection-issue' ? 'alert' : 'status'}>{label} · {detail}</p>;
}
function Empty({ children }: { children: ReactNode }) { return <EmptyState className="route-empty">{children}</EmptyState>; }
function retryFor<T>(key: string, userId: string | undefined, identityFailure = false, allowMissingUser = false) {
  return () => {
    if (identityFailure || key === resourceKeys.identity() || (userId === undefined && !allowMissingUser)) {
      void revalidate<T>(resourceKeys.identity(), '', { force: true, reason: 'auth-restored' }).catch(() => undefined);
    } else {
      void revalidate<T>(key, userId ?? '', { force: true, reason: 'route' }).catch(() => undefined);
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
const nameOf = (members: GroupMember[], id: string, fallback = 'Removed participant') => members.find((member) => member.personId === id)?.name || fallback;
const historicalParticipantName = (participant: HistoricalParticipant) => participant.status === 'deleted' ? `${participant.name} · Deleted account` : participant.status === 'removed' ? `${participant.name} · Removed` : participant.name;
const moneyInput = (minor: number) => (minor / 100).toFixed(2);
const isPendingInvitation = (invitation?: GroupInvitation) => Boolean(invitation && !invitation.revokedAt && !invitation.acceptedAt && !invitation.rejectedAt && Date.parse(invitation.expiresAt) > Date.now());
type TargetedInvitationMutationState = 'available' | 'checking' | 'unavailable';
const targetedInvitationMutationState = (resource: ResourceSnapshot<{ invitations: GroupInvitation[] }>): TargetedInvitationMutationState => resource.data === undefined ? resource.error ? 'unavailable' : 'checking' : resource.error ? 'unavailable' : resource.revalidating || resource.stale ? 'checking' : 'available';

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
  return <Surface className="invitations"><SectionHeader title="Pending invitations" description="Matched to your verified email" /><LedgerList label="Pending invitations">{invitations.map((invitation) => <LedgerRow key={invitation.id}><span><strong>{invitation.email}</strong><small>Expires {new Date(invitation.expiresAt).toLocaleDateString()}</small></span><ActionGroup className="actions"><Button type="button" disabled={!online || busyId === invitation.id} onClick={() => void respond(invitation, 'accept')}>{busyId === invitation.id ? 'Working…' : 'Accept'}</Button><Button type="button" variant="secondary" disabled={!online || busyId === invitation.id} onClick={() => void respond(invitation, 'reject')}>Reject</Button></ActionGroup></LedgerRow>)}</LedgerList>{error ? <ErrorBox error={error} id="invitation-response-error" /> : null}{!online ? <p className="muted">Invitation responses require a connection.</p> : null}</Surface>;
}

function InsightCurrencyMetrics({ summary, personal = false }: { summary: SpendingInsightSummaryResponse['summaries'][number]; personal?: boolean }) {
  return <div className="insight-metric"><span className="insight-metric__currency">{summary.currency} · {personal ? 'Your allocated share' : 'Total group spending'}</span><strong><Money amountMinor={personal ? summary.allocatedSpendMinor : summary.groupSpendMinor} currency={summary.currency} /></strong>{!personal ? <><span className="muted">Your share <Money amountMinor={summary.yourShareMinor} currency={summary.currency} /></span><span className="muted">You paid <Money amountMinor={summary.youPaidMinor} currency={summary.currency} /></span></> : null}<small>{summary.expenseCount} counted expense{summary.expenseCount === 1 ? '' : 's'}</small></div>;
}

function CompactInsights({ groupId, userId, title = 'Spending', global = false }: { groupId?: string; userId?: string; title?: string; global?: boolean }) {
  const online = useOnlineStatus();
  const scope = `${groupId || 'all'}:summary`;
  const resource = useResource<SpendingInsightSummaryResponse>(resourceKeys.insights(userId || 'pending', scope), userId, (signal) => getSpendingInsightSummary(groupId, {}, signal), RESOURCE_FRESHNESS.insights);
  const href = groupId ? `/activity?group=${encodeURIComponent(groupId)}&view=insights&period=all` : '/activity?view=insights&period=all';
  if (resource.data === undefined) {
    if (!online) return <MacroSection title={title} className="insights-compact"><p className="muted" role="status">Refresh is unavailable offline; cached spending data may be shown when available.</p></MacroSection>;
    if (resource.error) return <MacroSection title={title} className="insights-compact"><ErrorBox error={resource.error} onRetry={retryFor(resourceKeys.insights(userId || 'pending', scope), userId)} id={`${global ? 'global' : 'group'}-insights-error`} /></MacroSection>;
    return <MacroSection title={title} className="insights-compact"><Loading /></MacroSection>;
  }
  const summaries = resource.data.summaries;
  return <MacroSection title={title} className="insights-compact" actions={<Link className="inline-action" to={href}>View detailed insights</Link>}>{!online ? <p className="cache-status" role="status">Refresh is unavailable offline; showing cached spending data.</p> : resource.error || resource.offline ? <p className="cache-status" role="status">Showing the last confirmed spending aggregate; it may be out of date.</p> : null}{summaries.length ? <div className="insight-metrics" aria-label={`${title} by currency`}>{summaries.map((summary) => <InsightCurrencyMetrics key={summary.currency} summary={summary} personal={global} />)}</div> : <p className="muted">No counted expenses yet. Settlements and scheduled expenses are not spending.</p>}<p className="muted insight-disclosure">{global ? 'Your allocated split spending across active groups.' : 'Group spend uses expense totals; your share uses allocated splits.'} Pending offline expenses are excluded.</p></MacroSection>;
}

function GroupSettings({ group, groupId, userId, online, role, activeMemberCount, pendingGenericInvitation, conversionBusy = false, onConversionBusyChange, onDeleted, onLeft }: { group: Group; groupId: string; userId: string; online: boolean; role: 'owner' | 'member'; activeMemberCount: number; pendingGenericInvitation?: boolean; conversionBusy?: boolean; onConversionBusyChange?: (busy: boolean) => void; onDeleted: () => void; onLeft: () => void }) {
  const displayName = groupDisplayName(group);
  const managementKind = groupManagementKind(group);
  const [name, setName] = useState(managementKind === 'peer' ? '' : group.name);
  const [currency, setCurrency] = useState<Currency>(group.currency);
  const [busy, setBusy] = useState<'save' | 'delete' | 'leave' | 'convert'>();
  const [error, setError] = useState<unknown>();
  useEffect(() => { setName(managementKind === 'peer' ? '' : group.name); setCurrency(group.currency); }, [group.currency, group.name, managementKind]);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!online || busy || conversionBusy || !name.trim()) return;
    setBusy('save'); setError(undefined);
    try {
      await updateGroup(groupId, { name: name.trim(), currency });
      await invalidateForMutation.groupChanged(groupId, userId, captureSessionGeneration());
    } catch (cause) { setError(cause); }
    finally { setBusy(undefined); }
  };
  const remove = async () => {
    if (!online || busy || conversionBusy) return;
    const confirmation = window.prompt(`Type the group name exactly to delete “${displayName}”. This is a soft-delete and can be purged after 30 days.`, '');
    if (confirmation !== displayName) return;
    setBusy('delete'); setError(undefined);
    try {
      const generation = captureSessionGeneration();
      await deleteGroup(groupId);
      await invalidateForMutation.groupDeleted(groupId, userId, generation);
      onDeleted();
    } catch (cause) { setError(cause); setBusy(undefined); }
  };
  const leave = async () => {
    if (!online || busy || conversionBusy || !confirm(`Leave ${displayName}? You will lose access to this group. Historical transactions are retained for the group.`)) return;
    setBusy('leave'); setError(undefined);
    try { const generation = captureSessionGeneration(); await leaveGroup(groupId); await invalidateForMutation.groupLeft(groupId, userId, generation); onLeft(); }
    catch (cause) { setError(cause); setBusy(undefined); }
  };
  const convert = async (event: FormEvent) => {
    event.preventDefault();
    if (!online || busy || conversionBusy || !name.trim()) { if (!name.trim()) setError(new Error('Enter a name for the named group.')); return; }
    setBusy('convert'); setError(undefined);
    onConversionBusyChange?.(true);
    try { const result = await convertPeerToNamedGroup(groupId, name.trim()); await applyConfirmedGroup(groupId, userId, result.group); await invalidateForMutation.groupChanged(groupId, userId, captureSessionGeneration()); }
    catch (cause) { setError(cause); }
    finally { onConversionBusyChange?.(false); setBusy(undefined); }
  };
  const convertToPeer = async () => {
    if (!online || busy || conversionBusy || activeMemberCount !== 2 || pendingGenericInvitation !== false || !confirm(`Convert “${displayName}” to a peer relationship?`)) return;
    setBusy('convert'); setError(undefined);
    onConversionBusyChange?.(true);
    try { const result = await convertNamedToPeerGroup(groupId); await applyConfirmedGroup(groupId, userId, result.group); await invalidateForMutation.groupChanged(groupId, userId, captureSessionGeneration()); }
    catch (cause) { setError(cause); }
    finally { onConversionBusyChange?.(false); setBusy(undefined); }
  };
  const relationshipSettings = managementKind === 'named' ? <section className="group-relationship-settings" aria-labelledby="relationship-type-heading"><SectionHeader title={<span id="relationship-type-heading">Relationship type</span>} description="Owner-only" /><p className="muted">Peer relationships use the other participant’s name as the ledger name and cannot add more people until converted back to a named group.</p>{activeMemberCount === 2 && pendingGenericInvitation === false ? <Button type="button" disabled={!online || Boolean(busy)} onClick={() => void convertToPeer()}>{busy === 'convert' ? 'Converting…' : 'Convert to peer relationship'}</Button> : <div className="muted" role="status"><p>Peer conversion is currently unavailable:</p><ul>{activeMemberCount !== 2 ? <li>Exactly two active ledger participants are required.</li> : null}{pendingGenericInvitation === true ? <li>Revoke pending generic group invitations first.</li> : null}{pendingGenericInvitation === undefined ? <li>Reconnect to confirm the group invitation status.</li> : null}</ul></div>}</section> : null;
  if (role === 'member') return <section className="group-settings"><SectionHeader title="Group settings" description="Member · online-only" /><p className="muted">You can leave this group at any time. The owner must transfer ownership before leaving.</p><ActionGroup className="actions"><Button type="button" variant="danger" disabled={!online || Boolean(busy)} onClick={() => void leave()}>{busy === 'leave' ? 'Leaving…' : 'Leave group'}</Button></ActionGroup>{error ? <ErrorBox error={error} id="group-settings-error" /> : null}</section>;
    return <section className="group-settings"><SectionHeader title="Group settings" description="Owner · online-only" />{managementKind === 'peer' ? <><p className="muted">This peer ledger is for you and one other participant. Convert it to a named group to add more people and use normal group invitations.</p><form onSubmit={convert} aria-describedby={error ? 'group-settings-error' : undefined}><Field label="New group name"><input required value={name} onChange={(event) => setName(event.target.value)} /></Field><Button type="submit" disabled={!online || Boolean(busy)}>{busy === 'convert' ? 'Converting…' : 'Convert to named group'}</Button></form></> : managementKind === 'unknown' ? <p className="muted" role="status">Group type is unavailable in this cached snapshot. Reconnect before changing group settings.</p> : <><p className="muted">Changing the default currency does not convert existing expenses or settlements. Existing transactions keep their original currency.</p><form onSubmit={save} aria-describedby={error ? 'group-settings-error' : undefined}><Field label="Group name"><input required value={name} onChange={(event) => setName(event.target.value)} /></Field><Field label="Default currency"><CurrencySelect value={currency} onChange={setCurrency} /></Field><Button type="submit" disabled={!online || busy === 'save'}>{busy === 'save' ? 'Saving…' : 'Save settings'}</Button></form>{relationshipSettings}</> }<ActionGroup className="actions"><Button type="button" variant="danger" disabled={!online || Boolean(busy)} onClick={() => void remove()}>{busy === 'delete' ? 'Deleting…' : 'Delete group'}</Button></ActionGroup>{error ? <ErrorBox error={error} id="group-settings-error" /> : null}<p className="muted">Deleting a group is a soft-delete. It is retained for 30 days before cleanup and removes it from your active groups.</p></section>;
}

async function saveDownload(blob: Blob, filename: string) {
  const picker = (window as Window & { showSaveFilePicker?: (options: unknown) => Promise<{ createWritable: () => Promise<{ write: (value: Blob) => Promise<void>; close: () => Promise<void> }> }> }).showSaveFilePicker;
  if (picker) {
    try { const handle = await picker({ suggestedName: filename }); const writable = await handle.createWritable(); await writable.write(blob); await writable.close(); return; } catch (error) { if (error instanceof DOMException && error.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
}

function GroupExports({ groupId, online }: { groupId: string; online: boolean }) {
  const [busy, setBusy] = useState<'json' | 'csv' | 'settlements' | 'credits'>();
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
  const exportCredits = async () => {
    if (!online || busy) return; setBusy('credits'); setError(undefined); setProgress('Starting…'); const abort = new AbortController(); controller.current = abort;
    try { const pages = await collectPagedExport(async (cursor, signal) => { const page = await getGroupCreditCsvExportPage(groupId, { limit: 100, cursor }, signal); return { items: [await page.blob.text()], nextCursor: page.nextCursor }; }, abort.signal, (count) => setProgress(`Fetched page ${count}`)); await saveDownload(new Blob([assembleCsvPages(pages, 'date,subtype,delivery_mode,amount_minor,currency,applications,allocations,note')], { type: 'text/csv;charset=utf-8' }), 'billsplit-credits.csv'); }
    catch (cause) { if (!(cause instanceof DOMException && cause.name === 'AbortError')) setError(cause); else setProgress('Cancelled'); }
    finally { controller.current = undefined; setBusy(undefined); }
  };
  return <section className="export-controls" data-flow-region="admin"><SectionHeader title="Export" description="Paged, connection required" /><p className="muted">Exports fetch bounded pages and can be cancelled before download.</p><ActionGroup className="actions"><Button type="button" variant="secondary" disabled={!online || Boolean(busy)} onClick={() => void exportJson()}>{busy === 'json' ? 'Exporting JSON…' : 'Export JSON'}</Button><Button type="button" variant="secondary" disabled={!online || Boolean(busy)} onClick={() => void exportCsv()}>{busy === 'csv' ? 'Exporting expenses CSV…' : 'Export expenses CSV'}</Button><Button type="button" variant="secondary" disabled={!online || Boolean(busy)} onClick={() => void exportSettlements()}>{busy === 'settlements' ? 'Exporting settlements CSV…' : 'Export settlements CSV'}</Button><Button type="button" variant="secondary" disabled={!online || Boolean(busy)} onClick={() => void exportCredits()}>{busy === 'credits' ? 'Exporting credits CSV…' : 'Export credits CSV'}</Button>{busy ? <Button type="button" variant="danger" onClick={cancel}>Cancel</Button> : null}</ActionGroup>{progress ? <p className="cache-status" role="status">{progress}</p> : null}{error ? <ErrorBox error={error} id="export-error" /> : null}</section>;
}

function Home() {
   const online = useOnlineStatus();
  const me = useResource(resourceKeys.identity(), '', (signal) => getMe({ signal }), RESOURCE_FRESHNESS.expenses, hydrateIdentity);
  const groupsResource = useResource<{ groups: Group[] }>(resourceKeys.groups(me.data?.id || 'pending'), me.data?.id, (signal) => getGroups(signal), RESOURCE_FRESHNESS.groups, me.data?.id ? () => hydrateGroups(me.data!.id) : undefined);
  const groups = groupsResource.data?.groups || [];
  const offline = Boolean(groupsResource.offline || me.offline);
   const [searchParams] = useSearchParams();
  const newGroupRequested = searchParams.get('new') === '1';
  const addFriendRequested = searchParams.get('friend') === '1';
   if (newGroupRequested) return <Navigate to="/groups/new" replace />;
   if (addFriendRequested) return <Navigate to="/friends/new" replace />;
   const coldHomeLoading = online && !offline && groupsResource.data === undefined && !me.error && !groupsResource.error && (me.status === 'idle' || me.status === 'loading' || groupsResource.status === 'idle' || groupsResource.status === 'loading');
   if (coldHomeLoading) return <Layout><HomeLoadingPlaceholder /></Layout>;
     return <Layout>
       <PageHeader className="page-title" eyebrow="Private expenses" title="Friends & groups" actions={<ActionGroup className="home-actions"><Link className="button" to="/friends/new">Add friend</Link><Link className="button button--secondary" to="/groups/new">New group</Link></ActionGroup>} />
        <PendingInvitations userId={me.data?.id} online={online && !offline} />
       {!online || offline ? <ConnectionBanner detail="showing your last verified groups. Friend and group creation require a connection; Add Expense remains available from cached groups." /> : null}{groupsResource.data !== undefined ? <CachedIdentityNotice resource={me} id="groups-identity-error" /> : null}{groupsResource.data === undefined && me.error ? <ErrorBox error={me.error} onRetry={retryFor(resourceKeys.identity(), '')} id="identity-error" retryLabel="Retry identity check" /> : null}
        {groupsResource.data === undefined && !me.error ? <ResourceNotice resource={groupsResource} label="groups" retry={retryFor(resourceKeys.groups(me.data?.id || 'pending'), me.data?.id)} /> : groupsResource.data !== undefined ? <><ResourceNotice resource={groupsResource} label="groups" retry={retryFor(resourceKeys.groups(me.data?.id || 'pending'), me.data?.id)} />{groups.length ? <div className="cards group-cards">{groups.map((group) => { const people = [{ name: 'You' }, ...(group.counterpartName ? [{ name: group.counterpartName }] : [])]; return <Link className="card group-card ui-card-surface" to={`/groups/${group.id}`} key={group.id}><div className="group-card__identity"><div className="group-card__heading"><AvatarStack people={people} /><strong className="card__name">{groupDisplayName(group)}</strong></div><span className="group-card__meta">{group.memberCount ? `${group.memberCount} ${group.memberCount === 1 ? 'person' : 'people'}` : group.kind === 'peer' ? 'Friend ledger' : 'Shared ledger'} · {group.currency}</span></div><div className="card__balances">{groupBalanceDisplays(group.balanceSummaries, group.currency).map((display, index) => display.kind === 'balance' ? <span className="card__balance" key={`${display.currency}-${index}`}><span className="card__balance-label">{display.label}</span><span className="card__balance-money"><Money amountMinor={display.amountMinor} currency={display.currency} currencyDisplay="code" tone={display.label === 'You are owed' ? 'positive' : 'debt'} /></span></span> : <span className={`card__balance card__balance--${display.kind}`} key={`${display.label}-${index}`}><span className="card__balance-label">{display.label}</span><small>{display.currency}</small></span>)}</div></Link>; })}</div> : <EmptyState title="No groups yet"><p className="empty-state__copy">Start a friend ledger for a quick one-to-one split, or create a shared group for a trip or household.</p><div className="empty-state__actions"><Link className="button" to="/friends/new">Add a friend</Link><Link className="button button--secondary" to="/groups/new">Create a group</Link></div></EmptyState>}</> : null}
       <CompactInsights userId={me.data?.id} global title="Spending snapshot" />
  </Layout>;
}

type PersonDraft = { id: string; name: string; email: string };
function CreationPageLayout({ eyebrow, title, children }: { eyebrow: string; title: string; children: ReactNode }) {
  return <Layout><Link className="back" to="/">← Friends &amp; groups</Link><PageHeader className="page-title" eyebrow={eyebrow} title={title} />{children}</Layout>;
}

function FriendCreationPage() {
  const online = useOnlineStatus(); const me = useResource(resourceKeys.identity(), '', (signal) => getMe({ signal }), RESOURCE_FRESHNESS.expenses); const nav = useNavigate();
  const [name, setName] = useState(''); const [email, setEmail] = useState(''); const [currency, setCurrency] = useState<Currency>('USD'); const [busy, setBusy] = useState(false); const [error, setError] = useState<unknown>(); const [op] = useState(operationId);
  const submit = async (event: FormEvent) => { event.preventDefault(); if (!online || busy) return; if (!name.trim()) { setError(new Error('Enter a friend name.')); return; } setBusy(true); setError(undefined); try { const result = await createFriend({ name: name.trim(), email: email.trim() || undefined, currency, client_operation_id: op }); await invalidateForMutation.groupCreated(me.data?.id, captureSessionGeneration()); nav(`/groups/${result.group.id}`); } catch (cause) { setError(cause); } finally { setBusy(false); } };
  return <CreationPageLayout eyebrow="New connection" title="Add friend">{!online ? <ConnectionBanner detail="Friend creation requires a connection." /> : null}<FormSurface className="creation-form-surface"><p className="muted">The signed-in account is added as the owner. An email only creates a targeted invitation; it does not grant access until accepted.</p><form onSubmit={submit} aria-describedby={error ? 'create-friend-error' : undefined}><Field label="Friend name"><input id="friend-name" required value={name} onChange={(event) => { setError(undefined); setName(event.target.value); }} /></Field><Field label="Email (optional)"><input id="friend-email" className="email" type="email" value={email} onChange={(event) => { setError(undefined); setEmail(event.target.value); }} /></Field><Field label="Currency"><CurrencySelect value={currency} onChange={setCurrency} /></Field>{error ? <ErrorBox error={error} id="create-friend-error" /> : null}<ActionGroup className="actions" region="frequent"><Button type="submit" data-primary-action="true" disabled={!online || busy}>{busy ? 'Adding…' : 'Add friend'}</Button><Link className="button button--secondary" to="/">Cancel</Link></ActionGroup></form></FormSurface></CreationPageLayout>;
}

function GroupCreationPage() {
  const online = useOnlineStatus(); const me = useResource(resourceKeys.identity(), '', (signal) => getMe({ signal }), RESOURCE_FRESHNESS.expenses); const nav = useNavigate();
  const [name, setName] = useState(''); const [currency, setCurrency] = useState<Currency>('USD'); const [people, setPeople] = useState<PersonDraft[]>(() => [{ id: operationId(), name: '', email: '' }]); const [busy, setBusy] = useState(false); const [error, setError] = useState<unknown>(); const [op] = useState(operationId);
  const updatePerson = (id: string, patch: Partial<PersonDraft>) => setPeople((current) => current.map((person) => person.id === id ? { ...person, ...patch } : person));
  const submit = async (event: FormEvent) => { event.preventDefault(); if (!online || busy) return; if (!name.trim()) { setError(new Error('Enter a group name.')); return; } if (people.some((person) => !person.name.trim())) { setError(new Error('Enter a name for every participant.')); return; } setBusy(true); setError(undefined); try { const result = await createGroup({ name: name.trim(), currency, people: people.map((person) => ({ name: person.name.trim(), email: person.email.trim() || undefined })), client_operation_id: op }); await invalidateForMutation.groupCreated(me.data?.id, captureSessionGeneration()); nav(`/groups/${result.group.id}`); } catch (cause) { setError(cause); } finally { setBusy(false); } };
  return <CreationPageLayout eyebrow="New shared ledger" title="New group">{!online ? <ConnectionBanner detail="Group creation requires a connection." /> : null}<FormSurface className="creation-form-surface"><p className="muted">You are the owner. Added people start as ledger-only participants; a targeted invitation is created when an email is supplied.</p><form onSubmit={submit} aria-describedby={error ? 'create-group-error' : undefined}><Field label="Group name"><input id="group-name" required value={name} onChange={(event) => { setError(undefined); setName(event.target.value); }} /></Field><Field label="Currency"><CurrencySelect value={currency} onChange={setCurrency} /></Field><fieldset><legend>People</legend><div className="participant-list"><div className="checkbox-row"><strong>You</strong><span className="muted">Owner</span></div>{people.map((person, index) => <div className="creation-person" key={person.id}><strong>Person {index + 1}</strong><Field label="Name"><input required value={person.name} onChange={(event) => updatePerson(person.id, { name: event.target.value })} /></Field><Field label="Email (optional)"><input className="email" type="email" value={person.email} onChange={(event) => updatePerson(person.id, { email: event.target.value })} /></Field>{people.length > 1 ? <Button type="button" variant="secondary" onClick={() => setPeople((current) => current.filter((candidate) => candidate.id !== person.id))}>Remove person</Button> : null}</div>)}</div><Button type="button" variant="secondary" onClick={() => setPeople((current) => [...current, { id: operationId(), name: '', email: '' }])}>Add another person</Button></fieldset>{error ? <ErrorBox error={error} id="create-group-error" /> : null}<ActionGroup className="actions" region="frequent"><Button type="submit" data-primary-action="true" disabled={!online || busy}>{busy ? 'Creating…' : 'Create group'}</Button><Link className="button button--secondary" to="/">Cancel</Link></ActionGroup></form></FormSurface></CreationPageLayout>;
}

function MemberDirectory({ groupId, userId, members, currentPersonId, online, owner, invitationsResource, targetedMutationState }: { groupId: string; userId: string; members: GroupMember[]; currentPersonId: string | null; online: boolean; owner: boolean; invitationsResource?: ResourceSnapshot<{ invitations: GroupInvitation[] }>; targetedMutationState?: TargetedInvitationMutationState }) {
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
  const invitations = invitationsResource?.data?.invitations;
  return <>
    <ul className="member-list" aria-label="Group members">{members.map((member) => <li className={`member-row${(!owner || member.role === 'owner') ? ' member-row--identity-only' : ''}${owner && member.role === 'member' && !member.linked ? ' member-row--with-email-control' : ''}`} key={member.personId}>
       <div className="member-row__identity"><strong>{member.personId === currentPersonId ? 'You' : member.name}</strong>{member.email ? <span className="email">{member.email}</span> : <span className="muted">No email linked</span>}<span className="muted">Role: {member.role === 'owner' ? 'Owner' : 'Member'}{member.linked ? '' : invitations?.some((candidate) => candidate.targetPersonId === member.personId && isPendingInvitation(candidate)) ? ' · Invitation pending' : ' · Access not linked'}</span></div>
      {owner && member.role === 'member' && !member.linked ? invitationsResource?.data !== undefined ? <TargetedInvitationControl groupId={groupId} userId={userId} member={member} invitation={invitations?.find((candidate) => candidate.targetPersonId === member.personId)} online={online} mutationState={targetedMutationState || 'checking'} /> : <InvitationAvailabilityStatus resource={invitationsResource} /> : null}
       {owner && member.role !== 'owner' ? <div className="member-row__actions" aria-label={`Actions for ${member.name}`}>{member.linked ? <Button type="button" variant="secondary" disabled={!online || Boolean(busy)} onClick={() => void transfer(member)}>Transfer ownership</Button> : null}<Button type="button" variant="danger" disabled={!online || Boolean(busy)} onClick={() => void remove(member)}>Remove</Button></div> : null}
    </li>)}</ul>{error ? <ErrorBox error={error} id="member-management-error" /> : null}
  </>;
}

function InvitationAvailabilityStatus({ resource }: { resource?: ResourceSnapshot<{ invitations: GroupInvitation[] }> }) {
  const message = resource?.error || resource?.status === 'error' || resource?.status === 'auth-blocked' ? 'Email actions unavailable. Retry below.' : resource?.offline || (typeof navigator !== 'undefined' && navigator.onLine === false) ? 'Email actions unavailable offline.' : 'Checking invitation status…';
  return <div className="member-email-control member-email-control--unavailable"><p className="muted" role="status">{message}</p></div>;
}

function TargetedInvitationControl({ groupId, userId, member, invitation, online, mutationState }: { groupId: string; userId: string; member: GroupMember; invitation?: GroupInvitation; online: boolean; mutationState: TargetedInvitationMutationState }) {
  const [email, setEmail] = useState(invitation?.email || member.email || '');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<'save' | 'revoke'>();
  const [error, setError] = useState<unknown>();
  const pending = isPendingInvitation(invitation) ? invitation : undefined;
  const mutationAvailable = online && mutationState === 'available';
  const mutationStatus = !online ? 'Email actions unavailable offline.' : mutationState === 'checking' ? 'Refreshing invitation status…' : 'Email actions unavailable. Retry below.';
  useEffect(() => { setEmail(invitation?.email || member.email || ''); }, [invitation?.email, member.email]);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!mutationAvailable || busy || !email.trim()) return;
    setBusy('save'); setError(undefined);
    try { await createTargetedGroupInvitation(groupId, member.personId, email.trim()); setOpen(false); await invalidateForMutation.invitationsChanged(groupId, userId); }
    catch (cause) { setError(cause); }
    finally { setBusy(undefined); }
  };
  const revoke = async () => {
    if (!pending || !mutationAvailable || busy || !confirm(`Revoke the invitation for ${member.name}?`)) return;
    setBusy('revoke'); setError(undefined);
    try { await revokeGroupInvitation(groupId, pending.id); setOpen(false); await invalidateForMutation.invitationsChanged(groupId, userId); }
    catch (cause) { setError(cause); }
    finally { setBusy(undefined); }
  };
  return <div className="member-email-control">
    {pending ? <p className="member-email-control__pending" role="status"><span>Pending invitation for <strong>{pending.email}</strong>.</span><span className="member-email-control__pending-actions"><Button type="button" variant="secondary" disabled={!mutationAvailable || Boolean(busy)} onClick={() => setOpen((current) => !current)}>{open ? 'Close' : 'Change'}</Button><Button type="button" variant="danger" disabled={!mutationAvailable || Boolean(busy)} onClick={() => void revoke()}>{busy === 'revoke' ? 'Revoking…' : 'Revoke'}</Button></span></p> : null}
    {pending && (!mutationAvailable || mutationState !== 'available') ? <p className="member-email-control__availability muted" role="status">{mutationStatus}</p> : null}
     {!pending ? mutationState === 'available' ? <Disclosure className="member-email-control__disclosure" open={open} onToggle={(event) => setOpen(event.currentTarget.open)} summary="Add email"><TargetedInvitationForm member={member} email={email} setEmail={setEmail} clearError={() => setError(undefined)} busy={busy} error={error} online={mutationAvailable} save={save} /></Disclosure> : <><p className="member-email-control__availability muted" role="status">{mutationStatus}</p><Button type="button" variant="secondary" disabled>Add email</Button></> : open ? <div className="member-email-control__form"><TargetedInvitationForm member={member} email={email} setEmail={setEmail} clearError={() => setError(undefined)} busy={busy} error={error} online={mutationAvailable} save={save} /></div> : null}
    {error && pending && !open ? <ErrorBox error={error} id={`target-invite-error-${member.personId}`} /> : null}
  </div>;
}

function TargetedInvitationForm({ member, email, setEmail, clearError, busy, error, online, save }: { member: GroupMember; email: string; setEmail: (email: string) => void; clearError: () => void; busy?: 'save' | 'revoke'; error?: unknown; online: boolean; save: (event: FormEvent) => Promise<void> }) {
  return <form onSubmit={save} aria-describedby={error ? `target-invite-error-${member.personId}` : undefined}><Field label={`Email for ${member.name}`}><input id={`target-email-${member.personId}`} className="email" type="email" required value={email} disabled={!online || Boolean(busy)} onChange={(event) => { clearError(); setEmail(event.target.value); }} /></Field><Button type="submit" variant="secondary" disabled={!online || Boolean(busy)}>{busy === 'save' ? 'Saving…' : 'Save email'}</Button>{error ? <ErrorBox error={error} id={`target-invite-error-${member.personId}`} /> : null}</form>;
}

function GenericInvitationControls({ groupId, userId, online, invitationsResource }: { groupId: string; userId: string; online: boolean; invitationsResource: ResourceSnapshot<{ invitations: GroupInvitation[] }> }) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<unknown>();
  const [inviteError, setInviteError] = useState<unknown>();
  const effectiveOnline = online && (typeof navigator === 'undefined' || navigator.onLine !== false);
  const mutationState = targetedInvitationMutationState(invitationsResource);
  const mutationAvailable = effectiveOnline && mutationState === 'available';
  const mutationStatus = !effectiveOnline ? 'Invitation actions unavailable offline.' : mutationState === 'checking' ? 'Refreshing invitation status…' : 'Invitation actions unavailable. Retry below.';
  const invitations = invitationsResource.data?.invitations?.filter((invitation) => invitation.targetPersonId == null);
  const invite = async (event: FormEvent) => {
    event.preventDefault(); if (!mutationAvailable || busy || !email.trim()) return;
    setBusy('invite'); setInviteError(undefined);
    try { await createGroupInvitation(groupId, email.trim()); setEmail(''); await invalidateForMutation.invitationsChanged(groupId, userId); }
    catch (cause) { setInviteError(cause); }
    finally { setBusy(undefined); }
  };
  const revoke = async (invitation: GroupInvitation) => {
    if (!mutationAvailable || busy || !confirm(`Revoke the invitation for ${invitation.email}?`)) return;
    setBusy(invitation.id); setError(undefined);
    try { await revokeGroupInvitation(groupId, invitation.id); await invalidateForMutation.invitationsChanged(groupId, userId); }
    catch (cause) { setError(cause); }
    finally { setBusy(undefined); }
  };
  const offlineWithoutCache = !effectiveOnline && invitationsResource.data === undefined;
  return <section className="invitations-panel" aria-labelledby="invitations-heading"><div className="management-section__header"><h2 id="invitations-heading">Invitations</h2><span className="muted">Owner · generic only</span></div><details className="generic-invitation-disclosure"><summary>Invite a new member</summary><p className="muted">Send an invitation to someone who is not in this ledger yet.</p><form onSubmit={invite} aria-describedby={inviteError ? 'invite-error' : undefined}><Field label="Invite by email"><input className="email" type="email" required value={email} disabled={!mutationAvailable || Boolean(busy)} onChange={(event) => { setInviteError(undefined); setEmail(event.target.value); }} /></Field><Button type="submit" disabled={!mutationAvailable || busy === 'invite'}>{busy === 'invite' ? 'Inviting…' : 'Invite'}</Button></form>{inviteError ? <ErrorBox error={inviteError} id="invite-error" /> : null}</details>{!mutationAvailable ? <p className="member-email-control__availability muted" role="status">{mutationStatus}</p> : null}{offlineWithoutCache ? <p className="cache-status">Invitations aren’t cached on this device and need a connection.</p> : <><ResourceNotice resource={invitationsResource} label="invitations" retry={retryFor(resourceKeys.groupInvitations(userId, groupId), userId)} />{!effectiveOnline && invitationsResource.data !== undefined ? <p className="cache-status">Showing cached invitations; they may be out of date. Invitation changes require a connection.</p> : null}</>}{invitationsResource.data !== undefined ? invitations?.length ? <div aria-label="Generic invitation history">{invitations.map((invitation) => { const pending = isPendingInvitation(invitation); const status = pending ? 'Pending' : invitation.acceptedAt ? 'Accepted' : invitation.rejectedAt ? 'Declined' : invitation.revokedAt ? 'Revoked' : 'Expired'; return <div className="invitation-history-row" key={invitation.id}><span><strong>{invitation.email}</strong><small>{status} · Created {new Date(invitation.createdAt).toLocaleDateString()}</small></span>{pending ? <Button type="button" variant="danger" disabled={!mutationAvailable || Boolean(busy)} onClick={() => void revoke(invitation)}>{busy === invitation.id ? 'Revoking…' : 'Revoke'}</Button> : null}</div>; })}</div> : <p className="muted">No invitations yet.</p> : null}{error ? <ErrorBox error={error} id="invitation-management-error" /> : null}</section>;
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
  return <section aria-labelledby="add-friend-heading" data-flow-region="frequent"><SectionHeader title={<span id="add-friend-heading">Add friend</span>} actions={<Button type="button" variant="secondary" data-primary-action="true" disabled={!online} onClick={() => { setError(undefined); setOpen((current) => !current); }}>{open ? 'Cancel' : 'Add friend'}</Button>} />{open ? <form onSubmit={submit} aria-describedby={error ? 'add-person-error' : undefined}><Field label="Friend name"><input required value={name} onChange={(event) => { setError(undefined); setName(event.target.value); }} /></Field><Field label="Email (optional)"><input className="email" type="email" value={email} onChange={(event) => { setError(undefined); setEmail(event.target.value); }} /></Field>{error ? <ErrorBox error={error} id="add-person-error" /> : null}<Button type="submit" data-primary-action="true" disabled={!online || busy}>{busy ? 'Adding…' : 'Add friend'}</Button></form> : <p className="muted">Add a ledger-only friend or link the email they use to sign in.</p>}</section>;
}

function SplitDefaultSummary({ value, members }: { value: GroupSplitDefault | null | undefined; members: GroupMember[] }) {
  const summary = groupSplitDefaultSummary(value, members);
  return <><p className="muted">{summary.label}</p><p className="muted">Saved defaults affect future entries for everyone. Members can save a shared default while adding an expense; only the owner can edit or clear it here.</p>{summary.warning ? <p className="warning" role="alert">This default includes removed members. New expenses will use an equal split across current members until it is updated.</p> : null}</>;
}

function SplitDefaultSettings({ groupId, userId, members, value, online, owner, onChanged }: { groupId: string; userId: string; members: GroupMember[]; value: GroupSplitDefault | null; online: boolean; owner: boolean; onChanged: (value: GroupSplitDefault | null) => void }) {
  const [open, setOpen] = useState(false);
  const resolvedEditorDefault = resolveGroupSplitDefault(value, members);
  const [method, setMethod] = useState<'equal' | 'percentage' | 'shares'>(resolvedEditorDefault.method === 'exact' ? 'equal' : resolvedEditorDefault.method);
  const [selected, setSelected] = useState<string[]>(resolvedEditorDefault.selected);
  const [values, setValues] = useState<Record<string, string>>(resolvedEditorDefault.values);
  const [busy, setBusy] = useState<'save' | 'clear'>();
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    if (open) return;
    const resolved = resolveGroupSplitDefault(value, members);
    setMethod(resolved.method === 'exact' ? 'equal' : resolved.method); setSelected(resolved.selected); setValues(resolved.values);
  }, [members, open, value]);
  const cancel = () => { setOpen(false); setError(undefined); };
  const evenly = () => {
    if (!selected.length) return;
    const each = Math.floor(10_000 / selected.length), remainder = 10_000 - each * selected.length;
    setValues(Object.fromEntries(selected.map((personId, index) => [personId, String((each + (index < remainder ? 1 : 0)) / 100)])));
  };
  const save = async (event: FormEvent) => {
    event.preventDefault(); if (!online || busy) return;
    setBusy('save'); setError(undefined);
    try {
      const input = method === 'equal' ? { method, person_ids: selected } : { method, person_ids: selected, values: selected.map((personId) => method === 'percentage' ? Math.round(Number(values[personId] || 0) * 100) : Number(values[personId] || 0)) };
      const parsed = groupSplitDefaultInput.parse(input);
      const result = await updateGroupSplitDefault(groupId, parsed);
      const next = result.splitDefault;
      onChanged(next); setOpen(false);
    } catch (cause) { setError(cause); }
    finally { setBusy(undefined); }
  };
  const clear = async () => {
    if (!online || busy || !confirm('Use automatic equal split for new expenses?')) return;
    setBusy('clear'); setError(undefined);
    try { await deleteGroupSplitDefault(groupId); onChanged(null); setOpen(false); }
    catch (cause) { setError(cause); }
    finally { setBusy(undefined); }
  };
  const total = selected.reduce((sum, personId) => sum + (Number(values[personId]) || 0), 0);
  const summary = groupSplitDefaultSummary(value, members);
  return <section className="split-default-settings" aria-labelledby="split-default-heading"><div className="management-section__header"><h2 id="split-default-heading">Party default split</h2>{owner ? <Button type="button" variant="secondary" disabled={Boolean(busy)} onClick={() => { setError(undefined); setOpen((current) => !current); }}>{open ? 'Close' : value ? 'Edit' : 'Customize'}</Button> : <span className="muted">Owner-only editor</span>}</div>{!open ? <><SplitDefaultSummary value={value} members={members} />{owner ? <p className="muted">Used only when starting a new expense or schedule. Each expense can override it.</p> : <p className="muted">You can save a shared default while adding an expense. Only the owner can edit or clear it here.</p>}</> : <form onSubmit={save} aria-describedby={error ? 'split-default-error' : undefined}><fieldset><legend>Split new entries</legend><div className="radio-list"><label className="checkbox-row"><input type="radio" name="split-default-method" checked={method === 'equal'} onChange={() => setMethod('equal')} />Equal</label><label className="checkbox-row"><input type="radio" name="split-default-method" checked={method === 'percentage'} onChange={() => setMethod('percentage')} />Percentage</label><label className="checkbox-row"><input type="radio" name="split-default-method" checked={method === 'shares'} onChange={() => setMethod('shares')} />Shares</label></div></fieldset><fieldset><legend>Included members</legend><div className="participant-list">{members.map((member) => <label className="checkbox-row" key={member.personId}><input type="checkbox" checked={selected.includes(member.personId)} onChange={() => setSelected((current) => current.includes(member.personId) ? current.filter((id) => id !== member.personId) : [...current, member.personId])} />{member.name}</label>)}</div></fieldset>{method !== 'equal' ? <div className="allocation-list">{members.filter((member) => selected.includes(member.personId)).map((member) => <Field key={member.personId} label={`${member.name} ${method === 'percentage' ? 'percentage' : 'shares'}`} className="field--compact"><input required inputMode="decimal" value={values[member.personId] || ''} placeholder={method === 'percentage' ? '0.00%' : '1'} onChange={(event) => setValues((current) => ({ ...current, [member.personId]: event.target.value }))} /></Field>)}<p className="allocation-summary" role="status" aria-live="polite">{method === 'percentage' ? `Total ${total.toFixed(2)}% of 100%` : `Total shares ${total}`}</p>{method === 'percentage' ? <Button type="button" variant="secondary" onClick={evenly}>Split evenly</Button> : null}</div> : null}{error ? <ErrorBox error={error} id="split-default-error" /> : null}<div className="actions"><Button type="submit" disabled={!online || busy === 'save'}>{busy === 'save' ? 'Saving…' : 'Save'}</Button><Button type="button" variant="secondary" disabled={Boolean(busy)} onClick={cancel}>Cancel</Button><Button type="button" variant="secondary" disabled={!online || Boolean(busy) || !value} onClick={() => void clear()}>Use automatic equal split</Button></div>{!online ? <p className="cache-status">Default split editing requires a connection. The cached summary remains available.</p> : null}</form>}{open && value && summary.warning ? <p className="warning" role="alert">Removed members must be removed before saving this default.</p> : null}</section>;
}

type GroupManagementContentProps = { group: Group; groupId: string; userId: string; members: GroupMember[]; currentPersonId: string | null; online: boolean; offline: boolean; groupResource: ResourceSnapshot<GroupResponse>; splitDefault: GroupSplitDefault | null; onSplitDefaultChanged: (value: GroupSplitDefault | null) => void; onDeleted: () => void; onLeft: () => void };
type GroupManagementLayoutProps = Pick<GroupManagementContentProps, 'group' | 'groupId' | 'userId' | 'online' | 'offline' | 'groupResource' | 'onDeleted' | 'onLeft'> & { children: ReactNode; activeMemberCount: number; pendingGenericInvitation?: boolean; conversionBusy?: boolean; onConversionBusyChange?: (busy: boolean) => void };

function GroupManagementLayout({ group, groupId, userId, online, offline, groupResource, children, activeMemberCount, pendingGenericInvitation, conversionBusy, onConversionBusyChange, onDeleted, onLeft }: GroupManagementLayoutProps) {
  const owner = group.role === 'owner';
  return <Layout><Link className="back" to={`/groups/${groupId}`}>← <span className="back__label">Back to {groupDisplayName(group)}</span></Link><PageHeader className="page-title" eyebrow="Group management" title="Manage group" />{offline ? <ConnectionBanner detail="cached group data is available. Member changes, invitations, exports, and settings require a connection." /> : null}<ResourceNotice resource={groupResource} label="group" retry={retryFor(resourceKeys.group(userId, groupId), userId)} /><div className="management-sections">{children}<GroupExports groupId={groupId} online={online && !offline} /><div id="settings" className="group-management-settings" data-flow-region="admin" tabIndex={-1}><GroupSettings group={group} groupId={groupId} userId={userId} online={online && !offline} role={owner ? 'owner' : 'member'} activeMemberCount={activeMemberCount} pendingGenericInvitation={pendingGenericInvitation} conversionBusy={conversionBusy} onConversionBusyChange={onConversionBusyChange} onDeleted={onDeleted} onLeft={onLeft} /></div></div></Layout>;
}

function PeopleSection({ groupId, userId, members, currentPersonId, online, owner, invitationsResource, targetedMutationState }: { groupId: string; userId: string; members: GroupMember[]; currentPersonId: string | null; online: boolean; owner: boolean; invitationsResource?: ResourceSnapshot<{ invitations: GroupInvitation[] }>; targetedMutationState?: TargetedInvitationMutationState }) {
  return <section id="people" className="management-section management-section--people" tabIndex={-1} aria-labelledby="people-heading" data-flow-region="admin"><SectionHeader title={<span id="people-heading">People</span>} description={owner ? 'Owner controls' : 'Members can view this list'} /><MemberDirectory groupId={groupId} userId={userId} members={members} currentPersonId={currentPersonId} online={online} owner={owner} invitationsResource={invitationsResource} targetedMutationState={targetedMutationState} /></section>;
}

function OwnerGroupManagement({ group, groupId, userId, members, currentPersonId, online, offline, groupResource, splitDefault, onSplitDefaultChanged, onDeleted, onLeft }: GroupManagementContentProps) {
  const effectiveOnline = online && !offline && (typeof navigator === 'undefined' || navigator.onLine !== false);
  const [conversionBusy, setConversionBusy] = useState(false);
  const invitationsResource = useResource<{ invitations: GroupInvitation[] }>(resourceKeys.groupInvitations(userId, groupId), userId, (signal) => getOwnerInvitations(groupId, signal), RESOURCE_FRESHNESS.invitations, undefined, { skipWhenOffline: !effectiveOnline });
  const pendingGenericInvitation = invitationsResource.data !== undefined && !invitationsResource.error && !invitationsResource.revalidating && !invitationsResource.stale && !invitationsResource.offline
    ? invitationsResource.data.invitations.some((invitation) => invitation.targetPersonId == null && isPendingInvitation(invitation))
    : undefined;
  return <GroupManagementLayout group={group} groupId={groupId} userId={userId} online={online} offline={offline} groupResource={groupResource} activeMemberCount={members.length} pendingGenericInvitation={pendingGenericInvitation} conversionBusy={conversionBusy} onConversionBusyChange={setConversionBusy} onDeleted={onDeleted} onLeft={onLeft}>{groupManagementKind(group) === 'named' ? <><AddFriendForm groupId={groupId} userId={userId} online={effectiveOnline && !conversionBusy} /><PeopleSection groupId={groupId} userId={userId} members={members} currentPersonId={currentPersonId} online={effectiveOnline && !conversionBusy} owner invitationsResource={invitationsResource} targetedMutationState={targetedInvitationMutationState(invitationsResource)} /><div data-flow-region="admin"><GenericInvitationControls groupId={groupId} userId={userId} online={effectiveOnline && !conversionBusy} invitationsResource={invitationsResource} /></div></> : <PeopleSection groupId={groupId} userId={userId} members={members} currentPersonId={currentPersonId} online={effectiveOnline && !conversionBusy} owner invitationsResource={invitationsResource} targetedMutationState={targetedInvitationMutationState(invitationsResource)} />}{groupManagementKind(group) === 'unknown' ? <p className="muted" role="status">Additional people and invitations are unavailable until this group’s type is confirmed online.</p> : null}<div data-flow-region="admin"><SplitDefaultSettings groupId={groupId} userId={userId} members={members} value={splitDefault} online={effectiveOnline && !conversionBusy} owner onChanged={onSplitDefaultChanged} /></div></GroupManagementLayout>;
}

function MemberGroupManagement({ group, groupId, userId, members, currentPersonId, online, offline, groupResource, splitDefault, onSplitDefaultChanged, onDeleted, onLeft }: GroupManagementContentProps) {
  const effectiveOnline = online && !offline && (typeof navigator === 'undefined' || navigator.onLine !== false);
  return <GroupManagementLayout group={group} groupId={groupId} userId={userId} online={online} offline={offline} groupResource={groupResource} activeMemberCount={members.length} onDeleted={onDeleted} onLeft={onLeft}><PeopleSection groupId={groupId} userId={userId} members={members} currentPersonId={currentPersonId} online={effectiveOnline} owner={false} /><SplitDefaultSettings groupId={groupId} userId={userId} members={members} value={splitDefault} online={effectiveOnline} owner={false} onChanged={onSplitDefaultChanged} /></GroupManagementLayout>;
}

function GroupManagementPage() {
  const online = useOnlineStatus();
  const { id = '' } = useParams();
  const nav = useNavigate();
  const me = useResource(resourceKeys.identity(), '', (signal) => getMe({ signal }), RESOURCE_FRESHNESS.expenses, hydrateIdentity);
  const userId = me.data?.id || 'pending';
  const groupResource = useResource<GroupResponse>(resourceKeys.group(userId, id), me.data?.id, (signal) => getGroup(id, signal), RESOURCE_FRESHNESS.group, me.data?.id ? () => hydrateGroup(me.data!.id, id) : undefined);
  const group = groupResource.data?.group;
  const members = groupResource.data?.members || [];
  const [splitDefault, setSplitDefault] = useState<GroupSplitDefault | null>(groupResource.data?.splitDefault ?? null);
  useEffect(() => { if (groupResource.data) setSplitDefault(groupResource.data.splitDefault ?? null); }, [groupResource.data]);
  const offline = Boolean(me.offline || groupResource.offline) || !online;
  useEffect(() => {
    if (!group || typeof window === 'undefined' || !window.location.hash) return;
    const target = document.getElementById(window.location.hash.slice(1));
    if (target instanceof HTMLElement) window.requestAnimationFrame(() => target.focus({ preventScroll: true }));
  }, [group, id]);
  if ((me.error || groupResource.error) && !group) return <Layout><ErrorBox error={me.error || groupResource.error} onRetry={me.error ? retryFor(resourceKeys.identity(), '') : retryFor(resourceKeys.group(userId, id), me.data?.id)} id="group-manage-error" retryLabel={me.error ? 'Retry identity check' : 'Retry'} /><Link className="back" to={`/groups/${id}`}>← Back to group</Link></Layout>;
  if (!group) return <Layout><Loading /></Layout>;
  const contentProps = { group, groupId: id, userId, members, currentPersonId: groupResource.data?.currentPersonId ?? null, online, offline, groupResource, splitDefault, onSplitDefaultChanged: (next: GroupSplitDefault | null) => { setSplitDefault(next); void invalidateForMutation.splitDefaultChanged(id, next, userId, captureSessionGeneration()); }, onDeleted: () => nav('/'), onLeft: () => nav('/') };
  return group.role === 'owner' ? <OwnerGroupManagement {...contentProps} /> : <MemberGroupManagement {...contentProps} />;
}

function GroupOverview() {
  const online = useOnlineStatus();
  const connection = useConnectionState();
  const { id = '' } = useParams();
  const me = useResource(resourceKeys.identity(), '', (signal) => getMe({ signal }), RESOURCE_FRESHNESS.expenses, hydrateIdentity);
  const userId = me.data?.id || 'pending';
  const groupResource = useResource<GroupResponse>(resourceKeys.group(userId, id), me.data?.id, (signal) => getGroup(id, signal), RESOURCE_FRESHNESS.group, me.data?.id ? () => hydrateGroup(me.data!.id, id) : undefined);
  const transactionsResource = useResource<{ transactions: Transaction[]; nextCursor?: string }>(resourceKeys.transactions(userId, id, 'overview'), me.data?.id, (signal) => getTransactionPage(id, { limit: 5 }, signal), RESOURCE_FRESHNESS.transactions, me.data?.id ? () => hydrateTransactionOverview(me.data!.id, id) : undefined);
  const scheduledResource = useResource<{ scheduledExpenses: ScheduledExpense[]; nextCursor?: string }>(resourceKeys.scheduledExpenses(userId, id), me.data?.id, (signal) => getScheduledExpenses(id, signal), RESOURCE_FRESHNESS.scheduledExpenses);
  const balancesResource = useResource<{ balances: Record<string, Balances> }>(resourceKeys.balances(userId, id), me.data?.id, (signal) => getBalances(id, signal), RESOURCE_FRESHNESS.balances, me.data?.id ? () => hydrateBalances(me.data!.id, id) : undefined);
  const group = groupResource.data?.group;
  const members = groupResource.data?.members || [];
  const balances = Object.fromEntries(Object.entries(balancesResource.data?.balances || {}).map(([key, balance]) => [key, { ...balance, suggestions: balance.simplified }])) as Record<string, Balances & { suggestions: Balances['simplified'] }>;
  const currentPersonId = groupResource.data?.currentPersonId || '';
  const currentUserId = me.data?.id || '';
  const outbox = useSyncExternalStore(subscribeOutbox, getOutboxSnapshot, () => []);
  const pending = outbox.filter((item) => item.userId === currentUserId && item.groupId === id);
  const transactions = transactionsResource.data?.transactions || [];
  const offline = Boolean(groupResource.offline || transactionsResource.offline || balancesResource.offline || scheduledResource.offline || me.offline) || !online;
  const refreshing = [groupResource, transactionsResource, balancesResource, scheduledResource].some((resource) => resource.revalidating);
  if ((groupResource.error || me.error) && !group) return <Layout><ErrorBox error={groupResource.error || me.error} onRetry={me.error ? retryFor(resourceKeys.identity(), '') : retryFor(resourceKeys.group(userId, id), me.data?.id)} id="group-error" /><Link className="back" to="/">← Groups</Link></Layout>;
  const coldGroupLoading = online && !offline && !group && !me.error && !groupResource.error && (me.status === 'idle' || me.status === 'loading' || groupResource.status === 'idle' || groupResource.status === 'loading');
  if (coldGroupLoading) return <Layout><GroupOverviewLoadingPlaceholder /></Layout>;
  if (!group) return <Layout><GroupOverviewUnavailable connectionStatus={connection.status} /></Layout>;
  const displayName = groupDisplayName(group);
  const balanceDisplays = personalBalances(balances, currentPersonId, group.currency);

  const transactionLoading = transactionsResource.data === undefined && !transactionsResource.error && online && !transactionsResource.offline && (transactionsResource.loading || transactionsResource.status === 'idle' || transactionsResource.status === 'loading');
  const knownBalanceCurrencyCount = balancesResource.data === undefined ? undefined : Object.keys(balancesResource.data.balances).length;
  const memberCount = group.memberCount ?? members.length;
  const groupContext = group.kind === 'peer' || (group.kind === undefined && memberCount === 2) ? 'Friend group' : 'Shared group';
  return <Layout>
    <Link to="/" className="back">← Groups</Link>
      <PageHeader className="page-title group-overview-header" title={displayName} description={<span className="group-overview-meta">{memberCount} {memberCount === 1 ? 'member' : 'members'} · {group.currency} · {groupContext}</span>} actions={<ActionGroup className="expense-heading__actions" region="frequent"><SplitTransactionControl groupId={id} online={online && !offline} primaryAriaLabel="+ Add expense" /><Link className="button button--secondary" to={`/groups/${id}/settle`}>Settle up</Link></ActionGroup>} />
    {offline ? <ConnectionBanner detail="showing cached group data. New expenses can be captured; history, schedules, and management need a connection." /> : null}
    {me.error ? <CachedIdentityNotice resource={me} id="group-identity-error" /> : null}
    {groupResource.error ? <ResourceNotice resource={groupResource} label="group" retry={retryFor(resourceKeys.group(userId, id), me.data?.id)} /> : null}
    {refreshing ? <p className="cache-status" role="status">Refreshing group data…</p> : null}
    <div className="group-overview-columns">
      <div className="group-overview-main">
        <section className="group-overview-card group-overview-card--balances compact-balances" aria-labelledby="balances-heading"><SectionHeader title={<span id="balances-heading">Your balances</span>} description={knownBalanceCurrencyCount !== undefined ? `${knownBalanceCurrencyCount} ${knownBalanceCurrencyCount === 1 ? 'currency' : 'currencies'}` : undefined} />{balancesResource.data !== undefined ? <ResourceNotice resource={balancesResource} label="balances" retry={retryFor(resourceKeys.balances(userId, id), me.data?.id)} /> : balancesResource.error ? <ErrorBox error={balancesResource.error} onRetry={online ? retryFor(resourceKeys.balances(userId, id), me.data?.id) : undefined} id="balances-error" /> : null}<ul className="balance-cards">{balancesResource.data === undefined ? <li><p className="cache-status">Balances are unavailable until this group’s balance data is loaded.</p></li> : balanceDisplays.map((display, index) => <li className={`balance-card balance-card--${display.kind} ${display.label === 'You are owed' ? 'balance-card--positive' : display.label === 'You owe' ? 'balance-card--debt' : ''}`} key={`${display.currency}-${index}`}><span className="balance-card__currency">{display.currency}</span><strong>{display.label}</strong>{display.kind === 'balance' ? <Money amountMinor={display.amountMinor} currency={display.currency} tone={display.label === 'You are owed' ? 'positive' : 'debt'} size="large" /> : null}</li>)}</ul><Disclosure className="balance-breakdown" summary="View full group breakdown"><p className="muted">Net position = paid minus share, adjusted by settlements. Positive means owed; negative means owes.</p>{balancesResource.data === undefined ? <p className="cache-status">Balance details are unavailable.</p> : Object.keys(balances).length ? Object.entries(balances).map(([currencyKey, balance]) => <div key={currencyKey}><SectionHeader level={3} title={currencyKey} /><LedgerList label={`${currencyKey} balances`}>{balance.raw.map((item) => <LedgerRow key={`${currencyKey}-raw-${item.personId}`}><span>{item.personId === currentPersonId ? 'You' : item.name}</span><span>{balanceStatus(item.netMinor) === 'owed' ? 'is owed' : balanceStatus(item.netMinor) === 'owes' ? 'owes' : 'settled up'}</span>{item.netMinor === 0 ? null : <Money amountMinor={Math.abs(item.netMinor)} currency={currencyKey} tone={item.netMinor > 0 ? 'positive' : 'debt'} />}</LedgerRow>)}</LedgerList><SectionHeader level={4} title="Suggested settlements" />{balance.suggestions.length ? <LedgerList label={`${currencyKey} suggested settlements`}>{balance.suggestions.map((suggestion) => <LedgerRow key={`${currencyKey}-suggestion-${suggestion.fromPersonId}-${suggestion.toPersonId}`}><span>{suggestion.fromPersonId === currentPersonId ? 'You' : nameOf(members, suggestion.fromPersonId, suggestion.fromName)} → {suggestion.toPersonId === currentPersonId ? 'You' : nameOf(members, suggestion.toPersonId, suggestion.toName)}</span><Money amountMinor={suggestion.amountMinor} currency={currencyKey} /></LedgerRow>)}</LedgerList> : <p className="muted">No payment is suggested in this currency.</p>}</div>) : <Empty>No balance details yet.</Empty>}</Disclosure></section>
        <section className="group-overview-card group-overview-card--transactions" aria-labelledby="recent-transactions-heading"><SectionHeader title={<span id="recent-transactions-heading">Recent transactions</span>} actions={<Link className="inline-action" to={`/activity?group=${encodeURIComponent(id)}&view=transactions`}>See all</Link>} />{transactionsResource.data !== undefined ? <ResourceNotice resource={transactionsResource} label="transactions" retry={retryFor(resourceKeys.transactions(userId, id, 'overview'), me.data?.id)} /> : transactionsResource.error ? <ErrorBox error={transactionsResource.error} onRetry={online ? retryFor(resourceKeys.transactions(userId, id, 'overview'), me.data?.id) : undefined} id="overview-transactions-error" /> : transactionLoading ? <p className="cache-status" role="status">Loading recent transactions…</p> : null}{pending.length ? <section className="pending-transactions" aria-labelledby="pending-transactions-heading"><SectionHeader level={3} title={`Waiting to sync · ${pending.length}`} /><LedgerList as="div" label="Pending transactions">{pending.map((item) => <PendingExpenseRow key={item.clientOperationId} item={item} />)}</LedgerList></section> : null}{transactionsResource.data === undefined ? transactionLoading ? null : <p className="cache-status">Recent transactions are unavailable until this group’s transaction data is loaded.</p> : !transactions.length && !pending.length ? <Empty>No transactions yet.</Empty> : transactions.length ? <LedgerList className="transaction-list" label="Recent transactions">{transactions.map((transaction) => <li key={transactionKey(transaction)}><TransactionRow groupId={id} transaction={transaction} currentPersonId={currentPersonId} overview /></li>)}</LedgerList> : null}</section>
      </div>
      <div className="group-overview-context">
        <CompactScheduleList groupId={id} schedules={scheduledResource.data?.scheduledExpenses || []} resource={scheduledResource} online={!offline} userId={currentUserId} />
        <section className="group-overview-card group-overview-card--people" aria-labelledby="people-summary-heading"><SectionHeader title={<span id="people-summary-heading">People</span>} description={`${members.length} ${members.length === 1 ? 'person' : 'people'}`} /><ul className="people-preview-list" aria-label="People in this group">{members.slice(0, 4).map((member) => <li className="people-preview-row" key={member.personId}><Avatar name={member.name} size="sm" /><span><strong>{member.personId === currentPersonId ? 'You' : member.name}</strong><small>{member.personId === currentPersonId ? `You${member.role === 'owner' ? ' · Owner' : ''}` : member.role === 'owner' ? 'Owner' : 'Member'}</small></span></li>)}{members.length > 4 ? <li className="people-preview-overflow">+{members.length - 4} more people</li> : null}</ul><Link className="inline-action" to={`/groups/${id}/manage#people`}>Manage people</Link></section>
      </div>
    </div>
      <Disclosure className="group-overview-tools" summary="More group actions" region="admin"><nav className="group-tools" aria-label="More group actions"><Link className="group-tool-row" to={`/activity?group=${encodeURIComponent(id)}&view=insights&period=all`}>View spending insights</Link><Link className="group-tool-row" to={`/groups/${id}/credit/new`}>Record credit</Link><Link className="group-tool-row" to={`/activity?group=${encodeURIComponent(id)}&view=changes`}>Group history</Link><Link className="group-tool-row" to={`/groups/${id}/manage#settings`}>Group settings</Link></nav></Disclosure>

  </Layout>;
}

function TransactionRow({ groupId, transaction, showNotes = false, currentPersonId, overview = false }: { groupId: string; transaction: Transaction; showNotes?: boolean; currentPersonId?: string; overview?: boolean }) {
  const path = transaction.kind === 'expense' ? expenseDetailPath(groupId, transaction.id) : transaction.kind === 'settlement' ? settlementDetailPath(groupId, transaction.id) : creditDetailPath(groupId, transaction.id);
  const category = transactionCategory(transaction);
  const note = showNotes ? transactionNote(transaction) : undefined;
  const overviewContext = transactionPeople(transaction) || transactionContext(transaction, currentPersonId)[0];
  const content = overview
    ? <><span className="transaction-row__overview-copy"><strong>{transactionTitle(transaction)}</strong><small>{transactionDate(transaction)}{overviewContext ? ` · ${overviewContext}` : ''}</small>{category ? <span className="transaction-row__category">{category}</span> : null}</span><Money amountMinor={transaction.amountMinor} currency={transaction.currency} tone={transaction.kind === 'settlement' ? 'positive' : undefined} /></>
    : <><span><strong>{transactionTypeLabel(transaction)} · {transactionTitle(transaction)}</strong>{transaction.groupName ? <small>{transaction.groupName}</small> : null}<small>{transactionDate(transaction)}{transactionPeople(transaction) ? ` · ${transactionPeople(transaction)}` : ''}</small>{transactionContext(transaction, currentPersonId).map((line) => <small key={line}>{line}</small>)}{category ? <small className="transaction-row__category">Category: {category}</small> : null}{note ? <small className="transaction-row__notes">Note: {note}</small> : null}</span><Money amountMinor={transaction.amountMinor} currency={transaction.currency} tone={transaction.kind === 'settlement' ? 'positive' : undefined} /> </>;
  return path ? <Link className={`ui-ledger-row transaction-row${overview ? ' transaction-row--overview' : ''}`} data-transaction-kind={transaction.kind} to={path}>{content}</Link> : <div className={`ui-ledger-row transaction-row${overview ? ' transaction-row--overview' : ''}`} data-transaction-kind={transaction.kind}>{content}</div>;
}

function TransactionFilterDisclosure({ filterKey, filterCount, offline, children }: { filterKey: string; filterCount: number; offline: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(filterCount > 0);
  useEffect(() => { if (filterCount > 0) setOpen(true); }, [filterCount, filterKey]);
  return <Disclosure className="transaction-filters-disclosure" open={open} onToggle={(event) => setOpen(event.currentTarget.open)} summary={<>Search and filters{filterCount ? ` · ${filterCount} active filter${filterCount === 1 ? '' : 's'}` : ''}</>}>{offline ? <p className="cache-status">Server filters are unavailable offline. Reconnect to search history.</p> : null}{children}</Disclosure>;
}


function PendingExpenseRow({ item, groupName }: { item: ExpenseOutboxItem; groupName?: string }) {
  const connection = useConnectionState();
  const canMutate = useOnlineStatus();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const syncing = item.status === 'syncing' && (item.leaseExpiresAt === undefined || item.leaseExpiresAt > Date.now());
  const cannotDiscard = syncing || Boolean(item.deliveryUncertain);
  const explanation = syncing ? 'An in-flight server write cannot be safely cancelled.' : item.deliveryUncertain ? 'The server may have committed this expense; retry or wait for reconciliation.' : undefined;
  const retry = async () => { setError(undefined); setBusy(true); try { await retryOutboxItem(item.clientOperationId); } catch (cause) { setError(cause); } finally { setBusy(false); } };
  const discard = async () => { if (!confirm('Discard this pending expense?')) return; setError(undefined); setBusy(true); try { await discardOutboxItem(item.clientOperationId); } catch (cause) { setError(cause); } finally { setBusy(false); } };
  return <LedgerRow as="div" className="pending-row"><span>{item.display.description}{groupName ? <small>{groupName}</small> : null}<small>{item.display.date} · {item.display.currency} · <Status tone={item.status === 'failed' ? 'debt' : 'warning'}>{statusLabel(item.status, item.deliveryUncertain)}</Status></small>{item.lastError ? <small>{item.lastError.message}</small> : null}{explanation ? <small>{explanation}</small> : null}{error ? <ErrorBox error={error} id={`pending-error-${item.clientOperationId}`} /> : null}</span><div className="pending-row__actions"><Money amountMinor={item.display.amountMinor} currency={item.display.currency} />{connection.status !== 'offline' ? <Button disabled={!canMutate || syncing || busy} type="button" variant="secondary" onClick={() => void retry()}>Retry</Button> : null}<Button disabled={cannotDiscard || busy} title={explanation} type="button" variant="danger" onClick={() => void discard()}>Discard</Button></div></LedgerRow>;
}

function ScheduleStatus({ status }: { status: ScheduledExpenseStatus }) {
  const tone = status === 'active' ? 'positive' : status === 'cancelled' ? 'neutral' : 'warning';
  return <Status tone={tone}>{status[0].toUpperCase() + status.slice(1)}</Status>;
}

type ScheduleListProps = { groupId: string; schedules: ScheduledExpense[]; resource: ResourceSnapshot<{ scheduledExpenses: ScheduledExpense[]; nextCursor?: string }>; online: boolean; userId: string };
function CompactScheduleList(props: ScheduleListProps) {
  const connection = useConnectionState();
  const active = props.schedules.filter((schedule) => schedule.status === 'active');
  const orderedActive = active.map((schedule, index) => ({ schedule, index })).sort((left, right) => {
    const leftDate = left.schedule.nextOccurrenceDate;
    const rightDate = right.schedule.nextOccurrenceDate;
    if (!leftDate && !rightDate) return left.index - right.index;
    if (!leftDate) return 1;
    if (!rightDate) return -1;
    return leftDate.localeCompare(rightDate) || left.index - right.index;
  }).map(({ schedule }) => schedule);
  const preview = orderedActive.slice(0, 2);
  const next = orderedActive.map((schedule) => schedule.nextOccurrenceDate).filter((date): date is string => Boolean(date))[0];
  const scheduleContent = props.resource.data === undefined
    ? connection.status === 'offline'
      ? <p className="cache-status">Scheduled expenses need a connection and are not cached on this device.</p>
      : <ResourceNotice resource={props.resource} label="scheduled expenses" retry={retryFor(resourceKeys.scheduledExpenses(props.userId, props.groupId), props.userId)} />
    : active.length
      ? <ul className="schedule-overview-list" aria-label="Active scheduled expenses">{preview.map((schedule) => <li className="schedule-overview-row" key={schedule.id}><span className="schedule-overview-row__rail" aria-hidden="true" /><span className="schedule-overview-row__copy"><strong>{schedule.description}</strong><small><Money amountMinor={schedule.amountMinor} currency={schedule.currency} /> · {scheduleSummary(schedule.frequency, schedule.interval, schedule.weekdays)}</small><small>{schedule.nextOccurrenceDate ? `Next occurrence ${formatScheduleDate(schedule.nextOccurrenceDate)}` : 'No future occurrences'}</small></span><ScheduleStatus status={schedule.status} /></li>)}</ul>
      : <Empty>No active scheduled expenses.</Empty>;
  return <section className="scheduled-summary group-overview-card group-overview-card--schedules" aria-labelledby="scheduled-summary-heading"><SectionHeader title={<span id="scheduled-summary-heading">Scheduled expenses</span>} description={props.resource.data !== undefined ? scheduleOverviewMetadata(active.length, next, Boolean(props.resource.data.nextCursor)) : undefined} />{scheduleContent}{props.resource.data !== undefined ? <Disclosure summary="View all schedules"><div className="schedule-list-content"><ScheduleList {...props} /></div></Disclosure> : null}</section>;
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
  if (resource.data === undefined && connection.status === 'offline') return <section className="schedule-management-section" aria-labelledby="scheduled-expenses-heading"><SectionHeader title={<span id="scheduled-expenses-heading">Scheduled expenses</span>} description="Online-only" /><p className="cache-status">Scheduled expenses need a connection and are not cached on this device.</p></section>;
  return <section className="schedule-management-section" aria-labelledby="scheduled-expenses-heading"><SectionHeader title={<span id="scheduled-expenses-heading">Scheduled expenses</span>} description="Online-only" />{resource.data === undefined ? <ResourceNotice resource={resource} label="scheduled expenses" retry={retryFor(resourceKeys.scheduledExpenses(userId, groupId), userId)} /> : schedules.length ? <LedgerList label="Scheduled expenses">{schedules.map((schedule) => <LedgerRow as="li" className="schedule-row" key={schedule.id}><span><strong>{schedule.description}</strong><small>{scheduleSummary(schedule.frequency, schedule.interval, schedule.weekdays)} · {schedule.timezone}</small><small>{schedule.nextOccurrenceDate ? `Next occurrence ${formatScheduleDate(schedule.nextOccurrenceDate)}` : 'No future occurrences'}</small><small><ScheduleStatus status={schedule.status} />{schedule.blockedReason ? ` ${schedule.blockedReason}` : null}</small></span><div className="schedule-row__actions"><Money amountMinor={schedule.amountMinor} currency={schedule.currency} /><Link className="button button--secondary" to={`/groups/${groupId}/scheduled-expense/${schedule.id}`}>Edit</Link>{schedule.status === 'active' ? <Button type="button" variant="secondary" disabled={!online || busyId === schedule.id} onClick={() => void updateStatus(schedule, 'pause')}>Pause</Button> : schedule.status === 'paused' || schedule.status === 'blocked' ? <Button type="button" variant="secondary" disabled={!online || busyId === schedule.id} onClick={() => void updateStatus(schedule, 'resume')}>Resume</Button> : null}{schedule.status !== 'cancelled' ? <Button type="button" variant="danger" disabled={!online || busyId === schedule.id} onClick={() => void updateStatus(schedule, 'cancel')}>Cancel</Button> : null}</div></LedgerRow>)}</LedgerList> : <Empty>No recurring expenses yet.</Empty>}{error ? <ErrorBox error={error} id="scheduled-expense-mutation-error" /> : null}{!online ? <p className="cache-status">Schedule management requires a connection. Existing schedules are not stored for offline use.</p> : null}</section>;
}

type PayerRow = { personId: string; amount: string };
type ExpenseErrorTarget = 'description' | 'amount' | 'participants' | 'payers' | 'allocation' | 'form';
type ExpenseFormError = { error: unknown; target: ExpenseErrorTarget };
type SplitDefaultSaveState = { status: 'idle' | 'saving' | 'success' | 'error'; error?: unknown };

function TransactionChooser() {
  const { id: routeId } = useParams();
  const id = routeId === 'new' ? undefined : routeId;
  const online = useOnlineStatus();
  const me = useResource(resourceKeys.identity(), '', (signal) => getMe({ signal }), RESOURCE_FRESHNESS.expenses, hydrateIdentity);
  const groups = useResource<{ groups: Group[] }>(resourceKeys.groups(me.data?.id || 'pending'), me.data?.id, (signal) => getGroups(signal), RESOURCE_FRESHNESS.groups, me.data?.id ? () => hydrateGroups(me.data!.id) : undefined);
  const contextualGroup = useResource<GroupResponse | null>(resourceKeys.group(me.data?.id || 'pending', id || 'chooser-none'), me.data?.id, (signal) => id ? getGroup(id, signal) : Promise.resolve(null), RESOURCE_FRESHNESS.group, me.data?.id && id ? () => hydrateGroup(me.data!.id, id) : undefined);
  const group = id ? contextualGroup.data?.group || groups.data?.groups.find((candidate) => candidate.id === id) : undefined;
  const options = (groupId: string) => { const navigation = getTransactionNavigation(groupId, online); return <div className="chooser-options" data-flow-region="frequent">{groups.error ? <p className="cache-status" role="status">Showing cached groups; refresh is unavailable.</p> : null}<Link className="button" data-primary-action="true" to={navigation.primaryPath}>Expense</Link>{navigation.options.map((option) => option.disabled || !option.path ? <Button key={option.value} type="button" variant="secondary" disabled title={option.label}>{option.label}</Button> : <Link key={option.value} className="button button--secondary" to={option.path}>{option.label}</Link>)}{!online ? <p className="muted" role="status">Refunds and payments are online-only. New expenses remain available offline.</p> : null}</div>; };
  if ((me.error && !me.data) || (id && contextualGroup.error && !contextualGroup.data && !group) || (!id && groups.error && !groups.data)) return <Layout><ErrorBox error={me.error || contextualGroup.error || groups.error} onRetry={retryFor(id ? resourceKeys.group(me.data?.id || 'pending', id) : resourceKeys.groups(me.data?.id || 'pending'), me.data?.id)} id="transaction-chooser-error" /></Layout>;
  if (!id && !groups.data) return <Layout><Loading /></Layout>;
  return <Layout><Link className="back" to={id ? `/groups/${id}` : '/'}>← {id ? 'Group' : 'Groups'}</Link><PageHeader className="page-title" eyebrow="Quick ledger action" title="Add transaction" /><FormSurface><p className="muted">Choose what happened. Refunds and reimbursements can start from an expense, or be recorded for more than one expense.</p>{id ? group ? <><h2>{groupDisplayName(group)}</h2>{options(id)}</> : <p role="alert">This group is unavailable. Reconnect or return to Groups; no other group actions are shown.</p> : (groups.data?.groups || []).length ? <div className="chooser-groups">{sortOptionsByLabel(groups.data?.groups || [], groupDisplayName, (candidate) => candidate.id).map((candidate) => <section key={candidate.id}><h2>{groupDisplayName(candidate)}</h2>{options(candidate.id)}</section>)}</div> : <Empty>No groups yet. <Link to="/groups/new">Create a group</Link> or <Link to="/friends/new">add a friend</Link>.</Empty>}</FormSurface></Layout>;
}

function OneTimeOnlyDetails({ category, notes, customCategories = [], showNotes = true, suggested = false, onCategoryChange, onNotesChange }: { category: string; notes: string; customCategories?: string[]; showNotes?: boolean; suggested?: boolean; onCategoryChange: (value: string) => void; onNotesChange: (value: string) => void }) {
  const options = categoryOptions(customCategories);
  const custom = Boolean(category && !options.includes(category));
  const other = custom || category === 'Other';
  return <fieldset className="one-time-only-details" aria-describedby="one-time-only-details-help"><legend>Expense details</legend><p id="one-time-only-details-help" className="muted">{showNotes ? 'Categories are saved with expenses. Notes are saved for one-time expenses only. Choose a category to make future entries faster. Categories are private to your account.' : 'Categories are saved with scheduled expenses. Notes are available for one-time expenses only. Categories are private to your account.'}</p>{suggested ? <p className="muted" role="status">Suggested from past expenses.</p> : null}<Field label="Category" className="field--compact"><select value={custom ? 'Other' : category} onChange={(event) => onCategoryChange(event.target.value)}><option value="">Choose a category</option>{options.map((option) => <option key={option} value={option}>{option}</option>)}</select></Field>{other ? <Field label="Custom category" className="field--compact"><input className="category" required value={custom ? category : ''} onChange={(event) => onCategoryChange(event.target.value)} placeholder="Enter a category" /></Field> : null}{showNotes ? <Field label="Notes (optional)" className="field--compact"><textarea className="notes" rows={3} value={notes} onChange={(event) => onNotesChange(event.target.value)} /></Field> : null}</fieldset>;
}

function CreditDetail() {
  const { creditId = '' } = useParams();
  const nav = useNavigate();
  const online = useOnlineStatus();
  const me = useResource(resourceKeys.identity(), '', (signal) => getMe({ signal }), RESOURCE_FRESHNESS.expenses, hydrateIdentity);
  const details = useResource<{ credit: Credit; history: Array<{ id: string; revision: number; createdAt: string }> }>(resourceKeys.creditDetail(me.data?.id || 'pending', creditId), me.data?.id, (signal) => getCreditDetails(creditId, signal), RESOURCE_FRESHNESS.expenseDetail);
  const credit = details.data?.credit;
  const group = useResource<GroupResponse>(resourceKeys.group(me.data?.id || 'pending', credit?.groupId || 'missing'), me.data?.id, (signal) => credit ? getGroup(credit.groupId, signal) : Promise.reject(new Error('Group unavailable')), RESOURCE_FRESHNESS.group);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  if ((details.error || me.error) && !credit) return <Layout><ErrorBox error={details.error || me.error} onRetry={retryFor(details.error ? resourceKeys.creditDetail(me.data?.id || 'pending', creditId) : resourceKeys.identity(), me.data?.id)} id="refund-detail-error" /><Link className="back" to="/">← Groups</Link></Layout>;
  if (!credit) return <Layout><Loading /></Layout>;
  const detailPeople = [...(group.data?.members || []), ...(group.data?.historicalParticipants || []).filter((participant) => !(group.data?.members || []).some((member) => member.personId === participant.personId)).map((participant) => ({ ...participant, name: historicalParticipantName(participant) }))];
  const label = (personId: string) => personId === group.data?.currentPersonId ? 'You' : nameOf(detailPeople, personId);
  const remove = async () => { if (!online || busy || !confirm('Delete this refund/reimbursement?')) return; setBusy(true); setError(undefined); const generation = captureSessionGeneration(); const mutationUserId = me.data?.id; try { await deleteCredit(credit.id, credit.version); if (!isSessionGenerationCurrent(generation)) return; await invalidateForMutation.creditChanged(credit.groupId, mutationUserId, credit.id, generation); if (isSessionGenerationCurrent(generation)) nav(`/groups/${credit.groupId}`); } catch (cause) { setError(cause); } finally { setBusy(false); } };
  const restore = async () => { if (!online || busy) return; setBusy(true); setError(undefined); const generation = captureSessionGeneration(); const mutationUserId = me.data?.id; try { await restoreCredit(credit.id, credit.version); if (!isSessionGenerationCurrent(generation)) return; await invalidateForMutation.creditChanged(credit.groupId, mutationUserId, credit.id, generation); } catch (cause) { setError(cause); } finally { setBusy(false); } };
  const recipients = credit.allocations.filter((allocation) => allocation.allocationType === 'recipient');
  const affected = credit.allocations.filter((allocation) => allocation.allocationType === 'beneficiary');
  return <Layout><Link to={`/groups/${credit.groupId}`} className="back">← Group</Link><PageHeader className="page-title" eyebrow={`${credit.date} · Refund/reimbursement`} title={credit.deliveryMode === 'direct_provider_offset' ? 'Original payment or bill was adjusted' : 'A group member received the money'} actions={<Money amountMinor={credit.amountMinor} currency={credit.currency} size="large" />} />{!online ? <ConnectionBanner detail="Refund changes require a connection." /> : null}{details.error || group.error ? <p className="cache-status" role="status">Showing cached refund details; names or linked expenses may be out of date.</p> : null}{credit.deletedAt ? <Surface className="credit-detail-tombstone"><strong>Deleted refund/reimbursement</strong><p className="muted">This record can be restored within 30 days.</p><ActionGroup><Button disabled={!online || busy} onClick={() => void restore()}>{busy ? 'Restoring…' : 'Restore refund/reimbursement'}</Button></ActionGroup></Surface> : <><Surface className="credit-detail-surface"><SectionHeader title="Money flow" />{credit.note ? <p>{credit.note}</p> : <p className="muted">No note was added.</p>}<p>Refund/reimbursement total: <Money amountMinor={credit.amountMinor} currency={credit.currency} /></p><p className="muted">This reduces the affected costs by the same amount in the group balance.</p></Surface><Surface className="credit-detail-surface"><SectionHeader title="Linked expenses" />{credit.applications.length ? <LedgerList label="Linked expenses">{credit.applications.map((application) => <LedgerRow as="li" key={application.expenseId}><Link className="ui-ledger-row__link" to={expenseDetailPath(credit.groupId, application.expenseId) || `/groups/${credit.groupId}`}><span><strong>{application.expenseDescription || 'Expense'}</strong>{application.expenseDate ? <small>{application.expenseDate}</small> : null}</span><Money amountMinor={application.amountMinor} currency={credit.currency} /></Link></LedgerRow>)}</LedgerList> : <p className="muted">Standalone refund/reimbursement.</p>}</Surface>{credit.deliveryMode === 'member_reimbursement' ? <Surface><SectionHeader title="Who received the money?" /><LedgerList label="Recipients">{recipients.map((allocation) => <LedgerRow key={`recipient-${allocation.personId}`}><span>{label(allocation.personId)}</span><Money amountMinor={allocation.amountMinor} currency={credit.currency} /></LedgerRow>)}</LedgerList><SectionHeader title="Whose costs did this reduce?" /><LedgerList label="Affected members">{affected.map((allocation) => <LedgerRow key={`affected-${allocation.personId}`}><span>{label(allocation.personId)}</span><Money amountMinor={allocation.amountMinor} currency={credit.currency} /></LedgerRow>)}</LedgerList></Surface> : <Surface><SectionHeader title="Original payment or bill was adjusted" /><p className="muted">The original payer and affected shares were derived from the linked expenses and saved with this refund.</p></Surface>}<ActionGroup><Link className="button button--secondary" to={`/groups/${credit.groupId}/credit/${credit.id}/edit`}>Edit refund/reimbursement</Link><Button type="button" variant="danger" disabled={!online || busy} onClick={() => void remove()}>{busy ? 'Deleting…' : 'Delete refund/reimbursement'}</Button></ActionGroup></>}{error ? <ErrorBox error={error} id="refund-detail-action-error" /> : null}<Disclosure className="reading-width" summary="Audit history">{details.data?.history.length ? <LedgerList label="Refund revisions">{details.data.history.map((item) => <LedgerRow key={item.id}><span>Version {item.revision}</span><small>{new Date(item.createdAt).toLocaleString()}</small></LedgerRow>)}</LedgerList> : <p className="muted">No audit history.</p>}</Disclosure></Layout>;
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
  const groupResource = useResource<GroupResponse>(resourceKeys.group(formUserId, id || 'none'), meResource.data?.id, (signal) => id ? getGroup(id, signal) : Promise.resolve({ group: undefined as unknown as Group, members: [], historicalParticipants: [], splitDefault: null, currentPersonId: null }), RESOURCE_FRESHNESS.group, meResource.data?.id && id ? () => hydrateGroup(meResource.data!.id, id) : undefined);
  const detailResource = useResource<{ expense: Expense; history: Array<{ id: string; revision: number; createdAt: string }> }>(resourceKeys.expenseDetail(formUserId, expenseId || 'new'), meResource.data?.id, async (signal) => expenseId ? getExpenseDetails(expenseId, signal) : { expense: undefined as unknown as Expense, history: [] }, RESOURCE_FRESHNESS.expenseDetail, expenseId && meResource.data?.id ? () => hydrateExpenseDetails(meResource.data!.id, expenseId) : undefined);
  const scheduleResource = useResource<{ scheduledExpense: ScheduledExpense }>(resourceKeys.scheduledExpense(formUserId, scheduledExpenseId || 'new'), meResource.data?.id, async (signal) => scheduledExpenseId ? getScheduledExpense(scheduledExpenseId, signal) : { scheduledExpense: undefined as unknown as ScheduledExpense }, RESOURCE_FRESHNESS.scheduledExpenses);
  const group = groupResource.data?.group;
  const members = groupResource.data?.members || [];
   const currentPersonId = groupResource.data?.currentPersonId || '';
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
  const [splitCustomized, setSplitCustomized] = useState(false);
  const [defaultApplied, setDefaultApplied] = useState(false);
  const [defaultInvalid, setDefaultInvalid] = useState(false);
  const [updatedElsewhere, setUpdatedElsewhere] = useState(false);
  const [formReady, setFormReady] = useState(false);
  const [savedPartyDefault, setSavedPartyDefault] = useState<GroupSplitDefault>();
  const [splitDefaultSaveState, setSplitDefaultSaveState] = useState<SplitDefaultSaveState>({ status: 'idle' });
  const routeKey = `${formUserId}:${id}:${scheduledExpenseId ? `schedule:${scheduledExpenseId}` : `expense:${expenseId || 'new'}`}`;
  const timezoneLabelDate = useMemo(() => new Date(), []);
  const availableTimezoneOptions = useMemo(() => scheduleMode ? timezoneOptions(usingCustomTimezone ? [] : [timezone]) : [], [scheduleMode, timezone, usingCustomTimezone]);
  const timezoneSelectOptions = useMemo(() => availableTimezoneOptions.map((zone) => ({ zone, label: timezoneLabel(zone, timezoneLabelDate) })), [availableTimezoneOptions, timezoneLabelDate]);
  const timezoneSelectValue = timezoneSelectValueForState(timezone, availableTimezoneOptions, usingCustomTimezone);
  const selectedTimezone = timezoneValueFromSelection(timezoneSelectValue, customTimezone);
  const initializedRoute = useRef<string | undefined>(undefined);
  const initializedVersion = useRef<number | undefined>(undefined);
  const formSaveToken = useRef(0);
  const splitDefaultRequestToken = useRef(0);
  const splitDefaultSavePending = useRef<string | undefined>(undefined);
  const splitDefaultScopeRef = useRef(routeKey);
  splitDefaultScopeRef.current = routeKey;
  const categoryTouchedRef = useRef(false);
  const suggestionRequest = useRef<AbortController>();
  const newEntry = !expenseId && !scheduledExpenseId;
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
     formSaveToken.current += 1; splitDefaultRequestToken.current += 1;
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
     setSplitCustomized(false); setDefaultApplied(false); setDefaultInvalid(false);
     setSavedPartyDefault(undefined); setSplitDefaultSaveState({ status: 'idle' });
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

       formSaveToken.current += 1; splitDefaultRequestToken.current += 1;
      const loadedMethod = (expense || schedule)?.splits[0]?.metadata?.method;
    const nextMethod: SplitMethod = loadedMethod === 'exact' || loadedMethod === 'percentage' || loadedMethod === 'shares' ? loadedMethod : 'equal';
     setCurrency(expense?.currency ?? schedule?.currency ?? groupResult.group.currency);
      if (expense || schedule) {
        const record = expense || schedule!;
         setDescription(record.description); setAmount(moneyInput(record.amountMinor)); setDate('date' in record ? record.date : record.startDate); setCategory('category' in record ? record.category || '' : ''); categoryTouchedRef.current = true; setCategoryTouched(true); setCategorySuggestion(undefined); setNotes('notes' in record ? record.notes || '' : ''); setMethod(nextMethod); setSelected(record.splits.map((split) => split.personId)); setAllocationValues(allocationStateFromSplits(record.splits, nextMethod)); setExistingSplitMetadata(allocationMetadataByPerson(record.splits)); setVersion(record.version); setPayerRows(record.payers.map((payer) => ({ personId: payer.personId, amount: moneyInput(payer.amountMinor) })));
        setRecurrenceEnabled(Boolean(schedule));
       if ('startDate' in record) { setEndDate(record.endDate || ''); setFrequency(record.frequency); setInterval(String(record.interval)); setWeekdays(record.weekdays); setTimezone(record.timezone); setCustomTimezone(''); setUsingCustomTimezone(false); }
      } else {
           const payer = currentPayerSelection(groupResult.currentPersonId || undefined, groupResult.members), resolvedDefault = resolveGroupSplitDefault(groupResult.splitDefault, groupResult.members);
          const defaultTimezone = browserTimezone(); setDescription(''); setAmount(''); setDate(scheduleMode ? localDateForTimeZone(new Date(), defaultTimezone) : today()); setRecurrenceEnabled(legacyRecurring); setEndDate(''); setFrequency('monthly'); setInterval('1'); setWeekdays([]); setTimezone(defaultTimezone); setCustomTimezone(''); setUsingCustomTimezone(false); setCategory(''); categoryTouchedRef.current = false; setCategoryTouched(false); setCategorySuggestion(undefined); setNotes(''); setMethod(resolvedDefault.method); setAllocationValues(resolvedDefault.values); setExistingSplitMetadata({}); setVersion(undefined); setSelected(resolvedDefault.selected); setDefaultApplied(resolvedDefault.applied); setDefaultInvalid(resolvedDefault.invalid); setPayerRows(payer ? [{ personId: payer, amount: '' }] : []);
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
    if (!group && isGlobalNewExpense) return <Layout><PageHeader className="page-title" eyebrow="New expense" title="Add expense" /><FormSurface className="expense-target-surface">{groupsResource.data?.groups.length ? <Field label="Group / person"><select required aria-label="Expense group" value={id} onChange={(event) => setTargetGroupId(event.target.value)}><option value="" disabled>Choose a group</option>{sortOptionsByLabel(groupsResource.data.groups, groupDisplayName, (option) => option.id).map((option) => <option value={option.id} key={option.id}>{groupDisplayName(option)}</option>)}</select></Field> : groupsResource.data !== undefined ? <Empty>No groups yet. <Link to="/groups/new">Create a group</Link> or <Link to="/friends/new">add a friend</Link> to get started.</Empty> : <ResourceNotice resource={groupsResource} label="groups" retry={retryFor(resourceKeys.groups(formUserId), meResource.data?.id)} />}</FormSurface></Layout>;
   if (!group) return <Layout><Loading /></Layout>;
  if (!routeReady) return <Layout><Loading /></Layout>;
  const offlineData = Boolean(groupResource.offline || meResource.offline || detailResource.offline);
   const editUnavailable = scheduleMode ? !online : Boolean(expenseId) && (!online || offlineData);
    const amountMinor = amount.trim() ? (() => { try { return parseMoney(amount, currency); } catch { return undefined; } })() : undefined;
     const preview = amountMinor === undefined ? neutralAllocationPreview() : previewAllocation(amountMinor, selected, method, allocationValues, currency);
     const storedPartyDefault = savedPartyDefault || groupResource.data?.splitDefault || null;
     const draftDefault = groupSplitDefaultFromDraft(method, selected, allocationValues, members);
    const effectiveDefault = effectiveGroupSplitDefault(storedPartyDefault, members);
    const draftIsSaveable = Boolean(draftDefault.value);
     const choiceState = splitDefaultChoiceState({ newEntry, scheduleMode, method, saveable: draftIsSaveable, draft: draftDefault.value, effective: effectiveDefault, selected, values: allocationValues, members });
     const savePartyDefault = async (arrangement: GroupSplitDefault | null = draftDefault.value) => {
        const saveScope = routeKey;
       if (!online || splitDefaultSaveState.status === 'saving' || isSplitDefaultSaveLockedForScope(splitDefaultSavePending.current, saveScope) || !arrangement) return;
        splitDefaultSavePending.current = saveScope;
        const saveGroupId = id;
        const saveUserId = currentUserId;
        const generation = captureSessionGeneration();
        const draftToken = formSaveToken.current;
        const saveFence: FormSaveFence = { token: ++splitDefaultRequestToken.current, scope: saveScope, sessionGeneration: generation };
        setSplitDefaultSaveState({ status: 'saving' });
       try {
         const parsed = groupSplitDefaultInput.parse({ method: arrangement.method, person_ids: arrangement.personIds, ...('values' in arrangement ? { values: arrangement.values } : {}) });
         const result = await updateGroupSplitDefault(saveGroupId, parsed);
          const outcome = splitDefaultSaveOutcome(saveFence, { token: splitDefaultRequestToken.current, scope: splitDefaultScopeRef.current, sessionGeneration: captureSessionGeneration() }, draftToken, formSaveToken.current);
         if (outcome.requestCurrent) {
             setSavedPartyDefault(result.splitDefault); setDefaultApplied(outcome.draftCurrent); setDefaultInvalid(false); if (outcome.draftCurrent) setSplitCustomized(false); setSplitDefaultSaveState({ status: 'success' });
         }
         if (isSessionGenerationCurrent(generation)) await invalidateForMutation.splitDefaultChanged(saveGroupId, result.splitDefault, saveUserId, generation);
       } catch (cause) {
          if (isCurrentSplitDefaultSave(saveFence, { token: splitDefaultRequestToken.current, scope: splitDefaultScopeRef.current, sessionGeneration: captureSessionGeneration() })) setSplitDefaultSaveState({ status: 'error', error: cause });
       } finally {
         splitDefaultSavePending.current = releaseSplitDefaultSaveLock(splitDefaultSavePending.current, saveScope);
       }
     };
   const isYou = (personId: string) => personId === currentPersonId;
  const setAmountAndPayer = (value: string) => { markDirty(); setAmount(value); if (payerRows.length === 1) setPayerRows((rows) => rows.map((row) => ({ ...row, amount: value }))); };
    const markSplitDirty = () => { formSaveToken.current += 1; markDirty(); setSplitCustomized(true); setDefaultApplied(false); setSplitDefaultSaveState((current) => current.status === 'saving' ? current : { status: 'idle' }); };
   const toggleSplit = (personId: string) => { markSplitDirty(); setSelected((current) => current.includes(personId) ? current.filter((idValue) => idValue !== personId) : [...current, personId]); };
   const updateAllocation = (personId: string, value: string) => { markSplitDirty(); setAllocationValues((current) => ({ ...current, [personId]: value })); };
  const addPayer = () => { const personId = members.find((member) => !payerRows.some((payer) => payer.personId === member.personId))?.personId; if (personId) { markDirty(); setPayerRows((rows) => [...rows, { personId, amount: '' }]); } };
  const removePayer = (index: number) => { markDirty(); setPayerRows((rows) => normalizeSinglePayer(rows.filter((_, rowIndex) => rowIndex !== index), amount)); };
   const resetToServer = () => { setDirty(false); setUpdatedElsewhere(false); setFormError(undefined); };
      const resetToPartyDefault = () => { formSaveToken.current += 1; const resolved = resolveGroupSplitDefault(storedPartyDefault, members); setMethod(resolved.method); setSelected(resolved.selected); setAllocationValues(resolved.values); setSplitCustomized(false); setDefaultApplied(resolved.applied); setDefaultInvalid(resolved.invalid); setSplitDefaultSaveState((current) => current.status === 'saving' ? current : { status: 'idle' }); setDirty(true); setFormError(undefined); };
   const payerIsFullTotal = payerRows.length === 1 && amount.trim() !== '' && (amountMinor ?? 0) > 0 && (() => { try { return parseMoney(payerRows[0].amount, currency) === amountMinor; } catch { return false; } })();
  const payerSummary = payerRows.length === 1 ? `Paid by ${isYou(payerRows[0].personId) ? 'You' : nameOf(members, payerRows[0].personId)}` : payerRows.length ? `Paid by ${payerRows.length} people` : 'Choose who paid';
   const payerSummaryDetail = payerRows.length === 1 ? (payerIsFullTotal ? 'Entire total' : 'Amount needs review') : payerRows.length ? 'Configure exact amounts' : 'Choose a payer';
    const recurring = scheduleMode || recurrenceEnabled;
    const scheduleDraft = { startDate: date, endDate: endDate || null, frequency, interval: Number(interval) || 1, weekdays };
      const schedulePreview = recurring ? (() => { try { return previewScheduleDates(scheduleDraft, localDateForTimeZone(new Date(), selectedTimezone.trim() || 'UTC'), 3); } catch { return previewScheduleDates(scheduleDraft, today(), 3); } })() : [];
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
      setSubmitting(true); setFormError(undefined); const generation = captureSessionGeneration(); const mutationUserId = currentUserId;
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
           if (!isSessionGenerationCurrent(generation)) return;
           await invalidateForMutation.scheduledExpenseChanged(id, mutationUserId, scheduledExpenseId, generation);
           if (!isSessionGenerationCurrent(generation)) return;
         nav(`/groups/${id}`);
       } else {
       if (category === 'Other') throw new Error('Enter a custom category.');
       const input = { description: description.trim(), amount_minor: cents, currency, date, category: category.trim() || null, notes: notes || null, payers, splits, version, client_operation_id: expenseId ? undefined : operation };
          if (expenseId) { await api(`/expenses/${expenseId}`, { method: 'PUT', body: JSON.stringify(input) }); if (!isSessionGenerationCurrent(generation)) return; await invalidateForMutation.expenseChanged(id, expenseId, mutationUserId, generation); if (!isSessionGenerationCurrent(generation)) return; }
        else {
         const me = currentUserId ? { id: currentUserId } : await getMe();
         const payload = input as ExpenseInput;
         await enqueueExpense({ userId: me.id, groupId: id, payload, clientOperationId: operation, display: { description: payload.description, amountMinor: payload.amount_minor, currency: payload.currency, date: payload.date } });
          await flushOutbox();
          if (!isSessionGenerationCurrent(generation)) return;
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
           <PageHeader className="page-title expense-heading" eyebrow={<Link to={routeGroupId ? `/groups/${id}` : '/'} className="back">← <span className="back__label">{routeGroupId ? groupDisplayName(group) : 'Groups'}</span></Link>} title={scheduleMode ? (scheduledExpenseId ? 'Edit recurring expense' : 'Schedule an expense') : expenseId ? 'Edit expense' : 'Add expense'} actions={<ActionGroup className="expense-heading__actions"><Link className="button button--secondary" to={routeGroupId ? `/groups/${id}` : '/'}>Cancel</Link></ActionGroup>} />{meResource.error ? <CachedIdentityNotice resource={meResource} id="expense-identity-error" /> : null}{groupResource.error ? <ResourceNotice resource={groupResource} label="group details" retry={retryFor(resourceKeys.group(formUserId, id), meResource.data?.id)} /> : null}{expenseId && detailResource.error ? <ResourceNotice resource={detailResource} label="expense form data" retry={retryFor(resourceKeys.expenseDetail(formUserId, expenseId), meResource.data?.id)} /> : null}{scheduledExpenseId && scheduleResource.error ? <ResourceNotice resource={scheduleResource} label="scheduled expense form data" retry={retryFor(resourceKeys.scheduledExpense(formUserId, scheduledExpenseId), meResource.data?.id)} /> : null}
          {updatedElsewhere ? <div className="offline-banner updated-elsewhere" role="status"><span>Updated elsewhere. Your changes are preserved.</span><Button type="button" variant="secondary" onClick={resetToServer}>Reload</Button></div> : null}{editUnavailable ? <ConnectionBanner detail={scheduleMode ? 'Schedule management is online-only. Reconnect before saving changes.' : 'Editing expenses is online-only. Reconnect before saving changes.'} /> : null}<FormSurface className="expense-form-surface"><form className="expense-form reading-width" onSubmit={submit} aria-describedby={formError ? 'expense-form-error' : preview.error ? 'allocation-error' : undefined}>
           {!expenseId && !scheduledExpenseId ? <Field label="Group / person" className="field--compact"><select required aria-label="Expense group" value={id} onChange={(event) => { setTargetGroupId(event.target.value); setDirty(false); }}><option value="" disabled>Choose a group</option>{sortOptionsByLabel(groupsResource.data?.groups || [], groupDisplayName, (option) => option.id).map((option) => <option value={option.id} key={option.id}>{groupDisplayName(option)}</option>)}</select></Field> : null}
          <Field label="Amount and currency" className={amountFieldClass(amount)}><CurrencySelect value={currency} onChange={(value) => { markDirty(); setCurrency(value); }} /><input id="expense-amount" className={amountInputClass(amount)} data-amount-length={amountInputLength(amount)} required inputMode="decimal" aria-label="Expense amount" aria-invalid={formError?.target === 'amount'} aria-describedby={formError?.target === 'amount' ? 'expense-form-error' : undefined} placeholder="0.00" value={amount} onChange={(event) => setAmountAndPayer(event.target.value)} /></Field>
           <Field label="Description" className="field--compact"><input id="expense-description" required aria-invalid={formError?.target === 'description'} aria-describedby={formError?.target === 'description' ? 'expense-form-error' : undefined} placeholder="What was this for?" value={description} onChange={(event) => { const value = event.target.value; markDirty(); setDescription(value); if (!categoryTouchedRef.current) { setCategorySuggestion(undefined); setCategory(''); } }} onBlur={() => void requestCategorySuggestion()} /></Field>{!expenseId && !scheduledExpenseId ? <label className="checkbox-row recurrence-toggle" htmlFor="repeat-expense"><input id="repeat-expense" type="checkbox" checked={recurrenceEnabled} onChange={(event) => { markDirty(); setRecurrenceEnabled(event.target.checked); }} /><span>Repeat this expense</span></label> : null}
        <button className="summary-row" type="button" aria-invalid={formError?.target === 'payers'} aria-describedby={formError?.target === 'payers' ? 'expense-form-error' : undefined} onClick={() => setPayersOpen(true)}><span><span className="summary-row__label">{payerSummary}</span><small>{payerSummaryDetail}</small></span><strong>Change</strong></button>
          {defaultApplied && !choiceState.returnToDefault ? <p className="cache-status" role="status">Party default applied. This saved default affects future entries for everyone. You can override the split for this {scheduleMode ? 'schedule' : 'expense'}.{scheduleMode ? ' This arrangement is copied into the schedule; later default changes will not alter it.' : ''}</p> : null}{defaultInvalid ? <p className="warning" role="alert">The party default includes removed members, so this new entry uses an equal split across all current members. The saved default was not changed.</p> : null}{scheduleMode && splitCustomized ? <p className="cache-status">Custom split for this schedule. <button className="inline-action" type="button" onClick={resetToPartyDefault}>Reset to party default</button></p> : null}{splitDefaultSaveState.status === 'success' ? <p className="cache-status" role="status">Party default saved for everyone.</p> : null}{splitDefaultSaveState.status === 'error' ? <ErrorBox error={splitDefaultSaveState.error} id="split-default-save-error" /> : null}<fieldset aria-describedby={formError?.target === 'participants' ? 'expense-form-error' : undefined}><legend>Split between</legend><div className="participant-list">
          {members.map((member) => { const active = selected.includes(member.personId); return <button className="participant-row" type="button" aria-pressed={active} aria-invalid={formError?.target === 'participants'} key={member.personId} onClick={() => toggleSplit(member.personId)}><span className="participant-row__name"><span className="checkmark" aria-hidden="true">✓</span><span className="participant-row__label">{member.name}</span>{isYou(member.personId) ? <small>You</small> : null}</span>{active && method === 'equal' && preview.allocations[member.personId] !== undefined ? <span className="allocation-row__amount">{formatMoney(preview.allocations[member.personId], currency)}</span> : null}</button>; })}</div></fieldset>
         <div className="secondary-fields"><Field label="Split method" className="field--compact"><select value={method} onChange={(event) => { markSplitDirty(); setMethod(event.target.value as SplitMethod); }}><option value="equal">Equal</option><option value="exact">Exact amounts</option><option value="percentage">Percentage</option><option value="shares">Shares</option></select></Field>
          {method !== 'equal' ? <div className="allocation-list">{members.filter((member) => selected.includes(member.personId)).map((member) => <div className="allocation-row" key={member.personId}><span className="allocation-row__person"><span>{member.name}{isYou(member.personId) ? ' · You' : ''}</span>{preview.allocations[member.personId] !== undefined ? <span className="allocation-row__amount">{formatMoney(preview.allocations[member.personId], currency)}</span> : null}</span><input className={amountInputClass(allocationValues[member.personId] || '')} data-amount-length={amountInputLength(allocationValues[member.personId] || '')} required inputMode="decimal" aria-label={`${member.name} ${method} value`} aria-invalid={Boolean(formError?.target === 'allocation' || preview.error)} aria-describedby={preview.error ? (formError?.target === 'allocation' ? 'expense-form-error' : 'allocation-error') : formError?.target === 'allocation' ? 'expense-form-error' : undefined} placeholder={method === 'exact' ? '0.00' : method === 'percentage' ? '%' : 'Shares'} value={allocationValues[member.personId] || ''} onChange={(event) => updateAllocation(member.personId, event.target.value)} /></div>)}{amountMinor !== undefined ? <p className="allocation-summary" role="status">{method === 'exact' ? `Remaining ${formatMoney(preview.remainingMinor ?? amountMinor, currency)}` : method === 'percentage' ? `Remaining ${preview.remainingPercent ?? 100}%` : `Total shares ${preview.totalValue || 0}`}</p> : null}{preview.error ? <p className="error" id="allocation-error" role="alert">{preview.error}</p> : null}</div> : null}{choiceState.returnToDefault ? <section className="split-default-choices" aria-labelledby="split-default-choices-heading"><p id="split-default-choices-heading" className="muted">{choiceState.makeNewDefault ? 'Use this split for this expense or update the party default.' : draftDefault.reason === 'exact' ? 'This exact split applies only to this expense.' : 'Complete this split before making it the party default.'}</p><div className="actions"><Button type="button" variant="secondary" onClick={resetToPartyDefault}>Return to default</Button>{choiceState.makeNewDefault ? <Button type="button" disabled={!online || splitDefaultSaveState.status === 'saving'} onClick={() => void savePartyDefault()}>{splitDefaultSaveState.status === 'saving' ? 'Saving default…' : 'Make this the new default'}</Button> : null}</div></section> : null}
             {scheduleMode ? <><div className="form-row"><Field label="Start date" className="field--compact"><input required type="date" value={date} onChange={(event) => { markDirty(); setDate(event.target.value); }} /></Field><Field label="End date (optional)" className="field--compact"><input type="date" value={endDate} min={date} onChange={(event) => { markDirty(); setEndDate(event.target.value); }} /></Field></div><div className="form-row"><Field label="Repeats" className="field--compact"><select value={frequency} onChange={(event) => { markDirty(); setFrequency(event.target.value as RecurrenceFrequency); if (event.target.value !== 'weekly') setWeekdays([]); }}><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select></Field><Field label="Every (interval)" className="field--compact"><input required type="number" min="1" max="366" value={interval} onChange={(event) => { markDirty(); setInterval(event.target.value); }} /></Field></div>{frequency === 'weekly' ? <fieldset><legend>On weekdays</legend><div className="weekday-list">{weekdayLabels.map((day) => <label className="checkbox-row" key={day.value}><input type="checkbox" checked={weekdays.includes(day.value)} onChange={() => { markDirty(); setWeekdays((current) => current.includes(day.value) ? current.filter((value) => value !== day.value) : [...current, day.value].sort((a, b) => a - b)); }} />{day.label}</label>)}</div></fieldset> : null}<Field label="Creator timezone" className="field--compact"><select id="creator-timezone" required value={timezoneSelectValue} aria-describedby="timezone-help" onChange={(event) => { markDirty(); if (event.target.value === otherTimezoneValue) { setUsingCustomTimezone(true); setCustomTimezone(''); } else { setUsingCustomTimezone(false); setCustomTimezone(''); setTimezone(event.target.value); } }}>{timezoneSelectOptions.map(({ zone, label }) => <option key={zone} value={zone}>{label}</option>)}<option value={otherTimezoneValue}>Other IANA timezone…</option></select>{usingCustomTimezone ? <input id="custom-timezone" required aria-label="Other IANA timezone" aria-describedby="timezone-help custom-timezone-help" placeholder="America/Los_Angeles" value={customTimezone} onChange={(event) => { markDirty(); setCustomTimezone(event.target.value); }} /> : null}<small id="timezone-help" className="muted">Choose an IANA timezone. Selected: {timezoneLabel(selectedTimezone || 'UTC', timezoneLabelDate)}. Dates are calendar dates in this timezone; the stored value remains the IANA ID.</small>{usingCustomTimezone ? <small id="custom-timezone-help" className="muted">Enter a valid IANA timezone ID, such as America/Los_Angeles.</small> : null}</Field><div className="schedule-preview"><strong>Next dates</strong>{schedulePreview.length ? <ol>{schedulePreview.map((previewDate) => <li key={previewDate}>{formatScheduleDate(previewDate)}</li>)}</ol> : <p className="muted">No occurrences match these settings.</p>}<p className="schedule-preview__continuation">{scheduleContinuationText(endDate, schedulePreview)}</p></div><p className="muted">Only future occurrences use edits. Already generated expenses stay in the ledger; occurrences affect balances only when posted. Creating or changing a schedule never enters the expense outbox.</p><OneTimeOnlyDetails category={category} customCategories={categoriesResource.data?.categories || []} notes={notes} showNotes={false} onCategoryChange={(value) => { markDirty(); setCategory(value); }} onNotesChange={(value) => { markDirty(); setNotes(value); }} /></> : <><div className="form-row"><Field label="Date" className="field--compact"><input required type="date" value={date} onChange={(event) => { markDirty(); setDate(event.target.value); }} /></Field></div>
              <OneTimeOnlyDetails category={category} customCategories={categoriesResource.data?.categories || []} notes={notes} suggested={Boolean(categorySuggestion && !categoryTouched && category === categorySuggestion)} onCategoryChange={manuallySetCategory} onNotesChange={(value) => { markDirty(); setNotes(value); }} /></>}
       </div>
         {formError ? <ErrorBox error={formError.error} id="expense-form-error" /> : null}<Button className="full-width-button" disabled={submitting || editUnavailable} type="submit">{submitting ? 'Saving…' : scheduleMode ? scheduledExpenseId ? 'Save schedule' : 'Create schedule' : expenseId ? 'Save changes' : 'Save expense'}</Button>
     </form></FormSurface>
       {payersOpen && <Modal title="Who paid?" description="Use one payer for a quick entry, or add people and enter exact amounts." onClose={() => setPayersOpen(false)}><div className="payer-list">{payerRows.map((payer, index) => <div className={`payer-row${payerRows.length > 1 ? ' payer-row--removable' : ''}`} key={`${payer.personId}-${index}`}><select aria-label={`Payer ${index + 1}: ${isYou(payer.personId) ? 'You' : nameOf(members, payer.personId)}`} aria-invalid={formError?.target === 'payers'} aria-describedby={formError?.target === 'payers' ? 'expense-form-error' : undefined} value={payer.personId} onChange={(event) => { markDirty(); setPayerRows((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, personId: event.target.value } : row)); }}>{sortOptionsByLabel(members.filter((member) => !payerRows.some((other, otherIndex) => other.personId === member.personId && otherIndex !== index)), (member) => `${member.name}${isYou(member.personId) ? ' · You' : ''}`, (member) => member.personId).map((member) => <option key={member.personId} value={member.personId}>{member.name}{isYou(member.personId) ? ' · You' : ''}</option>)}</select><input className={amountInputClass(payer.amount)} data-amount-length={amountInputLength(payer.amount)} required inputMode="decimal" aria-label={`Amount paid by ${isYou(payer.personId) ? 'You' : nameOf(members, payer.personId)} (payer ${index + 1})`} aria-invalid={formError?.target === 'payers'} aria-describedby={formError?.target === 'payers' ? 'expense-form-error' : undefined} placeholder="Amount" value={payer.amount} onChange={(event) => { markDirty(); setPayerRows((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, amount: event.target.value } : row)); }} />{payerRows.length > 1 && <Button type="button" variant="secondary" aria-label={`Remove payer ${isYou(payer.personId) ? 'You' : nameOf(members, payer.personId)} (payer ${index + 1})`} onClick={() => removePayer(index)}>Remove</Button>}</div>)}</div><p className="allocation-summary" role="status">Payers total {formatMoney(payerRows.reduce((sum, payer) => { try { return sum + parseMoney(payer.amount || '0', currency); } catch { return sum; } }, 0), currency)} {amountMinor !== undefined ? <> of {formatMoney(amountMinor, currency)}</> : null}</p><Button className="full-width-button" type="button" variant="secondary" onClick={addPayer}>+ Add payer</Button><Button className="full-width-button" type="button" onClick={() => setPayersOpen(false)}>Done</Button></Modal>}
  </Layout>;
}

function AuditList({ groupId, entityId, entityType, userId }: { groupId: string; entityId: string; entityType: 'expense' | 'settlement'; userId?: string }) {
  const [open, setOpen] = useState(false);
  return <Disclosure className="audit-disclosure" open={open} onToggle={(event) => setOpen(event.currentTarget.open)} summary="View audit history">{open ? <AuditListContent groupId={groupId} entityId={entityId} entityType={entityType} userId={userId} /> : null}</Disclosure>;
}

function AuditListContent({ groupId, entityId, entityType, userId }: { groupId: string; entityId: string; entityType: 'expense' | 'settlement'; userId?: string }) {
  const resource = useResource<{ audit: AuditDisclosureEvent[]; nextCursor?: string }>(resourceKeys.auditEntity(userId || 'pending', groupId, entityType, entityId), userId, (signal) => getAuditEntityPage(groupId, entityType, entityId, { limit: 50 }, signal), RESOURCE_FRESHNESS.audit);
  const [events, setEvents] = useState<AuditDisclosureEvent[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>();
  const scopeKey = `${userId || 'pending'}:${groupId}:${entityType}:${entityId}`;
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
       const page = await getAuditEntityPage(groupId, entityType, entityId, { cursor: request.cursor }, request.signal);
      if (!pageScope.current.isCurrent(request) || scopeKeyRef.current !== request.key || cursorRef.current !== request.cursor) return;
      cursorRef.current = page.nextCursor;
       setEvents((current) => appendUniquePage(current, page.audit, (event) => `${event.occurredAt}:${event.version}:${event.action}`)); setCursor(page.nextCursor);
    } catch (cause) {
      if (pageScope.current.isCurrent(request) && !(cause instanceof DOMException && cause.name === 'AbortError')) setError(cause);
    }
    finally { if (pageScope.current.isCurrent(request)) setLoading(false); }
  };
  return <section className="reading-section audit"><h2>Audit history</h2><ResourceNotice resource={resource} label="audit history" />{events.length ? <div>{events.map((event, index) => <div className="audit-event" key={`${event.occurredAt}-${event.version}-${event.action}-${index}`}><span><strong>{event.action === 'create' ? 'Added' : event.action === 'update' ? 'Updated' : event.action === 'delete' ? 'Deleted' : 'Restored'} {event.entityType}</strong><small>{event.actorName || 'Unknown user'} · {new Date(event.occurredAt).toLocaleString()}</small>{event.beforeSummary ? <small>Previously: {event.beforeSummary}</small> : null}{event.afterSummary ? <small>Now: {event.afterSummary}</small> : null}</span></div>)}</div> : resource.data !== undefined ? <p className="muted">No audit events in the loaded pages yet.</p> : null}{cursor ? <Button type="button" variant="secondary" disabled={loading} onClick={() => void loadMore()}>{loading ? 'Loading…' : 'Load more audit events'}</Button> : null}{error ? <ErrorBox error={error} id="audit-error" /> : null}</section>;
}

function ExpenseDetail() {
  const online = useOnlineStatus();
  const { id, expenseId = '' } = useParams();
  const nav = useNavigate();
  const me = useResource(resourceKeys.identity(), '', (signal) => getMe({ signal }), RESOURCE_FRESHNESS.expenses, hydrateIdentity);
  const details = useResource<{ expense: Expense; history: Array<{ id: string; revision: number; createdAt: string }> }>(resourceKeys.expenseDetail(me.data?.id || 'pending', expenseId), me.data?.id, (signal) => getExpenseDetails(expenseId, signal), RESOURCE_FRESHNESS.expenseDetail, me.data?.id ? () => hydrateExpenseDetails(me.data!.id, expenseId) : undefined);
  const expense = details.data?.expense;
  const groupId = expense?.groupId || id || '';
  const group = useResource<GroupResponse>(resourceKeys.group(me.data?.id || 'pending', groupId || 'missing'), me.data?.id, (signal) => groupId ? getGroup(groupId, signal) : Promise.reject(new Error('Group unavailable')), RESOURCE_FRESHNESS.group, me.data?.id && groupId ? () => hydrateGroup(me.data!.id, groupId) : undefined);
  const [busy, setBusy] = useState(false);
  const [mutationError, setMutationError] = useState<unknown>();
  useEffect(() => { if (expense && !id) nav(`/groups/${expense.groupId}/expenses/${expenseId}`, { replace: true }); }, [expense, expenseId, id, nav]);
  if ((details.error || me.error) && !expense) return <Layout><ErrorBox error={details.error || me.error} onRetry={retryFor(resourceKeys.expenseDetail(me.data?.id || 'pending', expenseId), me.data?.id, Boolean(me.error))} id="expense-detail-error" /></Layout>;
  if (!expense) return <Layout><Loading /></Layout>;
  const summary = expenseRefundSummary(expense);
  const members = group.data?.members || [];
  const historicalParticipants = group.data?.historicalParticipants || [];
  const currentPersonId = group.data?.currentPersonId || '';
  const people = [...members, ...historicalParticipants.filter((participant) => !members.some((member) => member.personId === participant.personId))];
  const personLabel = (personId: string) => personId === currentPersonId ? 'You' : nameOf(people, personId);
  const restore = async () => { if (!online || busy) return; setBusy(true); setMutationError(undefined); const generation = captureSessionGeneration(); const mutationUserId = me.data?.id; try { await restoreExpense(expense.id, expense.version); if (!isSessionGenerationCurrent(generation)) return; await invalidateForMutation.expenseChanged(expense.groupId, expense.id, mutationUserId, generation); } catch (cause) { setMutationError(cause); } finally { setBusy(false); } };
  const remove = async () => { if (!online || busy || !confirm('Delete this expense?')) return; setBusy(true); setMutationError(undefined); const generation = captureSessionGeneration(); const mutationUserId = me.data?.id; try { await api(`/expenses/${expense.id}?version=${expense.version}`, { method: 'DELETE' }); if (!isSessionGenerationCurrent(generation)) return; await invalidateForMutation.expenseChanged(expense.groupId, expense.id, mutationUserId, generation); if (isSessionGenerationCurrent(generation)) nav(`/groups/${expense.groupId}`); } catch (cause) { setMutationError(cause); } finally { setBusy(false); } };
  const refundPath = `/groups/${expense.groupId}/refund/new?expense=${encodeURIComponent(expense.id)}`;
  return <Layout><Link to={`/groups/${expense.groupId}`} className="back">← Group</Link><PageHeader className="page-title" eyebrow={expense.deletedAt ? 'Deleted transaction' : expense.date} title={expense.description} actions={<Money amountMinor={expense.amountMinor} currency={expense.currency} size="large" />} /><ResourceNotice resource={details} label="expense details" retry={retryFor(resourceKeys.expenseDetail(me.data?.id || 'pending', expenseId), me.data?.id)} />{expense.deletedAt ? <Surface className="expense-detail-tombstone"><strong>Deleted expense</strong><p className="muted">This expense is retained for 30 days and cannot receive a refund.</p><ActionGroup><Button disabled={!online || busy} onClick={() => void restore()}>{busy ? 'Restoring…' : 'Restore expense'}</Button></ActionGroup></Surface> : null}<Surface className="expense-detail-surface"><SectionHeader title="Cost after refunds/reimbursements" /><LedgerList label="Expense cost summary"><LedgerRow><span>Gross expense</span><Money amountMinor={summary.grossMinor} currency={expense.currency} /></LedgerRow><LedgerRow><span>Refunds/reimbursements</span><Money amountMinor={summary.refundedMinor} currency={expense.currency} tone="positive" /></LedgerRow><LedgerRow><span>Net group cost</span><Money amountMinor={summary.netGroupCostMinor} currency={expense.currency} /></LedgerRow><LedgerRow><span>Remaining refundable</span><Money amountMinor={summary.remainingRefundableMinor} currency={expense.currency} /></LedgerRow></LedgerList>{!expense.deletedAt && !summary.fullyRefunded ? <Link className="button" to={refundPath}>Add refund</Link> : <p className="muted" role="status">{refundActionLabel(expense)}</p>}</Surface>{expense.linkedCredits?.length ? <Surface className="expense-detail-surface"><SectionHeader title="Refunds/reimbursements" /><LedgerList label="Refunds and reimbursements">{expense.linkedCredits.map((credit) => <LedgerRow as="li" key={credit.creditId}><Link className="ui-ledger-row__link" to={creditDetailPath(expense.groupId, credit.creditId) || `/groups/${expense.groupId}`}><span>{credit.subtype === 'refund' ? 'Refund' : 'Reimbursement'}<small>{credit.date} · {credit.deliveryMode === 'direct_provider_offset' ? 'Original payment or bill adjusted' : 'A group member received the money'}</small></span><Money amountMinor={credit.amountMinor} currency={expense.currency} /></Link></LedgerRow>)}</LedgerList></Surface> : null}<section className="reading-width expense-participants"><SectionHeader title="Payers" /><LedgerList label="Payers">{expense.payers.map((payer) => <LedgerRow key={payer.personId}><span>{personLabel(payer.personId)}</span><Money amountMinor={payer.amountMinor} currency={expense.currency} /></LedgerRow>)}</LedgerList><SectionHeader title="Split" /><LedgerList label="Split members">{expense.splits.map((split) => <LedgerRow key={split.personId}><span>{personLabel(split.personId)}</span><Money amountMinor={split.amountMinor} currency={expense.currency} /></LedgerRow>)}</LedgerList></section>{mutationError ? <ErrorBox error={mutationError} id="expense-mutation-error" /> : null}{!expense.deletedAt && online ? <ActionGroup><Link className="button" to={`/groups/${expense.groupId}/expense/${expense.id}`}>Edit</Link><Button variant="danger" disabled={busy} onClick={() => void remove()}>Delete</Button></ActionGroup> : null}<AuditList groupId={expense.groupId} entityId={expense.id} entityType="expense" userId={me.data?.id} /></Layout>;
}

function Settle() {
  const online = useOnlineStatus();
  const { id = '' } = useParams();
  const nav = useNavigate();
  const me = useResource(resourceKeys.identity(), '', (signal) => getMe({ signal }), RESOURCE_FRESHNESS.expenses, hydrateIdentity);
  const settleUserId = me.data?.id || 'pending';
  const groupResource = useResource<GroupResponse>(resourceKeys.group(settleUserId, id), me.data?.id, (signal) => getGroup(id, signal), RESOURCE_FRESHNESS.group, me.data?.id ? () => hydrateGroup(me.data!.id, id) : undefined);
  const balancesResource = useResource<{ balances: Record<string, Balances> }>(resourceKeys.balances(settleUserId, id), me.data?.id, (signal) => getBalances(id, signal), RESOURCE_FRESHNESS.balances, me.data?.id ? () => hydrateBalances(me.data!.id, id) : undefined);
   const historicalParticipants = groupResource.data?.historicalParticipants || (groupResource.data?.members || []).map((member) => ({ ...member, status: member.removedAt ? 'removed' as const : 'active' as const }));
   const currentPersonId = groupResource.data?.currentPersonId || '';
   const members = useMemo(() => sortOptionsByLabel(historicalParticipants.map((participant) => ({ ...participant, name: participant.status === 'deleted' ? 'Deleted account' : `${participant.name}${participant.status === 'removed' ? ' · Removed' : ''}` })), (member) => `${member.name}${member.personId === currentPersonId ? ' · You' : ''}`, (member) => member.personId), [currentPersonId, historicalParticipants]);
  const group = groupResource.data?.group;
  const balances = balancesResource.data?.balances || {};
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
   const [amount, setAmount] = useState('');
   const [currency, setCurrency] = useState<Currency>('USD');
   const [date, setDate] = useState(today);
  const [operation] = useState(operationId);
  const [submitting, setSubmitting] = useState(false);
   const [error, setError] = useState<unknown>();
   const [dirty, setDirty] = useState(false);
  const settlementRouteKey = `${settleUserId}:${id}`;
   const initializedRoute = useRef<string | undefined>(undefined);
   const initializedSuggestion = useRef<string | undefined>(undefined);
   const autoAmountRef = useRef<string | undefined>(undefined);
  const markDirty = () => setDirty(true);
  const offlineData = Boolean(me.offline || groupResource.offline || balancesResource.offline);
   const suggestion = group && currentPersonId && balancesResource.data ? settlementSuggestion(balancesResource.data.balances, currentPersonId, group.currency) : undefined;
   const fallbackFrom = suggestion?.fromPersonId || historicalParticipants[0]?.personId || '';
   const fallbackTo = suggestion?.toPersonId || historicalParticipants.find((member) => member.personId !== fallbackFrom)?.personId || '';
   const suggestionFingerprint = group ? settlementSuggestionFingerprint(suggestion, group.currency, fallbackFrom, fallbackTo) : '';
   const pairSuggestion = balancesResource.data ? settlementSuggestionForPair(balancesResource.data.balances, from, to, currency) : undefined;

  useEffect(() => {
    if (!group || !me.data || !balancesResource.data) return;
    const routeChanged = initializedRoute.current !== settlementRouteKey;
    if (!routeChanged && dirty) return;
    if (!routeChanged && initializedSuggestion.current === suggestionFingerprint) return;
     setCurrency(suggestion?.currency || group.currency); setFrom(fallbackFrom); setTo(fallbackTo); setAmount(suggestion ? moneyInput(suggestion.amountMinor) : ''); autoAmountRef.current = suggestion ? moneyInput(suggestion.amountMinor) : ''; if (routeChanged) setDate(today());
    initializedRoute.current = settlementRouteKey;
    initializedSuggestion.current = suggestionFingerprint;
     setDirty(false);
   }, [balancesResource.data, dirty, fallbackFrom, fallbackTo, group, me.data, settlementRouteKey, suggestion, suggestionFingerprint]);
    useEffect(() => {
      if (!balancesResource.data || !from || !to || from === to) return;
      const next = settlementAmountForPair(amount, autoAmountRef.current, pairSuggestion);
      if (next.amount === amount && next.autoAmount === autoAmountRef.current) return;
      autoAmountRef.current = next.autoAmount;
      setAmount(next.amount);
   }, [amount, balancesResource.data, from, pairSuggestion, to]);
   useEffect(() => {
     if (!from || !to || from !== to) return;
     setTo(historicalParticipants.find((member) => member.personId !== from)?.personId || '');
   }, [from, historicalParticipants, to]);
  const resourceError = error || me.error || groupResource.error || balancesResource.error;
  if (!group) return <Layout>{resourceError ? <ErrorBox error={resourceError} onRetry={retryFor(resourceError === balancesResource.error ? resourceKeys.balances(settleUserId, id) : resourceKeys.group(settleUserId, id), me.data?.id, Boolean(me.error))} id="settle-resource-error" /> : <Loading />}</Layout>;
    if (!online || offlineData) return <Layout><Link to={`/groups/${id}`} className="back">← <span className="back__label">{groupDisplayName(group)}</span></Link><PageHeader className="page-title" eyebrow={balancesResource.data ? 'Cached balance' : 'Balance unavailable'} title="Settle up" />{me.error ? <CachedIdentityNotice resource={me} id="settle-identity-error" /> : null}<p className="offline-banner" role="status">Settlements are online-only. Reconnect to submit; {balancesResource.data ? 'cached balances remain available.' : 'no verified cached balances are available on this device.'}</p><ResourceNotice resource={balancesResource} label="balances" retry={retryFor(resourceKeys.balances(settleUserId, id), me.data?.id)} />{balancesResource.data ? Object.entries(balances).map(([currencyKey, balance]) => <section className="reading-section settlement-balance-section" key={currencyKey}><SectionHeader title="Balances" description={currencyKey} />{balance.simplified.length ? <LedgerList label={`${currencyKey} balances`}>{balance.simplified.map((item) => <LedgerRow key={`${currencyKey}-${item.fromPersonId}-${item.toPersonId}`}><span>{item.fromPersonId === currentPersonId ? 'You' : item.fromName} owes {item.toPersonId === currentPersonId ? 'You' : item.toName}</span><Money amountMinor={item.amountMinor} currency={currencyKey} tone="debt" /></LedgerRow>)}</LedgerList> : <Empty>Everyone is settled up.</Empty>}</section>) : null}</Layout>;
    if (balancesResource.data === undefined) return <Layout><Link to={`/groups/${id}`} className="back">← <span className="back__label">{groupDisplayName(group)}</span></Link><PageHeader className="page-title" eyebrow="Balance required" title="Settle up" />{me.error ? <CachedIdentityNotice resource={me} id="settle-identity-error" /> : null}{!me.error ? <ResourceNotice resource={balancesResource} label="balances" retry={retryFor(resourceKeys.balances(settleUserId, id), me.data?.id)} /> : null}</Layout>;
   const submit = async (event: FormEvent) => { event.preventDefault(); if (submitting) return; setSubmitting(true); setError(undefined); const generation = captureSessionGeneration(); try { await api(`/groups/${id}/settlements`, { method: 'POST', body: JSON.stringify({ from_person_id: from, to_person_id: to, amount_minor: parseMoney(amount, currency), currency, date, client_operation_id: operation }) }); await invalidateForMutation.settlementChanged(id, me.data?.id, generation); nav(`/groups/${id}`); } catch (cause) { setSubmitting(false); setError(cause); } };
        const resetSuggestion = () => { const nextAmount = pairSuggestion ? moneyInput(pairSuggestion.amountMinor) : ''; setAmount(nextAmount); autoAmountRef.current = nextAmount; setDirty(false); };
        return <Layout><Link to={`/groups/${id}`} className="back">← <span className="back__label">{groupDisplayName(group)}</span></Link><PageHeader className="page-title" eyebrow={currentPersonId ? 'Suggested from your balance' : 'Payment'} title="Settle up" />{me.error ? <CachedIdentityNotice resource={me} id="settle-identity-error" /> : null}<p className="muted">Record a payment. Partial settlements are supported.</p><ResourceNotice resource={balancesResource} label="balances" retry={retryFor(resourceKeys.balances(settleUserId, id), me.data?.id)} /><FormSurface className="settlement-form-surface"><form className="reading-width" onSubmit={submit} aria-describedby={error ? 'settlement-form-error' : undefined}><Field label="Who paid?"><select value={from} onChange={(event) => { setError(undefined); markDirty(); setFrom(event.target.value); }}>{members.map((member) => <option key={member.personId} value={member.personId}>{member.name}{member.personId === currentPersonId ? ' · You' : ''}</option>)}</select></Field><Field label="Who received?"><select value={to} onChange={(event) => { setError(undefined); markDirty(); setTo(event.target.value); }}>{members.filter((member) => member.personId !== from).map((member) => <option key={member.personId} value={member.personId}>{member.name}{member.personId === currentPersonId ? ' · You' : ''}</option>)}</select></Field><Field label="Currency"><CurrencySelect value={currency} onChange={(value) => { setError(undefined); markDirty(); setCurrency(value); }} /></Field><Field label={`Amount (${currency})`}><input className={amountInputClass(amount)} data-amount-length={amountInputLength(amount)} required inputMode="decimal" aria-invalid={Boolean(error)} value={amount} onChange={(event) => { setError(undefined); markDirty(); setAmount(event.target.value); }} /></Field><Field label="Date"><input required type="date" value={date} onChange={(event) => { setError(undefined); markDirty(); setDate(event.target.value); }} /></Field>{dirty ? <ActionGroup><Button type="button" variant="secondary" onClick={resetSuggestion}>Reset to current suggestion</Button></ActionGroup> : null}{error ? <ErrorBox error={error} id="settlement-form-error" /> : null}<Button className="full-width-button" disabled={submitting} type="submit">{submitting ? 'Recording…' : 'Record payment'}</Button></form></FormSurface></Layout>;
}

function SettlementDetail() {
  const online = useOnlineStatus(); const { settlementId = '' } = useParams(); const nav = useNavigate(); const me = useResource(resourceKeys.identity(), '', (signal) => getMe({ signal }), RESOURCE_FRESHNESS.expenses, hydrateIdentity); const userId = me.data?.id;
    const detail = useResource<{ settlement: Settlement; history: Array<{ id: string; revision: number; createdAt: string }> }>(resourceKeys.settlementDetail(userId || 'pending', settlementId), userId, (signal) => getSettlementDetails(settlementId, signal), RESOURCE_FRESHNESS.settlementDetail); const loadedSettlement = detail.data?.settlement; let settlement: Settlement = loadedSettlement!; const groupId = loadedSettlement?.groupId || ''; const group = useResource<GroupResponse>(resourceKeys.group(userId || 'pending', groupId), userId, (signal) => groupId ? getGroup(groupId, signal) : Promise.reject(new Error('Group unavailable')), RESOURCE_FRESHNESS.group); const members = group.data?.members || []; const historicalParticipants = group.data?.historicalParticipants || members.map((member) => ({ ...member, status: member.removedAt ? 'removed' as const : 'active' as const }));
   const balancesResource = useResource<{ balances: Record<string, Balances> }>(resourceKeys.balances(userId || 'pending', groupId), userId, (signal) => groupId ? getBalances(groupId, signal) : Promise.resolve({ balances: {} }), RESOURCE_FRESHNESS.balances);
     const editAmountState = useRef<SettlementEditAmountState>();
   const [busy, setBusy] = useState(false); const [editing, setEditing] = useState(false); const [error, setError] = useState<unknown>(); const [from, setFrom] = useState(''); const [to, setTo] = useState(''); const [amount, setAmount] = useState(''); const [date, setDate] = useState(''); const [note, setNote] = useState('');
   const editSuggestion = balancesResource.data ? settlementSuggestionForPair(balancesResource.data.balances, from, to, settlement?.currency || 'USD') : undefined;
     useEffect(() => { if (settlement && !editing) { const savedAmount = moneyInput(settlement.amountMinor); setFrom(settlement.fromPersonId); setTo(settlement.toPersonId); setAmount(savedAmount); editAmountState.current = settlementEditAmountState(`${settlement.fromPersonId}:${settlement.toPersonId}`, savedAmount); setDate(settlement.date); setNote(settlement.note || ''); } }, [editing, settlement]);
      useEffect(() => { if (!editing || !loadedSettlement || from === to || !editAmountState.current) return; const pairKey = `${from}:${to}`; const next = transitionSettlementEditAmount(editAmountState.current, pairKey, editSuggestion); if (next.amount === amount && next.autoAmount === editAmountState.current.autoAmount) return; editAmountState.current = next; setAmount(next.amount); }, [amount, editSuggestion, editing, from, loadedSettlement, to]);
   useEffect(() => { if (editing && from === to) setTo(historicalParticipants.find((participant) => participant.personId !== from)?.personId || ''); }, [editing, from, historicalParticipants, to]);
   if (!loadedSettlement && (detail.error || me.error)) return <Layout><ErrorBox error={detail.error || me.error} id="settlement-detail-error" /></Layout>; if (!loadedSettlement) return <Layout><Loading /></Layout>;
     let participantIds = [...new Set([settlement.fromPersonId, settlement.toPersonId, ...historicalParticipants.map((participant) => participant.personId)])]; const label = (personId: string) => { if (personId === group.data?.currentPersonId) return 'You'; const participant = historicalParticipants.find((candidate) => candidate.personId === personId); return participant ? (participant.status === 'deleted' ? 'Deleted account' : `${participant.name}${participant.status === 'removed' ? ' · Removed' : ''}`) : 'Removed'; }; participantIds = sortOptionsByLabel(participantIds, label, (personId) => personId);
   const restore = async () => { if (!online || busy) return; setBusy(true); setError(undefined); const generation = captureSessionGeneration(); try { await restoreSettlement(settlement.id, settlement.version); await invalidateForMutation.settlementChanged(settlement.groupId, userId, settlement.id, generation); } catch (cause) { setError(cause); } finally { setBusy(false); } };
  const remove = async () => { if (!confirm('Delete this settlement?')) return; setBusy(true); setError(undefined); const generation = captureSessionGeneration(); try { await api(`/settlements/${settlement.id}?version=${settlement.version}`, { method: 'DELETE' }); await invalidateForMutation.settlementChanged(settlement.groupId, userId, settlement.id, generation); nav(`/groups/${settlement.groupId}`); } catch (cause) { setError(cause); } finally { setBusy(false); } };
   const save = async (event: FormEvent) => { event.preventDefault(); if (!online || busy) return; setBusy(true); setError(undefined); const generation = captureSessionGeneration(); try { await updateSettlement(settlement.id, { from_person_id: from, to_person_id: to, amount_minor: parseMoney(amount, settlement.currency), currency: settlement.currency, date, note: note || null, version: settlement.version }); setEditing(false); await invalidateForMutation.settlementChanged(settlement.groupId, userId, settlement.id, generation); } catch (cause) { setError(cause); } finally { setBusy(false); } };
   if (editing) { try { settlement = { ...settlement, fromPersonId: from, toPersonId: to, amountMinor: parseMoney(amount, settlement.currency), date, note }; } catch { settlement = { ...settlement, fromPersonId: from, toPersonId: to, date, note }; } }
  return <Layout><Link to={`/groups/${settlement.groupId}`} className="back">← Group</Link><PageHeader className="page-title" eyebrow={settlement.deletedAt ? 'Deleted transaction' : settlement.date} title={`${label(settlement.fromPersonId)} paid ${label(settlement.toPersonId)}`} actions={<Money amountMinor={settlement.amountMinor} currency={settlement.currency} size="large" tone="positive" />} />{settlement.deletedAt ? <Surface className="settlement-detail-tombstone"><strong>Deleted settlement</strong><p className="muted">The tombstone is retained for 30 days and can be restored by an active group member.</p><ActionGroup><Button disabled={!online || busy} onClick={() => void restore()}>{busy ? 'Restoring…' : 'Restore settlement'}</Button></ActionGroup></Surface> : editing ? <FormSurface className="settlement-form-surface"><form onSubmit={save}><Field label="Who paid?"><select value={from} onChange={(event) => setFrom(event.target.value)}>{participantIds.filter((personId) => personId !== to).map((personId) => <option key={personId} value={personId}>{label(personId)}</option>)}</select></Field><Field label="Who received?"><select value={to} onChange={(event) => setTo(event.target.value)}>{participantIds.filter((personId) => personId !== from).map((personId) => <option key={personId} value={personId}>{label(personId)}</option>)}</select></Field><Field label={`Amount (${settlement.currency})`}><input className={amountInputClass(amount)} data-amount-length={amountInputLength(amount)} required inputMode="decimal" value={amount} onChange={(event) => { const value = event.target.value; setAmount(value); if (editAmountState.current) editAmountState.current = manuallySetSettlementEditAmount(editAmountState.current, value); }} /></Field><Field label="Date"><input required type="date" value={date} onChange={(event) => setDate(event.target.value)} /></Field><Field label="Note (optional)"><textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} /></Field><ActionGroup><Button type="submit" disabled={!online || busy}>{busy ? 'Saving…' : 'Save changes'}</Button><Button type="button" variant="secondary" onClick={() => setEditing(false)}>Cancel</Button></ActionGroup></form></FormSurface> : <ActionGroup><Button type="button" onClick={() => setEditing(true)} disabled={!online}>Edit settlement</Button><Button type="button" variant="danger" disabled={!online || busy} onClick={() => void remove()}>Delete</Button></ActionGroup>}{error ? <ErrorBox error={error} id="settlement-mutation-error" /> : null}<ResourceNotice resource={detail} label="settlement details" /><AuditList groupId={settlement.groupId} entityId={settlement.id} entityType="settlement" userId={userId} /></Layout>;
}


type TransactionPage = { transactions: Transaction[]; nextCursor?: string };
type TransactionPageState = { resource: TransactionPage; rows: Transaction[]; cursor?: string; loadingToken?: number; pageError?: unknown };

function HistoryTransactions({ groupId, groups }: { groupId?: string; groups: Group[] }) {
  const online = useOnlineStatus();
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(() => readTransactionFilters(searchParams), [searchParams]);
  const filterSignature = transactionFilterKey(filters);
  const me = useResource(resourceKeys.identity(), '', (signal) => getMe({ signal }), RESOURCE_FRESHNESS.expenses, hydrateIdentity);
  const userId = me.data?.id || 'pending';
   const groupResource = useResource<GroupResponse | { group?: Group; members: GroupMember[]; historicalParticipants: HistoricalParticipant[]; splitDefault: GroupSplitDefault | null; currentPersonId: string | null }>(resourceKeys.group(userId, groupId || 'all'), me.data?.id, (signal) => groupId ? getGroup(groupId, signal) : Promise.resolve({ group: undefined, members: [], historicalParticipants: [], splitDefault: null, currentPersonId: null }), RESOURCE_FRESHNESS.group, groupId && me.data?.id ? () => hydrateGroup(me.data!.id, groupId) : undefined);
  const transactionsResource = useResource<TransactionPage>(resourceKeys.transactions(userId, groupId || 'all', filterSignature), me.data?.id, (signal) => getGlobalTransactionPage(groupId, filters, signal), RESOURCE_FRESHNESS.transactions, me.data?.id && !hasTransactionFilters(filters) ? (groupId ? () => hydrateTransactions(me.data!.id, groupId) : () => hydrateGlobalTransactions(me.data!.id)) : undefined);
  const categoriesResource = useResource<{ categories: string[] }>(resourceKeys.categories(userId), me.data?.id, (signal) => getCategories(signal), RESOURCE_FRESHNESS.expenses, me.data?.id ? () => hydrateCategories(me.data!.id) : undefined);
  const group = groupResource.data?.group;
  const members = sortOptionsByLabel(groupResource.data?.members || [], (member) => member.name, (member) => member.personId);
  const outbox = useSyncExternalStore(subscribeOutbox, getOutboxSnapshot, () => []);
  const pending = outbox.filter((item) => item.userId === (me.data?.id || '') && (!groupId || item.groupId === groupId));
  const scopeKey = `${userId}:${groupId || 'all'}:${filterSignature}`;
  const [pageStates, setPageStates] = useState<Record<string, TransactionPageState>>({}); const [draftState, setDraftState] = useState<{ scopeKey: string; filters: TransactionFilters }>(() => ({ scopeKey, filters }));
  const draftFilters = draftState.scopeKey === scopeKey ? draftState.filters : filters;
  const setDraftFilters = (update: (current: TransactionFilters) => TransactionFilters) => setDraftState((current) => ({ scopeKey, filters: update(current.scopeKey === scopeKey ? current.filters : filters) }));
  const pageScope = useRef(createPageRequestScope());
  const resourcePage = transactionsResource.data;
  const storedPageState = pageStates[scopeKey];
  const pageState = resourcePage === undefined ? undefined : storedPageState?.resource === resourcePage ? storedPageState : { resource: resourcePage, rows: resourcePage.transactions, cursor: resourcePage.nextCursor };
  const rows = pageState?.rows || [];
  const cursor = pageState?.cursor;
  const loadingMore = pageState?.loadingToken !== undefined;
  const offline = Boolean(groupResource.offline || transactionsResource.offline || me.offline) || !online;
  useEffect(() => { const page = transactionsResource.data; if (!page) return; setPageStates((current) => current[scopeKey]?.resource === page ? current : { ...current, [scopeKey]: { resource: page, rows: page.transactions, cursor: page.nextCursor } }); }, [scopeKey, transactionsResource.data]);
  useEffect(() => () => pageScope.current.dispose(), []);
  useEffect(() => { if ((filters.kind === 'settlement' || filters.kind === 'credit') && searchParams.get('category')) setSearchParams(writeTransactionFilters(searchParams, filters), { replace: true }); }, [filters, searchParams, setSearchParams]);
  if (groupId && (groupResource.error || me.error) && !group) return <ErrorBox error={groupResource.error || me.error} onRetry={me.error ? retryFor(resourceKeys.identity(), '') : retryFor(resourceKeys.group(userId, groupId), me.data?.id)} id="history-group-error" />;
  if (groupId && !group) return <Loading />;
  const filterCount = transactionFilterCount(filters);
  const categoryChoices = sortOptionsByLabel([...new Set([...(categoriesResource.data?.categories || []), ...rows.filter((row): row is Extract<Transaction, { kind: 'expense' }> => row.kind === 'expense').map((row) => row.category || '')].filter(Boolean))], (category) => category);
  const filteredOfflineUnavailable = offline && hasTransactionFilters(filters) && transactionsResource.data === undefined;
  const groupNames = new Map(groups.map((candidate) => [candidate.id, groupDisplayName(candidate)]));
  const applyFilters = (event: FormEvent) => { event.preventDefault(); setSearchParams(writeTransactionFilters(searchParams, draftFilters)); };
  const loadMore = async () => { if (!pageState || !cursor || loadingMore || offline) return; const requestedResource = pageState.resource; const request = pageScope.current.begin(scopeKey, cursor); setPageStates((current) => { const state = current[scopeKey]?.resource === requestedResource ? current[scopeKey] : pageState; return state?.cursor === request.cursor ? { ...current, [scopeKey]: { ...state, loadingToken: request.token, pageError: undefined } } : current; }); try { const page = await getGlobalTransactionPage(groupId, { ...filters, limit: 25, cursor: request.cursor }, request.signal); if (!pageScope.current.isCurrent(request)) return; setPageStates((current) => { const state = current[request.key]; if (!state || state.resource !== requestedResource || state.cursor !== request.cursor || state.loadingToken !== request.token) return current; return { ...current, [request.key]: { ...state, rows: appendUniquePage(state.rows, page.transactions, transactionKey), cursor: page.nextCursor, loadingToken: undefined } }; }); } catch (cause) { if (pageScope.current.isCurrent(request) && !(cause instanceof DOMException && cause.name === 'AbortError')) setPageStates((current) => { const state = current[request.key]; return state?.resource === requestedResource && state.loadingToken === request.token ? { ...current, [request.key]: { ...state, pageError: cause } } : current; }); } finally { setPageStates((current) => { const state = current[request.key]; return state?.resource === requestedResource && state.loadingToken === request.token ? { ...current, [request.key]: { ...state, loadingToken: undefined } } : current; }); } };
  const clearFilters = () => setSearchParams(writeTransactionFilters(searchParams, {}));
   return <section className="history-panel" aria-labelledby="history-transactions-heading">
      <label className="history-kind-shortcut">Transaction kind <select value={draftFilters.kind || ''} disabled={offline} onChange={(event) => setDraftFilters((current) => ({ ...current, kind: (event.target.value || undefined) as TransactionFilters['kind'], category: event.target.value === 'credit' || event.target.value === 'settlement' ? undefined : current.category }))}><option value="">All transactions</option><option value="expense">Expenses</option><option value="settlement">Payments</option><option value="credit">Refunds/reimbursements</option></select></label>
     <h2 id="history-transactions-heading" className="sr-only">Transactions</h2>
    {offline ? <ConnectionBanner detail="transaction history and server filters need a connection." /> : null}

    <TransactionFilterDisclosure filterKey={filterSignature} filterCount={filterCount} offline={offline}><form className="transaction-filters" onSubmit={applyFilters}><Field label="Search"><input type="search" value={draftFilters.q || ''} disabled={offline} onChange={(event) => setDraftFilters((current) => ({ ...current, q: event.target.value || undefined }))} /></Field><Field label="Kind"><select value={draftFilters.kind || ''} disabled={offline} onChange={(event) => setDraftFilters((current) => ({ ...current, kind: (event.target.value || undefined) as TransactionFilters['kind'], category: event.target.value === 'settlement' || event.target.value === 'credit' ? undefined : current.category }))}><option value="">All transaction types</option><option value="expense">Expenses</option><option value="settlement">Payments</option><option value="credit">Refunds/reimbursements</option></select></Field>{groupId ? <Field label="Person"><select value={draftFilters.person || ''} disabled={offline} onChange={(event) => setDraftFilters((current) => ({ ...current, person: event.target.value || undefined }))}><option value="">All people</option>{members.map((member) => <option key={member.personId} value={member.personId}>{member.name}</option>)}</select></Field> : null}<Field label="Category"><select value={draftFilters.category || ''} disabled={offline || draftFilters.kind === 'settlement' || draftFilters.kind === 'credit'} onChange={(event) => setDraftFilters((current) => ({ ...current, category: event.target.value || undefined }))}><option value="">All categories</option>{categoryChoices.map((category) => <option key={category} value={category}>{category}</option>)}</select></Field><Field label="From date"><input type="date" value={draftFilters.from || ''} disabled={offline} onChange={(event) => setDraftFilters((current) => ({ ...current, from: event.target.value || undefined }))} /></Field><Field label="To date"><input type="date" value={draftFilters.to || ''} disabled={offline} onChange={(event) => setDraftFilters((current) => ({ ...current, to: event.target.value || undefined }))} /></Field><Field label="Currency"><select value={draftFilters.currency || ''} disabled={offline} onChange={(event) => setDraftFilters((current) => ({ ...current, currency: event.target.value as Currency || undefined }))}><option value="">All currencies</option>{currencyOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></Field><div className="actions"><Button type="submit" disabled={offline}>Apply</Button>{filterCount ? <Button type="button" variant="secondary" disabled={offline} onClick={clearFilters}>Clear</Button> : null}</div></form></TransactionFilterDisclosure>
      {filteredOfflineUnavailable ? <p className="cache-status" role="status">Filtered transaction results aren’t cached on this device. Reconnect to search history.</p> : <ResourceNotice resource={transactionsResource} label="transactions" retry={retryFor(resourceKeys.transactions(userId, groupId || 'all', filterSignature), me.data?.id)} />}{pending.length ? <section className="pending-transactions" aria-labelledby="pending-transactions-heading"><h3 className="pending-transactions__heading" id="pending-transactions-heading">Waiting to sync · {pending.length}</h3><LedgerList as="div" label="Pending transactions">{pending.map((item) => <PendingExpenseRow key={item.clientOperationId} item={item} groupName={!groupId ? groupNames.get(item.groupId) : undefined} />)}</LedgerList></section> : null}{pageState && rows.length ? <LedgerList className="transaction-list" label="Transactions">{rows.map((transaction) => <li key={transactionKey(transaction)}><TransactionRow key={transactionKey(transaction)} groupId={transaction.groupId} transaction={transaction} currentPersonId={me.data?.personId} showNotes /></li>)}</LedgerList> : pageState && !pending.length ? <Empty>No transactions match the current filters.</Empty> : null}{pageState?.cursor ? <Button type="button" variant="secondary" disabled={loadingMore || offline} onClick={() => void loadMore()}>{loadingMore ? 'Loading…' : 'Load more transactions'}</Button> : null}{pageState?.pageError ? <ErrorBox error={pageState.pageError} id="history-transactions-page-error" /> : null}

  </section>;
}

function HistoryChanges({ groupId }: { groupId?: string }) {
  const online = useOnlineStatus();
  const me = useResource(resourceKeys.identity(), '', (signal) => getMe({ signal }), RESOURCE_FRESHNESS.expenses, hydrateIdentity);
  const userId = me.data?.id || 'pending';
  const activity = useResource<{ activity: ActivityItem[]; nextCursor?: string }>(resourceKeys.activity(userId, groupId || 'all'), me.data?.id, (signal) => getActivity(groupId, signal), RESOURCE_FRESHNESS.activity, me.data?.id ? () => hydrateActivity(me.data!.id, groupId || 'all') : undefined);
  const [items, setItems] = useState<ActivityItem[]>([]); const [cursor, setCursor] = useState<string>(); const [loadingMore, setLoadingMore] = useState(false); const [pageError, setPageError] = useState<unknown>();
  const scopeKey = `${userId}:${groupId || 'all'}`; const scopeKeyRef = useRef(scopeKey); scopeKeyRef.current = scopeKey; const pageScope = useRef(createPageRequestScope()); const cursorRef = useRef<string>(); const loadingCursorRef = useRef<string>();
  useEffect(() => { pageScope.current.reset(scopeKey); cursorRef.current = undefined; loadingCursorRef.current = undefined; setItems([]); setCursor(undefined); setLoadingMore(false); setPageError(undefined); }, [scopeKey]);
  useEffect(() => { const page = activity.data; if (!page || scopeKeyRef.current !== scopeKey) return; pageScope.current.reset(scopeKey); cursorRef.current = page.nextCursor; loadingCursorRef.current = undefined; setItems(page.activity); setCursor(page.nextCursor); setLoadingMore(false); setPageError(undefined); }, [activity.data, scopeKey]);
  useEffect(() => () => pageScope.current.dispose(), []);
  const loadMore = async () => { if (!cursor || loadingMore || !online) return; const request = pageScope.current.begin(scopeKey, cursor); loadingCursorRef.current = request.cursor; setLoadingMore(true); setPageError(undefined); try { const page = await getActivityPage(groupId, { cursor: request.cursor }, request.signal); if (!pageScope.current.isCurrent(request) || scopeKeyRef.current !== request.key || cursorRef.current !== request.cursor) return; cursorRef.current = page.nextCursor; setItems((current) => appendUniquePage(current, page.activity, (item) => `${item.type}:${item.id}`)); setCursor(page.nextCursor); } catch (cause) { if (pageScope.current.isCurrent(request) && scopeKeyRef.current === request.key && cursorRef.current === request.cursor && loadingCursorRef.current === request.cursor && !(cause instanceof DOMException && cause.name === 'AbortError')) setPageError(cause); } finally { if (pageScope.current.isCurrent(request) && scopeKeyRef.current === request.key && (cursorRef.current === request.cursor || loadingCursorRef.current === request.cursor)) { loadingCursorRef.current = undefined; setLoadingMore(false); } } };
    const typeLabel = (type: ActivityItem['type']) => ({ expense: 'Expense', settlement: 'Payment', credit: 'Refund/reimbursement', expense_revision: 'Expense edited', settlement_revision: 'Payment edited', credit_revision: 'Refund/reimbursement edited', expense_deleted: 'Expense deleted', settlement_deleted: 'Payment deleted', credit_deleted: 'Refund/reimbursement deleted' })[type];
   const itemRow = (item: ActivityItem) => { const content = <><span><strong>{item.type.startsWith('settlement') ? `${item.fromName || 'Unknown member'} paid ${item.toName || 'unknown member'}` : item.label || 'Expense'}</strong><small>{item.groupName ? `${item.groupName} · ` : ''}{typeLabel(item.type)} · {item.transactionDate || item.createdAt.slice(0, 10)}</small>{item.label && item.type.startsWith('settlement') ? <small className="activity-description">{item.label}</small> : null}</span>{item.amountMinor != null && item.currency ? <Money amountMinor={item.amountMinor} currency={item.currency} /> : null}</>; const path = transactionActivityPath(item.groupId, item); return path ? <Link className="ui-ledger-row" to={path} key={`${item.type}-${item.id}`}>{content}</Link> : <div className="ui-ledger-row" key={`${item.type}-${item.id}`}>{content}</div>; };
  return <section className="history-panel" aria-labelledby="history-changes-heading"><h2 id="history-changes-heading" className="sr-only">Changes</h2>{!online || activity.offline ? <p className="offline-banner" role="status">Offline · showing cached history; this is only the first cached page.</p> : null}{me.error ? <CachedIdentityNotice resource={me} id="history-identity-error" /> : null}<ResourceNotice resource={activity} label="history" retry={retryFor(resourceKeys.activity(me.data?.id || 'pending', groupId || 'all'), me.data?.id)} />{activity.data !== undefined && items.length ? <LedgerList className="reading-width activity-list" label="Changes">{items.map((item) => <li key={`${item.type}-${item.id}`}>{itemRow(item)}</li>)}</LedgerList> : activity.data !== undefined ? <Empty>No history yet.</Empty> : null}{cursor ? <Button type="button" variant="secondary" disabled={loadingMore || !online} onClick={() => void loadMore()}>{loadingMore ? 'Loading…' : 'Load more history'}</Button> : null}{pageError ? <ErrorBox error={pageError} id="history-page-error" /> : null}</section>;
}

function zeroInsightSummary(currency: Currency): SpendingInsightSummaryResponse['summaries'][number] {
  return { currency, groupSpendMinor: 0, allocatedSpendMinor: 0, yourShareMinor: 0, youPaidMinor: 0, expenseCount: 0 };
}

function InsightPrimarySummary({ summary, data, previous }: { summary: SpendingInsightSummaryResponse['summaries'][number]; data: SpendingInsightSummaryResponse; previous?: NonNullable<SpendingInsightSummaryResponse['previous']>['summaries'][number] }) {
  const value = data.scope === 'global' ? summary.allocatedSpendMinor : summary.groupSpendMinor;
  const previousValue = data.previous ? (previous ? data.scope === 'global' ? previous.allocatedSpendMinor : previous.groupSpendMinor : 0) : undefined;
  const change = previousValue === undefined ? 0 : value - previousValue;
  const percent = previousValue === undefined ? undefined : previousValue === 0 ? change === 0 ? '0%' : 'new' : `${change >= 0 ? '+' : ''}${((change / previousValue) * 100).toFixed(1)}%`;
  const changeText = previousValue === undefined ? 'No comparison is available for all-time spending.' : `${change >= 0 ? '+' : ''}${new Intl.NumberFormat(undefined, { style: 'currency', currency: summary.currency }).format(change / 100)} (${percent})`;
  const comparisonPeriod = data.previous ? `${data.previous.from} to ${data.previous.to}` : undefined;
  return <article className="insight-summary-card"><span className="insight-metric__currency">{summary.currency} · {data.scope === 'global' ? 'Your allocated split share' : 'Total group spending'}</span><strong className="insight-summary-card__primary"><Money amountMinor={value} currency={summary.currency} /></strong><span className="muted">{comparisonPeriod ? `Compared with ${comparisonPeriod}: ${changeText}` : changeText}</span></article>;
}

function InsightUnavailableOffline({ label }: { label: string }) {
  return <p className="offline-banner" role="status">{label} {label === 'Category trends' ? 'are' : 'is'} unavailable offline; no cached data is available.</p>;
}

function SimplifiedCategoryTrendModule({ data, currencyValue, index }: { data: SpendingInsightTrends; currencyValue: Currency; index: number }) {
  const sourceMonths = insightTrendMonths({ trendFrom: data.trendFrom, trendTo: data.trendTo });
  const categories = topCategoryTrends(data.categoryTrends, currencyValue, data.scope === 'global' ? 'allocated' : 'group', { trendFrom: data.trendFrom, trendTo: data.trendTo });
  const months = insightDisplayedTrendMonths(categories, sourceMonths);
  const moneyText = (value: number) => new Intl.NumberFormat(undefined, { style: 'currency', currency: currencyValue }).format(value / 100);
  const actualCurrentMonth = sourceMonths.at(-1);
  const referenceMonth = months.at(-1);
  const headingId = `insight-${data.scope}-${currencyValue}-${index}-categories-heading`;
  const guidanceId = `${headingId}-guidance`;
  const valuesId = `${headingId}-values`;
  const maximum = insightTrendMaximum(categories);
  const categoryColors = new Map(categories.map((item) => [item.category, insightCategoryColor(item.category)] as const));
  const statuses = categories.map((item) => categoryTrendStatus(item, sourceMonths));
  return <section className="insight-chart insight-category-trends" aria-labelledby={headingId}>
    <div className="insight-module-heading"><div><h4 id={headingId}>Highest-spend categories</h4><p className="muted">{insightActivitySpanText(months)} · {currencyValue} · {data.scope === 'global' ? 'your allocated share' : 'total group spending'}</p></div></div>
    {categories.length ? <>
      {months.length ? <>
        <figure className="category-trend-figure" aria-labelledby={headingId} aria-describedby={guidanceId}>
          <div id={guidanceId} className="category-trend-guidance muted">Bars share one scale; very small non-zero values use a minimum visible marker. Exact displayed-span amounts are in the table.</div>
          <div className="category-trend-bars" tabIndex={0} role="group" aria-label={`${currencyValue} category spending chart`} aria-describedby={guidanceId} aria-details={valuesId}>
            <div className={`category-trend-plot${months.length > 3 ? ' category-trend-plot--long' : ''}`} style={{ gridTemplateColumns: `repeat(${months.length}, minmax(0, 1fr))` }}>
              {months.map((month) => <div className="category-trend-month" data-month={month} key={month}>
                <div className="category-trend-month-bars" aria-hidden="true">
                  {categories.map((item) => {
                    const value = insightTrendValue(item, month);
                    return <span className="category-trend-bar" data-category={item.category} data-value={value} data-month={month} key={item.category} style={{ backgroundColor: categoryColors.get(item.category), height: `${insightTrendBarHeight(value, maximum)}%` }} />;
                  })}
                </div>
                <small>{insightTrendMonthLabel(month, actualCurrentMonth)}</small>
              </div>)}
            </div>
          </div>
          <ul className="category-trend-legend" aria-label="Category summaries">
            {categories.map((item, categoryIndex) => { return <li className="category-trend-summary" data-category={item.category} key={item.category}>
              <span className="category-trend-marker" data-category={item.category} aria-hidden="true" style={{ backgroundColor: categoryColors.get(item.category) }} />
              <div className="category-trend-summary__copy"><strong className="category-trend-name">{item.category}</strong><span className="category-trend-current">{moneyText(insightTrendValue(item, referenceMonth))} {insightTrendReferenceLabel(referenceMonth, actualCurrentMonth)}</span><span className="category-trend-total">{moneyText(checkedSumMinor(months.map((month) => insightTrendValue(item, month))))} across {months.length}-month span</span><span className={`category-trend-direction category-trend-direction--${statuses[categoryIndex].kind}`}>{statuses[categoryIndex].text}</span></div>
            </li>; })}
          </ul>
          <div className="sr-only category-trend-values-wrapper">
            <table id={valuesId} className="category-trend-values">
              <caption>Exact displayed-span {currencyValue} values by category</caption>
              <thead><tr><th scope="col">Category</th>{months.map((month) => <th scope="col" key={month}>{insightTrendMonthLabel(month, actualCurrentMonth)}</th>)}</tr></thead>
              <tbody>{categories.map((item) => <tr key={item.category}><th scope="row">{item.category}</th>{months.map((month) => <td key={month}>{moneyText(insightTrendValue(item, month))}</td>)}</tr>)}</tbody>
            </table>
          </div>
          <figcaption className="sr-only">Category spending bars for {currencyValue} across the displayed activity span. Exact values are available in the table below.</figcaption>
        </figure>
      </> : <p className="muted">{insightActivitySpanText(months)}</p>}
    </> : <p className="muted">{insightActivitySpanText(months)}</p>}
  </section>;
}

function InsightCurrencyTabs({ currencies, selectedCurrency, onSelect }: { currencies: Currency[]; selectedCurrency?: Currency; onSelect: (currency: Currency) => void }) {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  useEffect(() => {
    if (!selectedCurrency) return;
    const index = currencies.indexOf(selectedCurrency);
    if (index >= 0) tabRefs.current[index]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [currencies, selectedCurrency]);
  if (!currencies.length) return null;
  const moveTo = (index: number) => {
    const currency = currencies[index];
    if (!currency) return;
    onSelect(currency);
    tabRefs.current[index]?.focus();
  };
  return <div className="insight-currency-tabs" role="tablist" aria-label="Spending insight currencies">
    {currencies.map((currency, index) => <button className="insight-currency-tab" type="button" role="tab" key={currency} id={`insight-currency-tab-${currency}`} aria-selected={currency === selectedCurrency} aria-controls="insight-currency-panel" tabIndex={currency === selectedCurrency ? 0 : -1} ref={(element) => { tabRefs.current[index] = element; }} onClick={() => onSelect(currency)} onKeyDown={(event) => {
      let nextIndex: number | undefined;
      if (event.key === 'ArrowRight') nextIndex = (index + 1) % currencies.length;
      else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + currencies.length) % currencies.length;
      else if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = currencies.length - 1;
      if (nextIndex !== undefined) { event.preventDefault(); moveTo(nextIndex); }
    }}>{currency}</button>)}
  </div>;
}

function InsightSummarySection({ resource, currency, groupId, online, retry, summaryValid }: { resource: ResourceSnapshot<SpendingInsightSummaryResponse>; currency?: Currency; groupId?: string; online: boolean; retry?: () => void; summaryValid: boolean }) {
  const data = resource.data;
  const current = currency ? data?.summaries.find((item) => item.currency === currency) : undefined;
  const previous = currency ? data?.previous?.summaries.find((item) => item.currency === currency) : undefined;
  let content: ReactNode;
  if (!summaryValid) content = <p className="muted" role="status">Choose two valid dates to load the selected-period summary. Category trends remain available in the capped local calendar window.</p>;
  else if (!data) content = !online ? <InsightUnavailableOffline label="Selected-period summary" /> : resource.error ? <ErrorBox error={resource.error} onRetry={online ? retry : undefined} id="insights-summary-error" /> : <Loading />;
  else content = <>{!online ? <p className="cache-status" role="status">Refresh unavailable offline; showing cached selected-period summary.</p> : resource.revalidating || resource.error || resource.stale || resource.offline ? <ResourceNotice resource={resource} label="selected-period summary" retry={online ? retry : undefined} /> : null}{current || previous ? <div className="insight-summary-grid" aria-label="Selected-period spending summary"><InsightPrimarySummary summary={current || zeroInsightSummary(currency!)} data={data} previous={previous} /></div> : <Empty>No counted expenses in this period. Settlements, scheduled expenses, deleted expenses, and pending offline expenses are excluded.</Empty>}</>;
  return <section className="insight-section" aria-labelledby="insight-summary-heading"><SectionHeader level={3} title={<span id="insight-summary-heading">{groupId ? 'How much did this group spend?' : 'How much did I spend?'}</span>} description="Selected period" />{content}</section>;
}

function InsightTrendsSection({ resource, currency, online, retry }: { resource: ResourceSnapshot<SpendingInsightTrends>; currency?: Currency; online: boolean; retry?: () => void }) {
  let content: ReactNode;
  if (!resource.data) content = !online ? <InsightUnavailableOffline label="Category trends" /> : resource.error ? <ErrorBox error={resource.error} onRetry={online ? retry : undefined} id="insights-trends-error" /> : <Loading />;
  else {
    const trendData = resource.data;
    const cacheNotice = !online ? <p className="cache-status" role="status">Refresh unavailable offline; showing cached category trends.</p> : resource.revalidating || resource.error || resource.stale || resource.offline ? <ResourceNotice resource={resource} label="category trends" retry={online ? retry : undefined} /> : null;
    const trend = currency ? <SimplifiedCategoryTrendModule data={trendData} currencyValue={currency} index={0} /> : <Empty>No counted category spending in the local calendar window.</Empty>;
    content = <>{cacheNotice}{trend}</>;
  }
  return <section className="insight-section" aria-labelledby="insight-change-heading"><SectionHeader level={3} title={<span id="insight-change-heading">Where is spending changing?</span>} description="Independent activity window" />{content}</section>;
}

function SpendingInsightsPage({ groupId, groupName }: { groupId?: string; groupName?: string }) {
  const online = useOnlineStatus();
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(() => readInsightFilters(searchParams), [searchParams]);
  const [customDraft, setCustomDraft] = useState({ from: filters.from || '', to: filters.to || '' });
  const [customError, setCustomError] = useState('');
  useEffect(() => { if (filters.period === 'custom') setCustomDraft({ from: filters.from || '', to: filters.to || '' }); }, [filters.period, filters.from, filters.to]);
  const customValid = filters.period !== 'custom' || validInsightRange(filters.from, filters.to);
  const comparison = insightComparisonDateRange(filters.period, filters, new Date());
  const trendRange = insightTrendDateRange();
  const insightScopeKey = `${groupId || 'all'}:${filters.period}:${filters.from || ''}:${filters.to || ''}:${trendRange.trendFrom}:${trendRange.trendTo}`;
  const [implicitSelection, setImplicitSelection] = useState<{ scopeKey: string; currency?: Currency }>({ scopeKey: insightScopeKey });
  useEffect(() => { setImplicitSelection({ scopeKey: insightScopeKey }); }, [insightScopeKey]);
  const me = useResource(resourceKeys.identity(), '', (signal) => getMe({ signal }), RESOURCE_FRESHNESS.expenses, hydrateIdentity);
  const userId = me.data?.id || 'pending';
  const summaryKey = `${groupId || 'all'}:summary:${filters.period}:${filters.from || ''}:${filters.to || ''}:${comparison.from || ''}:${comparison.to || ''}`;
  const trendKey = `${groupId || 'all'}:trends:${trendRange.trendFrom}:${trendRange.trendTo}`;
  const emptySummary: SpendingInsightSummaryResponse = { scope: groupId ? 'group' : 'global', summaries: [] };
  const summary = useResource<SpendingInsightSummaryResponse>(resourceKeys.insights(userId, summaryKey), me.data?.id, (signal) => customValid ? getSpendingInsightSummary(groupId, { from: filters.from, to: filters.to, comparisonFrom: comparison.from, comparisonTo: comparison.to }, signal) : Promise.resolve(emptySummary), RESOURCE_FRESHNESS.insights);
  const trends = useResource<SpendingInsightTrends>(resourceKeys.insights(userId, trendKey), me.data?.id, (signal) => getSpendingInsightTrends(groupId, trendRange, signal), RESOURCE_FRESHNESS.insights);
  const updateUrl = (next: URLSearchParams) => { next.set('view', 'insights'); setSearchParams(next); };
  const selectPeriod = (period: InsightFilters['period']) => { const next = new URLSearchParams(searchParams); next.set('period', period); if (period === 'custom') { next.delete('from'); next.delete('to'); setCustomDraft({ from: '', to: '' }); setCustomError(''); } else { next.delete('from'); next.delete('to'); } updateUrl(next); };
  const applyCustom = () => { const fromError = customDraft.from !== '' && !validInsightRange(customDraft.from, customDraft.from) ? 'Enter a real start date.' : ''; const toError = customDraft.to !== '' && !validInsightRange(customDraft.to, customDraft.to) ? 'Enter a real end date.' : ''; const rangeError = !fromError && !toError && customDraft.from && customDraft.to && customDraft.from > customDraft.to ? 'Start date must not be after end date.' : ''; if (!customDraft.from || !customDraft.to || fromError || toError || rangeError) { setCustomError(fromError || toError || rangeError || 'Choose both dates.'); return; } const next = new URLSearchParams(searchParams); next.set('period', 'custom'); next.set('from', customDraft.from); next.set('to', customDraft.to); setCustomError(''); updateUrl(next); };
  const currencies = useMemo(() => insightCurrencies(summary.data, trends.data, filters.currency), [summary.data, trends.data, filters.currency]);
  const activeCurrencies = useMemo(() => [...new Set([...(summary.data?.summaries || []).map((item) => item.currency), ...(trends.data?.categoryTrends || []).map((item) => item.currency)])].sort(), [summary.data, trends.data]);
  const implicitCurrency = implicitSelection.scopeKey === insightScopeKey && implicitSelection.currency && currencies.includes(implicitSelection.currency) ? implicitSelection.currency : undefined;
  const selectedCurrency = filters.currency || implicitCurrency || effectiveInsightCurrency(undefined, currencies, activeCurrencies);
  useEffect(() => {
    if (filters.currency || implicitSelection.scopeKey !== insightScopeKey) return;
    const next = implicitSelection.currency && currencies.includes(implicitSelection.currency) ? implicitSelection.currency : effectiveInsightCurrency(undefined, currencies, activeCurrencies);
    if (implicitSelection.currency !== next) setImplicitSelection({ scopeKey: insightScopeKey, currency: next });
  }, [activeCurrencies, currencies, filters.currency, implicitSelection, insightScopeKey]);
  const selectCurrency = (currency: Currency) => { const next = new URLSearchParams(searchParams); next.set('currency', currency); updateUrl(next); };
  const periodLabel = filters.period === 'month' ? 'This month to date' : filters.period === 'last-month' ? 'Last month' : filters.period === 'year' ? 'This year to date' : filters.period === 'custom' ? 'Custom range' : 'All time';
  const summaryRetry = retryFor(resourceKeys.insights(userId, summaryKey), me.data?.id);
  const trendRetry = retryFor(resourceKeys.insights(userId, trendKey), me.data?.id);
  const sections = <><InsightSummarySection resource={summary} currency={selectedCurrency} groupId={groupId} online={online} retry={online ? summaryRetry : undefined} summaryValid={customValid} /><InsightTrendsSection resource={trends} currency={selectedCurrency} online={online} retry={online ? trendRetry : undefined} /></>;
  return <section className="insights-page" aria-labelledby="insights-heading"><SectionHeader title={<span id="insights-heading">Spending insights</span>} description={groupId ? `${groupName || 'Selected group'} · ${periodLabel}${filters.from && filters.to ? ` · ${filters.from} to ${filters.to}` : ''}` : `All groups · ${periodLabel}${filters.from && filters.to ? ` · ${filters.from} to ${filters.to}` : ''}`} /><div className="insight-controls" aria-label="Spending insight filters"><Field label="Period"><select value={filters.period} onChange={(event) => selectPeriod(event.target.value as InsightFilters['period'])}><option value="month">This month to date</option><option value="last-month">Last month</option><option value="year">This year to date</option><option value="all">All time</option><option value="custom">Custom range</option></select></Field>{filters.period === 'custom' ? <><Field label="From" errorId="insights-custom-from-error" error={customDraft.from !== '' && !validInsightRange(customDraft.from, customDraft.from) ? 'Enter a real start date.' : undefined}><input type="date" value={customDraft.from} aria-invalid={customDraft.from !== '' && !validInsightRange(customDraft.from, customDraft.from)} aria-describedby={customDraft.from !== '' && !validInsightRange(customDraft.from, customDraft.from) ? 'insights-custom-from-error' : undefined} onChange={(event) => { setCustomDraft((current) => ({ ...current, from: event.target.value })); setCustomError(''); }} /></Field><Field label="To" errorId="insights-custom-to-error" error={customDraft.to !== '' && !validInsightRange(customDraft.to, customDraft.to) ? 'Enter a real end date.' : undefined}><input type="date" value={customDraft.to} aria-invalid={customDraft.to !== '' && !validInsightRange(customDraft.to, customDraft.to)} aria-describedby={customDraft.to !== '' && !validInsightRange(customDraft.to, customDraft.to) ? 'insights-custom-to-error' : undefined} onChange={(event) => { setCustomDraft((current) => ({ ...current, to: event.target.value })); setCustomError(''); }} /></Field><Button type="button" variant="secondary" aria-describedby={customError ? 'insights-custom-range-error' : undefined} onClick={applyCustom}>Apply range</Button>{customError ? <p className="error" id="insights-custom-range-error" role="alert">{customError}</p> : null}</> : null}</div>{!online ? <><ConnectionBanner detail="Refresh is unavailable offline; cached insight data may be shown." /><p className="muted" role="status">Refresh is unavailable offline; cached data may be shown. New server aggregates require a connection.</p></> : null}{currencies.length ? <><InsightCurrencyTabs currencies={currencies} selectedCurrency={selectedCurrency} onSelect={selectCurrency} /><div className="insight-currency-panel" id="insight-currency-panel" role="tabpanel" aria-labelledby={selectedCurrency ? `insight-currency-tab-${selectedCurrency}` : undefined}>{sections}</div></> : sections}</section>;
}

function History() {
  const [searchParams, setSearchParams] = useSearchParams();
  const groupId = searchParams.get('group') || undefined;
  const view = searchParams.get('view') === 'transactions' ? 'transactions' : searchParams.get('view') === 'insights' ? 'insights' : 'changes';
  const me = useResource(resourceKeys.identity(), '', (signal) => getMe({ signal }), RESOURCE_FRESHNESS.expenses, hydrateIdentity);
  const groupsResource = useResource<{ groups: Group[] }>(resourceKeys.groups(me.data?.id || 'pending'), me.data?.id, (signal) => getGroups(signal), RESOURCE_FRESHNESS.groups, me.data?.id ? () => hydrateGroups(me.data!.id) : undefined);
  const groups = sortOptionsByLabel(groupsResource.data?.groups || [], groupDisplayName, (group) => group.id);
  const selectedGroup = groupId ? groups.find((group) => group.id === groupId) : undefined;
  useEffect(() => { if (groupId || !searchParams.has('person')) return; const next = new URLSearchParams(searchParams); next.delete('person'); setSearchParams(next, { replace: true }); }, [groupId, searchParams, setSearchParams]);
  const changeGroup = (nextGroup: string) => { const next = new URLSearchParams(searchParams); if (nextGroup) next.set('group', nextGroup); else next.delete('group'); next.delete('person'); if (view === 'insights') next.delete('currency'); setSearchParams(next); };
  const tabPath = (nextView: 'transactions' | 'changes' | 'insights') => { const next = new URLSearchParams(searchParams); next.set('view', nextView); if (nextView !== 'insights') { next.delete('period'); next.delete('from'); next.delete('to'); next.delete('currency'); } return `/activity?${next}`; };
  return <Layout><PageHeader className="page-title" eyebrow="Authorized groups" title="History" /><section className="activity-filter reading-width" aria-label="History filters"><Field label="Filter by group"><select aria-label="Filter history by group" value={groupId || ''} onChange={(event) => changeGroup(event.target.value)}><option value="">All groups</option>{groups.map((group) => <option value={group.id} key={group.id}>{groupDisplayName(group)}</option>)}</select></Field></section>{groupsResource.error ? <ErrorBox error={groupsResource.error} onRetry={retryFor(resourceKeys.groups(me.data?.id || 'pending'), me.data?.id)} id="history-groups-error" /> : null}{groupId && groupsResource.data && !selectedGroup ? <p className="error" role="alert">This group is no longer available to your account. Choose another group or view all groups.</p> : null}{groupsResource.data === undefined ? groupsResource.error ? null : <Loading /> : <><nav className="history-tabs" aria-label="History views"><Link className={view === 'changes' ? 'active' : ''} aria-current={view === 'changes' ? 'page' : undefined} to={tabPath('changes')}>Changes</Link><Link className={view === 'transactions' ? 'active' : undefined} aria-current={view === 'transactions' ? 'page' : undefined} to={tabPath('transactions')}>Transactions</Link><Link className={view === 'insights' ? 'active' : undefined} aria-current={view === 'insights' ? 'page' : undefined} to={tabPath('insights')}>Insights</Link></nav>{view === 'transactions' ? <HistoryTransactions groupId={groupId} groups={groups} /> : view === 'insights' ? <SpendingInsightsPage groupId={groupId} groupName={selectedGroup ? groupDisplayName(selectedGroup) : undefined} /> : <HistoryChanges groupId={groupId} />}</>}</Layout>;
}

function LegacyActivityRedirect() {
  const { id = '' } = useParams();
  const location = useLocation();
  const search = new URLSearchParams(location.search); search.set('group', id); search.set('view', 'changes');
  return <Navigate to={`/activity?${search}`} replace />;
}

function LegacyTransactionRedirect() {
  const { id = '' } = useParams();
  const location = useLocation();
  const search = new URLSearchParams(location.search); search.set('group', id); search.set('view', 'transactions');
  return <Navigate to={`/activity?${search}`} replace />;
}

function ProfileSettings() {
  const connection = useConnectionState();
  const lifecycle = useAuthLifecycle();
  const online = connection.status === 'connected' && lifecycle.status === 'authenticated';
  const me = useResource(resourceKeys.identity(), '', (signal) => getMe({ signal }), RESOURCE_FRESHNESS.expenses, hydrateIdentity);
  const [name, setName] = useState(me.data?.name || '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState<unknown>();
  useEffect(() => { if (me.data?.name) setName(me.data.name); }, [me.data?.name]);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const value = name.trim();
    if (!online || busy) return;
    if (value.length < 1 || value.length > 120) { setError(new Error('Display name must be between 1 and 120 characters.')); return; }
    setBusy(true); setMessage(''); setError(undefined);
     try { const result = await updateDisplayName(value); setName(result.user.name); setMessage(result.superseded ? `A newer profile update is already active: ${result.user.name}.` : 'Display name updated across your groups.'); }
    catch (cause) { setError(cause); }
    finally { setBusy(false); }
  };
  return <MacroSection title="Profile" className="settings-section" region="frequent"><p className="muted">Your display name is shared across every group. Historical audit entries keep the name captured at the time.</p>{me.error ? <ErrorBox error={me.error} onRetry={retryFor(resourceKeys.identity(), '')} id="profile-load-error" /> : <form onSubmit={save} aria-describedby={error ? 'profile-error' : 'profile-help'}><Field label="Display name"><input required minLength={1} maxLength={120} value={name} onChange={(event) => { setName(event.target.value); setError(undefined); setMessage(''); }} aria-describedby={error ? 'profile-error' : 'profile-help'} /></Field><span id="profile-help" className="muted">1–120 characters. Renaming is available while online.</span>{error ? <ErrorBox error={error} id="profile-error" /> : null}<Button type="submit" data-primary-action="true" disabled={!online || busy || me.data === undefined}>{busy ? 'Saving…' : 'Save name'}</Button>{message ? <p className="cache-status" role="status">{message}</p> : null}{!online ? <p className="muted" role="status">Profile changes require a connection.</p> : null}</form>}</MacroSection>;
}

function SettingsSection({ title, children, className = '' }: { title: ReactNode; children: ReactNode; className?: string }) {
  return <MacroSection title={title} className={`settings-section ${className}`.trim()} region="admin">{children}</MacroSection>;
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
      broadcastSessionCoordination({ type: 'cache-clear', reason: 'cache-clear', clerkUserId: clerkUser?.id || undefined, userId: userId || undefined });
      setMessage('Cached account and group data cleared. Pending expenses were preserved.');
    } catch (cause) { setError(cause); }
    finally { setClearing(false); }
  };

  const logout = async (allDevices = false) => {
    if (!online) { setLogoutError(new Error('Logout requires a connection so the server session can be revoked safely.')); return; }
    if (outbox.length && !confirm(`You have ${outbox.length} unsynced expense${outbox.length === 1 ? '' : 's'}. They will stay on this device and sync only after the same account is verified again. Continue?`)) return;
    setClearing(true); setError(undefined); setLogoutError(undefined);
    try {
      if (allDevices) await revokeAllApplicationSessions(); else await revokeApplicationSession();
      await clearEverythingForLogout();
      try {
        await signOut({ redirectUrl: '/' });
        finalizeSuccessfulClerkSignOut();
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
       if (!clerkUser?.id || !userId) throw new Error('Clerk is still loading this account. Retry account deletion when the identity is available.');
       await deleteAccount(clerkUser.id);
       const result = await completePendingAccountDeletion(clerkUser, signOut, { clerkEvidence: { isLoaded: clerkLoaded === true, isSignedIn, userId } });
       if (result.clerkStatus === 'unsupported') setAccountDeletionMessage('BillSplit data was deleted. This installed Clerk client cannot delete the Clerk account; manage that account separately.');
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
      <PageHeader className="page-title" eyebrow="More" title="Settings" />
      <ProfileSettings />
      <SettingsSection title="Device"><p className="muted" role="status">{connectionStatusLabel(connection.status)} · {outbox.length ? `${outbox.length} expense${outbox.length === 1 ? '' : 's'} pending` : 'No expenses pending'}</p><InstallAction showStatus /></SettingsSection>
      <SettingsSection title="Pending expenses">{outbox.length ? <LedgerList label="Pending expenses">{outbox.map((item) => <LedgerRow key={item.clientOperationId}><span>{item.display.description}<small>{statusLabel(item.status, item.deliveryUncertain)}</small></span><Money amountMinor={item.display.amountMinor} currency={item.display.currency} /></LedgerRow>)}</LedgerList> : <p className="muted">New expenses sync automatically when you are online and signed in.</p>}</SettingsSection>
      <SettingsSection title="Trusted-device offline access"><p className="muted">After a verified visit, this browser keeps a private copy of your identity and recent group data so you can capture new expenses offline. It never stores a Clerk token, and replay still requires an active application session. Only use this on a device you trust.</p></SettingsSection>
      <SettingsSection title="Local data"><p className="muted">Clear cached identity, groups, snapshots, and recent preferences without deleting pending or uncertain outbox expenses. Resolve those from the queue controls before removing them.</p><ActionGroup><Button variant="secondary" disabled={clearing} onClick={() => void clearCache}>{clearing ? 'Clearing…' : 'Clear cached data'}</Button></ActionGroup>{message ? <p className="muted" role="status">{message}</p> : null}{error ? <ErrorBox error={error} /> : null}</SettingsSection>
      <SettingsSection title="Account export"><p className="muted">Download all groups and their transactions as paged JSON. This is online-only, bounded per request, and can be cancelled before the file is written.</p><ActionGroup><Button type="button" variant="secondary" disabled={!online || exporting || clearing} onClick={() => void exportAccount}>{exporting ? 'Exporting account…' : 'Export account JSON'}</Button>{exporting ? <Button type="button" variant="danger" onClick={() => exportController.current?.abort()}>Cancel</Button> : null}</ActionGroup>{exportProgress ? <p className="cache-status" role="status">{exportProgress}</p> : null}{exportError ? <ErrorBox error={exportError} id="account-export-error" /> : null}</SettingsSection>
      <SettingsSection title="Account"><p className="muted">Logging out revokes the server session first, then clears local account data before Clerk ends the session.</p>{logoutError ? <div className="error" id="logout-error" role="alert" aria-live="assertive"><strong>Logout was not completed.</strong> <span>{errorText(logoutError)}</span></div> : null}<ActionGroup><Button variant="danger" disabled={!outboxReady || clearing || exporting || deletingAccount || !online} onClick={() => void logout()}>{outboxReady ? clearing ? 'Signing out securely…' : 'Log out' : 'Checking pending expenses…'}</Button><Button variant="secondary" disabled={!outboxReady || clearing || exporting || deletingAccount || !online} onClick={() => void logout(true)}>Log out all devices</Button></ActionGroup></SettingsSection>
      <SettingsSection title="Delete BillSplit account" className="settings-section--danger"><p className="muted">This permanently removes your BillSplit personal identity, leaves active non-owned groups, revokes pending invitations, and clears private preferences. Financial rows, revisions, and audit name snapshots are retained so shared ledgers remain referentially intact.</p><p className="muted">You must transfer ownership or delete every active group you own first. Type <strong>{ACCOUNT_DELETION_CONFIRMATION}</strong> to continue. This action is online-only.</p><form onSubmit={removeAccount} aria-describedby={accountDeletionError ? 'account-deletion-error' : 'account-deletion-help'}><Field label="Typed confirmation"><input aria-describedby={accountDeletionError ? 'account-deletion-error' : 'account-deletion-help'} aria-invalid={Boolean(accountDeletionError)} required value={deletionConfirmation} onChange={(event) => { setDeletionConfirmation(event.target.value); setAccountDeletionError(undefined); }} /><span id="account-deletion-help" className="muted">Exact text required: {ACCOUNT_DELETION_CONFIRMATION}</span></Field>{accountDeletionError ? <ErrorBox error={accountDeletionError} id="account-deletion-error" /> : null}<Button type="submit" variant="danger" disabled={!online || !clerkUser?.id || clearing || exporting || deletingAccount || deletionConfirmation !== ACCOUNT_DELETION_CONFIRMATION}>{deletingAccount ? 'Deleting account…' : 'Delete BillSplit account'}</Button></form>{accountDeletionMessage ? <p className="muted" role="status">{accountDeletionMessage}</p> : null}</SettingsSection>
    </Layout>;
}

function LegacyScheduledExpenseRedirect() {
  const { id = '' } = useParams();
  return <Navigate to={{ pathname: `/groups/${id}/expense/new`, search: '?recurrence=1' }} replace />;
}

function PrivateRoutes() {
  const identityEpoch = useResourceIdentityEpoch();
  return <Routes key={identityEpoch}><Route path="/" element={<Home />} /><Route path="/friends/new" element={<FriendCreationPage />} /><Route path="/groups/new" element={<GroupCreationPage />} /><Route path="/settings" element={<Settings />} /><Route path="/activity" element={<History />} /><Route path="/add" element={<TransactionChooser />} /><Route path="/expense/new" element={<ExpenseForm />} /><Route path="/groups/:id" element={<GroupOverview />} /><Route path="/groups/:id/add" element={<TransactionChooser />} /><Route path="/groups/:id/transactions" element={<LegacyTransactionRedirect />} /><Route path="/groups/:id/manage" element={<GroupManagementPage />} /><Route path="/groups/:id/expense/new" element={<ExpenseForm />} /><Route path="/groups/:id/credit/new" element={<RefundCreateRoute />} /><Route path="/groups/:id/refund/new" element={<RefundCreateRoute />} /><Route path="/groups/:id/credit/:creditId/edit" element={<RefundEditRoute />} /><Route path="/groups/:id/refund/:creditId/edit" element={<RefundEditRoute />} /><Route path="/groups/:id/credits/:creditId" element={<CreditDetail />} /><Route path="/groups/:id/expense/:expenseId" element={<ExpenseForm />} /><Route path="/groups/:id/scheduled-expense/new" element={<LegacyScheduledExpenseRedirect />} /><Route path="/groups/:id/scheduled-expense/:scheduledExpenseId" element={<ExpenseForm />} /><Route path="/groups/:id/expenses/:expenseId" element={<ExpenseDetail />} /><Route path="/expenses/:expenseId" element={<ExpenseDetail />} /><Route path="/groups/:id/settle" element={<Settle />} /><Route path="/groups/:id/settlements/:settlementId" element={<SettlementDetail />} /><Route path="/groups/:id/activity" element={<LegacyActivityRedirect />} /><Route path="*" element={<Navigate to="/" replace />} /></Routes>;
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
  useEffect(() => {
    if (auth.status !== 'authenticated') return;
    const scheduler = createSessionActivityScheduler({
      isAuthenticated: () => getAuthLifecycle().status === 'authenticated',
      isOnline: () => getConnectionState().status === 'connected',
      isVisible: () => typeof document === 'undefined' || document.visibilityState === 'visible',
      renew: () => recordSessionActivity(),
    });
    return scheduler.dispose;
  }, [auth.status]);
   const [pendingDeletion, setPendingDeletion] = useState(hasPendingAccountDeletion);
   const [pendingDeletionError, setPendingDeletionError] = useState<unknown>();
   const [pendingDeletionRetry, setPendingDeletionRetry] = useState(0);
   const [accountDeletionNotice, setAccountDeletionNotice] = useState(false);
  useEffect(() => {
    const onGroupRevoked = (event: Event) => {
      const groupId = (event as CustomEvent<{ groupId?: string }>).detail?.groupId;
       if (groupId && getNavigationContext(location.pathname, location.search).groupId === groupId) navigate('/', { replace: true });
    };
    window.addEventListener('billsplit-group-revoked', onGroupRevoked);
    return () => window.removeEventListener('billsplit-group-revoked', onGroupRevoked);
   }, [location.pathname, location.search, navigate]);
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
    if (online && completeAccountMismatch) resetForClerkSessionChange(false, currentClerkUserId);
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
   const authoritativeClerkIdentityReady = isDevelopmentAuthBypass || (auth.status === 'authenticated' && Boolean(getVerifiedUserId()) && (isSignedIn !== true || getVerifiedClerkUserId() === userId)) || (auth.status === 'trusted-offline' && !incompleteLoadedSignedInEvidence && (!userId || getTrustedOfflineClerkUserId() === userId));
   if (pendingDeletion) {
     const pendingPhase = getPendingAccountDeletionPhase();
     const pendingIdentity = getPendingAccountDeletionClerkUserId();
     const signedInToDifferentAccount = Boolean(isSignedIn && userId && pendingIdentity && userId !== pendingIdentity);
     const canSignInToRecover = pendingPhase === 'server-pending' || pendingPhase === 'server-deleted' || pendingPhase === 'local-cleared';
      return <PublicShell showAuthActions={false}><div className="public-status" aria-live="polite"><h1>Finishing account deletion…</h1><p className="muted">Private data will not be restored while this identity-bound deletion is pending.</p>{signedInToDifferentAccount ? <><p className="muted">This browser is signed in to a different Clerk account. Sign out, then sign in to the original account to continue.</p><Button type="button" variant="secondary" onClick={() => void signOut({ redirectUrl: '/' })}>Sign out this account</Button></> : canSignInToRecover && isLoaded && isSignedIn === false ? <><p className="muted">Sign in to the same Clerk account that started deletion. BillSplit data is already cleared; provider deletion will not be claimed until that account is verified.</p><SignInButton mode="modal" fallbackRedirectUrl={returnTo}><button className="button" type="button">Sign in to finish deletion</button></SignInButton>{pendingPhase !== 'server-pending' ? <><p className="muted">If that original Clerk account was deleted elsewhere, you may finish local cleanup here. This does not delete or manage Clerk.</p><Button type="button" variant="secondary" onClick={finishExternalProviderCleanup}>Finish local cleanup</Button></> : null}</> : null}{pendingDeletionError ? <><ErrorBox error={pendingDeletionError} id="account-deletion-recovery-error" />{hasInvalidPendingAccountDeletion() ? <Button type="button" variant="secondary" onClick={discardInvalidDeletionMarker}>Discard invalid recovery marker</Button> : <Button type="button" variant="secondary" onClick={retryPendingDeletion}>Retry cleanup</Button>}</> : <Loading />}</div></PublicShell>;
     }
     // Clerk's loaded signed-out evidence is synchronous input to this render.
     // Do not wait for the coordinator effect before masking a private tree.
     // A failed provider sign-out has an explicit retry lifecycle and must keep
     // its existing error UI instead of being replaced by this fast path.
     if (signOutRetryError) return <PublicLanding logoutError={signOutRetryError} accountDeletionNotice={accountDeletionNotice} />;
      if (logoutInProgress) return <PublicShell returnTo={returnTo}><div className="public-status" aria-live="polite"><p className="muted">Signing out securely…</p></div></PublicShell>;
     if (definitiveSignedOut && auth.status === 'unauthenticated') return <PublicLanding accountDeletionNotice={accountDeletionNotice} />;
      if (knownClerkIdentityMismatch) return <AuthLoadingShell />;
    if (auth.status === 'checking') return <AuthLoadingShell />;
  // Clerk can report signed-in before it has supplied both pieces of
  // session evidence. Keep the private route tree out of that bounded window
  // even if a previously trusted offline lifecycle is still visible.
  if (incompleteLoadedSignedInEvidence && auth.status !== 'verification-unavailable') {
     if (!retainedPrivateView) return <AuthLoadingShell />;
  }
   if (auth.status === 'unauthenticated') return <PublicLanding logoutError={auth.error instanceof Error && auth.error.name === 'ClerkSignOutFailure' ? auth.error : undefined} accountDeletionNotice={accountDeletionNotice} />;
   if (cachedAuthLifecycle && location.pathname !== '/settings' && !privateCacheRouteMatches) {
     // A previous route's cache contract is never valid for this location.
     // Keep this synchronous guard ahead of PrivateRoutes while the new route
     // restore is in flight; an unspecified contract is fail-closed.
     if (!auth.privateCacheRouteKey) return <PrivateCacheUnavailable onRetry={retryVerification} />;
      return <AuthLoadingShell />;
   }
    if (cachedAuthLifecycle && location.pathname !== '/settings' && auth.privateCacheAvailable === undefined) return <AuthLoadingShell />;
   if (cachedAuthLifecycle && auth.privateCacheAvailable === false) return <PrivateCacheUnavailable onRetry={retryVerification} />;
   if (auth.status === 'verification-unavailable') return <VerificationUnavailable onRetry={retryVerification} />;
   if ((auth.status === 'restoring' || auth.status === 'reverifying') && !retainedPrivateView) return <AuthLoadingShell />;
    if (auth.status === 'authenticated' && (sessionTransitionPending || !authoritativeClerkIdentityReady)) return <AuthLoadingShell />;
  return <PrivateRoutes />;
}
