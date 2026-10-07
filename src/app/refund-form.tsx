import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useReloadBlocker } from './reload-safety-react';
import { runProtectedOperation } from './reload-safety';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { Currency, Credit, Expense, GroupResponse, HistoricalParticipant } from '../shared/types';
import { type CreditInput } from '../shared/schemas';
import { AmountControl } from './amount-control';
import { parseMoney } from '../domain/money';
import { createCredit, getCreditDetails, getExpenseDetails, getExpensePage, getGroup, getMe, hydrateExpenses, updateCredit, type ExpensePage, ApiError } from './api';
import { captureSessionGeneration, isSessionGenerationCurrent } from './session';
import { invalidateForMutation, revalidate, RESOURCE_FRESHNESS, resourceKeys, useResource } from './resource-cache';
import { ActionGroup, Button, Field, FormSurface, Layout, LedgerList, LedgerRow, Money, PageHeader, ResourceState, SectionHeader, useOnlineStatus } from './ui';
import { defaultRefundApplications, derivedBeneficiaryShares, derivedPayerShares, localBrowserDate, remainingRefundableMinor, type CreditAllocationDraft, type CreditApplicationDraft } from './credit-form';
import { createPageRequestScope } from './pagination';

type Application = CreditApplicationDraft;
type Allocation = CreditAllocationDraft & { touched?: boolean; personTouched?: boolean; defaultHint?: string };
type AllocationType = Allocation['allocationType'];

export const refundSourceOptions = [
  { value: 'refund', label: 'Merchant refund' },
  { value: 'claim', label: 'Reimbursement or claim' },
] as const;

export function refundModeOptions(linked: boolean) {
  return [
    { value: 'member_reimbursement' as const, label: 'A group member received the money', disabled: false },
    { value: 'direct_provider_offset' as const, label: 'Original payment or bill was adjusted', disabled: !linked },
  ];
}

const id = () => crypto.randomUUID();
const money = (minor: number) => (minor / 100).toFixed(2);
export const refundErrorText = (error: unknown) => error instanceof ApiError ? error.message : error instanceof Error ? error.message : 'Something went wrong. Retry when the connection is available.';
const emptyApplication = (expenseId = ''): Application => ({ id: id(), expenseId, amount: '', touched: false, provenance: 'default' });
const emptyAllocation = (allocationType: AllocationType): Allocation => ({ id: id(), personId: '', allocationType, amount: '', touched: false });

export function refundMoneyError(value: string, currency: Currency) {
  if (!value.trim()) return 'Enter an amount.';
  try { return parseMoney(value, currency) > 0 ? undefined : 'Enter an amount greater than zero.'; }
  catch { return 'Enter a valid money amount (for example, 12.50).'; }
}

export function createRefundOperationController(nextId: () => string = id) {
  let operationId = nextId();
  const rotate = () => { operationId = nextId(); };
  return { current: () => operationId, rotateAfterSuccess: rotate, rotateAfterUnmount: rotate };
}

export function initialRefundApplications(creditId?: string, preselectedExpenseId = ''): Application[] {
  return creditId ? [] : [emptyApplication(preselectedExpenseId)];
}

export function refundApplicationsForPath(path: 'linked' | 'standalone', rows: Application[]): Application[] {
  return path === 'linked' ? rows.length ? rows : [emptyApplication()] : [];
}

export function removeRefundAllocation(rows: Allocation[], rowId: string, minimumRows: number): Allocation[] {
  return rows.length <= minimumRows ? rows : rows.filter((row) => row.id !== rowId);
}

export function duplicateRefundAllocationTypes(rows: Array<Pick<Allocation, 'personId' | 'allocationType'>>): AllocationType[] {
  return (['recipient', 'beneficiary'] as const).filter((allocationType) => {
    const people = rows.filter((row) => row.allocationType === allocationType && row.personId).map((row) => row.personId);
    return new Set(people).size !== people.length;
  });
}

export function refundAllocationDuplicateError(rows: Array<Pick<Allocation, 'personId' | 'allocationType'>>) {
  const duplicateTypes = duplicateRefundAllocationTypes(rows);
  if (!duplicateTypes.length) return undefined;
  if (duplicateTypes.length === 1) {
    return duplicateTypes[0] === 'recipient'
      ? 'Choose each person only once within recipient allocations.'
      : 'Choose each person only once within affected-member allocations.';
  }
  return 'Choose each person only once within recipient allocations and within affected-member allocations. The same person may be selected once on each side.';
}

export function refundAllocationRowsForValidation(rows: Allocation[], mode: CreditInput['delivery_mode'], linked: boolean, adjustBenefits: boolean) {
  if (mode === 'direct_provider_offset') return [];
  return rows.filter((row) => adjustBenefits || !linked || row.allocationType === 'recipient');
}

export function refundApplicationFillAmount(rows: Array<Pick<Application, 'id' | 'amount'>>, rowId: string, totalMinor: number, capacityMinor: number, currency: Currency) {
  if (!Number.isSafeInteger(totalMinor) || totalMinor <= 0) return Math.max(0, capacityMinor);
  const appliedElsewhere = rows.reduce((sum, row) => {
    if (row.id === rowId) return sum;
    try { return sum + parseMoney(row.amount, currency); } catch { return sum; }
  }, 0);
  return Math.min(Math.max(0, capacityMinor), Math.max(0, totalMinor - appliedElsewhere));
}

export function refundApplicationStatus(totalMinor: number, appliedMinor: number, currency: Currency) {
  const remainingMinor = totalMinor - appliedMinor;
  if (remainingMinor === 0) return { kind: 'fully-applied' as const, label: 'Fully applied', remainingMinor, currency };
  if (remainingMinor > 0) return { kind: 'remaining' as const, label: `Remaining to apply: ${money(remainingMinor)} ${currency}`, remainingMinor, currency };
  return { kind: 'overallocated' as const, label: `Overallocated by ${money(Math.abs(remainingMinor))} ${currency}`, remainingMinor, currency };
}

export function refundApplicationRowsHavePositiveAmounts(rows: Array<Pick<Application, 'amount'>>, currency: Currency) {
  return rows.every((row) => {
    try { return parseMoney(row.amount, currency) > 0; } catch { return false; }
  });
}

export type RefundPreviewRow = { personId: string; amountMinor: number; label: string };
export type RefundPreviewPerson = { personId: string; components: Array<{ label: string; amountMinor: number }>; netMinor: number };

export function refundSettlementEffect(netMinor: number, currency: Currency) {
  if (netMinor === 0) return 'Your settlement balance is unchanged.';
  const change = `${money(Math.abs(netMinor))} ${currency}`;
  return netMinor > 0
    ? `The amount you owe decreases, or the amount you are owed increases by ${change}.`
    : `The amount you owe increases, or the amount you are owed decreases by ${change}.`;
}

export function groupRefundPreviewRows(rows: RefundPreviewRow[]): RefundPreviewPerson[] {
  const grouped = new Map<string, RefundPreviewPerson>();
  for (const row of rows) {
    if (!row.personId.trim()) continue;
    const person = grouped.get(row.personId) || { personId: row.personId, components: [], netMinor: 0 };
    person.components.push({ label: row.label, amountMinor: row.amountMinor });
    person.netMinor += row.amountMinor;
    grouped.set(row.personId, person);
  }
  return [...grouped.values()];
}

