import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGoal, applyGoalEvent, buildGoalCashflowBundle, withGoalCashflowSources,
} from '../src/domain/goals/index.ts';

const source = (extra = {}) => ({
  openingDate: '2026-01-01', asOfDate: '2026-03-05', horizonMonths: 12,
  accounts: [{id:'bank', currency:'RUB', openingBalanceCents:50_000_000}],
  reserves: [], plans: [], actuals: [], ...extra,
});
const fresh = (id = 'g1', extra = {}) => createGoal({
  id, eventId:`create-${id}`, on:'2026-01-01', title:'Сбережения',
  targetCents:12_000_000, targetDate:'2027-01-01', ...extra,
});
const put = (goal, id, on, amountCents, extra = {}) => applyGoalEvent(goal, {
  id, type:'contribution', on, amountCents, funding:'virtual', ...extra,
});
const spend = (goal, id, on, amountCents, extra = {}) => applyGoalEvent(goal, {
  id, type:'use', on, amountCents, usage:'virtual-release', ...extra,
});
const undo = (goal, id, on, eventId, extra = {}) => applyGoalEvent(goal, {
  id, type:'void', on, eventId, reason:'Исправление', ...extra,
});
const binding = [{goalId:'g1',accountId:'bank'}];
const sum = (rows, status) => rows.filter(row=>row.status===status)
  .reduce((acc, row)=>acc+(row.kind==='allocate'?row.amountCents:-row.amountCents),0);

test('goal earmark and scheduled allocations are not bank outflows or expenses', () => {
  const result=withGoalCashflowSources(source(),[fresh()],binding);
  assert.deepEqual(result.actuals,[]);
  assert.deepEqual(result.plans,[]);
  assert.equal(result.accounts[0].openingBalanceCents,50_000_000);
  assert.equal(result.reserves[0].openingReservedCents,0);
  assert.equal(sum(result.reserveMovements,'actual'),0);
  assert.equal(sum(result.reserveMovements,'planned'),12_000_000);
  assert.ok(result.reserveMovements.every(x=>x.amountCents>0));
});

test('early prepaid installment is earmarked once and not planned twice',()=>{
  const g=put(fresh(),'prepaid','2026-02-01',2_000_000,{forDueOn:'2026-04-01'});
  const b=buildGoalCashflowBundle([g],source(),binding);
  assert.equal(sum(b.movements,'actual'),2_000_000);
  assert.equal(sum(b.movements,'planned'),10_000_000);
  assert.equal(b.movements.filter(x=>x.date==='2026-04-01'&&x.status==='planned').length,0);
  assert.deepEqual(b.externalCashFlows,[]);
});

test('opening snapshot and events partition by date without double booking',()=>{
  let g=fresh('g1',{on:'2025-10-01',openingCents:2_000_000});
  g=put(g,'old','2025-12-01',1_000_000);
  g=put(g,'new','2026-01-01',500_000);
  g=spend(g,'use','2026-02-01',600_000);
  const b=buildGoalCashflowBundle([g],source(),binding);
  assert.equal(b.openingReserves[0].openingReservedCents,3_000_000);
  assert.equal(sum(b.movements,'actual'),-100_000);
  assert.equal(b.openingReserves[0].openingReservedCents+sum(b.movements,'actual'),2_900_000);
  assert.equal(b.movements.filter(x=>x.status==='actual').length,2);
});

test('same-day origin plus later cancellation is represented as signed reserve events',()=>{
  let g=put(fresh(),'dep','2026-02-01',3_000_000);
  g=undo(g,'void-dep','2026-03-01','dep');
  const b=buildGoalCashflowBundle([g],source(),binding);
  assert.deepEqual(b.movements.filter(x=>x.status==='actual').map(x=>[x.kind,x.amountCents]),[
    ['allocate',3_000_000],['release',3_000_000],
  ]);
  assert.equal(sum(b.movements,'actual'),0);
});

test('voiding an already-spent goal use re-earmarks but never credits income',()=>{
  let g=put(fresh(),'dep','2026-02-01',3_000_000);
  g=spend(g,'purchase','2026-02-10',1_000_000,{
    usage:'expense',ledgerMovementId:'already-booked-expense',
  });
  g=undo(g,'revert','2026-02-15','purchase',{ledgerReversalId:'already-booked-reversal'});
  const s=source({actuals:[{id:'bank-expense',date:'2026-02-10',kind:'expense',amountCents:1_000_000}]});
  const out=withGoalCashflowSources(s,[g],binding);
  assert.deepEqual(out.actuals,s.actuals);
  assert.equal(sum(out.reserveMovements,'actual'),3_000_000);
  assert.deepEqual(out.reserveMovements.filter(x=>x.status==='actual').map(x=>x.kind),[
    'allocate','release','allocate',
  ]);
});

