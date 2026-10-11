import { test, expect, newAuthenticatedContext, BASE_URL, DEV_EMAIL } from './fixtures';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { UpdateStatus } from '../../src/app/update-status';
import type { ServiceWorkerUpdateState } from '../../src/app/service-worker';

const recoveryWidths = [320, 390, 767, 768, 895, 896, 834, 1024, 1440];

test('recovery opens separately and preserves an unsaved Settings profile', async ({ browser }) => {
  const context = await newAuthenticatedContext(browser, DEV_EMAIL, { width: 390, height: 844 }, { serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    await page.goto(`${BASE_URL}/settings`);
    const input = page.getByLabel('Display name', { exact: true });
    await input.fill('Unsaved sample profile');
    await page.getByText('Update diagnostics and recovery', { exact: true }).click();
    const link = page.getByRole('link', { name: 'Open update recovery instructions' });
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    const popupPromise = page.waitForEvent('popup');
    await link.click();
    const recovery = await popupPromise;
    await expect(recovery.getByRole('heading', { name: 'Recover a BillSplit update' })).toBeVisible();
    expect(await recovery.evaluate(() => window.opener === null)).toBe(true);
    await expect(page).toHaveURL(`${BASE_URL}/settings`);
    await expect(input).toHaveValue('Unsaved sample profile');
    await expect(page.getByText(/Close the recovery tab too/)).toBeVisible();
    await recovery.close();
    await expect(input).toHaveValue('Unsaved sample profile');
  } finally { await context.close(); }
});

test('diagnostics disclosure supports mouse and keyboard with contained builds and honest unavailable states', async ({ browser }) => {
  const variants: ServiceWorkerUpdateState[] = [
    { phase: 'ready', updateReady: true, applying: false, blocked: false, pageBuild: `bill-split-shell-${'a'.repeat(64)}`, activeBuild: `bill-split-shell-${'b'.repeat(64)}`, waitingBuild: `bill-split-shell-${'c'.repeat(64)}` },
    { phase: 'unsupported', updateReady: false, applying: false, blocked: false },
    { phase: 'blocked', updateReady: true, applying: false, blocked: true, manualError: 'Finish work in other open tabs, then try Update now again.' },
    { phase: 'offline', offline: true, updateReady: false, applying: false, blocked: false },
    { phase: 'check-error', updateReady: false, applying: false, blocked: false, manualError: 'Could not check for updates. Retry when connected.' },
  ];
  for (const width of recoveryWidths) {
    const context = await newAuthenticatedContext(browser, DEV_EMAIL, { width, height: 844 }, { serviceWorkers: 'block' });
    try {
      const page = await context.newPage();
      await page.goto(`${BASE_URL}/settings`);
      await expect(page.getByRole('heading', { name: 'Device', exact: true })).toBeVisible();
      for (const [index, update] of variants.entries()) {
        const markup = renderToStaticMarkup(createElement(UpdateStatus, { update, settings: true, onCheck: () => undefined }));
        await page.evaluate((markup) => { document.querySelector('main .update-control')!.outerHTML = markup; }, markup);
        const details = page.locator('main .update-diagnostics');
        const summary = details.locator('summary');
        const recovery = details.getByRole('link', { name: 'Open update recovery instructions' });
        await expect(recovery).not.toBeVisible();
        await summary.click();
        await expect(details).toHaveAttribute('open', '');
        await expect(recovery).toBeVisible();
        if (index === 0) {
          await expect(details.locator('dd')).toHaveText([update.pageBuild!, update.activeBuild!, update.waitingBuild!]);
        } else {
          await expect(details.locator('dd')).toHaveText(['Unavailable', 'Unavailable (older workers may not report a build)', update.updateReady ? 'Not yet verified' : 'None reported']);
        }
        await summary.focus();
        await page.keyboard.press('Space');
        await expect(recovery).not.toBeVisible();
        await page.keyboard.press('Enter');
        await expect(recovery).toBeVisible();
        const geometry = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, clipped: [...document.querySelectorAll<HTMLElement>('.update-control, .update-diagnostics, .update-diagnostics dd')].some((node) => node.scrollWidth > node.clientWidth + 1) }));
        expect(geometry.scroll, `${width}px variant ${index}`).toBeLessThanOrEqual(geometry.width);
        expect(geometry.clipped, `${width}px variant ${index}`).toBe(false);
        if (process.env.UPDATE_RECOVERY_SCREENSHOTS === '1' && index === 0 && [390, 834, 1440].includes(width)) {
          await page.evaluate(() => document.fonts.ready);
          // Isolated production-component evidence: fixed navigation must not
          // paint over the clipped component capture. Behavior runs with it visible.
          await page.addStyleTag({ content: '.bottom-nav { visibility: hidden !important; }' });
          await page.locator('main .update-control').screenshot({ path: `docs/screenshots/update-diagnostics-${width}.png`, animations: 'disabled' });
          await page.locator('style').last().evaluate((node) => node.remove());
        }
      }
    } finally { await context.close(); }
  }
});

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