export function refundPreviewRows(mode: Credit['deliveryMode'], recipientRows: Allocation[], derivedPayers: Array<{ personId: string; amountMinor: number }>, derivedBeneficiaries: Array<{ personId: string; amountMinor: number }>, derivedDisplay: Array<{ personId: string; amountMinor: number }>, currency: Currency): RefundPreviewRow[] {
  const amount = (row: Allocation) => {
    try { return parseMoney(row.amount, currency); } catch { return 0; }
  };
  return mode === 'direct_provider_offset'
    ? [...derivedPayers.map((row) => ({ ...row, amountMinor: -row.amountMinor, label: 'Payment reduction' })), ...derivedBeneficiaries.map((row) => ({ ...row, label: 'Cost reduction' }))]
    : [...recipientRows.map((row) => ({ personId: row.personId, amountMinor: -amount(row), label: 'Received' })), ...derivedDisplay.map((row) => ({ ...row, label: 'Cost reduction' }))];
}

export function buildRefundInput({ subtype, mode, amountMinor, currency, date, note, applications, allocations, linked, adjustBenefits }: {
  subtype: CreditInput['subtype'];
  mode: CreditInput['delivery_mode'];
  amountMinor: number;
  currency: Currency;
  date: string;
  note: string;
  applications: Array<{ expenseId: string; amountMinor: number }>;
  allocations: Allocation[];
  linked: boolean;
  adjustBenefits: boolean;
}): CreditInput {
  const submittedAllocations = refundAllocationRowsForValidation(allocations, mode, linked, adjustBenefits).filter((allocation) => allocation.personId);
  return {
    subtype, delivery_mode: mode, amount_minor: amountMinor, currency, date, note: note || null,
    applications: linked ? applications.map((application) => ({ expense_id: application.expenseId, amount_minor: application.amountMinor })) : [],
    allocations: mode === 'direct_provider_offset' ? [] : submittedAllocations.map((allocation) => ({ person_id: allocation.personId, allocation_type: allocation.allocationType, amount_minor: parseMoney(allocation.amount, currency) })),
  };
}

export function beneficiarySnapshotMatches(rows: Allocation[], derived: Array<{ personId: string; amountMinor: number }>, currency: Currency) {
  const savedRows = rows.filter((row) => row.personId);
  const saved = new Map(savedRows.map((row) => {
    try { return [row.personId, parseMoney(row.amount, currency)] as const; } catch { return [row.personId, -1] as const; }
  }));
  return savedRows.length === derived.length && saved.size === derived.length && derived.every((row) => saved.get(row.personId) === row.amountMinor);
}

export function refundOriginalSplitAllowed(activeIds: string[], derived: Array<{ personId: string; amountMinor: number }>, saved?: Pick<Credit, 'allocations'>) {
  return !saved || derived.every((row) => activeIds.includes(row.personId) || saved.allocations.some((allocation) => allocation.allocationType === 'beneficiary' && allocation.personId === row.personId && allocation.amountMinor === row.amountMinor));
}

export function refundBeneficiaryPreviewRows(rows: Allocation[], derived: Array<{ personId: string; amountMinor: number }>, linked: boolean, adjustBenefits: boolean, currency: Currency) {
  if (linked && !adjustBenefits) return derived;
  return rows.filter((row) => row.personId).map((row) => {
    try { return { personId: row.personId, amountMinor: parseMoney(row.amount, currency) }; } catch { return { personId: row.personId, amountMinor: 0 }; }
  });
}

export function beneficiaryRowsComplete(rows: Allocation[], amountMinor: number, currency: Currency) {
  if (!rows.length) return false;
  let total = 0;
  for (const row of rows) {
    if (!row.personId || !row.amount.trim()) return false;
    try {
      const amount = parseMoney(row.amount, currency);
      if (amount <= 0) return false;
      total += amount;
    } catch { return false; }
  }
  return total === amountMinor;
}

export function refundAllocationRowsHavePositiveAmounts(rows: Allocation[], currency: Currency) {
  return rows.every((row) => {
    if (!row.personId) return false;
    try { return parseMoney(row.amount, currency) > 0; } catch { return false; }
  });
}

function expenseCapacity(expense: Expense, editingCreditId?: string) {
  return remainingRefundableMinor(expense, editingCreditId);
}

function uniqueExpenses(expenses: Expense[]) {
  return expenses.filter((expense, index, all) => all.findIndex((candidate) => candidate.id === expense.id) === index);
}

export function refundAllocationPeople(group: Pick<GroupResponse, 'members' | 'historicalParticipants'> | undefined, loadedCredit?: Pick<Credit, 'allocations'>): Array<{ personId: string; name: string }> {
  if (!group) return [];
  const active = group.members.map((member) => ({ personId: member.personId, name: member.name }));
  const retainedIds = new Set(loadedCredit?.allocations.map((allocation) => allocation.personId) || []);
  const historical = group.historicalParticipants
    .filter((participant) => retainedIds.has(participant.personId) && !group.members.some((member) => member.personId === participant.personId))
    .map((participant) => ({ personId: participant.personId, name: historicalName(participant) }));
  return [...active, ...historical];
}

function historicalName(participant: HistoricalParticipant) {
  return participant.status === 'deleted' ? `${participant.name} · Deleted account` : participant.status === 'removed' ? `${participant.name} · Removed` : participant.name;
}

function personName(people: Array<{ personId: string; name: string }>, personId: string, currentPersonId?: string | null) {
  return personId === currentPersonId ? 'You' : people.find((person) => person.personId === personId)?.name || 'Removed participant';
}

export function refundExpenseOptions(expenses: Expense[], rows: Array<Pick<Application, 'id' | 'expenseId'>>, rowId: string, editingCreditId?: string, search = '') {
  const row = rows.find((candidate) => candidate.id === rowId);
  const first = rows[0];
  const selected = new Set(rows.map((candidate) => candidate.expenseId).filter(Boolean));
  const firstRow = first?.id === rowId;
  const normalizedSearch = search.trim().toLowerCase();
  return expenses.filter((expense) => {
    if (expense.id === row?.expenseId) return true;
    if (selected.has(expense.id)) return false;
    if (!firstRow) {
      const firstExpense = expenses.find((candidate) => candidate.id === first?.expenseId);
      if (firstExpense && firstExpense.currency !== expense.currency) return false;
    }
    return expenseCapacity(expense, editingCreditId) > 0 && `${expense.description} ${expense.date}`.toLowerCase().includes(normalizedSearch);
  });
}

export function RefundExpensePickerOptions({ expenses, rows, rowId, editingCreditId, search }: { expenses: Expense[]; rows: Array<Pick<Application, 'id' | 'expenseId'>>; rowId: string; editingCreditId?: string; search?: string }) {
  return <>{refundExpenseOptions(expenses, rows, rowId, editingCreditId, search).map((expense) => <option key={expense.id} value={expense.id}>{expense.date} · {expense.description} · {expense.currency}</option>)}</>;
}

