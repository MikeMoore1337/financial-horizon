import { test, expect } from '@playwright/test';
import { ORIGIN, observe, visitGuest, view } from './helpers.mjs';

// The isolated localhost E2E server issues a genuine FH AuthStore session
// without making extra public registration requests. The PostgreSQL/finance
// HTTP response below is still synthetic and never treated as live money.

test('#33 server-backed accounts are absent for guest and unapproved production shell', async ({page, context}) => {
  const watch = await observe(context, page);
  const financeCalls = [];
  page.on('request', (req) => {
    if (req.url().includes('/api/finance/') || req.url().includes('/api/auth/email/finance/session')) {
      financeCalls.push(req.url());
    }
  });
  await visitGuest(page);
  await view(page, 'settings');
  await expect(page.locator('[data-settings-card="finance-accounts"]')).toHaveCount(0);
  // Even a manually injected navigation button cannot bypass the UI feature gate.
  await page.evaluate(() => {
    const button = document.createElement('button');
    button.dataset.view = 'accounts-connected';
    document.body.append(button);
    button.click();
    button.remove();
  });
  await expect(page.locator('#toolbar-title')).toHaveText('Настройки');
  // Use an actual HttpOnly FH session shared with this browser context,
  // never route or mock /api/auth/email/me (which differs under WebKit SW).
  const session = await context.request.post('/__e2e__/personal-session');
  expect(session.status()).toBe(200);
  await page.evaluate(() => sessionStorage.removeItem('fh-guest-session-v2'));
  await page.goto('/');
  await expect(page.locator('#toolbar-title')).toHaveText('Обзор');
  await view(page, 'settings');
  await expect(page.locator('[data-settings-card="finance-accounts"]')).toHaveCount(0);
  expect(financeCalls).toEqual([]);
  watch.assertClean();
});

test('#33 owner-approved opt-in shows a real PWA entry and reads only authoritative finance response', async ({page, context}) => {
  const watch = await observe(context, page);
  await page.route(ORIGIN + '/', async (route) => {
    const upstream = await route.fetch();
    const body = await upstream.text();
    const original = '<meta name="fh-finance-accounts" content="disabled">';
    if (!body.includes(original)) throw Error('Unreviewed PWA finance feature markup');
    await route.fulfill({
      response: upstream,
      body: body.replace(original, '<meta name="fh-finance-accounts" content="enabled">'),
    });
  });
  // The same isolated backend exercises the real FH cookie behavior.
  const session = await context.request.post(
    '/__e2e__/personal-session?enable_finance_stub=true',
  );
  expect(session.status()).toBe(200);
  const actor = (await session.json()).user.id;
  await page.goto('/');
  await expect(page.locator('#toolbar-title')).toHaveText('Обзор');
  await view(page, 'settings');
  await expect(page.locator('[data-settings-card="finance-accounts"]')).toBeVisible();
  await page.locator('[data-settings-card="finance-accounts"] [data-view="accounts-connected"]').click();
  await expect(page.locator('#toolbar-title')).toHaveText('Счета и кошельки');
  await expect(page.locator('.fh-accounts-total')).toContainText('Всего на счетах');
  await expect(page.locator('.fh-accounts-total')).toContainText('0');
  // Assertions come from the synthetic localhost backend itself rather
  // than Playwright interception (WebKit service workers bypass page.route).
  const receipt = async () => {
    const response = await context.request.get(
      '/__e2e__/finance-stub/receipt?user_id=' + encodeURIComponent(actor),
    );
    expect(response.status()).toBe(200);
    return response.json();
  };
  expect(await receipt()).toEqual({session: 1, state: 1});
  await page.getByRole('button', {name: /К обзору/}).click();
  await expect(page.locator('#toolbar-title')).toHaveText('Обзор');
  expect(await receipt()).toEqual({session: 1, state: 1});
  watch.assertClean();
});
