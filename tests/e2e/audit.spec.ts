import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, newAuthenticatedContext, BASE_URL, DEV_EMAIL, EMPTY_EMAIL, REGISTERED_EMAIL, expect, seedOfflineTrust } from './fixtures';
import type { Browser, BrowserContext, Page, TestInfo } from '@playwright/test';

type Viewport = { width: number; height: number };
type Severity = 'critical' | 'major' | 'minor' | 'info';
type AuthState = 'public' | `authenticated:${string}`;
type Finding = {
  kind: string;
  severity: Severity;
  scenarioName: string;
  authState: AuthState;
  route: string;
  viewport: Viewport;
  context: string;
  selector?: string;
  detail: string;
  actual?: number;
};
type HarnessFailure = {
  category?: 'scenario' | 'setup' | 'environment';
  scenarioName: string;
  authState: AuthState;
  route: string;
  viewport: Viewport;
  detail: string;
};
type Coverage = {
  scenarioName: string;
  authState: AuthState;
  route: string;
  viewport: Viewport;
  context: string;
  rendered: boolean;
  apiSuccesses: string[];
};
type FindingGroup = {
  kind: string;
  severity: Severity;
  componentPattern: string;
  detail: string;
  affected: Array<{ scenarioName: string; authState: AuthState; route: string; viewport: Viewport }>;
};
type ApiObservation = { path: string; status: number };
type ApiRequestObservation = { path: string; search: string; headers: Record<string, string> };
type ExpectedScenario = {
  mode: 'normal' | 'loading' | 'api-error' | 'offline' | 'modal' | 'insights-loading' | 'insights-error';
  heading: string;
  content?: string;
  apiPaths?: string[];
  apiFailures?: Array<{ path: string; status: number }>;
  insightErrors?: Array<{ id: string; message: string }>;
};
type Scenario = {
  name: string;
  path: string;
  finalPath?: string;
  auth: string | undefined;
  context: string;
  expected: ExpectedScenario;
  expandedAudit?: { entityType: 'expense' | 'settlement'; entityId: string; content: string };
};

const viewports: Viewport[] = [
  { width: 320, height: 844 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 895, height: 900 },
  { width: 896, height: 900 },
  { width: 1440, height: 900 },
];
const disclosureAuditWidths = new Set([320, 895, 896, 1440]);
const expandedManagementWidths = new Set([320, 895, 896, 1440]);
const insightViewports: Viewport[] = viewports;

const ids = {
  rich: '00000000-0000-4000-8000-000000003002',
  large: '00000000-0000-4000-8000-000000003003',
  dinner: '00000000-0000-4000-8000-000000004001',
  deletedExpense: '00000000-0000-4000-8000-000000004004',
  settlement: '00000000-0000-4000-8000-000000005001',
  deletedSettlement: '00000000-0000-4000-8000-000000005002',
  refund: '00000000-0000-4000-8000-000000008001',
  deletedRefund: '00000000-0000-4000-8000-000000008002',
  schedule: '00000000-0000-4000-8000-000000007001',
};

const apiPaths = {
  me: '/api/me',
  groups: '/api/groups',
  group: (id: string) => `/api/groups/${id}`,
  expenses: (id: string) => `/api/groups/${id}/expenses`,
  balances: (id: string) => `/api/groups/${id}/balances`,
  settlements: (id: string) => `/api/groups/${id}/settlements`,
  transactions: (id: string) => `/api/groups/${id}/transactions`,
  globalTransactions: '/api/transactions',
  scheduledExpenses: (id: string) => `/api/groups/${id}/scheduled-expenses`,
  categories: '/api/categories',
  invitations: (id: string) => `/api/groups/${id}/invitations`,
  expense: (id: string) => `/api/expenses/${id}`,
  settlement: (id: string) => `/api/settlements/${id}`,
  scheduledExpense: (id: string) => `/api/scheduled-expenses/${id}`,
  credit: (id: string) => `/api/credits/${id}`,
  auditEntity: (groupId: string, entityType: 'expense' | 'settlement', entityId: string) => `/api/groups/${groupId}/audit/${entityType}/${entityId}`,
  activity: (_id: string) => '/api/activity',
  spendingInsights: '/api/spending-insights',
};

function localInsightRange() {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  const date = (value: Date) => `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  return { trendFrom: date(new Date(now.getFullYear(), now.getMonth() - 5, 1)), trendTo: date(now) };
}

function localMonthKeys(trendFrom: string, count: number) {
  const [year, month] = trendFrom.slice(0, 7).split('-').map(Number);
  return Array.from({ length: count }, (_, index) => {
    const value = new Date(year, month - 1 + index, 1);
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}`;
  });
}

