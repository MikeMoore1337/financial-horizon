import {test,expect} from '@playwright/test';
import {observe,visitGuest,addEntry,scopedState} from './helpers.mjs';

test('native Service Worker shell works offline and recovers online',async({page,context})=>{
 const watcher=await observe(context,page);
 await visitGuest(page);
 await addEntry(page,'E2E offline retained');
 await page.evaluate(()=>navigator.serviceWorker.ready);
 await expect.poll(()=>page.evaluate(()=>Boolean(navigator.serviceWorker.controller))).toBe(true);
 expect((await page.evaluate(()=>caches.keys())).some(k=>k.startsWith('financial-horizon-shell-'))).toBe(true);
 await context.setOffline(true);
 await page.reload();
 await expect(page.locator('#toolbar-title')).toHaveText('Обзор');
 expect((await scopedState(page,'state')).entries.some(e=>e.title==='E2E offline retained')).toBe(true);
 await context.setOffline(false);
 await page.reload();
 await expect(page.locator('#toolbar-title')).toHaveText('Обзор');
 watcher.assertClean();
});

test('native Service Worker upgrade preserves financial IndexedDB and PWA manifest',async({page,context,request})=>{
 const watcher=await observe(context,page);
 await visitGuest(page);
 await addEntry(page,'E2E SW migration retained');
 await page.evaluate(()=>navigator.serviceWorker.ready);
 await expect.poll(()=>page.evaluate(()=>Boolean(navigator.serviceWorker.controller))).toBe(true);
 const id=(await scopedState(page,'state')).entries[0].id;
 const response=await request.post('/__e2e__/sw-upgrade');
 expect(response.ok()).toBe(true);
 const {revision}=await response.json();
 await page.evaluate(async()=>{const reg=await navigator.serviceWorker.ready;await reg.update();});
 await expect.poll(()=>page.evaluate(async n=> (await caches.keys()).some(k=>k.endsWith('-e2e-'+n+'-schema-v2')),revision),{timeout:15000}).toBe(true);
 await page.reload();
 expect((await scopedState(page,'state')).entries[0].id).toBe(id);
 const manifest=await page.evaluate(async()=> (await fetch('/manifest.webmanifest')).json());
 expect(manifest.display).toBe('standalone');
 expect(manifest.icons.length).toBeGreaterThan(0);
 watcher.assertClean();
});


test('installed legacy v25 Service Worker upgrades to Vite shell without losing IndexedDB',async({page,context,request})=>{
 test.setTimeout(120_000);
 const watcher=await observe(context,page);
 await visitGuest(page);
 await addEntry(page,'E2E legacy worker preserved');
 await page.evaluate(()=>navigator.serviceWorker.ready);
 const original=(await scopedState(page,'state')).entries.find(e=>e.title==='E2E legacy worker preserved');
 try{
  const legacy=await request.post('/__e2e__/sw-version/legacy');
  expect(legacy.ok()).toBe(true);
  await page.evaluate(async()=>{const reg=await navigator.serviceWorker.ready;await reg.update();});
  await expect.poll(()=>page.evaluate(async()=> (await caches.keys()).some(k=>k.includes('financial-horizon-shell-v25-theme-auth'))),{timeout:20000}).toBe(true);
  const newer=await request.post('/__e2e__/sw-version/vite');
  expect(newer.ok()).toBe(true);
  await page.evaluate(async()=>{const reg=await navigator.serviceWorker.ready;await reg.update();});
  await expect.poll(()=>page.evaluate(async()=> (await caches.keys()).some(k=>k.startsWith('financial-horizon-shell-vite-'))),{timeout:20000}).toBe(true);
  await page.reload();
  await expect(page.locator('#toolbar-title')).toHaveText('Обзор');
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#toolbar-title')).toHaveText('Обзор');
  expect((await scopedState(page,'state')).entries.some(e=>e.id===original.id)).toBe(true);
  await context.setOffline(false);
  watcher.assertClean();
 }finally{
  await context.setOffline(false);
  await request.post('/__e2e__/sw-version/vite');
 }
});
