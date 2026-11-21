import test from 'node:test';
import assert from 'node:assert/strict';
import {createSampleState} from '../finance.js';
import {encryptBackup} from '../backup.js';
import {verifyLiveLegacyBackup} from '../src/security/live-legacy-preflight.ts';
import {planLiveLegacyImportPreviewCandidate} from '../src/cloud/live-legacy-import-preview-candidate.mjs';
import {prepareLivePersonalImportCandidate, preparePersonalMergeReviewCandidate, executeConfirmedPersonalImportCandidate} from '../src/cloud/personal-import-transport-candidate.mjs';

const accountA = 'a'.repeat(32);
const accountB = 'b'.repeat(32);
const backupPassword = 'independent encrypted backup password 2026';
const consent = {savedEncryptedBackupOutsideThisBrowser:true, confirmedReadOnlyPreflight:true};
const clone = value => structuredClone(value);
const legacy = () => {
  const data = createSampleState();
  data.version = 1;
  delete data.revision;
  return data;
};

function mount(rows, options={}) {
  const values = new Map(Object.entries(rows).map(([key,value]) => [key,clone(value)]));
  let openCount = 0, writeCount = 0, closeCount = 0;
  const db = {
    version:1,
    objectStoreNames:{contains: name => name === 'finance'},
    onversionchange:null,
    close(){closeCount++},
    transaction(name,mode){
      assert.equal(name,'finance');
      assert.equal(mode,'readonly', 'preflight may not modify legacy IndexedDB');
      let pending=0, finished=false;
      const tx={oncomplete:null,onerror:null,onabort:null,error:null,
        objectStore(){
          return {get(key){
            const req={result:undefined,onsuccess:null,onerror:null};
            pending++;
            queueMicrotask(() => {
              req.result=clone(values.get(key));
              req.onsuccess?.();
              pending--;
              if(pending===0)queueMicrotask(() => {
                if(finished)return;
                finished=true;
                tx.oncomplete?.();
              });
            });
            return req;
          }};
        },
      };
      return tx;
    },
  };
  const indexedDB = {open(name,version){
    openCount++;
    assert.equal(name,'financial-horizon-browser-v1');
    assert.equal(version,undefined,'never trigger DB version upgrade');
    if (openCount===2 && typeof options.beforeSecondRead==='function') {
      options.beforeSecondRead(values);
    }
    if (openCount===3 && typeof options.beforeThirdRead==='function') {
      options.beforeThirdRead(values);
    }
    if (openCount===4 && typeof options.beforeFourthRead==='function') {
      options.beforeFourthRead(values);
    }
    const req={onsuccess:null,onerror:null,onupgradeneeded:null,onblocked:null,result:db,error:null,transaction:null};
    queueMicrotask(()=>req.onsuccess?.());
    return req;
  }};
  globalThis.indexedDB=indexedDB;
  return {
    values,
    get openCount(){return openCount},
    get writeCount(){return writeCount},
    get closeCount(){return closeCount},
  };
}
const account = id => ({kind:'account',verifiedUserId:id});
const guest = (namespace='guest-qa-local') => ({kind:'guest',guestNamespace:namespace});
const verify = (selection, backupText, extra={}) => verifyLiveLegacyBackup({
  selection,backupText,backupPassword,consent,...extra,
});