function localComparisonRange() {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  const date = (value: Date) => `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  const month = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const end = new Date(now.getFullYear(), now.getMonth() - 1, Math.min(now.getDate(), new Date(now.getFullYear(), now.getMonth(), 0).getDate()));
  return { from: date(month), to: date(end) };
}

const utcMonthLabel = (bucket: string) => new Intl.DateTimeFormat(undefined, { month: 'short', timeZone: 'UTC' }).format(new Date(`${bucket}-01T00:00:00Z`));

function populatedInsightFixture(scope: 'global' | 'group', emptySummary = false) {
  const { trendFrom, trendTo } = localInsightRange();
  const comparison = localComparisonRange();
  const months = localMonthKeys(trendFrom, 6);
  const values = [[0, 125000, 0, 0, 123456789, 0], [0, 0, 400000, 0, 0, 0], [0, 0, 0, 0, 2345678, 0], [0, 25000, 0, 0, 987654, 0]];
  const categoryTrends = emptySummary ? [] : values.flatMap((amounts, categoryIndex) => amounts.flatMap((amount, monthIndex) => amount ? [{ currency: 'USD', bucket: months[monthIndex], category: `Category ${String.fromCharCode(65 + categoryIndex)}`, groupSpendMinor: amount, allocatedSpendMinor: Math.round(amount / 2), expenseCount: 1 }] : []));
  const summary = { scope, summaries: emptySummary ? [] : [{ currency: 'USD', groupSpendMinor: 987654321, allocatedSpendMinor: 456789012, yourShareMinor: 456789012, youPaidMinor: 123456789, expenseCount: 12 }], ...(emptySummary ? {} : { previous: { from: comparison.from, to: comparison.to, summaries: [{ currency: 'EUR', groupSpendMinor: 700000000, allocatedSpendMinor: 350000000, yourShareMinor: 350000000, youPaidMinor: 100000000, expenseCount: 8 }] } }) };
  const trends = { scope, trendFrom, trendTo, categoryTrends };
  return { summary, trends };
}

function displayedFixtureTrend(fixture: ReturnType<typeof populatedInsightFixture>, primary: 'allocatedSpendMinor' | 'groupSpendMinor') {
  const categoryTotals = new Map<string, number>();
  for (const row of fixture.trends.categoryTrends) categoryTotals.set(row.category, (categoryTotals.get(row.category) || 0) + row[primary]);
  const categories = [...categoryTotals.entries()].sort((first, second) => second[1] - first[1] || first[0].localeCompare(second[0])).slice(0, 4).map(([category]) => category);
  const sourceMonths = localMonthKeys(fixture.trends.trendFrom, 6);
  const activeMonths = sourceMonths.filter((month) => fixture.trends.categoryTrends.some((row) => categories.includes(row.category) && row.bucket === month && row[primary] > 0));
  const displayedMonths = activeMonths.length ? sourceMonths.slice(sourceMonths.indexOf(activeMonths[0]), sourceMonths.indexOf(activeMonths.at(-1)!) + 1) : [];
  return { displayedMonths, categories };
}

const privateHomeApis = [apiPaths.me, apiPaths.groups, apiPaths.spendingInsights];
const groupApis = (id: string) => [apiPaths.me, apiPaths.group(id), apiPaths.transactions(id), apiPaths.balances(id), apiPaths.scheduledExpenses(id)];
const groupManagementApis = (id: string) => [apiPaths.me, apiPaths.group(id), apiPaths.invitations(id)];
const memberManagementApis = (id: string) => [apiPaths.me, apiPaths.group(id)];
const scenarios: Scenario[] = [
  { name: 'public-landing', path: '/', auth: undefined, context: 'PublicLanding / signed-out marketing shell', expected: { mode: 'normal', heading: 'Know who paid. Know what is still owed.', content: 'Private, even when offline' } },
  { name: 'populated-home', path: '/', auth: DEV_EMAIL, context: 'Home / populated groups fixture', expected: { mode: 'normal', heading: 'Friends & groups', content: 'Europe trip · USD + EUR', apiPaths: privateHomeApis } },
  { name: 'empty-home', path: '/', auth: EMPTY_EMAIL, context: 'Home / empty groups fixture', expected: { mode: 'normal', heading: 'Friends & groups', content: 'No groups yet', apiPaths: privateHomeApis } },
  { name: 'friend-creation', path: '/friends/new', auth: DEV_EMAIL, context: 'FriendCreation / dedicated friend form with consent guidance', expected: { mode: 'normal', heading: 'Add friend', content: 'Friend name', apiPaths: [apiPaths.me] } },
  { name: 'group-creation', path: '/groups/new', auth: DEV_EMAIL, context: 'GroupCreation / owner and participant form', expected: { mode: 'normal', heading: 'New group', content: 'Group name', apiPaths: [apiPaths.me] } },
  { name: 'rich-group', path: `/groups/${ids.rich}`, auth: DEV_EMAIL, context: 'GroupPage / rich multi-currency fixture', expected: { mode: 'normal', heading: 'Europe trip · USD + EUR', content: 'Scheduled expenses', apiPaths: groupApis(ids.rich) } },
  { name: 'group-management', path: `/groups/${ids.rich}/manage`, auth: DEV_EMAIL, context: 'GroupManagement / owner people, invitations, split-default, and named-group relationship controls', expected: { mode: 'normal', heading: 'Manage group', content: 'Relationship type', apiPaths: groupManagementApis(ids.rich) } },
  { name: 'member-management', path: `/groups/${ids.rich}/manage`, auth: REGISTERED_EMAIL, context: 'GroupManagement / member people and shared split-default controls', expected: { mode: 'normal', heading: 'Manage group', content: 'People', apiPaths: memberManagementApis(ids.rich) } },
  { name: 'global-add-chooser', path: '/add', auth: DEV_EMAIL, context: 'TransactionChooser / global add flow across cached groups', expected: { mode: 'normal', heading: 'Add transaction', content: 'Choose what happened', apiPaths: [apiPaths.me, apiPaths.groups] } },
  { name: 'group-add-chooser', path: `/groups/${ids.rich}/add`, auth: DEV_EMAIL, context: 'TransactionChooser / group-scoped add flow', expected: { mode: 'normal', heading: 'Add transaction', content: 'Europe trip · USD + EUR', apiPaths: [apiPaths.me, apiPaths.groups, apiPaths.group(ids.rich)] } },
  { name: 'transaction-history', path: `/groups/${ids.rich}/transactions`, finalPath: `/activity?group=${ids.rich}&view=transactions`, auth: DEV_EMAIL, context: 'Legacy transaction route / canonical History transactions tab fixture', expected: { mode: 'normal', heading: 'History', content: 'Search and filters', apiPaths: [apiPaths.me, apiPaths.groups, apiPaths.group(ids.rich), apiPaths.globalTransactions, apiPaths.categories] } },
  { name: 'large-group', path: `/groups/${ids.large}`, auth: DEV_EMAIL, context: 'Group overview / long-member-label fixture', expected: { mode: 'normal', heading: 'Very large group with a name that should remain contained at narrow widths', content: 'Recent transactions', apiPaths: groupApis(ids.large) } },
  { name: 'expense-form', path: `/groups/${ids.rich}/expense/new`, auth: DEV_EMAIL, context: 'ExpenseForm / new expense fixture', expected: { mode: 'normal', heading: 'Add expense', content: 'Split between', apiPaths: [apiPaths.me, apiPaths.group(ids.rich)] } },
  { name: 'expense-edit', path: `/groups/${ids.rich}/expense/${ids.dinner}`, auth: DEV_EMAIL, context: 'ExpenseForm / canonical expense edit fixture', expected: { mode: 'normal', heading: 'Edit expense', content: 'Dinner by the canal (edited)', apiPaths: [apiPaths.me, apiPaths.group(ids.rich), apiPaths.expense(ids.dinner), apiPaths.categories] } },
  { name: 'scheduled-expense-edit', path: `/groups/${ids.rich}/scheduled-expense/${ids.schedule}`, auth: DEV_EMAIL, context: 'ExpenseForm / canonical scheduled expense edit fixture', expected: { mode: 'normal', heading: 'Edit recurring expense', content: 'Monthly apartment rent', apiPaths: [apiPaths.me, apiPaths.group(ids.rich), apiPaths.scheduledExpense(ids.schedule)] } },
  { name: 'scheduled-expense-form', path: `/groups/${ids.rich}/expense/new?recurrence=1`, auth: DEV_EMAIL, context: 'Legacy recurring route / redirected new expense fixture', expected: { mode: 'normal', heading: 'Schedule an expense', content: 'Repeat this expense', apiPaths: [apiPaths.me, apiPaths.group(ids.rich)] } },
  { name: 'record-credit', path: `/groups/${ids.rich}/credit/new`, auth: DEV_EMAIL, context: 'RefundForm / credit route alias for recording money back', expected: { mode: 'normal', heading: 'Record money back', content: 'Apply this to', apiPaths: [apiPaths.me, apiPaths.group(ids.rich), apiPaths.expenses(ids.rich)] } },
  { name: 'expense-detail-history', path: `/groups/${ids.rich}/expenses/${ids.dinner}`, auth: DEV_EMAIL, context: 'ExpenseDetail / edited dinner with closed and expanded audit disclosure states', expected: { mode: 'normal', heading: 'Dinner by the canal (edited)', content: 'History', apiPaths: [apiPaths.me, apiPaths.expense(ids.dinner), apiPaths.group(ids.rich)] }, expandedAudit: { entityType: 'expense', entityId: ids.dinner, content: 'Updated expense' } },
  { name: 'refund-form', path: `/groups/${ids.rich}/refund/new`, auth: DEV_EMAIL, context: 'RefundForm / linked expense-first refund state and responsive money-flow controls', expected: { mode: 'normal', heading: 'Record money back', content: 'Apply this to', apiPaths: [apiPaths.me, apiPaths.group(ids.rich), apiPaths.expenses(ids.rich)] } },
  { name: 'refund-edit', path: `/groups/${ids.rich}/refund/${ids.refund}/edit`, auth: DEV_EMAIL, context: 'RefundForm / canonical dedicated refund edit fixture', expected: { mode: 'normal', heading: 'Edit refund or reimbursement', content: 'Apply this to', apiPaths: [apiPaths.me, apiPaths.group(ids.rich), apiPaths.credit(ids.refund), apiPaths.expenses(ids.rich)] } },
  { name: 'credit-edit-alias', path: `/groups/${ids.rich}/credit/${ids.refund}/edit`, auth: DEV_EMAIL, context: 'RefundForm / canonical credit edit alias fixture', expected: { mode: 'normal', heading: 'Edit refund or reimbursement', content: 'Apply this to', apiPaths: [apiPaths.me, apiPaths.group(ids.rich), apiPaths.credit(ids.refund), apiPaths.expenses(ids.rich)] } },
  { name: 'refund-detail', path: `/groups/${ids.rich}/credits/${ids.refund}`, auth: DEV_EMAIL, context: 'CreditDetail / active dedicated refund detail fixture', expected: { mode: 'normal', heading: 'A group member received the money', content: 'Linked expenses', apiPaths: [apiPaths.me, apiPaths.credit(ids.refund), apiPaths.group(ids.rich)] } },
  { name: 'refund-detail-deleted', path: `/groups/${ids.rich}/credits/${ids.deletedRefund}`, auth: DEV_EMAIL, context: 'CreditDetail / deleted refund tombstone and restore control', expected: { mode: 'normal', heading: 'A group member received the money', content: 'Deleted refund/reimbursement', apiPaths: [apiPaths.me, apiPaths.credit(ids.deletedRefund), apiPaths.group(ids.rich)] } },
  { name: 'settlement-detail-history', path: `/groups/${ids.rich}/settlements/${ids.settlement}`, auth: DEV_EMAIL, context: 'SettlementDetail / edited payment with closed and expanded audit disclosure states', expected: { mode: 'normal', heading: 'paid', content: 'View audit history', apiPaths: [apiPaths.me, apiPaths.settlement(ids.settlement), apiPaths.group(ids.rich), apiPaths.balances(ids.rich)] }, expandedAudit: { entityType: 'settlement', entityId: ids.settlement, content: 'Updated settlement' } },
  { name: 'expense-detail-deleted', path: `/groups/${ids.rich}/expenses/${ids.deletedExpense}`, auth: DEV_EMAIL, context: 'ExpenseDetail / deleted expense tombstone and restore control', expected: { mode: 'normal', heading: 'Deleted museum tickets', content: 'Deleted expense', apiPaths: [apiPaths.me, apiPaths.expense(ids.deletedExpense), apiPaths.group(ids.rich)] } },
  { name: 'settlement-detail-deleted', path: `/groups/${ids.rich}/settlements/${ids.deletedSettlement}`, auth: DEV_EMAIL, context: 'SettlementDetail / deleted settlement tombstone and restore control', expected: { mode: 'normal', heading: 'paid', content: 'Deleted settlement', apiPaths: [apiPaths.me, apiPaths.settlement(ids.deletedSettlement), apiPaths.group(ids.rich), apiPaths.balances(ids.rich)] } },
  { name: 'settlement', path: `/groups/${ids.rich}/settle`, auth: DEV_EMAIL, context: 'Settle / multi-currency balance fixture', expected: { mode: 'normal', heading: 'Settle up', content: 'Record a payment', apiPaths: [apiPaths.me, apiPaths.group(ids.rich), apiPaths.balances(ids.rich)] } },
  { name: 'activity', path: `/activity?group=${ids.rich}`, auth: DEV_EMAIL, context: 'History changes / filtered expense and settlement history fixture', expected: { mode: 'normal', heading: 'History', content: 'Dinner by the canal', apiPaths: [apiPaths.me, apiPaths.groups, apiPaths.activity(ids.rich)] } },
  { name: 'all-groups-transactions', path: '/activity?view=transactions', auth: DEV_EMAIL, context: 'History transactions / all authorized groups fixture', expected: { mode: 'normal', heading: 'History', content: 'Search and filters', apiPaths: [apiPaths.me, apiPaths.groups, apiPaths.globalTransactions, apiPaths.categories] } },
  { name: 'group-insights', path: `/activity?group=${ids.rich}&view=insights&period=month`, auth: DEV_EMAIL, context: 'History insights / group selected-period summary and comparison fixture', expected: { mode: 'normal', heading: 'History', content: 'Spending insights', apiPaths: [apiPaths.me, apiPaths.groups, apiPaths.spendingInsights] } },
  { name: 'global-insights', path: '/activity?view=insights&period=month', auth: DEV_EMAIL, context: 'History insights / global selected-period summary and comparison fixture', expected: { mode: 'normal', heading: 'History', content: 'Spending insights', apiPaths: [apiPaths.me, apiPaths.groups, apiPaths.spendingInsights] } },
  { name: 'empty-global-insights', path: '/activity?view=insights&period=all', auth: EMPTY_EMAIL, context: 'History insights / empty aggregate state', expected: { mode: 'normal', heading: 'History', content: 'No counted expenses in this period', apiPaths: [apiPaths.me, apiPaths.groups, apiPaths.spendingInsights] } },
  { name: 'custom-insights', path: '/activity?view=insights&period=custom', auth: DEV_EMAIL, context: 'History insights / custom range disclosure before two dates are supplied', expected: { mode: 'normal', heading: 'History', content: 'Choose two valid dates', apiPaths: [apiPaths.me, apiPaths.groups, apiPaths.spendingInsights] } },
  { name: 'invalid-custom-insights', path: '/activity?view=insights&period=custom&from=2026-02-30&to=2026-01-01', auth: DEV_EMAIL, context: 'History insights / invalid custom date validation and field error relationships', expected: { mode: 'normal', heading: 'History', content: 'Choose two valid dates', apiPaths: [apiPaths.me, apiPaths.groups, apiPaths.spendingInsights] } },
  { name: 'settings', path: '/settings', auth: DEV_EMAIL, context: 'Settings / Profile rename and trusted-device controls', expected: { mode: 'normal', heading: 'Settings', content: 'Renaming is available while online.', apiPaths: [apiPaths.me] } },
];

const authState = (auth: string | undefined): AuthState => auth ? `authenticated:${auth}` : 'public';
const isTouchViewport = (viewport: Viewport) => viewport.width < 896;
type AuditArtifactKind = 'normal' | 'intercepted';
const auditArtifactDirectory = (kind: AuditArtifactKind) => path.join(process.cwd(), 'test-results', 'audit', kind);

async function auditGeometry(page: Page, scenario: Scenario, route: string, viewport: Viewport): Promise<Finding[]> {
  const state: AuthState = authState(scenario.auth);
  return page.evaluate(({ scenarioName, authState, route, viewport, context, touchViewport }) => {
    type Finding = { kind: string; severity: 'critical' | 'major' | 'minor' | 'info'; scenarioName: string; authState: AuthState; route: string; viewport: typeof viewport; context: string; selector?: string; detail: string; actual?: number };
    type AuthState = 'public' | `authenticated:${string}`;
    const findings: Finding[] = [];
    const seen = new Set<string>();
    const add = (kind: string, severity: Finding['severity'], detail: string, selector?: string, actual?: number) => {
      const key = [scenarioName, authState, route, viewport.width, viewport.height, kind, selector || '', detail, actual ?? ''].join('|');
      if (seen.has(key)) return;
      seen.add(key);
      findings.push({ kind, severity, scenarioName, authState, route, viewport, context, selector, detail, actual });
    };
    const visible = (element: Element) => {
      if (element.classList.contains('sr-only')) return false;
      // A closed <details> keeps its summary interactive while its other
      // descendants can retain layout-like bounds in Chromium. Treat only the
      // direct summary subtree as visible; this prevents hidden schedule
      // actions from being compared with the next visible group section.
      for (let current: Element | null = element; current; current = current.parentElement) {
        if (current.classList.contains('sr-only')) return false;
        const ancestorStyle = getComputedStyle(current);
        if (ancestorStyle.display === 'none' || ancestorStyle.visibility === 'hidden' || Number(ancestorStyle.opacity) === 0) return false;
        if (current instanceof HTMLDetailsElement && !current.open) {
          const summary = Array.from(current.children).find((child) => child.tagName.toLowerCase() === 'summary');
          if (!summary || !summary.contains(element)) return false;
        }
      }
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && box.width > 0 && box.height > 0;
    };
    const boxOf = (element: Element) => {
      const value = element.getBoundingClientRect();
      return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height };
    };
    const selector = (element: Element) => {
      const id = element.id ? `#${element.id}` : '';
      const classes = typeof element.className === 'string' ? element.className.trim().split(/\s+/).filter(Boolean).slice(0, 3).map((name) => `.${name}`).join('') : '';
      const text = (element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 48);
      return `${element.tagName.toLowerCase()}${id}${classes}${text ? `[text="${text.replaceAll('"', '\\"')}"]` : ''}`;
    };
    const contentWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
    // Geometry is measured from the top of the document. Sticky shell
    // controls must not be compared with content left underneath them after a
    // preceding interaction or a full-page screenshot.
    window.scrollTo(0, 0);
    if (contentWidth > viewport.width + 1) add('horizontal-overflow', 'major', `Document scroll width ${contentWidth}px exceeds viewport width ${viewport.width}px`, 'html/body', contentWidth - viewport.width);
    const internalOverflowDescendant = (element: Element) => {
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (parent.matches('.insight-currency-tabs,.category-trend-bars')) return true;
      }
      return false;
    };
    for (const element of Array.from(document.querySelectorAll('body *')).filter(visible)) {
      if (internalOverflowDescendant(element)) continue;
      const box = boxOf(element);
      if (box.left < -1 || box.right > viewport.width + 1) add('horizontal-overflow-element', 'major', `Visible bounds are ${Math.round(box.left)}..${Math.round(box.right)}px`, selector(element), Math.max(-box.left, box.right - viewport.width));
    }

    const modal = document.querySelector('.modal-sheet');
    const modalIsVisible = Boolean(modal && visible(modal));
    const auditTarget = (element: Element) => visible(element) && !element.matches('.skip-link') && !element.closest('.shell-header,.shell-nav') && !(modalIsVisible && !modal?.contains(element));
    if (touchViewport) {
      const tapTargets = Array.from(document.querySelectorAll('a,button,input,select,textarea,summary,[role="button"]')).filter(auditTarget).filter((element) => {
        // The native checkbox/radio is intentionally smaller than its label.
        // Audit the label's hit area instead of reporting the visual input.
        if (!element.matches('input[type="checkbox"],input[type="radio"]')) return true;
        const label = element.closest('label');
        return !label || boxOf(label).width < 44 || boxOf(label).height < 44;
      });
      for (const label of Array.from(document.querySelectorAll('label:has(> input[type="checkbox"]),label:has(> input[type="radio"])')).filter(auditTarget)) {
        const box = boxOf(label);
        if (box.width < 44 || box.height < 44) add('project-touch-target-policy', 'minor', `Project touch-target policy: checkbox/radio label is ${Math.round(box.width)}×${Math.round(box.height)}px; project minimum is 44×44px`, selector(label), Math.min(box.width, box.height));
      }
      for (const element of tapTargets) {
        const box = boxOf(element);
        if (box.width < 44 || box.height < 44) add('project-touch-target-policy', 'minor', `Project touch-target policy: interactive target is ${Math.round(box.width)}×${Math.round(box.height)}px; project minimum is 44×44px`, selector(element), Math.min(box.width, box.height));
      }
      for (let firstIndex = 0; firstIndex < tapTargets.length; firstIndex += 1) {
        for (let secondIndex = firstIndex + 1; secondIndex < tapTargets.length; secondIndex += 1) {
          const first = tapTargets[firstIndex];
          const second = tapTargets[secondIndex];
          if (first.contains(second) || second.contains(first)) continue;
          if (first.closest('.bottom-nav') || second.closest('.bottom-nav')) continue;
          const a = boxOf(first); const b = boxOf(second);
          const overlapWidth = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const overlapHeight = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (overlapWidth > 1 && overlapHeight > 1) add('interactive-overlap', 'major', `Interactive bounds overlap by ${Math.round(overlapWidth)}×${Math.round(overlapHeight)}px`, `${selector(first)} / ${selector(second)}`);
        }
      }
      for (const element of Array.from(document.querySelectorAll('input,select,textarea')).filter(auditTarget)) {
        const fontSize = Number.parseFloat(getComputedStyle(element).fontSize);
        if (fontSize < 16) add('mobile-input-font-size', 'major', `Mobile form control uses ${fontSize}px text; expected at least 16px to avoid viewport zoom`, selector(element), fontSize);
      }
    }

    // Touch widths use the same check above; keep the desktop assertion here
    // so overlap remains a generic invariant instead of a mobile-only rule.
    if (!touchViewport) {
      const desktopTargets = Array.from(document.querySelectorAll('a,button,select,[role="button"],summary')).filter(auditTarget);
      for (let firstIndex = 0; firstIndex < desktopTargets.length; firstIndex += 1) {
        for (let secondIndex = firstIndex + 1; secondIndex < desktopTargets.length; secondIndex += 1) {
          const first = desktopTargets[firstIndex];
          const second = desktopTargets[secondIndex];
          if (first.contains(second) || second.contains(first)) continue;
          if (first.closest('.bottom-nav,.desktop-nav') || second.closest('.bottom-nav,.desktop-nav')) continue;
          const a = boxOf(first); const b = boxOf(second);
          const overlapWidth = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const overlapHeight = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (overlapWidth > 1 && overlapHeight > 1) add('interactive-overlap', 'major', `Interactive bounds overlap by ${Math.round(overlapWidth)}×${Math.round(overlapHeight)}px`, `${selector(first)} / ${selector(second)}`);
        }
      }
    }

    const desktop = document.querySelector('.desktop-nav');
    const bottom = document.querySelector('.bottom-nav');
    const desktopVisible = desktop ? getComputedStyle(desktop).display !== 'none' : false;
    const bottomVisible = bottom ? getComputedStyle(bottom).display !== 'none' : false;
    const desktopExpected = viewport.width >= 896;
    if (desktop && desktopVisible !== desktopExpected) add('breakpoint-nav', 'major', `Desktop navigation is ${desktopVisible ? 'visible' : 'hidden'} at ${viewport.width}px; expected ${desktopExpected ? 'visible' : 'hidden'}`, '.desktop-nav');
    if (bottom && bottomVisible === desktopExpected) add('breakpoint-nav', 'major', `Bottom navigation is ${bottomVisible ? 'visible' : 'hidden'} at ${viewport.width}px; expected ${desktopExpected ? 'hidden' : 'visible'}`, '.bottom-nav');
    const numeric = (value: string) => Number.parseFloat(value) || 0;
    const lengthInPixels = (value: string, element: Element) => {
      if (value.trim().endsWith('rem')) return numeric(value) * numeric(getComputedStyle(document.documentElement).fontSize || '16');
      if (value.trim().endsWith('em')) return numeric(value) * numeric(getComputedStyle(element).fontSize || '16');
      return numeric(value);
    };

    const checkBottomNavClearance = () => {
      if (!bottom || !bottomVisible || modalIsVisible) return;
      const navBox = boxOf(bottom);
      const main = document.querySelector('main.app-main');
      if (!main) return;

      const rootStyle = getComputedStyle(document.documentElement);
      const mainStyle = getComputedStyle(main);
      const safeArea = lengthInPixels(rootStyle.getPropertyValue('--safe-bottom'), document.documentElement);
      const intendedGap = lengthInPixels(mainStyle.getPropertyValue('--space-2'), main) || 8;
      const paddingBottom = numeric(mainStyle.paddingBottom);
      const requiredPadding = navBox.height + intendedGap + safeArea;
      if (paddingBottom + 0.5 < requiredPadding) {
        add('bottom-nav-clearance', 'major', `Computed .app-main bottom padding is ${paddingBottom.toFixed(2)}px; fixed bottom navigation is ${navBox.height.toFixed(2)}px high and requires at least ${requiredPadding.toFixed(2)}px including the ${intendedGap.toFixed(2)}px intended gap and ${safeArea.toFixed(2)}px safe-area approximation`, '.app-main', requiredPadding - paddingBottom);
      }

      window.scrollTo(0, document.documentElement.scrollHeight);
      const content = Array.from(main.querySelectorAll('h1,h2,h3,h4,p,a,button,input,select,textarea,fieldset,form,li,.ui-card-surface,.ui-ledger-list,.ui-ledger-row,.ui-empty-state,.error,.offline-banner,.ui-action-group,.form-row,.field,.ui-section-header,.ui-page-header'))
        .filter((element) => visible(element) && !element.closest('.bottom-nav,.modal-backdrop'));
      const finalContent = content.reduce<Element | undefined>((last, element) => {
        if (!last) return element;
        return boxOf(element).bottom > boxOf(last).bottom ? element : last;
      }, undefined);
      if (finalContent) {
        const finalBox = boxOf(finalContent);
        if (finalBox.bottom > navBox.top - intendedGap + 0.5) {
          add('bottom-nav-clearance', 'major', `At scroll bottom, final meaningful main content ends at ${finalBox.bottom.toFixed(2)}px while fixed bottom navigation starts at ${navBox.top.toFixed(2)}px; expected at least ${intendedGap.toFixed(2)}px clearance`, selector(finalContent), finalBox.bottom - (navBox.top - intendedGap));
        }
      }
      window.scrollTo(0, 0);
    };
    if (bottom && bottomVisible) {
      if (getComputedStyle(bottom).position !== 'fixed') add('bottom-nav-position', 'major', 'Bottom navigation is visible but is not fixed to the viewport', '.bottom-nav');
      checkBottomNavClearance();
    }

    if (modal && modalIsVisible) {
      const box = boxOf(modal);
      if (box.left < 0 || box.right > viewport.width || box.top < 0 || box.bottom > viewport.height) add('modal-bounds', 'major', `Modal bounds are ${Math.round(box.left)},${Math.round(box.top)}..${Math.round(box.right)},${Math.round(box.bottom)}px outside ${viewport.width}×${viewport.height}px`, '.modal-sheet');
    }

    for (const element of Array.from(document.querySelectorAll('.card__name,.email,.participant-row__label,.activity-description,.back__label,h1,h2,h3,.notes,.category,.chip')).filter(visible)) {
      const box = boxOf(element);
      if (element.scrollWidth > element.clientWidth + 1 || box.left < -1 || box.right > viewport.width + 1) add('long-text-containment', 'major', `Long text overflows its box (${element.scrollWidth}px content in ${element.clientWidth}px) or viewport bounds`, selector(element));
    }

    const surfaceRootSelector = '.ui-surface,.ui-card-surface,.ui-form-surface,.ui-empty-state,.error,.offline-banner,.schedule-preview,.recurrence-toggle,.summary-row,.participant-row,.method-row,.member-row,.insight-summary-card,.insight-category-trends,.compact-balances,.group-overview-card,.route-loading__card,.app-error-boundary__card,.ledger-preview,.modal-sheet,[role="dialog"],.route-view--group-management > section,.route-view--group-management > #settings > section,.route-view--settings > section';
    for (const element of Array.from(document.querySelectorAll(surfaceRootSelector)).filter(visible)) {
      const style = getComputedStyle(element);
      const padding = Math.min(parseFloat(style.paddingTop), parseFloat(style.paddingRight), parseFloat(style.paddingBottom), parseFloat(style.paddingLeft));
      if (padding < 12) add('surface-padding', 'minor', `Flow surface internal padding is ${padding}px; expected at least 12px`, selector(element), padding);
    }

    const flatRouteContainerSelector = '.insights-page,.insight-section,.history-panel,.route-view--group-overview > section:not(.compact-balances)';
    const surfaceCandidate = (element: Element) => element.matches(surfaceRootSelector) || element.matches(flatRouteContainerSelector);
    const hasPaint = (element: Element) => {
      const style = getComputedStyle(element);
      const borderSides = ['Top', 'Right', 'Bottom', 'Left'] as const;
      const hasBorder = borderSides.some((side) => Number.parseFloat(style[`border${side}Width` as 'borderTopWidth']) > 0 && style[`border${side}Style` as 'borderTopStyle'] !== 'none');
      const radii = ['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft'] as const;
      const hasRadius = radii.some((corner) => Number.parseFloat(style[`border${corner}Radius` as 'borderTopLeftRadius']) > 0);
      const hasBackground = style.backgroundColor !== 'transparent' && style.backgroundColor !== 'rgba(0, 0, 0, 0)';
      return hasBorder || hasRadius || hasBackground || style.boxShadow !== 'none';
    };
    for (const element of Array.from(document.querySelectorAll(flatRouteContainerSelector)).filter(visible)) {
      if (hasPaint(element)) add('flat-route-container-paint', 'major', 'Semantic route container regained a background, border, radius, or shadow; keep the outer flow flat and paint only its intentional child modules', selector(element));
    }
    const paintedSurface = (element: Element) => surfaceCandidate(element) && hasPaint(element);
    const cardSurfaceDepth = (root: Element) => {
      const dialogRoot = root.closest('.modal-sheet,[role="dialog"]');
      let depth = 0;
      for (let current: Element | null = root; current && current !== document.body; current = current.parentElement) {
        if (paintedSurface(current)) depth += 1;
        if (current === dialogRoot) break;
      }
      return depth;
    };
    for (const root of Array.from(document.querySelectorAll(surfaceRootSelector)).filter((element) => visible(element) && !element.matches('.modal-backdrop'))) {
      const depth = cardSurfaceDepth(root);
      if (depth > 2) add('card-surface-hierarchy-depth', 'major', `Visible painted card/surface ancestor depth is ${depth}; project maximum is two`, selector(root), depth);
    }

    for (const list of Array.from(document.querySelectorAll('.ui-ledger-list')).filter(visible)) {
      if (list.tagName === 'UL' && Array.from(list.children).some((child) => child.tagName !== 'LI')) add('semantic-list-structure', 'major', 'A semantic ledger list contains a non-LI direct child', selector(list));
      if (list.querySelector('[tabindex]:not([tabindex="-1"])')) add('semantic-focus-order', 'minor', 'A ledger collection contains a positive or unmanaged tabindex; preserve native focus order', selector(list));
    }

    // Only regions that opt into this audit are compared. A broad button
    // heuristic mistakes unrelated management actions (for example removing a
    // person) for the page's primary task (for example saving settings).
    const primaryRegions = Array.from(document.querySelectorAll('[data-flow-region="frequent"]')).filter(auditTarget);
    const adminRegions = Array.from(document.querySelectorAll('[data-flow-region="admin"]')).filter(auditTarget);
    for (const primaryRegion of primaryRegions) {
      const primaryAction = primaryRegion.querySelector('[data-primary-action="true"],button[type="submit"],a.button:not(.button--secondary):not(.button--danger)');
      if (!primaryAction || !visible(primaryAction)) add('missing-primary-action', 'major', 'A frequent-action region is marked for ordering but contains no visible primary action', selector(primaryRegion));
    }
    for (const primary of primaryRegions) {
      for (const admin of adminRegions) {
        if (primary === admin || primary.contains(admin) || admin.contains(primary)) continue;
        if (primary.compareDocumentPosition(admin) & Node.DOCUMENT_POSITION_FOLLOWING) continue;
        add('primary-before-admin', 'major', 'An administrative region appears before an independent frequent-action region', `${selector(admin)} → ${selector(primary)}`);
        break;
      }
    }

    const flowSurface = (element: Element) => element.matches('.ui-form-surface,.ui-card-surface,.ui-surface,section,.ui-empty-state,.offline-banner,.error,.ui-ledger-list,.secondary-fields,.landing-note,.landing-proof > div');
    const meaningfulFlowContent = (element: Element) => flowSurface(element) || element.matches('h1,h2,h3,h4,p,form,fieldset,ul,ol,dl,table,article,header,aside,nav,.ui-page-header,.ui-section-header,.ui-action-group,.form-row,.field,.notes,.category,.title,.cluster,.notice,[class*="title"],[class*="cluster"],[class*="notice"]');
    const flowContainer = (element: Element) => meaningfulFlowContent(element) || element.matches('div') && Array.from(element.children).some((child) => child.matches('h1,h2,h3,h4,.ui-ledger-list,.ui-action-group,form,fieldset,.error,.offline-banner,.ui-empty-state,[class*="title"],[class*="cluster"]'));
    const hasBorder = (style: CSSStyleDeclaration, side: 'top' | 'bottom') => ['solid', 'dashed', 'dotted', 'double'].includes(side === 'top' ? style.borderTopStyle : style.borderBottomStyle);
    const intentionallyConnected = (element: Element, next: Element, parent: Element) => {
      if (!parent || parent !== next.parentElement) return false;
      if (element.matches('.ui-ledger-row,.participant-row,.allocation-row,.payer-row') && next.matches('.ui-ledger-row,.participant-row,.allocation-row,.payer-row')) return true;
      if (parent.matches('.ui-ledger-list,.participant-list,.allocation-list,.payer-list,.bottom-nav,.desktop-nav,[role="group"]')) return true;
      if (parent.matches('.ui-section-header,.ui-page-header,.top-bar__actions,.home-actions,.landing-actions,.ui-action-group,.form-row,.field,.chips')) return true;
      return false;
    };
    const boundaryNode = (element: Element, direction: 'first' | 'last') => {
      if (meaningfulFlowContent(element)) return element;
      const descendants = Array.from(element.querySelectorAll('*')).filter((descendant) => visible(descendant) && meaningfulFlowContent(descendant));
      return descendants.reduce<Element | undefined>((current, descendant) => {
        if (!current) return descendant;
        const currentBox = boxOf(current);
        const descendantBox = boxOf(descendant);
        return direction === 'first' ? descendantBox.top < currentBox.top ? descendant : current : descendantBox.bottom > currentBox.bottom ? descendant : current;
      }, undefined);
    };
    const boundaryGap = (element: Element, next: Element, parent: Element) => {
      if (!visible(element) || !visible(next) || !flowContainer(element) || !flowContainer(next) || intentionallyConnected(element, next, parent)) return;
      const boundaryElement = boundaryNode(element, 'last');
      const boundaryNext = boundaryNode(next, 'first');
      if (!boundaryElement || !boundaryNext) return;
      const elementStyle = getComputedStyle(boundaryElement);
      const nextStyle = getComputedStyle(boundaryNext);
      const elementBox = boxOf(boundaryElement);
      const nextBox = boxOf(boundaryNext);
      if (nextBox.top < elementBox.bottom - 1) return;
      const borderBoxGap = nextBox.top - elementBox.bottom;
      const hasBoundaryBorder = hasBorder(elementStyle, 'bottom') || hasBorder(nextStyle, 'top');
      if (borderBoxGap >= (hasBoundaryBorder ? 12 : 1)) return;
      const elementContentBottom = elementBox.bottom - numeric(elementStyle.borderBottomWidth) - numeric(elementStyle.paddingBottom);
      const nextContentTop = nextBox.top + numeric(nextStyle.borderTopWidth) + numeric(nextStyle.paddingTop);
      const contentBoxGap = nextContentTop - elementContentBottom;
      const kind = hasBoundaryBorder ? 'bordered-sibling-gap' : 'flow-boundary-gap';
      const label = hasBoundaryBorder ? 'Bordered flow transition' : 'Nested flow transition';
      const threshold = hasBoundaryBorder ? 12 : 1;
      add(kind, 'major', `${label} from ${elementBox.bottom.toFixed(2)}px to ${nextBox.top.toFixed(2)}px: border-box gap ${borderBoxGap.toFixed(2)}px (<${threshold}px); content-box gap ${contentBoxGap.toFixed(2)}px`, `${selector(boundaryElement)} → ${selector(boundaryNext)}`, borderBoxGap);
    };
    for (const parent of [document.body, ...Array.from(document.querySelectorAll('body *'))]) {
      const children = Array.from(parent.children);
      for (let index = 0; index < children.length - 1; index += 1) boundaryGap(children[index], children[index + 1], parent);
    }
    window.scrollTo(0, 0);
    return findings;
  }, { scenarioName: scenario.name, authState: state, route, viewport, context: scenario.context, touchViewport: isTouchViewport(viewport) });
}

