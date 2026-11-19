import { test, expect } from '@playwright/test';
import { observe, visitGuest, view, scopedState } from './helpers.mjs';

function iso(date) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')].join('-');
}
function plusDays(days) {
  const target = new Date();
  target.setHours(12, 0, 0, 0);
  target.setDate(target.getDate() + days);
  return iso(target);
}
async function addScheduledExpense(page, title, date, amount) {
  await page.locator('#top-add').click();
  const form = page.locator('#entry-form');
  await expect(page.locator('#entry-dialog')).toBeVisible();
  await form.locator('[name="title"]').fill(title);
  await form.locator('[name="kind"]').selectOption('expense');
  await form.locator('[name="amount"]').fill(amount);
  await form.locator('[name="date"]').fill(date);
  await form.locator('[name="recurrence"]').selectOption('monthly');
  await form.locator('button[type="submit"]').click();
  await expect(page.locator('#entry-dialog')).not.toBeVisible();
}
async function openDue(page) {
  await view(page, 'obligations');
  await page.locator('.fh-reserve-tabs').getByRole('button', { name: /К оплате/ }).click();
  await expect(page.getByRole('heading', { name: 'Центр оплат' })).toBeVisible();
}

test('#40 real guest: persisted 1/3/7 preferences, partial and full confirmed payment', async ({ page, context }) => {
  const watch = await observe(context, page);
  await page.setViewportSize({ width: 393, height: 852 });
  await visitGuest(page);
  const due = plusDays(3);
  await addScheduledExpense(page, 'Проверка напоминания #40', due, '1500');
  await openDue(page);
  const card = page.locator('.fh-center-event').filter({ hasText: 'Проверка напоминания #40' }).first();
  await expect(card).toContainText('1 500');
  await expect(card).toContainText('осталось 3 дн.');
  await page.getByRole('button', { name: 'Настроить напоминания' }).click();
  await expect(page.getByRole('checkbox', { name: 'За 3 дня' })).toBeChecked();
  await page.getByRole('checkbox', { name: 'За 3 дня' }).uncheck();
  await expect(page.locator('.fh-center-payments .fh-center-count')).toHaveText('0');
  await expect(card).toBeVisible(); // Switch never hides outstanding debts.
  let settings = await scopedState(page, 'state');
  expect(settings.settings.paymentReminders).toMatchObject({ enabled: true, daysBefore: [1, 7] });

  await page.reload();
  await openDue(page);
  await page.getByRole('button', { name: 'Настроить напоминания' }).click();
  await expect(page.getByRole('checkbox', { name: 'За 3 дня' })).not.toBeChecked();
  await page.getByRole('checkbox', { name: 'За 3 дня' }).check();
  await expect(page.locator('.fh-center-payments .fh-center-count')).toHaveText('1');

  await card.getByRole('button', { name: 'Отметить оплату' }).click();
  await expect(page.locator('#settlement-dialog')).toBeVisible();
  await page.locator('#settlement-form [name="amount"]').fill('500');
  await page.locator('#settlement-form button[type="submit"]').click();
  await expect.poll(async () => (await scopedState(page, 'state')).settlements.length).toBe(1);
  await expect(card).toContainText('1 000');
  await expect(card).toContainText('Частично оплачено');

  await card.getByRole('button', { name: 'Отметить оплату' }).click();
  await page.locator('#settlement-form [name="amount"]').fill('1000');
  await page.locator('#settlement-form button[type="submit"]').click();
  await expect.poll(async () => (await scopedState(page, 'state')).settlements.length).toBe(2);
  await expect(page.locator('.fh-center-event').filter({ hasText: 'Проверка напоминания #40' })).toHaveCount(0);
  settings = await scopedState(page, 'state');
  expect(settings.settlements.reduce((sum, p) => sum + p.amountCents, 0)).toBe(150000);
  expect(settings.entries).toHaveLength(1);
  watch.assertClean();
});

