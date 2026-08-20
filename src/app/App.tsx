import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { Balances, Currency, Expense, Group, GroupMember, Settlement, SplitMethod } from '../shared/types';
import { currencyOptions } from '../shared/schemas';
import { formatMoney, parseMoney } from '../domain/money';
import { api, getBalances, getExpenseDetails, getExpenses, getGroup, getGroups, getMe, getSettlements } from './api';
import { allocationMetadataByPerson, allocationSplits, allocationStateFromSplits, currentPayerSelection, normalizeSinglePayer, previewAllocation, settlementSuggestion, type AllocationState } from './form-helpers';
import { Button, Field, Layout, Modal, Money, Status, Surface } from './ui';

const today = () => new Date().toISOString().slice(0, 10);
const operationId = () => crypto.randomUUID();
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong';
function Loading() { return <p className="muted">Loading…</p>; }
function ErrorBox({ error }: { error: unknown }) { return <div className="error" role="alert">{errorText(error)}</div>; }
function Empty({ children }: { children: ReactNode }) { return <div className="empty">{children}</div>; }
function CurrencySelect({ value, onChange }: { value: Currency; onChange: (value: Currency) => void }) {
  return <select value={value} onChange={(event) => onChange(event.target.value as Currency)}>{currencyOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>;
}
const nameOf = (members: GroupMember[], id: string) => members.find((member) => member.personId === id)?.name || 'Unknown member';
const moneyInput = (minor: number) => (minor / 100).toFixed(2);

function Home() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [error, setError] = useState<unknown>();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState<Currency>('USD');
  const [searchParams, setSearchParams] = useSearchParams();
  const nav = useNavigate();
  const newGroupRequested = searchParams.get('new') === '1';

  useEffect(() => { getGroups().then((result) => setGroups(result.groups)).catch(setError); }, []);
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
      if (result.group) nav(`/groups/${result.group.id}`);
    } catch (cause) { setError(cause); }
  };

  return <Layout>
    <div className="page-title"><div><p className="eyebrow">Private expenses</p><h1>Your groups</h1></div><Button onClick={() => setCreating((current) => !current)} variant="secondary">{creating ? 'Cancel' : '+ New group'}</Button></div>
    {creating && <Surface><form onSubmit={create}><Field label="Group name"><input required value={name} onChange={(event) => setName(event.target.value)} /></Field><Field label="Default currency"><CurrencySelect value={currency} onChange={setCurrency} /></Field><Button type="submit">Create group</Button></form></Surface>}
    {error ? <ErrorBox error={error} /> : null}
    {!groups.length && !error ? <Empty>No groups yet. Create one to get started.</Empty> : <div className="cards">{groups.map((group) => <Link className="card" to={`/groups/${group.id}`} key={group.id}><strong>{group.name}</strong><span>{group.currency}</span></Link>)}</div>}
  </Layout>;
}