function routeFrom(page: Page) {
  const url = new URL(page.url());
  return `${url.pathname}${url.search}${url.hash}`;
}

async function visibleCount(page: Page, selector: string) {
  return page.locator(selector).evaluateAll((elements) => elements.filter((element) => {
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
  }).length);
}

const routeReadySelectors: Record<string, string> = {
  'populated-home': '.cards',
  'empty-home': '.ui-empty-state',
  'friend-creation': '#friend-name',
  'group-creation': '#group-name',
  'rich-group': '.group-overview-card--transactions .transaction-row--overview',
  'large-group': '.group-overview-card--transactions .transaction-row--overview',
  'group-management': '.management-sections',
  'member-management': '.management-sections',
  'global-add-chooser': '.chooser-groups > section',
  'group-add-chooser': '.chooser-options',
  'transaction-history': '.transaction-list .transaction-row',
  'activity': '.activity-list > li',
  'all-groups-transactions': '.transaction-list .transaction-row',
  'group-insights': '.insights-page',
  'global-insights': '.insights-page',
  'empty-global-insights': '.insights-page',
  'custom-insights': '.insights-page',
  'invalid-custom-insights': '.insights-page',
  'settings': '.settings-section',
  'expense-form': '.expense-form',
  'expense-edit': '.expense-form',
  'scheduled-expense-edit': '.expense-form',
  'scheduled-expense-form': '.expense-form',
  'record-credit': '.refund-form',
  'refund-form': '.refund-form',
  'refund-edit': '.refund-form',
  'credit-edit-alias': '.refund-form',
  'expense-detail-history': '.expense-detail-surface',
  'expense-detail-deleted': '.expense-detail-tombstone',
  'refund-detail': '.credit-detail-surface',
  'refund-detail-deleted': '.credit-detail-tombstone',
  'settlement-detail-history': '.settlement-detail-surface',
  'settlement-detail-deleted': '.settlement-detail-tombstone',
  'settlement': '.settlement-form-surface',
};

async function waitForScenarioReady(page: Page, scenario: Scenario) {
  if (!scenario.auth) {
    await expect(page.locator('.public-main')).toBeVisible();
    if (scenario.expected.content) await expect(page.locator('.public-main')).toContainText(scenario.expected.content);
    return;
  }
  if (scenario.expected.mode === 'loading' || scenario.expected.mode === 'insights-loading') {
    await expect(page.getByRole('status').filter({ hasText: 'Loading' }).first()).toBeVisible();
    return;
  }
  const selector = routeReadySelectors[scenario.name];
  if (selector) await expect(page.locator(selector).first()).toBeVisible({ timeout: 15_000 });
  else if (scenario.expected.content) await expect(page.locator('main')).toContainText(scenario.expected.content, { timeout: 15_000 });
  else await expect(page.locator('main')).toBeVisible({ timeout: 15_000 });
  if (scenario.expected.content) await expect(page.locator('main')).toContainText(scenario.expected.content, { timeout: 15_000 });
}

