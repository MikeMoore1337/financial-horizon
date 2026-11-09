import {test,expect} from '@playwright/test';
import {observe,registerViaUi,addEntry,currentUser} from './helpers.mjs';

// Exercises the REAL unbundled compatibility app served to old installed PWAs,
// native Chromium/WebKit, real local auth and native IndexedDB on synthetic data.
test('legacy PWA clears finance and dialogs before redirecting on cross-tab logout',async({page,context,request})=>{
 test.setTimeout(120_000);
 try{
  expect((await request.post('/__e2e__/sw-version/legacy')).ok()).toBe(true);
  const watcher=await observe(context,page);
  const email='e2e-legacy-scope-'+test.info().project.name+'@example.invalid';
  await registerViaUi(page,request,email);
  const identity=await currentUser(page);
  expect(identity?.id).toMatch(/^[a-f0-9]{32}$/);
  await addEntry(page,'PRIVATE_LEGACY_CROSS_TAB',{amount:'129.99'});
  await expect(page.locator('#main')).toContainText('PRIVATE_LEGACY_CROSS_TAB');

  const served=await request.get('/app.js');
  expect(served.ok()).toBe(true);
  expect(await served.text()).toContain('function revokeDisplayedLedger()');
  // Track the exact synchronous DOM clear even after the browser navigates.
  await page.evaluate(()=>{
   const replace=Element.prototype.replaceChildren;
   Element.prototype.replaceChildren=function(...args){
    if(this.id==='main')sessionStorage.setItem('__e2e_legacy_main_cleared','1');
    if(this.tagName==='DIALOG')sessionStorage.setItem('__e2e_legacy_dialog_cleared','1');
    return replace.apply(this,args);
   };
  });
  await page.evaluate(()=>{
   const channel=new BroadcastChannel('fh-auth-session-v2');
   channel.postMessage({type:'logout',userId:'b'.repeat(32)});
   channel.close();
  });
  await expect(page.locator('#main')).toContainText('PRIVATE_LEGACY_CROSS_TAB');
  expect(await page.evaluate(()=>sessionStorage.getItem('__e2e_legacy_main_cleared'))).toBeNull();

  await page.evaluate(userId=>{
   const channel=new BroadcastChannel('fh-auth-session-v2');
   channel.postMessage({type:'logout',userId});
   channel.close();
  },identity.id);
  await expect(page).toHaveURL(/\/account\.html$/, {timeout:20_000});
  const receipts=await page.evaluate(()=>({
   main:sessionStorage.getItem('__e2e_legacy_main_cleared'),
   dialogs:sessionStorage.getItem('__e2e_legacy_dialog_cleared'),
  }));
  expect(receipts).toEqual({main:'1',dialogs:'1'});
  watcher.assertClean();
 }finally{
  await request.post('/__e2e__/sw-version/vite');
 }
});
