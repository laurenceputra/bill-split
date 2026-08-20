import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { Balances, Currency, Expense, Group, GroupMember, Settlement, SplitMethod } from '../shared/types';
import { currencyOptions, type ExpenseInput } from '../shared/schemas';
import { checkedSumMinor, formatMoney, parseMoney } from '../domain/money';
import { ApiError, api, getActivity, getBalances, getExpenseDetails, getExpenses, getGroup, getGroups, getMe, getSettlements, hydrateActivity, hydrateBalances, hydrateExpenseDetails, hydrateExpenses, hydrateGroup, hydrateGroups, hydrateIdentity, hydrateSettlements } from './api';
import { allocationMetadataByPerson, allocationSplits, allocationStateFromSplits, currentPayerSelection, normalizeSinglePayer, previewAllocation, settlementSuggestion, type AllocationState } from './form-helpers';
import { Button, Field, InstallAction, Layout, Modal, Money, Status, Surface, useOnlineStatus } from './ui';
import { discardOutboxItem, enqueueExpense, flushOutbox, getOutboxSnapshot, initializeOutbox, retryOutboxItem, statusLabel, subscribeOutbox, type ExpenseOutboxItem } from './outbox';
import { clearCachedData } from './idb';
import { invalidateForMutation, RESOURCE_FRESHNESS, resourceKeys, useResource, useResourceIdentityEpoch } from './resource-cache';

const today = () => new Date().toISOString().slice(0, 10);
const operationId = () => crypto.randomUUID();
const errorText = (error: unknown) => error instanceof ApiError && error.networkFailure ? (error.reconnectRequired ? 'Connection failed while online. Reconnect or check your session; your pending expense remains retryable.' : 'You appear to be offline. Only new expenses can be queued; edits, deletes, settlements, and membership changes require a connection.') : error instanceof Error ? error.message : 'Something went wrong';
function Loading() { return <p className="muted">Loading…</p>; }
function ErrorBox({ error }: { error: unknown }) { return <div className="error" role="alert">{errorText(error)}</div>; }
function Empty({ children }: { children: ReactNode }) { return <div className="empty">{children}</div>; }
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
  const error = groupsResource.error || me.error;
  const offline = Boolean(groupsResource.offline || me.offline);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState<Currency>('USD');
  const [searchParams, setSearchParams] = useSearchParams();
  const nav = useNavigate();
  const newGroupRequested = searchParams.get('new') === '1';
  const offlineView = offline || !online;

  useEffect(() => {
    if (newGroupRequested) {
      setCreating(true);
      searchParams.delete('new');
      setSearchParams(searchParams, { replace: true });
    }
  }, [newGroupRequested, searchParams, setSearchParams]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    try {
      const result = await api<{ group: Group }>('/groups', { method: 'POST', body: JSON.stringify({ name, currency }) });
      if (result.group) { invalidateForMutation.groupCreated(me.data?.id); nav(`/groups/${result.group.id}`); }
    } catch (cause) { /* Keep the cached screen visible while reporting mutation errors. */ console.error(cause); }
  };

  return <Layout>
    <div className="page-title"><div><p className="eyebrow">Private expenses</p><h1>Your groups</h1></div><Button disabled={offlineView} onClick={() => setCreating((current) => !current)} variant="secondary">{creating ? 'Cancel' : '+ New group'}</Button></div>
    {creating && <Surface><form onSubmit={create}><Field label="Group name"><input required value={name} onChange={(event) => setName(event.target.value)} /></Field><Field label="Default currency"><CurrencySelect value={currency} onChange={setCurrency} /></Field><Button disabled={offlineView} type="submit">Create group</Button></form></Surface>}
    {offlineView ? <p className="offline-banner" role="status">Offline · showing your last verified groups. Group creation requires a connection; Add Expense remains available from cached groups.</p> : null}{error ? <ErrorBox error={error} /> : null}
    {groupsResource.revalidating || groupsResource.stale ? <p className="cache-status" role="status">{groupsResource.revalidating ? 'Refreshing groups…' : 'Showing stale groups'}</p> : null}{!groups.length && !error && groupsResource.loading ? <Loading /> : !groups.length && !error ? <Empty>No groups yet. Create one to get started.</Empty> : <div className="cards">{groups.map((group) => <Link className="card" to={`/groups/${group.id}`} key={group.id}><strong>{group.name}</strong><span>{group.currency}</span></Link>)}</div>}
  </Layout>;
}

