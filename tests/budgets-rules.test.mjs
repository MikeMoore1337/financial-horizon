import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyBudgetRuleState, applyBudgetRuleCommand, assertBudgetRuleState } from '../src/domain/budgets/rules.ts';
const profileId='profile-a';
const id=(i)=>`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`;
const rule=(name='total',limitMinor=1_000_000,other={})=>({id:name,profileId,scope:{kind:'total'},limitMinor,recurrence:'monthly',fromMonth:'2026-01',...other});
const cat=(name,limitMinor=100_000,other={})=>({...rule(name,limitMinor),scope:{kind:'category',categoryId:name},...other});
const create=(i,baseRevision,newRule)=>({clientMutationId:id(i),baseRevision,action:'budget.create',payload:{rule:newRule}});
const amend=(i,baseRevision,ruleId,effectiveFromMonth,replacementId,limitMinor)=>({clientMutationId:id(i),baseRevision,action:'budget.amend',payload:{ruleId,effectiveFromMonth,replacementId,limitMinor}});
const archive=(i,baseRevision,ruleId,archivedFromMonth)=>({clientMutationId:id(i),baseRevision,action:'budget.archive',payload:{ruleId,archivedFromMonth}});
const apply=(state,command)=>applyBudgetRuleCommand(state,command).state;
const total=()=>emptyBudgetRuleState(profileId);

test('create general and category rules with integer kopecks and profile revision',()=>{
  const state=apply(apply(total(),create(1,0,rule())),create(2,1,cat('food',0)));
  assert.equal(state.revision,2);
  assert.deepEqual(state.rules.map(r=>r.limitMinor),[1_000_000,0]);
  assert.equal(state.receipts.length,2);
  assertBudgetRuleState(structuredClone(state));
});

test('idempotent retry replays a receipt without changing state, different intent is denied',()=>{
  const command=create(1,0,rule());
  const first=applyBudgetRuleCommand(total(),command);
  const retried=applyBudgetRuleCommand(first.state,{payload:{rule:{limitMinor:1_000_000,scope:{kind:'total'},recurrence:'monthly',profileId,id:'total',fromMonth:'2026-01'}},baseRevision:0,clientMutationId:id(1),action:'budget.create'});
  assert.equal(retried.replayed,true);
  assert.strictEqual(retried.state,first.state);
  assert.equal(first.receipt.revision,1);
  assert.throws(()=>applyBudgetRuleCommand(first.state,create(1,0,rule('other'))),/idempotency_key_reuse/);
});

test('old revisions, mutation ids and cross-profile rules are rejected',()=>{
  const state=apply(total(),create(1,0,rule()));
  assert.throws(()=>apply(state,create(2,0,cat('food'))),/stale_revision/);
  assert.throws(()=>apply(state,create(1,1,cat('food'))),/idempotency_key_reuse/);
  assert.throws(()=>apply(total(),create(3,0,rule('bad',1,{profileId:'other'}))),/Cross-profile/);
  assert.throws(()=>apply(total(),{...create(4,0,rule()),clientMutationId:'BAD'}),/Invalid mutation ID/);
  assert.throws(()=>apply(total(),{...create(5,0,rule()),baseRevision:0.5}),/Invalid budget revision/);
});

test('future amendments split months without rewriting historical limit',()=>{
  let state=apply(total(),create(1,0,rule()));
  const previous=structuredClone(state);
  state=apply(state,amend(2,1,'total','2026-03','total-from-march',700_000));
  assert.equal(state.revision,2);
  assert.equal(state.rules[0].limitMinor,1_000_000);
  assert.equal(state.rules[0].endsBeforeMonth,'2026-03');
  assert.equal(state.rules[1].fromMonth,'2026-03');
  assert.equal(state.rules[1].limitMinor,700_000);
  assert.equal(state.rules[1].recurrence,'monthly');
  assert.deepEqual(previous.rules,[rule()]);
  assertBudgetRuleState(state);
});

test('archiving a split rule preserves prior months and does not rewrite old objects',()=>{
  let state=apply(total(),create(1,0,rule()));
  state=apply(state,amend(2,1,'total','2026-03','march',800_000));
  const snapshot=structuredClone(state);
  state=apply(state,archive(3,2,'march','2026-05'));
  assert.equal(state.rules[0].endsBeforeMonth,'2026-03');
  assert.equal(state.rules[1].archivedFromMonth,'2026-05');
  assert.equal(snapshot.rules[1].archivedFromMonth,undefined);
  assert.throws(()=>apply(state,archive(4,3,'march','2026-06')),/inactive/);
});

