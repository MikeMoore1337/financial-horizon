import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeReserveV2 } from '../src/domain/reserves/v2-wire.ts';

const idA='11111111-1111-4111-8111-111111111111';
const idB='22222222-2222-4222-8222-222222222222';
const idC='33333333-3333-4333-8333-333333333333';
const idD='44444444-4444-4444-8444-444444444444';
const mutation='55555555-5555-4555-8555-555555555555';
const original = {
  action: 'reserve.create',
  payload: {
    id: idC, account_id: idA, obligation_id: idB,
    title: 'Страховка', target_minor: 120000,
    opened_on: '2026-11-16', first_due_on: '2027-11-16',
    period_months: 12, due_day: 16, contribution_mode: 'auto',
    opening_reserved_minor: 12000,
  },
  clientMutationId: mutation,
  baseRevision: 3,
  ifMatch: '"strong.etag.received.from.server"',
  expectedEntityRevisions: { [idA]: 2, [idB]: 1 },
};

test('reserve create encodes strict v2 envelope without client profile, cookies or cash debit', () => {
  const encoded=encodeReserveV2(original);
  assert.equal(encoded.path,'/api/finance/v2/commands');
  assert.deepEqual(encoded.headers,{
    'Content-Type':'application/json',
    'If-Match':original.ifMatch,
    'Idempotency-Key':mutation,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(encoded.body)),{
    schema_version:2,
    client_mutation_id:mutation,
    base_revision:3,
    action:'reserve.create',
    expected_entity_revisions:{[idA]:2,[idB]:1},
    payload:original.payload,
  });
  assert.deepEqual(encodeReserveV2(original),encoded);
  assert.ok(!('actor_id' in encoded.body));
  assert.ok(!('profile_id' in encoded.body));
});
test('reserve ETag, idempotency and entity revision gates fail closed', () => {
  const invalid = [
    {ifMatch:'W/"weak"'},
    {ifMatch:'*'},
    {clientMutationId:'not-uuid'},
    {baseRevision:1.4},
    {expectedEntityRevisions:{[idA]:1}},
    {expectedEntityRevisions:{[idA]:1,[idB]:1,[idD]:3}},
    {expectedEntityRevisions:{[idA]:0,[idB]:1}},
    {payload:{...original.payload,target_minor:0}},
    {payload:{...original.payload,period_months:61}},
    {payload:{...original.payload,contribution_mode:'fixed'}},
    {payload:{...original.payload,unexpected:'secret'}},
    {payload:{...original.payload,first_due_on:'2028-12-16'}},
    {payload:{...original.payload,first_due_on:'2027-11-15'}},
  ];
  for(const variant of invalid) assert.throws(()=>encodeReserveV2({...original,...variant}));
});
test('linked payment requires explicit reserve, account, obligation and exact amount', () => {
  const p={account_id:idA,obligation_id:idB,reserve_id:idC,
    amount_minor:6000,reserved_used_minor:3000,paid_on:'2027-11-16',occurrence_on:'2027-11-16'};
  const command={...original,action:'settlement.payment.record',payload:p,
    expectedEntityRevisions:{[idA]:3,[idB]:1,[idC]:5}};
  const got=encodeReserveV2(command);
  assert.equal(got.body.payload.reserved_used_minor,3000);
  assert.equal(got.body.payload.amount_minor,6000);
  assert.throws(()=>encodeReserveV2({...command,payload:{...p,reserved_used_minor:6001}}));
  assert.throws(()=>encodeReserveV2({...command,payload:{...p,reserve_id:undefined}}));
  assert.throws(()=>encodeReserveV2({...command,payload:{...p,actor_user_id:idD}}));
  assert.throws(()=>encodeReserveV2({...command,payload:{...p,transaction_id:idD}}));
  assert.throws(()=>encodeReserveV2({...command,payload:{...p,fact_id:mutation}}));
});
test('zero-reserve-use payment and exact void are valid, other ledger actions excluded', () => {
  const p={account_id:idA,obligation_id:idB,reserve_id:idC,
    amount_minor:6000,reserved_used_minor:0,paid_on:'2027-11-16',occurrence_on:'2027-11-16'};
  assert.equal(encodeReserveV2({...original,action:'settlement.payment.record',payload:p,
    expectedEntityRevisions:{[idA]:3,[idB]:1,[idC]:5}}).body.payload.reserved_used_minor,0);
  const voidPay={transaction_id:idD,fact_id:idB,account_id:idA,reserve_id:idC,
    reason:'Ошибка проведения'};
  assert.equal(encodeReserveV2({...original,action:'settlement.payment.void',
    payload:voidPay,expectedEntityRevisions:{[idD]:1,[idB]:1,[idA]:2,[idC]:3}}).body.action,
    'settlement.payment.void');
  assert.throws(()=>encodeReserveV2({...original,action:'account.transfer'}));
});
test('cycle and event commands require a bounded date, reason and revs', () => {
  for(const action of ['reserve.skip','reserve.cycle.close','reserve.cycle.void',
      'reserve.event.void','reserve.archive','reserve.allocate','reserve.update']){
    let payload;
    if(action==='reserve.skip') payload={reserve_id:idC,slot_on:'2026-12-16',
      occurred_on:'2026-12-17'};
    else if(action==='reserve.cycle.close') payload={reserve_id:idC,
      occurred_on:'2027-11-16'};
    else if(action==='reserve.cycle.void') payload={reserve_id:idC,
      occurred_on:'2027-11-17',reason:'Корректировка'};
    else if(action==='reserve.event.void') payload={reserve_id:idC,account_id:idA,
      target_event_id:idD,occurred_on:'2027-11-16',reason:'Корректировка'};
    else if(action==='reserve.archive') payload={reserve_id:idC};
    else if(action==='reserve.allocate') payload={reserve_id:idC,account_id:idA,
      delta_minor:-500,occurred_on:'2027-11-16'};
    else payload={reserve_id:idC,title:'Обновлённая страховка',target_minor:200000,
      first_due_on:'2027-11-16',period_months:12,due_day:16,
      contribution_mode:'fixed',fixed_monthly_minor:10000};
    const expected={ [idC]:3, ...((action==='reserve.event.void'||action==='reserve.allocate')?
      {[idA]:2}:{}) };
    assert.equal(encodeReserveV2({...original,action,payload,
      expectedEntityRevisions:expected}).body.action,action);
  }
});
