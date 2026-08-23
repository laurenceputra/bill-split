import { test, expect } from './fixtures';

test('public shell exposes a skip link and keyboard-focusable auth actions', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.public-shell')).toBeVisible();
  const skipLink = page.locator('.skip-link').first();
  await expect(skipLink).toHaveAttribute('href', '#public-main-content');
  await expect.poll(() => skipLink.evaluate((element) => {
    (element as HTMLElement).focus();
    return document.activeElement === element;
  })).toBe(true);
  await expect(page.getByRole('button', { name: 'Sign in' }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign up' }).first()).toBeVisible();
});

test('authenticated settings keeps navigation semantics and labelled controls', async ({ authenticatedPage: page }) => {
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toHaveCount(1);
  await expect(page.getByRole('link', { name: 'Settings' }).first()).toHaveAttribute('aria-current', 'page');
  await expect(page.getByLabel('Typed confirmation')).toBeVisible();
  await page.getByLabel('Typed confirmation').focus();
  await page.keyboard.type('DELETE MY ACCOUNT');
  await expect(page.getByRole('button', { name: 'Delete BillSplit account' })).toBeDisabled();
});
