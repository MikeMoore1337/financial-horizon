import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyState,validateState} from '../finance.js';
import {reconcileBankStatement} from '../src/importers/bank-statements/reconcile.ts';
import {
  emptyGuestBankLedger,readGuestBankLedger,guestBankMovements,guestBankBalance,
  addGuestBankAccount,commitGuestBankBatch,undoGuestBankBatch,
} from '../src/importers/bank-statements/guest-ledger.js';

const accountId='11111111-1111-4111-8111-111111111111';
const secondId='22222222-2222-4222-8222-222222222222';
const hash=s=>s.repeat(64);
function opened(){
  const s=emptyState();
  addGuestBankAccount(s,{id:accountId,name:'Тестовый',openingMinor:20000},0);
  s.revision++;
  addGuestBankAccount(s,{id:secondId,name:'Второй',openingMinor:0},1);
  s.revision++;
  return s;
}
function confirmed(ops=[{sourceKey:hash('a'),fingerprint:hash('b'),externalId:'SYN-1',
  date:'2026-11-07',amountCents:500,kind:'expense',description:'Синтетика',
  accountId,targetAccountId:null,category:null}]){
  return {batchKey:hash('c'),sourceKeys:ops.map(x=>x.sourceKey),operations:ops,expectedOperationCount:ops.length};
}
test('guest bank ledger starts empty, distinct from planner and accepts old backups',()=>{
  const s=emptyState();
  assert.equal(s.bankStatements,undefined);
  assert.deepEqual(readGuestBankLedger(s),emptyGuestBankLedger());
  assert.equal(validateState(s),s);
});
test('guest batch commit and whole undo preserve immutable financial facts',()=>{
  const s=opened();
  const plan=confirmed([
    {sourceKey:hash('a'),fingerprint:hash('b'),externalId:'SYN-1',
     date:'2026-11-07',amountCents:500,kind:'expense',description:'Покупка',
     accountId,targetAccountId:null,category:null},
    {sourceKey:hash('d'),fingerprint:hash('e'),externalId:'SYN-2',
     date:'2026-11-08',amountCents:300,kind:'transfer',description:'Перевод',
     accountId,targetAccountId:secondId,category:null},
  ]);
  commitGuestBankBatch(s,plan,hash('f'),2);s.revision++;
  assert.equal(guestBankBalance(s.bankStatements,accountId),19200);
  assert.equal(guestBankBalance(s.bankStatements,secondId),300);
  assert.equal(guestBankMovements(s.bankStatements).length,2);
  assert.throws(()=>commitGuestBankBatch(s,plan,hash('f'),3),/учтена/);
  undoGuestBankBatch(s,plan.batchKey,3);s.revision++;
  assert.equal(guestBankBalance(s.bankStatements,accountId),20000);
  assert.equal(guestBankBalance(s.bankStatements,secondId),0);
  assert.equal(s.bankStatements.operations.length,2);
  const cancelled = guestBankMovements(s.bankStatements);
  assert.ok(cancelled.every(x=>x.voidedAt));
  const reread = {
    fileDigest: hash('f'), mapping: {}, warnings: [], accepted: 2,
    rejected: 0, inflowCents: 0, outflowCents: 0, transfersCents: 0,
    rows: plan.operations.map((op,i)=>({rowNumber:i+2,operation:op,warnings:[]})),
  };
  // A compensated batch remains an immutable imported-source identity.
  // The user must not be invited to post the same bank file again.
  const status=reconcileBankStatement(reread,cancelled);
  assert.equal(status.duplicates,2);
  assert.equal(status.ready,0);
  assert.throws(()=>undoGuestBankBatch(s,plan.batchKey,4),/недоступна/);
  assert.deepEqual(validateState(structuredClone(s)),s);
});
test('guest validation rejects corrupted backups, same source bank ID and bad sums',()=>{
  const s=opened();
  const plan=confirmed();
  commitGuestBankBatch(s,plan,hash('d'),2);s.revision++;
  for(const update of [
    data=>{data.operations[0].amountCents=0;},
    data=>{data.operations.push({...data.operations[0]});data.batches[0].operationCount=2;},
    data=>{data.batches[0].operationCount=900;},
    data=>{data.operations[0].accountId='wrong';},
  ]){
    const bad=structuredClone(s);update(bad.bankStatements);
    assert.throws(()=>validateState(bad));
  }
  assert.throws(()=>commitGuestBankBatch(s,confirmed([{...plan.operations[0],sourceKey:hash('f')}]),hash('e'),3));
});
test('guest unpaid prior planner fact refuses matching bank debit',()=>{
  const s=opened();s.loanPayments.push({id:'historic',loanId:'loan',date:'2026-11-07',
     amountCents:500,strategy:'term',createdAt:'2026-11-07T08:00:00.000Z'});
  const before=structuredClone(s);
  assert.throws(()=>commitGuestBankBatch(s,confirmed(),hash('f'),2),/совпадает/);
  assert.deepEqual(s,before);
});
test('guest stale state or concurrent edit refuses undo atomically',()=>{
 const s=opened(),plan=confirmed();
 commitGuestBankBatch(s,plan,hash('f'),2);s.revision++;
 s.revision++;
 const prev=structuredClone(s);
 assert.throws(()=>undoGuestBankBatch(s,plan.batchKey,4),/после импорта/);
 assert.deepEqual(s,prev);
 assert.throws(()=>commitGuestBankBatch(s,confirmed([{...plan.operations[0],sourceKey:hash('e')}]),hash('f'),3),/изменилась/);
});
