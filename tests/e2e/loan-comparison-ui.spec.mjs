import { test, expect } from '@playwright/test';
import { observe, visitGuest, view, scopedState } from './helpers.mjs';

const bankCsv = [
  'Date;Payment;Interest;Principal;Balance',
  '2026-02-01;300.00;0.00;300.00;1200.00',
  '2026-03-01;300.00;0.00;300.00;900.00',
  '2026-04-01;300.00;0.00;300.00;600.00',
  '2026-05-01;300.00;0.00;300.00;300.00',
  '2026-06-01;300.00;0.00;300.00;0.00',
].join('\n') + '\n';

async function addSyntheticLoan(page) {
  await page.locator('[data-action="new-loan"]').first().click();
  const form = page.locator('#loan-form');
  for (const [field, value] of Object.entries({
    title: 'Synthetic bank comparison', opening: '1500', payment: '300',
    apr: '0', term: '5', asOfDate: '2026-01-01', dueDay: '1',
  })) await form.locator('[name="' + field + '"]').fill(value);
  await form.locator('button[type="submit"]').click();
  await expect(page.locator('#loan-dialog')).not.toBeVisible();
  await expect(page.locator('.loan-card')).toHaveCount(1);
}

async function confirmBankRules(page) {
  await page.getByRole('button', { name: 'Уточнить условия банка' }).click();
  const dialog = page.getByRole('dialog', { name: 'Условия банка' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('input[readonly]')).toHaveValue('2026-01-01');
  await dialog.locator('[name="firstDueDate"]').fill('2026-02-01');
  await dialog.locator('[name="dueDayAnchor"]').fill('1');
  await dialog.locator('[name="annualRate"]').fill('0');
  await dialog.locator('[name="dayCount"]').selectOption('ACT/365F');
  await dialog.locator('[name="rounding"]').selectOption('HALF_UP');
  await dialog.locator('[name="scheduleType"]').selectOption('annuity');
  await dialog.locator('[name="installmentBasis"]').selectOption('fixed-contractual');
  await dialog.locator('[name="agreementConfirmed"]').check();
  await dialog.locator('[name="openingBalanceDateConfirmed"]').check();
  await dialog.getByRole('button', { name: 'Рассчитать и сравнить' }).click();
  await expect(dialog).not.toBeVisible();
}

test('approved loan comparison uses all persisted bank rows without any IndexedDB writes', async ({ page, context }) => {
  const watcher = await observe(context, page);
  await visitGuest(page);
  await view(page, 'loans');
  await addSyntheticLoan(page);
  await page.locator('[data-action="schedule-import"]').click();
  await page.locator('#schedule-file').setInputFiles({
    name: 'synthetic-complete.csv', mimeType: 'text/csv', buffer: Buffer.from(bankCsv),
  });
  await expect.poll(async () => (await scopedState(page, 'state')).loans[0].schedule.length).toBe(5);
  const before = await scopedState(page, 'state');
  const section = page.locator('.loan-comparison');
  await expect(section).toContainText('Условия не подтверждены');
  await expect(section.locator('.loan-comparison-table-scroll')).toHaveCount(0);
  await confirmBankRules(page);
  await expect(section.locator('.loan-comparison-status')).toContainText('Числовое совпадение');
  await expect(section.locator('.loan-comparison-metrics')).toContainText('Полная');
  await expect(section.locator('.loan-comparison-table-scroll tbody tr')).toHaveCount(5);
  await expect(section).toContainText('Банковская идентичность не подтверждена');
  expect(await scopedState(page, 'state')).toEqual(before);

  const changedCsv = bankCsv.replace('2026-06-01;300.00', '2026-06-01;300.01');
  await page.getByLabel('Локальный банковский CSV для сверки').setInputFiles({
    name: 'PRIVATE_SYNTHETIC_BANK.csv', mimeType: 'text/csv', buffer: Buffer.from(changedCsv),
  });
  await expect(section.locator('.loan-comparison-status')).toContainText('Обнаружены расхождения');
  await expect(section.locator('.loan-comparison-metrics')).toContainText('1');
  await expect(section).not.toContainText('PRIVATE_SYNTHETIC_BANK');
  expect(await scopedState(page, 'state')).toEqual(before);

  const incomplete = ['Date;Payment;Balance', ...bankCsv.trim().split('\n').slice(1).map(x => {
    const [date, amount, , , balance] = x.split(';');
    return [date, amount, balance].join(';');
  })].join('\n');
  await page.getByLabel('Локальный банковский CSV для сверки').setInputFiles({
    name: 'incomplete.csv', mimeType: 'text/csv', buffer: Buffer.from(incomplete),
  });
  await expect(section.locator('.loan-comparison-status')).toContainText('данных недостаточно');
  await expect(section.locator('.loan-comparison-metrics')).toContainText('Не подтверждена');
  expect(await scopedState(page, 'state')).toEqual(before);

  await page.reload();
  await view(page, 'loans');
  await expect(page.locator('.loan-comparison-status')).toContainText('Правила банка не подтверждены');
  await expect(page.locator('.loan-detail')).toContainText('Расчёт по аннуитетной модели');
  expect(await scopedState(page, 'state')).toEqual(before);
  watcher.assertClean();
});

test('approved comparison dialog retains focus, mobile width and both themes', async ({ page, context }) => {
  const watcher = await observe(context, page);
  await visitGuest(page);
  await view(page, 'loans');
  await addSyntheticLoan(page);
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    for (const theme of ['light', 'dark']) {
      if (await page.locator('body').getAttribute('data-theme') !== theme) {
        await page.locator('#theme-toggle').click();
      }
      const button = page.getByRole('button', { name: 'Уточнить условия банка' });
      await button.click();
      const dialog = page.getByRole('dialog', { name: 'Условия банка' });
      await expect(dialog).toBeVisible();
      const sizing = await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        scroll: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
        dialogWidth: document.querySelector('.loan-comparison-dialog').getBoundingClientRect().width,
      }));
      expect(sizing.scroll, 'page overflow ' + width + '/' + theme).toBeLessThanOrEqual(sizing.viewport + 1);
      expect(sizing.dialogWidth, 'dialog overflow ' + width + '/' + theme).toBeLessThanOrEqual(sizing.viewport);
      await page.keyboard.press('Escape');
      await expect(dialog).not.toBeVisible();
    }
  }
  watcher.assertClean();
});