test('same-start amendment changes no earlier period; one-off rule is limited to one month',()=>{
  let state=apply(total(),create(1,0,rule('once',500_000,{recurrence:'once',fromMonth:'2026-07'})));
  state=apply(state,amend(2,1,'once','2026-07','once',250_000));
  assert.equal(state.rules.length,1);
  assert.equal(state.rules[0].limitMinor,250_000);
  assert.throws(()=>apply(state,amend(3,2,'once','2026-08','later',200_000)),/not active/);
  assert.throws(()=>apply(state,archive(4,2,'once','2026-08')),/inactive/);
});

test('duplicate ID and overlapping scopes reject any future clash, not only this month',()=>{
  let state=apply(total(),create(1,0,rule('a',100_000,{fromMonth:'2026-01',endsBeforeMonth:'2026-06'})));
  assert.throws(()=>apply(state,create(2,1,rule('a',100_000,{fromMonth:'2026-06'}))),/Duplicate/);
  assert.throws(()=>apply(state,create(3,1,rule('b',100_000,{fromMonth:'2026-05'}))),/Overlapping/);
  state=apply(state,create(4,1,rule('b',100_000,{fromMonth:'2026-06'})));
  assert.equal(state.rules.length,2);
  assertBudgetRuleState(state);
});

test('different category scopes coexist and overlapping intervals of one category are blocked',()=>{
  let state=apply(total(),create(1,0,cat('food')));
  state=apply(state,create(2,1,cat('fuel')));
  assert.equal(state.rules.length,2);
  assert.throws(()=>apply(state,create(3,2,cat('second',10,{scope:{kind:'category',categoryId:'food'}}))),/Overlapping/);
});

test('invalid numbers, boundaries and calendar syntax fail closed',()=>{
  assert.throws(()=>apply(total(),create(1,0,rule('zero',-1))),/kopecks/);
  assert.throws(()=>apply(total(),create(1,0,rule('fraction',0.5))),/kopecks/);
  assert.throws(()=>apply(total(),create(1,0,rule('overflow',1_000_000_000_001))),/kopecks/);
  assert.throws(()=>apply(total(),create(1,0,rule('bad',100,{fromMonth:'2026-13'}))),/month/);
  assert.throws(()=>apply(total(),create(1,0,rule('bad',100,{endsBeforeMonth:'2026-01'}))),/end month/);
  assert.throws(()=>apply(total(),create(1,0,rule('bad',100,{archivedFromMonth:'2025-12'}))),/Archive precedes/);
  assert.throws(()=>apply(total(),create(1,0,rule('bad',100,{recurrence:'weekly'}))),/recurrence/);
});

test('tampered snapshots reject duplicate rules, receipts, orphan receipt, overlap and unsupported fields',()=>{
  const state=apply(total(),create(1,0,rule()));
  assert.throws(()=>assertBudgetRuleState({...state,rules:[...state.rules,state.rules[0]]}),/Duplicate/);
  assert.throws(()=>assertBudgetRuleState({...state,receipts:[...state.receipts,state.receipts[0]]}),/Duplicate budget receipt/);
  assert.throws(()=>assertBudgetRuleState({...state,receipts:[{...state.receipts[0],affectedRuleId:'missing'}]}),/Orphan/);
  assert.throws(()=>assertBudgetRuleState({...state,rules:[...state.rules,rule('bad',400,{fromMonth:'2026-06'})]}),/Overlapping/);
  assert.throws(()=>assertBudgetRuleState({...state,rules:[rule('bad',100,{scope:{kind:'total',categoryId:'sneaky'}})]}),/Invalid budget scope/);
  assert.throws(()=>assertBudgetRuleState({...state,extra:true}),/Invalid budget rule state/);
});

test('immutable source and repeated archived state remain stable under serialization',()=>{
  const base=Object.freeze({...total(),rules:Object.freeze([]),receipts:Object.freeze([])});
  const created=applyBudgetRuleCommand(base,create(1,0,rule()));
  const archived=applyBudgetRuleCommand(created.state,archive(2,1,'total','2026-02'));
  assert.deepEqual(JSON.parse(JSON.stringify(archived.state)),archived.state);
  assert.equal(base.revision,0);
  assert.equal(created.state.rules[0].archivedFromMonth,undefined);
  assert.equal(archived.state.rules[0].archivedFromMonth,'2026-02');
});

test('invalid archive and amendment windows fail without mutating inputs',()=>{
  let state=apply(total(),create(1,0,rule('q',123_000,{fromMonth:'2026-03',endsBeforeMonth:'2026-06'})));
  const frozen=structuredClone(state);
  assert.throws(()=>apply(state,amend(2,1,'q','2026-02','f',200_000)),/not active/);
  assert.throws(()=>apply(state,amend(3,1,'q','2026-06','f',200_000)),/not active/);
  assert.throws(()=>apply(state,archive(4,1,'q','2026-02')),/inactive/);
  assert.deepEqual(state,frozen);
});
