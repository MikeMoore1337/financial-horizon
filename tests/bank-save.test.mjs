import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BankCommitError, buildBankCommitRequest, buildBankUndoRequest,
  commitConfirmedBankBatch, undoConfirmedBankBatch,
} from '../src/importers/bank-statements/save.ts';
import { draftBankImportBatch } from '../src/importers/bank-statements/reconcile.ts';

const hash = c => c.repeat(64);
const account = '11111111-1111-4111-8111-111111111111';
const movement = '22222222-2222-4222-8222-222222222222';
const mutation = '33333333-3333-4333-8333-333333333333';
const confirmedBatch = '44444444-4444-4444-8444-444444444444';
const op = {
  sourceRow:2,sourceKey:hash('a'),fingerprint:hash('b'),externalId:'SYNT-1',
  date:'2026-11-07',amountCents:1250,kind:'expense',
  description:'Синтетическая покупка',accountId:account,
  targetAccountId:null,category:null,currency:'RUB',
};
const plan = {batchKey:hash('c'),sourceKeys:[op.sourceKey],operations:[op],
              expectedOperationCount:1,journal:[]};
const row = {rowNumber:2,operation:op,warnings:[],status:'possible-duplicate',existingIds:[movement]};
const reconciled = {rows:[row],ready:0,duplicates:0,possibleDuplicates:1,invalid:0};
const context = {revision:7,etag:'"safe-server-etag"',clientMutationId:mutation,
                 accountEntityRevisions:{[account]:1}};
const body = () => buildBankCommitRequest(plan,reconciled,hash('d'),context);

test('confirmed request contains only normalized financial fields and reviewed server IDs', () => {
  const result=body();
  assert.equal(result.client_mutation_id,mutation);
  assert.equal(result.base_revision,7);
  assert.deepEqual(result.expected_account_revisions,{[account]:1});
  assert.deepEqual(result.operations[0].reviewed_transaction_ids,[movement]);
  assert.equal(result.operations[0].amount_minor,1250);
  assert.ok(!('filename' in result) && !('csv' in result) && !('rawFile' in result));
  assert.throws(() => buildBankCommitRequest(
    plan,reconciled,hash('d'),{...context,accountEntityRevisions:{}}
  ),BankCommitError);
});

test('real frozen draftBankImportBatch is accepted despite deliberate operation cloning', async () => {
  const frozen = await draftBankImportBatch(reconciled, [op.sourceKey], [op.sourceKey]);
  assert.notEqual(frozen.operations[0], op);
  assert.ok(Object.isFrozen(frozen.operations[0]));
  const valid = buildBankCommitRequest(frozen, reconciled, hash('d'), context);
  assert.equal(valid.operations[0].amount_minor, 1250);
  assert.deepEqual(valid.operations[0].reviewed_transaction_ids, [movement]);
  const altered = { ...frozen, operations: [{ ...frozen.operations[0], description: 'Different' }] };
  assert.throws(() => buildBankCommitRequest(altered, reconciled, hash('d'), context),
    BankCommitError);
});

test('no unapproved, modified or non-UUID possible duplicates are committed', () => {
  assert.throws(() => buildBankCommitRequest(plan,{
    ...reconciled,rows:[{...row,status:'duplicate'}]
  },hash('d'),context),BankCommitError);
  assert.throws(() => buildBankCommitRequest(plan,{
    ...reconciled,rows:[{...row,existingIds:['local-unsafe-id']}]
  },hash('d'),context),BankCommitError);
  assert.throws(() => buildBankCommitRequest(plan,{
    ...reconciled,rows:[{...row,operation:{...op,description:'Изменено'}}]
  },hash('d'),context),BankCommitError);
  assert.throws(() => buildBankCommitRequest(plan,reconciled,hash('e'),{
    ...context,etag:'W/"weak"'
  }),BankCommitError);
});

test('exact server ack is needed; failed writes never masquerade as a receipt', async () => {
  const request=body();
  let sent;
  const fake=async (url,options)=>{
    sent={url,options};
    return new Response(JSON.stringify({
      status:'COMMITTED',batch_id:confirmedBatch,revision:8,
      new_operations:1,replayed:false,
    }),{status:201,headers:{ETag:'"new-strong-etag"'}});
  };
  const success=await commitConfirmedBankBatch(request,context.etag,fake);
  assert.equal(success.revision,8);
  assert.equal(sent.url,'/api/finance/v2/bank-import/commit');
  assert.equal(sent.options.credentials,'same-origin');
  assert.equal(sent.options.redirect,'error');
  assert.equal(JSON.parse(sent.options.body).file_digest,hash('d'));
  assert.equal(sent.options.headers['Idempotency-Key'],mutation);
  await assert.rejects(commitConfirmedBankBatch(request,context.etag,async()=>new Response(
    JSON.stringify({status:'COMMITTED',batch_id:confirmedBatch,revision:8,
                    new_operations:0,replayed:false}),
    {status:201,headers:{ETag:'"new-strong-etag"'}})),BankCommitError);
  await assert.rejects(commitConfirmedBankBatch(request,context.etag,async()=>{throw Error('offline')}),
    error => error.code==='ambiguous_commit');
  await assert.rejects(commitConfirmedBankBatch(request,context.etag,async()=>new Response(
    JSON.stringify({code:'stale_revision'}),{status:412})),error => error.status===412);
});

test('whole-batch cancel transmits only batch identity and reason', async () => {
  const undo=buildBankUndoRequest(hash('c'),'Синтетическая отмена',context);
  let sent;
  const ack=await undoConfirmedBankBatch(undo,context.etag,async (_url,init)=>{
    sent=JSON.parse(init.body);
    return new Response(JSON.stringify({
      status:'CANCELLED',batch_id:confirmedBatch,revision:8,
      new_operations:0,reversed_operations:1,replayed:false,
    }),{status:201,headers:{ETag:'"cancelled-strong"'}});
  });
  assert.equal(ack.status,'CANCELLED');
  assert.deepEqual(Object.keys(sent).sort(),[
    'base_revision','batch_key','client_mutation_id','reason','schema_version',
  ].sort());
});