test('populated profile yields a verified read-only inventory, never an import command', async () => {
  const source=legacy(), backupText=await encryptBackup(source,backupPassword);
  const db=mount({['account-state-v2:'+accountA]:source});
  const profile='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const entities=[
    {id:'11111111-1111-4111-8111-111111111111',kind:'account',entity_revision:1,data:{}},
    {id:'22222222-2222-4222-8222-222222222222',kind:'obligation',entity_revision:1,data:{}},
    {id:'33333333-3333-4333-8333-333333333333',kind:'reserve',entity_revision:1,data:{}},
  ];
  const calls=[];
  const fetchImpl=async (url,init)=>{
    calls.push([new URL(url).pathname,init.method]);
    const body=init.method==='POST' ? {ok:true,profile_id:profile} :
      {schema_version:1,profile_id:profile,revision:3,currency:'RUB',entities};
    return new Response(JSON.stringify(body),{status:200,headers:{
      'Content-Type':'application/json',ETag:'"synthetic"',
    }});
  };
  const signal=new AbortController().signal;
  const prepared=await prepareLivePersonalImportCandidate({
    verifiedActorUserId:accountA,backupText,backupPassword,fetchImpl,
    origin:'https://fin-horizon.example',signal,explicitConsent:true,
  });
  assert.equal(prepared.preview.status,'NEEDS_CONFLICT_DECISION');
  assert.equal(prepared.serverCounts.account,1);
  assert.equal(prepared.serverCounts.obligation,1);
  assert.equal(prepared.serverCounts.reserve,1);
  assert.equal(prepared.comparison.status,'NEEDS_OWNER_DECISIONS');
  assert.equal(prepared.comparison.groups.entries.local.length,source.entries.length);
  assert.deepEqual(prepared.comparison.groups.entries.serverIds,[entities[1].id]);
  assert.equal(prepared.payload,undefined);
  const decisions=Object.entries(prepared.comparison.groups).flatMap(([kind,group])=>
    group.local.map(row=>({kind,sourceId:row.sourceId,action:'add'})));
  const draft=await preparePersonalMergeReviewCandidate({prepared,verifiedActorUserId:accountA,
    currentLocalSnapshotMatches:true,decisions,signal});
  assert.equal(draft.preview.status,'MERGE_PREVIEW_ONLY');
  assert.equal(draft.payload.manifest.schema_version,2);
  assert.equal(draft.payload.manifest.rows.length,prepared.preview.recordCount);
  await assert.rejects(preparePersonalMergeReviewCandidate({prepared,verifiedActorUserId:accountA,
    currentLocalSnapshotMatches:true,decisions:decisions.slice(1),signal}),/IMPORT_HOLD/);
  await assert.rejects(preparePersonalMergeReviewCandidate({prepared,verifiedActorUserId:accountA,
    currentLocalSnapshotMatches:true,decisions:[{...decisions[0],action:'link',
      targetId:'44444444-4444-4444-8444-444444444444'},...decisions.slice(1)],signal}),/IMPORT_HOLD/);
  let getterCalled=false;
  const unsafe={...decisions[0]};
  Object.defineProperty(unsafe,'action',{enumerable:true,get(){getterCalled=true;return 'add'}});
  await assert.rejects(preparePersonalMergeReviewCandidate({prepared,verifiedActorUserId:accountA,
    currentLocalSnapshotMatches:true,decisions:[unsafe,...decisions.slice(1)],signal}),/IMPORT_HOLD/);
  assert.equal(getterCalled,false);
  await assert.rejects(executeConfirmedPersonalImportCandidate({
    prepared,verifiedActorUserId:accountA,currentLocalSnapshotMatches:true,
    explicitFinalConsent:true,fetchImpl,signal,
  }),/IMPORT_HOLD/);
  const recorded=[];
  const batch='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const finish=await executeConfirmedPersonalImportCandidate({prepared:draft,
    verifiedActorUserId:accountA,currentLocalSnapshotMatches:true,explicitFinalConsent:true,signal,
    fetchImpl:async (url,init)=>{
      const path=new URL(url).pathname;recorded.push(path);
      let body;
      if(path.endsWith('/manifest'))body={status:'UNVERIFIED_MANIFEST_STAGED',batch_id:batch,
        record_count:draft.preview.recordCount,financial_write:false};
      else if(path.endsWith('/commit'))body={status:'COMMITTED',batch_id:batch,revision:4,
        record_count:draft.preview.recordCount,source_sha256:draft.preview.sourceSha256,
        source_original_preserved:true,cash_postings_created:0,
        created_counts:Object.fromEntries(Object.entries(draft.mergeCounts.add).reverse()),
        linked_counts:Object.fromEntries(Object.entries(draft.mergeCounts.link).reverse())};
      else return new Response(draft.payload.source_canonical_json,{status:200,headers:{'Content-Type':'application/json'}});
      return new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
    },
  });
  assert.equal(finish.status,'COMMITTED_AND_SOURCE_RESTORED');
  assert.deepEqual(recorded,['/api/finance/v1/import/commit','/api/finance/v1/import/restore']);
  assert.deepEqual(calls,[['/api/auth/email/finance/session','POST'],
    ['/api/finance/v1/state','GET']]);
  assert.deepEqual(db.values.get('account-state-v2:'+accountA),source);
  assert.equal(db.writeCount,0);
});