async function assertRendered(page: Page, scenario: Scenario, observations: ApiObservation[], viewport: Viewport) {
  const expected = scenario.expected;
  const finalUrl = new URL(page.url());
  const expectedOrigin = new URL(BASE_URL).origin;
  if (finalUrl.origin !== expectedOrigin) throw new Error(`Final URL origin is ${finalUrl.origin}; expected ${expectedOrigin}`);
  const expectedPath = scenario.finalPath || scenario.path;
  if (routeFrom(page) !== expectedPath) throw new Error(`Final URL is ${routeFrom(page)}; expected ${expectedPath}`);
  if (!scenario.auth && expected.mode === 'normal') {
    if (await visibleCount(page, '.public-shell') !== 1 || await visibleCount(page, '.app-shell') !== 0) throw new Error('Public scenario did not render the signed-out landing shell');
    if (await page.getByRole('heading', { level: 1, name: expected.heading, exact: false }).count() === 0) throw new Error(`Expected public heading was not rendered: ${expected.heading}`);
    if (expected.content && !(await page.locator('body').innerText()).includes(expected.content)) throw new Error(`Expected public content was not rendered: ${expected.content}`);
    if (await visibleCount(page, '.app-error-boundary') !== 0 || await visibleCount(page, '.auth-banner') !== 0) throw new Error('Public scenario rendered an unexpected auth/error fallback');
    return;
  }
  if (expected.mode === 'loading') {
    if (await visibleCount(page, '.auth-loading-shell') !== 1 || await visibleCount(page, '.app-shell') !== 1 || await visibleCount(page, '.public-shell') !== 0) throw new Error('Loading fixture did not render the private-shaped auth loading shell');
    if (await visibleCount(page, '[role="status"]') === 0 || !(await page.locator('body').innerText()).includes('Loading')) throw new Error('Loading fixture did not render Loading status');
    return;
  }

  if (expected.mode === 'normal' || expected.mode === 'api-error' || expected.mode === 'offline' || expected.mode === 'modal' || expected.mode === 'insights-loading' || expected.mode === 'insights-error') {
    if (await visibleCount(page, '.app-shell') !== 1 || await visibleCount(page, '.public-shell') !== 0) throw new Error('Scenario did not render the authenticated private shell');
    if (await page.getByRole('heading', { level: 1, name: expected.heading, exact: false }).count() === 0) throw new Error(`Expected heading was not rendered: ${expected.heading}`);
    if (expected.content && !(await page.locator('body').innerText()).includes(expected.content)) throw new Error(`Expected fixture content was not rendered: ${expected.content}`);
    if (await visibleCount(page, '.app-error-boundary') !== 0) throw new Error('Scenario rendered the application error fallback');
    const flatRouteContainers = scenario.path.startsWith('/activity')
      ? page.locator('.history-panel,.insights-page,.insight-section')
      : scenario.name === 'rich-group' || scenario.name === 'large-group'
        ? page.locator('.route-view--group-overview > section:not(.compact-balances)')
        : undefined;
    if (flatRouteContainers) {
      const painted = await flatRouteContainers.evaluateAll((elements) => elements.filter((element) => {
        const style = getComputedStyle(element);
        const borders = [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth];
        const radii = [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius];
        return borders.some((border) => border !== '0px') || radii.some((radius) => radius !== '0px') || (style.backgroundColor !== 'transparent' && style.backgroundColor !== 'rgba(0, 0, 0, 0)') || style.boxShadow !== 'none';
      }).map((element) => `${element.tagName.toLowerCase()}.${typeof element.className === 'string' ? element.className : ''}`));
      if (painted.length) throw new Error(`Flat route containers retained painted surfaces: ${painted.join(', ')}`);
    }
    const semanticCollectionSelector = scenario.name === 'rich-group' || scenario.name === 'large-group'
      ? '.balance-cards'
      : scenario.path.includes('view=transactions') || scenario.name === 'transaction-history' || scenario.name === 'all-groups-transactions'
        ? '.transaction-list'
        : scenario.path.includes('view=changes') || scenario.name === 'activity'
          ? '.activity-list'
          : undefined;
    if (semanticCollectionSelector) {
      const invalidCollections = await page.locator(semanticCollectionSelector).evaluateAll((elements) => elements.filter((element) => element.tagName !== 'UL' || Array.from(element.children).some((child) => child.tagName !== 'LI')).map((element) => element.className));
      if (invalidCollections.length) throw new Error(`Flattened collection lost native list semantics: ${invalidCollections.join(', ')}`);
    }
    if (expected.content === 'Spending insights' && expected.mode === 'normal') {
      const body = await page.locator('body').innerText();
      const populatedInsight = scenario.name === 'global-insights' || scenario.name === 'group-insights';
      if (body.includes('What stands out')) throw new Error('Detailed insights still render generated prose');
      if (scenario.name === 'global-insights' && !body.includes('your allocated share')) throw new Error('Global insight scope wording is missing');
      if (scenario.name === 'group-insights' && !body.includes('total group spending')) throw new Error('Group insight scope wording is missing');
      const comparison = localComparisonRange();
      if ((scenario.name === 'global-insights' || scenario.name === 'group-insights') && !body.includes(`Compared with ${comparison.from} to ${comparison.to}`)) throw new Error('Selected-period summary did not show exact comparison dates');
      if (populatedInsight) {
        if (!body.includes('USD') || !body.includes('EUR')) throw new Error('Insight currency tabs did not render all available currencies');
        const trendGraph = page.locator('.category-trend-figure');
        await expect(trendGraph).toHaveCount(1);
        const trendPlot = trendGraph.locator('.category-trend-bars');
        const fixture = populatedInsightFixture(scenario.name === 'group-insights' ? 'group' : 'global');
        const primary = scenario.name === 'group-insights' ? 'groupSpendMinor' : 'allocatedSpendMinor';
        const { displayedMonths, categories } = displayedFixtureTrend(fixture, primary);
        const categoryCount = categories.length;
        const actualCurrentMonth = fixture.trends.trendTo.slice(0, 7);
        const expectedReferenceLabel = utcMonthLabel(displayedMonths.at(-1)!);
        const expectedHeaders = ['Category', ...displayedMonths.map((month) => `${utcMonthLabel(month)}${month === actualCurrentMonth ? ' MTD' : ''}`)];
        const expectedSpanText = `across ${displayedMonths.length}-month span`;
        if (await trendPlot.locator('.category-trend-month').count() !== displayedMonths.length) throw new Error(`Grouped category trend did not render the fixture-derived ${displayedMonths.length} month groups`);
        if (await trendPlot.locator('.category-trend-bar').count() !== displayedMonths.length * categoryCount) throw new Error(`Grouped category trend did not render ${displayedMonths.length * categoryCount} fixture bars`);
        if (await trendGraph.locator('.category-trend-summary').count() !== categoryCount) throw new Error(`Grouped category trend did not render ${categoryCount} compact category summaries`);
        if (await trendGraph.locator('.category-trend-summary').evaluateAll((elements, expected) => elements.some((element) => !element.textContent?.includes(expected.expectedReferenceLabel) || !element.textContent.includes(expected.expectedSpanText) || !element.querySelector('.category-trend-direction')), { expectedReferenceLabel, expectedSpanText })) throw new Error('Category summaries omitted the displayed reference month, span total, or trend status');
        const categoryColors = await trendGraph.locator('.category-trend-summary').evaluateAll((elements) => elements.map((element) => { const marker = element.querySelector('.category-trend-marker'); return { category: element.getAttribute('data-category'), color: marker ? getComputedStyle(marker).backgroundColor : '' }; }));
        const barColors = await trendPlot.locator('.category-trend-bar').evaluateAll((elements) => elements.map((element) => ({ category: element.getAttribute('data-category'), color: getComputedStyle(element).backgroundColor })));
        if (barColors.some((bar) => { const summary = categoryColors.find((candidate) => candidate.category === bar.category); return !summary || summary.color !== bar.color; })) throw new Error('Category bars and legend markers did not preserve category color identity');
        const currentLabels = await trendPlot.locator('.category-trend-month small').evaluateAll((elements) => elements.filter((element) => / MTD$/.test(element.textContent || '')).map((element) => { const range = document.createRange(); range.selectNodeContents(element); return { text: element.textContent, lines: new Set(Array.from(range.getClientRects()).map((rect) => Math.round(rect.top))).size }; }));
        if (currentLabels.length !== 0) throw new Error(`A trimmed historical span incorrectly labeled a month MTD: ${JSON.stringify(currentLabels)}`);
        const monthLabels = await trendPlot.locator('.category-trend-month small').evaluateAll((elements) => elements.map((element) => { const range = document.createRange(); range.selectNodeContents(element); return { text: element.textContent, lines: new Set(Array.from(range.getClientRects()).map((rect) => Math.round(rect.top))).size }; }));
        if (monthLabels.some((label) => label.lines !== 1)) throw new Error(`Displayed month label wrapped: ${JSON.stringify(monthLabels)}`);
        const scale = await trendPlot.locator('.category-trend-bar').evaluateAll((elements) => { const values = elements.map((element) => Number(element.getAttribute('data-value'))); const maximum = Math.max(...values); return { values, maximum, heights: elements.map((element) => Number.parseFloat(getComputedStyle(element).height)), width: getComputedStyle(elements[0]).width }; });
        if (!scale.values.includes(0) || !scale.heights.includes(0)) throw new Error('Sparse category fixture did not preserve true zero-height bars');
         const width = Number.parseFloat(scale.width);
         if (!Number.isFinite(width) || Math.abs(width - 7.2) > 0.1) throw new Error(`Category trend bars are not thin: computed ${scale.width} (${width}px), expected approximately 7.2px`);
        if (scale.values.some((value, barIndex) => Math.abs(scale.heights[barIndex] - (value === 0 ? 0 : Math.max(4, Math.round((value / scale.maximum) * 100) * 112 / 100))) > 2)) throw new Error('Category trend bars did not use one shared maximum');
        const trendCurrency = fixture.trends.categoryTrends.find((row) => categories.includes(row.category))?.currency ?? fixture.summary.summaries[0]?.currency ?? 'USD';
        const valuesTable = trendGraph.getByRole('table', { name: `Exact displayed-span ${trendCurrency} values by category`, exact: true });
        await expect(valuesTable).toHaveCount(1);
        const expectedTable = await page.evaluate(({ rows, orderedCategories, months, primaryValue, currentMonth, currency }) => {
          const formatters = new Map<string, Intl.NumberFormat>();
          const format = (currency: string, value: number) => {
            let formatter = formatters.get(currency);
            if (!formatter) { formatter = new Intl.NumberFormat(undefined, { style: 'currency', currency }); formatters.set(currency, formatter); }
            return formatter.format(value / 100);
          };
          return {
            headers: ['Category', ...months.map((month) => `${new Intl.DateTimeFormat(undefined, { month: 'short', timeZone: 'UTC' }).format(new Date(`${month}-01T00:00:00Z`))}${month === currentMonth ? ' MTD' : ''}`)],
            rows: orderedCategories.map((category) => ({ category, values: months.map((month) => format(currency, rows.filter((row) => row.category === category && row.bucket === month).reduce((sum, row) => sum + row[primaryValue], 0))) })),
          };
        }, { rows: fixture.trends.categoryTrends, orderedCategories: categories, months: displayedMonths, primaryValue: primary, currentMonth: actualCurrentMonth, currency: trendCurrency });
        const actualTable = await valuesTable.evaluate((table) => ({
          headers: Array.from(table.querySelectorAll('thead th')).map((cell) => cell.textContent?.trim() || ''),
          rows: Array.from(table.querySelectorAll('tbody tr')).map((row) => ({ category: row.querySelector('th')?.textContent?.trim() || '', values: Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent?.trim() || '') })),
        }));
        expect(actualTable.headers).toEqual(expectedHeaders);
        expect(actualTable.headers).toEqual(expectedTable.headers);
        expect(actualTable.rows).toEqual(expectedTable.rows);
        const tablist = page.getByRole('tablist', { name: 'Spending insight currencies' });
        await expect(tablist).toHaveCount(1);
        const tabs = tablist.getByRole('tab');
        expect(await tabs.count()).toBeGreaterThan(1);
        const initialTab = page.locator('.insight-currency-tab[aria-selected="true"]');
        await expect(initialTab).toHaveCount(1);
        const initialCurrency = await initialTab.innerText();
        await expect(page.getByRole('tabpanel', { name: initialCurrency })).toBeVisible();
        await expect(page.locator('.insight-currency-panel .insight-summary-card')).toHaveCount(1);
        await expect(page.locator('.insight-currency-panel .insight-category-trends')).toHaveCount(1);
        await expect(initialTab).toHaveText('USD');
        await expect(page.locator('.insight-currency-panel .insight-summary-card')).toContainText('(new)');
        for (const tab of await tabs.all()) await expect(tab).toHaveAttribute('aria-controls', 'insight-currency-panel');
        const plotLayout = await trendPlot.evaluate((element) => ({ overflowX: getComputedStyle(element).overflowX, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }));
        const documentWidth = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth));
        if (plotLayout.scrollWidth > plotLayout.clientWidth + 1 && !['auto', 'scroll'].includes(plotLayout.overflowX)) throw new Error('Grouped insight plot overflow was not contained internally');
        if (documentWidth > viewport.width + 1) throw new Error('Insight categories caused document-level overflow');
        if (viewport.width >= 896 && plotLayout.scrollWidth > plotLayout.clientWidth + 1) {
          throw new Error('Desktop grouped insight plot did not fit the displayed month groups without scrolling');
        }
        const initialIndex = await tabs.evaluateAll((elements) => elements.findIndex((element) => element.getAttribute('aria-selected') === 'true'));
        const otherIndex = await tabs.evaluateAll((elements) => elements.findIndex((element) => element.textContent?.trim() === 'EUR'));
        if (otherIndex < 0) throw new Error('Comparison fixture did not expose an EUR currency tab');
        const otherCurrency = await tabs.nth(otherIndex).innerText();
        await page.locator(`#insight-currency-tab-${otherCurrency}`).click();
        await expect(page.locator('.insight-currency-tab[aria-selected="true"]'), `currency switch at ${viewport.width}px`).toHaveText(otherCurrency);
        expect(new URL(page.url()).searchParams.get('currency')).toBe(otherCurrency);
        await expect(page.locator('.insight-currency-panel .insight-summary-card')).toContainText(otherCurrency);
        await expect(page.locator('.insight-currency-panel .insight-category-trends')).toContainText(otherCurrency);
        await page.locator('.insight-currency-tab[aria-selected="true"]').press('End');
        await expect(page.locator('.insight-currency-tab[aria-selected="true"]'), `End key at ${viewport.width}px`).toHaveText(await tabs.nth((await tabs.count()) - 1).innerText());
        await page.locator('.insight-currency-tab[aria-selected="true"]').press('Home');
        await expect(page.locator('.insight-currency-tab[aria-selected="true"]'), `Home key at ${viewport.width}px`).toHaveText(await tabs.nth(0).innerText());
        await page.locator('.insight-currency-tab[aria-selected="true"]').press('ArrowRight');
        await expect(page.locator('.insight-currency-tab[aria-selected="true"]'), `ArrowRight at ${viewport.width}px`).toHaveText(await tabs.nth((await tabs.count()) - 1).innerText());
        await page.locator('.insight-currency-tab[aria-selected="true"]').press('ArrowLeft');
        await expect(page.locator('.insight-currency-tab[aria-selected="true"]'), `Arrow cycle at ${viewport.width}px`).toHaveText(await tabs.nth(0).innerText());
        await tabs.nth(initialIndex).click();
        await expect(page.locator('.insight-currency-tab[aria-selected="true"]'), `return to initial currency at ${viewport.width}px`).toHaveText(initialCurrency);
        const tabIndices = await tabs.evaluateAll((elements) => elements.map((element) => ({ selected: element.getAttribute('aria-selected') === 'true', tabIndex: (element as HTMLButtonElement).tabIndex })));
        expect(tabIndices.filter((tab) => tab.selected && tab.tabIndex === 0)).toHaveLength(1);
        expect(tabIndices.filter((tab) => !tab.selected && tab.tabIndex !== -1)).toHaveLength(0);
        const tablistLayout = await tablist.evaluate((element) => ({ display: getComputedStyle(element).display, flexWrap: getComputedStyle(element).flexWrap, overflowX: getComputedStyle(element).overflowX, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), targets: Array.from(element.querySelectorAll('button')).map((button) => ({ width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height })) }));
        if (viewport.width <= 320) {
          if (tablistLayout.display !== 'flex' || tablistLayout.flexWrap !== 'nowrap' || !['auto', 'scroll'].includes(tablistLayout.overflowX)) throw new Error('320px currency tabs did not remain a single-row internally scrollable tablist');
          if (tablistLayout.documentWidth > viewport.width + 1) throw new Error('320px currency tabs caused document-level overflow');
          if (tablistLayout.targets.some((target) => target.width < 44 || target.height < 44)) throw new Error('320px currency tab touch target is smaller than 44px');
          await tabs.nth(0).focus();
          if (await tabs.nth(0).evaluate((element) => document.activeElement !== element)) throw new Error('320px currency tab cannot receive focus');
        }
      }
    }
      if (scenario.name === 'populated-home') {
        const globalCompact = page.locator('.insights-compact').filter({ hasText: 'Spending snapshot' });
        if (await globalCompact.count() !== 1) throw new Error('Populated home did not render the global spending snapshot');
        if ((await globalCompact.innerText()).includes('You paid')) throw new Error('Global compact insights exposed a paid-but-zero-allocation value');
        const compactSurface = await globalCompact.evaluate((element) => {
          const style = getComputedStyle(element);
          const borders = [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth];
          const radii = [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius];
          return { borders, radii, background: style.backgroundColor, shadow: style.boxShadow };
        });
        if (compactSurface.borders.some((border) => border !== '0px') || compactSurface.radii.some((radius) => radius !== '0px') || compactSurface.background !== 'rgba(0, 0, 0, 0)' || compactSurface.shadow !== 'none') throw new Error('Home spending snapshot retained an unnecessary painted outer surface');
        if (await globalCompact.locator('.insight-metric').evaluateAll((elements) => elements.some((element) => {
          const style = getComputedStyle(element);
          const outerBorders = [style.borderTopWidth, style.borderRightWidth, style.borderLeftWidth];
          const dividerIsAllowed = style.borderBottomWidth === '0px' || (style.borderBottomStyle === 'solid' && Number.parseFloat(style.borderBottomWidth) <= 1);
          const radii = [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius];
          return outerBorders.some((border) => border !== '0px') || !dividerIsAllowed || radii.some((radius) => radius !== '0px') || style.backgroundColor !== 'rgba(0, 0, 0, 0)' || style.boxShadow !== 'none';
        }))) throw new Error('Home spending snapshot retained painted metric cards');
      }
   }
  if (expected.mode === 'normal' || expected.mode === 'offline' || expected.mode === 'modal') {
    if (await visibleCount(page, '.error') !== 0 || await visibleCount(page, '.auth-banner') !== 0) throw new Error('Scenario rendered an unexpected auth/error fallback');
  }
  if (expected.mode === 'api-error') {
    if (await visibleCount(page, '#groups-error') !== 1 || !(await page.locator('body').innerText()).includes('Fixture outage')) throw new Error('API-error fixture did not render the intended groups error UI');
  }
  if (expected.mode === 'insights-error') {
    for (const insightError of expected.insightErrors || []) {
      if (await visibleCount(page, `#${insightError.id}`) !== 1 || !(await page.locator(`#${insightError.id}`).innerText()).includes(insightError.message)) throw new Error(`Insights error fixture did not render ${insightError.id} with ${insightError.message}`);
    }
  }
  if (expected.mode === 'insights-loading' && !(await page.getByRole('status').allTextContents()).some((text) => text.includes('Loading'))) throw new Error('Insights loading fixture did not render Loading status');
  if (expected.mode === 'offline' && await visibleCount(page, '.offline-banner') === 0) throw new Error('Offline fixture did not render the intended offline banner');
  for (const apiPath of expected.apiPaths || []) {
    if (!observations.some((observation) => observation.path === apiPath && observation.status >= 200 && observation.status < 300)) throw new Error(`Authenticated API did not succeed: ${apiPath}`);
  }
  for (const expectedFailure of expected.apiFailures || []) {
    if (!observations.some((observation) => observation.path === expectedFailure.path && observation.status === expectedFailure.status)) throw new Error(`Intercepted API did not return ${expectedFailure.status}: ${expectedFailure.path}`);
  }
}

async function assertCustomInsightAccessibility(page: Page, invalidFromUrl: boolean) {
  const customControls = page.locator('.insight-controls');
  const dateInputs = customControls.locator('input[type="date"]');
  const fromInput = dateInputs.nth(0);
  const toInput = dateInputs.nth(1);
  const applyButton = customControls.getByRole('button', { name: 'Apply range', exact: true });
  const initialIds = await page.locator('[id^="insights-custom-"]').evaluateAll((elements) => elements.map((element) => element.id));
  expect(new Set(initialIds).size).toBe(initialIds.length);
  if (invalidFromUrl) {
    expect(initialIds).toContain('insights-custom-from-error');
    expect(initialIds).not.toContain('insights-custom-to-error');
    await expect(fromInput).toHaveAttribute('aria-invalid', 'true');
    await expect(fromInput).toHaveAttribute('aria-describedby', 'insights-custom-from-error');
    await expect(toInput).toHaveAttribute('aria-invalid', 'false');
    await expect(toInput).not.toHaveAttribute('aria-describedby', 'insights-custom-to-error');
    await expect(page.locator('#insights-custom-from-error')).toHaveCount(1);
    await expect(applyButton).toBeVisible();
    await fromInput.fill('2026-02-01');
    await toInput.fill('2026-01-01');
    await applyButton.click();
    await expect(page.locator('#insights-custom-range-error')).toHaveCount(1);
    await expect(applyButton).toHaveAttribute('aria-describedby', 'insights-custom-range-error');
    return;
  }
  await fromInput.fill('2026-02-01');
  await toInput.fill('2026-01-01');
  await applyButton.click();
  await expect(page.locator('#insights-custom-range-error')).toHaveCount(1);
  await expect(applyButton).toHaveAttribute('aria-describedby', 'insights-custom-range-error');
  const finalIds = await page.locator('[id^="insights-custom-"]').evaluateAll((elements) => elements.map((element) => element.id));
  expect(new Set(finalIds).size).toBe(finalIds.length);
}

async function populateRefundAuditState(page: Page) {
  const expenseSelect = page.locator('.refund-application-row select').first();
  await expect(expenseSelect).toBeVisible();
  await expenseSelect.selectOption(ids.dinner);
  await expect(expenseSelect).toHaveValue(ids.dinner);
  const amountInput = page.locator('input[inputmode="decimal"]').first();
  const appliedAmountInput = page.locator('input[name="application-1-amount"]');
  await amountInput.fill('42.00');
  await expect(appliedAmountInput).toHaveValue('42.00');
  await page.locator('select[name="allocation-recipient-1-person"]').selectOption('00000000-0000-4000-8000-000000002003');
  await page.locator('input[name="allocation-recipient-1-amount"]').fill('42.00');
  await expect(page.locator('.refund-application-status')).toHaveText('Fully applied');
  await expect(page.locator('.refund-preview-person')).toHaveCount(3);
  await expect(page.locator('.refund-preview-list')).toContainText('Received');
  await expect(page.locator('.refund-preview-list')).toContainText('Cost reduction');
  await expect(page.locator('.refund-preview-list')).toContainText('Net balance effect');
}

async function populateStandaloneRefundAuditState(page: Page) {
  const pathSelect = page.getByLabel('Apply this to', { exact: true });
  await pathSelect.selectOption('standalone');
  await expect(pathSelect).toHaveValue('standalone');
  await expect(page.getByText('Standalone records do not change an expense.', { exact: true })).toBeVisible();
  const modeSelect = page.getByLabel('How was it handled?', { exact: true });
  await expect(modeSelect.locator('option[value="direct_provider_offset"]')).toBeDisabled();
  await expect(page.getByLabel('Affected member 1', { exact: true })).toBeVisible();
  await page.getByLabel('Affected member 1', { exact: true }).selectOption('00000000-0000-4000-8000-000000002004');
  await page.getByLabel('Affected member amount 1 (USD)', { exact: true }).fill('42.00');
  await expect(page.getByLabel('Affected member amount 1 (USD)', { exact: true })).toHaveValue('42.00');
  await expect(page.getByText('Standalone mode requires explicit recipient and affected-member allocations.', { exact: true })).toBeVisible();
}

async function populateLinkedDirectProviderRefundAuditState(page: Page) {
  const pathSelect = page.getByLabel('Apply this to', { exact: true });
  await pathSelect.selectOption('linked');
  await expect(pathSelect).toHaveValue('linked');
  await page.getByLabel('Expense 1', { exact: true }).selectOption(ids.dinner);
  await expect(page.getByLabel('Expense 1', { exact: true })).toHaveValue(ids.dinner);
  await page.getByLabel('How much? (USD)', { exact: true }).fill('42.00');
  await page.getByLabel('Applied amount for expense 1 (USD)', { exact: true }).fill('42.00');
  const modeSelect = page.getByLabel('How was it handled?', { exact: true });
  await modeSelect.selectOption('direct_provider_offset');
  await expect(modeSelect).toHaveValue('direct_provider_offset');
  await expect(page.locator('.refund-preview-list')).toContainText('Payment reduction');
  await expect(page.locator('.refund-preview-list')).toContainText('Cost reduction');
  await expect(page.getByText('Both payer and affected shares are derived from linked expenses.', { exact: true })).toBeVisible();
}

async function saveScreenshot(page: Page, artifactDirectory: string, name: string, failures: HarnessFailure[], scenario: Scenario, route: string, viewport: Viewport) {
  const directory = path.join(artifactDirectory, 'screenshots');
  await mkdir(directory, { recursive: true });
  const screenshotPath = path.join(directory, `${name}-${viewport.width}x${viewport.height}.png`);
  try {
    await page.screenshot({ path: screenshotPath, fullPage: true });
  } catch (error) {
    failures.push({ scenarioName: scenario.name, authState: authState(scenario.auth), route, viewport, detail: `Screenshot failed: ${error instanceof Error ? error.message : String(error)}` });
  }
}

async function reportForPage(page: Page, scenario: Scenario, route: string, viewport: Viewport, artifactDirectory: string, findings: Finding[], failures: HarnessFailure[]) {
  try {
    await page.evaluate(() => window.scrollTo(0, 0));
    findings.push(...await auditGeometry(page, scenario, route, viewport));
  } catch (error) {
    failures.push({ scenarioName: scenario.name, authState: authState(scenario.auth), route, viewport, detail: `Geometry audit failed: ${error instanceof Error ? error.message : String(error)}` });
  }
  await saveScreenshot(page, artifactDirectory, `${scenario.name}-${route.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')}`, failures, scenario, route, viewport);
}

async function captureRefundAuditState(page: Page, scenario: Scenario, state: { name: string; routeSuffix: string; context: string; content: string; populate: (page: Page) => Promise<void> }, observations: ApiObservation[], viewport: Viewport, artifactDirectory: string, findings: Finding[], failures: HarnessFailure[], coverage: Coverage[]) {
  const route = `${scenario.path} ${state.routeSuffix}`;
  try {
    await state.populate(page);
    const stateScenario: Scenario = { ...scenario, name: state.name, context: state.context, expected: { ...scenario.expected, content: state.content } };
    await assertRendered(page, stateScenario, observations, viewport);
    coverage.push({ scenarioName: stateScenario.name, authState: authState(stateScenario.auth), route, viewport, context: stateScenario.context, rendered: true, apiSuccesses: observations.filter((observation) => observation.status >= 200 && observation.status < 300).map((observation) => observation.path) });
    await reportForPage(page, stateScenario, route, viewport, artifactDirectory, findings, failures);
  } catch (error) {
    failures.push({ scenarioName: state.name, authState: authState(scenario.auth), route, viewport, detail: `Refund state could not be validated: ${error instanceof Error ? error.message : String(error)}` });
  }
}

