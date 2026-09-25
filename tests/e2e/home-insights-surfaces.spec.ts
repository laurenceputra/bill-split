import { test, expect, newAuthenticatedContext, BASE_URL, DEV_EMAIL } from './fixtures';

const shortId = '00000000-0000-4000-8000-000000003001';
const longId = '00000000-0000-4000-8000-000000003003';
const insightsId = '00000000-0000-4000-8000-000000003002';

test('Home cards retain compact, accessible balance geometry across the navigation boundary', async ({ browser }) => {
  for (const width of [320, 390, 768, 895, 896, 1440]) {
    const context = await newAuthenticatedContext(browser, DEV_EMAIL, { width, height: 844 }, { serviceWorkers: 'block' });
    try {
      const page = await context.newPage();
      await page.route('**/api/groups', async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        await route.fulfill({ response, json: { ...body, groups: [
          { ...body.groups[0], id: shortId, name: 'Li Ling', currency: 'SGD', kind: 'named', memberCount: 2, balanceSummaries: [{ currency: 'SGD', netMinor: 4216 }] },
          { ...body.groups.find((group: { id: string }) => group.id === longId), name: 'Maternity household and shared care expenses', currency: 'SGD', kind: 'named', memberCount: 9, balanceSummaries: [{ currency: 'SGD', netMinor: 543972 }, { currency: 'EUR', netMinor: -12345 }] },
        ] } });
      });
      await page.goto(`${BASE_URL}/`);
      await expect(page.getByRole('heading', { name: 'Friends & groups' })).toBeVisible();
      const cards = page.locator('a.group-card');
      await expect(cards).toHaveCount(2);
      for (const [index, id] of [shortId, longId].entries()) {
        await expect(cards.nth(index)).toHaveAttribute('href', `/groups/${id}`);
        await expect(cards.nth(index)).toHaveAccessibleName(index === 0 ? /Li Ling.*SGD.*42\.16/s : /Maternity household.*SGD.*5,439\.72.*EUR.*123\.45/s);
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
    } finally {
      await context.close();
    }
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