test('populated preview rejects incomplete, stale and malformed snapshots before reading local data', async () => {
  const source=legacy(), backupText=await encryptBackup(source,backupPassword);
  const db=mount({['account-state-v2:'+accountA]:source});
  const profile='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const row={id:'11111111-1111-4111-8111-111111111111',kind:'obligation',entity_revision:1,data:{}};
  const valid={schema_version:1,profile_id:profile,revision:3,currency:'RUB',entities:[row]};
  for(const [body,etag] of [
    [{...valid,next_cursor:'more'},'"strong"'],
    [valid,'W/"weak"'],
    [{...valid,entities:[row,row]},'"strong"'],
    [{...valid,entities:[{...row,entity_revision:4}]},'"strong"'],
    [{...valid,entities:[{...row,kind:'unknown'}]},'"strong"'],
    [{...valid,entities:[{...row,kind:'loan',data:{imported_schedule:[{date:'2026-01-01',internalId:'synthetic'}]}}]},'"strong"'],
  ]) {
    const calls=[];
    await assert.rejects(prepareLivePersonalImportCandidate({
      verifiedActorUserId:accountA,backupText,backupPassword,
      origin:'https://fin-horizon.example',signal:new AbortController().signal,
      explicitConsent:true,fetchImpl:async (url,init)=>{
        calls.push([new URL(url).pathname,init.method]);
        return new Response(JSON.stringify(init.method==='POST' ? {ok:true,profile_id:profile} : body),
          {status:200,headers:{'Content-Type':'application/json',ETag:etag}});
      },
    }),/IMPORT_HOLD/);
    assert.deepEqual(calls,[['/api/auth/email/finance/session','POST'],['/api/finance/v1/state','GET']]);
  }
  assert.equal(db.openCount,0);
  assert.deepEqual(db.values.get('account-state-v2:'+accountA),source);
});

test('unclaimed guest reads only legacy state and migrates encrypted v1 backup to v2',async()=>{
  const state=legacy(),original=clone(state);
  const backupText=await encryptBackup(state,backupPassword);
  const db=mount({state});
  const result=await verify(guest(),backupText);
  assert.equal(result.scope,'guest:guest-qa-local');
  assert.equal(result.sourceKey,'state');
  assert.equal(result.backupVersion,1);
  assert.equal(result.sourceRevision,0);
  assert.equal(result.snapshot.version,2);
  assert.deepEqual(result.snapshot.entries,state.entries);
  assert.deepEqual(db.values.get('state'),original);
  assert.equal(db.openCount,2);
  assert.equal(db.closeCount,2);
  assert.equal(db.writeCount,0);
});

test('claimed guest uses separate guest-state-v2, never leaks claimed legacy state',async()=>{
  const previous=legacy(),guestState=legacy();
  guestState.entries[0].title='EXPLICIT_GUEST_ONLY';
  const backupText=await encryptBackup(guestState,backupPassword);
  const db=mount({state:previous,'legacy-account-claim-v2':accountA,'guest-state-v2':guestState});
  const result=await verify(guest(),backupText);
  assert.equal(result.sourceKey,'guest-state-v2');
  assert.equal(result.snapshot.entries[0].title,'EXPLICIT_GUEST_ONLY');
  assert.notEqual(result.snapshot.entries[0].title,previous.entries[0].title);
  assert.deepEqual(db.values.get('state'),previous);
});

test('account uses exact account-state key, no fallback to old shared state',async()=>{
  const source=legacy(),other=legacy();
  other.entries[0].title='OTHER_ACCOUNT_DATA';
  const backupText=await encryptBackup(source,backupPassword);
  const db=mount({state:other,'legacy-account-claim-v2':accountB,
    ['account-state-v2:'+accountA]:source});
  const result=await verify(account(accountA),backupText);
  assert.equal(result.scope,'account:'+accountA);
  assert.equal(result.sourceKey,'account-state-v2:'+accountA);
  assert.equal(result.snapshot.entries[0].title,source.entries[0].title);
  assert.deepEqual(db.values.get('state'),other);
});

test('account without exact key rejects even when a previous owner has shared legacy state',async()=>{
  const state=legacy(),backupText=await encryptBackup(state,backupPassword);
  const db=mount({state,'legacy-account-claim-v2':accountA});
  await assert.rejects(()=>verify(account(accountA),backupText),/нет исходных финансовых данных/);
  assert.equal(db.openCount,1);
});

test('backup must match all financial fields rather than merely contain a valid password',async()=>{
  const state=legacy(),different=legacy();
  different.entries[0].title='DIVERGENT_PRIVATE_TITLE';
  const backupText=await encryptBackup(different,backupPassword);
  const db=mount({state});
  await assert.rejects(()=>verify(guest(),backupText),/не совпадает/);
  assert.equal(db.values.get('state').entries[0].title,state.entries[0].title);
  assert.equal(db.openCount,1);
});

