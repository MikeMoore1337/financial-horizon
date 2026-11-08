import {test, expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

// No production import or feature activation. Same-origin synthetic crypto test.
const js=ts.transpileModule(
  readFileSync(new URL('../../src/security/local-vault.ts',import.meta.url),'utf8'),
  {compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}
).outputText;

test('isolated Web Crypto: native IndexedDB, reload and offline unlock',async({page,context})=>{
 const errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/__e2e_crypto_vault__.js',route=>route.fulfill({
  status:200,contentType:'text/javascript',body:js,headers:{'Cache-Control':'no-store'}
 }));
 await page.goto('/__e2e__/ready');
 const first=await page.evaluate(async()=>{
  const {createLocalKeyset}=await import('/__e2e_crypto_vault__.js');
  const scope='guest:qa-browser',password='synthetic offline passphrase 2026';
  const expected={kind:'snapshot',recordId:'state',schemaVersion:2,revision:42};
  const money={title:'UNIQUE_FINANCIAL_PRIVATE_TITLE',amountCents:12345678};
  const {keyset,recoveryKey,vault}=await createLocalKeyset(scope,password);
  const record=await vault.encrypt(money,expected);
  const db=await new Promise((resolve,reject)=>{
   const r=indexedDB.open('fh-crypto-isolated-e2e',1);
   r.onupgradeneeded=()=>r.result.createObjectStore('records');
   r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
  });
  await new Promise((resolve,reject)=>{
   const tx=db.transaction('records','readwrite');
   tx.objectStore('records').put({keyset,record},'snapshot');
   tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
  });
  db.close();vault.lock();
  const serialized=JSON.stringify({keyset,record});
  return {
   locked:!vault.unlocked,
   noPlaintext:!serialized.includes(money.title)&&!serialized.includes('12345678')&&
    !serialized.includes(password)&&!serialized.includes(recoveryKey)
  };
 });
 expect(first).toEqual({locked:true,noPlaintext:true});
 await page.reload();
 await page.evaluate(async()=>{globalThis.__qaVault=await import('/__e2e_crypto_vault__.js');});
 await context.setOffline(true);
 try{
  const second=await page.evaluate(async()=>{
   const db=await new Promise((resolve,reject)=>{
    const r=indexedDB.open('fh-crypto-isolated-e2e',1);
    r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
   });
   const stored=await new Promise((resolve,reject)=>{
    const tx=db.transaction('records','readonly');
    const req=tx.objectStore('records').get('snapshot');
    tx.oncomplete=()=>resolve(req.result);tx.onerror=()=>reject(tx.error);
   });
   db.close();
   const {unlockLocalKeyset,createLocalKeyset}=globalThis.__qaVault;
   const metadata={kind:'snapshot',recordId:'state',schemaVersion:2,revision:42};
   const vault=await unlockLocalKeyset(stored.keyset,{passphrase:'synthetic offline passphrase 2026'},'guest:qa-browser');
   const plain=await vault.decrypt(stored.record,metadata);
   const other=await createLocalKeyset('guest:other-user','synthetic offline passphrase 2026');
   let isolated=false;
   try{await other.vault.decrypt(stored.record,metadata);}catch{isolated=true;}
   vault.lock();other.vault.lock();
   return {offline:!navigator.onLine,sum:plain.amountCents,isolated};
  });
  expect(second).toEqual({offline:true,sum:12345678,isolated:true});
 }finally{await context.setOffline(false);}
 expect(errors).toEqual([]);
});