function dedupeFindings(findings: Finding[]) {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = [finding.scenarioName, finding.authState, finding.route, finding.viewport.width, finding.viewport.height, finding.kind, finding.selector || '', finding.detail, finding.actual ?? ''].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function groupedFindings(findings: Finding[]): FindingGroup[] {
  const groups = new Map<string, FindingGroup>();
  for (const finding of findings) {
    const componentPattern = (finding.selector || finding.kind).replace(/\[text="(?:[^"\\]|\\.)*"\]/g, '[text]');
    const key = `${finding.kind}|${componentPattern}`;
    const existing = groups.get(key);
    if (existing) {
      if (!existing.affected.some((entry) => entry.scenarioName === finding.scenarioName && entry.authState === finding.authState && entry.route === finding.route && entry.viewport.width === finding.viewport.width && entry.viewport.height === finding.viewport.height)) {
        existing.affected.push({ scenarioName: finding.scenarioName, authState: finding.authState, route: finding.route, viewport: finding.viewport });
      }
      continue;
    }
    groups.set(key, { kind: finding.kind, severity: finding.severity, componentPattern, detail: finding.detail, affected: [{ scenarioName: finding.scenarioName, authState: finding.authState, route: finding.route, viewport: finding.viewport }] });
  }
  return [...groups.values()].sort((first, second) => first.severity.localeCompare(second.severity) || first.kind.localeCompare(second.kind) || first.componentPattern.localeCompare(second.componentPattern));
}

async function writeAuditAttachment(testInfo: TestInfo, artifactDirectory: string, name: string, findings: Finding[], failures: HarnessFailure[], coverage: Coverage[], limitations: string[]) {
  const severityRank: Record<Severity, number> = { critical: 0, major: 1, minor: 2, info: 3 };
  const orderedFindings = dedupeFindings(findings).sort((first, second) => severityRank[first.severity] - severityRank[second.severity] || first.route.localeCompare(second.route) || first.scenarioName.localeCompare(second.scenarioName) || first.authState.localeCompare(second.authState) || first.viewport.width - second.viewport.width || first.viewport.height - second.viewport.height || first.kind.localeCompare(second.kind));
  const setupFailures = failures.filter((failure) => failure.category === 'setup');
  const environmentFailures = failures.filter((failure) => failure.category === 'environment');
  const harnessFailures = failures.filter((failure) => failure.category !== 'environment' && failure.category !== 'setup');
  const report = { generatedAt: new Date().toISOString(), findings: orderedFindings, groupedFindings: groupedFindings(orderedFindings), coverage, limitations, harnessFailures, setupFailures, environmentFailures };
  await mkdir(artifactDirectory, { recursive: true });
  const reportPath = path.join(artifactDirectory, name);
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  await testInfo.attach(name, { path: reportPath, contentType: 'application/json' });
  console.log(`\n${name}: ${orderedFindings.length} product findings in ${report.groupedFindings.length} component patterns, ${harnessFailures.length} harness failures, ${setupFailures.length} setup/code failures, ${environmentFailures.length} environment failures`);
  for (const finding of report.groupedFindings) console.log(`[${finding.severity}] ${finding.kind} ${finding.componentPattern} — ${finding.detail} — affected: ${finding.affected.map((entry) => `${entry.route} @ ${entry.viewport.width}x${entry.viewport.height}`).join(', ')}`);
  for (const failure of harnessFailures) console.log(`[HARNESS] ${failure.scenarioName} ${failure.authState} ${failure.route} @ ${failure.viewport.width}x${failure.viewport.height} — ${failure.detail}`);
  for (const failure of setupFailures) console.log(`[SETUP/CODE] ${failure.scenarioName} ${failure.route} — ${failure.detail}`);
  for (const failure of report.environmentFailures) console.log(`[ENVIRONMENT] ${failure.scenarioName} ${failure.route} — ${failure.detail}`);
  return report;
}

function isEnvironmentFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_EMPTY_RESPONSE|Target page, context or browser has been closed|browser has been closed|Wrangler/i.test(message);
}

async function readServerFailure(): Promise<HarnessFailure | undefined> {
  try {
    const raw = JSON.parse(await readFile(path.join(process.cwd(), 'test-results', 'e2e-environment-failure.json'), 'utf8')) as { category?: string; type?: string; detail?: string };
    const category = raw.category === 'setup/code' ? 'setup' : 'environment';
    const type = raw.type ? ` (${raw.type})` : '';
    return { category, scenarioName: 'e2e-server', authState: 'public', route: '[web server]', viewport: { width: 0, height: 0 }, detail: `${category === 'setup' ? 'Setup/code' : 'Runtime/environment'} failure${type}: ${raw.detail || 'The E2E web server failed.'}` };
  } catch {
    return undefined;
  }
}

async function openContext(browser: Browser, auth: string | undefined, viewport: Viewport): Promise<BrowserContext> {
  return auth ? newAuthenticatedContext(browser, auth, viewport) : browser.newContext({ viewport });
}

async function observeResponses(page: Page, observations: ApiObservation[]) {
  page.on('response', (response) => {
    try {
      const url = new URL(response.url());
      if (url.pathname.startsWith('/api/')) observations.push({ path: url.pathname, status: response.status() });
    } catch { /* Ignore non-HTTP response URLs. */ }
  });
}

function observeRequests(page: Page, requests: ApiRequestObservation[]) {
  page.on('request', (request) => {
    try {
      const url = new URL(request.url());
      if (url.pathname.startsWith('/api/')) requests.push({ path: url.pathname, search: url.search, headers: request.headers() });
    } catch { /* Ignore non-HTTP request URLs. */ }
  });
}

function assertAuthenticatedRequest(requests: ApiRequestObservation[], auth: string) {
  if (!requests.some((request) => request.path === apiPaths.me && request.headers['x-dev-email'] === auth)) throw new Error(`Authenticated context did not send X-Dev-Email: ${auth}`);
}

test.describe.configure({ mode: 'serial' });

test('browser audit matrix captures validated routes, geometry, and full-page screenshots', async ({ browser }, testInfo) => {
  test.setTimeout(900_000);
  const findings: Finding[] = [];
  const failures: HarnessFailure[] = [];
  const coverage: Coverage[] = [];
  const artifactDirectory = auditArtifactDirectory('normal');
  for (const scenario of scenarios) {
    const scenarioViewports = scenario.name === 'group-insights' || scenario.name === 'global-insights' || scenario.name === 'empty-global-insights' || scenario.name === 'custom-insights' || scenario.name === 'invalid-custom-insights' ? insightViewports : viewports;
    for (const viewport of scenarioViewports) {
      const context = await openContext(browser, scenario.auth, viewport);
      const page = await context.newPage();
      const observations: ApiObservation[] = [];
       const apiHeaders: Array<{ path: string; search: string; headers: Record<string, string> }> = [];
      await observeResponses(page, observations);
      page.on('request', (request) => {
        try {
          const url = new URL(request.url());
           if (url.pathname.startsWith('/api/')) apiHeaders.push({ path: url.pathname, search: url.search, headers: request.headers() });
        } catch { /* Ignore non-HTTP request URLs. */ }
      });
      try {
        if (scenario.name === 'group-insights' || scenario.name === 'global-insights' || scenario.name === 'empty-global-insights') {
          const scope = scenario.name === 'group-insights' ? 'group' : 'global';
           await page.route('**/api/spending-insights*', (route) => { const fixture = populatedInsightFixture(scope, scenario.name === 'empty-global-insights'); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(new URL(route.request().url()).searchParams.get('view') === 'trends' ? fixture.trends : fixture.summary) }); });
        }
          await page.goto(`${BASE_URL}${scenario.path}`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
          await waitForScenarioReady(page, scenario);
        if (scenario.auth && !apiHeaders.some((request) => request.path === apiPaths.me && request.headers['x-dev-email'] === scenario.auth)) throw new Error(`Authenticated context did not send X-Dev-Email: ${scenario.auth}`);
        if (!scenario.auth && apiHeaders.some((request) => request.headers['x-dev-email'])) throw new Error('Public landing context sent X-Dev-Email');
        await assertRendered(page, scenario, observations, viewport);
        if (scenario.name === 'custom-insights' || scenario.name === 'invalid-custom-insights') {
           if (!apiHeaders.some((request) => request.path === apiPaths.spendingInsights && request.search.includes('view=trends'))) throw new Error('Invalid or incomplete custom insight range did not request independent trends');
           if (apiHeaders.some((request) => request.path === apiPaths.spendingInsights && request.search.includes('view=summary'))) throw new Error('Invalid or incomplete custom insight range made a selected-period summary request');
          await assertCustomInsightAccessibility(page, scenario.name === 'invalid-custom-insights');
        }
           coverage.push({ scenarioName: scenario.name, authState: authState(scenario.auth), route: scenario.path, viewport, context: scenario.context, rendered: true, apiSuccesses: observations.filter((observation) => observation.status >= 200 && observation.status < 300).map((observation) => observation.path) });
           await reportForPage(page, scenario, scenario.path, viewport, artifactDirectory, findings, failures);
           if (scenario.name === 'rich-group' && disclosureAuditWidths.has(viewport.width)) {
             try {
               const tools = page.locator('.group-overview-tools');
               await tools.locator('summary').click();
               await expect(tools).toHaveJSProperty('open', true);
               for (const linkName of ['View spending insights', 'Record credit', 'Group history', 'Group settings']) await expect(page.getByRole('link', { name: linkName, exact: true })).toBeVisible();
               const toolsScenario: Scenario = { ...scenario, name: 'group-overview-more-actions-open', context: 'GroupOverview / More group actions disclosure open', expected: { ...scenario.expected, content: 'View spending insights' } };
               await assertRendered(page, toolsScenario, observations, viewport);
               coverage.push({ scenarioName: toolsScenario.name, authState: authState(toolsScenario.auth), route: `${scenario.path} [More group actions open]`, viewport, context: toolsScenario.context, rendered: true, apiSuccesses: observations.filter((observation) => observation.status >= 200 && observation.status < 300).map((observation) => observation.path) });
               await reportForPage(page, toolsScenario, `${scenario.path} [More group actions open]`, viewport, artifactDirectory, findings, failures);

               const schedules = page.locator('.group-overview-card--schedules');
               const scheduleDisclosure = schedules.locator('details');
               await scheduleDisclosure.locator('summary').click();
               await expect(scheduleDisclosure).toHaveJSProperty('open', true);
               await expect(schedules.locator('.schedule-list-content')).toBeVisible();
               const schedulesScenario: Scenario = { ...scenario, name: 'group-overview-all-schedules-open', context: 'GroupOverview / View all schedules disclosure open', expected: { ...scenario.expected, content: 'Monthly apartment rent' } };
               await assertRendered(page, schedulesScenario, observations, viewport);
               coverage.push({ scenarioName: schedulesScenario.name, authState: authState(schedulesScenario.auth), route: `${scenario.path} [View all schedules open]`, viewport, context: schedulesScenario.context, rendered: true, apiSuccesses: observations.filter((observation) => observation.status >= 200 && observation.status < 300).map((observation) => observation.path) });
               await reportForPage(page, schedulesScenario, `${scenario.path} [View all schedules open]`, viewport, artifactDirectory, findings, failures);
             } catch (error) {
               failures.push({ scenarioName: 'group-overview-disclosures', authState: authState(scenario.auth), route: scenario.path, viewport, detail: `Group overview disclosures could not be validated: ${error instanceof Error ? error.message : String(error)}` });
             }
           }
           if (scenario.name === 'refund-form') {
            try {
              await populateRefundAuditState(page);
              const populatedScenario: Scenario = { ...scenario, name: 'refund-form-populated', context: 'RefundForm / selected expense, recipient, running application status, and grouped money-flow preview', expected: { ...scenario.expected, content: 'Fully applied' } };
              await assertRendered(page, populatedScenario, observations, viewport);
              coverage.push({ scenarioName: populatedScenario.name, authState: authState(populatedScenario.auth), route: `${scenario.path} [populated]`, viewport, context: populatedScenario.context, rendered: true, apiSuccesses: observations.filter((observation) => observation.status >= 200 && observation.status < 300).map((observation) => observation.path) });
              await reportForPage(page, populatedScenario, `${scenario.path} [populated]`, viewport, artifactDirectory, findings, failures);
            } catch (error) {
              failures.push({ scenarioName: 'refund-form-populated', authState: authState(scenario.auth), route: `${scenario.path} [populated]`, viewport, detail: `Populated refund state could not be validated: ${error instanceof Error ? error.message : String(error)}` });
            }
            await captureRefundAuditState(page, scenario, {
              name: 'refund-form-standalone-member',
              routeSuffix: '[standalone member]',
              context: 'RefundForm / standalone member reimbursement with provider adjustment unavailable',
              content: 'Standalone records do not change an expense.',
              populate: populateStandaloneRefundAuditState,
            }, observations, viewport, artifactDirectory, findings, failures, coverage);
            await captureRefundAuditState(page, scenario, {
              name: 'refund-form-linked-direct-provider',
              routeSuffix: '[linked direct provider]',
              context: 'RefundForm / linked direct-provider adjustment with derived payer and cost reductions',
              content: 'Payment reduction',
              populate: populateLinkedDirectProviderRefundAuditState,
            }, observations, viewport, artifactDirectory, findings, failures, coverage);
          }
          if (scenario.name === 'group-creation') {
           try {
             await page.getByRole('button', { name: 'Add another person' }).click();
             await page.getByLabel('Name').nth(0).fill('Taylor Reed');
             await page.getByLabel('Name').nth(1).fill('Jordan Lee');
             await expect(page.getByText('Person 2', { exact: true })).toBeVisible();
             const expandedScenario: Scenario = { ...scenario, name: 'group-creation-multi-person', context: 'GroupCreation / expanded multi-person named form', expected: { ...scenario.expected, content: 'Person 2' } };
             await assertRendered(page, expandedScenario, observations, viewport);
             coverage.push({ scenarioName: expandedScenario.name, authState: authState(expandedScenario.auth), route: `${scenario.path} [multi-person]`, viewport, context: expandedScenario.context, rendered: true, apiSuccesses: observations.filter((observation) => observation.status >= 200 && observation.status < 300).map((observation) => observation.path) });
             await reportForPage(page, expandedScenario, `${scenario.path} [multi-person]`, viewport, artifactDirectory, findings, failures);
             await page.evaluate(() => window.dispatchEvent(new Event('offline')));
             await expect(page.getByRole('button', { name: 'Create group' })).toBeDisabled();
             const offlineScenario: Scenario = { ...expandedScenario, name: 'group-creation-offline', context: 'GroupCreation / expanded form with connection-required mutation disabled', expected: { mode: 'offline', heading: 'New group', content: 'Group creation requires a connection.' } };
             await assertRendered(page, offlineScenario, observations, viewport);
             coverage.push({ scenarioName: offlineScenario.name, authState: authState(offlineScenario.auth), route: `${scenario.path} [offline]`, viewport, context: offlineScenario.context, rendered: true, apiSuccesses: observations.filter((observation) => observation.status >= 200 && observation.status < 300).map((observation) => observation.path) });
             await reportForPage(page, offlineScenario, `${scenario.path} [offline]`, viewport, artifactDirectory, findings, failures);
           } catch (error) {
             failures.push({ scenarioName: 'group-creation-states', authState: authState(scenario.auth), route: scenario.path, viewport, detail: `Creation form states could not be validated: ${error instanceof Error ? error.message : String(error)}` });
           }
         }
         if (scenario.expandedAudit) {
          try {
            const auditSummary = page.getByText('View audit history', { exact: true });
            await expect(auditSummary).toBeVisible();
            await auditSummary.click();
            await expect(page.locator('details.audit-disclosure')).toHaveAttribute('open', '');
            await expect(page.getByRole('heading', { name: 'Audit history' })).toBeVisible();
            await expect(page.getByText(scenario.expandedAudit.content, { exact: true })).toBeVisible();
            expect(observations.some((observation) => observation.path === apiPaths.auditEntity(ids.rich, scenario.expandedAudit.entityType, scenario.expandedAudit.entityId) && observation.status >= 200 && observation.status < 300)).toBe(true);
            const expandedScenario: Scenario = { ...scenario, name: `${scenario.name}-audit-open`, context: `${scenario.context} / audit disclosure open`, expected: { ...scenario.expected, content: scenario.expandedAudit.content } };
            await assertRendered(page, expandedScenario, observations, viewport);
            coverage.push({ scenarioName: expandedScenario.name, authState: authState(expandedScenario.auth), route: `${scenario.path} [audit open]`, viewport, context: expandedScenario.context, rendered: true, apiSuccesses: observations.filter((observation) => observation.status >= 200 && observation.status < 300).map((observation) => observation.path) });
            await reportForPage(page, expandedScenario, `${scenario.path} [audit open]`, viewport, artifactDirectory, findings, failures);
          } catch (error) {
            failures.push({ scenarioName: `${scenario.name}-audit-open`, authState: authState(scenario.auth), route: `${scenario.path} [audit open]`, viewport, detail: `Audit disclosure could not be validated: ${error instanceof Error ? error.message : String(error)}` });
          }
        }
         if (scenario.name === 'group-management' && expandedManagementWidths.has(viewport.width)) {
          try {
            const mateo = page.getByRole('list', { name: 'Group members' }).getByRole('listitem').filter({ hasText: 'Mateo Silva' });
            await expect(mateo.locator('summary')).toHaveText('Add email');
            await mateo.locator('summary').click();
            await expect(mateo.getByLabel('Email for Mateo Silva')).toBeVisible();
            const expandedScenario: Scenario = { ...scenario, name: 'group-management-add-email', context: 'GroupManagement / Mateo Silva (ledger-only person 002005) Add email disclosure open', expected: { ...scenario.expected } };
            await assertRendered(page, expandedScenario, observations, viewport);
            coverage.push({ scenarioName: expandedScenario.name, authState: authState(expandedScenario.auth), route: `${scenario.path} [add email]`, viewport, context: expandedScenario.context, rendered: true, apiSuccesses: observations.filter((observation) => observation.status >= 200 && observation.status < 300).map((observation) => observation.path) });
            await reportForPage(page, expandedScenario, `${scenario.path} [add email]`, viewport, artifactDirectory, findings, failures);
          } catch (error) {
             failures.push({ scenarioName: 'group-management-add-email', authState: authState(scenario.auth), route: `${scenario.path} [add email]`, viewport, detail: `Add-email disclosure could not be validated: ${error instanceof Error ? error.message : String(error)}` });
           }
           try {
             const invitation = page.locator('details.generic-invitation-disclosure');
             await expect(invitation).toBeVisible();
             await invitation.locator('summary').click();
             await expect(invitation.getByLabel('Invite by email')).toBeVisible();
             const expandedScenario: Scenario = { ...scenario, name: 'group-management-invitation', context: 'GroupManagement / generic invitation disclosure open', expected: { ...scenario.expected, content: 'Invite by email' } };
             await assertRendered(page, expandedScenario, observations, viewport);
             coverage.push({ scenarioName: expandedScenario.name, authState: authState(expandedScenario.auth), route: `${scenario.path} [invitation open]`, viewport, context: expandedScenario.context, rendered: true, apiSuccesses: observations.filter((observation) => observation.status >= 200 && observation.status < 300).map((observation) => observation.path) });
             await reportForPage(page, expandedScenario, `${scenario.path} [invitation open]`, viewport, artifactDirectory, findings, failures);
            } catch (error) {
              failures.push({ scenarioName: 'group-management-invitation', authState: authState(scenario.auth), route: `${scenario.path} [invitation open]`, viewport, detail: `Invitation disclosure could not be validated: ${error instanceof Error ? error.message : String(error)}` });
            }
            try {
              const addFriend = page.locator('section[aria-labelledby="add-friend-heading"]');
              await addFriend.getByRole('button', { name: 'Add friend', exact: true }).click();
              await expect(addFriend.getByLabel('Friend name')).toBeVisible();
              const expandedScenario: Scenario = { ...scenario, name: 'group-management-add-friend', context: 'GroupManagement / Add friend editor open', expected: { ...scenario.expected, content: 'Friend name' } };
              await assertRendered(page, expandedScenario, observations, viewport);
              coverage.push({ scenarioName: expandedScenario.name, authState: authState(expandedScenario.auth), route: `${scenario.path} [Add friend open]`, viewport, context: expandedScenario.context, rendered: true, apiSuccesses: observations.filter((observation) => observation.status >= 200 && observation.status < 300).map((observation) => observation.path) });
              await reportForPage(page, expandedScenario, `${scenario.path} [Add friend open]`, viewport, artifactDirectory, findings, failures);
            } catch (error) {
              failures.push({ scenarioName: 'group-management-add-friend', authState: authState(scenario.auth), route: `${scenario.path} [Add friend open]`, viewport, detail: `Add-friend editor could not be validated: ${error instanceof Error ? error.message : String(error)}` });
            }
            try {
              const splitDefault = page.locator('section.split-default-settings');
              await splitDefault.getByRole('button', { name: /^(Customize|Edit)$/ }).click();
              await expect(splitDefault.locator(':scope > form')).toBeVisible();
              const expandedScenario: Scenario = { ...scenario, name: 'group-management-split-default', context: 'GroupManagement / party default split editor open', expected: { ...scenario.expected, content: 'Split new entries' } };
              await assertRendered(page, expandedScenario, observations, viewport);
              coverage.push({ scenarioName: expandedScenario.name, authState: authState(expandedScenario.auth), route: `${scenario.path} [split default open]`, viewport, context: expandedScenario.context, rendered: true, apiSuccesses: observations.filter((observation) => observation.status >= 200 && observation.status < 300).map((observation) => observation.path) });
              await reportForPage(page, expandedScenario, `${scenario.path} [split default open]`, viewport, artifactDirectory, findings, failures);
            } catch (error) {
              failures.push({ scenarioName: 'group-management-split-default', authState: authState(scenario.auth), route: `${scenario.path} [split default open]`, viewport, detail: `Split-default editor could not be validated: ${error instanceof Error ? error.message : String(error)}` });
            }
          }
        if (scenario.name === 'expense-form') {
          try {
            await page.locator('.summary-row').click();
            await expect(page.locator('.modal-sheet')).toBeVisible();
            const modalScenario: Scenario = { ...scenario, name: `${scenario.name}-payer-modal`, context: 'ExpenseForm / payer modal (full canonical responsive coverage)', expected: { mode: 'modal', heading: 'Add expense', content: 'Who paid?' } };
            await assertRendered(page, modalScenario, observations, viewport);
            coverage.push({ scenarioName: modalScenario.name, authState: authState(modalScenario.auth), route: `${scenario.path} [payer modal]`, viewport, context: modalScenario.context, rendered: true, apiSuccesses: observations.filter((observation) => observation.status >= 200 && observation.status < 300).map((observation) => observation.path) });
            await reportForPage(page, modalScenario, `${scenario.path} [payer modal]`, viewport, artifactDirectory, findings, failures);
          } catch (error) {
            failures.push({ scenarioName: `${scenario.name}-payer-modal`, authState: authState(scenario.auth), route: `${scenario.path} [payer modal]`, viewport, detail: `Payer modal could not be validated: ${error instanceof Error ? error.message : String(error)}` });
          }
        }
      } catch (error) {
        failures.push({ category: isEnvironmentFailure(error) ? 'environment' : 'scenario', scenarioName: scenario.name, authState: authState(scenario.auth), route: scenario.path, viewport, detail: `Scenario validation/navigation failed before audit: ${error instanceof Error ? error.message : String(error)}` });
        await saveScreenshot(page, artifactDirectory, scenario.name, failures, scenario, scenario.path, viewport);
      } finally {
        await context.close();
      }
    }
  }
  const serverFailure = await readServerFailure();
  if (serverFailure && !failures.some((failure) => failure.category === serverFailure.category && failure.detail === serverFailure.detail)) failures.push(serverFailure);
  const report = await writeAuditAttachment(testInfo, artifactDirectory, 'audit-findings.json', findings, failures, coverage, [
    'The 44×44 policy is the project touch-target policy and is audited only at touch/mobile/tablet widths (<896px), not as a universal standards failure.',
    'Playwright cannot reliably inject CSS env(safe-area-inset-*) values into Chromium; source assertions cover the safe-area contracts, while real-device inset behavior remains to be checked on notched iOS/Android hardware.',
    'Payer modal coverage is exercised at every canonical width, including the 895px/896px presentation boundary and 1440px desktop.',
    'The matrix reports broad route/fixture coverage separately from actual geometry violations. Findings from a few routes do not establish a global architecture defect.',
  ]);
  expect(report.findings.filter((finding) => finding.severity === 'critical' || finding.severity === 'major'), 'The audit must not contain critical or major geometry findings').toEqual([]);
  expect(failures, 'The audit matrix should complete without harness failures').toEqual([]);
});