function Loading() { return <ResourceState state="loading" className="muted">Loading…</ResourceState>; }
function ConnectionBanner({ detail }: { detail: string }) { return <p className="offline-banner" role="status">Offline · {detail}</p>; }

export function AllocationRows({ rows, label, currency, people, currentPersonId, onChange, onRemove, minimumRows, showErrors, error }: {
  rows: Allocation[];
  label: string;
  currency: Currency;
  people: Array<{ personId: string; name: string }>;
  currentPersonId?: string | null;
  onChange: (rowId: string, patch: Partial<Allocation>) => void;
  onRemove: (rowId: string) => void;
  minimumRows: number;
  showErrors: boolean;
  error?: string;
}) {
  const [blurred, setBlurred] = useState<Set<string>>(() => new Set());
  const validate = (key: string) => setBlurred((current) => new Set(current).add(key));
  const visible = (key: string) => showErrors || blurred.has(key);
  const totalErrorId = `refund-${label.toLowerCase().replace(/\s+/g, '-')}-total-error`;
  return <>
    {rows.map((row, index) => <div className="allocation-row refund-allocation-row" key={row.id}>
      <Field className="refund-allocation-row__person" label={label}>
        <select required onBlur={() => validate(`${row.id}-person`)} aria-invalid={visible(`${row.id}-person`) && !row.personId} aria-describedby={`${row.id}-person-error`} aria-label={`${label} ${index + 1}`} name={`allocation-${row.allocationType}-${index + 1}-person`} value={row.personId} onChange={(event) => onChange(row.id, { personId: event.target.value, personTouched: true, defaultHint: undefined })}>
          <option value="">Choose a person</option>
          {people.filter((person) => person.personId === row.personId || !rows.some((candidate) => candidate.id !== row.id && candidate.personId === person.personId)).map((person) => <option key={person.personId} value={person.personId}>{personName(people, person.personId, currentPersonId)}</option>)}
        </select>
        {row.defaultHint ? <small>{row.defaultHint}</small> : null}
        {visible(`${row.id}-person`) && !row.personId ? <small id={`${row.id}-person-error`} className="field-error">Choose a person.</small> : null}
      </Field>
      <Field className="refund-allocation-row__amount" label={`Amount (${currency})`}>
        <AmountControl currency={currency} required onBlur={() => validate(`${row.id}-amount`)} aria-invalid={visible(`${row.id}-amount`) && Boolean(refundMoneyError(row.amount, currency) || error)} aria-describedby={`${row.id}-amount-error ${totalErrorId}`} aria-label={`${label} amount ${index + 1} (${currency})`} name={`allocation-${row.allocationType}-${index + 1}-amount`} value={row.amount} onChange={(event) => onChange(row.id, { amount: event.target.value, touched: true })} />
        {visible(`${row.id}-amount`) && refundMoneyError(row.amount, currency) ? <small id={`${row.id}-amount-error`} className="field-error">{refundMoneyError(row.amount, currency)}</small> : null}
      </Field>
      {rows.length > minimumRows ? <Button className="refund-allocation-row__remove" type="button" variant="secondary" aria-label={`Remove ${label.toLowerCase()} allocation ${index + 1}`} onClick={() => onRemove(row.id)}>Remove</Button> : null}
    </div>)}
    {showErrors && error ? <p id={totalErrorId} role="alert" className="field-error">{error}</p> : null}
  </>;
}