function GroupPage() {
  const { id = '' } = useParams();
  const [group, setGroup] = useState<Group>();
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [balances, setBalances] = useState<Record<string, Balances>>({});
  const [currentPersonId, setCurrentPersonId] = useState('');
  const [personName, setPersonName] = useState('');
  const [personEmail, setPersonEmail] = useState('');
  const [addingPerson, setAddingPerson] = useState(false);
  const [error, setError] = useState<unknown>();

  const load = () => Promise.all([getGroup(id), getExpenses(id), getBalances(id), getSettlements(id), getMe()]).then(([groupResult, expenseResult, balanceResult, settlementResult, me]) => {
    setGroup(groupResult.group); setMembers(groupResult.members); setExpenses(expenseResult.expenses); setBalances(balanceResult.balances); setSettlements(settlementResult.settlements); setCurrentPersonId(me.personId);
  }).catch(setError);
  useEffect(() => { void load(); }, [id]);

  if (error) return <Layout><ErrorBox error={error} /><Link className="back" to="/">← Groups</Link></Layout>;
  if (!group) return <Layout><Loading /></Layout>;
  const addPerson = async (event: FormEvent) => {
    event.preventDefault();
    if (!personName.trim()) return;
    try { await api(`/groups/${id}/people`, { method: 'POST', body: JSON.stringify({ name: personName, email: personEmail.trim() || undefined }) }); setPersonName(''); setPersonEmail(''); setAddingPerson(false); void load(); }
    catch (cause) { setError(cause); }
  };
  const memberLabel = (personId: string) => personId === currentPersonId ? 'You' : nameOf(members, personId);

  return <Layout>
    <Link to="/" className="back">← Groups</Link>
    <div className="page-title"><div><p className="eyebrow">{group.currency} group</p><h1>{group.name}</h1></div><Link className="button" to={`/groups/${id}/expense/new`}>+ Add expense</Link></div>
    <div className="actions"><Link to={`/groups/${id}/settle`}>Settle up</Link><Link to={`/groups/${id}/activity`}>Activity</Link><a href={`/api/groups/${id}/export.csv`}>CSV export</a><a href={`/api/groups/${id}/export.json`}>JSON export</a></div>
    {Object.entries(balances).map(([currencyKey, balance]) => <section key={currencyKey}><h2>Balances <small>({currencyKey})</small></h2>{balance.simplified.length ? <div className="list">{balance.simplified.map((item) => <div className="row" key={`${currencyKey}-${item.fromPersonId}-${item.toPersonId}`}><span>{item.fromPersonId === currentPersonId ? 'You' : item.fromName} owes {item.toPersonId === currentPersonId ? 'You' : item.toName}<Status tone="debt">Debt</Status></span><Money amountMinor={item.amountMinor} currency={currencyKey} tone="debt" /></div>)}</div> : <Empty>Everyone is settled up.</Empty>}</section>)}
    <section><div className="section-title"><h2>People</h2>{group.role === 'owner' && <Button variant="secondary" onClick={() => setAddingPerson((current) => !current)}>{addingPerson ? 'Cancel' : '+ Add'}</Button>}</div>{addingPerson && <form onSubmit={addPerson}><Field label="Name"><input required value={personName} onChange={(event) => setPersonName(event.target.value)} /></Field><Field label="Email (optional)"><input type="email" value={personEmail} onChange={(event) => setPersonEmail(event.target.value)} /></Field><Button type="submit">Add person</Button></form>}<div className="chips">{members.map((member) => <span className="chip" key={member.personId}>{member.personId === currentPersonId ? 'You' : member.name}{member.email ? <small> · {member.email}</small> : null}</span>)}</div></section>
    <section><h2>Recent expenses</h2>{expenses.length ? <div className="list">{expenses.map((expense) => <Link className="row" to={`/expenses/${expense.id}`} key={expense.id}><span>{expense.description}<small>{expense.date} · {expense.currency}</small></span><Money amountMinor={expense.amountMinor} currency={expense.currency} /></Link>)}</div> : <Empty>No expenses yet.</Empty>}</section>
    {settlements.length ? <section><h2>Recent settlements</h2><div className="list">{settlements.map((settlement) => <div className="row" key={settlement.id}><span>{settlement.date}<small>{memberLabel(settlement.fromPersonId)} paid {memberLabel(settlement.toPersonId)}</small><Status tone="positive">Paid</Status></span><Money amountMinor={settlement.amountMinor} currency={settlement.currency} tone="positive" /></div>)}</div></section> : null}
  </Layout>;
}

type PayerRow = { personId: string; amount: string };