const highRiskViewports = [{ width: 390, height: 844 }, { width: 895, height: 900 }, { width: 896, height: 900 }, { width: 1440, height: 900 }];

async function withHighRiskPage(browser: Browser, viewport: Viewport, run: (page: Page, context: BrowserContext) => Promise<void>) {
  const context = await newAuthenticatedContext(browser, DEV_EMAIL, viewport);
  const page = await context.newPage();
  try {
    await run(page, context);
  } finally {
    // Close the page before its context so an interrupted assertion cannot leave
    // a pending page operation blocking context disposal.
    await page.close({ runBeforeUnload: false }).catch(() => undefined);
    await context.close().catch(() => undefined);
  }
}

async function openHighRiskRoute(page: Page, context: BrowserContext, route: string) {
   await context.setOffline(false);
   await page.goto(`${BASE_URL}${route}`, { waitUntil: 'domcontentloaded' });
   await expect(page.locator('main')).toBeVisible();
}

async function setHighRiskOnline(page: Page, context: BrowserContext) {
  await context.setOffline(false);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
    window.dispatchEvent(new Event('online'));
  });
}

async function setHighRiskOffline(page: Page, context: BrowserContext) {
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    window.dispatchEvent(new Event('offline'));
  });
  await context.setOffline(true);
}

test('deleted records preserve restore recovery and offline controls', async ({ browser }) => {
  for (const viewport of highRiskViewports) {
    await withHighRiskPage(browser, viewport, async (page, context) => {
      for (const [route, label] of [
        [`/groups/${ids.rich}/expenses/${ids.deletedExpense}`, 'Restore expense'],
        [`/groups/${ids.rich}/settlements/${ids.deletedSettlement}`, 'Restore settlement'],
        [`/groups/${ids.rich}/credits/${ids.deletedRefund}`, 'Restore refund/reimbursement'],
      ] as const) {
        await setHighRiskOnline(page, context);
        await openHighRiskRoute(page, context, route);
        const restore = page.getByRole('button', { name: label, exact: true });
        await expect(restore).toBeVisible();
        await expect(restore).toBeEnabled();
        await seedOfflineTrust(page);
        await setHighRiskOffline(page, context);
        await expect(restore).toBeDisabled();
      }
    });
  }
});

test('settings keeps account deletion guarded and ordered after primary actions', async ({ browser }) => {
  for (const viewport of highRiskViewports) {
    await withHighRiskPage(browser, viewport, async (page, context) => {
      await openHighRiskRoute(page, context, '/settings');
      const danger = page.locator('.settings-section--danger');
      await expect(danger).toBeVisible();
      await expect(page.getByLabel('Typed confirmation')).toHaveAttribute('aria-describedby', 'account-deletion-help');
      const deleteAccount = danger.getByRole('button', { name: 'Delete BillSplit account', exact: true });
      await expect(deleteAccount).toBeDisabled();
      await page.getByLabel('Typed confirmation').fill('DELETE MY ACCOUNT');
      // The local development Clerk fixture has no destructive account identity;
      // exact text alone must never make this action executable.
      await expect(deleteAccount).toBeDisabled();
      const settingsOrder = await page.locator('main').evaluate((main) => {
        const sections = Array.from(main.querySelectorAll('section'));
        return { dangerIndex: sections.findIndex((section) => section.classList.contains('settings-section--danger')), primaryIndex: sections.findIndex((section) => Boolean(section.querySelector('button:not(.button--secondary):not(.button--danger)'))) };
      });
      expect(settingsOrder.dangerIndex).toBeGreaterThan(settingsOrder.primaryIndex);
    });
  }
});

test('management invitation disclosure stays actionable', async ({ browser }) => {
  for (const viewport of highRiskViewports) {
    await withHighRiskPage(browser, viewport, async (page, context) => {
      await openHighRiskRoute(page, context, `/groups/${ids.rich}/manage`);
      const invitation = page.locator('.generic-invitation-disclosure');
      await invitation.locator('summary').click();
      await expect(invitation.getByLabel('Invite by email')).toBeVisible();
      await expect(invitation.getByRole('button', { name: 'Invite', exact: true })).toBeEnabled();
    });
  }
});

test('refund submission remains enabled online and disabled offline', async ({ browser }) => {
  for (const viewport of highRiskViewports) {
    await withHighRiskPage(browser, viewport, async (page, context) => {
      await openHighRiskRoute(page, context, `/groups/${ids.rich}/refund/new`);
      await populateRefundAuditState(page);
      const refundSubmit = page.getByRole('button', { name: 'Record money back', exact: true });
      await expect(refundSubmit).toBeEnabled();
      await setHighRiskOffline(page, context);
      await expect(refundSubmit).toBeDisabled();
    });
  }
});

test('history filters preserve credit selection and transaction results', async ({ browser }) => {
  for (const viewport of highRiskViewports) {
    await withHighRiskPage(browser, viewport, async (page, context) => {
      await openHighRiskRoute(page, context, `/activity?group=${ids.rich}&view=transactions`);
      const filterDisclosure = page.locator('.transaction-filters-disclosure');
      await filterDisclosure.locator('summary').click();
      await expect(filterDisclosure.locator('form')).toBeVisible();
      await page.locator('.history-kind-shortcut select').selectOption('credit');
      await expect(filterDisclosure.locator('label').filter({ hasText: 'Category' }).locator('select')).toBeDisabled();
      await filterDisclosure.locator('form').evaluate((form) => form.requestSubmit());
      await expect.poll(() => new URL(page.url()).searchParams.get('kind')).toBe('credit');
      await expect.poll(() => new URL(page.url()).searchParams.get('view')).toBe('transactions');
      await expect(page.locator('.transaction-list')).toBeVisible();
      await expect(page.locator('.transaction-list .transaction-row')).not.toHaveCount(0);
      expect(await page.locator('.transaction-list .transaction-row').evaluateAll((rows) => rows.every((row) => row.getAttribute('data-transaction-kind') === 'credit'))).toBe(true);
    });
  }
});

test('group overview keeps storyboard modules flat, ordered, and responsive', async ({ authenticatedPage: page }) => {
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.goto(`${BASE_URL}/groups/${ids.rich}`);
    await expect(page.locator('.group-overview-card')).toHaveCount(4);
    await expect(page.locator('.group-overview-card--schedules .schedule-overview-list')).toBeVisible();
    await expect(page.locator('.group-overview-card--schedules .schedule-overview-row')).toHaveCount(1);
    await expect(page.getByRole('list', { name: 'People in this group' })).toBeVisible();
    await expect(page.locator('.transaction-row--overview').first()).toBeVisible();
    await expect(page.locator('.group-overview-card--balances .balance-card--positive').first()).toBeVisible();
    await expect(page.locator('.group-overview-card--balances .balance-card--debt').first()).toBeVisible();
    await expect(page.locator('.group-overview-tools')).toHaveJSProperty('open', false);

    const structure = await page.locator('.group-overview-columns').evaluate((element) => {
      const order = Array.from(element.querySelectorAll(':scope .group-overview-card')).map((card) => card.className);
      const columns = Array.from(element.children).map((column) => ({ className: column.className, cards: Array.from(column.querySelectorAll(':scope > .group-overview-card')).map((card) => card.className) }));
       const paintedDescendants = Array.from(element.querySelectorAll('.group-overview-card .ui-card-surface,.group-overview-card .ui-surface,.group-overview-card .ui-form-surface,.group-overview-card .group-overview-card')).length;
      return { order, columns, paintedDescendants, display: getComputedStyle(element).gridTemplateColumns };
    });
    expect(structure.order.map((name) => name.includes('balances') ? 'balances' : name.includes('transactions') ? 'transactions' : name.includes('schedules') ? 'schedules' : 'people')).toEqual(['balances', 'transactions', 'schedules', 'people']);
    expect(structure.paintedDescendants).toBe(0);
    if (viewport.width < 896) {
      expect(structure.columns).toHaveLength(2);
      expect(structure.display.split(' ').filter(Boolean)).toHaveLength(1);
    } else {
      expect(structure.columns[0].cards.map((name) => name.includes('balances') ? 'balances' : name.includes('transactions') ? 'transactions' : name)).toEqual(['balances', 'transactions']);
      expect(structure.columns[1].cards.map((name) => name.includes('schedules') ? 'schedules' : name.includes('people') ? 'people' : name)).toEqual(['schedules', 'people']);
      expect(structure.display.split(' ').filter(Boolean)).toHaveLength(2);
    }

    const geometry = await page.locator('.route-view--group-overview').evaluate((route) => {
      const visible = (element: Element) => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
      };
      const box = (element: Element) => {
        const value = element.getBoundingClientRect();
        return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height };
      };
      const cards = Array.from(route.querySelectorAll<HTMLElement>('.group-overview-card'));
      const header = route.querySelector<HTMLElement>('.group-overview-header');
      const grid = route.querySelector<HTMLElement>('.group-overview-columns');
      const tools = route.querySelector<HTMLElement>('.group-overview-tools');
      const actions = Array.from(route.querySelectorAll<HTMLElement>('.group-overview-header .button')).filter(visible).map(box);
      const cardsWithStyles = cards.map((card) => {
        const style = getComputedStyle(card);
        return { ...box(card), radius: parseFloat(style.borderTopLeftRadius), padding: parseFloat(style.paddingTop), border: parseFloat(style.borderTopWidth), background: style.backgroundColor, shadow: style.boxShadow };
      });
      const balanceAmounts = Array.from(route.querySelectorAll<HTMLElement>('.group-overview-card--balances .balance-card .money')).map((element) => ({ fontSize: parseFloat(getComputedStyle(element).fontSize), background: getComputedStyle(element.parentElement || element).backgroundColor }));
      const balanceStates = Array.from(route.querySelectorAll<HTMLElement>('.group-overview-card--balances .balance-card--positive,.group-overview-card--balances .balance-card--debt')).map((element) => {
        const style = getComputedStyle(element);
        return { kind: element.classList.contains('balance-card--positive') ? 'positive' : 'debt', background: style.backgroundColor, accentWidth: parseFloat(style.borderLeftWidth), accentColor: style.borderLeftColor, amountFontSize: parseFloat(getComputedStyle(element.querySelector('.money') || element).fontSize) };
      });
      const transactions = Array.from(route.querySelectorAll<HTMLElement>('.transaction-row--overview'));
      const transactionTexts = transactions.map((transaction) => transaction.textContent || '');
      const peoplePreview = route.querySelector<HTMLElement>('.people-preview-list');
      const peopleRows = Array.from(peoplePreview?.querySelectorAll<HTMLElement>('.people-preview-row') || []).filter(visible).map((row) => row.textContent || '');
      const peopleOverflowElement = peoplePreview?.querySelector<HTMLElement>('.people-preview-overflow');
      const peopleOverflow = peopleOverflowElement && visible(peopleOverflowElement) ? peopleOverflowElement.textContent || '' : '';
      const categoryStyles = transactions.flatMap((transaction) => Array.from(transaction.querySelectorAll<HTMLElement>('.transaction-row__category')).filter(visible).map((category) => {
        const style = getComputedStyle(category);
        return { background: style.backgroundColor, radius: parseFloat(style.borderTopLeftRadius), fontSize: parseFloat(style.fontSize) };
      }));
      const overviewLinks = Array.from(route.querySelectorAll<HTMLElement>('.group-overview-card a,.group-overview-card summary,.group-overview-tools summary')).filter(visible);
      const firstCard = cards[0];
      const firstAction = route.querySelector<HTMLElement>('.group-overview-header .button');
      return {
        titleFontSize: parseFloat(getComputedStyle(route.querySelector('h1')!).fontSize),
        metaFontSize: parseFloat(getComputedStyle(route.querySelector('.group-overview-meta')!).fontSize),
        headerToGrid: header && grid ? grid.getBoundingClientRect().top - header.getBoundingClientRect().bottom : 0,
        gridToTools: grid && tools ? tools.getBoundingClientRect().top - grid.getBoundingClientRect().bottom : 0,
        columns: getComputedStyle(grid!).gridTemplateColumns.split(' ').filter(Boolean).length,
        cards: cardsWithStyles,
        balanceAmounts,
        balanceStates,
        actionSizes: actions,
        actionGroupWithinHeader: Boolean(route.querySelector('.group-overview-header .expense-heading__actions')),
        actionPlacementValid: Boolean(header && actions.every((action) => action.left >= route.getBoundingClientRect().left - 1 && action.right <= route.getBoundingClientRect().right + 1 && action.bottom <= header.getBoundingClientRect().bottom + 1)),
        transactionTexts,
        categoryStyles,
        scheduleText: route.querySelector('.schedule-overview-list')?.textContent || '',
        peopleRows,
        peopleOverflow,
      nestedPaint: cards.reduce((count, card) => count + Array.from(card.querySelectorAll('.ui-card-surface,.ui-surface,.ui-form-surface,.group-overview-card')).length, 0),
        firstActionBeforeCard: Boolean(firstAction && firstCard && firstAction.compareDocumentPosition(firstCard) & Node.DOCUMENT_POSITION_FOLLOWING),
        toolsAfterCards: Boolean(tools && cards.at(-1) && cards.at(-1)!.compareDocumentPosition(tools) & Node.DOCUMENT_POSITION_FOLLOWING),
        focusableOrder: overviewLinks.map((element) => element.matches('.group-overview-tools summary') ? 'tools' : element.closest('.group-overview-card')?.className.includes('balances') ? 'balances' : element.closest('.group-overview-card')?.className.includes('transactions') ? 'transactions' : element.closest('.group-overview-card')?.className.includes('schedules') ? 'schedules' : element.closest('.group-overview-card')?.className.includes('people') ? 'people' : 'other'),
      };
    });
    expect(geometry.titleFontSize).toBeGreaterThanOrEqual(28);
    expect(geometry.titleFontSize).toBeLessThanOrEqual(34);
    expect(geometry.metaFontSize).toBeGreaterThanOrEqual(12);
    expect(geometry.metaFontSize).toBeLessThanOrEqual(16);
    expect(geometry.headerToGrid).toBeGreaterThanOrEqual(8);
    expect(geometry.headerToGrid).toBeLessThanOrEqual(40);
    expect(geometry.gridToTools).toBeGreaterThanOrEqual(8);
    expect(geometry.gridToTools).toBeLessThanOrEqual(40);
    expect(geometry.cards.every((card) => card.radius >= 8 && card.radius <= 16 && card.padding >= 12 && card.padding <= 24 && card.border >= 1 && card.background !== 'rgba(0, 0, 0, 0)' && card.shadow === 'none')).toBe(true);
    expect(geometry.actionSizes.every((action) => action.height >= 44)).toBe(true);
    expect(geometry.actionGroupWithinHeader).toBe(true);
    expect(geometry.actionPlacementValid).toBe(true);
    expect(geometry.balanceAmounts.every((amount) => amount.fontSize >= 28 && amount.fontSize <= 36)).toBe(true);
    expect(geometry.balanceStates.length).toBeGreaterThan(0);
    expect(geometry.balanceStates.some((state) => state.kind === 'positive')).toBe(true);
    expect(geometry.balanceStates.some((state) => state.kind === 'debt')).toBe(true);
    expect(geometry.balanceStates.every((state) => (state.background === 'transparent' || state.background === 'rgba(0, 0, 0, 0)') && state.accentWidth > 0 && state.accentColor !== 'transparent' && state.accentColor !== 'rgba(0, 0, 0, 0)' && state.amountFontSize >= 28)).toBe(true);
    expect(new Set(geometry.balanceStates.filter((state) => state.kind === 'positive').map((state) => state.accentColor))).not.toEqual(new Set(geometry.balanceStates.filter((state) => state.kind === 'debt').map((state) => state.accentColor)));
    expect(geometry.transactionTexts.some((text) => text.includes('Dinner by the canal (edited)'))).toBe(true);
    expect(geometry.categoryStyles.some((style) => style.background !== 'transparent' && style.background !== 'rgba(0, 0, 0, 0)' && style.radius > 0 && style.fontSize <= 14)).toBe(true);
    expect(geometry.scheduleText).toContain('Monthly apartment rent');
    expect(geometry.scheduleText).toContain('Next occurrence');
    expect(geometry.peopleRows).toHaveLength(4);
    expect(geometry.peopleRows.some((text) => text.includes('You'))).toBe(true);
    expect(geometry.peopleRows.some((text) => text.includes('Mateo Silva'))).toBe(true);
    expect(geometry.peopleRows.some((text) => text.includes('Priya Shah'))).toBe(true);
    expect(geometry.peopleOverflow).toMatch(/^\+\d+ more people$/);
    expect(geometry.nestedPaint).toBe(0);
    expect(geometry.firstActionBeforeCard).toBe(true);
    expect(geometry.toolsAfterCards).toBe(true);
    expect(geometry.focusableOrder.at(-1)).toBe('tools');
    expect([...new Set(geometry.focusableOrder)]).toEqual(['balances', 'transactions', 'schedules', 'people', 'tools']);
    expect(geometry.focusableOrder.filter((value) => value === 'balances').length).toBeGreaterThan(0);
    expect(geometry.focusableOrder.filter((value) => value === 'transactions').length).toBeGreaterThan(0);
    if (viewport.width < 896) expect(geometry.columns).toBe(1);
    else expect(geometry.columns).toBe(2);

    await page.locator('.group-overview-tools summary').click();
    await expect(page.getByRole('link', { name: 'View spending insights' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Record credit' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Group history' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Group settings' })).toBeVisible();
  }
});

