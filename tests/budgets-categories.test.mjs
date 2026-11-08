import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyBudgetCategoryState, assertBudgetCategoryState, applyBudgetCategoryCommand,
} from '../src/domain/budgets/categories.ts';

const profileId = 'profile-a';
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const debit = (id, overrides = {}) => ({ id, profileId, occurredOn: '2026-01-15',
  kind: 'expense', status: 'confirmed', signedMinor: -150_000, categoryId: null, ...overrides });
const cmd = (n, baseRevision, transactionId, categoryId) => ({
  action: 'budget.category.assign', clientMutationId: uuid(n), baseRevision,
  payload: { transactionId, categoryId },
});
const operations = [debit('expense-1'), debit('debit-1', {kind: 'payment', sourceFactId: 'settlement:f1'}),
  debit('transfer', {kind: 'transfer', signedMinor: 0}), debit('income', {kind: 'income', signedMinor: 1}),
  debit('plan', {status: 'planned'}), debit('voided', {status: 'voided'}),
  debit('credit', {kind: 'payment', signedMinor: 5000}), debit('reserve', {kind: 'reserve'})];
const empty = () => emptyBudgetCategoryState(profileId);
const apply = (state, command, entries=operations) => applyBudgetCategoryCommand(state, entries, command).state;

test('reassigning confirmed spending does not touch ledger or alter signed amount', () => {
  const input = structuredClone(operations);
  let state = apply(empty(), cmd(1, 0, 'expense-1', 'food'));
  assert.deepEqual(state.assignments, [{profileId, transactionId:'expense-1', categoryId:'food'}]);
  state = apply(state, cmd(2, 1, 'expense-1', 'transport'));
  assert.deepEqual(state.assignments, [{profileId, transactionId:'expense-1', categoryId:'transport'}]);
  assert.deepEqual(state.events.map(e=>[e.previousCategoryId,e.categoryId]), [[null,'food'],['food','transport']]);
  assert.deepEqual(operations, input);
  assertBudgetCategoryState(JSON.parse(JSON.stringify(state)));
});

test('reclassifying negative linked payment is permitted but not positive incoming payment', () => {
  const state=apply(empty(),cmd(1,0,'debit-1','credit'));
  assert.equal(state.assignments[0].categoryId,'credit');
  assert.throws(()=>apply(empty(),cmd(2,0,'credit','credit')), /Only confirmed/);
});

test('moving to uncategorized deletes projection but preserves event history', () => {
  const original=apply(empty(),cmd(1,0,'expense-1','food'));
  const moved=apply(original,cmd(2,1,'expense-1',null));
  assert.deepEqual(moved.assignments, []);
  assert.equal(moved.events.length,2);
  assert.equal(moved.events[1].previousCategoryId,'food');
  assertBudgetCategoryState(moved);
  assert.equal(original.assignments[0].categoryId,'food');
});

test('idempotent replay does not alter revision and conflicting mutation is denied', () => {
  const command=cmd(1,0,'expense-1','food');
  const first=applyBudgetCategoryCommand(empty(),operations,command);
  const replay=applyBudgetCategoryCommand(first.state,operations,structuredClone(command));
  assert.equal(replay.replayed,true);
  assert.strictEqual(replay.state,first.state);
  assert.throws(()=>applyBudgetCategoryCommand(first.state,operations,cmd(1,0,'expense-1','travel')), /idempotency_key_reuse/);
  assert.throws(()=>applyBudgetCategoryCommand(first.state,operations,cmd(2,0,'expense-1','travel')), /stale_revision/);
  assert.throws(()=>applyBudgetCategoryCommand(first.state,operations,cmd(3,1,'expense-1','food')), /unchanged/);
});

test('no attempt to categorize transfers, reserves, future or voided entries', () => {
  for (const transactionId of ['transfer','income','plan','voided','reserve','credit']) {
    assert.throws(()=>apply(empty(),cmd(1,0,transactionId,'food')), /Only confirmed/);
  }
});

test('foreign profile, nonexistent transaction and ambiguous transaction fail closed', () => {
  assert.throws(()=>apply(empty(),cmd(1,0,'missing','food')), /Unknown or ambiguous/);
  assert.throws(()=>apply(empty(),cmd(1,0,'expense-1','food'),[...operations,debit('expense-1')]),/Unknown or ambiguous/);
  assert.throws(()=>apply(empty(),cmd(1,0,'expense-1','food'),[debit('expense-1',{profileId:'other'})]),/Cross-profile/);
});

test('invalid category IDs, mutation IDs and unknown fields fail closed', () => {
  for (const bad of ['', '  ', ' x', 'x ', 'a'.repeat(161)]) {
    assert.throws(()=>apply(empty(),cmd(1,0,'expense-1',bad)),/Invalid category ID/);
  }
  assert.throws(()=>apply(empty(),{...cmd(1,0,'expense-1','food'),clientMutationId:'ABC'}),/mutation ID/);
  assert.throws(()=>apply(empty(),{...cmd(1,0,'expense-1','food'),payload:{transactionId:'expense-1',categoryId:'food',secret:true}}),/Invalid category command payload/);
});

