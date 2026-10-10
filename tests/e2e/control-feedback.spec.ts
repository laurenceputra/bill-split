import path from 'node:path';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Locator, Page, TestInfo } from '@playwright/test';
import { test, expect, BASE_URL } from './fixtures';
import { AuthBannerAction, Button, InstallButton, PublicAuthAction } from '../../src/app/control-actions';
import { UpdateStatus } from '../../src/app/update-status';

const noop = () => undefined;
const section = (id: string, title: string, ...children: ReturnType<typeof h>[]) => h('section', { id }, h('h2', null, title), ...children);
const fixture = renderToStaticMarkup(h('main', null,
  h('h1', null, 'Sample control feedback'),
  section('variants', 'Standard actions',
    ...(['primary', 'secondary', 'danger', 'quiet'] as const).map((variant) => h(Button, { key: variant, variant, 'data-control': variant }, variant)),
    h(Button, { loading: true, 'data-control': 'busy' }, 'Busy action'),
    h(Button, { disabled: true, 'data-control': 'disabled' }, 'Disabled action'),
    h('button', { className: 'secondary', 'data-control': 'legacy-secondary' }, 'Legacy secondary'),
    h('button', { className: 'danger', 'data-control': 'legacy-danger' }, 'Legacy danger'),
    h('button', { className: 'inline-action', 'data-control': 'inline' }, 'Retry')),
  section('public', 'Public authentication', h('div', { className: 'public-auth-actions' }, h(PublicAuthAction), h(PublicAuthAction, { signUp: true }))),
  section('install', 'Install actions',
    h('div', { className: 'landing-actions', 'data-context': 'landing' }, h(InstallButton, { label: 'Install BillSplit', secondary: true })),
    h('div', { className: 'top-bar__actions', 'data-context': 'topbar' }, h(InstallButton, { label: 'Install' })),
    h('div', { 'data-context': 'settings' }, h(InstallButton, { label: 'Install' })),
    h('div', { 'data-context': 'install-busy' }, h(InstallButton, { label: 'Install', busy: true }))),
  section('updates', 'App updates',
    h(UpdateStatus, { settings: true, update: { phase: 'ready', updateReady: true, applying: false, blocked: false }, onCheck: noop, onApply: noop }),
    ...(['checking', 'installing', 'applying', 'offline'] as const).map((phase) => h('div', { key: phase, 'data-phase': phase }, h(UpdateStatus, { settings: true, update: { phase, updateReady: false, applying: phase === 'applying', blocked: false, offline: phase === 'offline' }, onCheck: noop })))),
  section('banners', 'Session feedback', ...(['sign-in', 'checking', 'error'] as const).map((state) => h('div', { key: state, className: `auth-banner${state === 'checking' ? ' auth-banner--checking' : ''}`, 'data-state': state }, h('span', null, state === 'sign-in' ? 'Sign in again to continue syncing.' : state === 'checking' ? 'Checking connection.' : 'Connection issue.'), h(AuthBannerAction, { state, onRetry: noop }))))));

async function token(page: Page, background: string, foreground: string) {
  return page.evaluate(({ background, foreground }) => {
    const probe = document.createElement('div');
    probe.style.background = background === 'transparent' ? background : `var(${background})`;
    probe.style.color = `var(${foreground})`;
    document.body.append(probe);
    const style = getComputedStyle(probe);
    const result = { background: style.backgroundColor, foreground: style.color };
    probe.remove();
    return result;
  }, { background, foreground });
}

async function assertPaint(control: Locator, colors: { background: string; foreground: string }) {
  await expect(control).toHaveCSS('background-color', colors.background);
  await expect(control).toHaveCSS('color', colors.foreground);
}

