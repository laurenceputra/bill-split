import { test, expect } from './fixtures';

test('mobile navigation paints Groups, History and Settings icons', async ({ authenticatedPage: page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');

  const nav = page.locator('.bottom-nav[aria-label="Primary navigation"]');
  await expect(nav).toBeVisible();
  for (const name of ['Groups', 'History', 'Settings']) {
    const icon = nav.getByRole('link', { name }).locator('svg.nav-icon');
    await expect(icon).toBeVisible();
    const appearance = await icon.evaluate((svg) => {
      const path = svg.querySelector('path');
      const bounds = svg.getBoundingClientRect();
      const style = path && getComputedStyle(path);
      return { width: bounds.width, height: bounds.height, stroke: style?.stroke, strokeWidth: style?.strokeWidth, opacity: style?.opacity };
    });
    expect(appearance.width, name).toBe(20);
    expect(appearance.height, name).toBe(20);
    expect(appearance.stroke, name).not.toBe('none');
    expect(appearance.stroke, name).toBeTruthy();
    expect(Number.parseFloat(appearance.strokeWidth ?? '0'), name).toBeGreaterThan(0);
    expect(appearance.opacity, name).not.toBe('0');
  }
});