test('serialized tampering with history, sequence and receipt is detected before replay', () => {
  let state=apply(empty(),cmd(1,0,'expense-1','food'));
  state=apply(state,cmd(2,1,'expense-1','travel'));
  const changed = transform => transform(structuredClone(state));
  assert.throws(()=>assertBudgetCategoryState(changed(s=>{s.assignments[0].categoryId='food';return s;})),/projection mismatch/);
  assert.throws(()=>assertBudgetCategoryState(changed(s=>{s.events[1].previousCategoryId=null;return s;})),/history mismatch/);
  assert.throws(()=>assertBudgetCategoryState(changed(s=>{s.receipts[1].transactionId='other';return s;})),/receipt does not match/);
  assert.throws(()=>assertBudgetCategoryState(changed(s=>{s.receipts[1].requestFingerprint='fake';return s;})),/receipt does not match/);
  assert.throws(()=>assertBudgetCategoryState(changed(s=>{s.receipts.pop();return s;})),/revision sequence/);
  assert.throws(()=>assertBudgetCategoryState(changed(s=>{s.revision=1;return s;})),/revision sequence/);
  assert.throws(()=>assertBudgetCategoryState(changed(s=>{s.receipts[1].clientMutationId=uuid(1);return s;})),/mutation ID/);
});

test('restored snapshot replays 3 categories in deterministic history order', () => {
  let s=empty();
  for(const [i,tx,category] of [[1,'expense-1','food'],[2,'debit-1','credit'],[3,'expense-1','transport']]){
    s=apply(s,cmd(i,s.revision,tx,category));
  }
  const saved=JSON.parse(JSON.stringify(s));
  assertBudgetCategoryState(saved);
  assert.deepEqual(saved.assignments.map(x=>[x.transactionId,x.categoryId]),[['debit-1','credit'],['expense-1','transport']]);
  const replay=applyBudgetCategoryCommand(saved,operations,cmd(1,0,'expense-1','food'));
  assert.equal(replay.replayed,true);
  assert.deepEqual(saved,s);
});

test('category reassignment changes the category report, never the total or ledger postings', async () => {
  const { calculateLedgerBudgetReport } = await import('../src/domain/budgets/ledger-adapter.ts');
  const total = { id: 'total', profileId, scope: { kind: 'total' }, limitMinor: 1_000_000,
    recurrence: 'monthly', fromMonth: '2026-01' };
  const rule = name => ({ id: name, profileId, scope: {kind: 'category', categoryId: name},
    limitMinor: 300_000, recurrence: 'monthly', fromMonth: '2026-01' });
  const ledger = { profileId, transactions: [{id:'expense-1',profileId,kind:'expense',
    occurredOn:'2026-01-15',reversedTransactionId:null}],
    postings: [{profileId,transactionId:'expense-1',accountId:'account-a',signedMinor:-150_000}],
    paymentLinks: [] };
  const unchanged = structuredClone(ledger);
  const rules = [total, rule('food'), rule('travel')];
  const initial = calculateLedgerBudgetReport({snapshot:ledger,month:'2026-01',rules});
  let state = apply(empty(),cmd(1,0,'expense-1','food'));
  const food = calculateLedgerBudgetReport({snapshot:ledger,month:'2026-01',rules,
    assignments:state.assignments});
  state = apply(state,cmd(2,1,'expense-1','travel'));
  const travel = calculateLedgerBudgetReport({snapshot:ledger,month:'2026-01',rules,
    assignments:state.assignments});
  assert.equal(initial.confirmedExpenseMinor,150_000);
  assert.equal(food.total.spentMinor,150_000);
  assert.equal(travel.total.spentMinor,150_000);
  assert.deepEqual(initial.categories.map(x=>x.spentMinor),[0,0]);
  assert.deepEqual(food.categories.map(x=>x.spentMinor),[150_000,0]);
  assert.deepEqual(travel.categories.map(x=>x.spentMinor),[0,150_000]);
  assert.deepEqual(ledger,unchanged);
});

test('previously committed category command replays after the debit was reversed', () => {
  const command=cmd(1,0,'expense-1','food');
  const first=applyBudgetCategoryCommand(empty(),operations,command);
  const laterLedger=[debit('expense-1'),debit('reversal-1',{
    kind:'reversal',signedMinor:150_000,reversedTransactionId:'expense-1' })];
  assert.throws(()=>apply(first.state,cmd(2,1,'expense-1','travel'),laterLedger),/Cannot reclassify reversed/);
  const replay=applyBudgetCategoryCommand(first.state,laterLedger,command);
  assert.equal(replay.replayed,true);
  assert.strictEqual(replay.state,first.state);
  assert.equal(replay.receipt.revision,1);
});

test('out-of-range signed amount cannot be reclassified', () => {
  assert.throws(()=>apply(empty(),cmd(1,0,'expense-1','food'),
    [debit('expense-1',{signedMinor:-1_000_000_000_001})]), /Only confirmed/);
});