test('#40 same-origin two guest tabs share one ledger and re-render after an offline return', async ({ page, context }) => {
  const watch = await observe(context, page);
  await visitGuest(page);
  const due = plusDays(1);
  await addScheduledExpense(page, 'Синхронизация напоминаний #40', due, '620');
  await openDue(page);
  const other = await context.newPage();
  await other.goto('/?guest=1');
  await openDue(other);
  const secondCard = other.locator('.fh-center-event').filter({ hasText: 'Синхронизация напоминаний #40' });
  await expect(secondCard).toBeVisible();

  await context.setOffline(true);
  await page.locator('.fh-center-event').filter({ hasText: 'Синхронизация напоминаний #40' })
    .getByRole('button', { name: 'Отметить оплату' }).click();
  await page.locator('#settlement-form [name="amount"]').fill('620');
  await page.locator('#settlement-form button[type="submit"]').click();
  await expect.poll(async () => (await scopedState(page, 'state')).settlements.length).toBe(1);
  await expect(secondCard).toHaveCount(0);
  await context.setOffline(false);
  await other.bringToFront();
  await expect(secondCard).toHaveCount(0);
  await expect(page.locator('.fh-center-event').filter({ hasText: 'Синхронизация напоминаний #40' })).toHaveCount(0);
  await other.close();
  watch.assertClean();
});

test('#40 no unwanted Notification API or push permission request, no overflow at 320px', async ({ page, context }) => {
  const watch = await observe(context, page);
  await page.setViewportSize({ width: 320, height: 780 });
  await context.addInitScript(() => {
    window.__fhNotificationCalls = 0;
    window.Notification = class {
      static requestPermission() { window.__fhNotificationCalls++; return Promise.resolve('denied'); }
    };
  });
  await visitGuest(page);
  await addScheduledExpense(page, 'Платёж на узком экране #40', plusDays(7), '900');
  await openDue(page);
  await expect(page.locator('.fh-center-event').filter({ hasText: 'Платёж на узком экране #40' })).toBeVisible();
  await page.getByRole('button', { name: 'Настроить напоминания' }).click();
  const result = await page.evaluate(() => ({
    overflow: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) -
      document.documentElement.clientWidth,
    notifications: window.__fhNotificationCalls,
  }));
  expect(result.overflow).toBeLessThanOrEqual(1);
  expect(result.notifications).toBe(0);
  watch.assertClean();
});

test('#40 actual authenticated reserve snapshot warns at 3 days and refreshes after top-up', async ({ page, context }) => {
  const watch = await observe(context, page);
  await page.clock.setFixedTime(new Date('2026-12-09T12:00:00Z'));
  const session = await context.request.post(
    '/__e2e__/personal-session?enable_finance_stub=true&enable_reserves_stub=true',
  );
  expect(session.status()).toBe(200);
  await page.goto('/?fh_reserves_e2e=1');
  await openDue(page);
  const notice = page.locator('.fh-center-reserves .fh-center-event').filter({ hasText: 'Хостинг' });
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('3 000,00 ₽');
  await expect(notice).toContainText('Осталось 3 дн.');
  await notice.getByRole('button', { name: 'Открыть резерв' }).click();
  const hosting = page.locator('.fh-reserve-card').filter({ hasText: 'Хостинг' });
  await expect(hosting).toBeVisible();
  await hosting.getByRole('button', { name: 'Пополнить' }).click();
  const funding = page.getByRole('dialog', { name: 'Пополнить резерв' });
  await funding.getByRole('textbox', { name: 'Сумма, ₽' }).fill('1000');
  await funding.getByRole('button', { name: 'Пополнить', exact: true }).click();
  await expect(funding).toHaveCount(0);
  await expect(page.locator('.fh-center-reserves .fh-center-event').filter({ hasText: 'Хостинг' }))
    .toContainText('2 000,00 ₽');
  watch.assertClean();
});
