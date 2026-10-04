import { test, expect, newAuthenticatedContext, BASE_URL, DEV_EMAIL } from './fixtures';

const widths = [320, 390, 767, 768, 895, 896, 1440];
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9V8AAAAASUVORK5CYII=', 'base64');

for (const width of widths) test(`account avatar preference, preview and fallback at ${width}px`, async ({ browser }) => {
  const context = await newAuthenticatedContext(browser, DEV_EMAIL, { width, height: 900 }, { serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    await context.request.put(`${BASE_URL}/api/me`, { headers: { Origin: BASE_URL }, data: { name: 'BillSplit Saved Name', avatarMode: 'initials' } });
    let images = 0;
    let failImages = false;
    await page.route('https://gravatar.com/**', async (route) => {
      images += 1;
      if (failImages) await route.fulfill({ status: 404 });
      else await route.fulfill({ contentType: 'image/png', body: image });
    });
    let releaseIdentity!: () => void;
    const identityReady = new Promise<void>((resolve) => { releaseIdentity = resolve; });
    let failSave = true;
    await page.route('**/api/me', async (route) => {
      if (route.request().method() === 'GET') await identityReady;
      if (route.request().method() === 'PUT' && failSave) {
        failSave = false;
        await route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: 'Profile temporarily unavailable' } } });
      } else await route.continue();
    });
    await page.goto(`${BASE_URL}/settings`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.auth-loading-shell')).toBeVisible();
    expect(images).toBe(0);
    releaseIdentity();
    await expect(page.getByRole('combobox', { name: 'Avatar', exact: true })).toHaveValue('initials');
    await expect(page.locator('[aria-label="Avatar preview"] .avatar')).toHaveText('BS');
    expect(images).toBe(0);
    await page.getByRole('combobox', { name: 'Avatar', exact: true }).selectOption('gravatar');
    // A name-only update in another tab must not erase this unsaved choice.
    const renamed = await (await context.request.put(`${BASE_URL}/api/me`, { headers: { Origin: BASE_URL }, data: { name: 'BillSplit Saved Name Renamed' } })).json();
    await page.evaluate((user) => {
      const channel = new BroadcastChannel('billsplit-auth');
      channel.postMessage({ type: 'profile-changed', userId: user.id, personId: user.personId, name: user.name, profileRevision: user.profileRevision, generation: Number(localStorage.getItem('billsplit-session-generation') || 0), nonce: `rename-${user.profileRevision}`, owner: 'other-tab' });
      channel.close();
    }, renamed.user);
    await expect(page.getByRole('textbox', { name: 'Display name', exact: true })).toHaveValue(renamed.user.name);
    await expect(page.getByRole('combobox', { name: 'Avatar', exact: true })).toHaveValue('gravatar');
    await expect(page.getByText(/Gravatar is a third-party service/)).toBeVisible();
    await expect(page.locator('[aria-label="Avatar preview"] img')).toBeVisible();
    await page.getByRole('button', { name: 'Save profile' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Profile temporarily unavailable' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Avatar', exact: true })).toHaveValue('gravatar');
    await page.getByRole('button', { name: 'Save profile' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Profile updated' })).toBeVisible();
    const saved = await (await context.request.get(`${BASE_URL}/api/me`)).json();
    expect(saved.avatarMode).toBe('gravatar');
    expect(saved.avatarHash).toMatch(/^[a-f0-9]{64}$/);
    await page.route('**/api/groups', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.groups[0] = { ...body.groups[0], kind: 'named', counterpartName: 'Other Saved User', counterpartAvatar: { avatarMode: 'gravatar', avatarHash: 'b'.repeat(64) } };
      await route.fulfill({ response, json: body });
    });
    await page.goto(`${BASE_URL}/`);
    await expect(page.locator('.group-card').first().locator('.avatar img').first()).toBeVisible();
    await expect(page.locator('.group-card').first().locator('.avatar').first()).toHaveAttribute('aria-label', saved.name);
    await expect(page.locator('.group-card').first().locator('.avatar[aria-label="Other Saved User"] img')).toHaveAttribute('src', `https://gravatar.com/avatar/${'b'.repeat(64)}?s=96&r=g&d=404`);
    if (width >= 896) await expect(page.locator('.desktop-user-avatar img')).toBeVisible();
    await page.goto(`${BASE_URL}/groups/00000000-0000-4000-8000-000000003002`);
    await expect(page.locator(`.people-preview-list .avatar[aria-label="${saved.name}"] img`)).toBeVisible();
    failImages = true;
    await page.goto(`${BASE_URL}/settings`);
    await expect(page.locator('[aria-label="Avatar preview"] .avatar')).toHaveText('BS');
    await expect(page.locator('[aria-label="Avatar preview"] img')).toHaveCount(0);
    await page.evaluate((user) => new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('bill-split-local');
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('offlineTrust', 'readwrite');
        tx.objectStore('offlineTrust').put({ key: 'current', state: 'active', revision: 1, userId: user.id, personId: user.personId, email: user.email, name: user.name, avatarMode: user.avatarMode, avatarHash: user.avatarHash, profileRevision: user.profileRevision, clerkUserId: 'e2e-clerk', verifiedAt: new Date().toISOString() });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    }), saved);
    await context.setOffline(true);
    await expect(page.getByRole('button', { name: 'Save profile' })).toBeDisabled();
    await expect(page.locator('[aria-label="Avatar preview"] .avatar')).toHaveText('BS');
    await expect(page.getByText('Profile changes require a connection.')).toBeVisible();
    const bounds = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
    expect(bounds.scroll).toBeLessThanOrEqual(bounds.width);
  } finally {
    await context.setOffline(false);
    await context.request.put(`${BASE_URL}/api/me`, { headers: { Origin: BASE_URL }, data: { name: 'Dev User', avatarMode: 'initials' } });
    await context.close();
  }
});

test('profile save errors retain the accessible unsaved choice', async ({ authenticatedPage }) => {
  await authenticatedPage.route('https://gravatar.com/**', (route) => route.fulfill({ status: 404 }));
  await authenticatedPage.goto('/settings');
  await authenticatedPage.route('**/api/me', (route) => route.request().method() === 'PUT'
    ? route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: 'Profile temporarily unavailable' } } })
    : route.continue());
  await authenticatedPage.getByRole('combobox', { name: 'Avatar', exact: true }).selectOption('gravatar');
  await authenticatedPage.getByRole('button', { name: 'Save profile' }).click();
  await expect(authenticatedPage.getByRole('alert').filter({ hasText: 'Profile temporarily unavailable' })).toBeVisible();
  await expect(authenticatedPage.getByRole('combobox', { name: 'Avatar', exact: true })).toHaveValue('gravatar');
  await expect(authenticatedPage.getByRole('button', { name: 'Save profile' })).toBeEnabled();
});
