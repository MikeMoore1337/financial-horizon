import {test,expect} from '@playwright/test';
import {observe,visitGuest,view,scopedState} from './helpers.mjs';

const fixture='Дата;Сумма;Описание;Счёт;Тип;ID\n'
  +'07.11.2026;-100,50;Синтетическая покупка;Основной;;SYNC-1\n'
  +'08.11.2026;200,00;Синтетический доход;Основной;;SYNC-2\n';
const file={name:'synthetic-bank.csv',mimeType:'text/csv',buffer:Buffer.from(fixture)};

test('#38: guest CSV import is local, atomic, duplicate-safe and fully cancellable',async({page,context})=>{
  const observer=await observe(context,page);
  const financeCalls=[];
  page.on('request',req=>{
    if(req.url().includes('/api/finance/'))financeCalls.push(req.url());
  });
  await visitGuest(page);
  await view(page,'settings');
  await page.locator('[data-settings-card="bank-statement-import"] [data-view="bank-import"]').click();
  await expect(page.locator('#toolbar-title')).toHaveText('Импорт выписки');
  await expect(page.locator('.fh-bank-screen')).toBeVisible();

  await page.getByRole('textbox',{name:'Название'}).fill('Основной');
  await page.getByRole('textbox',{name:/Начальный остаток/}).fill('1000');
  await page.getByRole('button',{name:'Добавить счёт'}).click();
  await expect.poll(async()=> (await scopedState(page,'state'))?.bankStatements?.accounts?.length).toBe(1);
  // A second owned account must be available for internal transfer mapping.
  await page.getByRole('textbox',{name:'Название'}).fill('Накопления');
  await page.getByRole('textbox',{name:/Начальный остаток/}).fill('300');
  await page.getByRole('button',{name:'Добавить счёт'}).click();
  await expect.poll(async()=> (await scopedState(page,'state'))?.bankStatements?.accounts?.length).toBe(2);
  await expect(page.getByLabel('Остатки банковских счетов')).toContainText('Накопления');

  await page.locator('.fh-bank-file input[type="file"]').setInputFiles(file);
  await expect(page.locator('.fh-bank-table tbody tr')).toHaveCount(2);
  await expect(page.getByRole('button',{name:/Подтвердить импорт 2 операций/})).toBeEnabled();
  await page.getByRole('button',{name:/Подтвердить импорт 2 операций/}).click();
  await expect.poll(async()=>{
    const value=await scopedState(page,'state');
    return value?.bankStatements?.operations.length;
  }).toBe(2);
  const original=await scopedState(page,'state');
  const ledger=original.bankStatements;
  expect(ledger.batches).toHaveLength(1);
  expect(ledger.operations.map(x=>x.amountCents)).toEqual([10050,20000]);
  expect(ledger.accounts[0].openingMinor).toBe(100000);
  expect(original.entries).toEqual([]);
  expect(original.settlements).toEqual([]);
  expect(original.loanPayments).toEqual([]);
  await expect(page.locator('#fh-bank-history')).toContainText('Сохранено');

  await page.locator('.fh-bank-file input[type="file"]').setInputFiles(file);
  await expect(page.locator('.fh-bank-table tbody tr')).toHaveCount(2);
  await expect(page.getByRole('button',{name:/Подтвердить импорт/})).toBeDisabled();
  expect((await scopedState(page,'state')).bankStatements.operations).toHaveLength(2);

  page.once('dialog',dialog=>dialog.accept());
  await page.locator('#fh-bank-history').getByRole('button',{name:'Отменить'}).click();
  await expect.poll(async()=> (await scopedState(page,'state')).bankStatements.batches[0]
    .cancelledStateRevision).toBeGreaterThan(0);
  const cancelled=await scopedState(page,'state');
  expect(cancelled.bankStatements.operations).toHaveLength(2);
  expect(cancelled.bankStatements.batches[0].operationCount).toBe(2);
  expect(cancelled.bankStatements.batches[0].cancelledStateRevision).toBe(cancelled.revision);
  expect(cancelled.entries).toEqual([]);
  expect(financeCalls).toEqual([]);
  observer.assertClean();
});

test('#38: bank import mobile settings card has no overflow and does not send bank files',async({page,context})=>{
  const observer=await observe(context,page);
  await visitGuest(page);
  await page.setViewportSize({width:393,height:852});
  await view(page,'settings');
  await page.locator('[data-settings-card="bank-statement-import"] [data-view="bank-import"]').click();
  await expect(page.locator('.fh-bank-screen')).toBeVisible();
  const metrics=await page.evaluate(()=>({
    inner:document.documentElement.clientWidth,
    scroll:Math.max(document.body.scrollWidth,document.documentElement.scrollWidth),
  }));
  expect(metrics.scroll).toBeLessThanOrEqual(metrics.inner+1);
  observer.assertClean();
});
