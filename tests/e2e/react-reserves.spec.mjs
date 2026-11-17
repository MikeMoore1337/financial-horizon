import {test,expect} from '@playwright/test';
import {observe,visitGuest,view,addEntry,nativeDb} from './helpers.mjs';

test('#6 Payments and Reserves remain isolated for guests, with original payment records intact',async({page,context})=>{
 const watch=await observe(context,page);
 const reserveCalls=[];
 page.on('request',req=>{
  if(req.url().includes('/api/finance/v2/commands')||
     req.url().includes('/api/finance/v1/state'))reserveCalls.push(req.url());
 });
 await visitGuest(page);
 await addEntry(page,'Синтетический хостинг',{amount:'1800.25'});
 await view(page,'obligations');
 const before=await nativeDb(page);
 await page.getByRole('button',{name:'Накопления',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Накопления недоступны'})).toBeVisible();
 await expect(page.locator('.fh-reserve-stat')).toHaveCount(0);
 await page.getByRole('button',{name:'Платежи',exact:true}).click();
 await expect(page.locator('.records-table')).toContainText('Синтетический хостинг');
 expect(await nativeDb(page)).toEqual(before);
 expect(reserveCalls).toEqual([]);
 watch.assertClean();
});

test('#6 new reserves route requires separately activated production API even for authenticated users',async({page,context})=>{
 const watch=await observe(context,page);
 const financeCalls=[];
 page.on('request',req=>{
  if(req.url().includes('/api/finance/v1/state')||
     req.url().includes('/api/finance/v2/commands')||
     req.url().includes('/api/auth/email/finance/session')){
     financeCalls.push(req.url());
  }
 });
 const response=await context.request.post('/__e2e__/personal-session?enable_finance_stub=true');
 expect(response.status()).toBe(200);
 await page.goto('/');
 await expect(page.locator('#toolbar-title')).toHaveText('Обзор');
 await view(page,'obligations');
 await page.getByRole('button',{name:'Накопления',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Накопления недоступны'})).toBeVisible();
 await view(page,'calendar');
 await expect(page.locator('#toolbar-title')).toHaveText('Календарь платежей');
 expect(financeCalls).toEqual([]);
 watch.assertClean();
});

test('#6 reserves segmented switch stays within viewport at all approved sizes in both themes',async({page,context})=>{
 const watch=await observe(context,page);
 await visitGuest(page);
 for(const width of [320,360,393,768,1150,1440,2560]){
  await page.setViewportSize({width,height:900});
  for(const theme of ['light','dark']){
   if(await page.locator('body').getAttribute('data-theme')!==theme)
    await page.locator('#theme-toggle').click();
   await view(page,'obligations');
   await page.getByRole('button',{name:'Накопления',exact:true}).click();
   const state=await page.evaluate(()=>({
    scroll:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth),
    width:document.documentElement.clientWidth,
   }));
   expect(state.scroll,'overflow '+width+'/'+theme).toBeLessThanOrEqual(state.width+1);
   await expect(page.locator('.fh-reserve-tabs')).toBeVisible();
   await expect(page.getByRole('heading',{name:'Накопления недоступны'})).toBeVisible();
  }
 }
 watch.assertClean();
});
