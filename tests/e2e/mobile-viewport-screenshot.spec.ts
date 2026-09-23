import { test, expect, newAuthenticatedContext, BASE_URL, DEV_EMAIL } from './fixtures';

test('group overview mobile viewport includes the fixed bottom navigation', async ({ browser }, testInfo) => {
  const context = await newAuthenticatedContext(browser, DEV_EMAIL, { width: 390, height: 844 });
  try {
    const page = await context.newPage();
    await page.goto(`${BASE_URL}/groups/00000000-0000-4000-8000-000000003002`);
    await expect(page.locator('.bottom-nav')).toBeVisible();
    const nav = page.getByRole('navigation', { name: 'Primary navigation' });
    await expect(nav.getByRole('link', { name: 'Groups' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'History' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Settings' })).toBeVisible();
    await expect(nav.getByRole('link', { name: /Add expense/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Balances' })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const path = testInfo.outputPath('group-overview-mobile-viewport.png');
    await page.screenshot({ path, fullPage: false, animations: 'disabled' });
    await testInfo.attach('group-overview-mobile-viewport', { path, contentType: 'image/png' });
  } finally {
    await context.close();
  }
});

test('native select uses the accessible control boundary and visible hover/focus states', async ({ browser }) => {
  const context = await newAuthenticatedContext(browser, DEV_EMAIL, { width: 390, height: 844 });
  try {
    const page = await context.newPage();
    await page.goto(`${BASE_URL}/activity`);
    const select = page.getByRole('combobox', { name: 'Filter history by group' });
    await expect(select).toBeVisible();
    const colors = await select.evaluate((element) => ({ border: getComputedStyle(element).borderTopColor, token: getComputedStyle(document.documentElement).getPropertyValue('--color-control-border').trim() }));
    expect(colors.border).toBe('rgb(146, 127, 166)');
    expect(colors.token).toBe('#927FA6');
    await select.hover();
    await expect(select).toHaveCSS('border-top-color', 'rgb(107, 79, 211)');
    await select.focus();
    await expect(select).toBeFocused();
  } finally {
    await context.close();
  }
});
