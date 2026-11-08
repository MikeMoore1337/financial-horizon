import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGoal, applyGoalEvent,
} from '../src/domain/goals/index.ts';
import {
  reconcileGoalCapacity, assertGoalCapacity,
} from '../src/domain/goals/allocation-capacity.ts';

const SCOPE = 'profile:synthetic';
const account = (id, amount) => ({ id, scopeKey: SCOPE, currency: 'RUB', balanceCents: amount });
const reserve = (id, accountId, amount) =>
  ({ id, scopeKey: SCOPE, accountId, allocatedCents: amount });
const goal = (id, openingCents = 0) => createGoal({
  id, eventId:`created-${id}`, title:`Goal ${id}`, on:'2026-01-01',
  targetCents: 12_000_000, targetDate: '2027-01-01', openingCents,
});
const fund = (g, id, amountCents, on = '2026-02-01') => applyGoalEvent(g, {
  id, type:'contribution', on, amountCents, funding:'virtual',
});
const use = (g, id, amountCents, on = '2026-02-02') => applyGoalEvent(g, {
  id, type:'use', on, amountCents, usage:'virtual-release',
});
const undo = (g, id, eventId, on = '2026-02-03') => applyGoalEvent(g, {
  id, type:'void', on, eventId, reason:'Ошибка',
});
const input = (overrides = {}) => ({
  scopeKey:SCOPE, asOfDate:'2026-03-01', ledgerRevision:14,
  accounts:[account('bank', 10_000_000)],
  goals:[goal('g1', 3_000_000)],
  bindings:[{goalId:'g1',accountId:'bank'}],
  mandatoryReserves:[reserve('rent', 'bank', 2_000_000)],
  ...overrides,
});

const row = (x) => reconcileGoalCapacity(x).accounts[0];

test('confirmed bank cash unchanged while goal and mandatory reserve share capacity', () => {
  const r = reconcileGoalCapacity(input());
  assert.equal(r.ledgerRevision, 14);
  assert.equal(r.postedBankCents, 0);
  assert.equal(r.withinCapacity, true);
  assert.deepEqual([r.accounts[0].balanceCents,r.accounts[0].voluntaryGoalCents,
    r.accounts[0].mandatoryReserveCents,r.accounts[0].earmarkedCents,
    r.accounts[0].availableCents], [10_000_000,3_000_000,2_000_000,5_000_000,5_000_000]);
});

test('overcommitted account remains inspectable with deficit but cannot authorize new allocations', () => {
  const snapshot = input({accounts:[account('bank',4_000_000)]});
  assert.equal(row(snapshot).shortageCents, 1_000_000);
  assert.equal(row(snapshot).availableCents, -1_000_000);
  assert.equal(reconcileGoalCapacity(snapshot).withinCapacity, false);
  assert.throws(() => assertGoalCapacity(snapshot), /Not enough unallocated/);
  assertGoalCapacity(input());
});

test('a bank outflow does not silently release archived or completed goal allocations', () => {
  const archived = applyGoalEvent(goal('g1',3_000_000), {
    type:'archive', id:'archive-1',on:'2026-02-05',
  });
  assert.equal(row(input({goals:[archived]})).voluntaryGoalCents, 3_000_000);
  assert.equal(row(input({goals:[archived],accounts:[account('bank',1_000_000)]})).shortageCents,4_000_000);
});

test('virtual deposit/use/reversal change earmarking, never confirmed cash', () => {
  const initial = goal('g1');
  const funded = fund(initial,'a',2_000_000);
  const spent = use(funded,'b',500_000);
  const corrected = undo(spent,'c','b');
  const values = [initial,funded,spent,corrected]
    .map(g => row(input({goals:[g]})));
  assert.deepEqual(values.map(x=>x.voluntaryGoalCents),[0,2_000_000,1_500_000,2_000_000]);
  assert.ok(values.every(x=>x.balanceCents===10_000_000));
});

test('future-dated funding does not change present-day capacity', () => {
  const g=fund(goal('g1'),'future',100_000,'2026-07-01');
  assert.equal(row(input({goals:[g]})).voluntaryGoalCents,0);
});

test('per-account reservation boundaries cannot be bypassed with aggregate surplus elsewhere', () => {
  const x=input({accounts:[account('a',1_000_000),account('b',100_000_000)],
    bindings:[{goalId:'g1',accountId:'a'}], mandatoryReserves:[]});
  assert.deepEqual(reconcileGoalCapacity(x).accounts.map(r=>[r.accountId,r.availableCents,r.shortageCents]),
    [['a',-2_000_000,2_000_000],['b',100_000_000,0]]);
  assert.throws(()=>assertGoalCapacity(x));
});

test('reject cross-profile accounts and mandatory reserves even with matching local IDs', () => {
  assert.throws(()=>reconcileGoalCapacity(input({accounts:[{...account('bank',10_000_000),scopeKey:'other'}]})),/cross-scope/);
  assert.throws(()=>reconcileGoalCapacity(input({mandatoryReserves:[{...reserve('rent','bank',100),scopeKey:'other'}]})),/cross-scope/);
});

