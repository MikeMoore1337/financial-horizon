import {test,expect} from '@playwright/test';
import {observe,visitGuest,view,addEntry,scopedState} from './helpers.mjs';

test('React calendar settlement saves exactly once and survives reload',async({page,context})=>{
 const watcher=await observe(context,page);
 await visitGuest(page);
 await addEntry(page,'E2E React calendar expense',{amount:'199.75'});
 await view(page,'calendar');
 await page.locator('.cal-day[data-date="2026-11-15"]').click();
 const row=page.locator('.cal-layout .plain-list .list-row').filter({hasText:'E2E React calendar expense'});
 await expect(row).toHaveCount(1);
 await row.locator('[data-action="settle"]').click();
 await expect(page.locator('#settlement-dialog')).toBeVisible();
 await page.locator('#settlement-form [name="amount"]').fill('50.25');
 await page.locator('#settlement-form button[type="submit"]').click();
 await expect(page.locator('#settlement-dialog')).not.toBeVisible();
 await expect.poll(async()=> (await scopedState(page,'state')).settlements.length).toBe(1);
 const state=await scopedState(page,'state');
 expect(state.settlements[0].amountCents).toBe(5025);
 await page.reload();
 await view(page,'calendar');
 await page.locator('.cal-day[data-date="2026-11-15"]').click();
 await expect(page.locator('.cal-layout .plain-list .list-row').filter({hasText:'E2E React calendar expense'})).toContainText('Частично');
 watcher.assertClean();
});

test('React calendar loan payment dispatches the original domain operation only once',async({page,context})=>{
 const watcher=await observe(context,page);
 await visitGuest(page);
 await view(page,'loans');
 await page.locator('[data-action="new-loan"]').first().click();
 const form=page.locator('#loan-form');
 for(const [field,value] of Object.entries({
  title:'E2E React calendar loan',opening:'10000',apr:'0',payment:'1000',
  term:'10',asOfDate:'2026-11-01',dueDay:'15'
 }))await form.locator('[name="'+field+'"]').fill(value);
 await form.locator('button[type="submit"]').click();
 await expect(page.locator('#loan-dialog')).not.toBeVisible();
 await view(page,'calendar');
 await page.locator('.cal-day[data-date="2026-11-15"]').click();
 const row=page.locator('.cal-layout .plain-list .list-row').filter({hasText:'E2E React calendar loan'});
 await expect(row).toHaveCount(1);
 await row.locator('[data-action="pay"]').click();
 await expect(page.locator('#payment-dialog')).toBeVisible();
 const payment=page.locator('#payment-form');
 await payment.locator('[name="amount"]').fill('500');
 await payment.locator('[name="date"]').fill('2026-11-15');
 await payment.locator('button[type="submit"]').click();
 await expect(page.locator('#payment-dialog')).not.toBeVisible();
 await expect.poll(async()=> (await scopedState(page,'state')).loanPayments.length).toBe(1);
 expect((await scopedState(page,'state')).loanPayments[0].amountCents).toBe(50000);
 watcher.assertClean();
});