function ExpenseForm() {
  const { id = '', expenseId } = useParams();
  const nav = useNavigate();
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [group, setGroup] = useState<Group>();
  const [currentPersonId, setCurrentPersonId] = useState('');
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

  useEffect(() => {
    let active = true;
    Promise.all([getGroup(id), getMe(), expenseId ? getExpenseDetails(expenseId) : Promise.resolve(undefined)]).then(([groupResult, me, details]) => {
      if (!active) return;
      setGroup(groupResult.group); setMembers(groupResult.members); setCurrentPersonId(me.personId);
      const expense = details?.expense;
      setCurrency(expense?.currency ?? groupResult.group.currency);
      if (expense) {
        const loadedMethod = expense.splits[0]?.metadata?.method;
        const nextMethod: SplitMethod = loadedMethod === 'exact' || loadedMethod === 'percentage' || loadedMethod === 'shares' ? loadedMethod : 'equal';
        setDescription(expense.description); setAmount(moneyInput(expense.amountMinor)); setDate(expense.date); setCategory(expense.category || ''); setNotes(expense.notes || ''); setMethod(nextMethod); setSelected(expense.splits.map((split) => split.personId)); setAllocationValues(allocationStateFromSplits(expense.splits, nextMethod)); setExistingSplitMetadata(allocationMetadataByPerson(expense.splits)); setVersion(expense.version); setPayerRows(expense.payers.map((payer) => ({ personId: payer.personId, amount: moneyInput(payer.amountMinor) })));
      } else {
        const payer = currentPayerSelection(me.personId, groupResult.members);
        setSelected(groupResult.members.map((member) => member.personId)); setPayerRows(payer ? [{ personId: payer, amount: '' }] : []);
      }
    }).catch(setError);
    return () => { active = false; };
  }, [id, expenseId]);

  if (error) return <Layout><ErrorBox error={error} /></Layout>;
  if (!group) return <Layout><Loading /></Layout>;
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
      if (payers.reduce((sum, payer) => sum + payer.amount_minor, 0) !== cents) throw new Error('Payer amounts must equal the expense total.');
      if (preview.error || preview.remainingMinor !== 0) throw new Error(preview.error || 'Split amounts must equal the expense total.');
      const input = { description: description.trim(), amount_minor: cents, currency, date, category: category.trim() || null, notes: notes || null, payers, splits: allocationSplits(selected, method, preview, allocationValues, existingSplitMetadata), version, client_operation_id: expenseId ? undefined : operation };
      if (expenseId) await api(`/expenses/${expenseId}`, { method: 'PUT', body: JSON.stringify(input) });
      else await api(`/groups/${id}/expenses`, { method: 'POST', body: JSON.stringify(input) });
      nav(`/groups/${id}`);
    } catch (cause) { setSubmitting(false); setError(cause); }
  };

  return <Layout>
    <div className="page-title expense-heading"><div><Link to={`/groups/${id}`} className="back">← {group.name}</Link><p className="eyebrow">{expenseId ? 'Edit expense' : 'New expense'}</p><h1>{expenseId ? 'Edit expense' : 'Add expense'}</h1></div><div className="expense-heading__actions"><Link className="button button--secondary" to={`/groups/${id}`}>Cancel</Link></div></div>
    <form className="expense-form" onSubmit={submit}>
      <Field label="Amount and currency" className="amount-field"><input required inputMode="decimal" aria-label="Expense amount" placeholder="0.00" value={amount} onChange={(event) => setAmountAndPayer(event.target.value)} /><CurrencySelect value={currency} onChange={setCurrency} /></Field>
      <Field label="Description" className="field--compact"><input required placeholder="What was this for?" value={description} onChange={(event) => setDescription(event.target.value)} /></Field>
      <button className="summary-row" type="button" onClick={() => setPayersOpen(true)}><span>{payerSummary}<small>{payerSummaryDetail}</small></span><strong>Change</strong></button>
      <fieldset><legend>Split between</legend><div className="participant-list">{members.map((member) => { const active = selected.includes(member.personId); return <button className="participant-row" type="button" aria-pressed={active} key={member.personId} onClick={() => toggleSplit(member.personId)}><span className="participant-row__name"><span className="checkmark" aria-hidden="true">✓</span>{member.name}{isYou(member.personId) ? <small>You</small> : null}</span>{active && method === 'equal' ? <span className="allocation-row__amount">{formatMoney(preview.allocations[member.personId] || 0, currency)}</span> : null}</button>; })}</div></fieldset>
      <div className="secondary-fields"><Field label="Split method" className="field--compact"><select value={method} onChange={(event) => setMethod(event.target.value as SplitMethod)}><option value="equal">Equal</option><option value="exact">Exact amounts</option><option value="percentage">Percentage</option><option value="shares">Shares</option></select></Field>
        {method !== 'equal' && <div className="allocation-list">{members.filter((member) => selected.includes(member.personId)).map((member) => <div className="allocation-row" key={member.personId}><span className="allocation-row__person"><span>{member.name}{isYou(member.personId) ? ' · You' : ''}</span><span className="allocation-row__amount">{preview.allocations[member.personId] !== undefined ? formatMoney(preview.allocations[member.personId], currency) : '—'}</span></span><input required inputMode="decimal" aria-label={`${member.name} ${method} value`} placeholder={method === 'exact' ? '0.00' : method === 'percentage' ? '%' : 'Shares'} value={allocationValues[member.personId] || ''} onChange={(event) => updateAllocation(member.personId, event.target.value)} /></div>)}<p className="allocation-summary" role="status">{method === 'exact' ? `Remaining ${formatMoney(preview.remainingMinor ?? amountMinor, currency)}` : method === 'percentage' ? `Remaining ${preview.remainingPercent ?? 100}%` : `Total shares ${preview.totalValue || 0}`}</p>{preview.error ? <p className="error" role="alert">{preview.error}</p> : null}</div>}
        <div className="form-row"><Field label="Date" className="field--compact"><input required type="date" value={date} onChange={(event) => setDate(event.target.value)} /></Field><Field label="Category (optional)" className="field--compact"><input value={category} onChange={(event) => setCategory(event.target.value)} /></Field></div><Field label="Notes (optional)" className="field--compact"><textarea rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} /></Field>
      </div>
      {error ? <ErrorBox error={error} /> : null}<Button className="full-width-button" disabled={submitting} type="submit">{submitting ? 'Saving…' : expenseId ? 'Save changes' : 'Save expense'}</Button>
    </form>
    {payersOpen && <Modal title="Who paid?" onClose={() => setPayersOpen(false)}><p className="muted">Use one payer for a quick entry, or add people and enter exact amounts.</p><div className="payer-list">{payerRows.map((payer, index) => <div className="payer-row" key={`${payer.personId}-${index}`}><select aria-label="Payer" value={payer.personId} onChange={(event) => setPayerRows((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, personId: event.target.value } : row))}>{members.filter((member) => !payerRows.some((other, otherIndex) => other.personId === member.personId && otherIndex !== index)).map((member) => <option key={member.personId} value={member.personId}>{member.name}{isYou(member.personId) ? ' · You' : ''}</option>)}</select><input required inputMode="decimal" aria-label="Payer amount" placeholder="Amount" value={payer.amount} onChange={(event) => setPayerRows((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, amount: event.target.value } : row))} />{payerRows.length > 1 && <Button type="button" variant="secondary" onClick={() => removePayer(index)}>Remove</Button>}</div>)}</div><p className="allocation-summary" role="status">Payers total {formatMoney(payerRows.reduce((sum, payer) => { try { return sum + parseMoney(payer.amount || '0', currency); } catch { return sum; } }, 0), currency)} of {formatMoney(amountMinor, currency)}</p><Button className="full-width-button" type="button" variant="secondary" onClick={addPayer}>+ Add payer</Button><Button className="full-width-button" type="button" onClick={() => setPayersOpen(false)}>Done</Button></Modal>}
  </Layout>;
}