function GroupPage() {
  const online = useOnlineStatus();
  const { id = '' } = useParams();
  const me = useResource(resourceKeys.identity(), '', (signal) => getMe({ signal }), RESOURCE_FRESHNESS.expenses, hydrateIdentity);
  const userId = me.data?.id || 'pending';
  const groupResource = useResource<{ group: Group; members: GroupMember[] }>(resourceKeys.group(userId, id), me.data?.id, (signal) => getGroup(id, signal), RESOURCE_FRESHNESS.group, me.data?.id ? () => hydrateGroup(me.data!.id, id) : undefined);
  const expensesResource = useResource<{ expenses: Expense[] }>(resourceKeys.expenses(userId, id), me.data?.id, (signal) => getExpenses(id, signal), RESOURCE_FRESHNESS.expenses, me.data?.id ? () => hydrateExpenses(me.data!.id, id) : undefined);
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
  const [pending, setPending] = useState<ExpenseOutboxItem[]>([]);
  const error = groupResource.error || expensesResource.error || balancesResource.error || settlementsResource.error || me.error;
  const offline = Boolean(groupResource.offline || expensesResource.offline || balancesResource.offline || settlementsResource.offline || me.offline);
  const refreshing = [groupResource, expensesResource, balancesResource, settlementsResource].some((resource) => resource.revalidating);
  const partialErrors = [groupResource, expensesResource, balancesResource, settlementsResource].filter((resource) => resource.error);
  useEffect(() => { setPending(getOutboxSnapshot().filter((item) => item.userId === currentUserId && item.groupId === id)); }, [id, currentUserId]);
  useEffect(() => { const unsubscribe = subscribeOutbox(() => setPending(getOutboxSnapshot().filter((item) => item.userId === currentUserId && item.groupId === id))); return () => { unsubscribe(); }; }, [id, currentUserId]);

  if (error && !group) return <Layout><ErrorBox error={error} /><Link className="back" to="/">← Groups</Link></Layout>;
  if (!group) return <Layout><Loading /></Layout>;
  const offlineView = offline || !online;
  const addPerson = async (event: FormEvent) => {
    event.preventDefault();
    if (!personName.trim()) return;
    try { await api(`/groups/${id}/people`, { method: 'POST', body: JSON.stringify({ name: personName, email: personEmail.trim() || undefined }) }); setPersonName(''); setPersonEmail(''); setAddingPerson(false); invalidateForMutation.groupChanged(id, currentUserId); }
    catch (cause) { /* Mutation errors do not remove the current authoritative view. */ console.error(cause); }
  };
  const memberLabel = (personId: string) => personId === currentPersonId ? 'You' : nameOf(members, personId);

   return <Layout>
     <Link to="/" className="back">← Groups</Link>
     <div className="page-title"><div><p className="eyebrow">{group.currency} group</p><h1>{group.name}</h1></div><Link className="button" to={`/groups/${id}/expense/new`}>+ Add expense</Link></div>
     {offlineView ? <p className="offline-banner" role="status">Offline · stale data is available. Only new expenses can be captured; settle, activity, exports, and member changes require a connection.</p> : null}{refreshing ? <p className="cache-status" role="status">Refreshing group data…</p> : null}{partialErrors.length ? <p className="cache-status" role="status">Some group data could not refresh; cached sections remain visible.</p> : null}
     <div className="actions"><Link to={`/groups/${id}/settle`}>Settle up</Link><Link to={`/groups/${id}/activity`}>Activity</Link>{!offlineView ? <><a href={`/api/groups/${id}/export.csv`}>CSV export</a><a href={`/api/groups/${id}/export.json`}>JSON export</a></> : null}</div>
     <div className="group-overview-grid">
       {Object.entries(balances).map(([currencyKey, balance]) => <section key={currencyKey}><h2>Balances <small>({currencyKey})</small></h2>{balance.simplified.length ? <div className="list">{balance.simplified.map((item) => <div className="row" key={`${currencyKey}-${item.fromPersonId}-${item.toPersonId}`}><span>{item.fromPersonId === currentPersonId ? 'You' : item.fromName} owes {item.toPersonId === currentPersonId ? 'You' : item.toName}<Status tone="debt">Debt</Status></span><Money amountMinor={item.amountMinor} currency={currencyKey} tone="debt" /></div>)}</div> : <Empty>Everyone is settled up.</Empty>}</section>)}
       <section><div className="section-title"><h2>People</h2>{!offlineView && group.role === 'owner' && <Button variant="secondary" onClick={() => setAddingPerson((current) => !current)}>{addingPerson ? 'Cancel' : '+ Add'}</Button>}</div>{!offlineView && addingPerson && <form onSubmit={addPerson}><Field label="Name"><input required value={personName} onChange={(event) => setPersonName(event.target.value)} /></Field><Field label="Email (optional)"><input type="email" value={personEmail} onChange={(event) => setPersonEmail(event.target.value)} /></Field><Button type="submit">Add person</Button></form>}<div className="chips">{members.map((member) => <span className="chip" key={member.personId}>{member.personId === currentPersonId ? 'You' : member.name}{member.email ? <small> · {member.email}</small> : null}</span>)}</div></section>
     </div>
     <div className="group-ledger">
       <section><h2>Recent expenses</h2>{expenses.length || pending.length ? <div className="list">{pending.map((item) => <PendingExpenseRow key={item.clientOperationId} item={item} onRetry={() => { void retryOutboxItem(item.clientOperationId).catch((cause) => console.error(cause)); }} onDiscard={() => { if (confirm('Discard this pending expense?')) void discardOutboxItem(item.clientOperationId).catch((cause) => console.error(cause)); }} />)}{expenses.map((expense) => <Link className="row" to={`/groups/${expense.groupId}/expenses/${expense.id}`} key={expense.id}><span>{expense.description}<small>{expense.date} · {expense.currency}</small></span><Money amountMinor={expense.amountMinor} currency={expense.currency} /></Link>)}</div> : <Empty>No expenses yet.</Empty>}</section>
       {settlements.length ? <section><h2>Recent settlements</h2><div className="list">{settlements.map((settlement) => <div className="row" key={settlement.id}><span>{settlement.date}<small>{memberLabel(settlement.fromPersonId)} paid {memberLabel(settlement.toPersonId)}</small><Status tone="positive">Paid</Status></span><Money amountMinor={settlement.amountMinor} currency={settlement.currency} tone="positive" /></div>)}</div></section> : null}
     </div>
   </Layout>;
}

