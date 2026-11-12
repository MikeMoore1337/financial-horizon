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
