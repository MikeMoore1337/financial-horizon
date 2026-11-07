import {test,expect} from '@playwright/test';
import {observe,visitGuest,view,addEntry,nativeDb,scopedState} from './helpers.mjs';

test('React Overview: ledger data and navigation survive repeated screen transitions',async({page,context})=>{
 const watch=await observe(context,page);
 await visitGuest(page);
 await addEntry(page,'E2E Overview income',{kind:'income',amount:'30000'});
 await addEntry(page,'E2E Overview expense',{kind:'expense',amount:'1250'});
 const before=await nativeDb(page);
 for(const target of ['calendar','overview','obligations','overview','loans','overview','settings','overview']){
   await view(page,target);
   await expect(page.locator('#main h1').first()).toContainText(
     {overview:'Обзор месяца',calendar:'Календарь платежей',
      obligations:'Обязательства',loans:'Кредиты',settings:'Настройки'}[target]);
 }
 await expect(page.locator('.hero-amount')).toContainText(/28\s?750/);
 expect(await nativeDb(page)).toEqual(before);
 watch.assertClean();
});

test('React Overview: money action uses the existing one-shot ledger mutation',async({page,context})=>{
 const watch=await observe(context,page);
 await visitGuest(page);
 await addEntry(page,'E2E Overview settled',{amount:'499.50'});
 const action=page.locator('.overview-grid .plain-list .list-row').filter({hasText:'E2E Overview settled'}).locator('[data-action="settle"]');
 await action.click();
 await expect(page.locator('#settlement-dialog')).toBeVisible();
 await page.locator('#settlement-form [name="amount"]').fill('100');
 await page.locator('#settlement-form button[type="submit"]').click();
 await expect.poll(async()=> (await scopedState(page,'state')).settlements.length).toBe(1);
 await page.reload();
 expect((await scopedState(page,'state')).settlements[0].amountCents).toBe(10000);
 watch.assertClean();
});

test('React Overview: both themes, 320-2560 CSS px and desktop navigation',async({page,context})=>{
 const watch=await observe(context,page);
 await visitGuest(page);
 await page.locator('#main [data-action="sample"]').first().click();
 await page.locator('#confirm-yes').click();
 for(const width of [320,360,393,768,1150,1151,1440,2560]){
   await page.setViewportSize({width,height:900});
   for(const theme of ['light','dark']){
     if(await page.locator('body').getAttribute('data-theme')!==theme)
       await page.locator('#theme-toggle').click();
     await view(page,'overview');
     await expect(page.locator('#main h1')).toHaveText('Обзор месяца');
     const bounds=await page.evaluate(()=>({
       scroll:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth),
       width:document.documentElement.clientWidth,
     }));
     expect(bounds.scroll,'overflow at '+width+'/'+theme).toBeLessThanOrEqual(bounds.width+1);
   }
 }
 watch.assertClean();
});
