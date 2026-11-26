import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeCompleteFinanceState } from '../src/domain/accounts/server-snapshot.ts';
import { calculateAuthoritativeLedgerBudgetReport } from '../src/domain/budgets/ledger-adapter.ts';
import { verifyFinanceSnapshotPagesCandidate, applyFinanceDeltaCandidate } from '../src/cloud/verified-delta-candidate.mjs';

const P = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', USER = 'a'.repeat(32);
const id = n => '10000000-0000-4000-8000-' + String(n).padStart(12, '0');
const A = id(1), TX = id(2), CAT = id(3), TOTAL = id(4), RULE = id(5), ASSIGN = id(6), REPLACEMENT = id(7);
const entity = (id, kind, data, entity_revision = 1) => ({id, kind, data, entity_revision});
const account = entity(A, 'account', {
  name: 'Synthetic', type: 'cash', currency: 'RUB', opening_minor: 1_000_000,
  balance_minor: 850_000, available_minor: 850_000, reserved_minor: 0, archived_at: null,
});
const tx = entity(TX, 'transaction', {
  kind: 'expense', occurred_on: '2026-01-15', posted_at: '2026-01-15T12:00:00Z',
  note: null, reversed_transaction_id: null, postings: [{account_id:A,signed_minor:-150_000}],
});
const cat = entity(CAT, 'budget_category', {name:'Продукты',archived:false});
const ruleData = category_id => ({category_id,limit_minor:1_000_000,recurrence:'monthly',
  from_month:'2026-01',ends_before_month:null,archived_from_month:null});
const total = entity(TOTAL, 'budget_rule', ruleData(null));
const rule = entity(RULE, 'budget_rule', ruleData(CAT));
const assignment = entity(ASSIGN,'budget_assignment',{transaction_id:TX,category_id:CAT});
const body = (entities=[account,tx,cat,total,rule,assignment], revision=6) => ({
  schema_version:1,profile_id:P,currency:'RUB',entities,revision,server_at:'2026-01-20T12:00:00Z',
});
const guard = () => ({scope:'account:'+USER,profileId:P,generation:1,
  epoch:'c'.repeat(32),signal:new AbortController().signal});
const verify = (raw=body()) => verifyFinanceSnapshotPagesCandidate([{cursorSent:null,body:raw}],guard());
const change = (revision,ordinal,entity) => ({
  revision,ordinal,kind:'upsert',entity_id:entity.id,entity_revision:entity.entity_revision,payload:{entity},
});
const delta = (changes,from=6,to=7) => ({
  schema_version:1,from_revision:from,to_revision:to,next_since_revision:to,has_more:false,changes,
});
function report(raw) {
  const view = decodeCompleteFinanceState(raw,P,USER);
  return calculateAuthoritativeLedgerBudgetReport({
    snapshot:view.ledger,month:'2026-01',rules:view.budget.rules,assignments:view.budget.assignments,
  });
}

test('full budget snapshot uses the real ledger without duplicating monetary facts', () => {
  const result = report(body());
  assert.equal(result.total.remainingMinor,850_000);
  assert.equal(result.total.percentUsed,15);
  assert.equal(result.categories[0].spentMinor,150_000);
  assert.equal(result.confirmedExpenseMinor,150_000);
  assert.equal(result.uncategorizedExpenseMinor,0);
  assert.equal(verify().entities.length,6);
  assert.deepEqual(decodeCompleteFinanceState(body([account,tx]),P,USER).budget,
    {profileId:P,rules:[],categories:[],assignments:[]});
});

test('budget entities survive cursor pages with stable references', () => {
  const first = body([account,tx,cat]);
  first.next_cursor = '6:budget_category:'+CAT;
  const second = body([total,rule,assignment]);
  const view = verifyFinanceSnapshotPagesCandidate([
    {cursorSent:null,body:first},{cursorSent:first.next_cursor,body:second},
  ],guard());
  assert.deepEqual(view.entities,body().entities);
});