function ExpenseDetail() {
  const { expenseId = '' } = useParams();
  const nav = useNavigate();
  const [expense, setExpense] = useState<Expense>();
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [history, setHistory] = useState<Array<{ id: string; revision: number; createdAt: string }>>([]);
  const [error, setError] = useState<unknown>();
  useEffect(() => { let active = true; getExpenseDetails(expenseId).then(async (result) => { const groupResult = await getGroup(result.expense.groupId); if (!active) return; setExpense(result.expense); setHistory(result.history); setMembers(groupResult.members); }).catch(setError); return () => { active = false; }; }, [expenseId]);
  if (error) return <Layout><ErrorBox error={error} /></Layout>;
  if (!expense) return <Layout><Loading /></Layout>;
  const remove = async () => { if (!confirm('Delete this expense?')) return; try { await api(`/expenses/${expense.id}?version=${expense.version}`, { method: 'DELETE' }); nav(`/groups/${expense.groupId}`); } catch (cause) { setError(cause); } };
  return <Layout><Link to={`/groups/${expense.groupId}`} className="back">← Group</Link><div className="page-title"><div><p className="eyebrow">{expense.date}</p><h1>{expense.description}</h1></div><Money amountMinor={expense.amountMinor} currency={expense.currency} size="large" /></div><section><h2>Payers</h2><div className="list">{expense.payers.map((payer) => <div className="row" key={payer.personId}><span>{nameOf(members, payer.personId)}</span><Money amountMinor={payer.amountMinor} currency={expense.currency} /></div>)}</div><h2>Split</h2><div className="list">{expense.splits.map((split) => <div className="row" key={split.personId}><span>{nameOf(members, split.personId)}</span><Money amountMinor={split.amountMinor} currency={expense.currency} /></div>)}</div>{expense.category ? <p className="muted">Category: {expense.category}</p> : null}{expense.notes ? <p className="muted">{expense.notes}</p> : null}</section><div className="actions"><Link className="button" to={`/groups/${expense.groupId}/expense/${expense.id}`}>Edit</Link><Button variant="danger" onClick={remove}>Delete</Button></div><section><h2>History</h2>{history.length ? <div className="list">{history.map((item) => <div className="row" key={item.id}><span>Revision {item.revision}</span><small>{item.createdAt}</small></div>)}</div> : <Empty>No edits yet.</Empty>}</section></Layout>;
}

