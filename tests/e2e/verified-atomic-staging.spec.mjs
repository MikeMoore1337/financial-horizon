import {test, expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

// Real Web Crypto and native IndexedDB. The browser context and records are
// synthetic and isolated; no production UI, migration, or auth is invoked.
const js = path => ts.transpileModule(
  readFileSync(new URL(path,import.meta.url),'utf8'),
  {compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}},
).outputText;
const sources=new Map([
 ['/__e2e_s6_vault__.js',js('../../src/security/local-vault.ts')],
 ['/__e2e_s6_session__.js',js('../../src/security/local-budget-session.ts')
   .replace(/['"]\.\/local-vault\.ts['"]/g,"'/__e2e_s6_vault__.js'")],
 ['/__e2e_s6_atomic__.js',js('../../src/security/protected-atomic-candidate.ts')
   .replace(/['"]\.\/local-vault\.ts['"]/g,"'/__e2e_s6_vault__.js'")],
 ['/__e2e_s6_stage__.js',js('../../src/security/protected-staging.ts')
   .replace(/['"]\.\/local-vault\.ts['"]/g,"'/__e2e_s6_vault__.js'")],
 ['/__e2e_s6_migrate__.js',js('../../state-migrations.ts')],
 ['/__e2e_s6_legacy__.js',js('../../src/security/live-legacy-preflight.ts')
   .replace(/['"]\.\.\/\.\.\/state-migrations\.ts['"]/g,"'/__e2e_s6_migrate__.js'")
   .replace(/['"]\.\/protected-staging\.ts['"]/g,"'/__e2e_s6_stage__.js'")],
 ['/__e2e_s6_bridge__.js',js('../../src/security/verified-atomic-staging.ts')
   .replace(/['"]\.\/live-legacy-preflight\.ts['"]/g,"'/__e2e_s6_legacy__.js'")
   .replace(/['"]\.\/protected-atomic-candidate\.ts['"]/g,"'/__e2e_s6_atomic__.js'")
   .replace(/['"]\.\/local-budget-session\.ts['"]/g,"'/__e2e_s6_session__.js'")
   .replace(/['"]\.\/protected-staging\.ts['"]/g,"'/__e2e_s6_stage__.js'")],
]);
test('verified external backup stages inactive encrypted candidate with offline recovery', async({page,context})=>{
  const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await context.route('**/__e2e_s6_*.js',route=>route.fulfill({
    status:200,contentType:'text/javascript',
    body:sources.get(new URL(route.request().url()).pathname),
    headers:{'Cache-Control':'no-store'},
  }));
  await page.goto('/__e2e__/ready');
  const first=await page.evaluate(async()=>{
    const {createSampleState}=await import('/finance.js');
    const {encryptBackup}=await import('/backup.js');
    const {prepareVerifiedAtomicCandidate}=await import('/__e2e_s6_bridge__.js');
    const {getAtomicEncryptedKeyset,readAtomicEncryptedCandidate,ATOMIC_ENCRYPTED_DB}
      =await import('/__e2e_s6_atomic__.js');
    const {LocalBudgetSession}=await import('/__e2e_s6_session__.js');
    const id='a'.repeat(32),scope='account:'+id;
    const state=createSampleState();
    state.version=1;delete state.revision;
    state.entries[0].title='PRIVATE_STAGE6_FINANCIAL_TITLE';
    const db=await new Promise((resolve,reject)=>{
      const req=indexedDB.open('financial-horizon-browser-v1',1);
      req.onupgradeneeded=()=>req.result.createObjectStore('finance');
      req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
    });
    await new Promise((resolve,reject)=>{
      const tx=db.transaction('finance','readwrite');
      tx.objectStore('finance').put(state,'account-state-v2:'+id);
      tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
    });
    db.close();
    const backupPassword='independent encrypted backup password 2026';
    const localPassphrase='separate local unlock phrase 2026';
    const backupText=await encryptBackup(state,backupPassword);
    const receipt=await prepareVerifiedAtomicCandidate({
      selection:{kind:'account',verifiedUserId:id},
      backupText,backupPassword,localPassphrase,
      consent:{savedEncryptedBackupOutsideThisBrowser:true,confirmedReadOnlyPreflight:true,
        confirmedSeparateEncryptedCandidate:true,acknowledgedOneTimeRecovery:true},
    });
    const session=new LocalBudgetSession();
    session.selectScope(scope);
    await session.unlock(await getAtomicEncryptedKeyset(scope),{recoveryKey:receipt.recoveryKey});
    const copy=await readAtomicEncryptedCandidate(scope,session);
    session.logout();

    const protectedDb=await new Promise((resolve,reject)=>{
      const req=indexedDB.open(ATOMIC_ENCRYPTED_DB,1);
      req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
    });
    const sealed=await new Promise((resolve,reject)=>{
      const tx=protectedDb.transaction(['keysets','bundles'],'readonly');
      const k=tx.objectStore('keysets').getAll();
      const b=tx.objectStore('bundles').getAll();
      tx.oncomplete=()=>resolve(JSON.stringify([k.result,b.result]));
      tx.onerror=()=>reject(tx.error);
    });
    protectedDb.close();
    return {status:receipt.status,active:receipt.active,revision:receipt.sourceRevision,
      keyLen:receipt.recoveryKey.length,entries:copy.snapshot.entries.length,
      sameTitle:copy.snapshot.entries[0].title===state.entries[0].title,
      queue:copy.outbox.length,conflicts:copy.conflicts.length,
      safe:!sealed.includes(state.entries[0].title) &&
        !sealed.includes(localPassphrase) && !sealed.includes(receipt.recoveryKey) &&
        !sealed.includes(String(state.entries[0].amountCents))};
  });
  expect(first).toEqual({status:'prepared',active:false,revision:0,keyLen:43,
    entries:first.entries,sameTitle:true,queue:0,conflicts:0,safe:true});
  expect(first.entries).toBeGreaterThan(0);

  await page.reload();
  await page.evaluate(async()=>{
    globalThis.__s6Atomic=await import('/__e2e_s6_atomic__.js');
    globalThis.__s6Session=await import('/__e2e_s6_session__.js');
  });
  await context.setOffline(true);
  try{
    const second=await page.evaluate(async()=>{
      const scope='account:'+'a'.repeat(32);
      const session=new globalThis.__s6Session.LocalBudgetSession();
      session.selectScope(scope);
      await session.unlock(await globalThis.__s6Atomic.getAtomicEncryptedKeyset(scope),
        {passphrase:'separate local unlock phrase 2026'});
      const copy=await globalThis.__s6Atomic.readAtomicEncryptedCandidate(scope,session);
      session.logout();
      return {offline:!navigator.onLine,title:copy.snapshot.entries[0].title,
        locked:session.state==='unselected',epoch:copy.epoch};
    });
    expect(second).toEqual({offline:true,title:'PRIVATE_STAGE6_FINANCIAL_TITLE',
      locked:true,epoch:0});
  }finally{await context.setOffline(false)}
  expect(errors).toEqual([]);
});