function PendingExpenseRow({ item, onRetry, onDiscard }: { item: ExpenseOutboxItem; onRetry: () => void; onDiscard: () => void }) {
  const syncing = item.status === 'syncing' && (item.leaseExpiresAt === undefined || item.leaseExpiresAt > Date.now());
  const cannotDiscard = syncing || Boolean(item.deliveryUncertain);
  const explanation = syncing ? 'An in-flight server write cannot be safely cancelled.' : item.deliveryUncertain ? 'The server may have committed this expense; retry or wait for reconciliation.' : undefined;
  return <div className="row pending-row"><span>{item.display.description}<small>{item.display.date} · {item.display.currency} · <Status tone={item.status === 'failed' ? 'debt' : 'positive'}>{statusLabel(item.status, item.deliveryUncertain)}</Status></small>{item.lastError ? <small>{item.lastError.message}</small> : null}{explanation ? <small>{explanation}</small> : null}</span><div className="pending-row__actions"><Money amountMinor={item.display.amountMinor} currency={item.display.currency} /><Button disabled={syncing} type="button" variant="secondary" onClick={onRetry}>Retry</Button><Button disabled={cannotDiscard} title={explanation} type="button" variant="danger" onClick={onDiscard}>Discard</Button></div></div>;
}

type PayerRow = { personId: string; amount: string };