test('budget delta atomically preserves history, existing account and pending work', () => {
  const local = verify();
  local.pending.push({status:'pending'});
  local.conflicts.push({kind:'manual'});
  const previous = structuredClone(local);
  const ended = entity(RULE,'budget_rule',{...rule.data,ends_before_month:'2026-03'},2);
  const next = entity(REPLACEMENT,'budget_rule',{...rule.data,from_month:'2026-03',limit_minor:800_000});
  // Insert-before-update is valid only within the same indivisible revision.
  const after = applyFinanceDeltaCandidate(local,delta([change(7,0,next),change(7,1,ended)]),guard());
  assert.equal(after.revision,7);
  assert.deepEqual(after.pending,previous.pending);
  assert.deepEqual(after.conflicts,previous.conflicts);
  assert.deepEqual(local,previous);
  assert.equal(after.entities.find(x=>x.id===A).data.balance_minor,850_000);
  assert.equal(report(body(after.entities,7)).categories[0].limitMinor,1_000_000);
  assert.throws(()=>applyFinanceDeltaCandidate(local,delta([change(7,0,next)]),guard()));
  assert.throws(()=>applyFinanceDeltaCandidate(local,delta([change(7,0,ended)]),guard()),/Разделение/);
  assert.throws(()=>applyFinanceDeltaCandidate(local,delta([change(7,0,ended),change(8,0,next)],6,8),guard()),/Разделение/);
  const wrong = entity(REPLACEMENT,'budget_rule',{...next.data,ends_before_month:'2026-04'});
  assert.throws(()=>applyFinanceDeltaCandidate(local,delta([change(7,0,ended),change(7,1,wrong)]),guard()),/Разделение/);
  assert.throws(()=>applyFinanceDeltaCandidate(local,delta([change(7,0,next),change(8,0,ended)],6,8),guard()));
});

test('category archive and uncategorization preserve expense and historical UUID', () => {
  const local = verify();
  const archived = entity(CAT,'budget_category',{...cat.data,archived:true},2);
  const unassigned = entity(ASSIGN,'budget_assignment',{...assignment.data,category_id:null},2);
  const after = applyFinanceDeltaCandidate(local,delta([change(7,0,archived),change(7,1,unassigned)]),guard());
  const result = report(body(after.entities,7));
  assert.equal(result.total.spentMinor,150_000);
  assert.equal(result.categories[0].spentMinor,0);
  assert.equal(result.uncategorizedExpenseMinor,150_000);
  assert.equal(after.entities.find(x=>x.id===ASSIGN).data.transaction_id,TX);
});

test('malformed rule, cross-reference and collision cannot replace a verified cache', () => {
  for (const mutate of [
    x=>{x.entities.find(e=>e.id===RULE).data.limit_minor=0.5;},
    x=>{x.entities.find(e=>e.id===RULE).data.category_id=id(99);},
    x=>{x.entities.find(e=>e.id===ASSIGN).data.transaction_id=id(99);},
    x=>{x.entities.find(e=>e.id===ASSIGN).id=TX;},
    x=>{x.entities.find(e=>e.id===TX).data.kind='adjustment';},
    x=>{x.entities.find(e=>e.id===RULE).data.from_month='0000-01';},
    x=>{x.entities.splice(5,0,entity(REPLACEMENT,'budget_rule',ruleData(CAT)));},
  ]) {
    const changed=structuredClone(body());
    mutate(changed);
    assert.throws(()=>verify(changed));
    assert.throws(()=>decodeCompleteFinanceState(changed,P,USER));
  }
  const local=verify();
  const tombstone={revision:7,ordinal:0,kind:'tombstone',entity_id:CAT,entity_revision:2,payload:{}};
  assert.throws(()=>applyFinanceDeltaCandidate(local,delta([tombstone]),guard()));
});

test('budget delta rejects revision jumps and reassignment of the immutable expense identity', () => {
  const local = verify();
  const renamed = entity(CAT, 'budget_category', {...cat.data, name:'Другие'}, 3);
  assert.throws(()=>applyFinanceDeltaCandidate(local,delta([change(7,0,renamed)]),guard()),/ревизия/);
  const another = entity(id(99),'transaction',tx.data);
  const initial = verify(body([account,tx,another,cat,total,rule,assignment]));
  const replaced = entity(ASSIGN,'budget_assignment',{transaction_id:another.id,category_id:CAT},2);
  assert.throws(()=>applyFinanceDeltaCandidate(initial,delta([change(7,0,replaced)]),guard()),/проводка/);
});
