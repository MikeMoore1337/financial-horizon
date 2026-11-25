import test from 'node:test';
import assert from 'node:assert/strict';
import {projectServerPaymentPlanner} from '../src/react/reserves-finance-gateway.ts';
import {getMonthEvents} from '../finance.js';

const id='22222222-2222-4222-8222-222222222222';
const fact='33333333-3333-4333-8333-333333333333';
const obligation={id,kind:'obligation',entity_revision:1,data:{title:'Хостинг',
  direction:'expense',amount_minor:10001,starts_on:'2024-01-31',
  recurrence_unit:'month',recurrence_every:2,category:null,deleted_at:null}};
const payment={id:fact,kind:'settlement',entity_revision:1,data:{obligation_id:id,
  occurrence_on:'2024-03-01',paid_on:'2024-04-15',amount_minor:3000,voided_at:null}};

test('server projection keeps occurrence and actual payment separate without touching local ledger',()=>{
  const source=[obligation,payment];const before=structuredClone(source);
  const state=projectServerPaymentPlanner(source);
  assert.deepEqual(source,before);
  assert.equal(getMonthEvents(state,'2024-02').length,0);
  const [march]=getMonthEvents(state,'2024-03');
  assert.equal(march.date,'2024-03-31');
  assert.equal(march.paidCents,3000);
  assert.equal(getMonthEvents(state,'2024-05')[0].paidCents,0);
  assert.equal(state.settlements[0].date,'2024-04-15');
});

test('server payment projection rejects missing parents, unknown periods, and invalid amounts',()=>{
  assert.throws(()=>projectServerPaymentPlanner([payment]));
  assert.throws(()=>projectServerPaymentPlanner([obligation,{...payment,data:{...payment.data,amount_minor:-1}}]));
  assert.throws(()=>projectServerPaymentPlanner([{...obligation,data:{...obligation.data,recurrence_every:0}}]));
  assert.throws(()=>projectServerPaymentPlanner([obligation,{...payment,data:{...payment.data,occurrence_on:'2024-02-30'}}]));
});

test('server projection preserves every-second-year schedule and ignores voided payments',()=>{
  const annual={...obligation,data:{...obligation.data,starts_on:'2024-02-29',
    recurrence_unit:'year',recurrence_every:2}};
  const voided={...payment,data:{...payment.data,occurrence_on:'2024-02-01',
    voided_at:'2024-03-01T00:00:00Z'}};
  const projected=projectServerPaymentPlanner([annual,voided]);
  assert.equal(getMonthEvents(projected,'2025-02').length,0);
  assert.equal(getMonthEvents(projected,'2026-02')[0].date,'2026-02-28');
  assert.equal(getMonthEvents(projected,'2024-02')[0].paidCents,0);
});
