import {test,expect} from '@playwright/test';
import {deflateSync} from 'node:zlib';
import {
 observe,visitGuest,view,addEntry,scopedState,
 registerViaUi,logoutViaUi,loginViaUi,currentUser,
} from './helpers.mjs';

function chunk(type,data){
 const length=Buffer.alloc(4);length.writeUInt32BE(data.length);
 const payload=Buffer.concat([Buffer.from(type,'ascii'),data]);
 let crc=0xffffffff;
 for(const byte of payload){
  crc^=byte;
  for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);
 }
 const trailer=Buffer.alloc(4);trailer.writeUInt32BE((crc^0xffffffff)>>>0);
 return Buffer.concat([length,payload,trailer]);
}
function qrPng(){
 const header=Buffer.from('89504e470d0a1a0a','hex');
 const dimensions=Buffer.alloc(13);dimensions.writeUInt32BE(1,0);
 dimensions.writeUInt32BE(1,4);dimensions[8]=8;dimensions[9]=6;
 return Buffer.concat([
  header,chunk('IHDR',dimensions),
  chunk('IDAT',deflateSync(Buffer.from([0,0,0,0,255]))),
  chunk('IEND',Buffer.alloc(0)),
 ]);
}
async function editRegularExpense(page,title){
 await view(page,'obligations');
 const desktop=page.locator('.records-table tr').filter({hasText:title}).locator('[data-action="edit-entry"]');
 const mobile=page.locator('.records-mobile-row').filter({hasText:title}).locator('[data-action="edit-entry"]');
 await (await desktop.isVisible()?desktop:mobile).click();
 await page.locator('[data-action="open-payment-methods"]').click();
 await expect(page.locator('#payment-methods-dialog')).toBeVisible();
}
async function addMethod(page,type,label,value='',file=null){
 const form=page.locator('#payment-method-form');
 const before=(await scopedState(page,'state'))?.entries[0]?.paymentMethods?.length||0;
 await form.locator('[name="type"]').selectOption(type);
 await form.locator('[name="label"]').fill(label);
 if(file)await form.locator('[name="qrFile"]').setInputFiles(file);
 else if(type!=='qr_image')await form.locator('[name="value"]').fill(value);
 await form.locator('button[type="submit"]').click();
 await expect.poll(async()=> (await scopedState(page,'state')).entries[0].paymentMethods?.length||0).toBe(before+1);
}

test('five methods, primary, text edit, QR and history survive offline restart and encrypted restore',async({page,context})=>{
 test.setTimeout(120_000);
 const watch=await observe(context,page);
 await visitGuest(page);
 await addEntry(page,'E2E recurring provider',{amount:'2990.40'});
 const original=await scopedState(page,'state');
 await editRegularExpense(page,'E2E recurring provider');
 await addMethod(page,'payment_url','Личный кабинет','https://billing.example/pay');
 await addMethod(page,'qr_image','QR-код','',{name:'qr-untrusted-filename.png',mimeType:'image/png',buffer:qrPng()});
 await addMethod(page,'sbp_link','СБП','https://qr.nspk.ru/example');
 await addMethod(page,'requisites','Реквизиты','ООО Пример, счёт 40817810000000000001');
 await addMethod(page,'instructions','Инструкция','Зайти в личный кабинет и оплатить');
 const list=page.locator('#payment-methods-list');
 await expect(list.locator('img')).toHaveCount(1);
 await expect(list.locator('a')).toHaveCount(2);
 expect(await list.locator('a').first().getAttribute('rel')).toContain('noopener');
 expect(await list.locator('a').first().getAttribute('target')).toBe('_blank');
 const requisites=list.locator('.archive-row').filter({hasText:'Реквизиты'});
 await requisites.locator('[data-action="primary-payment-method"]').click();
 await expect.poll(async()=> (await scopedState(page,'state')).entries[0].paymentMethods.find(x=>x.primary).type)
  .toBe('requisites');
 const instructions=list.locator('.archive-row').filter({hasText:'Инструкция'});
 await instructions.locator('[data-action="edit-payment-method"]').click();
 await page.locator('#payment-method-form [name="value"]').fill('Оплатить вручную по графику');
 await page.locator('#payment-method-form button[type="submit"]').click();
 await expect(list).toContainText('Оплатить вручную по графику');
 const stored=(await scopedState(page,'state')).entries[0];
 expect(stored.paymentMethods).toHaveLength(5);
 expect(stored.amountCents).toBe(original.entries[0].amountCents);
 expect(stored.date).toBe(original.entries[0].date);
 expect((await scopedState(page,'state')).settlements).toEqual(original.settlements);
 await page.locator('#payment-methods-dialog [data-action="close-payment-methods"]').first().click();
 await page.locator('#entry-form button[value="cancel"]').click();
 await page.evaluate(()=>navigator.serviceWorker.ready);
 await expect.poll(()=>page.evaluate(()=>Boolean(navigator.serviceWorker.controller))).toBe(true);
 await context.setOffline(true);
 await page.reload();
 await expect(page.locator('#toolbar-title')).toHaveText('Обзор');
 expect((await scopedState(page,'state')).entries[0].paymentMethods).toEqual(stored.paymentMethods);
 await context.setOffline(false);
 await page.reload();
 await view(page,'settings');
 await page.locator('[data-action="backup"]').click();
 await page.locator('#password-form [name="password"]').fill('Synthetic-backup-passphrase');
 const downloadPromise=page.waitForEvent('download');
 await page.locator('#password-form button[type="submit"]').click();
 const encrypted=await downloadPromise;
 await page.locator('[data-action="clear"]').click();
 await page.locator('#confirm-yes').click();
 await expect.poll(async()=> (await scopedState(page,'state')).entries.length).toBe(0);
 await page.locator('[data-action="restore"]').click();
 await page.locator('#restore-file').setInputFiles(await encrypted.path());
 await page.locator('#password-form [name="password"]').fill('Synthetic-backup-passphrase');
 await page.locator('#password-form button[type="submit"]').click();
 await page.locator('#confirm-yes').click();
 await expect.poll(async()=> (await scopedState(page,'state')).entries[0]?.paymentMethods?.length).toBe(5);
 expect((await scopedState(page,'state')).entries[0].paymentMethods).toEqual(stored.paymentMethods);
 const requests=await page.evaluate(async()=>{
  const entries=await caches.keys();
  const urls=[];
  for(const key of entries)for(const request of await (await caches.open(key)).keys())urls.push(request.url);
  return urls.filter(url=>url.includes('/api/')||url.includes('data:image/'));
 });
 expect(requests).toEqual([]);
 watch.assertClean();
});

