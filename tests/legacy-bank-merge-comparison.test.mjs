import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyState} from '../finance.js';
import {addGuestBankAccount,commitGuestBankBatch,undoGuestBankBatch} from '../src/importers/bank-statements/guest-ledger.js';
import {compareGuestBankHistory} from '../src/cloud/legacy-bank-merge-comparison.mjs';

const hash=letter=>letter.repeat(64);
const localId='11111111-1111-4111-8111-111111111111';
const remoteId='22222222-2222-4222-8222-222222222222';
const txId='33333333-3333-4333-8333-333333333333';
const profile='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const tag='"synthetic-strong-etag"';
function fixture(){
 const state=emptyState();
 addGuestBankAccount(state,{id:localId,name:'Синтетический счёт',openingMinor:20000},0);state.revision++;
 const operation={sourceKey:hash('a'),fingerprint:hash('b'),externalId:'SYN-1',date:'2026-11-07',
  amountCents:500,kind:'expense',description:'Синтетическая покупка',accountId:localId,
  targetAccountId:null,category:null,currency:'RUB'};
 commitGuestBankBatch(state,{batchKey:hash('c'),sourceKeys:[operation.sourceKey],operations:[operation],expectedOperationCount:1},hash('d'),1);
 state.revision++;
 const snapshot={schema_version:1,profile_id:profile,revision:3,currency:'RUB',entities:[
  {kind:'account',id:remoteId,entity_revision:1,data:{name:'Синтетический счёт',currency:'RUB',
   opening_minor:20000,balance_minor:19500,reserved_minor:0,available_minor:19500}},
  {kind:'transaction',id:txId,entity_revision:2,data:{kind:'expense',occurred_on:operation.date,note:operation.description,
   postings:[{account_id:remoteId,signed_minor:-500}]}},
 ]};
 const bankHistory={schema_version:1,revision:3,rows:[{
  source_key:operation.sourceKey,fingerprint:operation.fingerprint,external_id:operation.externalId,
  account_id:remoteId,target_account_id:null,transaction_id:txId,kind:operation.kind,
  occurred_on:operation.date,amount_minor:500,description:operation.description,category:null,status:'committed',
 }]};
 return {state,snapshot,bankHistory};
}
const run=({state,snapshot,bankHistory},options={})=>compareGuestBankHistory({
 ledger:state.bankStatements,sourceRevision:state.revision,snapshot,bankHistory,snapshotEtag:tag,bankEtag:tag,...options,
});

test('guest bank comparison shows matching candidates without deciding or mutating records',()=>{
 const input=fixture(), before=structuredClone(input);
 const result=run(input);
 assert.equal(result.status,'NEEDS_OWNER_DECISIONS');
 assert.equal(result.revision,3);
 assert.deepEqual(result.sourceAccounts,[{sourceId:localId,openingMinor:20000,balanceMinor:19500,candidateIds:[remoteId]}]);
 assert.deepEqual(result.operations,[{sourceKey:hash('a'),status:'committed',identityConflict:false,candidateIds:[txId]}]);
 assert.deepEqual(input,before);
});

test('changed fingerprint or category is a conflict, never an automatic match',()=>{
 for(const change of [row=>{row.fingerprint=hash('e');},row=>{row.category='другое';}]){
  const input=fixture();change(input.bankHistory.rows[0]);
  assert.equal(run(input).operations[0].identityConflict,true);
 }
 const input=fixture();undoGuestBankBatch(input.state,hash('c'),2);input.state.revision++;
 assert.equal(run(input).sourceAccounts[0].balanceMinor,20000);
 assert.equal(run(input).operations[0].identityConflict,true);
});

test('cancelled history requires the exact compensating postings and stays a conflict for an active source',()=>{
 const input=fixture(), reversalId='44444444-4444-4444-8444-444444444444';
 input.bankHistory.rows[0].status='cancelled';
 assert.throws(()=>run(input),/IMPORT_HOLD/);
 input.snapshot.entities.push({kind:'transaction',id:reversalId,entity_revision:3,data:{kind:'reversal',
  reversed_transaction_id:txId,postings:[{account_id:remoteId,signed_minor:500}]}});
 assert.equal(run(input).operations[0].identityConflict,true);
 undoGuestBankBatch(input.state,hash('c'),2);input.state.revision++;
 assert.equal(run(input).operations[0].identityConflict,false);
 input.snapshot.entities[2].data.postings[0].signed_minor=499;
 assert.throws(()=>run(input),/IMPORT_HOLD/);
});

test('external identity without exact source key is only a candidate',()=>{
 const input=fixture();input.bankHistory.rows[0].source_key=hash('e');
 const row=run(input).operations[0];
 assert.deepEqual(row.candidateIds,[txId]);
 assert.equal(row.identityConflict,false);
});

test('stale, incomplete, or tampered server data fail closed',()=>{
 for(const modify of [
  x=>{x.snapshot.next_cursor='more';},x=>{x.bankHistory.revision++;},
  x=>{x.snapshot.entities[1].data.postings[0].signed_minor=500;},
  x=>{x.snapshot.entities[1].data.occurred_on='2026-02-31';x.bankHistory.rows[0].occurred_on='2026-02-31';},
  x=>{x.bankHistory.rows[0].description='несовпадающее описание';},
  x=>{x.snapshot.entities.pop();},x=>{x.bankHistory.rows.push(structuredClone(x.bankHistory.rows[0]));},
  x=>{x.state.bankStatements.operations[0].amountCents=0;},
  x=>{x.state.bankStatements.batches[0].committedStateRevision=x.state.revision+1;},
 ]){
  const input=fixture();modify(input);
  assert.throws(()=>run(input),/IMPORT_HOLD/);
 }
 const input=fixture();
 assert.throws(()=>run(input,{bankEtag:'"changed"'}),/IMPORT_HOLD/);
 assert.throws(()=>run(input,{snapshotEtag:'W/"weak"',bankEtag:'W/"weak"'}),/IMPORT_HOLD/);
});
