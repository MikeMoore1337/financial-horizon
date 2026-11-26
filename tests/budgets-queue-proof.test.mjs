import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyBudgetReceiptCandidate} from '../src/cloud/encrypted-command-outbox-candidate.mjs';
const P='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const id=n=>'10000000-0000-4000-8000-'+String(n).padStart(12,'0');
const C=id(1), R=id(2), T=id(3), A=id(4), N=id(5), M=id(6);
const entity=(kind,id,data,entity_revision=1)=>({kind,id,data,entity_revision});
const event=(entity,extra={})=>({kind:'upsert',entity_id:entity.id,entity_revision:entity.entity_revision,payload:{entity,...extra}});
const cat=entity('budget_category',C,{name:'Еда',archived:false});
const data={category_id:C,limit_minor:1_000_000,recurrence:'monthly',from_month:'2026-01',ends_before_month:null,archived_from_month:null};
const rule=entity('budget_rule',R,data);
const tx=entity('transaction',T,{kind:'expense',postings:[{account_id:id(100),signed_minor:-150000}],reversed_transaction_id:null});
const assignment=entity('budget_assignment',A,{transaction_id:T,category_id:C});
const body=(action,payload,versions={})=>({schema_version:2,client_mutation_id:M,base_revision:8,action,payload,expected_entity_revisions:versions});
const proof=(cmd,changes,entities,previous=false)=>verifyBudgetReceiptCandidate(cmd,changes,entities,previous,P);

test('budget queue proof binds create, rename, archive, and rejects unrelated cash writes',()=>{
  const create=body('budget.category.create',{id:C,name:'Еда'});
  proof(create,[event(cat)],[]);
  proof(create,[event(cat)],[cat],true);
  assert.throws(()=>proof(create,[event({...cat,data:{name:'Другое',archived:false}})],[]));
  assert.throws(()=>proof(create,[event(cat),event(tx)],[]));
  const rename=body('budget.category.rename',{id:C,name:'Продукты'},{[C]:1});
  const renamed=entity('budget_category',C,{name:'Продукты',archived:false},2);
  proof(rename,[event(renamed)],[cat]);
  const archive=body('budget.category.archive',{id:C},{[C]:1});
  proof(archive,[event({...cat,entity_revision:2,data:{...cat.data,archived:true}})],[cat]);
  assert.throws(()=>proof(archive,[event({...cat,entity_revision:2,data:{name:'Other',archived:true}})],[cat]));
});
test('budget rule receipt keeps exact money and history across atomic split',()=>{
  const create=body('budget.create',{id:R,category_id:C,limit_minor:1_000_000,recurrence:'monthly',from_month:'2026-01'});
  proof(create,[event(rule)],[cat]);
  assert.throws(()=>proof(create,[event({...rule,data:{...data,limit_minor:999_999}})],[cat]));
  assert.throws(()=>proof(create,[event(rule)],[]));
  const amend=body('budget.amend',{rule_id:R,effective_from_month:'2026-03',replacement_id:N,limit_minor:800000},{[R]:1});
  const old=entity('budget_rule',R,{...data,ends_before_month:'2026-03'},2);
  const next=entity('budget_rule',N,{...data,limit_minor:800000,from_month:'2026-03'});
  proof(amend,[event(old),event(next)],[cat,rule]);
  proof(amend,[event(old),event(next)],[cat,old,next],true);
  assert.throws(()=>proof(amend,[event(next)],[cat,rule]));
  assert.throws(()=>proof(amend,[event({...old,data:{...old.data,limit_minor:1}}),event(next)],[cat,rule]));
  const archive=body('budget.archive',{rule_id:R,archived_from_month:'2026-02'},{[R]:1});
  proof(archive,[event(entity('budget_rule',R,{...data,archived_from_month:'2026-02'},2))],[cat,rule]);
});
test('assignment receipt preserves independent identity and rejects uncategorization of wrong transaction',()=>{
  const assign=body('budget.category.assign',{transaction_id:T,category_id:C},{[T]:1});
  proof(assign,[event(assignment,{previous_category_id:null})],[cat,tx]);
  assert.throws(()=>proof(assign,[event(assignment)],[cat,tx]));
  assert.throws(()=>proof(assign,[event({...assignment,id:T},{previous_category_id:null})],[cat,tx]));
  const clear=body('budget.category.assign',{transaction_id:T,category_id:null},{[T]:1});
  const cleared=entity('budget_assignment',A,{transaction_id:T,category_id:null},2);
  proof(clear,[event(cleared,{previous_category_id:C})],[cat,tx,assignment]);
  assert.throws(()=>proof(clear,[event(cleared,{previous_category_id:null})],[cat,tx,assignment]));
  assert.throws(()=>proof(assign,[event(assignment,{previous_category_id:null})],
    [cat,tx,{...tx,id:N,data:{...tx.data,kind:'reversal',reversed_transaction_id:T}}]));
  assert.throws(()=>proof(assign,[event(assignment,{previous_category_id:null})],[cat,{...tx,data:{...tx.data,kind:'income'}}]));
});
test('malformed commands cannot be certified as budget receipts',()=>{
  const cmd=body('budget.create',{id:R,category_id:C,limit_minor:1_000_000,recurrence:'monthly',from_month:'2026-01'});
  for(const bad of [
    {...cmd,schema_version:1}, {...cmd,payload:{...cmd.payload,limit_minor:0.1}},
    {...cmd,payload:{...cmd.payload,from_month:'0000-01'}},
    {...cmd,expected_entity_revisions:{[R]:1}},
    {...cmd,payload:{...cmd.payload,profile_id:P}},
  ]) assert.throws(()=>proof(bad,[event(rule)],[cat]));
});
