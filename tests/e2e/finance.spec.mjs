import {test,expect} from '@playwright/test';
import {observe,visitGuest,view,addEntry,scopedState} from './helpers.mjs';

test('income/expense CRUD, fact edit and void through actual UI',async({page,context})=>{
 await page.setViewportSize({width:1280,height:800});
 const watcher=await observe(context,page);
 await visitGuest(page);
 await addEntry(page,'E2E planned income',{kind:'income',amount:'24000'});
 await addEntry(page,'E2E planned expense',{amount:'1200'});
 await view(page,'obligations');
 let row=page.locator('.records-table tbody tr').filter({hasText:'E2E planned expense'});
 await row.locator('[data-action="edit-entry"]').click();
 await page.locator('#entry-form [name="title"]').fill('E2E expense revised');
 await page.locator('#entry-form [name="amount"]').fill('1375.50');
 await page.locator('#entry-form button[type="submit"]').click();
 await expect(page.locator('#entry-dialog')).not.toBeVisible();
 let state=await scopedState(page,'state');
 expect(state.entries.find(x=>x.title==='E2E expense revised').amountCents).toBe(137550);
 row=page.locator('.records-table tbody tr').filter({hasText:'E2E expense revised'});
 await row.locator('[data-action="settle"]').click();
 await page.locator('#settlement-form [name="amount"]').fill('750');
 await page.locator('#settlement-form button[type="submit"]').click();
 await expect.poll(async()=> (await scopedState(page,'state')).settlements.length).toBe(1);
 state=await scopedState(page,'state');expect(state.settlements[0].amountCents).toBe(75000);
 await page.setViewportSize({width:390,height:844});
 await view(page,'obligations');
 await page.locator('.records-mobile .record-mobile-row').filter({hasText:'E2E expense revised'}).locator('[data-action="expand-entry"]').click();
 await page.locator('.records-mobile [data-action="edit-settlement"]').first().click();
 await page.locator('#settlement-form [name="amount"]').fill('600');
 await page.locator('#settlement-form button[type="submit"]').click();
 await expect.poll(async()=> (await scopedState(page,'state')).settlements[0].amountCents).toBe(60000);
 await page.locator('.records-mobile [data-action="void-settlement"]').first().click();
 await expect(page.locator('#confirmation-dialog')).toBeVisible();
 await page.locator('#confirm-yes').click();
 await expect.poll(async()=>Boolean((await scopedState(page,'state')).settlements[0].voidedAt)).toBe(true);
 watcher.assertClean();
});

test('archive and restore financial record preserves historic entry',async({page,context})=>{
 await page.setViewportSize({width:1280,height:800});
 const watcher=await observe(context,page);
 await visitGuest(page);await addEntry(page,'E2E archive-only expense');
 await view(page,'obligations');
 await page.locator('.records-table tbody tr').filter({hasText:'E2E archive-only expense'}).locator('[data-action="archive-entry"]').click();
 await page.locator('#confirm-yes').click();
 await expect.poll(async()=>Boolean((await scopedState(page,'state')).entries[0].deletedAt)).toBe(true);
 await view(page,'settings');
 await page.locator('[data-settings-card="archive"] [data-action="restore-item"]').click();
 expect((await scopedState(page,'state')).entries[0].deletedAt).toBeUndefined();
 await view(page,'obligations');
 await expect(page.locator('.records-table tbody')).toContainText('E2E archive-only expense');
 watcher.assertClean();
});

test('loan creation, actual payment and cancellation survive reload',async({page,context})=>{
 const watcher=await observe(context,page);
 await visitGuest(page);await view(page,'loans');
 await page.locator('[data-action="new-loan"]').first().click();
 const f=page.locator('#loan-form');
 for(const [field,value] of Object.entries({
  title:'E2E synthetic loan',opening:'10000',apr:'0',payment:'1000',
  term:'10',asOfDate:'2026-11-01',dueDay:'15'
 }))await f.locator('[name="'+field+'"]').fill(value);
 await f.locator('button[type="submit"]').click();
 await expect(page.locator('#loan-dialog')).not.toBeVisible();
 await expect.poll(async()=> (await scopedState(page,'state')).loans.length).toBe(1);
 await page.locator('[data-action="pay"]').first().click();
 const p=page.locator('#payment-form');
 await p.locator('[name="amount"]').fill('500');
 await p.locator('[name="date"]').fill('2026-11-15');
 await expect(p.locator('button[type="submit"]')).toBeEnabled();
 await p.locator('button[type="submit"]').click();
 await expect.poll(async()=> (await scopedState(page,'state')).loanPayments.length).toBe(1);
 await page.reload();
 expect((await scopedState(page,'state')).loanPayments[0].amountCents).toBe(50000);
 await view(page,'loans');
 await page.locator('[data-action="void-payment"]').first().click();
 await page.locator('#confirm-yes').click();
 await expect.poll(async()=>Boolean((await scopedState(page,'state')).loanPayments[0].voidedAt)).toBe(true);
 watcher.assertClean();
});
