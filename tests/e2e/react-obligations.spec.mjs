import {test,expect} from '@playwright/test';
import {observe,visitGuest,view,addEntry,scopedState,nativeDb} from './helpers.mjs';

test('React obligations filtering and single settlement preserve IndexedDB',async({page,context})=>{
 const watch=await observe(context,page);
 await page.setViewportSize({width:1280,height:800});
 await visitGuest(page);
 await addEntry(page,'E2E React regular',{amount:'1500.50'});
 await addEntry(page,'E2E React income',{kind:'income',amount:'30000'});
 await page.locator('#top-add').click();
 const f=page.locator('#entry-form');
 await f.locator('[name="title"]').fill('E2E React once');
 await f.locator('[name="amount"]').fill('125');
 await f.locator('[name="date"]').fill('2026-11-15');
 await f.locator('[name="recurrence"]').selectOption('once');
 await f.locator('button[type="submit"]').click();
 await view(page,'obligations');
 const before=await nativeDb(page);
 await page.locator('[data-action="filter"][data-filter="regular"]').click();
 await expect(page.locator('.records-table tbody')).not.toContainText('E2E React once');
 await page.locator('[data-action="filter"][data-filter="once"]').click();
 await expect(page.locator('.records-table tbody')).toContainText('E2E React once');
 await page.locator('[data-action="filter"][data-filter="income"]').click();
 await expect(page.locator('.records-table tbody')).toContainText('E2E React income');
 await page.locator('[data-action="filter"][data-filter="all"]').click();
 expect(await nativeDb(page)).toEqual(before);
 await page.locator('.records-table tbody tr').filter({hasText:'E2E React once'})
  .locator('[data-action="settle"]').click();
 await page.locator('#settlement-form [name="amount"]').fill('50');
 await page.locator('#settlement-form button[type="submit"]').click();
 await expect.poll(async()=> (await scopedState(page,'state')).settlements.length).toBe(1);
 await page.reload();await view(page,'obligations');
 await expect(page.locator('.records-table tbody')).toContainText('Внесено');
 watch.assertClean();
});

test('React obligations adapt table/cards at 320-2560px in both themes',async({page,context})=>{
 const watch=await observe(context,page);
 await visitGuest(page);
 await addEntry(page,'E2E React responsive',{amount:'199.99'});
 for(const width of [320,360,393,768,1150,1151,1440,2560]){
  await page.setViewportSize({width,height:900});
  for(const theme of ['light','dark']){
   if(await page.locator('body').getAttribute('data-theme')!==theme)
    await page.locator('#theme-toggle').click();
   await view(page,'obligations');
   const result=await page.evaluate(()=>({
    scroll:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth),
    width:document.documentElement.clientWidth,
    table:getComputedStyle(document.querySelector('.records-table')).display!=='none',
    cards:getComputedStyle(document.querySelector('.records-mobile')).display!=='none',
   }));
   expect(result.scroll,'overflow '+width+'/'+theme).toBeLessThanOrEqual(result.width+1);
   expect(result.table).toBe(width>=1151);expect(result.cards).toBe(width<=1150);
   const action=width<=1150?
    page.locator('.records-mobile .record-mobile-actions [data-action="edit-entry"]'):
    page.locator('.records-table .record-actions [data-action="edit-entry"]');
   await expect(action.first()).toBeVisible();
  }
 }
 watch.assertClean();
});