test('separate goals retain distinct event IDs despite identical component names',()=>{
  const a=fresh('g1');
  const b=fresh('g2');
  const out=withGoalCashflowSources(source(),[a,b],[...binding,{goalId:'g2',accountId:'bank'}]);
  const ids=out.reserveMovements.map(x=>x.id);
  assert.equal(new Set(ids).size,ids.length);
  assert.equal(out.reserves.length,2);
});

test('cross-goal same ledger reference is rejected before DTO generation',()=>{
  const a=put(fresh('g1'),'a','2026-02-01',1000,{funding:'account-transfer',ledgerMovementId:'tx'});
  const b=put(fresh('g2'),'b','2026-02-01',1000,{funding:'account-transfer',ledgerMovementId:'tx'});
  assert.throws(()=>withGoalCashflowSources(source(),[a,b],[...binding,{goalId:'g2',accountId:'bank'}]),/multiple goals/);
});

test('adapter never silently double-merges the same reserve movements',()=>{
  const g=fresh();
  const first=withGoalCashflowSources(source(),[g],binding);
  assert.throws(()=>withGoalCashflowSources(first,[g],binding),/already included/);
  assert.equal(source().reserves.length,0);
});

test('binding must refer to known authorized account; cannot infer missing bank balance',()=>{
  assert.throws(()=>withGoalCashflowSources(source(),[fresh()],[]),/one verified account/);
  assert.throws(()=>withGoalCashflowSources(source(),[fresh()],[{goalId:'g1',accountId:'unknown'}]),/account binding/);
  assert.throws(()=>withGoalCashflowSources(source({accounts:[]}),[fresh()],binding),/account snapshot/);
  assert.throws(()=>withGoalCashflowSources(source({accounts:[{id:'bank',currency:'USD',openingBalanceCents:0}]}),[fresh()],binding),/RUB account/);
  assert.throws(()=>withGoalCashflowSources(source({openingDate:'2026-03-06'}),[fresh()],binding),/precedes opening/);
});

test('future correction cannot enter factual reserve history before its date',()=>{
  let g=put(fresh(),'dep','2026-02-01',3_000_000);
  g=undo(g,'void-dep','2026-04-01','dep');
  const b=buildGoalCashflowBundle([g],source(),binding);
  assert.equal(sum(b.movements,'actual'),3_000_000);
  assert.equal(b.movements.filter(x=>x.status==='actual').length,1);
});


test('control characters cannot produce malformed #36 movement identifiers',()=>{
  assert.throws(()=>buildGoalCashflowBundle([fresh('bad\0id')],source(),[
    {goalId:'bad\0id',accountId:'bank'},
  ]),/NUL/);
  const bad=fundingWithInvalidEventId();
  assert.throws(()=>buildGoalCashflowBundle([bad],source(),binding),/NUL/);
  assert.throws(()=>buildGoalCashflowBundle([fresh()],source({
    accounts:[{id:'bank\0internal',currency:'RUB',openingBalanceCents:1000}],
  }),[{goalId:'g1',accountId:'bank\0internal'}]),/RUB account/);
});

function fundingWithInvalidEventId() {
  return put(fresh(),'deposit\0bad','2026-02-01',10_000);
}

test('historical #36 cashflow ignores not-yet-created goal but includes it after creation', () => {
  const present = fresh('g1', { openingCents: 50_000 });
  const future = fresh('later', { on: '2026-04-01', openingCents: 150_000 });
  const bonds = [...binding, { goalId: 'later', accountId: 'bank' }];
  const earlier = withGoalCashflowSources(source(), [present, future], bonds);
  assert.equal(earlier.reserves.length, 1);
  assert.equal(earlier.reserves[0].openingReservedCents, 0);
  assert.equal(earlier.reserveMovements.filter(r => r.status === 'actual')
    .reduce((sum, r) => sum + r.amountCents, 0), 50_000);
  assert.ok(earlier.reserveMovements.every(r => !r.id.includes('later')));
  const later = withGoalCashflowSources(source({ asOfDate: '2026-04-02' }), [present, future], bonds);
  assert.equal(later.reserves.length, 2);
  assert.equal(later.reserveMovements.filter(r => r.status === 'actual')
    .reduce((sum, r) => sum + r.amountCents, 0), 200_000);
});

test('future-created goal still undergoes strict journal validation at historical as-of', () => {
  const future = fresh('later', { on: '2026-04-01' });
  const corrupted = structuredClone(future);
  corrupted.events.push({ id: 'invalid', type: 'contribution', on: '2026-04-10',
    amountCents: -1, funding: 'virtual' });
  assert.throws(() => buildGoalCashflowBundle([corrupted], source(), [
    { goalId: 'later', accountId: 'bank' },
  ]), /integer number of kopecks/);
});
