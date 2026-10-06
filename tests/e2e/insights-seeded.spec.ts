import { test, expect } from './fixtures';

for (const width of [320, 390, 768, 895, 896, 1440]) {
  test(`global all-time USD insights show seeded spending at ${width}px`, async ({ authenticatedPage: page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/activity?view=insights&period=all&currency=USD');
    await expect(page.getByRole('combobox', { name: 'Filter history by group' })).toHaveValue('');
    await expect(page.getByRole('navigation', { name: 'History views' }).getByRole('link', { name: 'Insights' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByLabel('Spending insight filters').getByRole('combobox', { name: 'Period' })).toHaveValue('all');
    await expect(page.getByRole('tablist', { name: 'Spending insight currencies' }).getByRole('tab', { name: 'USD' })).toHaveAttribute('aria-selected', 'true');
    const summary = page.getByLabel('Selected-period spending summary');
    await expect(summary).toBeVisible();
    await expect(summary).not.toContainText('0 counted expenses');
  });
}

for (const width of [320, 1440]) {
  test(`group history return context and person insights at ${width}px`, async ({ authenticatedPage: page }) => {
    await page.setViewportSize({ width, height: 844 });
    const groupId = '00000000-0000-4000-8000-000000003002';
    await page.goto(`/activity?group=${groupId}&view=insights&period=all`);
    await expect(page.getByRole('link', { name: '← Back to group', exact: true })).toHaveAttribute('href', `/groups/${groupId}`);
    await expect(page.getByRole('region', { name: 'Spending by person' })).toBeVisible();
    await expect(page.getByText('Highest payer', { exact: true }).first()).toBeVisible();
    await page.getByRole('combobox', { name: 'Filter history by group' }).selectOption('');
    await expect(page.getByRole('link', { name: '← Back to group', exact: true })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Spending by person' })).toHaveCount(0);
  });
}

test('group insights show seeded Food category at desktop width', async ({ authenticatedPage: page }) => {
  await page.setViewportSize({ width: 1440, height: 844 });
  await page.goto('/activity?group=00000000-0000-4000-8000-000000003002&view=insights&period=month&currency=USD');
  await expect(page.getByRole('navigation', { name: 'History views' }).getByRole('link', { name: 'Insights' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByText('Highest-spend categories')).toBeVisible();
  await expect(page.getByText('Food', { exact: true }).first()).toBeVisible();
});
