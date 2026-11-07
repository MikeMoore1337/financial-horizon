import {expect} from '@playwright/test';
export const ORIGIN='http://127.0.0.1:8791';
export const DB='financial-horizon-browser-v1';
export const TEST_PASSWORD='Synthetic-test-passphrase-2026!';
// Synthetic Turnstile is the only substituted external dependency; auth/cookies are real.
const turnstileStub="window.turnstile={render(_el,opts){queueMicrotask(()=>opts.callback('e2e-'+opts.action));return 1;},remove(){},reset(){}};";
export async function observe(context,page){
 // Stub only external Turnstile, before page scripts run. Avoid unstable
 // cross-origin script routing in Windows WebKit; retain real FastAPI and cookies.
 await context.addInitScript({content:turnstileStub});
 const unplanned=[],exceptions=[],consoleErrors=[];
 page.on('pageerror',e=>exceptions.push(e.stack||e.message));
 page.on('console',m=>{if(m.type()==='error')consoleErrors.push(m.text());});
 context.on('request',req=>{
  const url=req.url();
  if(!url.startsWith(ORIGIN+'/')){
   const origin=new URL(url).origin;
   if(!unplanned.includes(origin))unplanned.push(origin);
  }
 });
 // Do not proxy same-origin traffic through Playwright. It must reach the
 // real FastAPI service/Service Worker without interception or cache changes.
 await context.route(/^https?:\/\/(?!127\.0\.0\.1:8791(?:\/|$))/,async route=>{
  unplanned.push(new URL(route.request().url()).origin);
  return route.abort('blockedbyclient');
 });
 return {unplanned,exceptions,consoleErrors,assertClean(){
  expect(exceptions,'Uncaught JavaScript exceptions').toEqual([]);
  expect(consoleErrors,'Console JS errors').toEqual([]);
  expect(unplanned,'Unexpected external requests').toEqual([]);
 }};
}
export async function visitGuest(page){
 await page.goto('/?guest=1');
 await expect(page.locator('#toolbar-title')).toHaveText('Обзор');
 await expect(page.locator('#save-indicator')).toHaveText('Локальная база готова');
 await expect(page.locator('#main')).not.toContainText('Проверяем доступ');
}
export async function view(page,name){
 const side=page.locator('.sidebar-nav [data-view="'+name+'"]');
 if(await side.isVisible())await side.click();
 else await page.locator('.bottom-nav [data-view="'+name+'"]').click();
 await expect(side).toHaveAttribute('aria-current','page');
}
export async function nativeDb(page){
 return page.evaluate(async ({dbName,storeName})=>{
  const databases=typeof indexedDB.databases==='function'?await indexedDB.databases():[];
  if(databases.length&&!databases.some(d=>d.name===dbName))throw Error('Missing real IndexedDB');
  const db=await new Promise((resolve,reject)=>{
   const r=indexedDB.open(dbName);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
  });
  try{
   if(!db.objectStoreNames.contains(storeName))throw Error('Missing native finance object store');
   return await new Promise((resolve,reject)=>{
    const tx=db.transaction(storeName,'readonly');
    const keys=tx.objectStore(storeName).getAllKeys(),values=tx.objectStore(storeName).getAll();
    tx.oncomplete=()=>resolve({keys:keys.result,values:values.result});
    tx.onerror=()=>reject(tx.error);
   });
  }finally{db.close();}
 },{dbName:'financial-horizon-browser-v1',storeName:'finance'});
}
export async function scopedState(page,key){
 const db=await nativeDb(page);
 return db.values[db.keys.indexOf(key)]??null;
}
export async function addEntry(page,title,{kind='expense',amount='1200.50'}={}){
 await page.locator('#top-add').click();
 const form=page.locator('#entry-form');await expect(page.locator('#entry-dialog')).toBeVisible();
 await form.locator('[name="title"]').fill(title);
 await form.locator('[name="kind"]').selectOption(kind);
 await form.locator('[name="amount"]').fill(amount);
 await form.locator('[name="date"]').fill('2026-11-15');
 await form.locator('[name="recurrence"]').selectOption('monthly');
 await form.locator('button[type="submit"]').click();
 await expect(page.locator('#entry-dialog')).not.toBeVisible();
 await expect.poll(async()=>{const s=await nativeDb(page);return s.values.some(v=>v?.entries?.some(e=>e.title===title));}).toBe(true);
}
export async function mailToken(request,email,purpose){
 let token=null;
 await expect.poll(async()=>{
  const response=await request.get('/__e2e__/mail',{params:{email,purpose}});
  token=response.ok()?(await response.json()).token:null;return Boolean(token);
 },{timeout:10000}).toBe(true);
 return token;
}
export async function registerViaUi(page,request,email,password=TEST_PASSWORD){
 await page.goto('/account.html');await page.locator('[data-mode="register"]').click();
 await expect(page.locator('#auth-submit')).toBeEnabled();
 await page.locator('#email').fill(email);await page.locator('#auth-submit').click();
 await expect(page.locator('#auth-feedback')).toContainText('письмо');
 const token=await mailToken(request,email,'verify');
 await page.goto('/account.html?e2e=verify#verify-email='+encodeURIComponent(token));
 await expect(page.locator('#auth-submit')).toBeEnabled();
 await page.locator('#password').fill(password);await page.locator('#auth-submit').click();
 await expect(page).toHaveURL(ORIGIN+'/');
 await expect(page.locator('#toolbar-title')).toHaveText('Обзор');
 await expect(page.locator('#save-indicator')).toHaveText('Локальная база готова');
 await page.waitForLoadState('networkidle');
}
export async function loginViaUi(page,email,password=TEST_PASSWORD){
 await page.goto('/account.html');await expect(page.locator('#auth-submit')).toBeEnabled();
 await page.locator('#email').fill(email);await page.locator('#password').fill(password);
 await page.locator('#auth-submit').click();await expect(page).toHaveURL(ORIGIN+'/');
 await expect(page.locator('#toolbar-title')).toHaveText('Обзор');
 await expect(page.locator('#save-indicator')).toHaveText('Локальная база готова');
 await page.waitForLoadState('networkidle');
}
export async function logoutViaUi(page){
 await page.locator('#account-logout-toolbar').click();
 await expect(page).toHaveURL(ORIGIN+'/account.html');
 await expect(page.locator('#auth-form')).toBeVisible();
 await page.waitForLoadState('networkidle');
}
export async function currentUser(page){
 return page.evaluate(async()=> (await (await fetch('/api/auth/email/me',{credentials:'same-origin',cache:'no-store'})).json()).user);
}
