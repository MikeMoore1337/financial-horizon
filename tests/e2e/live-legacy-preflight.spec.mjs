import {test, expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

// The test creates only synthetic native IndexedDB records in an isolated
// Playwright context. It never imports the production app or writes a real DB.
const transpile = path => ts.transpileModule(
  readFileSync(new URL(path,import.meta.url),'utf8'),
  {compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}},
).outputText;
const resources=new Map([
  ['/__e2e_preflight_vault__.js',transpile('../../src/security/local-vault.ts')],
  ['/__e2e_preflight_stage__.js',transpile('../../src/security/protected-staging.ts')
    .replace(/['"]\.\/local-vault\.ts['"]/g,"'/__e2e_preflight_vault__.js'")],
  ['/__e2e_preflight_migrate__.js',transpile('../../state-migrations.ts')],
  ['/__e2e_preflight_live__.js',transpile('../../src/security/live-legacy-preflight.ts')
    .replace(/['"]\.\.\/\.\.\/state-migrations\.ts['"]/g,"'/__e2e_preflight_migrate__.js'")
    .replace(/['"]\.\/protected-staging\.ts['"]/g,"'/__e2e_preflight_stage__.js'")],
]);

test('real native legacy IDB is read-only, verified backup v1 and offline after reload',async({page,context})=>{
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await context.route('**/__e2e_preflight_*.js',route=>route.fulfill({
    status:200,contentType:'text/javascript',
    body:resources.get(new URL(route.request().url()).pathname),
    headers:{'Cache-Control':'no-store'},
  }));
  await page.goto('/__e2e__/ready');
  const first=await page.evaluate(async()=>{
    const {createSampleState}=await import('/finance.js');
    const {encryptBackup}=await import('/backup.js');
    const {verifyLiveLegacyBackup}=await import('/__e2e_preflight_live__.js');
    const state=createSampleState();
    state.version=1;delete state.revision;
    const db=await new Promise((resolve,reject)=>{
      const r=indexedDB.open('financial-horizon-browser-v1',1);
      r.onupgradeneeded=()=>r.result.createObjectStore('finance');
      r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
    });
    await new Promise((resolve,reject)=>{
      const tx=db.transaction('finance','readwrite');
      tx.objectStore('finance').put(state,'state');
      tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
    });
    db.close();
    const backupPassword='synthetic independent backup password';
    const backupText=await encryptBackup(state,backupPassword);
    const verified=await verifyLiveLegacyBackup({
      selection:{kind:'guest',guestNamespace:'e2e-guest'},
      backupText,backupPassword,
      consent:{savedEncryptedBackupOutsideThisBrowser:true,confirmedReadOnlyPreflight:true},
    });
    return {version:verified.snapshot.version,revision:verified.sourceRevision,sourceKey:verified.sourceKey,
      equal:JSON.stringify(verified.snapshot.entries)===JSON.stringify(state.entries)};
  });
  expect(first).toEqual({version:2,revision:0,sourceKey:'state',equal:true});

  await page.reload();
  await page.evaluate(async()=>{
    globalThis.__preflight = await import('/__e2e_preflight_live__.js');
    globalThis.__finance = await import('/finance.js');
    globalThis.__backup = await import('/backup.js');
  });
  await context.setOffline(true);
  try{
    const second=await page.evaluate(async()=>{
      const db=await new Promise((resolve,reject)=>{
        const r=indexedDB.open('financial-horizon-browser-v1');
        r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
      });
      const original=await new Promise((resolve,reject)=>{
        const tx=db.transaction('finance','readonly');
        const get=tx.objectStore('finance').get('state');
        tx.oncomplete=()=>resolve(get.result);
        tx.onerror=()=>reject(tx.error);
      });
      db.close();
      const password='synthetic independent backup password';
      const backup=await globalThis.__backup.encryptBackup(original,password);
      const verified=await globalThis.__preflight.verifyLiveLegacyBackup({
        selection:{kind:'guest',guestNamespace:'e2e-guest'},
        backupText:backup,backupPassword:password,
        consent:{savedEncryptedBackupOutsideThisBrowser:true,confirmedReadOnlyPreflight:true},
      });
      let wrongPassword=false;
      try{await globalThis.__preflight.verifyLiveLegacyBackup({
        selection:{kind:'guest',guestNamespace:'e2e-guest'},
        backupText:backup,backupPassword:'wrong incorrect backup password',
        consent:{savedEncryptedBackupOutsideThisBrowser:true,confirmedReadOnlyPreflight:true},
      });}catch{wrongPassword=true;}
      return {offline:!navigator.onLine,sourceKey:verified.sourceKey,
        count:verified.snapshot.entries.length,originalCount:original.entries.length,
        wrongPassword};
    });
    expect(second.offline).toBe(true);
    expect(second.sourceKey).toBe('state');
    expect(second.count).toBeGreaterThan(0);
    expect(second.count).toBe(second.originalCount);
    expect(second.wrongPassword).toBe(true);
  }finally{await context.setOffline(false);}
  expect(errors).toEqual([]);
});

test('claimed legacy state cannot be silently imported into another guest scope',async({page,context})=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await context.route('**/__e2e_preflight_*.js',route=>route.fulfill({
    status:200,contentType:'text/javascript',body:resources.get(new URL(route.request().url()).pathname),
    headers:{'Cache-Control':'no-store'},
  }));
  await page.goto('/__e2e__/ready');
  const actual=await page.evaluate(async()=>{
    const {createSampleState}=await import('/finance.js');
    const {encryptBackup}=await import('/backup.js');
    const {verifyLiveLegacyBackup}=await import('/__e2e_preflight_live__.js');
    const id='a'.repeat(32);
    const claimed=createSampleState();
    const guest=structuredClone(claimed);
    guest.entries[0].title='SYNTHETIC_GUEST_PRIVATE_TITLE';
    const db=await new Promise((resolve,reject)=>{
      const r=indexedDB.open('financial-horizon-browser-v1',1);
      r.onupgradeneeded=()=>r.result.createObjectStore('finance');
      r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
    });
    await new Promise((resolve,reject)=>{
      const tx=db.transaction('finance','readwrite');
      const store=tx.objectStore('finance');
      store.put(claimed,'state');
      store.put(guest,'guest-state-v2');
      store.put(claimed,'account-state-v2:'+id);
      store.put(id,'legacy-account-claim-v2');
      tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
    });
    db.close();
    const password='separate offline backup password';
    const backupText=await encryptBackup(guest,password);
    const verify=selection=>verifyLiveLegacyBackup({selection,backupText,backupPassword:password,
      consent:{savedEncryptedBackupOutsideThisBrowser:true,confirmedReadOnlyPreflight:true}});
    const result=await verify({kind:'guest',guestNamespace:'isolated-guest'});
    let otherDenied=false;
    try{await verify({kind:'account',verifiedUserId:id});}catch{otherDenied=true;}
    return {key:result.sourceKey,title:result.snapshot.entries[0].title,
      otherDenied,claimedTitle:claimed.entries[0].title};
  });
  expect(actual.key).toBe('guest-state-v2');
  expect(actual.title).toBe('SYNTHETIC_GUEST_PRIVATE_TITLE');
  expect(actual.title).not.toBe(actual.claimedTitle);
  expect(actual.otherDenied).toBe(true);
  expect(errors).toEqual([]);
});
