import { test, expect } from '@playwright/test';
import { deflateSync } from 'node:zlib';
import AxeBuilder from '@axe-core/playwright';
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

test('#138 older unpaid occurrences remain individually actionable', async ({page}) => {
  await page.clock.setFixedTime(new Date('2026-11-20T12:00:00'));
  await visitGuest(page);
  await addScheduledExpense(page, 'Историческое обязательство #138', '2025-01-15', '100');
  await openDue(page);
  const older = page.locator('.fh-center-event[data-payment-occurrence="2025-01"]')
    .filter({hasText: 'Историческое обязательство #138'});
  const newer = page.locator('.fh-center-event[data-payment-occurrence="2026-10"]')
    .filter({hasText: 'Историческое обязательство #138'});
  await expect(older).toBeVisible();
  await expect(newer).toBeVisible();
  await older.getByRole('button', {name: 'Отметить оплату'}).click();
  await page.locator('#settlement-form [name="amount"]').fill('20');
  await page.locator('#settlement-form [name="date"]').fill('2026-11-20');
  await page.locator('#settlement-form button[type="submit"]').click();
  await expect(older).toContainText('Частично оплачено');
  await expect(newer).not.toContainText('Частично оплачено');
  expect((await scopedState(page, 'state')).settlements[0]).toMatchObject({
    occurrence: '2025-01', date: '2026-11-20', amountCents: 2000,
  });
});

test('#138 guest: partial amount, overpayment rejection and remaining payment', async ({ page }) => {
  await visitGuest(page);
  await addScheduledExpense(page, 'Оплата частями #138', plusDays(1), '100.01');
  await openDue(page);
  const card = page.locator('.fh-center-event').filter({ hasText: 'Оплата частями #138' });
  await card.getByRole('button', { name: 'Отметить оплату' }).click();
  const form = page.locator('#settlement-form');
  await expect(form.locator('[name="date"]')).toHaveValue(iso(new Date()));
  await form.locator('[name="amount"]').fill('30');
  await form.locator('button[type="submit"]').click();
  await expect(page.locator('#settlement-dialog')).not.toBeVisible();
  await card.getByRole('button', { name: 'Отметить оплату' }).click();
  await expect(form.locator('[name="amount"]')).toHaveValue('70.01');
  await expect(form.locator('#settlement-description')).toContainText('Осталось:');
  await form.locator('[name="amount"]').fill('70.02');
  await form.locator('button[type="submit"]').click();
  await expect(page.locator('#settlement-dialog')).toBeVisible();
  expect((await scopedState(page, 'state')).settlements).toHaveLength(1);
  await form.locator('[name="amount"]').fill('70.01');
  await form.locator('button[type="submit"]').click();
  await expect(card).toHaveCount(0);
  const state = await scopedState(page, 'state');
  expect(state.settlements.map((payment) => payment.amountCents)).toEqual([3000, 7001]);
});

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
  await expect(notice).toContainText(/3\s*000\s*₽/);
  await expect(notice).toContainText('Осталось 3 дн.');
  await notice.getByRole('button', { name: 'Открыть резерв' }).click();
  const detail = page.getByRole('dialog', { name: 'Хостинг' });
  await expect(detail).toBeVisible();
  await detail.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await expect(detail).toHaveCount(0);
  const hosting = page.locator('.fh-reserve-card').filter({ hasText: 'Хостинг' });
  await expect(hosting).toBeVisible();
  await hosting.getByRole('button', { name: 'Пополнить' }).click();
  const funding = page.getByRole('dialog', { name: 'Пополнить резерв' });
  await funding.getByRole('textbox', { name: 'Сумма, ₽' }).fill('1000');
  await funding.getByRole('button', { name: 'Пополнить', exact: true }).click();
  await expect(funding).toHaveCount(0);
  await expect(page.locator('.fh-center-reserves .fh-center-event').filter({ hasText: 'Хостинг' }))
    .toContainText(/2\s*000\s*₽/);
  watch.assertClean();
});


