import { test, expect } from './fixtures';

const groupId = '00000000-0000-4000-8000-000000003002';
const path = `/activity?group=${groupId}&view=insights&period=all&currency=USD`;
const person = (personId: string, name: string, shareMinor: number, paidMinor: number) => ({ personId, name, shareMinor, paidMinor });
const summary = (currency: string, people?: ReturnType<typeof person>[]) => ({ currency, groupSpendMinor: 1000, allocatedSpendMinor: 200, yourShareMinor: 200, youPaidMinor: 600, expenseCount: 1, ...(people ? { people } : {}) });

test('Spending insights split actions stay aligned and in-flow at every audit width', async ({ authenticatedPage: page }) => {
  await page.goto(`/groups/${groupId}`);
  const tools = page.locator('.group-overview-tools');
  await expect(tools).toHaveAttribute('data-flow-region', 'admin');
  await expect(tools.locator('summary')).toHaveAccessibleName('More group actions');
  const insights = page.getByRole('link', { name: 'Spending insights', exact: true });
  await expect(insights).toHaveAttribute('href', `/activity?group=${groupId}&view=insights&period=all`);
  const positions = () => page.evaluate(() => {
    const box = (selector: string) => { const r = document.querySelector(selector)!.getBoundingClientRect(); return { top: r.top, height: r.height, width: r.width, left: r.left, right: r.right }; };
    return { title: box('.group-overview-header h1'), add: box('.group-overview-header .split-transaction-control'), addMenu: box('.group-overview-header .split-transaction-control__menu'), settle: box('.group-overview-header .expense-heading__actions > .button'), insights: box('.group-insights-control__primary'), menu: box('.group-overview-tools summary'), cards: box('.group-overview-columns') };
  });
  for (const width of [320, 390, 768, 895, 896, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(tools).toHaveJSProperty('open', false);
    await page.mouse.move(0, 0);
    const colors = (selector: string) => page.locator(selector).evaluate((element) => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, border: style.borderTopColor };
    });
    const rest = await colors('.group-insights-control__primary');
    expect(await colors('.group-overview-tools summary')).toEqual(rest);
    await insights.hover();
    const hover = await colors('.group-insights-control__primary');
    expect(hover.background).not.toBe(rest.background);
    await tools.locator('summary').hover();
    expect(await colors('.group-overview-tools summary')).toEqual(hover);
    await page.mouse.move(0, 0);
    const geometry = await tools.locator('summary').evaluate((element) => {
      const primary = document.querySelector('.group-overview-header .expense-heading__actions')!;
      const style = getComputedStyle(element);
       return { height: element.getBoundingClientRect().height, border: parseFloat(style.borderTopWidth), radius: parseFloat(style.borderTopRightRadius), followsPrimary: Boolean(primary.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) };
    });
    expect(geometry.height).toBeGreaterThanOrEqual(44);
    expect(geometry.border).toBeGreaterThan(0);
    expect(geometry.radius).toBeGreaterThan(0);
    expect(geometry.followsPrimary).toBe(true);
    const closed = await positions();
    expect(closed.menu.width).toBe(closed.addMenu.width);
    for (const control of [closed.add, closed.addMenu, closed.settle, closed.insights, closed.menu]) expect(control.height).toBe(44);
    expect(closed.menu.top).toBe(closed.insights.top);
    expect(closed.settle.top).toBe(closed.add.top);
    if (Math.abs(closed.insights.top - closed.add.top) < 1) expect(closed.menu.top).toBe(closed.addMenu.top);
    await tools.locator('summary').focus();
    await expect(tools.locator('summary')).toBeFocused();
    expect(await tools.locator('summary').evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe('none');
    expect(await tools.locator('summary').evaluate((element) => {
      const style = getComputedStyle(element);
      return { width: style.outlineWidth, offset: style.outlineOffset };
    })).toEqual({ width: '3px', offset: '3px' });
    await page.keyboard.press('Enter');
    for (const name of ['Group history', 'Group settings']) await expect(tools.getByRole('link', { name, exact: true })).toBeVisible();
    await expect(tools.getByRole('link', { name: /insights/i })).toHaveCount(0);
    const opened = await positions();
    for (const key of ['title', 'add', 'settle', 'insights', 'menu'] as const) expect(opened[key]).toEqual(closed[key]);
    expect(opened.cards.top).toBeGreaterThan(closed.cards.top);
    const panel = await tools.locator('nav').boundingBox();
    expect(panel!.x).toBeCloseTo(closed.insights.left, 0);
    expect(panel!.width).toBeCloseTo(closed.menu.right - closed.insights.left, 0);
    expect(panel!.y).toBeGreaterThanOrEqual(closed.menu.top + closed.menu.height);
    await expect(page.getByRole('link', { name: 'Record credit', exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.keyboard.press('Space');
    await expect(tools).toHaveJSProperty('open', false);
    await expect(tools.locator('summary')).toBeFocused();
  }
  await page.setViewportSize({ width: 320, height: 844 });
  await page.locator('.group-overview-header h1').evaluate((element) => { element.textContent = 'GroupWithAnExtremelyLongUnbrokenName'.repeat(3); });
  await tools.locator('summary').click();
  await tools.locator('nav a').first().evaluate((element) => { element.textContent = 'GroupHistoryWithAnExtremelyLongUnbrokenLabel'.repeat(3); });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(await page.locator('.group-insights-control').evaluate((element) => [...element.querySelectorAll<HTMLElement>('a, nav')].every((child) => child.scrollWidth <= child.clientWidth + 1))).toBe(true);
});

test('person totals follow currency and period; ties, zero, old cache and empty are distinct', async ({ authenticatedPage: page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.route('**/api/spending-insights?**', async (route) => {
    const query = new URL(route.request().url()).searchParams;
    if (query.get('view') === 'trends') return route.fulfill({ json: { scope: 'group', trendFrom: query.get('trendFrom'), trendTo: query.get('trendTo'), categoryTrends: [] } });
    const from = query.get('from');
    const summaries = from === '2026-02-01' ? [] : from === '2026-03-01' ? [summary('USD')] : from === '2026-01-01'
      ? [summary('USD', [person('a', 'Zero payer A', 200, 0), person('b', 'Zero payer B', 800, 0)])]
      : [summary('USD', [person('a', 'Alex', 200, 600), person('b', 'Blair', 800, 400)]), summary('EUR', [person('a', 'Alex', 100, 500), person('b', 'Blair', 900, 500)])];
    return route.fulfill({ json: { scope: 'group', summaries } });
  });
  await page.goto(path);
  const people = page.getByRole('region', { name: 'Spending by person' });
  await expect(people).toBeVisible();
  await expect(people.locator('li').filter({ hasText: 'Alex' })).toContainText(/Allocated share.*\$2\.00.*Paid.*\$6\.00/s);
  await expect(people.locator('li').filter({ hasText: 'Blair' })).toContainText(/Allocated share.*\$8\.00.*Paid.*\$4\.00/s);
  await expect(people.locator('.insight-highest-payer')).toHaveCount(1);
  await page.getByRole('tab', { name: 'EUR', exact: true }).click();
  await expect(people.locator('.insight-highest-payer')).toHaveText(['Highest payer (tie)', 'Highest payer (tie)']);
  await expect(people.locator('li').first()).toContainText(/Allocated share.*€1\.00.*Paid.*€5\.00/s);
  for (const width of [320, 390, 639, 640, 768, 895, 896, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    const headings = people.locator('.insight-people-headings');
    if (width < 640) await expect(headings).toBeHidden();
    else {
      await expect(headings).toBeVisible();
      const layout = await people.evaluate((element) => {
        const rows = [...element.querySelectorAll('li')];
        const boxes = rows.map((row) => [...row.children].map((child) => child.getBoundingClientRect()));
        const headingBoxes = [...element.querySelector('.insight-people-headings')!.children].map((child) => child.getBoundingClientRect());
        return { width: element.getBoundingClientRect().width, aligned: boxes.every((cells) => cells.every((cell, i) => Math.abs(cell.left - headingBoxes[i].left) < 1 && Math.abs(cell.right - headingBoxes[i].right) < 1)), sameTop: boxes.every((cells) => cells.every((cell) => Math.abs(cell.top - cells[0].top) < 1)), heights: rows.map((row) => row.getBoundingClientRect().height), rightAligned: [...element.querySelectorAll('.insight-person-metric')].every((metric) => getComputedStyle(metric).textAlign === 'right') };
      });
      expect(layout.width).toBeLessThanOrEqual(768);
      expect(layout.aligned).toBe(true);
      expect(layout.sameTop).toBe(true);
      expect(layout.rightAligned).toBe(true);
      for (const height of layout.heights) expect(height).toBeLessThan(100);
    }
    await expect(people.locator('.insight-highest-payer')).toHaveText(['Highest payer (tie)', 'Highest payer (tie)']);
  }
  await page.goto(`${path.replace('period=all', 'period=custom')}&from=2026-01-01&to=2026-01-31`);
  await expect(people).toContainText('Zero payer A');
  await expect(people.locator('.insight-highest-payer')).toHaveCount(0);
  await page.goto(`${path.replace('period=all', 'period=custom')}&from=2026-02-01&to=2026-02-28`);
  await expect(page.getByText('No counted expenses in this period.', { exact: false })).toBeVisible();
  await expect(people).toHaveCount(0);
  await page.goto(`${path.replace('period=all', 'period=custom')}&from=2026-03-01&to=2026-03-31`);
  await expect(page.getByLabel('Selected-period spending summary')).toBeVisible();
  await expect(people).toHaveCount(0);
});

test('cached person totals survive refresh errors and offline; long names and large amounts fit narrow screens', async ({ authenticatedPage: page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  let fail = false;
  let failedReads = 0;
  await page.route('**/api/spending-insights?**', async (route) => {
    const query = new URL(route.request().url()).searchParams;
    if (query.get('view') === 'trends') return route.fulfill({ json: { scope: 'group', trendFrom: query.get('trendFrom'), trendTo: query.get('trendTo'), categoryTrends: [] } });
    if (fail) { failedReads++; return route.fulfill({ status: 422, json: { error: { code: 'BALANCE_OVERFLOW', message: 'Summary refresh failed' } } }); }
    return route.fulfill({ json: { scope: 'group', summaries: [summary('USD', [person('a', 'HistoricalParticipantWithAnExtremelyLongUnbrokenName'.repeat(3), 123456789012345, 234567890123456)])] } });
  });
  await page.goto(path);
  const people = page.getByRole('region', { name: 'Spending by person' });
  await expect(people).toContainText('1,234,567,890,123.45');
  await expect(people).toContainText('2,345,678,901,234.56');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(await people.evaluate((element) => [...element.querySelectorAll<HTMLElement>('li, .money')].every((child) => child.scrollWidth <= child.clientWidth + 1))).toBe(true);
  for (const width of [390, 639, 640, 768, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    expect(await people.evaluate((element) => [...element.querySelectorAll<HTMLElement>('li, .insight-person-identity, .insight-person-metric, .money')].every((child) => child.scrollWidth <= child.clientWidth + 1))).toBe(true);
  }
  fail = true;
  await page.clock.install();
  await page.clock.fastForward(31_000);
  await page.getByRole('link', { name: '← Back to group', exact: true }).click();
  await page.getByRole('link', { name: 'Spending insights', exact: true }).click();
  await expect.poll(() => failedReads).toBeGreaterThan(0);
  await expect(people).toContainText('2,345,678,901,234.56');
  await expect(page.getByText('Showing cached selected-period summary; it may be out of date.', { exact: false })).toBeVisible();
  await page.context().setOffline(true);
  await expect(page.getByText('Refresh unavailable offline; showing cached selected-period summary.')).toBeVisible();
  await expect(people).toContainText('1,234,567,890,123.45');
  await expect(page.getByRole('link', { name: '← Back to group', exact: true })).toHaveAttribute('href', `/groups/${groupId}`);
  await page.context().setOffline(false);
});
