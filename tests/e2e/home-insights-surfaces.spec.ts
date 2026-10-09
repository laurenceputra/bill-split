import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect, newAuthenticatedContext, seedOfflineTrust, BASE_URL, DEV_EMAIL } from './fixtures';

async function captureHome(page: Page, testInfo: TestInfo, name: string) {
  await expect(page.locator('.card__name').filter({ hasText: 'Demo friend' })).toHaveText('Demo friend');
  await expect(page.locator('.card__name').filter({ hasText: name.startsWith('home-mobile') || name.startsWith('home-desktop') ? 'Sample project' : 'Shared project with a long sample name for responsive testing' })).toBeVisible();
  await expect(page.getByLabel('Spending snapshot by currency')).toBeVisible();
  await expect(page.locator('.group-card .avatar').filter({ hasText: 'DU' }).first()).toHaveAttribute('aria-label', 'Demo user');
  await expect(page.locator('.group-card .avatar').filter({ hasText: 'DF' }).first()).toHaveAttribute('aria-label', 'Demo friend');
  await expect(page.locator('.avatar img')).toHaveCount(0);
  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(/Li Ling|Maternity|shared care|Dev User|Alex|Priya|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b[a-f0-9]{64}\b/i);
  await page.evaluate(() => document.fonts.ready);
  const destination = process.env.UPDATE_HOME_SCREENSHOTS === '1'
    ? path.join(process.cwd(), 'docs', 'screenshots', `${name}.png`)
    : testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: destination, fullPage: true, animations: 'disabled', style: '.bottom-nav { visibility: hidden !important; }' });
  await testInfo.attach(name, { path: destination, contentType: 'image/png' });
}

const shortId = '00000000-0000-4000-8000-000000003001';
const longId = '00000000-0000-4000-8000-000000003003';
const insightsId = '00000000-0000-4000-8000-000000003002';

// Construct screenshot data rather than inheriting backend names or avatar preferences.
async function mockAnonymousHome(page: Page, stress = false) {
  await page.route('**/api/me', async (route) => {
    const response = await route.fetch();
    const { id, personId, profileRevision, updatedAt, idleExpiresAt } = await response.json();
    await route.fulfill({ response, json: { id, personId, profileRevision, updatedAt, idleExpiresAt, email: DEV_EMAIL, name: 'Demo user', avatarMode: 'initials' } });
  });
  await page.route('**/api/invitations', (route) => route.fulfill({ json: { invitations: [] } }));
  await page.route('**/api/groups', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { groups: [
    { id: shortId, name: 'Demo friend', currency: stress ? 'SGD' : 'USD', kind: 'named', memberCount: 2, counterpartName: 'Demo friend', counterpartAvatar: { avatarMode: 'initials' }, createdAt: '2026-01-01', updatedAt: '2026-01-01', balanceSummaries: [{ currency: stress ? 'SGD' : 'USD', netMinor: 4216 }] },
    { id: longId, name: stress ? 'Shared project with a long sample name for responsive testing' : 'Sample project', currency: stress ? 'SGD' : 'EUR', kind: 'named', memberCount: 9, createdAt: '2026-01-01', updatedAt: '2026-01-01', balanceSummaries: stress ? [{ currency: 'SGD', netMinor: 543972 }, { currency: 'EUR', netMinor: -12345 }] : [{ currency: 'EUR', netMinor: -12345 }] },
    ] } });
  });
  await page.route('**/api/spending-insights?*', (route) => route.fulfill({ json: { scope: 'global', summaries: ['USD', 'EUR', 'SGD'].map((currency) => ({ currency, groupSpendMinor: 24600, allocatedSpendMinor: 12300, yourShareMinor: 12300, youPaidMinor: 15000, expenseCount: 6 })) } }));
}

