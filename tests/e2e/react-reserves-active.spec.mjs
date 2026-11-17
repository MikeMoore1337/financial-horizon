import { test, expect } from '@playwright/test';
import { observe, view } from './helpers.mjs';

// This E2E origin is a test-only FastAPI+SQLite auth server with an explicit
// reserve HTTP fixture. It is NOT evidence of a production PostgreSQL write.
// Real PostgreSQL/RLS/atomic payment integration runs separately in CI.

test('#6 approved reserve UX allocates once and pays once in Chromium/WebKit', async ({page,context}) => {
  const watch = await observe(context,page);
  const session = await context.request.post(
    '/__e2e__/personal-session?enable_finance_stub=true&enable_reserves_stub=true',
  );
  expect(session.status()).toBe(200);
  const actor = (await session.json()).user.id;

  await page.goto('/?fh_reserves_e2e=1');
  await expect(page.locator('#toolbar-title')).toHaveText('Обзор');
  await expect(page.locator('.fh-reserve-highlights')).toContainText('Хостинг');
  await view(page,'obligations');
  await page.locator('.fh-reserve-tabs').getByRole('button',{name:'Накопления'}).click();

  await expect(page.locator('.fh-reserve-stat')).toHaveCount(3);
  const stats = page.locator('.fh-reserve-statline');
  await expect(stats).toContainText('70 000,00 ₽');
  await expect(stats).toContainText('14 000,00 ₽');
  await expect(stats).toContainText('56 000,00 ₽');

  const hosting=page.locator('.fh-reserve-card').filter({hasText:'Хостинг'});
  await expect(hosting).toContainText('6 000,00 ₽ из 9 000,00 ₽');
  await hosting.getByRole('button',{name:'Пополнить'}).click();
  const funding=page.getByRole('dialog',{name:'Пополнить резерв'});
  await expect(funding).toBeVisible();
  await funding.getByRole('textbox',{name:'Сумма, ₽'}).fill('1000');
  await funding.getByRole('button',{name:'Пополнить',exact:true}).click();
  await expect(funding).toHaveCount(0);
  await expect(stats).toContainText('70 000,00 ₽');
  await expect(stats).toContainText('15 000,00 ₽');
  await expect(stats).toContainText('55 000,00 ₽');
  await expect(hosting).toContainText('7 000,00 ₽ из 9 000,00 ₽');

  await hosting.getByRole('button',{name:'Отметить оплату'}).click();
  const paying=page.getByRole('dialog',{name:'Отметить фактическую оплату'});
  await expect(paying).toBeVisible();
  await paying.getByRole('textbox',{name:'Фактически оплачено, ₽'}).fill('9000');
  await paying.getByRole('textbox',{name:'Из резерва, ₽'}).fill('7000');
  await expect(paying).toContainText('61 000,00 ₽');
  await expect(paying).toContainText('8 000,00 ₽');
  await expect(paying).toContainText('53 000,00 ₽');
  await paying.getByRole('button',{name:'Подтвердить фактическую оплату'}).click();
  await expect(paying).toHaveCount(0);
  await expect(stats).toContainText('61 000,00 ₽');
  await expect(stats).toContainText('8 000,00 ₽');
  await expect(stats).toContainText('53 000,00 ₽');

  const receipt=await context.request.get(
    '/__e2e__/finance-stub/receipt?user_id='+encodeURIComponent(actor),
  );
  expect(receipt.status()).toBe(200);
  expect((await receipt.json()).commands).toBe(2);
  watch.assertClean();
});

test('#6 completed reserve cycle rolls over without a second bank debit',async({page,context})=>{
  const watch=await observe(context,page);
  const session=await context.request.post(
    '/__e2e__/personal-session?enable_finance_stub=true&enable_reserves_stub=true',
  );
  expect(session.status()).toBe(200);
  const actor=(await session.json()).user.id;
  await page.goto('/?fh_reserves_e2e=1');
  await view(page,'obligations');
  await page.locator('.fh-reserve-tabs').getByRole('button',{name:'Накопления'}).click();
  const stats=page.locator('.fh-reserve-statline');
  const hosting=page.locator('.fh-reserve-card').filter({hasText:'Хостинг'});
  await hosting.getByRole('button',{name:'Отметить оплату'}).click();
  const pay=page.getByRole('dialog',{name:'Отметить фактическую оплату'});
  await pay.getByRole('textbox',{name:'Фактически оплачено, ₽'}).fill('9000');
  await pay.getByRole('textbox',{name:'Из резерва, ₽'}).fill('6000');
  await pay.getByRole('button',{name:'Подтвердить фактическую оплату'}).click();
  await expect(stats).toContainText('61 000,00 ₽');
  await expect(stats).toContainText('8 000,00 ₽');
  await hosting.getByRole('button',{name:'Подробнее'}).click();
  const detail=page.getByRole('dialog',{name:'Хостинг'});
  await expect(detail.getByRole('button',{name:'Закрыть цикл'})).toBeEnabled();
  page.once('dialog',dialog=>dialog.accept());
  await detail.getByRole('button',{name:'Закрыть цикл'}).click();
  await expect(detail).toHaveCount(0);
  await expect(hosting).toContainText('12 декабря 2027');
  await expect(stats).toContainText('61 000,00 ₽');
  await expect(stats).toContainText('8 000,00 ₽');
  const receipt=await context.request.get(
    '/__e2e__/finance-stub/receipt?user_id='+encodeURIComponent(actor),
  );
  expect((await receipt.json()).commands).toBe(2);
  watch.assertClean();
});