test('wrong backup password rejects; never alters old finance or tries candidate database',async()=>{
  const state=legacy(),backupText=await encryptBackup(state,backupPassword);
  const db=mount({state});
  await assert.rejects(()=>verify(guest(),backupText,{backupPassword:'wrong independent backup password 2026'}),/Неверный пароль/);
  assert.deepEqual(db.values.get('state'),state);
  assert.equal(db.openCount,1);
});

test('a different tab changing a settlement during KDF invalidates the preflight',async()=>{
  const state=legacy(),backupText=await encryptBackup(state,backupPassword);
  const db=mount({state},{beforeSecondRead(values){
    const changed=clone(values.get('state'));
    changed.entries[0].amountCents+=1234;
    values.set('state',changed);
  }});
  await assert.rejects(()=>verify(guest(),backupText),/изменились во время проверки/);
  assert.equal(db.values.get('state').entries[0].amountCents,state.entries[0].amountCents+1234);
});

test('a concurrent claim switches guest source and aborts without cross-account migration',async()=>{
  const state=legacy(),backupText=await encryptBackup(state,backupPassword);
  const db=mount({state},{beforeSecondRead(values){values.set('legacy-account-claim-v2',accountA)}});
  await assert.rejects(()=>verify(guest(),backupText),/нет исходных финансовых данных|изменились во время проверки/);
  assert.deepEqual(db.values.get('state'),state);
});

test('mutable identity and backup arguments are pinned before first asynchronous read',async()=>{
  const state=legacy(),backupText=await encryptBackup(state,backupPassword);
  const db=mount({['account-state-v2:'+accountA]:state});
  const input={selection:account(accountA),backupText,backupPassword,consent};
  const promise=verifyLiveLegacyBackup(input);
  input.selection.verifiedUserId=accountB;
  input.backupText='incorrect data';
  input.backupPassword='attacker tampered backup password';
  const result=await promise;
  assert.equal(result.scope,'account:'+accountA);
  assert.equal(result.sourceKey,'account-state-v2:'+accountA);
  assert.equal(db.openCount,2);
});

test('invalid claim, identity or missing consent fail closed',async()=>{
  const state=legacy(),backupText=await encryptBackup(state,backupPassword);
  const db=mount({state,'legacy-account-claim-v2':'not-a-real-account'});
  await assert.rejects(()=>verify(guest(),backupText),/Повреждена привязка/);
  assert.equal(db.openCount,1);
  await assert.rejects(()=>verify(account('INVALID'),backupText),/Некорректный финансовый профиль/);
  await assert.rejects(()=>verify(guest(),backupText,{consent:{...consent,confirmedReadOnlyPreflight:false}}),/Не подтверждены/);
  assert.equal(db.openCount,1);
});

test('valid encrypted v1 backup and equivalent reordered v2 payload are accepted',async()=>{
  const state=legacy(),backupText=await encryptBackup(state,backupPassword);
  const sourceV2={version:2,revision:0,...Object.fromEntries(Object.entries(state)
    .filter(([key])=>key!=='version'&&key!=='revision'))};
  mount({state:sourceV2});
  const result=await verify(guest(),backupText);
  assert.equal(result.sourceRevision,0);
  assert.deepEqual(result.snapshot,sourceV2);
});

test('offline verification needs no network services',async()=>{
  const state=legacy(),backupText=await encryptBackup(state,backupPassword);
  mount({state});
  const original=globalThis.fetch;
  globalThis.fetch=async()=>{throw Error('No network available')};
  try{assert.equal((await verify(guest(),backupText)).snapshot.version,2)}
  finally{globalThis.fetch=original}
});


const livePreviewTarget = (fields={}) => ({
  accountScope: 'account:' + accountA,
  profileId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  serverRevision: 0, hasRemoteRecords: false, ...fields,
});
const livePreviewConsent = (guestTransfer=false) => ({
  ...consent,
  externalEncryptedBackupVerified: true,
  confirmedTargetAccount: true,
  previewRequested: true,
  explicitGuestTransfer: guestTransfer,
});
const previewFromBrowser = (selection, backupText, extra={}) =>
  planLiveLegacyImportPreviewCandidate({
    selection, backupText, backupPassword,
    target: livePreviewTarget(), consent: livePreviewConsent(selection.kind==='guest'),
    signal: new AbortController().signal, ...extra,
  });