function syntheticQrPng() {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const payload = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    let crc = 0xffffffff;
    for (const byte of payload) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const trailer = Buffer.alloc(4);
    trailer.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, payload, trailer]);
  };
  const header = Buffer.from('89504e470d0a1a0a', 'hex');
  const dimensions = Buffer.alloc(13);
  dimensions.writeUInt32BE(1, 0);
  dimensions.writeUInt32BE(1, 4);
  dimensions[8] = 8;
  dimensions[9] = 6;
  return Buffer.concat([
    header,
    chunk('IHDR', dimensions),
    chunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 0, 255]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('#137 real browser: QR, other methods, focus, 320-1280 and unchanged settlements', async ({ page, context }) => {
  const watch = await observe(context, page);
  await visitGuest(page);
  const title = 'Синтетический платёж #137';
  await addScheduledExpense(page, title, plusDays(1), '1240');
  await openDue(page);
  const card = page.locator('.fh-center-event[data-payment-source="entry"]').filter({ hasText: title });
  await card.getByRole('button', { name: 'Настроить оплату' }).click();
  await expect(page.locator('#entry-dialog')).toBeVisible();
  await page.locator('[data-action="open-payment-methods"]').click();
  const form = page.locator('#payment-method-form');
  const png = syntheticQrPng();
  await form.locator('[name="type"]').selectOption('qr_image');
  await form.locator('[name="label"]').fill('Сохранённый QR');
  await form.locator('[name="qrFile"]').setInputFiles({ name: 'fixture.png', mimeType: 'image/png', buffer: png });
  await form.locator('button[type="submit"]').click();
  await expect.poll(async () => ((await scopedState(page, 'state')).entries[0].paymentMethods?.length ?? 0)).toBe(1);
  await form.locator('[name="type"]').selectOption('sbp_link');
  await form.locator('[name="label"]').fill('СБП');
  await form.locator('[name="value"]').fill('https://qr.nspk.ru/example');
  await form.locator('button[type="submit"]').click();
  await expect.poll(async () => (await scopedState(page, 'state')).entries[0].paymentMethods.length).toBe(2);
  await form.locator('[name="type"]').selectOption('requisites');
  await form.locator('[name="label"]').fill('Реквизиты');
  await form.locator('[name="value"]').fill('ООО Пример, счёт 40817810000000000001');
  await form.locator('button[type="submit"]').click();
  await expect.poll(async () => (await scopedState(page, 'state')).entries[0].paymentMethods.length).toBe(3);
  await page.locator('#payment-methods-dialog [data-action="close-payment-methods"]').first().click();
  await page.locator('#entry-form button[value="cancel"]').first().click();
  await openDue(page);

  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => localStorage.setItem('fh-theme', value), theme);
    await page.reload();
    await expect(page.locator('body')).toHaveAttribute('data-theme', theme);
    await openDue(page);
    const payment = page.locator('.fh-center-event[data-payment-source="entry"]').filter({ hasText: title });
    const trigger = payment.getByRole('button', { name: 'Показать QR' });
    await trigger.click();
    const viewer = payment.getByRole('region', { name: 'Просмотр QR-кода' });
    await expect(viewer.getByRole('img', { name: 'Сохранённый QR-код для оплаты' })).toBeVisible();
    await expect(viewer.getByRole('link', { name: 'Перейти к оплате СБП' }))
      .toHaveAttribute('rel', /noreferrer/);
    await expect(viewer.getByRole('button', { name: 'Скопировать реквизиты' })).toBeVisible();
    await expect(viewer.getByRole('button', { name: 'Закрыть QR' })).toBeFocused();
    const axe = await new AxeBuilder({ page })
      .include('.fh-center')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(
      axe.violations.map((violation) => ({
        rule: violation.id,
        impact: violation.impact,
        elements: violation.nodes.map((node) => node.target),
      })),
      'Opened QR and alternatives must satisfy automated WCAG checks in ' + theme,
    ).toEqual([]);
    for (const width of [320, 375, 393, 768, 1280]) {
      await page.setViewportSize({ width, height: 852 });
      const overflow = await page.evaluate(() =>
        Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) -
        document.documentElement.clientWidth);
      expect(overflow, 'No horizontal overflow at ' + width + 'px').toBeLessThanOrEqual(1);
    }
    await page.keyboard.press('Escape');
    await expect(viewer).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await payment.getByText('Другие способы оплаты (2)').click();
    await expect(payment.getByRole('link', { name: 'Перейти к оплате СБП' })).toBeVisible();
    await expect(payment.getByRole('button', { name: 'Изменить' })).toHaveAttribute('data-action', 'edit-entry');
  }
  const state = await scopedState(page, 'state');
  expect(state.entries).toHaveLength(1);
  expect(state.entries[0].paymentMethods).toHaveLength(3);
  expect(state.settlements).toHaveLength(0); // External actions never mark payment as confirmed.
  watch.assertClean();
});
