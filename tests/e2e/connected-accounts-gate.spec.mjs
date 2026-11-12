import { test, expect } from '@playwright/test';
import { ORIGIN, observe, visitGuest, view } from './helpers.mjs';

const PROFILE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
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

test('#33 owner-approved opt-in shows a real PWA entry and reads only authoritative finance response', async ({page, context, request}) => {
  const watch = await observe(context, page);
  const financeCalls = [];
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
  await page.route('**/api/auth/email/finance/session', async (route) => {
    financeCalls.push('session');
    expect(route.request().method()).toBe('POST');
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ok: true, profile_id: PROFILE}),
    });
  });
  await page.route('**/api/finance/v1/state?limit_entities=5000', async (route) => {
    financeCalls.push('state');
    expect(route.request().method()).toBe('GET');
    await route.fulfill({
      status: 200, contentType: 'application/json',
      headers: {'ETag': '"fh.1.0.synthetic"', 'Cache-Control': 'no-store'},
      body: JSON.stringify({
        schema_version: 1, profile_id: PROFILE, revision: 0, currency: 'RUB',
        entities: [], server_at: '2026-11-12T12:00:00+00:00',
      }),
    });
  });
  // The same isolated backend exercises the real FH cookie behavior.
  const session = await context.request.post('/__e2e__/personal-session');
  expect(session.status()).toBe(200);
  await page.goto('/');
  await expect(page.locator('#toolbar-title')).toHaveText('Обзор');
  await view(page, 'settings');
  await expect(page.locator('[data-settings-card="finance-accounts"]')).toBeVisible();
  await page.locator('[data-settings-card="finance-accounts"] [data-view="accounts-connected"]').click();
  await expect(page.locator('#toolbar-title')).toHaveText('Счета и кошельки');
  await expect(page.locator('.fh-accounts-total')).toContainText('Всего на счетах');
  await expect(page.locator('.fh-accounts-total')).toContainText('0');
  expect(financeCalls).toEqual(['session', 'state']);
  await page.getByRole('button', {name: /К обзору/}).click();
  await expect(page.locator('#toolbar-title')).toHaveText('Обзор');
  expect(financeCalls).toEqual(['session', 'state']);
  watch.assertClean();
});
