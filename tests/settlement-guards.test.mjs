import {test} from 'node:test';
import assert from 'node:assert/strict';
import {emptyState, getMonthEvents} from '../finance.js';
import {applySettlement} from '../ledger-operations.js';

function fixture(recurrence='monthly',date='2024-01-31') {
 const state=emptyState();
 state.entries.push({id:'expense',title:'Расход',kind:'expense',amountCents:1000000,date,recurrence});
 let next=0;
 return {state,options:{idFactory:()=>String(++next),now:()=> '2024-03-01T12:00:00.000Z'}};
}

test('partial tranches accumulate in their occurrence, independent of actual payment date',()=>{
 const {state,options}=fixture();
 const pay=(amountCents,date)=>applySettlement(state,{entryId:'expense',occurrence:'2024-02',date,amountCents},options);
 pay(300000,'2024-01-20'); pay(250000,'2024-03-02');
 assert.equal(getMonthEvents(state,'2024-02')[0].paidCents,550000);
 assert.equal(getMonthEvents(state,'2024-03')[0].paidCents,0);
 pay(450000,'2024-03-04');
 assert.equal(getMonthEvents(state,'2024-02')[0].paidCents,1000000);
 const before=structuredClone(state);
 assert.throws(()=>pay(1,'2024-03-05'),/превышает остаток/);
 assert.deepEqual(state,before);
});

test('minor unit boundaries, malformed amounts and dates fail without mutations',()=>{
 const {state,options}=fixture();
 for(const amountCents of [0,-1,1.1,NaN,Infinity,Number.MAX_SAFE_INTEGER]) {
  const before=structuredClone(state);
  assert.throws(()=>applySettlement(state,{entryId:'expense',occurrence:'2024-02',date:'2024-02-29',amountCents},options));
  assert.deepEqual(state,before);
 }
 assert.throws(()=>applySettlement(state,{entryId:'expense',occurrence:'2024-02',date:'2023-02-29',amountCents:1},options));
 applySettlement(state,{entryId:'expense',occurrence:'2024-02',date:'2024-02-29',amountCents:1},options);
 assert.equal(getMonthEvents(state,'2024-02')[0].paidCents,1);
});

test('new payments require a valid occurrence and edits cannot change identity',()=>{
 const {state,options}=fixture('yearly','2024-02-29');
 const apply=(occurrence,date='2024-02-29')=>applySettlement(state,{entryId:'expense',occurrence,date,amountCents:1},options);
 for(const month of ['2024-00','2024-13','2023-02','2024-03','2024-02x'])assert.throws(()=>apply(month));
 const id=apply('2024-02');
 apply('2025-02','2025-03-01');
 assert.equal(getMonthEvents(state,'2025-02')[0].date,'2025-02-28');
 assert.throws(()=>applySettlement(state,{id,entryId:'expense',occurrence:'2025-02',date:'2025-03-01',amountCents:1},options));
 assert.equal(state.settlements[0].occurrence,'2024-02');
});

test('correction respects other payments and cancellation restores the available balance',()=>{
 const {state,options}=fixture('once','2024-12-31');
 const base={entryId:'expense',occurrence:'2024-12',date:'2025-01-02'};
 const id=applySettlement(state,{...base,amountCents:400000},options);
 applySettlement(state,{...base,amountCents:500000},options);
 assert.throws(()=>applySettlement(state,{...base,id,amountCents:500001},options));
 applySettlement(state,{...base,id,amountCents:300000},options);
 assert.equal(getMonthEvents(state,'2024-12')[0].paidCents,800000);
 state.settlements[1].voidedAt='2025-01-03T12:00:00.000Z';
 assert.equal(getMonthEvents(state,'2024-12')[0].paidCents,300000);
 applySettlement(state,{...base,amountCents:700000},options);
 assert.equal(getMonthEvents(state,'2024-12')[0].paidCents,1000000);
});
