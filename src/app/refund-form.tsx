import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { Currency, Credit, Expense, GroupResponse, HistoricalParticipant } from '../shared/types';
import { currencyOptions, type CreditInput } from '../shared/schemas';
import { parseMoney } from '../domain/money';
import { createCredit, getCreditDetails, getExpenseDetails, getExpensePage, getGroup, getMe, hydrateExpenses, updateCredit, type ExpensePage, ApiError } from './api';
import { captureSessionGeneration, isSessionGenerationCurrent } from './session';
import { invalidateForMutation, revalidate, RESOURCE_FRESHNESS, resourceKeys, useResource } from './resource-cache';
import { Button, Field, Layout, Money, Surface, useOnlineStatus } from './ui';
import { defaultRefundApplications, derivedBeneficiaryShares, derivedPayerShares, localBrowserDate, remainingRefundableMinor, type CreditAllocationDraft, type CreditApplicationDraft } from './credit-form';
import { createPageRequestScope } from './pagination';

type Application = CreditApplicationDraft;
type Allocation = CreditAllocationDraft & { touched?: boolean };
type AllocationType = Allocation['allocationType'];

const id = () => crypto.randomUUID();
const money = (minor: number) => (minor / 100).toFixed(2);
export const refundErrorText = (error: unknown) => error instanceof ApiError ? error.message : error instanceof Error ? error.message : 'Something went wrong. Retry when the connection is available.';
const emptyApplication = (expenseId = ''): Application => ({ id: id(), expenseId, amount: '', touched: false, provenance: 'default' });
const emptyAllocation = (allocationType: AllocationType): Allocation => ({ id: id(), personId: '', allocationType, amount: '', touched: false });

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
  const submittedAllocations = allocations.filter((allocation) => allocation.personId && (adjustBenefits || !linked || allocation.allocationType === 'recipient'));
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
    try { total += parseMoney(row.amount, currency); } catch { return false; }
  }
  return total === amountMinor;
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

