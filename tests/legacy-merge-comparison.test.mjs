import test from 'node:test';
import assert from 'node:assert/strict';
import {compareLegacyWithServer} from '../src/cloud/legacy-merge-comparison.mjs';

test('similarity finds candidates without deciding that either record is a duplicate', () => {
  const source = {entries:[
    {id:'local-1',title:'Тест',kind:'expense',amountCents:200,date:'2026-01-01'},
    {id:'local-2',title:'Другой',kind:'expense',amountCents:200,date:'2026-01-01'},
  ],loans:[],settlements:[],loanPayments:[]};
  const entities = [
    {id:'remote-1',kind:'obligation',data:{title:'тест',direction:'expense',amount_minor:300,starts_on:'2026-02-01'}},
    {id:'remote-2',kind:'obligation',data:{title:'Независимый',direction:'expense',amount_minor:200,starts_on:'2026-01-01'}},
    {id:'remote-3',kind:'reserve',data:{title:'Тест'}},
  ];
  const before = structuredClone({source,entities});
  const result = compareLegacyWithServer(source,entities);
  assert.equal(result.status,'NEEDS_OWNER_DECISIONS');
  assert.deepEqual(result.groups.entries.local,[
    {sourceId:'local-1',candidateIds:['remote-1','remote-2']},
    {sourceId:'local-2',candidateIds:['remote-2']},
  ]);
  assert.deepEqual(result.groups.entries.serverIds,['remote-1','remote-2']);
  assert.equal(result.candidatePairs,3);
  assert.deepEqual({source,entities},before);
});

test('historical facts compare by date and amount without guessing their parent', () => {
  const source={entries:[],loans:[],settlements:[{id:'s',entryId:'entry',amountCents:50,date:'2026-03-02'}],
    loanPayments:[{id:'p',loanId:'loan',amountCents:90,date:'2026-03-03'}]};
  const entities=[
    {id:'s1',kind:'settlement',data:{obligation_id:'unknown',amount_minor:50,paid_on:'2026-03-02'}},
    {id:'s2',kind:'settlement',data:{obligation_id:'different',amount_minor:50,paid_on:'2026-03-02'}},
    {id:'p1',kind:'loan_payment',data:{loan_id:'unknown',amount_minor:90,paid_on:'2026-03-03'}},
  ];
  const result=compareLegacyWithServer(source,entities);
  assert.deepEqual(result.groups.settlements.local[0].candidateIds,['s1','s2']);
  assert.deepEqual(result.groups.loanPayments.local[0].candidateIds,['p1']);
});

test('large ambiguous comparisons fail closed instead of hiding candidate pairs', () => {
  const source={entries:Array.from({length:101},(_,i)=>({
    id:'local-'+i,title:'Same',kind:'expense',amountCents:1,date:'2026-01-01',
  })),loans:[],settlements:[],loanPayments:[]};
  const entities=Array.from({length:1000},(_,i)=>({
    id:'remote-'+i,kind:'obligation',data:{title:'Same',direction:'expense',
      amount_minor:1,starts_on:'2026-01-01'},
  }));
  assert.throws(()=>compareLegacyWithServer(source,entities),/Слишком много возможных совпадений/);
});