test('invalid links, malicious text and QR files never execute or silently persist',async({page,context})=>{
 const watch=await observe(context,page);
 await visitGuest(page);await addEntry(page,'E2E provider URL guard');
 await editRegularExpense(page,'E2E provider URL guard');
 const f=page.locator('#payment-method-form');
 await f.locator('[name="label"]').fill('Подменённый адрес');
 await f.locator('[name="value"]').fill('https://trusted.example@other.example/');
 await f.locator('button[type="submit"]').click();
 await expect(page.locator('#toast')).toContainText('HTTPS');
 expect((await scopedState(page,'state')).entries[0].paymentMethods??[]).toHaveLength(0);
 await f.locator('[name="type"]').selectOption('instructions');
 await f.locator('[name="label"]').fill('Текст');
 await f.locator('[name="value"]').fill('<img src=x onerror=window.__injected=1>');
 await f.locator('button[type="submit"]').click();
 await expect.poll(async()=> (await scopedState(page,'state')).entries[0].paymentMethods?.length).toBe(1);
 expect(await page.evaluate(()=>window.__injected)).toBeUndefined();
 expect(await page.locator('#payment-methods-list img').count()).toBe(0);
 await f.locator('[name="type"]').selectOption('qr_image');
 await f.locator('[name="label"]').fill('Некорректное изображение');
 await f.locator('[name="qrFile"]').setInputFiles({
  name:'<img onerror=not-allowed>.png',mimeType:'image/png',buffer:Buffer.from('plain text'),
 });
 await f.locator('button[type="submit"]').click();
 expect((await scopedState(page,'state')).entries[0].paymentMethods).toHaveLength(1);
 await f.locator('[name="qrFile"]').setInputFiles({
  name:'oversized.png',mimeType:'image/png',buffer:Buffer.alloc(193*1024),
 });
 await f.locator('button[type="submit"]').click();
 expect((await scopedState(page,'state')).entries[0].paymentMethods).toHaveLength(1);
 // Expected validation errors are intentionally surfaced; no sensitive data is logged.
 expect(watch.unplanned).toEqual([]);
 expect(watch.exceptions).toEqual([]);
});

test('payment methods follow exact guest and account ownership through logout',async({page,context,request})=>{
 test.setTimeout(120_000);
 const watch=await observe(context,page);
 const suffix='+'+test.info().project.name+'@example.invalid';
 const first='e2e-method-owner-a'+suffix,second='e2e-method-owner-b'+suffix;
 await registerViaUi(page,request,first);
 const a=await currentUser(page);
 await addEntry(page,'E2E account A provider');
 await editRegularExpense(page,'E2E account A provider');
 const f=page.locator('#payment-method-form');
 await f.locator('[name="label"]').fill('Ссылка A');
 await f.locator('[name="value"]').fill('https://billing.example/a');
 await f.locator('button[type="submit"]').click();
 await expect.poll(async()=> (await scopedState(page,'account-state-v2:'+a.id)).entries[0].paymentMethods?.length).toBe(1);
 await page.locator('#payment-methods-dialog [data-action="close-payment-methods"]').first().click();
 await page.locator('#entry-form button[value="cancel"]').click();
 await logoutViaUi(page);
 await registerViaUi(page,request,second);
 const b=await currentUser(page);
 expect((await scopedState(page,'account-state-v2:'+b.id)).entries).toHaveLength(0);
 await logoutViaUi(page);
 await visitGuest(page);
 const guest=await scopedState(page,'guest-state-v2');
 expect(guest?.entries??[]).toHaveLength(0);
 await loginViaUi(page,first);
 const stored=await scopedState(page,'account-state-v2:'+a.id);
 expect(stored.entries[0].paymentMethods[0].value).toBe('https://billing.example/a');
 watch.assertClean();
});
