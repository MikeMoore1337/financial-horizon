import test from 'node:test';
import assert from 'node:assert/strict';
import {createSampleState} from '../finance.js';
import {planVerifiedLegacyImportCandidate,
  prepareVerifiedLegacyImportTransportCandidate,
} from '../src/cloud/legacy-import-manifest-candidate.mjs';
import {executeConfirmedPersonalImportCandidate,
  prepareLivePersonalImportCandidate,
} from '../src/cloud/personal-import-transport-candidate.mjs';

const USER = 'a'.repeat(32), PROFILE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORIGIN = 'https://fin-horizon.mikemoore.top';
const ETAG = '"fh.1.0.synthetic"';
const BATCH = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const req = () => new AbortController().signal;

function reply(body, status=200) {
  return new Response(JSON.stringify(body), {
    status, headers: {'Content-Type':'application/json'},
  });
}
async function example() {
  const source = createSampleState();
  const verified = {scope:'account:' + USER, sourceKey:'account-state-v2:' + USER,
    sourceRevision:source.revision, snapshot:source, backupVersion:1};
  const preview = await planVerifiedLegacyImportCandidate({
    verified, target:{accountScope:verified.scope, profileId:PROFILE,
      serverRevision:0, hasRemoteRecords:false},
    consent:{externalEncryptedBackupVerified:true,
      confirmedTargetAccount:true,previewRequested:true},
    signal:req(),
  });
  const payload = await prepareVerifiedLegacyImportTransportCandidate({
    verified, preview, signal:req(),
  });
  return {actor:USER, origin:ORIGIN, profileId:PROFILE,
    revision:0, etag:ETAG, snapshot:source, preview, payload};
}

test('confirmed owner import stages, commits once and recovers exact source bytes', async () => {
  const prepared = await example(), calls=[];
  const responders = [
    reply({status:'UNVERIFIED_MANIFEST_STAGED',batch_id:BATCH,
      record_count:prepared.preview.recordCount,financial_write:false},202),
    reply({status:'COMMITTED',batch_id:BATCH,revision:1,
      record_count:prepared.preview.recordCount,
      source_sha256:prepared.preview.sourceSha256,
      source_original_preserved:true,cash_postings_created:0},201),
    reply(JSON.parse(prepared.payload.source_canonical_json),200),
  ];
  const transport = async (url, init) => {
    calls.push({url,init});
    return responders.shift();
  };
  const result = await executeConfirmedPersonalImportCandidate({
    prepared,verifiedActorUserId:USER,
    currentLocalSnapshotMatches:true, explicitFinalConsent:true,
    fetchImpl:transport, signal:req(),
  });
  assert.deepEqual(result, {
    status:'COMMITTED_AND_SOURCE_RESTORED',revision:1,
    recordCount:prepared.preview.recordCount,
    sourceSha256:prepared.preview.sourceSha256,
    localDataPreserved:true,cashPostingsCreated:0,
  });
  assert.equal(calls.length,3);
  assert.deepEqual(calls.map(x=>new URL(x.url).pathname), [
    '/api/finance/v1/import/manifest',
    '/api/finance/v1/import/commit',
    '/api/finance/v1/import/restore',
  ]);
  for(const x of calls) {
    assert.equal(x.init.credentials,'same-origin');
    assert.equal(x.init.redirect,'error');
    assert.equal(x.init.referrerPolicy,'same-origin');
    assert.equal(x.init.cache,'no-store');
    assert.equal(x.init.mode,'same-origin');
    assert(!('Authorization' in x.init.headers));
    assert(!x.url.includes('source_canonical_json'));
  }
  const [stage, commit, restore]=calls;
  assert.equal(stage.init.headers['If-Match'],ETAG);
  assert.equal(commit.init.headers['If-Match'],ETAG);
  assert.deepEqual(JSON.parse(stage.init.body),{manifest:prepared.payload.manifest});
  assert.deepEqual(JSON.parse(commit.init.body),prepared.payload);
  assert.deepEqual(JSON.parse(restore.init.body),{
    batch_id:BATCH, source_sha256:prepared.preview.sourceSha256,
    confirm_restore:true,
  });
});

test('explicit consent, same owner and unchanged local snapshot required before any network', async () => {
  const prepared=await example();
  let calls=0;
  const fetchImpl=async()=>{calls++;throw Error('No request allowed');};
  for(const changes of [
    {explicitFinalConsent:false},
    {currentLocalSnapshotMatches:false},
    {verifiedActorUserId:'b'.repeat(32)},
    {prepared:{...prepared,etag:'W/"weak"'}},
    {prepared:{...prepared,preview:{...prepared.preview,status:'NEEDS_CONFLICT_DECISION'}}},
  ]) {
    await assert.rejects(executeConfirmedPersonalImportCandidate({
      prepared,verifiedActorUserId:USER,currentLocalSnapshotMatches:true,
      explicitFinalConsent:true,fetchImpl,signal:req(),...changes,
    }),/IMPORT_HOLD:/);
  }
  assert.equal(calls,0);
});