function ExpenseForm() {
  const online = useOnlineStatus();
  const { id = '', expenseId } = useParams();
  const nav = useNavigate();
  const meResource = useResource(resourceKeys.identity(), '', (signal) => getMe({ signal }), RESOURCE_FRESHNESS.expenses, hydrateIdentity);
  const formUserId = meResource.data?.id || 'pending';
  const groupResource = useResource<{ group: Group; members: GroupMember[] }>(resourceKeys.group(formUserId, id), meResource.data?.id, (signal) => getGroup(id, signal), RESOURCE_FRESHNESS.group, meResource.data?.id ? () => hydrateGroup(meResource.data!.id, id) : undefined);
  const detailResource = useResource<{ expense: Expense; history: Array<{ id: string; revision: number; createdAt: string }> }>(resourceKeys.expenseDetail(formUserId, expenseId || 'new'), meResource.data?.id, async (signal) => expenseId ? getExpenseDetails(expenseId, signal) : { expense: undefined as unknown as Expense, history: [] }, RESOURCE_FRESHNESS.expenseDetail, expenseId && meResource.data?.id ? () => hydrateExpenseDetails(meResource.data!.id, expenseId) : undefined);
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [group, setGroup] = useState<Group>();
  const [currentPersonId, setCurrentPersonId] = useState('');
  const [currentUserId, setCurrentUserId] = useState('');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState<Currency>('USD');
  const [date, setDate] = useState(today());
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
  const [error, setError] = useState<unknown>();
  const [offlineData, setOfflineData] = useState(false);
  const [formReady, setFormReady] = useState(false);

  useEffect(() => {
    const groupResult = groupResource.data;
    const me = meResource.data;
    if (!groupResult || !me) return;
      setGroup(groupResult.group); setMembers(groupResult.members); setCurrentPersonId(me.personId); setCurrentUserId(me.id); setOfflineData(Boolean(groupResource.offline || meResource.offline || detailResource.offline));
      const expense = detailResource.data?.expense;
      setCurrency(expense?.currency ?? groupResult.group.currency);
      if (expense) {
        const loadedMethod = expense.splits[0]?.metadata?.method;
        const nextMethod: SplitMethod = loadedMethod === 'exact' || loadedMethod === 'percentage' || loadedMethod === 'shares' ? loadedMethod : 'equal';
        setDescription(expense.description); setAmount(moneyInput(expense.amountMinor)); setDate(expense.date); setCategory(expense.category || ''); setNotes(expense.notes || ''); setMethod(nextMethod); setSelected(expense.splits.map((split) => split.personId)); setAllocationValues(allocationStateFromSplits(expense.splits, nextMethod)); setExistingSplitMetadata(allocationMetadataByPerson(expense.splits)); setVersion(expense.version); setPayerRows(expense.payers.map((payer) => ({ personId: payer.personId, amount: moneyInput(payer.amountMinor) })));
      } else {
        const payer = currentPayerSelection(me.personId, groupResult.members);
        setSelected(groupResult.members.map((member) => member.personId)); setPayerRows(payer ? [{ personId: payer, amount: '' }] : []);
      }
      setFormReady(true);
  }, [groupResource.data, groupResource.offline, meResource.data, meResource.offline, detailResource.data, detailResource.offline]);

  const resourceError = error || meResource.error || groupResource.error || (expenseId && detailResource.error);
  if (resourceError && !(group && formReady)) return <Layout><ErrorBox error={resourceError} /></Layout>;
  if (!group) return <Layout><Loading /></Layout>;
  const editUnavailable = Boolean(expenseId) && (!online || offlineData);
  const amountMinor = (() => { try { return parseMoney(amount, currency); } catch { return 0; } })();
  const preview = previewAllocation(amountMinor, selected, method, allocationValues, currency);
  const isYou = (personId: string) => personId === currentPersonId;
  const setAmountAndPayer = (value: string) => { setAmount(value); if (payerRows.length === 1) setPayerRows((rows) => rows.map((row) => ({ ...row, amount: value }))); };
  const toggleSplit = (personId: string) => setSelected((current) => current.includes(personId) ? current.filter((idValue) => idValue !== personId) : [...current, personId]);
  const updateAllocation = (personId: string, value: string) => setAllocationValues((current) => ({ ...current, [personId]: value }));
  const addPayer = () => { const personId = members.find((member) => !payerRows.some((payer) => payer.personId === member.personId))?.personId; if (personId) setPayerRows((rows) => [...rows, { personId, amount: '' }]); };
  const removePayer = (index: number) => setPayerRows((rows) => normalizeSinglePayer(rows.filter((_, rowIndex) => rowIndex !== index), amount));
  const payerIsFullTotal = payerRows.length === 1 && amount.trim() !== '' && amountMinor > 0 && (() => { try { return parseMoney(payerRows[0].amount, currency) === amountMinor; } catch { return false; } })();
  const payerSummary = payerRows.length === 1 ? `Paid by ${isYou(payerRows[0].personId) ? 'You' : nameOf(members, payerRows[0].personId)}` : payerRows.length ? `Paid by ${payerRows.length} people` : 'Choose who paid';
  const payerSummaryDetail = payerRows.length === 1 ? (payerIsFullTotal ? 'Entire total' : 'Amount needs review') : payerRows.length ? 'Configure exact amounts' : 'Choose a payer';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true); setError(undefined);
    try {
      if (!description.trim()) throw new Error('Add a short description.');
      if (!amount) throw new Error('Enter an expense amount.');
      const cents = parseMoney(amount, currency);
      if (!selected.length) throw new Error('Select at least one participant.');
      const payers = payerRows.map((payer) => ({ person_id: payer.personId, amount_minor: parseMoney(payer.amount || '0', currency) }));
       if (checkedSumMinor(payers.map((payer) => payer.amount_minor)) !== cents) throw new Error('Payer amounts must equal the expense total.');
      if (preview.error || preview.remainingMinor !== 0) throw new Error(preview.error || 'Split amounts must equal the expense total.');
      const input = { description: description.trim(), amount_minor: cents, currency, date, category: category.trim() || null, notes: notes || null, payers, splits: allocationSplits(selected, method, preview, allocationValues, existingSplitMetadata), version, client_operation_id: expenseId ? undefined : operation };
        if (expenseId) { await api(`/expenses/${expenseId}`, { method: 'PUT', body: JSON.stringify(input) }); invalidateForMutation.expenseChanged(id, expenseId, currentUserId); }
       else {
         const me = currentUserId ? { id: currentUserId } : await getMe();
         const payload = input as ExpenseInput;
         await enqueueExpense({ userId: me.id, groupId: id, payload, clientOperationId: operation, display: { description: payload.description, amountMinor: payload.amount_minor, currency: payload.currency, date: payload.date } });
          await flushOutbox();
          invalidateForMutation.expenseChanged(id, undefined, currentUserId);
       }
      nav(`/groups/${id}`);
    } catch (cause) { setSubmitting(false); setError(cause); }
  };

  return <Layout>
      <div className="page-title expense-heading"><div><Link to={`/groups/${id}`} className="back">← <span className="back__label">{group.name}</span></Link><p className="eyebrow">{expenseId ? 'Edit expense' : 'New expense'}</p><h1>{expenseId ? 'Edit expense' : 'Add expense'}</h1></div><div className="expense-heading__actions"><Link className="button button--secondary" to={`/groups/${id}`}>Cancel</Link></div></div>{resourceError ? <p className="cache-status" role="status">Showing cached form data; refresh failed and your edits are preserved.</p> : null}
      {editUnavailable ? <p className="offline-banner" role="status">Editing expenses is online-only. Reconnect before saving changes.</p> : null}<form className="expense-form reading-width" onSubmit={submit}>
       <Field label="Amount and currency" className="amount-field"><CurrencySelect value={currency} onChange={setCurrency} /><input required inputMode="decimal" aria-label="Expense amount" placeholder="0.00" value={amount} onChange={(event) => setAmountAndPayer(event.target.value)} /></Field>
       <Field label="Description" className="field--compact"><input required placeholder="What was this for?" value={description} onChange={(event) => setDescription(event.target.value)} /></Field>
       <button className="summary-row" type="button" onClick={() => setPayersOpen(true)}><span><span className="summary-row__label">{payerSummary}</span><small>{payerSummaryDetail}</small></span><strong>Change</strong></button>
       <fieldset><legend>Split between</legend><div className="participant-list">{members.map((member) => { const active = selected.includes(member.personId); return <button className="participant-row" type="button" aria-pressed={active} key={member.personId} onClick={() => toggleSplit(member.personId)}><span className="participant-row__name"><span className="checkmark" aria-hidden="true">✓</span><span className="participant-row__label">{member.name}</span>{isYou(member.personId) ? <small>You</small> : null}</span>{active && method === 'equal' ? <span className="allocation-row__amount">{formatMoney(preview.allocations[member.personId] || 0, currency)}</span> : null}</button>; })}</div></fieldset>
      <div className="secondary-fields"><Field label="Split method" className="field--compact"><select value={method} onChange={(event) => setMethod(event.target.value as SplitMethod)}><option value="equal">Equal</option><option value="exact">Exact amounts</option><option value="percentage">Percentage</option><option value="shares">Shares</option></select></Field>
        {method !== 'equal' && <div className="allocation-list">{members.filter((member) => selected.includes(member.personId)).map((member) => <div className="allocation-row" key={member.personId}><span className="allocation-row__person"><span>{member.name}{isYou(member.personId) ? ' · You' : ''}</span><span className="allocation-row__amount">{preview.allocations[member.personId] !== undefined ? formatMoney(preview.allocations[member.personId], currency) : '—'}</span></span><input required inputMode="decimal" aria-label={`${member.name} ${method} value`} placeholder={method === 'exact' ? '0.00' : method === 'percentage' ? '%' : 'Shares'} value={allocationValues[member.personId] || ''} onChange={(event) => updateAllocation(member.personId, event.target.value)} /></div>)}<p className="allocation-summary" role="status">{method === 'exact' ? `Remaining ${formatMoney(preview.remainingMinor ?? amountMinor, currency)}` : method === 'percentage' ? `Remaining ${preview.remainingPercent ?? 100}%` : `Total shares ${preview.totalValue || 0}`}</p>{preview.error ? <p className="error" role="alert">{preview.error}</p> : null}</div>}
        <div className="form-row"><Field label="Date" className="field--compact"><input required type="date" value={date} onChange={(event) => setDate(event.target.value)} /></Field><Field label="Category (optional)" className="field--compact"><input value={category} onChange={(event) => setCategory(event.target.value)} /></Field></div><Field label="Notes (optional)" className="field--compact"><textarea rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} /></Field>
      </div>
       {error ? <ErrorBox error={error} /> : null}<Button className="full-width-button" disabled={submitting || editUnavailable} type="submit">{submitting ? 'Saving…' : expenseId ? 'Save changes' : 'Save expense'}</Button>
    </form>
     {payersOpen && <Modal title="Who paid?" onClose={() => setPayersOpen(false)}><p className="muted">Use one payer for a quick entry, or add people and enter exact amounts.</p><div className="payer-list">{payerRows.map((payer, index) => <div className={`payer-row${payerRows.length > 1 ? ' payer-row--removable' : ''}`} key={`${payer.personId}-${index}`}><select aria-label={`Payer ${index + 1}: ${isYou(payer.personId) ? 'You' : nameOf(members, payer.personId)}`} value={payer.personId} onChange={(event) => setPayerRows((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, personId: event.target.value } : row))}>{members.filter((member) => !payerRows.some((other, otherIndex) => other.personId === member.personId && otherIndex !== index)).map((member) => <option key={member.personId} value={member.personId}>{member.name}{isYou(member.personId) ? ' · You' : ''}</option>)}</select><input required inputMode="decimal" aria-label={`Amount paid by ${isYou(payer.personId) ? 'You' : nameOf(members, payer.personId)} (payer ${index + 1})`} placeholder="Amount" value={payer.amount} onChange={(event) => setPayerRows((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, amount: event.target.value } : row))} />{payerRows.length > 1 && <Button type="button" variant="secondary" aria-label={`Remove payer ${isYou(payer.personId) ? 'You' : nameOf(members, payer.personId)} (payer ${index + 1})`} onClick={() => removePayer(index)}>Remove</Button>}</div>)}</div><p className="allocation-summary" role="status">Payers total {formatMoney(payerRows.reduce((sum, payer) => { try { return sum + parseMoney(payer.amount || '0', currency); } catch { return sum; } }, 0), currency)} of {formatMoney(amountMinor, currency)}</p><Button className="full-width-button" type="button" variant="secondary" onClick={addPayer}>+ Add payer</Button><Button className="full-width-button" type="button" onClick={() => setPayersOpen(false)}>Done</Button></Modal>}
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
  useEffect(() => { if (expense && !id) nav(`/groups/${expense.groupId}/expenses/${expenseId}`, { replace: true }); }, [expense, expenseId, id, nav]);
  if (!expense && error) return <Layout><ErrorBox error={error} /></Layout>;
  if (!expense) return <Layout><Loading /></Layout>;
  const remove = async () => { if (!confirm('Delete this expense?')) return; try { await api(`/expenses/${expense.id}?version=${expense.version}`, { method: 'DELETE' }); invalidateForMutation.expenseChanged(expense.groupId, expense.id, me.data?.id); nav(`/groups/${expense.groupId}`); } catch (cause) { console.error(cause); } };
   return <Layout><Link to={`/groups/${expense.groupId}`} className="back">← Group</Link><div className="page-title"><div><p className="eyebrow">{expense.date}</p><h1>{expense.description}</h1></div><Money amountMinor={expense.amountMinor} currency={expense.currency} size="large" /></div>{detailsResource.revalidating ? <p className="cache-status" role="status">Refreshing expense history…</p> : null}{detailsResource.error || groupResource.error ? <p className="cache-status" role="status">Showing cached expense data; related details may be unavailable.</p> : null}<section className="reading-width"><h2>Payers</h2><div className="list">{expense.payers.map((payer) => <div className="row" key={payer.personId}><span>{nameOf(members, payer.personId)}</span><Money amountMinor={payer.amountMinor} currency={expense.currency} /></div>)}</div><h2>Split</h2><div className="list">{expense.splits.map((split) => <div className="row" key={split.personId}><span>{nameOf(members, split.personId)}</span><Money amountMinor={split.amountMinor} currency={expense.currency} /></div>)}</div>{expense.category ? <p className="muted">Category: {expense.category}</p> : null}{expense.notes ? <p className="muted">{expense.notes}</p> : null}</section>{online && !offlineData ? <div className="actions"><Link className="button" to={`/groups/${expense.groupId}/expense/${expense.id}`}>Edit</Link><Button variant="danger" onClick={remove}>Delete</Button></div> : <p className="offline-banner" role="status">Editing and deleting expenses require a connection.</p>}<section className="reading-width"><h2>History</h2>{history.length ? <div className="list">{history.map((item) => <div className="row" key={item.id}><span>Revision {item.revision}</span><small>{item.createdAt}</small></div>)}</div> : <Empty>No edits yet.</Empty>}</section></Layout>;
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
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState<Currency>('USD');
  const currentPersonId = me.data?.personId || '';
  const [operation] = useState(operationId);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>();
  const offlineData = Boolean(me.offline || groupResource.offline || balancesResource.offline);
  useEffect(() => {
    if (!group || !me.data || !balancesResource.data) return;
    const suggestion = settlementSuggestion(balancesResource.data.balances, me.data.personId, group.currency);
    setCurrency(suggestion?.currency || group.currency); setFrom(suggestion?.fromPersonId || members[0]?.personId || ''); setTo(suggestion?.toPersonId || members.find((member) => member.personId !== (suggestion?.fromPersonId || members[0]?.personId))?.personId || ''); setAmount(suggestion ? moneyInput(suggestion.amountMinor) : '');
  }, [group, me.data, balancesResource.data, members]);
  const resourceError = error || me.error || groupResource.error || balancesResource.error;
  if (!group) return <Layout>{resourceError ? <ErrorBox error={resourceError} /> : <Loading />}</Layout>;
   if (!online || offlineData) return <Layout><Link to={`/groups/${id}`} className="back">← <span className="back__label">{group.name}</span></Link><div className="page-title"><div><p className="eyebrow">Cached balance</p><h1>Settle up</h1></div></div><p className="offline-banner" role="status">Settlements are online-only. Reconnect to submit; cached balances remain available.</p>{Object.entries(balancesResource.data?.balances || {}).map(([currencyKey, balance]) => <section className="reading-width" key={currencyKey}><h2>Balances <small>({currencyKey})</small></h2>{balance.simplified.length ? <div className="list">{balance.simplified.map((item) => <div className="row" key={`${currencyKey}-${item.fromPersonId}-${item.toPersonId}`}><span>{item.fromPersonId === currentPersonId ? 'You' : item.fromName} owes {item.toPersonId === currentPersonId ? 'You' : item.toName}</span><Money amountMinor={item.amountMinor} currency={currencyKey} tone="debt" /></div>)}</div> : <Empty>Everyone is settled up.</Empty>}</section>)}</Layout>;
  const submit = async (event: FormEvent) => { event.preventDefault(); if (submitting) return; setSubmitting(true); setError(undefined); try { await api(`/groups/${id}/settlements`, { method: 'POST', body: JSON.stringify({ from_person_id: from, to_person_id: to, amount_minor: parseMoney(amount, currency), currency, date: today(), client_operation_id: operation }) }); invalidateForMutation.settlementChanged(id, me.data?.id); nav(`/groups/${id}`); } catch (cause) { setSubmitting(false); setError(cause); } };
    return <Layout><Link to={`/groups/${id}`} className="back">← <span className="back__label">{group.name}</span></Link><div className="page-title"><div><p className="eyebrow">{currentPersonId ? 'Suggested from your balance' : 'Payment'}</p><h1>Settle up</h1></div></div><p className="muted">Record a payment. Partial settlements are supported.</p><form className="reading-width" onSubmit={submit}><Field label="Who paid?"><select value={from} onChange={(event) => setFrom(event.target.value)}>{members.map((member) => <option key={member.personId} value={member.personId}>{member.name}{member.personId === currentPersonId ? ' · You' : ''}</option>)}</select></Field><Field label="Who received?"><select value={to} onChange={(event) => setTo(event.target.value)}>{members.filter((member) => member.personId !== from).map((member) => <option key={member.personId} value={member.personId}>{member.name}{member.personId === currentPersonId ? ' · You' : ''}</option>)}</select></Field><Field label="Currency"><CurrencySelect value={currency} onChange={setCurrency} /></Field><Field label={`Amount (${currency})`}><input required inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} /></Field>{error ? <ErrorBox error={error} /> : null}<Button className="full-width-button" disabled={submitting} type="submit">{submitting ? 'Recording…' : 'Record payment'}</Button></form></Layout>;
}

