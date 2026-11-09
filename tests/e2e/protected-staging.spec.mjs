import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

// Isolated same-origin browser test; no production feature flags, storage.js or UI.
const compile=path=>ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{
 compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}
}).outputText;
const vaultJs=compile('../../src/security/local-vault.ts');
const stagingJs=compile('../../src/security/protected-staging.ts')
 .replace("from './local-vault.ts'","from '/__e2e_crypto_vault__.js'");

test('protected staging: browser-native IndexedDB, rollback, metadata tampering and offline restore',async({page,context})=>{
 const errors=[];
 page.on('pageerror',err=>errors.push(err.message));
 await page.route('**/__e2e_crypto_vault__.js',route=>route.fulfill({status:200,contentType:'text/javascript',body:vaultJs}));
 await page.route('**/__e2e_protected_staging__.js',route=>route.fulfill({status:200,contentType:'text/javascript',body:stagingJs}));
 await page.goto('/__e2e__/ready');
 const first=await page.evaluate(async()=>{
  const stage=await import('/__e2e_protected_staging__.js');
  const scope='account:'+'a'.repeat(32),pass='synthetic staging user password 2026';
  const ctx={kind:'snapshot',recordId:'state',schemaVersion:2,revision:9};
  const state={version:2,revision:9,entries:[{title:'SECRET_34_INDEXEDDB_TITLE',amountCents:47629381}]};
  const legacyDb=await new Promise((resolve,reject)=>{
   const r=indexedDB.open('financial-horizon-browser-v1',1);
   r.onupgradeneeded=()=>r.result.createObjectStore('finance');
   r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
  });
  await new Promise((resolve,reject)=>{
   const tx=legacyDb.transaction('finance','readwrite');
   tx.objectStore('finance').put(state,'state');
   tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
  });legacyDb.close();
  const created=await stage.stageProtectedSnapshot(scope,state,ctx,pass);
  const duplicate=await stage.stageProtectedSnapshot(scope,state,ctx,pass);
  let staleRejected=false;
  try{await stage.stageProtectedSnapshot(scope,{...state,revision:10},ctx,pass);}catch{staleRejected=true;}
  const readDb=async dbName=>new Promise((resolve,reject)=>{
   const r=indexedDB.open(dbName,1);
   r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
  });
  const db=await readDb(stage.PROTECTED_STAGING_DB);
  const saved=await new Promise((resolve,reject)=>{
   const tx=db.transaction(['keysets','records'],'readonly');
   const k=tx.objectStore('keysets').get(scope),v=tx.objectStore('records').get(scope);
   tx.oncomplete=()=>resolve({keyset:k.result,row:v.result});tx.onerror=()=>reject(tx.error);
  });db.close();
  const old=await readDb('financial-horizon-browser-v1');
  const original=await new Promise((resolve,reject)=>{
   const tx=old.transaction('finance','readonly'),g=tx.objectStore('finance').get('state');
   tx.oncomplete=()=>resolve(g.result);tx.onerror=()=>reject(tx.error);
  });old.close();
  const stored=JSON.stringify(saved);
  const noPlaintext=!stored.includes(state.entries[0].title)&&!stored.includes('47629381')&&
    !stored.includes(created.recoveryKey)&&!stored.includes(pass);
  const restored=await stage.readStagedSnapshot(scope,{recoveryKey:created.recoveryKey});
  let wrongPassword=false;
  try{await stage.readStagedSnapshot(scope,{passphrase:'wrong synthetic password 2026'});}catch{wrongPassword=true;}
  let isolated=await stage.readStagedSnapshot('account:'+'b'.repeat(32),{passphrase:pass})===null;
  // Native IDB tamper only; decrypt must reject authenticated revision.
  const changing=await readDb(stage.PROTECTED_STAGING_DB);
  await new Promise((resolve,reject)=>{
   const tx=changing.transaction('records','readwrite');
   tx.objectStore('records').put({...saved.row,record:{...saved.row.record,revision:123}},scope);
   tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
  });changing.close();
  let tamperRejected=false;
  try{await stage.readStagedSnapshot(scope,{passphrase:pass});}catch{tamperRejected=true;}
  const repairing=await readDb(stage.PROTECTED_STAGING_DB);
  await new Promise((resolve,reject)=>{
   const tx=repairing.transaction('records','readwrite');
   tx.objectStore('records').put(saved.row,scope);
   tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
  });repairing.close();
  return {scope,pass,original,source:state,created:created.status,duplicate:duplicate.status,staleRejected,
   tamperRejected,wrongPassword,isolated,noPlaintext,recoveryWorks:JSON.stringify(restored.state)===JSON.stringify(state)};
 });
 expect(first).toMatchObject({created:'created',duplicate:'already-staged',staleRejected:true,
  tamperRejected:true,wrongPassword:true,isolated:true,noPlaintext:true,recoveryWorks:true});
 expect(first.original).toEqual(first.source);
 await page.reload();
 await page.evaluate(async()=>{globalThis.__protected=await import('/__e2e_protected_staging__.js');});
 await context.setOffline(true);
 try {
  const second=await page.evaluate(async ({scope,pass})=>{
   const recovered=await globalThis.__protected.readStagedSnapshot(scope,{passphrase:pass});
   return {offline:!navigator.onLine,revision:recovered.context.revision,title:recovered.state.entries[0].title};
  },first);
  expect(second).toEqual({offline:true,revision:9,title:'SECRET_34_INDEXEDDB_TITLE'});
 }finally{await context.setOffline(false);}
 expect(errors).toEqual([]);
});