test('Home cards retain compact, accessible balance geometry across the navigation boundary', async ({ browser }, testInfo) => {
  for (const width of [320, 390, 768, 895, 896, 1440]) {
    const context = await newAuthenticatedContext(browser, DEV_EMAIL, { width, height: 844 }, { serviceWorkers: 'block' });
    try {
      const page = await context.newPage();
      await mockAnonymousHome(page, true);
      await page.goto(`${BASE_URL}/`);
      await expect(page.getByRole('heading', { name: 'Friends & groups' })).toBeVisible();
      const cards = page.locator('a.group-card');
      await expect(cards).toHaveCount(2);
      for (const [index, id] of [shortId, longId].entries()) {
        await expect(cards.nth(index)).toHaveAttribute('href', `/groups/${id}`);
        await expect(cards.nth(index)).toHaveAccessibleName(index === 0 ? /Demo friend.*SGD.*42\.16/s : /Shared project.*SGD.*5,439\.72.*EUR.*123\.45/s);
      }
      const geometry = await page.evaluate(() => {
        const cards = [...document.querySelectorAll<HTMLElement>('.group-card')];
        const rect = (element: Element) => element.getBoundingClientRect();
        const probe = document.createElement('div');
        probe.style.cssText = 'background: var(--color-surface); border: 1px solid var(--color-border)';
        document.body.append(probe);
        const surfaceColor = getComputedStyle(probe).backgroundColor;
        const border = getComputedStyle(probe).borderTopColor;
        probe.remove();
        return {
          clientWidth: document.documentElement.clientWidth,
          scale: visualViewport?.scale,
          scrollWidth: document.documentElement.scrollWidth,
          cards: cards.map((card) => ({
            box: { left: rect(card).left, right: rect(card).right, top: rect(card).top, bottom: rect(card).bottom, height: rect(card).height },
            gap: rect(card.querySelector('.card__balances')!).top - rect(card.querySelector('.group-card__identity')!).bottom,
            paintedRows: [...card.querySelectorAll('.card__balance')].filter((row) => {
              const style = getComputedStyle(row);
              return style.backgroundColor !== 'rgba(0, 0, 0, 0)' || style.boxShadow !== 'none' || parseFloat(style.borderTopWidth) > 0;
            }).length,
            balances: [...card.querySelectorAll('.card__balance')].map((row) => row.textContent?.trim()),
            clipped: [...card.querySelectorAll<HTMLElement>('.group-card__identity, .card__balances, .card__balance, .money')].some((child) => child.scrollWidth > child.clientWidth + 1 || rect(child).right > rect(card).right + 1),
            background: getComputedStyle(card).backgroundColor,
            border: getComputedStyle(card).borderTopColor,
            borderWidth: getComputedStyle(card).borderTopWidth,
          })),
          surfaceColor,
          border,
          actions: [...document.querySelectorAll('.home-actions a')].map((link) => link.getAttribute('href')),
          nav: { mobile: getComputedStyle(document.querySelector('.bottom-nav')!).display, desktop: getComputedStyle(document.querySelector('.desktop-nav')!).display },
        };
      });
      expect(geometry.scrollWidth, JSON.stringify({ width, geometry })).toBeLessThanOrEqual(geometry.clientWidth);
      expect(geometry.cards.every((card) => card.background === geometry.surfaceColor && card.border === geometry.border && card.borderWidth === '1px' && !card.clipped && !card.paintedRows && card.gap >= 0 && card.gap <= 24 && card.box.left >= 0 && card.box.right <= geometry.clientWidth + 1), JSON.stringify({ width, geometry })).toBe(true);
      expect(geometry.cards[0].balances).toEqual([expect.stringMatching(/SGD.*42\.16/)]);
      expect(geometry.cards[1].balances).toEqual([expect.stringMatching(/SGD.*5,439\.72/), expect.stringMatching(/EUR.*123\.45/)]);
      for (const balance of geometry.cards.flatMap((card) => card.balances)) expect(balance?.match(/(?:SGD|EUR)/g)).toHaveLength(1);
      expect(geometry.cards[0].box.height).toBeLessThan(geometry.cards[1].box.height);
      expect(geometry.cards[0].box.top === geometry.cards[1].box.top).toBe(width >= 896);
      const intercardGap = width >= 896
        ? geometry.cards[1].box.left - geometry.cards[0].box.right
        : geometry.cards[1].box.top - geometry.cards[0].box.bottom;
      expect(intercardGap, JSON.stringify({ width, geometry })).toBeGreaterThan(0);
      expect(intercardGap, JSON.stringify({ width, geometry })).toBeLessThanOrEqual(32);
      expect(geometry.actions).toEqual(['/friends/new', '/groups/new']);
      expect(geometry.nav.mobile === 'none').toBe(width >= 896);
      expect(geometry.nav.desktop === 'none').toBe(width < 896);
      const sort = page.getByRole('combobox', { name: 'Sort', exact: true });
      await expect(sort).toHaveValue('name');
      expect(await page.locator('.home-actions').evaluate((actions) => Boolean(actions.compareDocumentPosition(document.querySelector('.home-sort')!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
      const device = width === 390 ? 'mobile' : width === 1440 ? 'desktop' : undefined;
      if (device) await captureHome(page, testInfo, `home-sgd-stress-${device}`);
      await sort.selectOption('outstanding');
      await expect(cards.first()).toHaveAttribute('href', `/groups/${longId}`);
      await expect(page.locator('#home-sort-help')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      if (device) await captureHome(page, testInfo, `home-outstanding-${device}`);
      await page.reload();
      await expect(sort).toHaveValue('outstanding');
      await expect(cards.first()).toHaveAttribute('href', `/groups/${longId}`);
      await seedOfflineTrust(page);
      await page.unroute('**/api/groups');
      await page.route('**/api/groups', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Unavailable' }) }));
      await page.reload();
      await expect(sort).toHaveValue('outstanding');
      await expect(cards.first()).toHaveAttribute('href', `/groups/${longId}`);
      await seedOfflineTrust(page);
      await context.setOffline(true);
      await page.evaluate(() => window.dispatchEvent(new Event('offline')));
      await expect(sort).toHaveValue('outstanding');
      await expect(cards.first()).toHaveAttribute('href', `/groups/${longId}`);
      await sort.selectOption('name');
      await expect(cards.first()).toHaveAttribute('href', `/groups/${shortId}`);
      await expect(page.locator('#home-sort-help')).toHaveCount(0);
    } finally {
      await context.close();
    }
  }
});

for (const [device, width] of [['mobile', 390], ['desktop', 1440]] as const) {
  test(`Home reference screenshots at ${device} size`, async ({ authenticatedPage: page }, testInfo) => {
    await page.setViewportSize({ width, height: device === 'mobile' ? 844 : 900 });
    await mockAnonymousHome(page);
    await page.goto('/');
    await expect(page.locator('.group-card').first()).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Sort', exact: true })).toHaveValue('name');
    await expect(page.locator('.skeleton')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    if (device === 'mobile') await expect(page.locator('.bottom-nav')).toBeVisible();
    await captureHome(page, testInfo, `home-${device}`);
  });
}

test('Home sort is absent during cold loading, empty and uncached error states', async ({ browser }) => {
  for (const width of [320, 390, 768, 895, 896, 1440]) {
    const context = await newAuthenticatedContext(browser, DEV_EMAIL, { width, height: 844 }, { serviceWorkers: 'block' });
    try {
      const page = await context.newPage();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let failed = false;
      await page.route('**/api/groups', async (route) => {
        await gate;
        await route.fulfill({ status: failed ? 503 : 200, contentType: 'application/json', body: JSON.stringify(failed ? { error: 'Unavailable' } : { groups: [] }) });
      });
      await page.goto('/');
      await expect(page.locator('.skeleton').first()).toBeVisible();
      await expect(page.getByRole('combobox', { name: 'Sort', exact: true })).toHaveCount(0);
      release();
      await expect(page.getByText('No groups yet', { exact: true })).toBeVisible();
      await expect(page.getByRole('combobox', { name: 'Sort', exact: true })).toHaveCount(0);
      failed = true;
      // A fresh context avoids a verified empty cache masking the uncached error state.
      const errorContext = await newAuthenticatedContext(browser, DEV_EMAIL, { width, height: 844 }, { serviceWorkers: 'block' });
      try {
        const errorPage = await errorContext.newPage();
        await errorPage.route('**/api/groups', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Unavailable' }) }));
        await errorPage.goto('/');
        await expect(errorPage.getByRole('alert').first()).toBeVisible();
        await expect(errorPage.getByRole('combobox', { name: 'Sort', exact: true })).toHaveCount(0);
      } finally { await errorContext.close(); }
    } finally { await context.close(); }
  }
});

for (const width of [390, 1440]) {
  for (const scope of ['global', 'group'] as const) {
    test(`${scope} Insights summary and chart are independent painted modules at ${width}px`, async ({ authenticatedPage: page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`/activity?${scope === 'group' ? `group=${insightsId}&` : ''}view=insights&period=all&currency=USD`);
      await expect(page.getByRole('navigation', { name: 'History views' }).getByRole('link', { name: 'Insights' })).toHaveAttribute('aria-current', 'page');
      await expect(page.getByRole('tablist', { name: 'Spending insight currencies' }).getByRole('tab', { name: 'USD' })).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByLabel('Selected-period spending summary')).toBeVisible();
      await expect(page.getByRole('group', { name: 'USD category spending chart' })).toBeVisible();
      const geometry = await page.evaluate(() => {
        const summary = document.querySelector('.insight-summary-card')!;
        const chart = document.querySelector('.insight-category-trends')!;
        const color = (node: Element) => getComputedStyle(node).backgroundColor;
        return {
          expected: (() => { const probe = document.createElement('div'); probe.style.backgroundColor = 'var(--color-surface)'; document.body.append(probe); const result = color(probe); probe.remove(); return result; })(),
          summary: color(summary), chart: color(chart),
          sections: [...document.querySelectorAll('.insight-section')].map(color),
          separate: !summary.contains(chart) && !chart.contains(summary) && summary.closest('.insight-section') !== chart.closest('.insight-section'),
          overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        };
      });
      expect(geometry.summary).toBe(geometry.expected);
      expect(geometry.chart).toBe(geometry.summary);
      expect(geometry.sections).toEqual(['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)']);
      expect(geometry.separate).toBe(true);
      expect(geometry.overflow).toBe(false);
    });
  }
}