function Activity() {
  const online = useOnlineStatus();
  const { id = '' } = useParams();
  const me = useResource(resourceKeys.identity(), '', (signal) => getMe({ signal }), RESOURCE_FRESHNESS.expenses, hydrateIdentity);
  const activity = useResource<{ activity: Array<{ type: string; id: string; label: string | null; createdAt: string }> }>(resourceKeys.activity(me.data?.id || 'pending', id), me.data?.id, (signal) => getActivity(id, signal), RESOURCE_FRESHNESS.activity, me.data?.id ? () => hydrateActivity(me.data!.id, id) : undefined);
  const items = activity.data?.activity || [];
   return <Layout><Link to={`/groups/${id}`} className="back">← Group</Link><h1>Activity</h1>{!online || activity.offline ? <p className="offline-banner" role="status">Offline · showing cached activity.</p> : null}{activity.error || me.error ? <p className="cache-status" role="status">Activity refresh failed; cached activity remains available.</p> : null}{activity.revalidating ? <p className="cache-status" role="status">Refreshing activity…</p> : null}{items.length ? <div className="list reading-width">{items.map((item) => <div className="row" key={`${item.type}-${item.id}`}><span>{item.type}: {item.label}</span><small>{item.createdAt}</small></div>)}</div> : activity.loading ? <Loading /> : activity.error || me.error ? null : <Empty>No activity yet.</Empty>}</Layout>;
}

