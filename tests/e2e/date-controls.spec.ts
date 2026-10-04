import { test, expect } from './fixtures';
import type { Locator } from '@playwright/test';

const group = '00000000-0000-4000-8000-000000003002';
const locations = [
  { name: 'expense create', path: `/groups/${group}/expense/new`, count: 1 },
  { name: 'expense edit', path: `/groups/${group}/expense/00000000-0000-4000-8000-000000004001`, count: 1 },
  { name: 'repeat start/end', path: `/groups/${group}/expense/new`, count: 2, repeat: true },
  { name: 'schedule edit', path: `/groups/${group}/scheduled-expense/00000000-0000-4000-8000-000000007001`, count: 2, schedule: true },
  { name: 'refund create', path: `/groups/${group}/refund/new`, count: 1 },
  { name: 'refund edit', path: `/groups/${group}/refund/00000000-0000-4000-8000-000000008001/edit`, count: 1 },
  { name: 'credit edit alias', path: `/groups/${group}/credit/00000000-0000-4000-8000-000000008001/edit`, count: 1 },
  { name: 'settlement create', path: `/groups/${group}/settle`, count: 1 },
  { name: 'settlement edit', path: `/groups/${group}/settlements/00000000-0000-4000-8000-000000005001`, count: 1, edit: true },
  { name: 'group filters expanded', path: `/activity?group=${group}&view=transactions`, count: 2, filters: true },
  { name: 'global filters expanded', path: '/activity?view=transactions', count: 2, filters: true },
  { name: 'group custom insights', path: `/activity?group=${group}&view=insights&period=custom`, count: 2, insights: true },
  { name: 'global custom insights', path: '/activity?view=insights&period=custom', count: 2, insights: true },
];

async function expectContained(input: Locator, context: string) {
  await expect(input).toBeVisible();
  const violations = await input.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const failures: string[] = [];
    for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      const bounds = parent.getBoundingClientRect();
      if (box.left < bounds.left - 1 || box.right > bounds.right + 1) failures.push(parent.className || parent.tagName);
    }
    if (box.left < -1 || box.right > innerWidth + 1) failures.push('viewport');
    return failures;
  });
  expect(violations, `${context} must fit every containing layer`).toEqual([]);
}

for (const width of [320, 390, 767, 768, 895, 896, 1440]) {
  test(`date controls stay contained and retain values at ${width}px`, async ({ authenticatedPage: page }) => {
    await page.setViewportSize({ width, height: 900 });
    page.on('dialog', (dialog) => void dialog.accept());
    for (const location of locations) {
      await test.step(location.name, async () => {
        await page.goto(location.path);
        if (location.repeat) await page.getByLabel('Repeat this expense').check();
        if (location.edit) await page.getByRole('button', { name: 'Edit settlement', exact: true }).click();
        if (location.filters) await page.getByText('Search and filters', { exact: true }).click();
        const dates = page.locator('input[type="date"]');
        await expect(dates).toHaveCount(location.count);
        for (let index = 0; index < location.count; index += 1) {
          const input = dates.nth(index);
          await expectContained(input, `${location.name}: initial date ${index}`);
          // Schedule preview assumes a valid start date. Test its native empty
          // rendering without sending an invalid draft to that unrelated preview.
          if ((location.repeat || location.schedule) && index === 0) {
            await input.evaluate((element: HTMLInputElement) => { element.value = ''; });
          } else {
            await input.fill('');
          }
          await expect(input).toHaveValue('');
          await expectContained(input, `${location.name}: empty date ${index}`);
          const value = index === 0 ? '2030-01-02' : '2030-02-03';
          await input.fill(value);
          await input.blur();
          await expect(input).toHaveValue(value);
          await expectContained(input, `${location.name}: populated date ${index}`);
        }
        if (location.repeat || location.schedule) {
          await expect(dates.nth(1)).toHaveAttribute('min', '2030-01-02');
          await dates.nth(1).fill('');
          await expect(dates.nth(1)).toHaveValue('');
          await expectContained(dates.nth(1), `${location.name}: cleared optional end`);
        }
        if (location.insights) {
          await page.getByRole('button', { name: 'Apply range', exact: true }).click();
          await expect(page).toHaveURL(/from=2030-01-02&to=2030-02-03/);
          await expect(dates.nth(0)).toHaveValue('2030-01-02');
          await expect(dates.nth(1)).toHaveValue('2030-02-03');
        }
      });
    }
  });
}
