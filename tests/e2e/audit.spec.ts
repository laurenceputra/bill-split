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
type ApiRequestObservation = { path: string; headers: Record<string, string> };
type ExpectedScenario = {
  mode: 'normal' | 'loading' | 'api-error' | 'offline' | 'modal';
  heading: string;
  content?: string;
  apiPaths?: string[];
  apiFailures?: Array<{ path: string; status: number }>;
};
type Scenario = {
  name: string;
  path: string;
  finalPath?: string;
  auth: string | undefined;
  context: string;
  expected: ExpectedScenario;
};

const viewports: Viewport[] = [
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 895, height: 900 },
  { width: 896, height: 900 },
  { width: 1440, height: 900 },
];

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
  expense: (id: string) => `/api/expenses/${id}`,
  activity: (_id: string) => '/api/activity',
};

const privateHomeApis = [apiPaths.me, apiPaths.groups];
const groupApis = (id: string) => [apiPaths.me, apiPaths.group(id), apiPaths.transactions(id), apiPaths.balances(id), apiPaths.scheduledExpenses(id)];
const scenarios: Scenario[] = [
  { name: 'public-landing', path: '/', auth: undefined, context: 'PublicLanding / signed-out marketing shell', expected: { mode: 'normal', heading: 'Know who paid. Know what is still owed.', content: 'Private, even when offline' } },
  { name: 'populated-home', path: '/', auth: DEV_EMAIL, context: 'Home / populated groups fixture', expected: { mode: 'normal', heading: 'Friends & groups', content: 'Europe trip · USD + EUR', apiPaths: privateHomeApis } },
  { name: 'empty-home', path: '/', auth: EMPTY_EMAIL, context: 'Home / empty groups fixture', expected: { mode: 'normal', heading: 'Friends & groups', content: 'No groups yet', apiPaths: privateHomeApis } },
  { name: 'rich-group', path: `/groups/${ids.rich}`, auth: DEV_EMAIL, context: 'GroupPage / rich multi-currency fixture', expected: { mode: 'normal', heading: 'Europe trip · USD + EUR', content: 'Scheduled expenses', apiPaths: groupApis(ids.rich) } },
  { name: 'transaction-history', path: `/groups/${ids.rich}/transactions`, finalPath: `/activity?group=${ids.rich}&view=transactions`, auth: DEV_EMAIL, context: 'Legacy transaction route / canonical History transactions tab fixture', expected: { mode: 'normal', heading: 'History', content: 'Search and filters', apiPaths: [apiPaths.me, apiPaths.groups, apiPaths.group(ids.rich), apiPaths.globalTransactions, apiPaths.categories] } },
  { name: 'large-group', path: `/groups/${ids.large}`, auth: DEV_EMAIL, context: 'Group overview / long-member-label fixture', expected: { mode: 'normal', heading: 'Very large group with a name that should remain contained at narrow widths', content: 'Recent transactions', apiPaths: groupApis(ids.large) } },
  { name: 'expense-form', path: `/groups/${ids.rich}/expense/new`, auth: DEV_EMAIL, context: 'ExpenseForm / new expense fixture', expected: { mode: 'normal', heading: 'Add expense', content: 'Split between', apiPaths: [apiPaths.me, apiPaths.group(ids.rich)] } },
  { name: 'scheduled-expense-form', path: `/groups/${ids.rich}/expense/new?recurrence=1`, auth: DEV_EMAIL, context: 'Legacy recurring route / redirected new expense fixture', expected: { mode: 'normal', heading: 'Schedule an expense', content: 'Repeat this expense', apiPaths: [apiPaths.me, apiPaths.group(ids.rich)] } },
  { name: 'expense-detail-history', path: `/groups/${ids.rich}/expenses/${ids.dinner}`, auth: DEV_EMAIL, context: 'ExpenseDetail / edited dinner with history fixture', expected: { mode: 'normal', heading: 'Dinner by the canal (edited)', content: 'History', apiPaths: [apiPaths.me, apiPaths.expense(ids.dinner), apiPaths.group(ids.rich)] } },
  { name: 'settlement', path: `/groups/${ids.rich}/settle`, auth: DEV_EMAIL, context: 'Settle / multi-currency balance fixture', expected: { mode: 'normal', heading: 'Settle up', content: 'Record a payment', apiPaths: [apiPaths.me, apiPaths.group(ids.rich), apiPaths.balances(ids.rich)] } },
  { name: 'activity', path: `/activity?group=${ids.rich}`, auth: DEV_EMAIL, context: 'History changes / filtered expense and settlement history fixture', expected: { mode: 'normal', heading: 'History', content: 'Dinner by the canal', apiPaths: [apiPaths.me, apiPaths.groups, apiPaths.activity(ids.rich)] } },
  { name: 'all-groups-transactions', path: '/activity?view=transactions', auth: DEV_EMAIL, context: 'History transactions / all authorized groups fixture', expected: { mode: 'normal', heading: 'History', content: 'Search and filters', apiPaths: [apiPaths.me, apiPaths.groups, apiPaths.globalTransactions, apiPaths.categories] } },
  { name: 'settings', path: '/settings', auth: DEV_EMAIL, context: 'Settings / trusted-device controls', expected: { mode: 'normal', heading: 'Settings', content: 'Trusted-device offline access', apiPaths: [apiPaths.me] } },
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
    for (const element of Array.from(document.querySelectorAll('body *')).filter(visible)) {
      const box = boxOf(element);
      if (box.left < -1 || box.right > viewport.width + 1) add('horizontal-overflow-element', 'major', `Visible bounds are ${Math.round(box.left)}..${Math.round(box.right)}px`, selector(element), Math.max(-box.left, box.right - viewport.width));
    }

    const modal = document.querySelector('.modal-sheet');
    const modalIsVisible = Boolean(modal && visible(modal));
    const auditTarget = (element: Element) => visible(element) && !element.matches('.skip-link') && !(modalIsVisible && !modal?.contains(element));
    if (touchViewport) {
      const tapTargets = Array.from(document.querySelectorAll('a,button,input,select,textarea,[role="button"]')).filter(auditTarget);
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
      const style = getComputedStyle(element);
      const padding = Math.min(parseFloat(style.paddingTop), parseFloat(style.paddingRight), parseFloat(style.paddingBottom), parseFloat(style.paddingLeft));
      if (padding < 12) add('surface-padding', 'minor', `Flow surface internal padding is ${padding}px; expected at least 12px`, selector(element), padding);
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

async function assertRendered(page: Page, scenario: Scenario, observations: ApiObservation[]) {
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

  if (expected.mode === 'normal' || expected.mode === 'api-error' || expected.mode === 'offline' || expected.mode === 'modal') {
    if (await visibleCount(page, '.app-shell') !== 1 || await visibleCount(page, '.public-shell') !== 0) throw new Error('Scenario did not render the authenticated private shell');
    if (await page.getByRole('heading', { level: 1, name: expected.heading, exact: false }).count() === 0) throw new Error(`Expected heading was not rendered: ${expected.heading}`);
    if (expected.content && !(await page.locator('body').innerText()).includes(expected.content)) throw new Error(`Expected fixture content was not rendered: ${expected.content}`);
    if (await visibleCount(page, '.app-error-boundary') !== 0) throw new Error('Scenario rendered the application error fallback');
  }
  if (expected.mode === 'normal' || expected.mode === 'offline' || expected.mode === 'modal') {
    if (await visibleCount(page, '.error') !== 0 || await visibleCount(page, '.auth-banner') !== 0) throw new Error('Scenario rendered an unexpected auth/error fallback');
  }
  if (expected.mode === 'api-error') {
    if (await visibleCount(page, '#groups-error') !== 1 || !(await page.locator('body').innerText()).includes('Fixture outage')) throw new Error('API-error fixture did not render the intended groups error UI');
  }
  if (expected.mode === 'offline' && await visibleCount(page, '.offline-banner') === 0) throw new Error('Offline fixture did not render the intended offline banner');
  for (const apiPath of expected.apiPaths || []) {
    if (!observations.some((observation) => observation.path === apiPath && observation.status >= 200 && observation.status < 300)) throw new Error(`Authenticated API did not succeed: ${apiPath}`);
  }
  for (const expectedFailure of expected.apiFailures || []) {
    if (!observations.some((observation) => observation.path === expectedFailure.path && observation.status === expectedFailure.status)) throw new Error(`Intercepted API did not return ${expectedFailure.status}: ${expectedFailure.path}`);
  }
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
      if (url.pathname.startsWith('/api/')) requests.push({ path: url.pathname, headers: request.headers() });
    } catch { /* Ignore non-HTTP request URLs. */ }
  });
}