function Settings() {
  const online = useOnlineStatus();
  const [outbox, setOutbox] = useState<ExpenseOutboxItem[]>(getOutboxSnapshot());
  const [outboxReady, setOutboxReady] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState<unknown>();
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

  const logout = () => {
    if (outbox.length && !confirm(`You have ${outbox.length} unsynced expense${outbox.length === 1 ? '' : 's'}. Log out anyway? They will remain on this device but cannot sync until you reconnect.`)) return;
    window.location.assign('/cdn-cgi/access/logout');
  };

  return <Layout>
    <div className="page-title"><div><p className="eyebrow">More</p><h1>Settings</h1></div></div>
    <section><h2>Device</h2><p className="muted" role="status">{online ? 'Online' : 'Offline'} · {outbox.length ? `${outbox.length} expense${outbox.length === 1 ? '' : 's'} pending` : 'No expenses pending'}</p><InstallAction showStatus /></section>
    <section><h2>Pending expenses</h2>{outbox.length ? <div className="list">{outbox.map((item) => <div className="row" key={item.clientOperationId}><span>{item.display.description}<small>{statusLabel(item.status, item.deliveryUncertain)}</small></span><strong>{item.display.currency} {(item.display.amountMinor / 100).toFixed(2)}</strong></div>)}</div> : <p className="muted">New expenses sync automatically when you are online and signed in.</p>}</section>
    <section><h2>Trusted-device offline access</h2><p className="muted">After a verified visit, this browser keeps a private copy of your identity and recent group data so you can capture new expenses offline. It never stores an Access token, and replay still requires Cloudflare Access. Only use this on a device you trust.</p></section>
    <section><h2>Local data</h2><p className="muted">Clear cached identity, groups, snapshots, and recent preferences without deleting pending or uncertain outbox expenses. Resolve those from the queue controls before removing them.</p><Button variant="secondary" disabled={clearing} onClick={() => void clearCache}>{clearing ? 'Clearing…' : 'Clear cached data'}</Button>{message ? <p className="muted" role="status">{message}</p> : null}{error ? <ErrorBox error={error} /> : null}</section>
    <section><h2>Account</h2><p className="muted">Log out through Cloudflare Access. BillSplit does not handle or disclose your Access tokens.</p><Button variant="danger" disabled={!outboxReady} onClick={logout}>{outboxReady ? 'Log out' : 'Checking pending expenses…'}</Button></section>
  </Layout>;
}

export function App() {
  const identityEpoch = useResourceIdentityEpoch();
  return <Routes key={identityEpoch}><Route path="/" element={<Home />} /><Route path="/settings" element={<Settings />} /><Route path="/groups/:id" element={<GroupPage />} /><Route path="/groups/:id/expense/new" element={<ExpenseForm />} /><Route path="/groups/:id/expense/:expenseId" element={<ExpenseForm />} /><Route path="/groups/:id/expenses/:expenseId" element={<ExpenseDetail />} /><Route path="/expenses/:expenseId" element={<ExpenseDetail />} /><Route path="/groups/:id/settle" element={<Settle />} /><Route path="/groups/:id/activity" element={<Activity />} /><Route path="*" element={<Navigate to="/" replace />} /></Routes>;
}