export function RefundForm({ initialCredit }: { initialCredit?: Credit } = {}) {
  const { id: groupId = '', creditId } = useParams();
  const [searchParams] = useSearchParams();
  const preselectedExpenseId = searchParams.get('expense') || '';
  const navigate = useNavigate();
  const online = useOnlineStatus();
  const me = useResource(resourceKeys.identity(), '', (signal) => getMe({ signal }), RESOURCE_FRESHNESS.expenses);
  const groupResource = useResource<GroupResponse>(resourceKeys.group(me.data?.id || 'pending', groupId || 'missing'), me.data?.id, (signal) => getGroup(groupId, signal), RESOURCE_FRESHNESS.group);
  const editResource = useResource<{ credit: Credit }>(resourceKeys.creditDetail(me.data?.id || 'pending', creditId || 'new'), me.data?.id, (signal) => creditId ? getCreditDetails(creditId, signal) : Promise.resolve({ credit: undefined as unknown as Credit }), RESOURCE_FRESHNESS.expenseDetail);
  const loadedCredit = initialCredit || editResource.data?.credit;
  const expenseResourceKey = resourceKeys.expenses(me.data?.id || 'pending', groupId || 'missing');
  const expenseResource = useResource<ExpensePage>(expenseResourceKey, me.data?.id, (signal) => getExpensePage(groupId, { limit: 50 }, signal), RESOURCE_FRESHNESS.expenses, me.data?.id ? () => hydrateExpenses(me.data!.id, groupId) : undefined);
  const group = groupResource.data?.group;
  const people = refundAllocationPeople(groupResource.data, loadedCredit);
  const currentPersonId = groupResource.data?.currentPersonId;

  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [expenseError, setExpenseError] = useState<unknown>();
  const [expenseRetry, setExpenseRetry] = useState(0);
  const [search, setSearch] = useState('');
  const [mode, setMode] = useState<'member_reimbursement' | 'direct_provider_offset'>(loadedCredit?.deliveryMode || 'member_reimbursement');
  const [subtype, setSubtype] = useState<'refund' | 'claim'>(loadedCredit?.subtype || 'refund');
  const [currency, setCurrency] = useState<Currency>(loadedCredit?.currency || group?.currency || 'USD');
  const [amount, setAmount] = useState(loadedCredit ? money(loadedCredit.amountMinor) : '');
  const [amountTouched, setAmountTouched] = useState(Boolean(loadedCredit));
  const [amountProvenance, setAmountProvenance] = useState<'user' | 'default'>(loadedCredit ? 'user' : 'default');
  const [date, setDate] = useState(loadedCredit?.date || localBrowserDate());
  const [note, setNote] = useState(loadedCredit?.note || '');
  const [applications, setApplications] = useState<Application[]>(() => initialRefundApplications(creditId || (initialCredit ? initialCredit.id : undefined)));
  const [allocations, setAllocations] = useState<Allocation[]>([]);
  const [adjustBenefits, setAdjustBenefits] = useState(false);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [blurred, setBlurred] = useState<Set<string>>(() => new Set());
  const validateBlur = (key: string) => setBlurred((current) => new Set(current).add(key));
  const validationVisible = (key: string) => submitAttempted || blurred.has(key);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const seeded = useRef<string>();
  const benefitsReset = useRef(false);
  const seededGroupCurrency = useRef(false);
  const routeKey = `${groupId}:${creditId || 'new'}`;
  const editRoute = Boolean(creditId || initialCredit?.id);
  const [initializationRouteKey, setInitializationRouteKey] = useState(routeKey);
  const [editInitialized, setEditInitialized] = useState(false);
  const editCreditReady = !editRoute || Boolean(loadedCredit && (!creditId || loadedCredit.id === creditId));
  const initializing = initializationRouteKey !== routeKey || (editRoute && (!editInitialized || !editCreditReady));
  const previousRouteKey = useRef(routeKey);
  const inFlightExpenses = useRef(new Map<string, AbortController>());
  const pageScope = useRef(createPageRequestScope());
  const scopeKeyRef = useRef(routeKey);
  const cursorRef = useRef<string>();
  const loadingCursorRef = useRef<string>();
  scopeKeyRef.current = routeKey;
  const [operationController] = useState(createRefundOperationController);
  // Capture the initialized values before the first user edit, excluding row
  // identities and validation/provenance bookkeeping from the comparison.
  const draft = JSON.stringify({ mode, subtype, currency, amount, date, note, adjustBenefits,
    applications: applications.map(({ expenseId, amount }) => ({ expenseId, amount })),
    allocations: allocations.map(({ personId, allocationType, amount }) => ({ personId, allocationType, amount })) });
  const draftBaseline = useRef<{ routeKey: string; value: string }>();
  const captureDraft = () => { if (!initializing && draftBaseline.current?.routeKey !== routeKey) draftBaseline.current = { routeKey, value: draft }; };
  useReloadBlocker(draftBaseline.current?.routeKey === routeKey && draftBaseline.current.value !== draft, 'Unsaved refund');

  useEffect(() => {
    if (previousRouteKey.current === routeKey) return;
    previousRouteKey.current = routeKey;
    seeded.current = undefined;
    benefitsReset.current = false;
    setBlurred(new Set());
    seededGroupCurrency.current = false;
    inFlightExpenses.current.forEach((controller) => controller.abort());
    inFlightExpenses.current.clear();
    pageScope.current.reset(routeKey);
    cursorRef.current = undefined;
    loadingCursorRef.current = undefined;
    setInitializationRouteKey(routeKey);
    setEditInitialized(false);
    operationController.rotateAfterUnmount();
    setExpenses([]); setCursor(undefined); setExpenseError(undefined); setError(undefined); setSubmitAttempted(false);
    setApplications(initialRefundApplications(creditId)); setAllocations([]); setAmount(''); setAmountTouched(false); setAmountProvenance('default'); setNote(''); setDate(localBrowserDate());
    setMode('member_reimbursement'); setSubtype('refund'); setCurrency('USD'); setAdjustBenefits(false);
  }, [creditId, routeKey]);

  useEffect(() => () => {
    inFlightExpenses.current.forEach((controller) => controller.abort());
    inFlightExpenses.current.clear();
    pageScope.current.dispose();
  }, [routeKey]);

  useEffect(() => {
    if (expenseResource.data) {
      pageScope.current.reset(routeKey);
      cursorRef.current = expenseResource.data.nextCursor;
      loadingCursorRef.current = undefined;
      setExpenses((current) => uniqueExpenses([...expenseResource.data!.expenses, ...current]));
      setCursor(expenseResource.data.nextCursor);
      setLoadingMore(false);
    }
  }, [expenseResource.data, routeKey]);

  useEffect(() => {
    const requestedIds = [...new Set([preselectedExpenseId, ...(loadedCredit?.applications || []).map((application) => application.expenseId)])].filter(Boolean);
    const missing = requestedIds.filter((expenseId) => !expenses.some((expense) => expense.id === expenseId) && !inFlightExpenses.current.has(expenseId));
    missing.forEach((expenseId) => {
      const controller = new AbortController();
      inFlightExpenses.current.set(expenseId, controller);
      void getExpenseDetails(expenseId, controller.signal).then((result) => {
        inFlightExpenses.current.delete(expenseId);
        setExpenses((current) => uniqueExpenses([...current, result.expense]));
      }).catch((cause) => {
        inFlightExpenses.current.delete(expenseId);
        if (!controller.signal.aborted) setExpenseError(cause);
      });
    });
  }, [expenseRetry, expenses, loadedCredit?.applications, preselectedExpenseId]);

  useEffect(() => {
    if (initializationRouteKey !== routeKey || !loadedCredit || !editCreditReady || seeded.current === loadedCredit.id) return;
    seeded.current = loadedCredit.id;
    setApplications(loadedCredit.applications.map((application) => ({ id: id(), expenseId: application.expenseId, amount: money(application.amountMinor), touched: true, provenance: 'user' })));
    setAllocations(loadedCredit.allocations.map((allocation) => ({ id: id(), personId: allocation.personId, allocationType: allocation.allocationType, amount: money(allocation.amountMinor), touched: true })));
    setMode(loadedCredit.deliveryMode); setSubtype(loadedCredit.subtype); setCurrency(loadedCredit.currency); setAmount(money(loadedCredit.amountMinor)); setAmountTouched(true); setAmountProvenance('user'); setDate(loadedCredit.date); setNote(loadedCredit.note || '');
    setEditInitialized(true);
  }, [editCreditReady, initializationRouteKey, loadedCredit, routeKey]);

  const linked = applications.length > 0;
  const firstExpense = expenses.find((expense) => expense.id === applications[0]?.expenseId);

  useEffect(() => {
    if (!initializing && !editRoute && !loadedCredit && group?.currency && !seededGroupCurrency.current) {
      seededGroupCurrency.current = true;
      if (!linked) setCurrency(group.currency);
    }
  }, [editRoute, group?.currency, initializing, linked, loadedCredit]);

  useEffect(() => {
    if (!initializing && firstExpense && firstExpense.currency !== currency) setCurrency(firstExpense.currency);
  }, [currency, firstExpense, initializing]);

  useEffect(() => {
    if (!initializing && !loadedCredit && preselectedExpenseId && firstExpense?.id === preselectedExpenseId && !amountTouched) {
      setAmount(money(expenseCapacity(firstExpense)));
      setAmountProvenance('default');
    }
  }, [amountTouched, firstExpense, initializing, loadedCredit, preselectedExpenseId]);

  useEffect(() => {
    if (!initializing && !loadedCredit && preselectedExpenseId && expenses.some((expense) => expense.id === preselectedExpenseId)) {
      setApplications((current) => current.length === 1 && !current[0].expenseId ? [{ ...current[0], expenseId: preselectedExpenseId }] : current);
    }
  }, [expenses, initializing, loadedCredit, preselectedExpenseId]);

  const loadMore = async () => {
    if (!cursor || loadingMore || !online) return;
    const request = pageScope.current.begin(routeKey, cursor);
    loadingCursorRef.current = request.cursor;
    setLoadingMore(true); setExpenseError(undefined);
    try {
      const page = await getExpensePage(groupId, { limit: 50, cursor: request.cursor }, request.signal);
      if (!pageScope.current.isCurrent(request) || scopeKeyRef.current !== request.key || cursorRef.current !== request.cursor) return;
      setExpenses((current) => uniqueExpenses([...current, ...page.expenses]));
      cursorRef.current = page.nextCursor;
      setCursor(page.nextCursor);
    } catch (cause) {
      if (pageScope.current.isCurrent(request) && scopeKeyRef.current === request.key && cursorRef.current === request.cursor && !(cause instanceof DOMException && cause.name === 'AbortError')) setExpenseError(cause);
    } finally {
      if (pageScope.current.isCurrent(request) && scopeKeyRef.current === request.key && loadingCursorRef.current === request.cursor) {
        loadingCursorRef.current = undefined;
        setLoadingMore(false);
      }
    }
  };

  const retryMissingExpenses = () => { setExpenseError(undefined); setExpenseRetry((value) => value + 1); if (me.data?.id) void revalidate<ExpensePage>(expenseResourceKey, me.data.id, { force: true, reason: 'route' }); };
  const updateApplication = (applicationId: string, patch: Partial<Application>) => setApplications((current) => current.map((application) => application.id === applicationId ? { ...application, ...patch } : application));
  const chooseExpense = (application: Application, expenseId: string) => {
    const nextExpense = expenses.find((expense) => expense.id === expenseId);
    updateApplication(application.id, { expenseId, amount: '', touched: false, provenance: 'default' });
    if (application.id === applications[0]?.id && nextExpense) {
      setCurrency(nextExpense.currency);
      if (!amountTouched) { setAmount(money(expenseCapacity(nextExpense, loadedCredit?.id))); setAmountProvenance('default'); }
      setApplications((current) => current.map((candidate, index) => index === 0 ? candidate : (candidate.expenseId && expenses.find((expense) => expense.id === candidate.expenseId)?.currency !== nextExpense.currency ? { ...candidate, expenseId: '', amount: '', touched: false, provenance: 'default' } : candidate)));
    }
  };

  let amountMinor = 0;
  try { if (amount.trim()) amountMinor = parseMoney(amount, currency); } catch { amountMinor = -1; }

  useEffect(() => {
    if (initializing || !applications.length || amountMinor <= 0) return;
    setApplications((current) => defaultRefundApplications(current, expenses, amountMinor, loadedCredit?.id));
  }, [amountMinor, applications.map((application) => `${application.id}:${application.expenseId}:${application.amount}:${application.touched}`).join('|'), expenses, initializing, loadedCredit?.id]);

  useEffect(() => {
    if (initializing) return;
    if (allocations.length) {
      if (!linked && mode === 'member_reimbursement' && !allocations.some((allocation) => allocation.allocationType === 'beneficiary')) setAllocations((current) => [...current, emptyAllocation('beneficiary')]);
      return;
    }
    setAllocations(linked ? [emptyAllocation('recipient')] : mode === 'member_reimbursement' ? [emptyAllocation('recipient'), emptyAllocation('beneficiary')] : []);
  }, [initializing, linked, mode]);

  useEffect(() => {
    if (!linked && mode === 'direct_provider_offset') setMode('member_reimbursement');
  }, [linked, mode]);

  const parsedApplications = applications.map((application) => {
    try { return { ...application, amountMinor: parseMoney(application.amount, currency) }; } catch { return { ...application, amountMinor: -1 }; }
  });
  const appliedMinor = parsedApplications.reduce((sum, application) => sum + Math.max(0, application.amountMinor), 0);
  const applicationStatus = refundApplicationStatus(amountMinor, appliedMinor, currency);
  const capacityErrors = parsedApplications.map((application) => {
    const expense = expenses.find((candidate) => candidate.id === application.expenseId);
    if (!expense || application.amountMinor < 0) return expense ? `Enter a valid amount for ${expense.description}.` : 'Choose an expense.';
    return application.amountMinor > expenseCapacity(expense, loadedCredit?.id) ? `${expense.description} has only ${money(expenseCapacity(expense, loadedCredit?.id))} ${currency} remaining.` : undefined;
  });
  const recipientRows = allocations.filter((allocation) => allocation.allocationType === 'recipient');
  useEffect(() => {
    if (initializing || mode !== 'member_reimbursement') return;
    setAllocations((current) => current.map((row) => {
      if (row.allocationType !== 'recipient') return row;
      const eligible = groupResource.data?.members || [];
      const defaultPerson = eligible.find((member) => member.personId === currentPersonId) || (eligible.length === 1 ? eligible[0] : undefined);
      const choose = !editRoute && !row.personId && !row.personTouched && current.filter((candidate) => candidate.allocationType === 'recipient').length === 1 && defaultPerson;
      const nextAmount = recipientRows.length === 1 && !row.touched ? (amountMinor > 0 ? money(amountMinor) : '') : row.amount;
      return { ...row, amount: nextAmount, ...(choose ? { personId: choose.personId, defaultHint: choose.personId === currentPersonId ? 'Defaults to you. Change this if someone else received the money.' : 'Defaults to the only eligible member. Change this if needed.' } : {}) };
    }));
  }, [amountMinor, currentPersonId, editRoute, groupResource.data, initializing, mode, recipientRows.length]);
  const affectedRows = allocations.filter((allocation) => allocation.allocationType === 'beneficiary');
  const validationAllocationRows = refundAllocationRowsForValidation(allocations, mode, linked, adjustBenefits);
  const duplicateAllocationError = refundAllocationDuplicateError(validationAllocationRows);
  const sumRows = (rows: Allocation[]) => rows.reduce((sum, row) => { try { return sum + parseMoney(row.amount, currency); } catch { return sum; } }, 0);
  const recipientsMinor = sumRows(recipientRows);
  const affectedMinor = sumRows(affectedRows);
  const applicationSources = parsedApplications.flatMap((application) => {
    const expense = expenses.find((candidate) => candidate.id === application.expenseId);
    return expense && application.amountMinor >= 0 ? [{ amountMinor: application.amountMinor, expense }] : [];
  });
  const derivedBeneficiaries = derivedBeneficiaryShares(applicationSources);
  const derivedPayers = derivedPayerShares(applicationSources);
  useEffect(() => {
    if (benefitsReset.current || !loadedCredit || !linked || mode !== 'member_reimbursement' || adjustBenefits || !affectedRows.length || !derivedBeneficiaries.length) return;
    if (!beneficiarySnapshotMatches(affectedRows, derivedBeneficiaries, currency)) setAdjustBenefits(true);
  }, [adjustBenefits, affectedRows, currency, derivedBeneficiaries, linked, loadedCredit, mode]);
  const affectedNeedsTotals = mode === 'member_reimbursement' && linked && adjustBenefits;
  const totalError = refundMoneyError(amount, currency);
  const applicationTotalError = linked && !totalError && appliedMinor !== amountMinor ? `Applied amounts must total ${money(amountMinor)} ${currency}.` : undefined;
  const applicationAggregateInvalid = Boolean(applicationTotalError && applications.every((row, index) => row.expenseId && !refundMoneyError(row.amount, currency) && !capacityErrors[index]));
  const canAddRecipient = !recipientRows.some((row) => !row.personId) && recipientRows.length < people.length;
  const hasCustomBenefits = affectedRows.some((row) => row.personId && row.touched);
  const canAdjustBenefits = hasCustomBenefits || derivedBeneficiaries.every((row) => people.some((person) => person.personId === row.personId));
  const canResetBenefits = refundOriginalSplitAllowed((groupResource.data?.members || []).map((member) => member.personId), derivedBeneficiaries, loadedCredit);
  // A supported reset can become unsupported after the linked amounts or
  // membership change. Keep saved custom rows intact so reopening can recover.
  const historicalDerivedError = loadedCredit && linked && mode === 'member_reimbursement' && !adjustBenefits && !canResetBenefits
    ? 'The original split would change a former member’s saved share. Restore the previous applied amounts or choose Adjust who benefits to retain the saved split.' : undefined;
  const emptyBenefits = mode === 'member_reimbursement' && (!linked || adjustBenefits) && affectedRows.length === 0;
  const localError = refundMoneyError(amount, currency) || (!date ? 'Choose a date.' : undefined)
    || (mode === 'direct_provider_offset' && !linked ? 'Original payment or bill adjustments must link an expense.' : undefined)
    || duplicateAllocationError
    || historicalDerivedError
    || (linked ? applications.map((row, index) => !row.expenseId ? `Choose expense ${index + 1}.` : refundMoneyError(row.amount, currency) || capacityErrors[index]).find(Boolean) : undefined)
    || validationAllocationRows.map((row) => !row.personId ? `Choose a ${row.allocationType === 'recipient' ? 'recipient' : 'affected member'}.` : refundMoneyError(row.amount, currency)).find(Boolean)
    || (linked && appliedMinor !== amountMinor ? `Applied ${money(appliedMinor)} of ${money(amountMinor)} ${currency}.` : undefined)
    || (mode === 'member_reimbursement' && (!recipientRows.length || recipientsMinor !== amountMinor) ? 'Recipient amounts must total the refund.' : undefined)
    || (mode === 'member_reimbursement' && (!linked || affectedNeedsTotals) && !beneficiaryRowsComplete(affectedRows, amountMinor, currency) ? 'Affected-member amounts must total the full refund amount.' : undefined);
  const submitDisabled = !online || busy || !group || initializing;
  const showValidation = submitAttempted;

  const updateAllocation = (rowId: string, patch: Partial<Allocation>) => setAllocations((current) => current.map((row) => row.id === rowId ? { ...row, ...patch } : row));
  const removeAllocation = (rowId: string, type: AllocationType) => setAllocations((current) => removeRefundAllocation(current, rowId, type === 'recipient' ? 1 : (!linked && mode === 'member_reimbursement' ? 1 : 0)).map((row) => type === 'recipient' && row.allocationType === 'recipient' ? { ...row, touched: true } : row));
  const resetBenefits = () => { if (!canResetBenefits) return; benefitsReset.current = true; setAdjustBenefits(false); };
  const openBenefits = () => {
    if (!canAdjustBenefits) return;
    if (!hasCustomBenefits) setAllocations((current) => [...current.filter((row) => row.allocationType !== 'beneficiary'), ...derivedBeneficiaries.map((row) => ({ id: id(), personId: row.personId, allocationType: 'beneficiary' as const, amount: money(row.amountMinor), touched: true }))]);
    setAdjustBenefits(true);
  };
  const useFullRemaining = (application: Application) => {
    const expense = expenses.find((candidate) => candidate.id === application.expenseId);
    if (!expense) return;
    const capacity = expenseCapacity(expense, loadedCredit?.id);
    const fillAmount = refundApplicationFillAmount(applications, application.id, amountMinor, capacity, currency);
    updateApplication(application.id, { amount: money(fillAmount), touched: true, provenance: 'user' });
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) { setAmount(money(capacity)); setAmountTouched(true); setAmountProvenance('user'); }
  };

  const submit = (event: FormEvent) => runProtectedOperation(async () => {
    event.preventDefault(); setSubmitAttempted(true);
    if (submitDisabled || !group) return;
    if (localError) {
      const form = (event as FormEvent<HTMLFormElement>).currentTarget;
      setTimeout(() => form?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(), 0);
      return;
    }
    setBusy(true); setError(undefined);
    try {
      const generation = captureSessionGeneration();
      const mutationUserId = me.data?.id;
      const input = buildRefundInput({ subtype, mode, amountMinor, currency, date, note, linked, adjustBenefits, applications: parsedApplications.map((application) => ({ expenseId: application.expenseId, amountMinor: application.amountMinor })), allocations });
      const result = loadedCredit ? await updateCredit(loadedCredit.id, { ...input, version: loadedCredit.version }) : await createCredit(groupId, { ...input, client_operation_id: operationController.current() });
      if (!isSessionGenerationCurrent(generation)) return;
      await invalidateForMutation.creditChanged(groupId, mutationUserId, result.credit.id, generation);
      if (!isSessionGenerationCurrent(generation)) return;
      operationController.rotateAfterSuccess();
      navigate(`/groups/${groupId}/credits/${result.credit.id}`);
    } catch (cause) { setError(cause); }
    finally { setBusy(false); }
  }, 'Saving refund');

  if ((me.error && !me.data) || (groupResource.error && !group) || (creditId && editResource.error && !editCreditReady)) return <Layout><p role="alert">{refundErrorText(me.error || groupResource.error || editResource.error)}</p><Link className="back" to={`/groups/${groupId}`}>← Group</Link></Layout>;
  if (!group) return <Layout><Loading /></Layout>;
  if (initializing) return <Layout><Loading /></Layout>;

  const memberLabel = (personId: string) => personName([...people, ...(groupResource.data?.historicalParticipants || []).map((person) => ({ personId: person.personId, name: historicalName(person) }))], personId, currentPersonId);
  const statusReason = !online ? 'Reconnect to record a refund or reimbursement.' : !group ? 'Group details are still loading.' : localError || 'Complete the required fields to record this refund or reimbursement.';
  const derivedDisplay = mode === 'member_reimbursement' ? refundBeneficiaryPreviewRows(affectedRows, derivedBeneficiaries, linked, adjustBenefits, currency) : affectedRows.map((allocation) => ({ personId: allocation.personId, amountMinor: (() => { try { return parseMoney(allocation.amount, currency); } catch { return 0; } })() }));
  const sideRows = refundPreviewRows(mode, recipientRows, derivedPayers, derivedBeneficiaries, derivedDisplay, currency);
  const previewPeople = groupRefundPreviewRows(sideRows);

  return <Layout>
    <section className="refund-form" aria-labelledby="refund-form-title">
      <Link to={`/groups/${groupId}`} className="back">← Group</Link>
       <PageHeader className="page-title" headingId="refund-form-title" eyebrow="Online-only ledger action" title={loadedCredit ? 'Edit refund or reimbursement' : 'Record money back'} />
      {!online ? <ConnectionBanner detail="Refunds and payments require a connection. New expenses remain available offline." /> : null}
       <FormSurface className="refund-form__surface"><form noValidate onChangeCapture={captureDraft} onClickCapture={captureDraft} onSubmit={submit} aria-describedby="refund-form-help refund-form-status">
        <p id="refund-form-help" className="muted">Start with an expense when possible. The original payment or bill adjustment derives payer and affected shares; a member reimbursement requires a confirmed recipient.</p>
          <fieldset><legend>How should this money be recorded?</legend>
           <Field label="Apply this to"><select value={linked ? 'linked' : 'standalone'} onChange={(event) => { const nextPath = event.target.value as 'linked' | 'standalone'; setApplications(refundApplicationsForPath(nextPath, applications)); if (nextPath === 'standalone' && mode === 'direct_provider_offset') setMode('member_reimbursement'); }}><option value="linked">One or more expenses</option><option value="standalone">No specific expense</option></select></Field>
           <Field label="Source"><select aria-describedby="refund-source-help" value={subtype} onChange={(event) => setSubtype(event.target.value as typeof subtype)}>{refundSourceOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></Field>
           <small id="refund-source-help" className="refund-form__help">This source controls how the transaction is labeled in the ledger and exports.</small>
           <Field label="How was it handled?"><select aria-describedby="refund-mode-help" value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}>{refundModeOptions(linked).map((option) => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}</select></Field>
           <small id="refund-mode-help" className="refund-form__help">The original payment or bill option is available only with linked expenses and derives payer and cost-reduction shares. If a group member received the money, select the recipient below.</small>
           {linked ? <p className="muted">Currency: {currency} · locked to the first expense</p> : null}
           <div className="field"><label htmlFor="refund-amount">How much? ({currency})</label><AmountControl id="refund-amount" currency={currency} onCurrencyChange={linked ? undefined : setCurrency} required value={amount} onBlur={() => validateBlur('total')} onChange={(event) => { setAmount(event.target.value); setAmountTouched(true); setAmountProvenance('user'); }} aria-describedby="refund-total-error" aria-invalid={Boolean(validationVisible('total') && totalError)} />{validationVisible('total') && totalError ? <small id="refund-total-error" className="field-error">{totalError}</small> : null}<small>Credit total: {amountMinor > 0 ? money(amountMinor) : '—'} {currency} · {amountProvenance === 'default' ? 'Suggested and editable' : 'Entered total'}</small></div>
          <Field label="Date"><input required type="date" value={date} onBlur={() => validateBlur('date')} aria-invalid={validationVisible('date') && !date} aria-describedby="refund-date-error" onChange={(event) => setDate(event.target.value)} />{validationVisible('date') && !date ? <small id="refund-date-error" className="field-error">Choose a date.</small> : null}</Field>
          <Field label="Note (optional)"><textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} /></Field>
          </fieldset>

          <fieldset><legend>{linked ? 'Which expenses should this reduce?' : 'Advanced standalone details'}</legend>
          {linked ? <>
            <Field label="Search eligible expenses"><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search by description or date" /></Field>
             {applications.map((application, index) => { const expense = expenses.find((candidate) => candidate.id === application.expenseId); const capacity = expense ? expenseCapacity(expense, loadedCredit?.id) : 0; const fillAmount = refundApplicationFillAmount(applications, application.id, amountMinor, capacity, currency); return <div className="refund-application-row" key={application.id}>
               <Field label={`Expense ${index + 1}`}><select required onBlur={() => validateBlur(`${application.id}-expense`)} aria-invalid={validationVisible(`${application.id}-expense`) && !expense} aria-describedby={`${application.id}-expense-error`} value={application.expenseId} onChange={(event) => chooseExpense(application, event.target.value)}><option value="">Choose an expense</option><RefundExpensePickerOptions expenses={expenses} rows={applications} rowId={application.id} editingCreditId={loadedCredit?.id} search={search} /></select>{validationVisible(`${application.id}-expense`) && !expense ? <small id={`${application.id}-expense-error`} className="field-error">Choose an expense.</small> : null}</Field>
               {expense ? <p className="muted">{expense.date} · Gross {money(expense.amountMinor)} {expense.currency} · Already refunded {money(expense.amountMinor - capacity)} · Remaining {money(capacity)} {expense.currency}</p> : null}
                <Field label={`Applied amount (${currency})`}><AmountControl currency={currency} required onBlur={() => validateBlur(`${application.id}-amount`)} aria-invalid={validationVisible(`${application.id}-amount`) && Boolean(refundMoneyError(application.amount, currency) || (expense && capacityErrors[index]) || (showValidation && applicationAggregateInvalid))} aria-describedby={`${application.id}-amount-error refund-application-total-error`} aria-label={`Applied amount for expense ${index + 1} (${currency})`} name={`application-${index + 1}-amount`} value={application.amount} onChange={(event) => updateApplication(application.id, { amount: event.target.value, touched: true, provenance: 'user' })} />{validationVisible(`${application.id}-amount`) && (refundMoneyError(application.amount, currency) || (expense && capacityErrors[index])) ? <small id={`${application.id}-amount-error`} className="field-error">{refundMoneyError(application.amount, currency) || capacityErrors[index]}</small> : null}<small>Expense capacity: {money(capacity)} {expense?.currency || currency}</small></Field>
               {expense ? <Button type="button" variant="secondary" disabled={fillAmount === 0} aria-label={fillAmount === 0 ? `No remaining refund for expense ${index + 1}` : `Apply remaining refund to expense ${index + 1}`} onClick={() => useFullRemaining(application)}>{fillAmount === 0 ? 'No remaining refund to apply' : `Apply remaining refund (${money(fillAmount)} ${expense.currency})`}</Button> : null}
               {showValidation && capacityErrors[index] ? <p role="alert" className="field-error">{capacityErrors[index]}</p> : null}
               {applications.length > 1 ? <Button type="button" variant="secondary" aria-label={`Remove expense ${index + 1}`} onClick={() => setApplications((current) => current.filter((candidate) => candidate.id !== application.id))}>Remove expense</Button> : null}
             </div>; })}
              {amountMinor > 0 ? <output className={`refund-application-status refund-application-status--${applicationStatus.kind}`} aria-live="polite">{applicationStatus.label}</output> : <output className="refund-application-status" aria-live="polite">Enter a refund total to see what remains to apply.</output>}
              {showValidation && applicationTotalError ? <p id="refund-application-total-error" className="field-error">{applicationTotalError}</p> : null}
             <div className="refund-application-actions"><Button type="button" variant="secondary" onClick={() => setApplications((current) => [...current, emptyApplication()])}>Apply to another expense</Button>{cursor ? <Button type="button" variant="secondary" disabled={!online || loadingMore} onClick={() => void loadMore()}>{loadingMore ? 'Loading expenses…' : 'Load more expenses'}</Button> : null}</div>
            {expenseError ? <p role="alert">{refundErrorText(expenseError)} <Button type="button" variant="secondary" onClick={retryMissingExpenses}>Retry expense details</Button></p> : null}
            {expenseResource.error ? <p className="cache-status" role="status">Showing cached eligible expenses; they may be out of date. <Button type="button" variant="secondary" onClick={retryMissingExpenses}>Retry expense list</Button></p> : null}
           </> : <p className="muted">Standalone records do not change an expense. Explicitly identify who received the money and whose costs this should reduce.</p>}
          </fieldset>

          <fieldset id="refund-money-flow" tabIndex={-1} aria-invalid={showValidation && Boolean(historicalDerivedError || emptyBenefits)} aria-describedby={showValidation && historicalDerivedError ? 'refund-historical-derived-error' : showValidation && emptyBenefits ? 'refund-affected-member-total-error' : undefined}><legend>Money flow</legend>
          {showValidation && historicalDerivedError ? <p id="refund-historical-derived-error" role="alert" className="field-error">{historicalDerivedError}</p> : null}
          {mode === 'member_reimbursement' ? <>
             <h2>Who actually received the money?</h2>
             <p className="muted">Choose the person whose account received the money, even if someone else paid the original expense.</p>
            <AllocationRows rows={recipientRows} label="Recipient" currency={currency} people={people} currentPersonId={currentPersonId} onChange={updateAllocation} onRemove={(rowId) => removeAllocation(rowId, 'recipient')} minimumRows={1} showErrors={showValidation} error={showValidation && recipientsMinor !== amountMinor ? 'Recipient amounts must total the refund.' : undefined} />
             <output aria-live="polite">{amountMinor > 0 ? refundApplicationStatus(amountMinor, recipientsMinor, currency).label.replace('apply', 'allocate') : 'Enter a total to allocate.'}</output>
              <div className="refund-allocation-actions">{recipientRows.map((row) => <Button key={row.id} type="button" variant="secondary" disabled={amountMinor <= 0} onClick={() => updateAllocation(row.id, { amount: money(refundApplicationFillAmount(recipientRows, row.id, amountMinor, amountMinor, currency)), touched: recipientRows.length > 1 })}>{recipientRows.length === 1 ? 'Use full total' : `Use remaining total for recipient ${recipientRows.indexOf(row) + 1}`}</Button>)}<Button type="button" variant="secondary" disabled={!canAddRecipient} onClick={() => { if (canAddRecipient) setAllocations((current) => [...current.map((row) => row.allocationType === 'recipient' ? { ...row, touched: true } : row), { ...emptyAllocation('recipient'), personTouched: true }]); }}>Add recipient</Button></div>
             <h2>Whose expense shares should decrease?</h2>
             <p className="muted">Choose who benefits from the refund. Their expense shares decrease independently of who actually received the money.</p>
              {linked && !adjustBenefits ? <><p className="muted">Affected shares follow the original expense split and are read-only until adjusted.</p><LedgerList label="Affected shares">{derivedDisplay.map((allocation) => <LedgerRow key={allocation.personId}><span>{memberLabel(allocation.personId)} · original split</span><Money amountMinor={allocation.amountMinor} currency={currency} /></LedgerRow>)}</LedgerList><div className="refund-allocation-actions"><Button type="button" variant="secondary" disabled={!canAdjustBenefits} aria-describedby={!canAdjustBenefits ? 'refund-historical-benefits-help' : undefined} onClick={openBenefits}>Adjust who benefits</Button></div>{!canAdjustBenefits ? <p id="refund-historical-benefits-help" className="muted">This expense includes former members. Keep the original expense split; these historical shares cannot be added as new manual allocations.</p> : null}</> : <><AllocationRows rows={affectedRows} label="Affected member" currency={currency} people={people} currentPersonId={currentPersonId} onChange={updateAllocation} onRemove={(rowId) => removeAllocation(rowId, 'beneficiary')} minimumRows={!linked ? 1 : 0} showErrors={showValidation} error={showValidation && affectedMinor !== amountMinor ? 'Affected-member amounts must total the refund.' : undefined} /><div className="refund-allocation-actions"><Button type="button" variant="secondary" onClick={() => setAllocations((current) => [...current, emptyAllocation('beneficiary')])}>Add affected member</Button>{linked ? <Button type="button" variant="secondary" disabled={!canResetBenefits} aria-describedby={!canResetBenefits ? 'refund-reset-benefits-help' : undefined} onClick={resetBenefits}>Use original expense split</Button> : null}</div>{linked && !canResetBenefits ? <p id="refund-reset-benefits-help" className="muted">The original split would change a former member’s saved share. Editing can only retain that member’s exact saved beneficiary amount; keep the saved split instead.</p> : null}</>}
          </> : <p className="muted">Both payer and affected shares are derived from linked expenses.</p>}
          {!linked && mode === 'member_reimbursement' ? <p className="muted">Standalone mode requires explicit recipient and affected-member allocations.</p> : null}
           </fieldset>

            <section className="refund-preview-section"><SectionHeader title="How this affects settlement" />
              <p>Refund total: <Money amountMinor={Math.max(0, amountMinor)} currency={currency} />{linked ? <> · Applied: <Money amountMinor={Math.max(0, appliedMinor)} currency={currency} /> · <span className="refund-preview-application-status">{amountMinor > 0 ? applicationStatus.label : 'Enter a refund total to see application status.'}</span></> : null}</p>
              {localError ? <p className="muted">Complete the required fields with valid amounts to see how this refund changes settlement.</p> : <>
                <LedgerList className="refund-preview-list" label="Refund preview">{previewPeople.map((person) => <LedgerRow className="refund-preview-person" key={person.personId}><span><strong>{memberLabel(person.personId)}</strong>{person.components.map((component) => <small className="refund-preview-component" key={`${person.personId}-${component.label}`}>{component.label}: <Money amountMinor={component.amountMinor} currency={currency} /></small>)}<small className="refund-preview-net">Net balance effect: <Money amountMinor={person.netMinor} currency={currency} tone={person.netMinor > 0 ? 'positive' : person.netMinor < 0 ? 'debt' : undefined} /></small><small>{refundSettlementEffect(person.netMinor, currency)}</small></span></LedgerRow>)}</LedgerList>
                <p className="muted">These are changes from this refund, not your total balances or instructions to transfer money between particular people.</p>
              </>}
              {linked && mode === 'member_reimbursement' && derivedPayers.some((payer) => recipientRows.some((recipient) => recipient.personId && recipient.personId !== payer.personId)) ? <p className="refund-transfer-help">If the recipient has already transferred, or later transfers, this money to the original payer, record that transfer as a separate payment. This refund records the actual receipt, not that transfer.</p> : null}
              {!localError && linked && mode === 'member_reimbursement' && derivedPayers.length === 1 && recipientRows.length === 1 && derivedPayers[0].personId !== recipientRows[0].personId && previewPeople.some((person) => person.personId === derivedPayers[0].personId && person.netMinor > 0) ? <p className="muted">{memberLabel(derivedPayers[0].personId)} paid the original expense but did not receive this refund. Their expense share decreases while their original payment stays recorded, so the amount they owe decreases, or the amount they are owed increases.</p> : null}
            </section>
        {(showValidation && localError) || error ? <p id="refund-form-status" role="alert" className="error">{refundErrorText(error || new Error(localError))}</p> : <p id="refund-form-status" className={submitDisabled ? 'cache-status' : 'sr-only'} role="status" aria-live="polite">{submitDisabled ? statusReason : 'Refund form is ready. Submit is available.'}</p>}
         <ActionGroup className="actions"><Button type="submit" disabled={submitDisabled}>{busy ? 'Saving…' : loadedCredit ? 'Save refund/reimbursement' : 'Record money back'}</Button><Link className="button button--secondary" to={`/groups/${groupId}`}>Cancel</Link></ActionGroup>
       </form></FormSurface>
    </section>
  </Layout>;
}

export function RefundCreateRoute() { return <RefundForm />; }
export function RefundEditRoute() { return <RefundForm />; }
