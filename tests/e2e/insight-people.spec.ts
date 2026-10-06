import { test, expect } from './fixtures';

const groupId = '00000000-0000-4000-8000-000000003002';
const path = `/activity?group=${groupId}&view=insights&period=all&currency=USD`;
const person = (personId: string, name: string, shareMinor: number, paidMinor: number) => ({ personId, name, shareMinor, paidMinor });
const summary = (currency: string, people?: ReturnType<typeof person>[]) => ({ currency, groupSpendMinor: 1000, allocatedSpendMinor: 200, yourShareMinor: 200, youPaidMinor: 600, expenseCount: 1, ...(people ? { people } : {}) });

test('top More actions is button-like, in-flow and follows frequent actions at every audit width', async ({ authenticatedPage: page }) => {
  await page.goto(`/groups/${groupId}`);
  const tools = page.locator('.group-overview-tools');
  for (const width of [320, 390, 768, 895, 896, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(tools).toHaveJSProperty('open', false);
    const geometry = await tools.locator('summary').evaluate((element) => {
      const primary = document.querySelector('.group-overview-header .expense-heading__actions')!;
      const style = getComputedStyle(element);
      return { height: element.getBoundingClientRect().height, border: parseFloat(style.borderTopWidth), radius: parseFloat(style.borderRadius), followsPrimary: Boolean(primary.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) };
    });
    expect(geometry.height).toBeGreaterThanOrEqual(44);
    expect(geometry.border).toBeGreaterThan(0);
    expect(geometry.radius).toBeGreaterThan(0);
    expect(geometry.followsPrimary).toBe(true);
    await tools.locator('summary').click();
    for (const name of ['View spending insights', 'Group history', 'Group settings']) await expect(tools.getByRole('link', { name, exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Record credit', exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await tools.locator('summary').click();
  }
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
  fail = true;
  await page.clock.install();
  await page.clock.fastForward(31_000);
  await page.getByRole('link', { name: '← Back to group', exact: true }).click();
  await page.locator('.group-overview-tools summary').click();
  await page.getByRole('link', { name: 'View spending insights', exact: true }).click();
  await expect.poll(() => failedReads).toBeGreaterThan(0);
  await expect(people).toContainText('2,345,678,901,234.56');
  await expect(page.getByText('Showing cached selected-period summary; it may be out of date.', { exact: false })).toBeVisible();
  await page.context().setOffline(true);
  await expect(page.getByText('Refresh unavailable offline; showing cached selected-period summary.')).toBeVisible();
  await expect(people).toContainText('1,234,567,890,123.45');
  await expect(page.getByRole('link', { name: '← Back to group', exact: true })).toHaveAttribute('href', `/groups/${groupId}`);
  await page.context().setOffline(false);
});