test('no attempt to POST commit after foreign batch, unconfirmed stage or server conflict', async () => {
  const prepared=await example();
  for(const first of [
    reply({status:'UNVERIFIED_MANIFEST_STAGED',batch_id:BATCH,
      record_count:prepared.preview.recordCount,financial_write:true},202),
    reply({status:'UNVERIFIED_MANIFEST_STAGED',batch_id:BATCH,
      record_count:prepared.preview.recordCount+1,financial_write:false},202),
    reply({status:'error',code:'stale_revision'},412),
  ]) {
    let calls=0;
    await assert.rejects(executeConfirmedPersonalImportCandidate({
      prepared,verifiedActorUserId:USER,currentLocalSnapshotMatches:true,
      explicitFinalConsent:true,signal:req(),
      fetchImpl:async()=>{calls++;if(calls===1)return first;throw Error('Must not commit');},
    }),/IMPORT_HOLD:/);
    assert.equal(calls,1);
  }
});

test('ambiguous commit and failed server restore preserve local original and forbid auto-retry', async () => {
  const prepared=await example();
  const stage=reply({status:'UNVERIFIED_MANIFEST_STAGED',batch_id:BATCH,
    record_count:prepared.preview.recordCount,financial_write:false},202);
  let calls=0;
  await assert.rejects(executeConfirmedPersonalImportCandidate({
    prepared,verifiedActorUserId:USER,currentLocalSnapshotMatches:true,
    explicitFinalConsent:true,signal:req(),fetchImpl:async()=>{
      calls++;if(calls===1)return stage;throw Error('Connection was lost after commit');
    },
  }),/IMPORT_HOLD:/);
  assert.equal(calls,2);
  // Even a misleading successful receipt is rejected if exact original
  // bytes are not retrievable from the authenticated owner profile.
  calls=0;
  await assert.rejects(executeConfirmedPersonalImportCandidate({
    prepared,verifiedActorUserId:USER,currentLocalSnapshotMatches:true,
    explicitFinalConsent:true,signal:req(),fetchImpl:async()=>{
      calls++;
      if(calls===1)return reply({status:'UNVERIFIED_MANIFEST_STAGED',batch_id:BATCH,
        record_count:prepared.preview.recordCount,financial_write:false},202);
      if(calls===2)return reply({status:'COMMITTED',batch_id:BATCH,revision:1,
        record_count:prepared.preview.recordCount,source_sha256:prepared.preview.sourceSha256,
        source_original_preserved:true,cash_postings_created:0},201);
      return reply({fake:true},200);
    },
  }),/IMPORT_HOLD:/);
  assert.equal(calls,3);
});

test('preparation cannot access unprotected origins, missing backup or unverified user', async () => {
  let calls=0;
  const fetchImpl=async()=>{calls++;throw Error('No network');};
  for(const values of [
    {origin:'http://evil.invalid'},
    {origin:'https://evil.invalid/path'},
    {verifiedActorUserId:'not-a-user'},
    {backupText:''},
    {backupPassword:'short'},
    {explicitConsent:false},
  ]) {
    await assert.rejects(prepareLivePersonalImportCandidate({
      verifiedActorUserId:USER,backupText:'encrypted-but-not-yet-checked',
      backupPassword:'Password-123456',fetchImpl,origin:ORIGIN,
      signal:req(),explicitConsent:true,...values,
    }),/IMPORT_HOLD:/);
  }
  assert.equal(calls,0);
});


