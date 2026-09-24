import { test, expect, newAuthenticatedContext, BASE_URL, DEV_EMAIL } from './fixtures';

test('root and shell fill the viewport without a reserved right stripe', async ({ browser }) => {
  for (const width of [320, 390, 895, 896, 1440]) {
    const context = await newAuthenticatedContext(browser, DEV_EMAIL, { width, height: 844 });
    try {
      const page = await context.newPage();
      await page.goto(`${BASE_URL}/settings`);
      await expect(page.locator('.top-bar')).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
      const geometry = await page.evaluate(() => {
        const rect = (selector: string) => {
          const { left, right } = document.querySelector(selector)!.getBoundingClientRect();
          return { left, right };
        };
        return {
          root: document.documentElement.clientWidth,
          scroll: document.documentElement.scrollWidth,
          body: rect('body'),
          header: rect('.top-bar'),
          main: rect('.app-main'),
          nav: rect('.bottom-nav'),
          explicitGutter: document.documentElement.style.scrollbarGutter,
          computedGutter: getComputedStyle(document.documentElement).scrollbarGutter,
        };
      });
      expect(geometry.root, `${width}px: ${JSON.stringify(geometry)}`).toBeLessThanOrEqual(width);
      expect(geometry.scroll).toBeLessThanOrEqual(geometry.root);
      if (width < 896) expect(geometry.computedGutter).not.toContain('stable');
      expect(geometry.explicitGutter).not.toContain('stable');
      expect(geometry.body.left).toBe(0);
      expect(geometry.body.right).toBe(geometry.root);
      expect(geometry.header.left).toBe(0);
      expect(geometry.header.right).toBe(geometry.root);
      expect(geometry.main.left).toBeGreaterThanOrEqual(0);
      expect(geometry.main.right).toBeLessThanOrEqual(geometry.root);
      if (width < 896) {
        expect(geometry.nav.left).toBe(0);
        expect(geometry.nav.right).toBe(geometry.root);
      }
    } finally {
      await context.close();
    }
  }
});
