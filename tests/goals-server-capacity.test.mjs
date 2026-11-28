import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoal, applyGoalEvent } from '../src/domain/goals/index.ts';
import { reconcileGoalsWithFinanceSnapshot as reconcile } from '../src/domain/goals/server-capacity.ts';
const P='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', USER='a'.repeat(32);
const id=n=>'b0000000-0000-4000-8000-'+String(n).padStart(12,'0');
const [A,B,R,T,E,V]=[1,2,3,4,5,6].map(id), DAY='2026-11-11';
const account=(id,opening,balance,reserve=0)=>({id,kind:'account',entity_revision:1,
  data:{name:'Счёт',type:'bank',currency:'RUB',opening_minor:opening,balance_minor:balance,
    reserved_minor:reserve,available_minor:balance-reserve,archived_at:null}});
const tx=(id,kind,postings,reversed=null)=>({id,kind:'transaction',entity_revision:1,
  data:{kind,occurred_on:DAY,note:null,reversed_transaction_id:reversed,
    postings:postings.map(([account_id,signed_minor])=>({account_id,signed_minor}))}});
const raw=()=>({schema_version:1,profile_id:P,currency:'RUB',revision:7,
  entities:[account(A,100000,90000,20000),account(B,100000,107000),
    {id:R,kind:'reserve',entity_revision:1,data:{allocated_minor:20000,
      allocations_by_account:[{account_id:A,allocated_minor:20000}]}},
    tx(T,'transfer',[[A,-10000],[B,10000]]),tx(E,'expense',[[B,-3000]])]});
const goal=()=>applyGoalEvent(applyGoalEvent(createGoal({id:'g',eventId:'create',title:'Цель',
  on:'2026-11-01',targetCents:12000000,targetDate:'2027-11-01'}),
  {id:'deposit',type:'contribution',on:DAY,amountCents:10000,funding:'account-transfer',ledgerMovementId:T}),
  {id:'spend',type:'use',on:DAY,amountCents:3000,usage:'expense',ledgerMovementId:E});
const snapshot=(g=goal())=>({schema:'financial-horizon-goals',version:1,scopeKey:P,revision:7,goals:[g]});
const check=(r=raw(),s=snapshot(),accountId=B)=>reconcile(r,P,USER,s,[{goalId:'g',accountId}],DAY);
test('confirmed transfer and purchase are reconciled without posting cash twice',()=>{
  const r=raw(),s=snapshot(),before=JSON.stringify([r,s]);
  const result=check(r,s);
  assert.equal(result.postedBankCents,0);
  assert.deepEqual(result.accounts.map(a=>[a.balanceCents,a.mandatoryReserveCents,a.voluntaryGoalCents,a.availableCents]),
    [[90000,20000,0,70000],[107000,0,7000,100000]]);
  assert.equal(JSON.stringify([r,s]),before);
});
test('reject wrong revision, profile, incomplete page and reserve breakdown',()=>{
  assert.throws(()=>check(raw(),{...snapshot(),revision:6}),/revision/);
  assert.throws(()=>check(raw(),{...snapshot(),scopeKey:'other'}),/scope/);
  assert.throws(()=>check({...raw(),next_cursor:'more'}));
  const r=raw();r.entities[2].data.allocations_by_account[0].allocated_minor=19000;
  assert.throws(()=>check(r),/Reserve total/);
});
test('reject wrong amount, wrong account direction, wrong date and #6 link reuse',()=>{
  const s=snapshot();s.goals[0].events[1].amountCents=11000;
  assert.throws(()=>check(raw(),s),/amount or direction/);
  assert.throws(()=>check(raw(),snapshot(),A),/amount or direction/);
  const dated=raw();dated.entities[3].data.occurred_on='2026-11-10';
  assert.throws(()=>check(dated),/wrong-date/);
  const reserved=raw();reserved.entities[4].data.reserve_allocation={id:R};
  assert.throws(()=>check(reserved),/mandatory-reserve/);
});
test('a reversed expense requires exactly the matching goal correction',()=>{
  const r=raw();r.entities[1]=account(B,100000,110000);
  r.entities.push(tx(V,'reversal',[[B,3000]],E));
  assert.throws(()=>check(r),/matching goal correction/);
  const s=snapshot(applyGoalEvent(goal(),{id:'undo',type:'void',on:DAY,
    eventId:'spend',reason:'Ошибка',ledgerReversalId:V}));
  const result=check(r,s);
  assert.equal(result.accounts[1].voluntaryGoalCents,10000);
  assert.equal(result.accounts[1].availableCents,100000);
});