function Settle() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [group, setGroup] = useState<Group>();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState<Currency>('USD');
  const [currentPersonId, setCurrentPersonId] = useState('');
  const [operation] = useState(operationId);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>();
  useEffect(() => { Promise.all([getMe(), getGroup(id), getBalances(id)]).then(([me, groupResult, balanceResult]) => { setCurrentPersonId(me.personId); setGroup(groupResult.group); setMembers(groupResult.members); const suggestion = settlementSuggestion(balanceResult.balances, me.personId, groupResult.group.currency); setCurrency(suggestion?.currency || groupResult.group.currency); setFrom(suggestion?.fromPersonId || groupResult.members[0]?.personId || ''); setTo(suggestion?.toPersonId || groupResult.members.find((member) => member.personId !== (suggestion?.fromPersonId || groupResult.members[0]?.personId))?.personId || ''); setAmount(suggestion ? moneyInput(suggestion.amountMinor) : ''); }).catch(setError); }, [id]);
  if (!group) return <Layout>{error ? <ErrorBox error={error} /> : <Loading />}</Layout>;
  const submit = async (event: FormEvent) => { event.preventDefault(); if (submitting) return; setSubmitting(true); setError(undefined); try { await api(`/groups/${id}/settlements`, { method: 'POST', body: JSON.stringify({ from_person_id: from, to_person_id: to, amount_minor: parseMoney(amount, currency), currency, date: today(), client_operation_id: operation }) }); nav(`/groups/${id}`); } catch (cause) { setSubmitting(false); setError(cause); } };
  return <Layout><Link to={`/groups/${id}`} className="back">← {group.name}</Link><div className="page-title"><div><p className="eyebrow">{currentPersonId ? 'Suggested from your balance' : 'Payment'}</p><h1>Settle up</h1></div></div><p className="muted">Record a payment. Partial settlements are supported.</p><form onSubmit={submit}><Field label="Who paid?"><select value={from} onChange={(event) => setFrom(event.target.value)}>{members.map((member) => <option key={member.personId} value={member.personId}>{member.name}{member.personId === currentPersonId ? ' · You' : ''}</option>)}</select></Field><Field label="Who received?"><select value={to} onChange={(event) => setTo(event.target.value)}>{members.filter((member) => member.personId !== from).map((member) => <option key={member.personId} value={member.personId}>{member.name}{member.personId === currentPersonId ? ' · You' : ''}</option>)}</select></Field><Field label="Currency"><CurrencySelect value={currency} onChange={setCurrency} /></Field><Field label={`Amount (${currency})`}><input required inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} /></Field>{error ? <ErrorBox error={error} /> : null}<Button className="full-width-button" disabled={submitting} type="submit">{submitting ? 'Recording…' : 'Record payment'}</Button></form></Layout>;
}

function Activity() {
  const { id = '' } = useParams();
  const [items, setItems] = useState<Array<{ type: string; id: string; label: string | null; createdAt: string }>>([]);
  const [error, setError] = useState<unknown>();
  useEffect(() => { api<{ activity: Array<{ type: string; id: string; label: string | null; createdAt: string }> }>(`/groups/${id}/activity`).then((result) => setItems(result.activity)).catch(setError); }, [id]);
  return <Layout><Link to={`/groups/${id}`} className="back">← Group</Link><h1>Activity</h1>{error ? <ErrorBox error={error} /> : items.length ? <div className="list">{items.map((item) => <div className="row" key={`${item.type}-${item.id}`}><span>{item.type}: {item.label}</span><small>{item.createdAt}</small></div>)}</div> : <Empty>No activity yet.</Empty>}</Layout>;
}

export function App() {
  return <Routes><Route path="/" element={<Home />} /><Route path="/groups/:id" element={<GroupPage />} /><Route path="/groups/:id/expense/new" element={<ExpenseForm />} /><Route path="/groups/:id/expense/:expenseId" element={<ExpenseForm />} /><Route path="/expenses/:expenseId" element={<ExpenseDetail />} /><Route path="/groups/:id/settle" element={<Settle />} /><Route path="/groups/:id/activity" element={<Activity />} /><Route path="*" element={<Navigate to="/" replace />} /></Routes>;
}
