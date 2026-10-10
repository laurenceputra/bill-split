import { test, expect, newAuthenticatedContext, BASE_URL, DEV_EMAIL } from './fixtures';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { UpdateStatus } from '../../src/app/update-status';
import type { ServiceWorkerUpdateState } from '../../src/app/service-worker';

test('Settings keeps profile before app updates and destructive actions across responsive boundaries', async ({ browser }) => {
  for (const width of [320, 390, 767, 768, 895, 896, 1440]) {
    const context = await newAuthenticatedContext(browser, DEV_EMAIL, { width, height: 844 }, { serviceWorkers: 'block' });
    try {
      const page = await context.newPage();
      await page.goto(`${BASE_URL}/settings`);
      await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
      const check = page.getByRole('button', { name: 'Check for updates', exact: true });
      await expect(check).toBeVisible();
      await expect(check).toBeDisabled();
      await expect(page.getByText('No successful update check yet.', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: /Apply when ready|Force refresh/ })).toHaveCount(0);
      const order = await page.locator('main h2').allTextContents();
      expect(order.indexOf('Profile')).toBeLessThan(order.indexOf('Device'));
      expect(order.indexOf('Device')).toBeLessThan(order.indexOf('Delete BillSplit account'));
      const geometry = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
      expect(geometry.scroll).toBeLessThanOrEqual(geometry.width);
      const original = await page.getByLabel('Display name', { exact: true }).inputValue();
      await page.getByLabel('Display name', { exact: true }).fill('Unsaved responsive profile');
      await page.getByRole('heading', { name: 'Device', exact: true }).click();
      await expect(page.getByLabel('Display name', { exact: true })).toHaveValue('Unsaved responsive profile');
      await page.getByLabel('Display name', { exact: true }).fill(original);
    } finally { await context.close(); }
  }
});

test('update status presentation fits Settings and the contextual header in every meaningful phase', async ({ browser }) => {
  const phases: ServiceWorkerUpdateState['phase'][] = ['initializing', 'unsupported', 'idle', 'checking', 'installing', 'no-update', 'ready', 'blocked', 'applying', 'check-error', 'install-error', 'offline', 'deferred'];
  for (const width of [320, 390, 767, 768, 895, 896, 1440]) {
    const context = await newAuthenticatedContext(browser, DEV_EMAIL, { width, height: 844 }, { serviceWorkers: 'block' });
    try {
      const page = await context.newPage();
      await page.goto(`${BASE_URL}/settings`);
      await expect(page.getByRole('heading', { name: 'Device', exact: true })).toBeVisible();
      // These are presentation fixtures using the exact production component,
      // not simulated worker activation. The A/B suite owns lifecycle behavior.
      for (const phase of phases) {
         for (const variant of phase === 'blocked' ? [{ blockerReason: 'Unsaved profile' }, { blockerReason: 'Another tab has unsaved work; finish that entry before updating' }, { offline: true }] : phase === 'ready' ? [{}, { offline: true }] : phase === 'deferred' ? [{}, { manualError: 'Verifying the activated update before refreshing. Verification will retry automatically; try Update now again if it does not finish.' }] : [{}]) {
           const { blockerReason, offline, manualError } = variant as { blockerReason?: string; offline?: boolean; manualError?: string };
           const update = { phase, updateReady: ['ready', 'blocked'].includes(phase), blocked: phase === 'blocked', applying: phase === 'applying', blockerReason, offline, manualError: manualError ?? blockerReason, lastSuccess: Date.UTC(2026, 0, 1) } as ServiceWorkerUpdateState;
          const settings = renderToStaticMarkup(createElement(UpdateStatus, { update, settings: true, onCheck: () => undefined }));
          const header = renderToStaticMarkup(createElement(UpdateStatus, { update, onCheck: () => undefined }));
          await page.evaluate(({ settings, header }) => {
            document.querySelector('main .update-control')!.outerHTML = settings;
            document.querySelector('.top-bar__actions > .update-control')?.remove();
            document.querySelector('.top-bar__actions')!.insertAdjacentHTML('afterbegin', header);
          }, { settings, header });
           const button = page.locator('main .update-control button').last();
           if (offline || ['initializing', 'unsupported', 'checking', 'installing', 'applying', 'offline'].includes(phase)) await expect(button).toBeDisabled();
          else await expect(button).toBeEnabled();
           await expect(page.locator('main .update-control [role="status"]').first()).not.toBeEmpty();
           await expect(page.getByRole('button', { name: /Apply when ready|Force refresh/ })).toHaveCount(0);
           if (offline) {
             await expect(page.locator('main').getByRole('button', { name: 'Update now', exact: true })).toBeEnabled();
             await expect(page.getByText('Offline: checking for new updates requires a connection. The installed update can still use Update now.')).toBeVisible();
           }
          const overflow = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, clipped: [...document.querySelectorAll<HTMLElement>('.update-control')].some((node) => node.scrollWidth > node.clientWidth + 1) }));
          expect(overflow.scroll, `${width}px ${phase} ${blockerReason}`).toBeLessThanOrEqual(overflow.width);
          expect(overflow.clipped, `${width}px ${phase} ${blockerReason}`).toBe(false);
        }
      }
    } finally { await context.close(); }
  }
});