function assertAuthenticatedRequest(requests: ApiRequestObservation[], auth: string) {
  if (!requests.some((request) => request.path === apiPaths.me && request.headers['x-dev-email'] === auth)) throw new Error(`Authenticated context did not send X-Dev-Email: ${auth}`);
}

test.describe.configure({ mode: 'serial' });

test('browser audit matrix captures validated routes, geometry, and full-page screenshots', async ({ browser }, testInfo) => {
  const findings: Finding[] = [];
  const failures: HarnessFailure[] = [];
  const coverage: Coverage[] = [];
  const artifactDirectory = auditArtifactDirectory('normal');
  for (const scenario of scenarios) {
    for (const viewport of viewports) {
      const context = await openContext(browser, scenario.auth, viewport);
      const page = await context.newPage();
      const observations: ApiObservation[] = [];
      const apiHeaders: Array<{ path: string; headers: Record<string, string> }> = [];
      await observeResponses(page, observations);
      page.on('request', (request) => {
        try {
          const url = new URL(request.url());
          if (url.pathname.startsWith('/api/')) apiHeaders.push({ path: url.pathname, headers: request.headers() });
        } catch { /* Ignore non-HTTP request URLs. */ }
      });
      try {
        await page.goto(`${BASE_URL}${scenario.path}`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
        await page.waitForTimeout(scenario.auth ? 900 : 250);
        await page.waitForLoadState('networkidle', { timeout: 4_000 }).catch(() => undefined);
        if (scenario.auth && !apiHeaders.some((request) => request.path === apiPaths.me && request.headers['x-dev-email'] === scenario.auth)) throw new Error(`Authenticated context did not send X-Dev-Email: ${scenario.auth}`);
        if (!scenario.auth && apiHeaders.some((request) => request.headers['x-dev-email'])) throw new Error('Public landing context sent X-Dev-Email');
        await assertRendered(page, scenario, observations);
        coverage.push({ scenarioName: scenario.name, authState: authState(scenario.auth), route: scenario.path, viewport, context: scenario.context, rendered: true, apiSuccesses: observations.filter((observation) => observation.status >= 200 && observation.status < 300).map((observation) => observation.path) });
        await reportForPage(page, scenario, scenario.path, viewport, artifactDirectory, findings, failures);
        if (scenario.name === 'expense-form' && viewport.width <= 768) {
          try {
            await page.locator('.summary-row').click();
            await expect(page.locator('.modal-sheet')).toBeVisible();
            const modalScenario: Scenario = { ...scenario, name: `${scenario.name}-payer-modal`, context: 'ExpenseForm / payer modal (touch/mobile-tablet coverage)', expected: { mode: 'modal', heading: 'Add expense', content: 'Who paid?' } };
            await assertRendered(page, modalScenario, observations);
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
    'Payer modal coverage is exercised at 390px and 768px; 895px, 896px, and 1440px modal states are not opened.',
    'The matrix reports broad route/fixture coverage separately from actual geometry violations. Findings from a few routes do not establish a global architecture defect.',
  ]);
  expect(report.findings.filter((finding) => finding.severity === 'critical' || finding.severity === 'major'), 'The audit must not contain critical or major geometry findings').toEqual([]);
  expect(failures, 'The audit matrix should complete without harness failures').toEqual([]);
});

test('intercepted loading, API error, offline, and modal states render their intended UI', async ({ browser }, testInfo) => {
  const findings: Finding[] = [];
  const failures: HarnessFailure[] = [];
  const coverage: Coverage[] = [];
  const artifactDirectory = auditArtifactDirectory('intercepted');
  const stateViewports = viewports.filter((viewport) => viewport.width <= 768);
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
      await assertRendered(errorPage, errorScenario, errorObservations);
      coverage.push({ scenarioName: errorScenario.name, authState: authState(errorScenario.auth), route: errorScenario.path, viewport, context: errorScenario.context, rendered: true, apiSuccesses: errorObservations.filter((observation) => observation.status >= 200 && observation.status < 300).map((observation) => observation.path) });
      await reportForPage(errorPage, errorScenario, '/ [API error]', viewport, artifactDirectory, findings, failures);
    } catch (error) {
      failures.push({ scenarioName: errorScenario.name, authState: authState(errorScenario.auth), route: '/ [API error]', viewport, detail: `Intercepted API-error validation failed: ${error instanceof Error ? error.message : String(error)}` });
    } finally {
      await errorContext.close();
    }

    const loadingScenario: Scenario = { name: 'state-loading', path: '/', auth: DEV_EMAIL, context: 'App authentication / intercepted /api/me loading state', expected: { mode: 'loading', heading: 'Loading' } };
    const loadingContext = await newAuthenticatedContext(browser, DEV_EMAIL, viewport);
    const loadingPage = await loadingContext.newPage();
    const loadingObservations: ApiObservation[] = [];
    await observeResponses(loadingPage, loadingObservations);
    const loadingRequests: ApiRequestObservation[] = [];
    observeRequests(loadingPage, loadingRequests);
    await loadingPage.route('**/api/me', async (route) => { await new Promise((resolve) => setTimeout(resolve, 1_000)); await route.continue(); });
    try {
      await loadingPage.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
      await loadingPage.waitForTimeout(150);
      assertAuthenticatedRequest(loadingRequests, DEV_EMAIL);
      await assertRendered(loadingPage, loadingScenario, loadingObservations);
      coverage.push({ scenarioName: loadingScenario.name, authState: authState(loadingScenario.auth), route: loadingScenario.path, viewport, context: loadingScenario.context, rendered: true, apiSuccesses: [] });
      await reportForPage(loadingPage, loadingScenario, '/ [loading]', viewport, artifactDirectory, findings, failures);
    } catch (error) {
      failures.push({ scenarioName: loadingScenario.name, authState: authState(loadingScenario.auth), route: '/ [loading]', viewport, detail: `Intercepted loading validation failed: ${error instanceof Error ? error.message : String(error)}` });
    } finally {
      await loadingContext.close();
    }

    const offlineScenario: Scenario = { name: 'state-offline', path: `/groups/${ids.rich}`, auth: DEV_EMAIL, context: 'Group overview / verified fixture followed by offline transition', expected: { mode: 'offline', heading: 'Europe trip · USD + EUR', content: 'showing cached group data', apiPaths: groupApis(ids.rich) } };
    const offlineContext = await newAuthenticatedContext(browser, DEV_EMAIL, viewport);
    const offlinePage = await offlineContext.newPage();
    const offlineObservations: ApiObservation[] = [];
    await observeResponses(offlinePage, offlineObservations);
    const offlineRequests: ApiRequestObservation[] = [];
    observeRequests(offlinePage, offlineRequests);
    try {
      await offlinePage.goto(`${BASE_URL}${offlineScenario.path}`, { waitUntil: 'domcontentloaded' });
      await offlinePage.waitForTimeout(900);
      assertAuthenticatedRequest(offlineRequests, DEV_EMAIL);
      await assertRendered(offlinePage, { ...offlineScenario, expected: { ...offlineScenario.expected, mode: 'normal', content: 'Recent transactions' } }, offlineObservations);
      await offlineContext.setOffline(true);
      await offlinePage.evaluate(() => window.dispatchEvent(new Event('offline')));
      await offlinePage.waitForTimeout(150);
      await assertRendered(offlinePage, offlineScenario, offlineObservations);
      coverage.push({ scenarioName: offlineScenario.name, authState: authState(offlineScenario.auth), route: offlineScenario.path, viewport, context: offlineScenario.context, rendered: true, apiSuccesses: offlineObservations.filter((observation) => observation.status >= 200 && observation.status < 300).map((observation) => observation.path) });
      await reportForPage(offlinePage, offlineScenario, `${offlineScenario.path} [offline]`, viewport, artifactDirectory, findings, failures);
    } catch (error) {
      failures.push({ scenarioName: offlineScenario.name, authState: authState(offlineScenario.auth), route: `${offlineScenario.path} [offline]`, viewport, detail: `Intercepted offline validation failed: ${error instanceof Error ? error.message : String(error)}` });
    } finally {
      await offlineContext.close();
    }
  }
  const report = await writeAuditAttachment(testInfo, artifactDirectory, 'audit-findings.json', findings, failures, coverage, [
    'Intercepted loading, API-error, and offline states are covered at 390px and 768px only; wider route states use the normal matrix.',
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
