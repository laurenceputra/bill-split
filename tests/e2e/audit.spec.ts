import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, newAuthenticatedContext, BASE_URL, DEV_EMAIL, EMPTY_EMAIL, expect } from './fixtures';
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
  { width: 390, height: 844 },
  { width: 430, height: 844 },
  { width: 768, height: 1024 },
  { width: 895, height: 900 },
  { width: 896, height: 900 },
  { width: 1440, height: 900 },
];
const insightViewports: Viewport[] = [{ width: 320, height: 844 }, ...viewports];

const ids = {
  rich: '00000000-0000-4000-8000-000000003002',
  large: '00000000-0000-4000-8000-000000003003',
  dinner: '00000000-0000-4000-8000-000000004001',
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
const groupApis = (id: string) => [apiPaths.me, apiPaths.group(id), apiPaths.transactions(id), apiPaths.balances(id), apiPaths.scheduledExpenses(id), apiPaths.spendingInsights];
const groupManagementApis = (id: string) => [apiPaths.me, apiPaths.group(id), apiPaths.invitations(id)];
const scenarios: Scenario[] = [
  { name: 'public-landing', path: '/', auth: undefined, context: 'PublicLanding / signed-out marketing shell', expected: { mode: 'normal', heading: 'Know who paid. Know what is still owed.', content: 'Private, even when offline' } },
  { name: 'populated-home', path: '/', auth: DEV_EMAIL, context: 'Home / populated groups fixture', expected: { mode: 'normal', heading: 'Friends & groups', content: 'Europe trip · USD + EUR', apiPaths: privateHomeApis } },
  { name: 'empty-home', path: '/', auth: EMPTY_EMAIL, context: 'Home / empty groups fixture', expected: { mode: 'normal', heading: 'Friends & groups', content: 'No groups yet', apiPaths: privateHomeApis } },
  { name: 'rich-group', path: `/groups/${ids.rich}`, auth: DEV_EMAIL, context: 'GroupPage / rich multi-currency fixture', expected: { mode: 'normal', heading: 'Europe trip · USD + EUR', content: 'Scheduled expenses', apiPaths: groupApis(ids.rich) } },
  { name: 'group-management', path: `/groups/${ids.rich}/manage`, auth: DEV_EMAIL, context: 'GroupManagement / owner people, invitations, and split-default controls', expected: { mode: 'normal', heading: 'Manage group', content: 'People', apiPaths: groupManagementApis(ids.rich) } },
  { name: 'transaction-history', path: `/groups/${ids.rich}/transactions`, finalPath: `/activity?group=${ids.rich}&view=transactions`, auth: DEV_EMAIL, context: 'Legacy transaction route / canonical History transactions tab fixture', expected: { mode: 'normal', heading: 'History', content: 'Search and filters', apiPaths: [apiPaths.me, apiPaths.groups, apiPaths.group(ids.rich), apiPaths.globalTransactions, apiPaths.categories] } },
  { name: 'large-group', path: `/groups/${ids.large}`, auth: DEV_EMAIL, context: 'Group overview / long-member-label fixture', expected: { mode: 'normal', heading: 'Very large group with a name that should remain contained at narrow widths', content: 'Recent transactions', apiPaths: groupApis(ids.large) } },
  { name: 'expense-form', path: `/groups/${ids.rich}/expense/new`, auth: DEV_EMAIL, context: 'ExpenseForm / new expense fixture', expected: { mode: 'normal', heading: 'Add expense', content: 'Split between', apiPaths: [apiPaths.me, apiPaths.group(ids.rich)] } },
  { name: 'scheduled-expense-form', path: `/groups/${ids.rich}/expense/new?recurrence=1`, auth: DEV_EMAIL, context: 'Legacy recurring route / redirected new expense fixture', expected: { mode: 'normal', heading: 'Schedule an expense', content: 'Repeat this expense', apiPaths: [apiPaths.me, apiPaths.group(ids.rich)] } },
  { name: 'expense-detail-history', path: `/groups/${ids.rich}/expenses/${ids.dinner}`, auth: DEV_EMAIL, context: 'ExpenseDetail / edited dinner with closed and expanded audit disclosure states', expected: { mode: 'normal', heading: 'Dinner by the canal (edited)', content: 'History', apiPaths: [apiPaths.me, apiPaths.expense(ids.dinner), apiPaths.group(ids.rich)] }, expandedAudit: { entityType: 'expense', entityId: ids.dinner, content: 'Updated expense' } },
  { name: 'settlement-detail-history', path: `/groups/${ids.rich}/settlements/00000000-0000-4000-8000-000000005001`, auth: DEV_EMAIL, context: 'SettlementDetail / edited payment with closed and expanded audit disclosure states', expected: { mode: 'normal', heading: 'paid', content: 'View audit history', apiPaths: [apiPaths.me, apiPaths.settlement('00000000-0000-4000-8000-000000005001'), apiPaths.group(ids.rich), apiPaths.balances(ids.rich)] }, expandedAudit: { entityType: 'settlement', entityId: '00000000-0000-4000-8000-000000005001', content: 'Updated settlement' } },
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
    const auditTarget = (element: Element) => visible(element) && !element.matches('.skip-link') && !(modalIsVisible && !modal?.contains(element));
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
      const content = Array.from(main.querySelectorAll('h1,h2,h3,h4,p,a,button,input,select,textarea,fieldset,form,li,.card,.list,.row,.empty,.error,.offline-banner,.chip,.actions,.form-row,.field,.section-title,.page-title'))
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

    for (const element of Array.from(document.querySelectorAll('.surface,section,.card,.empty')).filter(visible)) {
      if (element.matches('.insight-section')) continue;
      const style = getComputedStyle(element);
      const padding = Math.min(parseFloat(style.paddingTop), parseFloat(style.paddingRight), parseFloat(style.paddingBottom), parseFloat(style.paddingLeft));
      if (padding < 12) add('surface-padding', 'minor', `Flow surface internal padding is ${padding}px; expected at least 12px`, selector(element), padding);
    }

    const surfaceRootSelector = '.surface,section,.card,.empty,.error,.offline-banner,.schedule-preview,.recurrence-toggle,.summary-row,.participant-row,.method-row,.member-row,.insight-metric,.insight-summary-card,.insight-category-trends,.balance-card,.route-loading__card,.app-error-boundary__card,.ledger-preview,.modal-sheet,[role="dialog"]';
    const paintedSurface = (element: Element) => {
      if (!element.matches(surfaceRootSelector)) return false;
      const style = getComputedStyle(element);
      const hasBorder = ['Top', 'Right', 'Bottom', 'Left'].some((side) => Number.parseFloat(style[`border${side}Width` as 'borderTopWidth']) > 0 && style[`border${side}Style` as 'borderTopStyle'] !== 'none');
      const hasBackground = style.backgroundColor !== 'transparent' && style.backgroundColor !== 'rgba(0, 0, 0, 0)';
      return hasBorder || hasBackground || style.boxShadow !== 'none';
    };
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

    const flowSurface = (element: Element) => element.matches('.surface,section,.card,.empty,.offline-banner,.error,.list,.secondary-fields,.landing-note,.landing-proof > div');
    const meaningfulFlowContent = (element: Element) => flowSurface(element) || element.matches('h1,h2,h3,h4,p,form,fieldset,ul,ol,dl,table,article,header,aside,nav,.page-title,.section-title,.chips,.actions,.form-row,.field,.notes,.category,.title,.cluster,.notice,[class*="title"],[class*="cluster"],[class*="notice"]');
    const flowContainer = (element: Element) => meaningfulFlowContent(element) || element.matches('div') && Array.from(element.children).some((child) => child.matches('h1,h2,h3,h4,.list,.chips,form,fieldset,.error,.offline-banner,.empty,[class*="title"],[class*="cluster"]'));
    const hasBorder = (style: CSSStyleDeclaration, side: 'top' | 'bottom') => ['solid', 'dashed', 'dotted', 'double'].includes(side === 'top' ? style.borderTopStyle : style.borderBottomStyle);
    const intentionallyConnected = (element: Element, next: Element, parent: Element) => {
      if (!parent || parent !== next.parentElement) return false;
      if (element.matches('.row,.participant-row,.allocation-row,.payer-row') && next.matches('.row,.participant-row,.allocation-row,.payer-row')) return true;
      if (parent.matches('.list,.participant-list,.allocation-list,.payer-list,.bottom-nav,.desktop-nav,[role="group"]')) return true;
      if (parent.matches('.section-title,.page-title,.top-bar__actions,.home-actions,.landing-actions,.actions,.form-row,.field,.chips')) return true;
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
        if (await trendGraph.locator('.category-trend-summary').evaluateAll((elements) => elements.some((element) => !element.textContent?.includes(expectedReferenceLabel) || !element.textContent.includes(expectedSpanText) || !element.querySelector('.category-trend-direction')))) throw new Error('Category summaries omitted the displayed reference month, span total, or trend status');
        const categoryColors = await trendGraph.locator('.category-trend-summary').evaluateAll((elements) => elements.map((element) => { const marker = element.querySelector('.category-trend-marker'); return { category: element.getAttribute('data-category'), color: marker ? getComputedStyle(marker).backgroundColor : '' }; }));
        const barColors = await trendPlot.locator('.category-trend-bar').evaluateAll((elements) => elements.map((element) => ({ category: element.getAttribute('data-category'), color: getComputedStyle(element).backgroundColor })));
        if (barColors.some((bar) => { const summary = categoryColors.find((candidate) => candidate.category === bar.category); return !summary || summary.color !== bar.color; })) throw new Error('Category bars and legend markers did not preserve category color identity');
        const currentLabels = await trendPlot.locator('.category-trend-month small').evaluateAll((elements) => elements.filter((element) => / MTD$/.test(element.textContent || '')).map((element) => { const range = document.createRange(); range.selectNodeContents(element); return { text: element.textContent, lines: new Set(Array.from(range.getClientRects()).map((rect) => Math.round(rect.top))).size }; }));
        if (currentLabels.length !== 0) throw new Error(`A trimmed historical span incorrectly labeled a month MTD: ${JSON.stringify(currentLabels)}`);
        const monthLabels = await trendPlot.locator('.category-trend-month small').evaluateAll((elements) => elements.map((element) => { const range = document.createRange(); range.selectNodeContents(element); return { text: element.textContent, lines: new Set(Array.from(range.getClientRects()).map((rect) => Math.round(rect.top))).size }; }));
        if (monthLabels.some((label) => label.lines !== 1)) throw new Error(`Displayed month label wrapped: ${JSON.stringify(monthLabels)}`);
        const scale = await trendPlot.locator('.category-trend-bar').evaluateAll((elements) => { const values = elements.map((element) => Number(element.getAttribute('data-value'))); const maximum = Math.max(...values); return { values, maximum, heights: elements.map((element) => Number.parseFloat(getComputedStyle(element).height)), width: getComputedStyle(elements[0]).width }; });
        if (!scale.values.includes(0) || !scale.heights.includes(0)) throw new Error('Sparse category fixture did not preserve true zero-height bars');
        if (scale.width !== '7.2px' && scale.width !== '0.45rem') throw new Error(`Category trend bars are not thin: ${scale.width}`);
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
       if (await globalCompact.count() !== 1) throw new Error('Populated home did not render the global compact insights card');
       if ((await globalCompact.innerText()).includes('You paid')) throw new Error('Global compact insights exposed a paid-but-zero-allocation value');
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
    findings.push(...await auditGeometry(page, scenario, route, viewport));
  } catch (error) {
    failures.push({ scenarioName: scenario.name, authState: authState(scenario.auth), route, viewport, detail: `Geometry audit failed: ${error instanceof Error ? error.message : String(error)}` });
  }
  await saveScreenshot(page, artifactDirectory, `${scenario.name}-${route.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')}`, failures, scenario, route, viewport);
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
  const report = { generatedAt: new Date().toISOString(), findings: orderedFindings, groupedFindings: groupedFindings(orderedFindings), coverage, limitations, harnessFailures: failures };
  await mkdir(artifactDirectory, { recursive: true });
  const reportPath = path.join(artifactDirectory, name);
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  await testInfo.attach(name, { path: reportPath, contentType: 'application/json' });
  console.log(`\n${name}: ${orderedFindings.length} product findings in ${report.groupedFindings.length} component patterns, ${failures.length} harness failures`);
  for (const finding of report.groupedFindings) console.log(`[${finding.severity}] ${finding.kind} ${finding.componentPattern} — ${finding.detail} — affected: ${finding.affected.map((entry) => `${entry.route} @ ${entry.viewport.width}x${entry.viewport.height}`).join(', ')}`);
  for (const failure of failures) console.log(`[HARNESS] ${failure.scenarioName} ${failure.authState} ${failure.route} @ ${failure.viewport.width}x${failure.viewport.height} — ${failure.detail}`);
  return report;
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
  test.setTimeout(360_000);
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
        await page.waitForTimeout(scenario.auth ? 900 : 250);
        await page.waitForLoadState('networkidle', { timeout: 4_000 }).catch(() => undefined);
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
        if (scenario.name === 'group-management') {
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
        }
        if (scenario.name === 'expense-form' && viewport.width <= 768) {
          try {
            await page.locator('.summary-row').click();
            await expect(page.locator('.modal-sheet')).toBeVisible();
            const modalScenario: Scenario = { ...scenario, name: `${scenario.name}-payer-modal`, context: 'ExpenseForm / payer modal (touch/mobile-tablet coverage)', expected: { mode: 'modal', heading: 'Add expense', content: 'Who paid?' } };
            await assertRendered(page, modalScenario, observations, viewport);
            coverage.push({ scenarioName: modalScenario.name, authState: authState(modalScenario.auth), route: `${scenario.path} [payer modal]`, viewport, context: modalScenario.context, rendered: true, apiSuccesses: observations.filter((observation) => observation.status >= 200 && observation.status < 300).map((observation) => observation.path) });
            await reportForPage(page, modalScenario, `${scenario.path} [payer modal]`, viewport, artifactDirectory, findings, failures);
          } catch (error) {
            failures.push({ scenarioName: `${scenario.name}-payer-modal`, authState: authState(scenario.auth), route: `${scenario.path} [payer modal]`, viewport, detail: `Payer modal could not be validated: ${error instanceof Error ? error.message : String(error)}` });
          }
        }
      } catch (error) {
        failures.push({ scenarioName: scenario.name, authState: authState(scenario.auth), route: scenario.path, viewport, detail: `Scenario validation/navigation failed before audit: ${error instanceof Error ? error.message : String(error)}` });
        await saveScreenshot(page, artifactDirectory, scenario.name, failures, scenario, scenario.path, viewport);
      } finally {
        await context.close();
      }
    }
  }
  const report = await writeAuditAttachment(testInfo, artifactDirectory, 'audit-findings.json', findings, failures, coverage, [
    'The 44×44 policy is the project touch-target policy and is audited only at touch/mobile/tablet widths (<896px), not as a universal standards failure.',
    'Playwright cannot reliably inject CSS env(safe-area-inset-*) values into Chromium; source assertions cover the safe-area contracts, while real-device inset behavior remains to be checked on notched iOS/Android hardware.',
    'Payer modal coverage is exercised at 390px and 768px; 895px, 896px, and 1440px modal states are not opened.',
    'The matrix reports broad route/fixture coverage separately from actual geometry violations. Findings from a few routes do not establish a global architecture defect.',
  ]);
  expect(report.findings.filter((finding) => finding.severity === 'critical' || finding.severity === 'major'), 'The audit must not contain critical or major geometry findings').toEqual([]);
  expect(failures, 'The audit matrix should complete without harness failures').toEqual([]);
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
      await page.waitForTimeout(900);
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
      await page.waitForTimeout(900);
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
      await errorPage.waitForTimeout(900);
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
      await insightsErrorPage.waitForTimeout(900);
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
         await page.waitForTimeout(900);
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
      await loadingPage.waitForTimeout(500);
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
      await offlinePage.waitForTimeout(900);
      assertAuthenticatedRequest(offlineRequests, DEV_EMAIL);
       await assertRendered(offlinePage, { ...offlineScenario, expected: { ...offlineScenario.expected, mode: 'normal', content: 'Spending insights' } }, offlineObservations, viewport);
      await offlineContext.setOffline(true);
       await offlinePage.evaluate(() => window.dispatchEvent(new Event('offline')));
       await offlinePage.waitForTimeout(150);
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
       await coldOfflinePage.waitForTimeout(900);
       await coldOfflineContext.setOffline(true);
       await coldOfflinePage.evaluate(() => window.dispatchEvent(new Event('offline')));
       await coldOfflinePage.getByRole('link', { name: 'Insights', exact: true }).click();
       await coldOfflinePage.waitForTimeout(250);
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
    'Payer modal coverage is touch/mobile-tablet only (390px and 768px) because the matrix does not open it at wider viewports.',
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
      await page.waitForTimeout(100);
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
      await page.waitForTimeout(100);
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
      await page.waitForTimeout(100);
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