test('preserved server zero account cannot be committed without separate checkbox', async () => {
  const candidate = await example();
  const existingId = '11111111-1111-4111-8111-111111111111';
  const prepared = {
    ...candidate,
    preservedZeroAccountId: existingId,
    preservedZeroAccountName: 'Synthetic zero',
    payload: {
      ...candidate.payload,
      manifest: {
        ...candidate.payload.manifest,
        preserve_zero_account_id: existingId,
        confirm_preserve_zero_account: true,
      },
    },
  };
  let requests = 0;
  const run = (changes = {}, fetchImpl = async () => {
    requests++;
    throw Error('Unexpected HTTP');
  }) => executeConfirmedPersonalImportCandidate({
    prepared, verifiedActorUserId: USER,
    currentLocalSnapshotMatches: true, explicitFinalConsent: true,
    explicitPreserveZeroAccountConsent: false,
    signal: req(), fetchImpl, ...changes,
  });
  await assert.rejects(run(), /IMPORT_HOLD:/);
  assert.equal(requests, 0);
  await assert.rejects(run({
    explicitPreserveZeroAccountConsent: true,
    prepared: {...prepared, payload: {...prepared.payload, manifest: {
      ...prepared.payload.manifest, confirm_preserve_zero_account: false,
    }}},
  }), /IMPORT_HOLD:/);
  assert.equal(requests, 0);

  const responses = [
    reply({status:'UNVERIFIED_MANIFEST_STAGED', batch_id:BATCH,
      record_count:prepared.preview.recordCount, financial_write:false},202),
    reply({status:'COMMITTED',batch_id:BATCH,revision:1,
      record_count:prepared.preview.recordCount,
      source_sha256:prepared.preview.sourceSha256,
      source_original_preserved:true,cash_postings_created:0},201),
    reply(JSON.parse(prepared.payload.source_canonical_json)),
  ];
  const result = await run({
    explicitPreserveZeroAccountConsent: true,
  }, async (url, options) => {
    requests++;
    assert.equal(options.credentials, 'same-origin');
    return responses.shift();
  });
  assert.equal(requests, 3);
  assert.equal(result.status, 'COMMITTED_AND_SOURCE_RESTORED');
  assert.equal(result.serverZeroAccountPreserved, true);
});


test('planner merge confirms actual readback, all projected fields and existing server data', async () => {
  const account = {id:'11111111-1111-4111-8111-111111111111',kind:'account',entity_revision:1,
    data:{name:'Existing synthetic account',type:'bank',currency:'RUB',
      opening_minor:500,balance_minor:500,reserved_minor:0,available_minor:500,archived_at:null}};
  const row={id:'synthetic-one',title:'Safe imported expense',kind:'expense',
    amountCents:12345,date:'2026-11-01',recurrence:'once'};
  const added={id:'22222222-2222-4222-8222-222222222222',kind:'obligation',entity_revision:1,
    data:{title:row.title,direction:'expense',amount_minor:12345,starts_on:row.date,
      timezone:'UTC',recurrence_unit:'none',recurrence_every:1,category:null,deleted_at:null}};
  const addCounts={entries:1,loans:0,settlements:0,loanPayments:0};
  const linkCounts={entries:0,loans:0,settlements:0,loanPayments:0};
  const original='{"synthetic":"source-original"}';
  const prepared={
    actor:USER,origin:ORIGIN,profileId:PROFILE,etag:ETAG,revision:3,
    preview:{status:'MERGE_PREVIEW_ONLY',sourceSha256:'c'.repeat(64),recordCount:1},
    snapshot:{entries:[row],loans:[],settlements:[],loanPayments:[]},
    serverEntities:[account],mergeCounts:{add:addCounts,link:linkCounts},
    payload:{manifest:{schema_version:2,explicit_guest_transfer:false,
      rows:[{record_type:'entries',source_record_id:row.id,decision:'add'}]},
      source_canonical_json:original},
  };
  const commit={status:'COMMITTED',batch_id:BATCH,revision:4,record_count:1,
    source_sha256:prepared.preview.sourceSha256,source_original_preserved:true,
    cash_postings_created:0,created_counts:addCounts,linked_counts:linkCounts};
  const testResponse=async changed=>{
    const entities=changed?[account,{...added,data:{...added.data,amount_minor:12346}}]:[account,added];
    const replies=[
      reply(commit,201),
      new Response(original,{status:200,headers:{'Content-Type':'application/json'}}),
      new Response(JSON.stringify({schema_version:1,profile_id:PROFILE,revision:4,currency:'RUB',
        entities}),{status:200,headers:{ETag:'"fh.1.4.synthetic"','Content-Type':'application/json'}}),
    ];
    const paths=[];
    const run=executeConfirmedPersonalImportCandidate({
      prepared,verifiedActorUserId:USER,currentLocalSnapshotMatches:true,
      explicitFinalConsent:true,fetchImpl:async url=>{
        paths.push(new URL(url).pathname);
        return replies.shift();
      },signal:req(),
    });
    if(changed)await assert.rejects(run,/IMPORT_HOLD:/);
    else assert.equal((await run).status,'COMMITTED_AND_SOURCE_RESTORED');
    assert.deepEqual(paths,[
      '/api/finance/v1/import/commit','/api/finance/v1/import/restore','/api/finance/v1/state',
    ]);
  };
  await testResponse(false);
  await testResponse(true);
});