test('#69 real IndexedDB read-only backup check is repeated after import hashing', async()=>{
  const state=legacy(),old=clone(state);
  const encrypted=await encryptBackup(state,backupPassword);
  const db=mount({state});
  const previousFetch=globalThis.fetch;
  let calls=0;
  globalThis.fetch=()=>{calls++;throw Error('Import preview must never send financial data')};
  try{
    const result=await previewFromBrowser(guest(),encrypted);
    assert.equal(result.status,'PREVIEW_ONLY');
    assert.equal(result.sourceScope,'guest:guest-qa-local');
    assert.equal(result.targetScope,'account:'+accountA);
    assert.equal(result.recordCount,state.entries.length+state.loans.length);
    assert.equal(result.sendAllowed,false);
    assert.deepEqual(result.plannedLedgerPostings,[]);
    assert.equal(db.openCount,4, 'two full read-only encrypted-backup comparisons');
    assert.equal(db.writeCount,0);
    assert.equal(calls,0);
    assert.deepEqual(db.values.get('state'),old);
  }finally{globalThis.fetch=previousFetch}
});

test('#69 revalidation catches changed legacy amounts between preview and final read',async()=>{
  const state=legacy(),backup=await encryptBackup(state,backupPassword);
  const db=mount({state},{beforeFourthRead(values){
    const edited=clone(values.get('state'));
    edited.entries[0].amountCents+=123;
    values.set('state',edited);
  }});
  await assert.rejects(()=>previewFromBrowser(guest(),backup),/не совпадает|изменились/);
  assert.equal(db.openCount,4);
  assert.equal(db.writeCount,0);
});

test('#69 revalidation rejects guest-claim source switch with identical money',async()=>{
  const state=legacy(),backup=await encryptBackup(state,backupPassword);
  // Change the claim BETWEEN the first completed full backup comparison
  // and the second one. Each individual preflight sees a stable snapshot:
  // only the wrapper's cross-check can catch this scope-switch.
  const db=mount({state,'guest-state-v2':state},{beforeThirdRead(values){
    values.set('legacy-account-claim-v2',accountA);
  }});
  await assert.rejects(()=>previewFromBrowser(guest(),backup),/IMPORT_HOLD/);
  assert.equal(db.openCount,4);
  assert.equal(db.writeCount,0);
});

test('#69 account selection needs exact owner and all import consents',async()=>{
  const state=legacy(),backup=await encryptBackup(state,backupPassword);
  const db=mount({['account-state-v2:'+accountA]:state});
  const result=await previewFromBrowser(account(accountA),backup);
  assert.equal(result.sourceScope,'account:'+accountA);
  assert.equal(result.targetScope,'account:'+accountA);
  assert.equal(result.sendAllowed,false);
  await assert.rejects(()=>previewFromBrowser(account(accountA),backup,{
    target:livePreviewTarget({accountScope:'account:'+accountB}),
  }),/IMPORT_HOLD/);
  await assert.rejects(()=>previewFromBrowser(account(accountA),backup,{
    consent: {...livePreviewConsent(), previewRequested:false},
  }),/IMPORT_HOLD/);
  assert.equal(db.writeCount,0);
});


test('#69 encrypted legacy preview of a single unused server zero account never uploads money',async()=>{
  const state=legacy(),backup=await encryptBackup(state,backupPassword);
  const db=mount({['account-state-v2:'+accountA]:state});
  const zero='11111111-1111-4111-8111-111111111111';
  const target=livePreviewTarget({
    hasRemoteRecords:true,serverRevision:1,preserveZeroAccountId:zero,
  });
  const originalFetch=globalThis.fetch;
  let http=0;
  globalThis.fetch=()=>{http++;throw Error('No network during encrypted preflight')};
  try{
    const withheld=await previewFromBrowser(account(accountA),backup,{target});
    assert.equal(withheld.status,'NEEDS_CONFLICT_DECISION');
    assert.equal(withheld.sendAllowed,false);
    const confirmed=await previewFromBrowser(account(accountA),backup,{
      target,consent:{...livePreviewConsent(),confirmPreserveZeroAccount:true},
    });
    assert.equal(confirmed.status,'PREVIEW_ONLY');
    assert.equal(confirmed.preservedZeroAccountId,zero);
    assert.equal(confirmed.expectedServerRevision,1);
    assert.deepEqual(confirmed.plannedAccounts,[]);
    assert.deepEqual(confirmed.plannedLedgerPostings,[]);
    assert.equal(db.writeCount,0);
    assert.equal(http,0);
    assert.deepEqual(db.values.get('account-state-v2:'+accountA),state);
  }finally{globalThis.fetch=originalFetch}
});
