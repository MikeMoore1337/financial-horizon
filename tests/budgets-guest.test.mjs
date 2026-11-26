import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyState,validateState} from '../finance.js';
import {encryptBackup,decryptBackup} from '../backup.js';
import {migrateState} from '../state-migrations.ts';
import {addGuestBankAccount,commitGuestBankBatch,undoGuestBankBatch} from '../src/importers/bank-statements/guest-ledger.js';
import {readGuestBudgetStore,projectGuestBudget,applyGuestBudgetCommand} from '../src/domain/budgets/guest.mjs';
import {calculateBudgetReport} from '../src/domain/budgets/index.ts';

const id=n=>'10000000-0000-4000-8000-'+String(n).padStart(12,'0');
const hash=s=>s.repeat(64), accountId=id(1), secondId=id(2), ruleId=id(3), otherRule=id(4), total=id(5);
const month='2026-11', category='legacy:покупки', other='legacy:здоровье';
function execute(state,action,payload,versions={}){
 applyGuestBudgetCommand(state,action,payload,versions,state.revision);state.revision++;
 return state;
}
function opened(){
 const state=emptyState();
 addGuestBankAccount(state,{id:accountId,name:'Основной',openingMinor:2_000_000},state.revision);state.revision++;
 addGuestBankAccount(state,{id:secondId,name:'Второй',openingMinor:0},state.revision);state.revision++;
 return state;
}
function setRule(state,id=ruleId,c=category,limit=1_000_000,recurrence='monthly'){
 return execute(state,'budget.create',{id,category_id:c,limit_minor:limit,recurrence,from_month:month});
}
function importFacts(state,{source='a',fingerprint='b',batch='c',day='2026-11-07',amount=150_000}={}){
 const rows=[
 {sourceKey:hash(source),fingerprint:hash(fingerprint),externalId:'expense-'+source,date:day,amountCents:amount,
  kind:'expense',description:'Покупка',accountId,targetAccountId:null,category:'Покупки',currency:'RUB'},
 {sourceKey:hash('d'),fingerprint:hash('e'),externalId:'transfer-'+source,date:day,amountCents:20_000,
  kind:'transfer',description:'Перевод',accountId,targetAccountId:secondId,category:'Покупки',currency:'RUB'},
 ];
 const plan={batchKey:hash(batch),sourceKeys:rows.map(x=>x.sourceKey),operations:rows,expectedOperationCount:rows.length};
 commitGuestBankBatch(state,plan,hash('f'),state.revision);state.revision++;
 return plan;
}
function report(state,m=month){
 const model=projectGuestBudget(state,m);
 return calculateBudgetReport({...model,month:m});
}
test('guest old state is read-only, seeded from existing categories, and restores without forced migration',async()=>{
 const old=emptyState(),before=structuredClone(old);
 const model=readGuestBudgetStore(old);
 assert.ok(model.categories.some(c=>c.id===category));
 assert.deepEqual(old,before);
 const legacy={...old,version:1};delete legacy.revision;
 const encrypted=await encryptBackup(legacy,'synthetic guest backup phrase');
 const restored=migrateState(await decryptBackup(encrypted,'synthetic guest backup phrase'));
 assert.equal(restored.version,2);assert.equal(restored.guestBudgets,undefined);
 assert.equal(report(restored).confirmedExpenseMinor,0);
});
test('1500 RUB consumes a 10000 RUB rule exactly once; transfer and planner fact do not',()=>{
 const s=opened();
 setRule(s);setRule(s,total,null);
 s.entries.push({id:'legacy-entry',title:'План',kind:'expense',amountCents:99999,date:'2026-11-01',recurrence:'monthly',category:'Покупки'});
 s.settlements.push({id:'legacy-fact',entryId:'legacy-entry',occurrence:month,date:'2026-11-01',amountCents:99999});
 const previous=structuredClone(s.entries);
 importFacts(s);
 const r=report(s);
 assert.equal(r.confirmedExpenseMinor,150_000);
 assert.equal(r.plannedExpenseMinor,99999);
 assert.equal(r.total.remainingMinor,850_000);
 assert.equal(r.categories[0].remainingMinor,850_000);
 assert.deepEqual(s.entries,previous);
 assert.equal(report(s,'2026-12').confirmedExpenseMinor,0);
 assert.equal(report(s,'2026-12').categories[0].remainingMinor,1_000_000);
});
test('guest cancellation preserves original movements and stops budget consumption',()=>{
 const s=opened();setRule(s);
 const plan=importFacts(s);
 assert.equal(report(s).confirmedExpenseMinor,150_000);
 const facts=structuredClone(s.bankStatements.operations);
 undoGuestBankBatch(s,plan.batchKey,s.revision);s.revision++;
 assert.equal(report(s).confirmedExpenseMinor,0);
 assert.equal(report(s).categories[0].remainingMinor,1_000_000);
 assert.deepEqual(s.bankStatements.operations,facts);
 assert.throws(()=>execute(s,'budget.category.assign',{transaction_id:hash('a'),category_id:other},{[hash('a')]:1}));
});
test('reclassify, uncategorize, rename and archive without rewriting bank or old categories',()=>{
 const s=opened();setRule(s);setRule(s,otherRule,other,100_000);
 importFacts(s);
 const bank=structuredClone(s.bankStatements),originalCategories=structuredClone(s.categories);
 execute(s,'budget.category.assign',{transaction_id:hash('a'),category_id:other},{[hash('a')]:1});
 const r=report(s);assert.equal(r.confirmedExpenseMinor,150000);
 assert.equal(r.categories.find(c=>c.ruleId===otherRule).overrunMinor,50000);
 assert.equal(r.categories.find(c=>c.ruleId===ruleId).spentMinor,0);
 execute(s,'budget.category.rename',{id:other,name:'Медицина'},{[other]:1});
 execute(s,'budget.category.archive',{id:other},{[other]:2});
 assert.equal(report(s).categories.find(c=>c.ruleId===otherRule).spentMinor,150000);
 assert.throws(()=>execute(s,'budget.category.assign',{transaction_id:hash('a'),category_id:other},{[hash('a')]:1}));
 execute(s,'budget.category.assign',{transaction_id:hash('a'),category_id:null},{[hash('a')]:1});
 assert.equal(report(s).uncategorizedExpenseMinor,150000);
 assert.deepEqual(s.bankStatements,bank);
 assert.deepEqual(s.categories,originalCategories);
});
test('amend and archive preserve prior month, zero limit, and reject overlap or stale revisions',()=>{
 const s=opened();setRule(s);const before=structuredClone(s);
 assert.throws(()=>setRule(s,id(9)),/Повреждены локальные бюджеты/);
 assert.deepEqual(s,before);
 assert.throws(()=>applyGuestBudgetCommand(s,'budget.archive',{rule_id:ruleId,archived_from_month:month},{[ruleId]:1},s.revision-1));
 execute(s,'budget.amend',{rule_id:ruleId,replacement_id:otherRule,effective_from_month:'2026-12',limit_minor:0},{[ruleId]:1});
 assert.equal(report(s).categories[0].limitMinor,1_000_000);
 assert.equal(report(s,'2026-12').categories[0].limitMinor,0);
 execute(s,'budget.archive',{rule_id:otherRule,archived_from_month:'2027-01'},{[otherRule]:1});
 assert.equal(report(s,'2027-01').categories.length,0);
 assert.equal(report(s,'2026-12').categories[0].limitMinor,0);
});
test('encrypted round-trip preserves all budget data and exact facts; corrupt sidecars refused',async()=>{
 const s=opened();setRule(s);importFacts(s);
 execute(s,'budget.category.assign',{transaction_id:hash('a'),category_id:other},{[hash('a')]:1});
 const file=await encryptBackup(s,'synthetic guest backup phrase');
 assert.ok(!file.includes('Покупка'));assert.ok(!file.includes('guestBudgets'));
 const restored=await decryptBackup(file,'synthetic guest backup phrase');
 assert.deepEqual(restored,s);assert.deepEqual(report(restored),report(s));
 for(const damage of [
  b=>{b.rules[0].limitMinor=0.1;},b=>{b.rules[0].fromMonth='0000-11';},
  b=>{b.rules.push({...b.rules[0],id:id(20)});},
  b=>{b.assignments[0].transactionId=hash('d');},
  b=>{b.assignments[0].categoryId='unknown';},
  b=>{b.categories[0].aliases.push(b.categories[1].aliases[0]);},
 ]){
  const bad=structuredClone(s);damage(bad.guestBudgets);
  assert.throws(()=>validateState(bad));await assert.rejects(()=>encryptBackup(bad,'synthetic guest backup phrase'));
 }
});
