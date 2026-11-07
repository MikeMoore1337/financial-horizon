import {test,expect} from '@playwright/test';
import {observe,visitGuest,addEntry,scopedState} from './helpers.mjs';

test('Vite to legacy PWA rollback preserves guest IndexedDB and offline shell',async({page,context,request})=>{
 const watcher=await observe(context,page);
 await visitGuest(page);
 await addEntry(page,'E2E rollback retained',{kind:'income',amount:'875.25'});
 const original=(await scopedState(page,'state')).entries.find(e=>e.title==='E2E rollback retained');
 await page.evaluate(()=>navigator.serviceWorker.ready);
 await expect.poll(()=>page.evaluate(async()=> (await caches.keys()).some(k=>k.startsWith('financial-horizon-shell-vite-')))).toBe(true);
 try{
  expect((await request.post('/__e2e__/sw-version/legacy')).ok()).toBe(true);
  await page.evaluate(async()=>{const reg=await navigator.serviceWorker.ready;await reg.update();});
  await expect.poll(()=>page.evaluate(async()=> (await caches.keys()).some(k=>k.startsWith('financial-horizon-shell-v25-theme-auth'))),{timeout:20000}).toBe(true);
  await page.reload();
  await expect(page.locator('#toolbar-title')).toHaveText('Обзор');
  expect((await scopedState(page,'state')).entries.some(e=>e.id===original.id&&e.amountCents===87525)).toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#toolbar-title')).toHaveText('Обзор');
  expect((await scopedState(page,'state')).entries.some(e=>e.id===original.id)).toBe(true);
  watcher.assertClean();
 }finally{
  await context.setOffline(false);
  await request.post('/__e2e__/sw-version/vite');
 }
});
