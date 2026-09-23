import { test, expect, newAuthenticatedContext, DEV_EMAIL } from './fixtures';

const groupId = '00000000-0000-4000-8000-000000003002';

for (const width of [896, 1440]) {
  for (const [name, route, heading] of [
    ['Home', '/', 'Friends & groups'],
    ['Group Overview', `/groups/${groupId}`, 'Europe trip · USD + EUR'],
  ]) {
    test(`${name} desktop navigation is rendered at ${width}px`, async ({ browser }) => {
      const context = await newAuthenticatedContext(browser, DEV_EMAIL, { width, height: 844 });
      try {
        const page = await context.newPage();
        await page.goto(route);
        await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
        await expect(page.locator('.network-indicator')).toContainText('Connected');
        if (name === 'Home') await expect(page.getByRole('region', { name: 'Spending snapshot' })).toContainText('counted expense');
        else await expect(page.getByText('Dinner by the canal (edited)')).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        const nav = page.locator('.desktop-nav');
        await expect(nav).toBeVisible();
        const links = nav.getByRole('link');
        await expect(links).toHaveText(['Groups', 'History', 'Add expense', 'Settings']);
        const geometry = await nav.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const links = [...element.querySelectorAll('a')].map((link) => link.getBoundingClientRect());
          return { display: getComputedStyle(element).display, box: { left: box.left, right: box.right, top: box.top, bottom: box.bottom }, links: links.map((rect) => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })), fonts: document.fonts.status, styles: [...document.styleSheets].length };
        });
        expect(geometry.fonts).toBe('loaded');
        expect(geometry.styles).toBeGreaterThan(0);
        expect(geometry.display).toBe('flex');
        for (const link of geometry.links) {
          expect(link.right).toBeGreaterThan(link.left);
          expect(link.left).toBeGreaterThanOrEqual(geometry.box.left - 1);
          expect(link.right).toBeLessThanOrEqual(geometry.box.right + 1);
          expect(link.top).toBeGreaterThanOrEqual(geometry.box.top - 1);
          expect(link.bottom).toBeLessThanOrEqual(geometry.box.bottom + 1);
        }
      } finally {
        await context.close();
      }
    });
  }
}