async function capture(page: Page, testInfo: TestInfo, section: string, width: number) {
  expect(await page.locator('body').innerText()).not.toMatch(/[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b[a-f0-9]{64}\b/i);
  await expect(page.locator('img')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  const name = `control-feedback-${section}-${width === 390 ? 'mobile' : 'desktop'}`;
  const destination = process.env.UPDATE_HOME_SCREENSHOTS === '1' ? path.join(process.cwd(), 'docs', 'screenshots', `${name}.png`) : testInfo.outputPath(`${name}.png`);
  await page.locator(`#${section}`).screenshot({ path: destination, animations: 'disabled' });
  await testInfo.attach(name, { path: destination, contentType: 'image/png' });
}

for (const width of [320, 390, 895, 896, 1440]) {
  test(`Production control presentation owns computed feedback at ${width}px`, async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    // Load the built application's real theme, without booting providers or API data.
    const html = await (await request.get(BASE_URL)).text();
    const stylesheet = html.match(/href="([^"]+\.css)"/)!;
    expect(stylesheet).toBeTruthy();
    await page.setContent(`<base href="${BASE_URL}/"><link rel="stylesheet" href="${stylesheet[1]}">${fixture}<style>main { padding: 16px; } section { display: grid; gap: 12px; margin-bottom: 24px; } section > button { justify-self: start; } #banners .auth-banner { position: static; width: 100%; margin: 0; max-height: none; } #updates .update-control { flex-wrap: wrap; }</style>`);
    const primaryHover = await token(page, '--color-primary-hover', '--color-primary-fg');
    const primaryPressed = await token(page, '--color-primary-pressed', '--color-primary-fg');
    const secondary = await token(page, '--color-primary-subtle-hover', '--color-primary-hover');
    const danger = await token(page, '--color-debt-subtle', '--color-debt-fg');
    const quiet = await token(page, '--color-primary-subtle', '--color-primary-pressed');
    const banner = await token(page, '--color-debt-fg', '--color-debt-bg');
    const cases: [Locator, typeof primaryHover, typeof primaryHover, string?][] = [
      [page.locator('[data-control="primary"]'), primaryHover, primaryPressed],
      ...['secondary', 'legacy-secondary'].map((name): [Locator, typeof secondary, typeof secondary] => [page.locator(`[data-control="${name}"]`), secondary, secondary]),
      ...['danger', 'legacy-danger'].map((name): [Locator, typeof danger, typeof danger] => [page.locator(`[data-control="${name}"]`), danger, danger]),
      [page.locator('[data-control="quiet"]'), quiet, quiet],
      [page.locator('[data-control="inline"]'), await token(page, 'transparent', '--color-primary'), await token(page, 'transparent', '--color-primary-pressed')],
      [page.locator('.public-sign-in'), primaryHover, primaryPressed],
      [page.locator('.public-sign-up'), secondary, secondary, 'public'],
      [page.locator('[data-context="landing"] button'), secondary, secondary],
      [page.locator('[data-context="topbar"] button'), primaryHover, primaryPressed],
      [page.locator('[data-context="settings"] button'), primaryHover, primaryPressed, 'install'],
      [page.locator('#updates > .update-control button').first(), secondary, secondary],
      [page.locator('#updates > .update-control button').last(), secondary, secondary, 'updates'],
      ...['sign-in', 'checking', 'error'].map((state): [Locator, typeof banner, typeof banner, string?] => [page.locator(`[data-state="${state}"] button`), banner, banner, state === 'error' ? 'banners' : undefined]),
    ];
    for (const [control, hover, pressed, evidence] of cases) {
      await control.hover();
      await assertPaint(control, hover);
      await page.mouse.down();
      await assertPaint(control, pressed);
      if (evidence && (width === 390 || width === 1440)) await capture(page, testInfo, evidence, width);
      await page.mouse.move(0, 0);
      await page.mouse.up();
    }
    for (const control of await page.locator('button:disabled').all()) {
      await expect(control).toBeDisabled();
      await control.hover();
      const isSecondary = await control.evaluate((node) => node.classList.contains('button--secondary'));
      await assertPaint(control, isSecondary ? secondary : primaryHover);
      await page.mouse.down();
      await assertPaint(control, isSecondary ? secondary : primaryPressed);
      await expect(control).toHaveCSS('opacity', '0.58');
      await page.mouse.move(0, 0);
      await page.mouse.up();
    }
    await expect(page.locator('[data-control="busy"]')).toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('[data-context="install-busy"] button')).toHaveAttribute('aria-busy', 'true');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
}
