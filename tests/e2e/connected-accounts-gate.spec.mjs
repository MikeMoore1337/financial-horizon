import { test, expect } from '@playwright/test';
import { observe, visitGuest, view } from './helpers.mjs';

// The isolated localhost E2E server issues a genuine FH AuthStore session
// without making extra public registration requests. The PostgreSQL/finance
// HTTP response below is still synthetic and never treated as live money.

test('#33 server-backed accounts remain hidden to guests and are available only when authenticated', async ({page, context}) => {
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
  await expect(page.locator('[data-settings-card="finance-accounts"]')).toBeVisible();
  expect(financeCalls).toEqual([]);
  watch.assertClean();
});

test('#33 reviewed production entry uses existing FH session and reads only authoritative finance state', async ({page, context}) => {
  const watch = await observe(context, page);
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
  await expect(page.locator('#storage-context-chip')).toHaveText('На сервере');
  await expect(page.locator('#storage-context-title')).toHaveText('Счета в аккаунте');
  await expect(page.locator('#storage-context-footnote')).toContainText('Счета хранятся на сервере');
  await expect(page.locator('#top-add')).toBeHidden();
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
  await expect(page.locator('#storage-context-chip')).toHaveText('Локально');
  await expect(page.locator('#storage-context-title')).toHaveText('Хранится на устройстве');
  await expect(page.locator('#storage-context-footnote')).toContainText('Данные остаются в этом браузере');
  await expect(page.locator('#top-add')).toBeVisible();
  expect(await receipt()).toEqual({session: 1, state: 1});
  watch.assertClean();
});
