import test from 'node:test';
import assert from 'node:assert/strict';
import {downloadVerifiedFinanceSnapshotCandidate} from
  '../src/cloud/authenticated-snapshot-pull-candidate.mjs';

const origin='https://fin-horizon.mikemoore.top';
const scope='account:'+'a'.repeat(32);
const profileId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function identity() {
  const controller=new AbortController();
  return {
    scope, profileId, generation:1, epoch:'e'.repeat(32),
    signal:controller.signal, controller,
  };
}
function base(id=identity()) {
  return {
    scope, identity:id,
    session:{
      state:'unlocked', selectedScope:scope, lifecycleVersion:id.generation,
      lifecycleSignal:id.signal,
    },
    origin, explicitReadConsent:true,
  };
}
function body(revision=0,entities=[],next_cursor=null) {
  return {schema_version:1,profile_id:profileId,currency:'RUB',
    revision,entities,next_cursor};
}
function reply(data,status=200,etag='"fh.1.0.verified"') {
  return new Response(JSON.stringify(data),{
    status, headers:{'Content-Type':'application/json','ETag':etag},
  });
}
const accountId='11111111-1111-4111-8111-111111111111';
const account={
  id:accountId,kind:'account',entity_revision:1,
  data:{name:'Synthetic zero',type:'bank',currency:'RUB',opening_minor:0,
    balance_minor:0,reserved_minor:0,available_minor:0,archived_at:null},
};

test('one complete FH finance page verifies strong ETag without local writes',async()=>{
  const calls=[];
  const result=await downloadVerifiedFinanceSnapshotCandidate({
    ...base(),
    fetchImpl:async(url,options)=>{
      calls.push({url,options});
      return reply(body());
    },
  });
  assert.equal(result.status,'VERIFIED_READ_ONLY');
  assert.equal(result.entityCount,0);
  assert.equal(result.serverRevision,0);
  assert.equal(result.etag,'"fh.1.0.verified"');
  assert.equal(result.sentCommands,0);
  assert.equal(result.cacheModified,false);
  assert.equal(result.cloudFeatureEnabled,false);
  assert.equal(calls.length,1);
  assert.equal(new URL(calls[0].url).pathname,'/api/finance/v1/state');
  assert.equal(new URL(calls[0].url).searchParams.get('limit_entities'),'5000');
  assert.equal(calls[0].options.method,'GET');
  assert.equal(calls[0].options.credentials,'same-origin');
  assert.equal(calls[0].options.cache,'no-store');
  assert.equal(calls[0].options.redirect,'error');
  assert.equal(calls[0].options.mode,'same-origin');
});

test('two HTTP 206/200 pages require exact cursor, revision and strong ETag',async()=>{
  const next='1:account:'+accountId;
  const responses=[reply(body(1,[account],next),206,'"fh.1.1.verified"'),
    reply(body(1,[],null),200,'"fh.1.1.verified"')];
  const seen=[];
  const result=await downloadVerifiedFinanceSnapshotCandidate({
    ...base(), fetchImpl:async(url)=>{
      seen.push(new URL(url).searchParams.get('cursor'));
      return responses.shift();
    },
  });
  assert.deepEqual(seen,[null,next]);
  assert.equal(result.pages.length,2);
  assert.equal(result.entityCount,1);
  assert.equal(result.serverRevision,1);
  assert.equal(result.profileId,profileId);
});

test('no explicit consent, wrong identity and stale unlock forbid all network',async()=>{
  let calls=0;
  const fetchImpl=async()=>{calls++;throw Error('No requests allowed');};
  await assert.rejects(downloadVerifiedFinanceSnapshotCandidate({
    ...base(), explicitReadConsent:false, fetchImpl,
  }),/SYNC_HOLD/);
  const id=identity();id.controller.abort();
  await assert.rejects(downloadVerifiedFinanceSnapshotCandidate({
    ...base(id),fetchImpl,
  }),/SYNC_HOLD/);
  await assert.rejects(downloadVerifiedFinanceSnapshotCandidate({
    ...base(),origin:'https://other.invalid',fetchImpl,
  }),/No requests allowed|SYNC_HOLD/);
  assert.equal(calls,0);
});

test('unknown finance status, weak or changing ETag and dishonest pagination fail closed',async()=>{
  for(const steps of [
    [reply({code:'unauthenticated'},401)],
    [reply(body(),200,'W/"fh.1.0.verified"')],
    [reply(body(1,[account],'1:account:'+accountId),206,'"strong-first"'),
     reply(body(1,[],null),200,'"strong-second"')],
    [reply(body(1,[],null),206)],
    [reply(body(1,[account],'1:account:'+accountId),200)],
    [reply(body(1,[account],'1:account:'+accountId),206),
     reply(body(2,[],null),200)],
    [new Response(JSON.stringify(body()),{status:200,headers:{
      'Content-Type':'application/json','ETag':'"strong"',
      'Content-Length':'99999999',
    }})],
  ]){
    let count=0;
    await assert.rejects(downloadVerifiedFinanceSnapshotCandidate({
      ...base(), fetchImpl:async()=>steps[count++],
    }),/SYNC_HOLD/);
    assert.ok(count>=1 && count<=steps.length);
  }
});