test('representative frequent/admin flow regions keep a primary action and a non-overlapping order', async ({ browser }) => {
  const representativeViewports = [{ width: 320, height: 844 }, { width: 895, height: 900 }, { width: 896, height: 900 }, { width: 1440, height: 900 }];
  const routes = [
    { path: `/groups/${ids.rich}`, name: 'group overview', frequent: '.expense-heading__actions', admin: '.group-overview-tools' },
    { path: `/groups/${ids.rich}/add`, name: 'chooser', frequent: '.chooser-options', admin: undefined },
    { path: `/groups/${ids.rich}/manage`, name: 'management', frequent: 'section[aria-labelledby="add-friend-heading"]', admin: '#people,.invitations-panel,.split-default-settings,.export-controls,#settings' },
  ];
  for (const viewport of representativeViewports) {
    for (const route of routes) {
      await withHighRiskPage(browser, viewport, async (page, context) => {
        await openHighRiskRoute(page, context, route.path);
        if (route.name === 'group overview') await expect(page.locator('.group-overview-card')).toHaveCount(4);
        if (route.name === 'chooser') await expect(page.locator('.chooser-options')).toBeVisible();
        if (route.name === 'management') await expect(page.locator('#people')).toBeVisible();
        const flow = await page.evaluate(({ frequentSelector, adminSelector }) => {
          const visible = (element: Element) => {
            const style = getComputedStyle(element);
            const box = element.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
          };
          const regions = (selector: string) => Array.from(document.querySelectorAll<HTMLElement>(selector)).filter(visible).map((element) => ({ element, top: element.getBoundingClientRect().top, bottom: element.getBoundingClientRect().bottom }));
          const frequent = regions('[data-flow-region="frequent"]');
          const admin = regions('[data-flow-region="admin"]');
          const primary = frequent.filter(({ element }) => element.querySelector('[data-primary-action="true"],button[type="submit"],a.button:not(.button--secondary):not(.button--danger)'));
          const all = [...frequent.map((region) => ({ ...region, kind: 'frequent' })), ...admin.map((region) => ({ ...region, kind: 'admin' }))].sort((first, second) => first.element.compareDocumentPosition(second.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
          const gaps = all.slice(1).map((region, index) => region.top - all[index].bottom);
          return { frequentCount: frequent.length, adminCount: admin.length, primaryCount: primary.length, invalidOrder: all.some((region, index) => region.kind === 'admin' && all.slice(index + 1).some((next) => next.kind === 'frequent')), gaps, documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), viewportWidth: window.innerWidth, requiredFrequent: frequentSelector, requiredAdmin: adminSelector };
        }, { frequentSelector: route.frequent, adminSelector: route.admin });
        expect(flow.frequentCount, `${route.name} @ ${viewport.width}px frequent regions`).toBeGreaterThan(0);
        expect(flow.primaryCount, `${route.name} @ ${viewport.width}px primary actions`).toBeGreaterThan(0);
        expect(flow.invalidOrder, `${route.name} @ ${viewport.width}px primary/admin order`).toBe(false);
        expect(flow.gaps.every((gap) => gap >= -1), `${route.name} @ ${viewport.width}px overlapping flow regions`).toBe(true);
        expect(flow.documentWidth, `${route.name} @ ${viewport.width}px document overflow`).toBeLessThanOrEqual(flow.viewportWidth + 1);
      });
    }
  }
});

test('chooser states are truthful when a loaded chooser loses its connection', async ({ browser }) => {
  const chooserViewports = [{ width: 320, height: 844 }, { width: 895, height: 900 }, { width: 896, height: 900 }, { width: 1440, height: 900 }];
  for (const viewport of chooserViewports) {
    await withHighRiskPage(browser, viewport, async (page, context) => {
      await openHighRiskRoute(page, context, `/groups/${ids.rich}/add`);
      await expect(page.locator('.chooser-options')).toHaveCount(1);
      await setHighRiskOffline(page, context);
      await expect(page.getByRole('status').filter({ hasText: 'Refunds and payments are online-only' })).toBeVisible();
      await expect(page.locator('.chooser-options [data-primary-action="true"]')).toBeEnabled();
      const unavailable = page.locator('.chooser-options button:disabled');
      await expect(unavailable).toHaveCount(2);
      await expect(unavailable.nth(0)).toContainText('(online only)');
      await expect(unavailable.nth(1)).toContainText('(online only)');
    });
  }
});

test('client-side route changes restore scroll while hash links focus their targets', async ({ authenticatedPage: page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto(`${BASE_URL}/groups/${ids.rich}`);
  await expect(page.locator('.transaction-row--overview').first()).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await page.locator('.bottom-nav').getByRole('link', { name: 'History', exact: true }).click();
  await expect(page).toHaveURL(/\/activity/);
  await expect(page.locator('.activity-list')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);

  await page.locator('.bottom-nav').getByRole('link', { name: 'Groups', exact: true }).click();
  await expect(page).toHaveURL(`${BASE_URL}/`);
  await page.locator('.group-card').first().click();
  await expect(page).toHaveURL(/\/groups\/[0-9a-f-]+$/);
  await expect(page.getByRole('link', { name: 'Manage people', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Manage people', exact: true }).click();
  await expect(page).toHaveURL(/\/manage#people$/);
  await expect(page.locator('#people')).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('people');
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
});

test('currency insight deep links restore the selected tab without filtering API data', async ({ browser }) => {
  for (const viewport of [{ width: 320, height: 844 }, { width: 1440, height: 900 }]) {
    const context = await newAuthenticatedContext(browser, DEV_EMAIL, viewport);
    const page = await context.newPage();
    const insightRequests: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname === apiPaths.spendingInsights) insightRequests.push(url.href);
    });
    const fixture = populatedInsightFixture('global');
    await page.route('**/api/spending-insights*', (route) => {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(new URL(route.request().url()).searchParams.get('view') === 'trends' ? fixture.trends : fixture.summary) });
    });
    try {
      await page.goto(`${BASE_URL}/activity?view=insights&period=month&currency=USD`, { waitUntil: 'domcontentloaded' });
      const selectedTab = page.locator('.insight-currency-tab[aria-selected="true"]');
      const panel = page.locator('.insight-currency-panel');
      await expect(selectedTab).toHaveText('USD');
      await expect(panel.locator('.insight-summary-card')).toContainText('USD');
      await expect(panel.locator('.insight-category-trends')).toContainText('USD');
      await expect(panel.locator('.insight-summary-card')).toContainText('(new)');
      expect(new URL(page.url()).searchParams.get('currency')).toBe('USD');

       const tablist = page.getByRole('tablist', { name: 'Spending insight currencies' });
       const tablistLayout = await tablist.evaluate((element) => ({ display: getComputedStyle(element).display, flexWrap: getComputedStyle(element).flexWrap, overflowX: getComputedStyle(element).overflowX, documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), targets: Array.from(element.querySelectorAll('button')).map((button) => ({ width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height })) }));
       if (tablistLayout.display !== 'flex' || tablistLayout.flexWrap !== 'nowrap' || !['auto', 'scroll'].includes(tablistLayout.overflowX) || tablistLayout.documentWidth > viewport.width + 1 || tablistLayout.targets.some((target) => target.width < 44 || target.height < 44)) throw new Error(`Currency tablist failed ${viewport.width}px layout constraints: ${JSON.stringify(tablistLayout)}`);

       const categoryGraph = page.locator('.category-trend-figure');
       const categoryPlot = categoryGraph.locator('.category-trend-bars');
       await expect(categoryGraph).toHaveCount(1);
       await expect(categoryPlot).toHaveAttribute('tabindex', '0');
       await expect(categoryPlot).toHaveAttribute('aria-label', 'USD category spending chart');
       await expect(categoryGraph.getByRole('table', { name: 'Exact displayed-span USD values by category', exact: true })).toHaveCount(1);
         const { displayedMonths, categories } = displayedFixtureTrend(fixture, 'allocatedSpendMinor');
         const categoryCount = categories.length;
        const actualMonthCount = await categoryPlot.locator('.category-trend-month').count();
        const actualBarCount = await categoryPlot.locator('.category-trend-bar').count();
        const actualCategoryCount = await categoryGraph.locator('.category-trend-summary').count();
        if (actualMonthCount !== displayedMonths.length || actualBarCount !== displayedMonths.length * categoryCount || actualCategoryCount !== categoryCount) throw new Error(`Grouped category chart fixture is incomplete at ${viewport.width}px: expected ${displayedMonths.length}/${displayedMonths.length * categoryCount}/${categoryCount}, got ${actualMonthCount}/${actualBarCount}/${actualCategoryCount}`);
       const categoryColors = await categoryGraph.locator('.category-trend-summary').evaluateAll((elements) => elements.map((element) => { const marker = element.querySelector('.category-trend-marker'); return { category: element.getAttribute('data-category'), color: marker ? getComputedStyle(marker).backgroundColor : '' }; }));
       const barColors = await categoryPlot.locator('.category-trend-bar').evaluateAll((elements) => elements.map((element) => ({ category: element.getAttribute('data-category'), color: getComputedStyle(element).backgroundColor })));
       const barColorMismatch = barColors.some((bar) => { const summary = categoryColors.find((candidate) => candidate.category === bar.category); return !summary || summary.color !== bar.color; });
       if (barColorMismatch) throw new Error(`Grouped category bars did not match their legend markers at ${viewport.width}px`);
       const categoryLayout = await categoryPlot.evaluate((element) => ({ overflowX: getComputedStyle(element).overflowX, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) }));
       if (viewport.width === 320) {
         if (!['auto', 'scroll'].includes(categoryLayout.overflowX) || categoryLayout.scrollWidth <= categoryLayout.clientWidth || categoryLayout.documentWidth > viewport.width + 1) throw new Error('320px grouped category plot did not contain its internal overflow');
       } else if (categoryLayout.scrollWidth > categoryLayout.clientWidth + 1 || categoryLayout.documentWidth > viewport.width + 1) {
         throw new Error('1440px grouped category plot did not fit without document overflow');
       }

      const eurTab = tablist.getByRole('tab', { name: 'EUR', exact: true });
      await eurTab.click();
      await expect(page.locator('.insight-currency-tab[aria-selected="true"]')).toHaveText('EUR');
      expect(new URL(page.url()).searchParams.get('currency')).toBe('EUR');
      await expect(panel.locator('.insight-summary-card')).toContainText('EUR');
      await expect(panel.locator('.insight-category-trends')).toContainText('EUR');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.locator('.insight-currency-tab[aria-selected="true"]')).toHaveText('EUR');
      expect(new URL(page.url()).searchParams.get('currency')).toBe('EUR');
      await expect(panel.locator('.insight-summary-card')).toContainText('EUR');
      await expect(panel.locator('.insight-category-trends')).toContainText('EUR');
      expect(insightRequests.length).toBeGreaterThan(0);
      expect(insightRequests.every((requestUrl) => !new URL(requestUrl).searchParams.has('currency'))).toBe(true);
    } finally {
      await context.close();
    }
  }
});