function Loading() { return <p className="muted" role="status">Loading…</p>; }
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
  return <>
    {rows.map((row) => <div className="allocation-row" key={row.id}>
      <Field label={label}>
        <select required value={row.personId} onChange={(event) => onChange(row.id, { personId: event.target.value, touched: true })}>
          <option value="">Choose a person</option>
          {people.map((person) => <option key={person.personId} value={person.personId}>{personName(people, person.personId, currentPersonId)}</option>)}
        </select>
      </Field>
      <Field label={`Amount (${currency})`}>
        <input required inputMode="decimal" value={row.amount} onChange={(event) => onChange(row.id, { amount: event.target.value, touched: true })} />
      </Field>
      {rows.length > minimumRows ? <Button type="button" variant="secondary" onClick={() => onRemove(row.id)}>Remove</Button> : null}
    </div>)}
    {showErrors && error ? <p role="alert" className="field-error">{error}</p> : null}
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const seeded = useRef<string>();
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

  useEffect(() => {
    if (previousRouteKey.current === routeKey) return;
    previousRouteKey.current = routeKey;
    seeded.current = undefined;
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
      setExpenses((current) => uniqueExpenses([...current, ...expenseResource.data!.expenses]));
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
  }, [amountMinor, applications.map((application) => `${application.id}:${application.expenseId}:${application.amount}:${application.touched}`).join('|'), expenses.length, initializing, loadedCredit?.id]);

  useEffect(() => {
    if (initializing) return;
    if (allocations.length) {
      if (!linked && mode === 'member_reimbursement' && !allocations.some((allocation) => allocation.allocationType === 'beneficiary')) setAllocations((current) => [...current, emptyAllocation('beneficiary')]);
      return;
    }
    setAllocations(linked ? [emptyAllocation('recipient')] : mode === 'member_reimbursement' ? [emptyAllocation('recipient'), emptyAllocation('beneficiary')] : []);
  }, [initializing, linked, mode]);

  const parsedApplications = applications.map((application) => {
    try { return { ...application, amountMinor: parseMoney(application.amount, currency) }; } catch { return { ...application, amountMinor: -1 }; }
  });
  const appliedMinor = parsedApplications.reduce((sum, application) => sum + Math.max(0, application.amountMinor), 0);
  const capacityErrors = parsedApplications.map((application) => {
    const expense = expenses.find((candidate) => candidate.id === application.expenseId);
    if (!expense || application.amountMinor < 0) return expense ? `Enter a valid amount for ${expense.description}.` : 'Choose an expense.';
    return application.amountMinor > expenseCapacity(expense, loadedCredit?.id) ? `${expense.description} has only ${money(expenseCapacity(expense, loadedCredit?.id))} ${currency} remaining.` : undefined;
  });
  const recipientRows = allocations.filter((allocation) => allocation.allocationType === 'recipient');
  const affectedRows = allocations.filter((allocation) => allocation.allocationType === 'beneficiary');
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
    if (!loadedCredit || !linked || mode !== 'member_reimbursement' || adjustBenefits || !affectedRows.length || !derivedBeneficiaries.length) return;
    if (!beneficiarySnapshotMatches(affectedRows, derivedBeneficiaries, currency)) setAdjustBenefits(true);
  }, [adjustBenefits, affectedRows, currency, derivedBeneficiaries, linked, loadedCredit, mode]);
  const affectedNeedsTotals = mode === 'member_reimbursement' && linked && adjustBenefits;
  const localError = !date ? 'Choose a date.' : amountMinor <= 0 ? 'Enter an amount greater than zero.' : mode === 'direct_provider_offset' && !linked ? 'Original payment or bill adjustments must link an expense.' : linked && applications.some((application) => !application.expenseId) ? 'Choose an expense for every row.' : linked && appliedMinor !== amountMinor ? `Applied ${money(appliedMinor)} of ${money(amountMinor)} ${currency}.` : capacityErrors.find(Boolean) || (!linked && mode === 'member_reimbursement' && (recipientsMinor !== amountMinor || affectedMinor !== amountMinor) ? 'Recipient and affected-member amounts must each total the refund.' : mode === 'member_reimbursement' && linked && recipientsMinor !== amountMinor ? 'Confirm who received the money for the full refund amount.' : affectedNeedsTotals && !beneficiaryRowsComplete(affectedRows, amountMinor, currency) ? 'Affected-member amounts must total the full refund amount.' : undefined);
  const submitDisabled = !online || busy || !group || Boolean(localError) || (mode === 'member_reimbursement' && !recipientRows.length);
  const showValidation = submitAttempted;

  const updateAllocation = (rowId: string, patch: Partial<Allocation>) => setAllocations((current) => current.map((row) => row.id === rowId ? { ...row, ...patch } : row));
  const removeAllocation = (rowId: string, type: AllocationType) => setAllocations((current) => removeRefundAllocation(current, rowId, type === 'recipient' ? 1 : (!linked && mode === 'member_reimbursement' ? 1 : 0)));
  const useFullRemaining = (application: Application) => {
    const expense = expenses.find((candidate) => candidate.id === application.expenseId);
    if (!expense) return;
    updateApplication(application.id, { amount: money(expenseCapacity(expense, loadedCredit?.id)), touched: true, provenance: 'user' });
    if (!amountTouched) { setAmount(money(expenseCapacity(expense, loadedCredit?.id))); setAmountTouched(true); setAmountProvenance('user'); }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setSubmitAttempted(true);
    if (submitDisabled || !group) return;
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
  };

  if ((me.error && !me.data) || (groupResource.error && !group) || (creditId && editResource.error && !editCreditReady)) return <Layout><p role="alert">{refundErrorText(me.error || groupResource.error || editResource.error)}</p><Link className="back" to={`/groups/${groupId}`}>← Group</Link></Layout>;
  if (!group) return <Layout><Loading /></Layout>;
  if (initializing) return <Layout><Loading /></Layout>;

  const memberLabel = (personId: string) => personName(people, personId, currentPersonId);
  const statusReason = !online ? 'Reconnect to record a refund or reimbursement.' : !group ? 'Group details are still loading.' : localError || 'Complete the required fields to record this refund or reimbursement.';
  const derivedDisplay = mode === 'member_reimbursement' ? refundBeneficiaryPreviewRows(affectedRows, derivedBeneficiaries, linked, adjustBenefits, currency) : affectedRows.map((allocation) => ({ personId: allocation.personId, amountMinor: (() => { try { return parseMoney(allocation.amount, currency); } catch { return 0; } })() }));
  const sideRows = mode === 'direct_provider_offset'
    ? [...derivedPayers.map((row) => ({ ...row, label: 'Payer-side reduction' })), ...derivedBeneficiaries.map((row) => ({ ...row, label: 'Affected cost reduction' }))]
    : [...recipientRows.map((row) => ({ personId: row.personId, amountMinor: (() => { try { return parseMoney(row.amount, currency); } catch { return 0; } })(), label: 'Recipient' })), ...derivedDisplay.map((row) => ({ ...row, label: 'Affected cost reduction' }))];

  return <Layout>
    <main className="refund-form" aria-labelledby="refund-form-title">
      <Link to={`/groups/${groupId}`} className="back">← Group</Link>
      <div className="page-title"><div><p className="eyebrow">Online-only ledger action</p><h1 id="refund-form-title">{loadedCredit ? 'Edit refund or reimbursement' : 'Record money back'}</h1></div></div>
      {!online ? <ConnectionBanner detail="Refunds and payments require a connection. New expenses remain available offline." /> : null}
      <form onSubmit={submit} aria-describedby="refund-form-help refund-form-status">
        <p id="refund-form-help" className="muted">Start with an expense when possible. The original payment or bill adjustment derives payer and affected shares; a member reimbursement requires a confirmed recipient.</p>
        <Surface><fieldset><legend>How should this money be recorded?</legend>
          <Field label="Path"><select value={linked ? 'linked' : 'standalone'} onChange={(event) => setApplications(refundApplicationsForPath(event.target.value as 'linked' | 'standalone', applications))}><option value="linked">Apply to an expense</option><option value="standalone">Standalone (advanced)</option></select></Field>
          <Field label="Refund type"><select value={subtype} onChange={(event) => setSubtype(event.target.value as typeof subtype)}><option value="refund">Refund</option><option value="claim">Reimbursement</option></select></Field>
          <Field label="What happened to the money?"><select value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}><option value="member_reimbursement">A group member received the money</option><option value="direct_provider_offset">Original payment or bill was adjusted</option></select></Field>
          {!linked ? <Field label="Currency"><select value={currency} onChange={(event) => setCurrency(event.target.value as Currency)}>{currencyOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></Field> : <p className="muted">Currency: {currency} · locked to the first expense</p>}
          <Field label={`How much? (${currency})`}><input required inputMode="decimal" value={amount} onChange={(event) => { setAmount(event.target.value); setAmountTouched(true); setAmountProvenance('user'); }} aria-invalid={Boolean(showValidation && amountMinor <= 0)} /><small>Credit total: {amountMinor > 0 ? money(amountMinor) : '—'} {currency} · {amountProvenance === 'default' ? 'Suggested and editable' : 'Entered total'}</small></Field>
          <Field label="Date"><input required type="date" value={date} onChange={(event) => setDate(event.target.value)} /></Field>
          <Field label="Note (optional)"><textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} /></Field>
        </fieldset></Surface>

        <Surface><fieldset><legend>{linked ? 'Which expenses should this reduce?' : 'Advanced standalone details'}</legend>
          {linked ? <>
            <Field label="Search eligible expenses"><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search by description or date" /></Field>
            {applications.map((application, index) => { const expense = expenses.find((candidate) => candidate.id === application.expenseId); const capacity = expense ? expenseCapacity(expense, loadedCredit?.id) : 0; return <div className="refund-application-row" key={application.id}>
              <Field label={`Expense ${index + 1}`}><select required value={application.expenseId} onChange={(event) => chooseExpense(application, event.target.value)}><option value="">Choose an expense</option><RefundExpensePickerOptions expenses={expenses} rows={applications} rowId={application.id} editingCreditId={loadedCredit?.id} search={search} /></select></Field>
              {expense ? <p className="muted">{expense.date} · Gross {money(expense.amountMinor)} {expense.currency} · Already refunded {money(expense.amountMinor - capacity)} · Remaining {money(capacity)} {expense.currency}</p> : null}
              <Field label={`Applied amount (${currency})`}><input required inputMode="decimal" value={application.amount} onChange={(event) => updateApplication(application.id, { amount: event.target.value, touched: true, provenance: 'user' })} /><small>Capacity: {money(capacity)} {currency}</small></Field>
              {expense ? <Button type="button" variant="secondary" onClick={() => useFullRemaining(application)}>Use full remaining ({money(capacity)} {expense.currency})</Button> : null}
              {showValidation && capacityErrors[index] ? <p role="alert" className="field-error">{capacityErrors[index]}</p> : null}
              {applications.length > 1 ? <Button type="button" variant="secondary" onClick={() => setApplications((current) => current.filter((candidate) => candidate.id !== application.id))}>Remove expense</Button> : null}
            </div>; })}
            <Button type="button" variant="secondary" onClick={() => setApplications((current) => [...current, emptyApplication()])}>Apply to another expense</Button>
            {cursor ? <Button type="button" variant="secondary" disabled={!online || loadingMore} onClick={() => void loadMore()}>{loadingMore ? 'Loading expenses…' : 'Load more expenses'}</Button> : null}
            {expenseError ? <p role="alert">{refundErrorText(expenseError)} <Button type="button" variant="secondary" onClick={retryMissingExpenses}>Retry expense details</Button></p> : null}
            {expenseResource.error ? <p className="cache-status" role="status">Showing cached eligible expenses; they may be out of date. <Button type="button" variant="secondary" onClick={retryMissingExpenses}>Retry expense list</Button></p> : null}
           </> : <p className="muted">Standalone records do not change an expense. Explicitly identify who received the money and whose costs this should reduce.</p>}
        </fieldset></Surface>

        <Surface><fieldset><legend>Money flow</legend>
          {mode === 'member_reimbursement' ? <>
            <h2>Who received the money?</h2>
            <AllocationRows rows={recipientRows} label="Recipient" currency={currency} people={people} currentPersonId={currentPersonId} onChange={updateAllocation} onRemove={(rowId) => removeAllocation(rowId, 'recipient')} minimumRows={1} showErrors={showValidation} error={showValidation && recipientsMinor !== amountMinor ? 'Recipient amounts must total the refund.' : undefined} />
            <Button type="button" variant="secondary" onClick={() => setAllocations((current) => [...current, emptyAllocation('recipient')])}>Add recipient</Button>
            <h2>Whose costs should this reduce?</h2>
            {linked && !adjustBenefits ? <><p className="muted">Affected shares follow the original expense split and are read-only until adjusted.</p><div className="list">{derivedDisplay.map((allocation) => <div className="row" key={allocation.personId}><span>{memberLabel(allocation.personId)} · original split</span><Money amountMinor={allocation.amountMinor} currency={currency} /></div>)}</div><Button type="button" variant="secondary" onClick={() => setAdjustBenefits(true)}>Adjust who benefits</Button></> : <><AllocationRows rows={affectedRows} label="Affected member" currency={currency} people={people} currentPersonId={currentPersonId} onChange={updateAllocation} onRemove={(rowId) => removeAllocation(rowId, 'beneficiary')} minimumRows={!linked ? 1 : 0} showErrors={showValidation} error={showValidation && affectedRows.length > 0 && affectedMinor !== amountMinor ? 'Affected-member amounts must total the refund.' : undefined} /><Button type="button" variant="secondary" onClick={() => setAllocations((current) => [...current, emptyAllocation('beneficiary')])}>Add affected member</Button></>}
          </> : <p className="muted">Both payer and affected shares are derived from linked expenses.</p>}
          {!linked && mode === 'member_reimbursement' ? <p className="muted">Standalone mode requires explicit recipient and affected-member allocations.</p> : null}
        </fieldset></Surface>

        <Surface><h2>Preview</h2><p>Refund total: <Money amountMinor={Math.max(0, amountMinor)} currency={currency} /> · Applied: <Money amountMinor={Math.max(0, appliedMinor)} currency={currency} /> · Remaining: <Money amountMinor={Math.max(0, amountMinor - appliedMinor)} currency={currency} />{appliedMinor > amountMinor ? ' · Overallocated' : ''}</p><div className="list">{sideRows.map((row) => <div className="row" key={`${row.label}-${row.personId}`}><span>{memberLabel(row.personId)}<small>{row.label}</small></span><Money amountMinor={row.amountMinor} currency={currency} /></div>)}</div><p className="muted">Amounts use integer cents with the same stable remainder rule as the server. {mode === 'direct_provider_offset' ? 'The payer side and affected cost side both reduce the group balance.' : 'The recipient receives the money and affected members receive the cost reduction.'}</p></Surface>
        {showValidation || error ? <p id="refund-form-status" role="alert" className="error">{refundErrorText(error || new Error(localError || 'Invalid form'))}</p> : <p id="refund-form-status" className={submitDisabled ? 'cache-status' : 'sr-only'} role="status" aria-live="polite">{submitDisabled ? statusReason : 'Refund form is ready. Submit is available.'}</p>}
        <div className="actions"><Button type="submit" disabled={submitDisabled}>{busy ? 'Saving…' : loadedCredit ? 'Save refund/reimbursement' : 'Record money back'}</Button><Link className="button button--secondary" to={`/groups/${groupId}`}>Cancel</Link></div>
      </form>
    </main>
  </Layout>;
}

export function RefundCreateRoute() { return <RefundForm />; }
export function RefundEditRoute() { return <RefundForm />; }
