import {test,expect} from '@playwright/test';
import {observe,visitGuest,view,addEntry,nativeDb,scopedState} from './helpers.mjs';

test('real native IndexedDB survives reload and syncs another browser tab',async({page,context})=>{
 const watcher=await observe(context,page);
 await visitGuest(page);
 await addEntry(page,'E2E guest durable entry',{kind:'income',amount:'1234.56'});
 const db=await nativeDb(page);
 expect(db.keys).toContain('state');
 expect(db.keys).not.toContain('legacy-account-claim-v2');
 expect((await scopedState(page,'state')).entries).toEqual(
  expect.arrayContaining([expect.objectContaining({title:'E2E guest durable entry',amountCents:123456,kind:'income'})]));
 await page.reload();
 await expect(page.locator('#toolbar-title')).toHaveText('Обзор');
 expect((await scopedState(page,'state')).entries.some(e=>e.title==='E2E guest durable entry')).toBe(true);
 const other=await context.newPage();
 const anotherWatcher=await observe(context,other);
 await visitGuest(other);
 await expect.poll(async()=>Boolean((await scopedState(other,'state'))?.entries.some(e=>e.title==='E2E guest durable entry'))).toBe(true);
 await addEntry(page,'E2E broadcast update');
 await expect.poll(async()=>Boolean((await scopedState(other,'state'))?.entries.some(e=>e.title==='E2E broadcast update'))).toBe(true);
 anotherWatcher.assertClean();watcher.assertClean();
 await other.close();
});

test('two browser profiles have distinct real origin storage',async({browser})=>{
 const a=await browser.newContext(),b=await browser.newContext();
 try{
  const first=await a.newPage(),second=await b.newPage();
  const wa=await observe(a,first),wb=await observe(b,second);
  await visitGuest(first);await addEntry(first,'E2E private profile A');
  await visitGuest(second);
  const dbA=await scopedState(first,'state'),dbB=await scopedState(second,'state');
  expect(dbA.entries.some(e=>e.title==='E2E private profile A')).toBe(true);
  expect(dbB?.entries.some(e=>e.title==='E2E private profile A')??false).toBe(false);
  wa.assertClean();wb.assertClean();
 }finally{await a.close();await b.close();}
});

test('theme, navigation and responsive widths do not overflow',async({page,context})=>{
 const watcher=await observe(context,page);
 await visitGuest(page);
 for(const size of [{width:320,height:740},{width:390,height:844},{width:1280,height:800}]){
  await page.setViewportSize(size);
  for(const section of ['calendar','obligations','loans','settings','overview']){
   await view(page,section);
   const width=await page.evaluate(()=>({page:document.documentElement.scrollWidth,viewport:window.innerWidth}));
   if(width.page>width.viewport+1){
    const offenders=await page.evaluate(()=>Array.from(document.body.querySelectorAll('*'))
     .filter(el=>{const box=el.getBoundingClientRect();return box.width>0&&box.right>innerWidth+1&&getComputedStyle(el).display!=='none';})
     .slice(0,14).map(el=>({tag:el.tagName.toLowerCase(),id:el.id,css:typeof el.className==='string'?el.className:'',
      right:Math.round(el.getBoundingClientRect().right),width:Math.round(el.getBoundingClientRect().width)})));
    console.log('E2E_OVERFLOW_DIAG '+JSON.stringify({section,viewport:size.width,scrollWidth:width.page,offenders}));
   }
   expect(width.page,'Horizontal overflow in '+section+' at '+size.width+'px').toBeLessThanOrEqual(width.viewport+1);
  }
 }
 await page.locator('#theme-toggle').click();
 const chosen=await page.locator('body').getAttribute('data-theme');
 expect(['dark','light']).toContain(chosen);
 expect(await page.locator('html').getAttribute('data-theme')).toBe(chosen);
 expect(await page.locator('#theme-color').getAttribute('content')).toBe(chosen==='dark'?'#172336':'#ffffff');
 await page.reload();
 await expect(page.locator('body')).toHaveAttribute('data-theme',chosen);
 await page.locator('#theme-toggle').click();
 await expect(page.locator('body')).not.toHaveAttribute('data-theme',chosen);
 watcher.assertClean();
});


test('theme changes meta chrome immediately and persists after a browser reload',async({page,context})=>{
 const watcher=await observe(context,page);
 await visitGuest(page);
 await page.locator('#theme-toggle').click();
 const chosen=await page.locator('body').getAttribute('data-theme');
 expect(['dark','light']).toContain(chosen);
 await expect(page.locator('html')).toHaveAttribute('data-theme',chosen);
 await expect(page.locator('#theme-color')).toHaveAttribute('content',chosen==='dark'?'#172336':'#ffffff');
 await page.reload();
 await expect(page.locator('body')).toHaveAttribute('data-theme',chosen);
 await expect(page.locator('#theme-color')).toHaveAttribute('content',chosen==='dark'?'#172336':'#ffffff');
 await page.locator('#theme-toggle').click();
 await expect(page.locator('body')).not.toHaveAttribute('data-theme',chosen);
 watcher.assertClean();
});