test('labels the displayed current month MTD and uses it for category references', async ({ browser }) => {
  const context = await newAuthenticatedContext(browser, DEV_EMAIL, { width: 1440, height: 900 });
  const page = await context.newPage();
  const fixture = populatedInsightFixture('global');
  const currentMonth = fixture.trends.trendTo.slice(0, 7);
  const currentFixture = {
    ...fixture,
    trends: {
      ...fixture.trends,
      categoryTrends: [...fixture.trends.categoryTrends, { currency: 'USD' as const, bucket: currentMonth, category: 'Category A', groupSpendMinor: 321000, allocatedSpendMinor: 160500, expenseCount: 1 }],
    },
  };
  await page.route('**/api/spending-insights*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(new URL(route.request().url()).searchParams.get('view') === 'trends' ? currentFixture.trends : currentFixture.summary) }));
  try {
    await page.goto(`${BASE_URL}/activity?view=insights&period=month`, { waitUntil: 'domcontentloaded' });
    const graph = page.locator('.category-trend-figure');
    await expect(graph).toHaveCount(1);
    const axisLabels = graph.locator('.category-trend-month small');
    await expect(axisLabels.filter({ hasText: 'MTD' })).toHaveCount(1);
    await expect(axisLabels.filter({ hasText: `${utcMonthLabel(currentMonth)} MTD` })).toHaveCount(1);
    const references = graph.locator('.category-trend-current');
    await expect(references).toHaveCount(4);
    for (const reference of await references.all()) await expect(reference).toContainText('MTD');
    await expect(graph.locator('thead th').filter({ hasText: 'MTD' })).toHaveCount(1);
  } finally {
    await context.close();
  }
});

test('intercepted loading, API error, offline, and modal states render their intended UI', async ({ browser }, testInfo) => {
  test.setTimeout(480_000);
  const findings: Finding[] = [];
  const failures: HarnessFailure[] = [];
  const coverage: Coverage[] = [];
  const artifactDirectory = auditArtifactDirectory('intercepted');
  const stateViewports = viewports;
  for (const viewport of stateViewports) {
    const errorScenario: Scenario = { name: 'state-api-error', path: '/', auth: DEV_EMAIL, context: 'Home / intercepted groups API error', expected: { mode: 'api-error', heading: 'Friends & groups', content: 'Fixture outage', apiPaths: [apiPaths.me], apiFailures: [{ path: apiPaths.groups, status: 503 }] } };
    const errorContext = await newAuthenticatedContext(browser, DEV_EMAIL, viewport);
    const errorPage = await errorContext.newPage();
    const errorObservations: ApiObservation[] = [];
    await observeResponses(errorPage, errorObservations);
    const errorRequests: ApiRequestObservation[] = [];
    observeRequests(errorPage, errorRequests);
      await errorPage.route('**/api/groups*', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'AUDIT_SERVICE_UNAVAILABLE', message: 'Fixture outage' } }) }));
    try {
      await errorPage.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
      await expect(errorPage.locator('#groups-error')).toBeVisible();
      assertAuthenticatedRequest(errorRequests, DEV_EMAIL);
      await assertRendered(errorPage, errorScenario, errorObservations, viewport);
      coverage.push({ scenarioName: errorScenario.name, authState: authState(errorScenario.auth), route: errorScenario.path, viewport, context: errorScenario.context, rendered: true, apiSuccesses: errorObservations.filter((observation) => observation.status >= 200 && observation.status < 300).map((observation) => observation.path) });
      await reportForPage(errorPage, errorScenario, '/ [API error]', viewport, artifactDirectory, findings, failures);
    } catch (error) {
      failures.push({ scenarioName: errorScenario.name, authState: authState(errorScenario.auth), route: '/ [API error]', viewport, detail: `Intercepted API-error validation failed: ${error instanceof Error ? error.message : String(error)}` });
    } finally {
      await errorContext.close();
    }

     const insightsErrorScenario: Scenario = { name: 'state-insights-error', path: '/activity?view=insights&period=all', auth: DEV_EMAIL, context: 'History insights / independent summary and trend API errors', expected: { mode: 'insights-error', heading: 'History', content: 'Spending insights', apiPaths: [apiPaths.me, apiPaths.groups], apiFailures: [{ path: apiPaths.spendingInsights, status: 400 }], insightErrors: [{ id: 'insights-summary-error', message: 'Insights fixture rejected' }, { id: 'insights-trends-error', message: 'Insights fixture rejected' }] } };
    const insightsErrorContext = await newAuthenticatedContext(browser, DEV_EMAIL, viewport);
    const insightsErrorPage = await insightsErrorContext.newPage();
    const insightsErrorObservations: ApiObservation[] = [];
    await observeResponses(insightsErrorPage, insightsErrorObservations);
    const insightsErrorRequests: ApiRequestObservation[] = [];
    observeRequests(insightsErrorPage, insightsErrorRequests);
     await insightsErrorPage.route('**/api/spending-insights*', (route) => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INVALID_FILTER', message: 'Insights fixture rejected' } }) }));
     try {
       await insightsErrorPage.goto(`${BASE_URL}${insightsErrorScenario.path}`, { waitUntil: 'domcontentloaded' });
       await expect(insightsErrorPage.locator('#insights-summary-error')).toBeVisible();
       await expect(insightsErrorPage.locator('#insights-trends-error')).toBeVisible();
      assertAuthenticatedRequest(insightsErrorRequests, DEV_EMAIL);
      await assertRendered(insightsErrorPage, insightsErrorScenario, insightsErrorObservations, viewport);
      coverage.push({ scenarioName: insightsErrorScenario.name, authState: authState(insightsErrorScenario.auth), route: insightsErrorScenario.path, viewport, context: insightsErrorScenario.context, rendered: true, apiSuccesses: insightsErrorObservations.filter((observation) => observation.status >= 200 && observation.status < 300).map((observation) => observation.path) });
      await reportForPage(insightsErrorPage, insightsErrorScenario, insightsErrorScenario.path, viewport, artifactDirectory, findings, failures);
    } catch (error) {
      failures.push({ scenarioName: insightsErrorScenario.name, authState: authState(insightsErrorScenario.auth), route: insightsErrorScenario.path, viewport, detail: `Intercepted insights-error validation failed: ${error instanceof Error ? error.message : String(error)}` });
     } finally {
       await insightsErrorContext.close();
     }

     for (const independent of [
       { name: 'state-insights-summary-success-trends-error', failedView: 'trends', errorId: 'insights-trends-error', message: 'Trend fixture rejected' },
       { name: 'state-insights-summary-error-trends-success', failedView: 'summary', errorId: 'insights-summary-error', message: 'Summary fixture rejected' },
     ]) {
       const scenario: Scenario = { name: independent.name, path: '/activity?view=insights&period=all', auth: DEV_EMAIL, context: `History insights / ${independent.failedView} resource failure with independent sibling success`, expected: { mode: 'insights-error', heading: 'History', content: 'Spending insights', apiPaths: [apiPaths.me, apiPaths.groups, apiPaths.spendingInsights], apiFailures: [{ path: apiPaths.spendingInsights, status: 400 }], insightErrors: [{ id: independent.errorId, message: independent.message }] } };
       const context = await newAuthenticatedContext(browser, DEV_EMAIL, viewport);
       const page = await context.newPage();
       const observations: ApiObservation[] = [];
       await observeResponses(page, observations);
       const requests: ApiRequestObservation[] = [];
       observeRequests(page, requests);
       await page.route('**/api/spending-insights*', (route) => {
         const isFailedView = new URL(route.request().url()).searchParams.get('view') === independent.failedView;
         if (isFailedView) return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INVALID_FILTER', message: independent.message } }) });
         const fixture = populatedInsightFixture('global');
         return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(new URL(route.request().url()).searchParams.get('view') === 'trends' ? fixture.trends : fixture.summary) });
       });
        try {
          await page.goto(`${BASE_URL}${scenario.path}`, { waitUntil: 'domcontentloaded' });
          await expect(page.locator(`#${independent.errorId}`)).toContainText(independent.message);
         assertAuthenticatedRequest(requests, DEV_EMAIL);
          await assertRendered(page, scenario, observations, viewport);
         if (independent.failedView === 'trends') {
           if (await page.locator('.insight-summary-grid').count() !== 1) throw new Error('Summary-success sibling did not render its summary grid');
          } else if (await page.locator('.category-trend-figure').count() === 0) {
            throw new Error('Trend-success sibling did not render a populated grouped category chart');
         }
         coverage.push({ scenarioName: scenario.name, authState: authState(scenario.auth), route: scenario.path, viewport, context: scenario.context, rendered: true, apiSuccesses: observations.filter((observation) => observation.status >= 200 && observation.status < 300).map((observation) => observation.path) });
         await reportForPage(page, scenario, scenario.path, viewport, artifactDirectory, findings, failures);
       } catch (error) {
         failures.push({ scenarioName: scenario.name, authState: authState(scenario.auth), route: scenario.path, viewport, detail: `Independent insights resource validation failed: ${error instanceof Error ? error.message : String(error)}` });
       } finally {
         await context.close();
       }
     }

    const loadingScenario: Scenario = { name: 'state-insights-loading', path: '/activity?view=insights&period=all', auth: DEV_EMAIL, context: 'History insights / intercepted spending-insights loading state', expected: { mode: 'insights-loading', heading: 'History', content: 'Spending insights', apiPaths: [apiPaths.me, apiPaths.groups] } };
    const loadingContext = await newAuthenticatedContext(browser, DEV_EMAIL, viewport);
    const loadingPage = await loadingContext.newPage();
    const loadingObservations: ApiObservation[] = [];
    await observeResponses(loadingPage, loadingObservations);
    const loadingRequests: ApiRequestObservation[] = [];
    observeRequests(loadingPage, loadingRequests);
    await loadingPage.route('**/api/spending-insights*', async (route) => { await new Promise((resolve) => setTimeout(resolve, 1_000)); await route.continue(); });
     try {
       await loadingPage.goto(`${BASE_URL}${loadingScenario.path}`, { waitUntil: 'domcontentloaded' });
       await expect(loadingPage.getByRole('status').filter({ hasText: 'Loading' }).first()).toBeVisible();
      assertAuthenticatedRequest(loadingRequests, DEV_EMAIL);
      await assertRendered(loadingPage, loadingScenario, loadingObservations, viewport);
      coverage.push({ scenarioName: loadingScenario.name, authState: authState(loadingScenario.auth), route: loadingScenario.path, viewport, context: loadingScenario.context, rendered: true, apiSuccesses: loadingObservations.filter((observation) => observation.status >= 200 && observation.status < 300).map((observation) => observation.path) });
      await reportForPage(loadingPage, loadingScenario, loadingScenario.path, viewport, artifactDirectory, findings, failures);
    } catch (error) {
      failures.push({ scenarioName: loadingScenario.name, authState: authState(loadingScenario.auth), route: loadingScenario.path, viewport, detail: `Intercepted insights-loading validation failed: ${error instanceof Error ? error.message : String(error)}` });
    } finally {
      await loadingContext.close();
    }

    const offlineScenario: Scenario = { name: 'state-insights-offline', path: '/activity?view=insights&period=all', auth: DEV_EMAIL, context: 'History insights / verified fixture followed by offline transition', expected: { mode: 'offline', heading: 'History', content: 'Refresh is unavailable offline', apiPaths: [apiPaths.me, apiPaths.groups, apiPaths.spendingInsights] } };
    const offlineContext = await newAuthenticatedContext(browser, DEV_EMAIL, viewport);
    const offlinePage = await offlineContext.newPage();
     const offlineObservations: ApiObservation[] = [];
     await observeResponses(offlinePage, offlineObservations);
     const offlineRequests: ApiRequestObservation[] = [];
     observeRequests(offlinePage, offlineRequests);
     await offlinePage.route('**/api/spending-insights*', (route) => { const fixture = populatedInsightFixture('global'); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(new URL(route.request().url()).searchParams.get('view') === 'trends' ? fixture.trends : fixture.summary) }); });
     try {
       await offlinePage.goto(`${BASE_URL}${offlineScenario.path}`, { waitUntil: 'domcontentloaded' });
       await expect(offlinePage.locator('.category-trend-figure')).toBeVisible();
      assertAuthenticatedRequest(offlineRequests, DEV_EMAIL);
       await assertRendered(offlinePage, { ...offlineScenario, expected: { ...offlineScenario.expected, mode: 'normal', content: 'Spending insights' } }, offlineObservations, viewport);
       await offlineContext.setOffline(true);
       await offlinePage.evaluate(() => window.dispatchEvent(new Event('offline')));
       await expect(offlinePage.locator('.offline-banner')).toBeVisible();
        await assertRendered(offlinePage, offlineScenario, offlineObservations, viewport);
        expect(await offlinePage.locator('.category-trend-figure').count()).toBeGreaterThan(0);
      coverage.push({ scenarioName: offlineScenario.name, authState: authState(offlineScenario.auth), route: offlineScenario.path, viewport, context: offlineScenario.context, rendered: true, apiSuccesses: offlineObservations.filter((observation) => observation.status >= 200 && observation.status < 300).map((observation) => observation.path) });
      await reportForPage(offlinePage, offlineScenario, `${offlineScenario.path} [offline]`, viewport, artifactDirectory, findings, failures);
    } catch (error) {
      failures.push({ scenarioName: offlineScenario.name, authState: authState(offlineScenario.auth), route: `${offlineScenario.path} [offline]`, viewport, detail: `Intercepted offline validation failed: ${error instanceof Error ? error.message : String(error)}` });
     } finally {
       await offlineContext.close();
     }

     const coldOfflineScenario: Scenario = { name: 'state-insights-cold-offline', path: '/activity?view=insights', auth: DEV_EMAIL, context: 'History insights / uncached summary and trends while the surrounding history shell is retained', expected: { mode: 'offline', heading: 'History', content: 'Selected-period summary is unavailable offline', apiPaths: [apiPaths.me, apiPaths.groups] } };
     const coldOfflineContext = await newAuthenticatedContext(browser, DEV_EMAIL, viewport);
     const coldOfflinePage = await coldOfflineContext.newPage();
     const coldOfflineObservations: ApiObservation[] = [];
     await observeResponses(coldOfflinePage, coldOfflineObservations);
     const coldOfflineRequests: ApiRequestObservation[] = [];
     observeRequests(coldOfflinePage, coldOfflineRequests);
      try {
        await coldOfflinePage.goto(`${BASE_URL}/activity?view=changes`, { waitUntil: 'domcontentloaded' });
        await expect(coldOfflinePage.locator('main')).toContainText('History');
       await coldOfflineContext.setOffline(true);
        await coldOfflinePage.evaluate(() => window.dispatchEvent(new Event('offline')));
        await coldOfflinePage.getByRole('link', { name: 'Insights', exact: true }).click();
        await expect(coldOfflinePage.locator('main')).toContainText('Selected-period summary is unavailable offline');
       assertAuthenticatedRequest(coldOfflineRequests, DEV_EMAIL);
        await assertRendered(coldOfflinePage, coldOfflineScenario, coldOfflineObservations, viewport);
        expect(await coldOfflinePage.getByText('Category trends are unavailable offline; no cached data is available.', { exact: true }).count()).toBe(1);
       expect(await coldOfflinePage.getByText('Loading…', { exact: true }).count()).toBe(0);
       coverage.push({ scenarioName: coldOfflineScenario.name, authState: authState(coldOfflineScenario.auth), route: coldOfflineScenario.path, viewport, context: coldOfflineScenario.context, rendered: true, apiSuccesses: coldOfflineObservations.filter((observation) => observation.status >= 200 && observation.status < 300).map((observation) => observation.path) });
       await reportForPage(coldOfflinePage, coldOfflineScenario, coldOfflineScenario.path, viewport, artifactDirectory, findings, failures);
     } catch (error) {
       failures.push({ scenarioName: coldOfflineScenario.name, authState: authState(coldOfflineScenario.auth), route: coldOfflineScenario.path, viewport, detail: `Cold offline insights validation failed: ${error instanceof Error ? error.message : String(error)}` });
     } finally {
       await coldOfflineContext.close();
     }
   }
  const report = await writeAuditAttachment(testInfo, artifactDirectory, 'audit-findings.json', findings, failures, coverage, [
     'Intercepted detailed insight loading, independent API-error, retained-cache offline, and cold-offline states are covered across every configured viewport, including 895px, 896px, and 1440px.',
    'The schedule disclosure state matrix uses bounded fixture/interception coverage at 390px; populated disclosure geometry is exercised across the full responsive matrix.',
     'Payer modal coverage is exercised at all canonical widths: 320px, 390px, 768px, 895px, 896px, and 1440px.',
  ]);
  expect(report.findings.filter((finding) => finding.severity === 'critical' || finding.severity === 'major'), 'The intercepted-state audit must not contain critical or major geometry findings').toEqual([]);
  expect(failures, 'Intercepted-state screenshots should complete without harness failures').toEqual([]);
});

test('auth refresh keeps private shell geometry stable while identity and groups load', async ({ browser }) => {
  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
    const context = await newAuthenticatedContext(browser, DEV_EMAIL, viewport);
    const page = await context.newPage();
    await page.route('**/api/me', async (route) => { await new Promise((resolve) => setTimeout(resolve, 600)); await route.continue(); });
    await page.route('**/api/groups*', async (route) => { await new Promise((resolve) => setTimeout(resolve, 600)); await route.continue(); });
    await page.addInitScript(() => {
      let value = 0;
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const shift = entry as PerformanceEntry & { hadRecentInput?: boolean; value?: number };
          if (!shift.hadRecentInput) value += shift.value || 0;
        }
      });
      observer.observe({ type: 'layout-shift', buffered: false });
      (window as Window & { __billSplitRefreshLayoutShift?: () => number }).__billSplitRefreshLayoutShift = () => value;
    });
    try {
      await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('.auth-loading-shell')).toBeVisible();
      await page.evaluate(() => {
        let value = 0;
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            const shift = entry as PerformanceEntry & { hadRecentInput?: boolean; value?: number };
            if (!shift.hadRecentInput) value += shift.value || 0;
          }
        });
        observer.observe({ type: 'layout-shift', buffered: false });
        (window as Window & { __billSplitLayoutShift?: () => number }).__billSplitLayoutShift = () => value;
      });
      const loadingGeometry = await page.evaluate(() => {
        const topbar = document.querySelector('.top-bar')?.getBoundingClientRect();
        const main = document.querySelector('.app-main')?.getBoundingClientRect();
        const bottom = document.querySelector('.bottom-nav');
        return { topbarHeight: topbar?.height || 0, mainTop: main?.top || 0, bottomDisplay: bottom ? getComputedStyle(bottom).display : 'none', bottomHeight: bottom?.getBoundingClientRect().height || 0 };
      });
      const homePlaceholder = page.locator('.route-loading--home');
      await expect(homePlaceholder).toBeVisible({ timeout: 15_000 });
      await expect(homePlaceholder).toBeHidden({ timeout: 15_000 });
      await expect(page.locator('.cards')).toBeVisible({ timeout: 15_000 });
      const result = await page.evaluate(() => {
        const topbar = document.querySelector('.top-bar')?.getBoundingClientRect();
        const main = document.querySelector('.app-main')?.getBoundingClientRect();
        const bottom = document.querySelector('.bottom-nav');
        const layoutShift = (window as Window & { __billSplitLayoutShift?: () => number }).__billSplitLayoutShift?.() || 0;
        return { topbarHeight: topbar?.height || 0, mainTop: main?.top || 0, bottomDisplay: bottom ? getComputedStyle(bottom).display : 'none', bottomHeight: bottom?.getBoundingClientRect().height || 0, layoutShift };
      });
      expect(Math.abs(result.topbarHeight - loadingGeometry.topbarHeight)).toBeLessThanOrEqual(1);
      expect(Math.abs(result.mainTop - loadingGeometry.mainTop)).toBeLessThanOrEqual(1);
      expect(result.bottomDisplay).toBe(loadingGeometry.bottomDisplay);
      expect(Math.abs(result.bottomHeight - loadingGeometry.bottomHeight)).toBeLessThanOrEqual(1);
      expect(result.layoutShift).toBeLessThan(0.1);
      await page.reload({ waitUntil: 'domcontentloaded' });
      const refreshedPlaceholder = page.locator('.route-loading--home');
      await expect(refreshedPlaceholder).toBeHidden({ timeout: 15_000 });
      await expect(page.locator('.cards')).toBeVisible({ timeout: 15_000 });
      const refreshed = await page.evaluate(() => {
        const topbar = document.querySelector('.top-bar')?.getBoundingClientRect();
        const main = document.querySelector('.app-main')?.getBoundingClientRect();
        const bottom = document.querySelector('.bottom-nav');
        const layoutShift = (window as Window & { __billSplitRefreshLayoutShift?: () => number }).__billSplitRefreshLayoutShift?.() || 0;
        return { topbarHeight: topbar?.height || 0, mainTop: main?.top || 0, bottomDisplay: bottom ? getComputedStyle(bottom).display : 'none', bottomHeight: bottom?.getBoundingClientRect().height || 0, layoutShift };
      });
      expect(Math.abs(refreshed.topbarHeight - result.topbarHeight)).toBeLessThanOrEqual(1);
      expect(Math.abs(refreshed.mainTop - result.mainTop)).toBeLessThanOrEqual(1);
      expect(refreshed.bottomDisplay).toBe(result.bottomDisplay);
      expect(Math.abs(refreshed.bottomHeight - result.bottomHeight)).toBeLessThanOrEqual(1);
      expect(refreshed.layoutShift).toBeLessThan(0.1);
    } finally {
      await context.close();
    }
  }
});