test('reject unknown, duplicate and missing bindings', () => {
  assert.throws(()=>reconcileGoalCapacity(input({bindings:[]})),/Invalid goal/);
  assert.throws(()=>reconcileGoalCapacity(input({bindings:[{goalId:'g1',accountId:'missing'}]})),/binding/);
  assert.throws(()=>reconcileGoalCapacity(input({goals:[goal('g1'),goal('g1')],bindings:[
    {goalId:'g1',accountId:'bank'},{goalId:'g1',accountId:'bank'}]})),/Duplicate goal/);
  assert.throws(()=>reconcileGoalCapacity(input({accounts:[account('bank',1),account('bank',2)]})),/duplicate/);
  assert.throws(()=>reconcileGoalCapacity(input({mandatoryReserves:[reserve('x','bank',100),reserve('x','bank',100)]})),/Duplicate/);
});

test('exact kopecks at upper bound; no fractional amounts or overflow accepted', () => {
  const x=input({goals:[goal('g1',999_999_999_999)],accounts:[account('bank',1_000_000_000_000)],mandatoryReserves:[]});
  assert.equal(row(x).availableCents,1);
  for (const cents of [1.5,Number.MAX_SAFE_INTEGER,-1_000_000_000_001,NaN,Infinity]) {
    assert.throws(()=>reconcileGoalCapacity(input({accounts:[account('bank',cents)]})),/kopecks/);
  }
  assert.equal(row(input({accounts:[account('bank',-1)],goals:[goal('g1')],mandatoryReserves:[]})).shortageCents, 1); // Negative bank balances are representable.
  assert.throws(()=>reconcileGoalCapacity(input({mandatoryReserves:[reserve('rent','bank',100.5)]})),/kopecks/);
});

test('source snapshots are not modified; ordered output is deterministic', () => {
  const x=input({
    accounts:[account('z',12_000_000),account('a',1_000_000)],
    goals:[goal('g2',500_000),goal('g1',250_000)],
    bindings:[{goalId:'g1',accountId:'a'},{goalId:'g2',accountId:'z'}],
    mandatoryReserves:[reserve('rent','z',1_000_000)],
  });
  const before=JSON.stringify(x);
  const a=reconcileGoalCapacity(x);
  assert.deepEqual(a,reconcileGoalCapacity({ ...x, accounts:[...x.accounts].reverse(),
    goals:[...x.goals].reverse(), bindings:[...x.bindings].reverse(),mandatoryReserves:[...x.mandatoryReserves].reverse() }));
  assert.equal(JSON.stringify(x),before);
  assert.equal(a.accounts[0].accountId,'a');
  assert.equal(a.accounts[1].accountId,'z');
});

test('a confirmed ledger movement cannot fund two separate goals', () => {
  const linked = id => applyGoalEvent(goal(id),{id:'payment-'+id,on:'2026-02-01',
    type:'contribution',funding:'account-transfer',ledgerMovementId:'shared-posting',amountCents:10_000});
  assert.throws(()=>reconcileGoalCapacity(input({goals:[linked('g1'),linked('g2')],
    bindings:[{goalId:'g1',accountId:'bank'},{goalId:'g2',accountId:'bank'}]})),/multiple goals/);
});

test('reject malformed calendar, excessive lists, missing currency and malicious new fields', () => {
  assert.throws(()=>reconcileGoalCapacity(input({asOfDate:'2026-02-30'})),/calendar/);
  assert.throws(()=>reconcileGoalCapacity(input({mandatoryReserves:Array.from({length:10_001},(_,i)=>reserve(String(i),'bank',0))})),/list/);
  assert.throws(()=>reconcileGoalCapacity(input({accounts:[{...account('bank',10_000),extra:'unexpected'}]})),/fields/);
  assert.throws(()=>reconcileGoalCapacity(input({accounts:[{...account('bank',10_000),currency:'USD'}]})),/cross-scope/);
  assert.throws(()=>reconcileGoalCapacity(input({ledgerRevision:-1})),/revision/);
});


test('historical snapshot ignores valid goals not yet created, but validates their entire journal', () => {
  const future = createGoal({
    id:'future', eventId:'future-created', title:'Next season', on:'2026-04-01',
    openingCents:8_000_000, targetCents:12_000_000, targetDate:'2027-04-01',
  });
  const old = goal('g1', 1_000_000);
  const historical = input({
    goals:[old, future],
    bindings:[{goalId:'g1',accountId:'bank'},{goalId:'future',accountId:'bank'}],
  });
  assert.equal(row(historical).voluntaryGoalCents,1_000_000);
  assert.equal(row(historical).availableCents,7_000_000);
  const afterCreation = input({ ...historical, asOfDate:'2026-04-02' });
  assert.equal(row(afterCreation).voluntaryGoalCents,9_000_000);
  assert.equal(row(afterCreation).availableCents,-1_000_000);
  // Do not treat the future goal as trusted solely because its creation is later.
  const corrupt = structuredClone(future);
  corrupt.events.push({id:'bad',on:'2026-04-02',type:'contribution',
    amountCents:-1,funding:'virtual'});
  assert.throws(() => reconcileGoalCapacity(input({
    ...historical, goals:[old,corrupt],
  })),/integer number of kopecks/);
});
