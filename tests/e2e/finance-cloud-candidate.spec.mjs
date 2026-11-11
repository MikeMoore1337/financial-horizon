import {test, expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

// #68 feature-OFF contract E2E. Uses real Web Crypto and native IndexedDB in
// Chromium/WebKit, but only synthetic finance data and no production network.
// It does NOT activate cloud finance in app.js or change existing guest data.
const transpile = source => ts.transpileModule(
  readFileSync(new URL(source, import.meta.url), 'utf8'),
  {compilerOptions: {module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022}},
).outputText;
const load = source => readFileSync(new URL(source, import.meta.url), 'utf8');
const urls = {
  vault: '/__e2e_cloud68_vault__.js',
  session: '/__e2e_cloud68_session__.js',
  atomic: '/__e2e_cloud68_atomic__.js',
  delta: '/__e2e_cloud68_delta__.js',
  cache: '/__e2e_cloud68_cache__.js',
  outbox: '/__e2e_cloud68_outbox__.js',
};
const sources = new Map([
  [urls.vault, transpile('../../src/security/local-vault.ts')],
  [urls.session, transpile('../../src/security/local-budget-session.ts')
    .replaceAll("'./local-vault.ts'", JSON.stringify(urls.vault))],
  [urls.atomic, transpile('../../src/security/protected-atomic-candidate.ts')
    .replaceAll("'./local-vault.ts'", JSON.stringify(urls.vault))],
  [urls.delta, load('../../src/cloud/verified-delta-candidate.mjs')],
  [urls.cache, load('../../src/cloud/encrypted-cloud-cache-candidate.mjs')
    .replaceAll("'../security/protected-atomic-candidate.ts'", JSON.stringify(urls.atomic))
    .replaceAll("'./verified-delta-candidate.mjs'", JSON.stringify(urls.delta))],
  [urls.outbox, load('../../src/cloud/encrypted-command-outbox-candidate.mjs')
    .replaceAll("'../security/protected-atomic-candidate.ts'", JSON.stringify(urls.atomic))
    .replaceAll("'./verified-delta-candidate.mjs'", JSON.stringify(urls.delta))],
]);
const PROFILE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SOURCE = 'b0000000-0000-4000-8000-000000000001';
const CREATED = 'c0000000-0000-4000-8000-000000000002';
const MUTATION = 'd0000000-0000-4000-8000-000000000003';

test('native encrypted cloud cache+outbox+server ACK survive reload with exact cash', async({page,context})=>{
  const errors=[];
  page.on('pageerror', error=>errors.push(error.message));
  await context.route('**/__e2e_cloud68_*.js', route=>route.fulfill({
    status:200, contentType:'text/javascript',
    body:sources.get(new URL(route.request().url()).pathname),
    headers:{'Cache-Control':'no-store'},
  }));
  await page.goto('/__e2e__/ready');
  const first=await page.evaluate(async ({profile,source,created,mutation})=>{
    const atomic=await import('/__e2e_cloud68_atomic__.js');
    const {LocalBudgetSession}=await import('/__e2e_cloud68_session__.js');
    const {initializeEncryptedCloudCacheCandidate}=await import('/__e2e_cloud68_cache__.js');
    const {enqueueEncryptedFinanceCommandCandidate}=await import('/__e2e_cloud68_outbox__.js');
    const scope='account:'+'a'.repeat(32);
    const passphrase='independent encrypted cloud 68 phrase 2026';
    const starting={
      version:2,revision:0,title:'SECRET_LEGACY_FINANCES_UNTOUCHED',
      amountCents:4211337,
    };
    const account={
      id:source,kind:'account',entity_revision:1,
      data:{name:'REAL_SERVER_OLD_BALANCE',type:'bank',currency:'RUB',
        opening_minor:10000,balance_minor:10000,
        reserved_minor:0,available_minor:10000,archived_at:null},
    };
    await atomic.createAtomicEncryptedCandidate(scope,passphrase,{
      snapshot:starting,outbox:[],conflicts:[],
    },2);
    const session=new LocalBudgetSession();session.selectScope(scope);
    await session.unlock(await atomic.getAtomicEncryptedKeyset(scope),{passphrase});
    const identity={scope,profileId:profile,generation:session.lifecycleVersion,
      epoch:'e'.repeat(32),signal:session.lifecycleSignal};
    const pages=[{cursorSent:null,body:{schema_version:1,profile_id:profile,
      currency:'RUB',revision:0,entities:[account]}}];
    const prepared=await initializeEncryptedCloudCacheCandidate({
      scope,session,identity,pages,expectedEpoch:0,
      confirmedAccountCacheInitialization:true,
    });
    const command={schema_version:2,client_mutation_id:mutation,base_revision:0,
      action:'account.create',expected_entity_revisions:{},
      payload:{id:created,name:'SECRET_PENDING_ACCOUNT',
        kind:'cash',currency:'RUB',opening_minor:2000}};
    const queued=await enqueueEncryptedFinanceCommandCandidate({
      scope,session,identity,command,ifMatch:'"synthetic-strong-etag"',
      expectedEpoch:prepared.bundleEpoch,
    });
    const saved=await atomic.readAtomicEncryptedCandidate(scope,session);
    const db=await new Promise((resolve,reject)=>{
      const r=indexedDB.open(atomic.ATOMIC_ENCRYPTED_DB,1);
      r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
    });
    const encrypted=await new Promise((resolve,reject)=>{
      const tx=db.transaction(['keysets','bundles'],'readonly');
      const key=tx.objectStore('keysets').getAll();
      const bodies=tx.objectStore('bundles').getAll();
      tx.oncomplete=()=>resolve(JSON.stringify([key.result,bodies.result]));
      tx.onerror=()=>reject(tx.error);
    });
    db.close();session.logout();
    return {epoch:saved.epoch,revision:saved.snapshot.cloudFinance.revision,
      originalTitle:saved.snapshot.title,legacyAmount:saved.snapshot.amountCents,
      pending:saved.outbox.length,queuedId:saved.outbox[0].mutationId,
      originalBalance:saved.snapshot.cloudFinance.entities[0].data.balance_minor,
      encrypted:!['SECRET_PENDING_ACCOUNT','SECRET_LEGACY_FINANCES_UNTOUCHED',
        'REAL_SERVER_OLD_BALANCE',passphrase,mutation,created,'4211337']
        .some(secret=>encrypted.includes(secret)),
      blocked:session.state==='unselected',sent:queued.sent};
  },{profile:PROFILE,source:SOURCE,created:CREATED,mutation:MUTATION});
  expect(first).toEqual({epoch:2,revision:0,
    originalTitle:'SECRET_LEGACY_FINANCES_UNTOUCHED',
    legacyAmount:4211337,pending:1,queuedId:MUTATION,originalBalance:10000,
    encrypted:true,blocked:true,sent:false});

  // Re-open the real encrypted browser data in a fresh JS/vault lifecycle.
  await page.reload();
  await page.evaluate(async()=>{
    globalThis.__cloud68={
      atomic:await import('/__e2e_cloud68_atomic__.js'),
      session:await import('/__e2e_cloud68_session__.js'),
      outbox:await import('/__e2e_cloud68_outbox__.js'),
    };
  });
  await context.setOffline(true);
  try{
    const beforeAck=await page.evaluate(async ()=>{
      const {atomic,session:sessionModule}=globalThis.__cloud68;
      const scope='account:'+'a'.repeat(32);
      const s=new sessionModule.LocalBudgetSession();s.selectScope(scope);
      const passphrase='independent encrypted cloud 68 phrase 2026';
      await s.unlock(await atomic.getAtomicEncryptedKeyset(scope),{passphrase});
      const before=await atomic.readAtomicEncryptedCandidate(scope,s);
      globalThis.__cloud68.active=s;
      return {offline:!navigator.onLine,revision:before.snapshot.cloudFinance.revision,
        balance:before.snapshot.cloudFinance.entities[0].data.balance_minor,
        pending:before.outbox.length,uuid:before.outbox[0].mutationId,
        legacy:before.snapshot.title};
    });
    expect(beforeAck).toEqual({offline:true,revision:0,balance:10000,
      pending:1,uuid:MUTATION,legacy:'SECRET_LEGACY_FINANCES_UNTOUCHED'});
  }finally{await context.setOffline(false);}

  const second=await page.evaluate(async ({created,mutation,source})=>{
    const {atomic,outbox,active:s}=globalThis.__cloud68;
    const scope='account:'+'a'.repeat(32);
    const identity={scope,profileId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      generation:s.lifecycleVersion,epoch:'e'.repeat(32),signal:s.lifecycleSignal};
    const newAccount={id:created,kind:'account',entity_revision:1,
      data:{name:'SYNTHETIC_SERVER_CONFIRMED_ACCOUNT',type:'cash',
        currency:'RUB',opening_minor:2000,balance_minor:2000,
        reserved_minor:0,available_minor:2000,archived_at:null}};
    const change={revision:1,ordinal:0,kind:'upsert',
      entity_id:created,entity_revision:1,payload:{entity:newAccount}};
    const receipt={schema_version:2,client_mutation_id:mutation,
      revision:1,replayed:false,changes:[change]};
    const deltaPage={schema_version:1,from_revision:0,to_revision:1,
      next_since_revision:1,has_more:false,changes:[change]};
    // These are TWO independent synthetic response bodies, not a real
    // PostgreSQL authorization. The production route is still feature OFF.
    const result=await outbox.persistAuthenticatedFinanceReceiptCandidate({
      scope,session:s,identity,expectedEpoch:2,receipt,deltaPage,
      commandHttpStatus:201,deltaHttpStatus:200,
    });
    const saved=await atomic.readAtomicEncryptedCandidate(scope,s);
    const replay=await outbox.enqueueEncryptedFinanceCommandCandidate({
      scope,session:s,identity,expectedEpoch:3,
      command:{schema_version:2,client_mutation_id:mutation,base_revision:0,
        action:'account.create',expected_entity_revisions:{},
        payload:{id:created,name:'SECRET_PENDING_ACCOUNT',
          kind:'cash',currency:'RUB',opening_minor:2000}},
      ifMatch:'"synthetic-strong-etag"',
    });
    const values={status:result.status,revision:saved.snapshot.cloudFinance.revision,
      pending:saved.outbox.length,proof:saved.snapshot.cloudFinance.appliedReceipts.length,
      originalBalance:saved.snapshot.cloudFinance.entities.find(x=>x.id===source).data.balance_minor,
      newBalance:saved.snapshot.cloudFinance.entities.find(x=>x.id===created).data.balance_minor,
      legacy:saved.snapshot.title,replay:replay.status};
    s.logout();
    return values;
  },{created:CREATED,mutation:MUTATION,source:SOURCE});
  expect(second).toEqual({status:'DURABLY_CONFIRMED',revision:1,pending:0,
    proof:1,originalBalance:10000,newBalance:2000,
    legacy:'SECRET_LEGACY_FINANCES_UNTOUCHED',replay:'ALREADY_CONFIRMED'});
  expect(errors).toEqual([]);
});
