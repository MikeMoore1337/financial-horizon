import {test, expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

// Synthetic browser-native #69 preview, no user financial record and NO
// cloud upload or destructive import. The separate physical backup gate is
// NOT established by an in-memory CI backup.
const transpile = path => ts.transpileModule(
  readFileSync(new URL(path, import.meta.url), 'utf8'),
  {compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}},
).outputText;
const load = path => readFileSync(new URL(path,import.meta.url),'utf8');
const urls = {
  vault: '/__e2e_mig69_vault__.js',
  stage: '/__e2e_mig69_stage__.js',
  migrations: '/__e2e_mig69_migrations__.js',
  preflight: '/__e2e_mig69_preflight__.js',
  manifest: '/__e2e_mig69_manifest__.js',
  bridge: '/__e2e_mig69_bridge__.js',
};
const resources = new Map([
  [urls.vault, transpile('../../src/security/local-vault.ts')],
  [urls.stage, transpile('../../src/security/protected-staging.ts')
    .replaceAll("'./local-vault.ts'", JSON.stringify(urls.vault))],
  [urls.migrations, transpile('../../state-migrations.ts')],
  [urls.preflight, transpile('../../src/security/live-legacy-preflight.ts')
    .replaceAll("'../../state-migrations.ts'", JSON.stringify(urls.migrations))
    .replaceAll("'./protected-staging.ts'", JSON.stringify(urls.stage))],
  [urls.manifest, load('../../src/cloud/legacy-import-manifest-candidate.mjs')
    .replaceAll("'../../finance.js'", "'/finance.js'")],
  [urls.bridge, load('../../src/cloud/live-legacy-import-preview-candidate.mjs')
    .replaceAll("'../security/live-legacy-preflight.ts'", JSON.stringify(urls.preflight))
    .replaceAll("'./legacy-import-manifest-candidate.mjs'", JSON.stringify(urls.manifest))],
]);
const ID = 'a'.repeat(32);
const FOREIGN = 'b'.repeat(32);
const PROFILE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

test('real legacy IndexedDB + encrypted backup yields preview only, never cloud postings', async({page,context})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await context.route('**/__e2e_mig69_*.js',route=>route.fulfill({
    status:200,contentType:'text/javascript',
    body:resources.get(new URL(route.request().url()).pathname),
    headers:{'Cache-Control':'no-store'},
  }));
  await page.goto('/__e2e__/ready');
  const result=await page.evaluate(async({id,other,profile})=>{
    const {createSampleState}=await import('/finance.js');
    const {encryptBackup}=await import('/backup.js');
    const {planLiveLegacyImportPreviewCandidate}=await import('/__e2e_mig69_bridge__.js');
    const state=createSampleState();
    state.version=1;delete state.revision;
    state.entries[0].title='INDEPENDENT_BACKUP_SYNTHETIC_PRIVATE_TITLE';
    const db=await new Promise((resolve,reject)=>{
      const r=indexedDB.open('financial-horizon-browser-v1',1);
      r.onupgradeneeded=()=>r.result.createObjectStore('finance');
      r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
    });
    await new Promise((resolve,reject)=>{
      const tx=db.transaction('finance','readwrite');
      tx.objectStore('finance').put(state,'account-state-v2:'+id);
      tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
    });
    db.close();

    const passphrase='synthetic independently exported backup password 2026';
    const backupText=await encryptBackup(state,passphrase);
    const consent={
      savedEncryptedBackupOutsideThisBrowser:true,confirmedReadOnlyPreflight:true,
      externalEncryptedBackupVerified:true,confirmedTargetAccount:true,
      previewRequested:true,explicitGuestTransfer:false,
    };
    const target={accountScope:'account:'+id,profileId:profile,
      serverRevision:0,hasRemoteRecords:false};
    const preview=await planLiveLegacyImportPreviewCandidate({
      selection:{kind:'account',verifiedUserId:id},
      backupText,backupPassword:passphrase,consent,target,
      signal:new AbortController().signal,
    });
    let denied=false;
    try{
      await planLiveLegacyImportPreviewCandidate({
        selection:{kind:'account',verifiedUserId:id},
        backupText,backupPassword:passphrase,consent,
        target:{...target,accountScope:'account:'+other},
        signal:new AbortController().signal,
      });
    }catch(error){denied=String(error.message).includes('IMPORT_HOLD');}
    const restored=await new Promise((resolve,reject)=>{
      const r=indexedDB.open('financial-horizon-browser-v1');
      r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
    });
    const source=await new Promise((resolve,reject)=>{
      const tx=restored.transaction('finance','readonly');
      const r=tx.objectStore('finance').get('account-state-v2:'+id);
      tx.oncomplete=()=>resolve(r.result);tx.onerror=()=>reject(tx.error);
    });
    restored.close();
    return {
      status:preview.status,hash:preview.sourceSha256,
      recordCount:preview.recordCount,
      entries:preview.counts.entries,loans:preview.counts.loans,
      targetScope:preview.targetScope,sourceScope:preview.sourceScope,
      serverWrites:preview.sendAllowed,plannedPostings:preview.plannedLedgerPostings.length,
      balancesInferred:!preview.requiresExplicitOpeningBalances,
      ownerDenied:denied,sourceUnchanged:JSON.stringify(source)===JSON.stringify(state),
      privateTitle:source.entries[0].title,
    };
  },{id:ID,other:FOREIGN,profile:PROFILE});
  expect(result.status).toBe('PREVIEW_ONLY');
  expect(result.hash).toMatch(/^[a-f0-9]{64}$/);
  expect(result.recordCount).toBe(result.entries+result.loans);
  expect(result.recordCount).toBeGreaterThan(0);
  expect(result.targetScope).toBe('account:'+ID);
  expect(result.sourceScope).toBe('account:'+ID);
  expect(result.serverWrites).toBe(false);
  expect(result.plannedPostings).toBe(0);
  expect(result.balancesInferred).toBe(false);
  expect(result.ownerDenied).toBe(true);
  expect(result.sourceUnchanged).toBe(true);
  expect(result.privateTitle).toBe('INDEPENDENT_BACKUP_SYNTHETIC_PRIVATE_TITLE');
  expect(errors).toEqual([]);
});
