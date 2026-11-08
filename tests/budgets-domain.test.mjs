import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateBudgetReport, MAX_MINOR } from '../src/domain/budgets/index.ts';

const profileId = 'profile-a';
const total = (limitMinor = 1_000_000, other = {}) => ({
  id: 'total', profileId, scope: { kind: 'total' }, limitMinor,
  recurrence: 'monthly', fromMonth: '2026-01', ...other,
});
const category = (categoryId, limitMinor, other = {}) => ({
  id: `rule-${categoryId}`, profileId, scope: { kind: 'category', categoryId },
  limitMinor, recurrence: 'monthly', fromMonth: '2026-01', ...other,
});
const expense = (id, signedMinor, categoryId = 'food', occurredOn = '2026-01-15', other = {}) => ({
  id, profileId, occurredOn, kind: 'expense', status: 'confirmed',
  signedMinor, categoryId, ...other,
});
const calc = (operations = [], rules = [total()], month = '2026-01') =>
  calculateBudgetReport({ profileId, month, rules, operations });

test('10 000 ₽ limit minus 1 500 ₽ is 8 500 ₽, 15% used', () => {
  const result = calc([expense('groceries', -150_000)]);
  assert.equal(result.confirmedExpenseMinor, 150_000);
  assert.equal(result.total.limitMinor, 1_000_000);
  assert.equal(result.total.remainingMinor, 850_000);
  assert.equal(result.total.percentUsed, 15);
  assert.equal(result.total.exceeded, false);
});

test('overspending reports negative remainder, positive overrun and >100%', () => {
  const result = calc([expense('extra', -1_200_000)], [total(1_000_000)]).total;
  assert.deepEqual([result.remainingMinor, result.overrunMinor, result.exceeded, result.percentUsed],
    [-200_000, 200_000, true, 120]);
});

test('no operations means zero spend, full remainder and zero percent', () => {
  const result = calc([], [total(250_001)]);
  assert.equal(result.total.remainingMinor, 250_001);
  assert.equal(result.total.percentUsed, 0);
  assert.equal(result.confirmedExpenseMinor, 0);
  assert.equal(result.uncategorizedExpenseMinor, 0);
});

test('category limits remain independent from total without double-counting', () => {
  const result = calc([
    expense('a', -150_000, 'food'), expense('b', -200_000, 'transport'),
    expense('c', -50_000, null),
  ], [category('transport', 300_000), total(600_000), category('food', 200_000)]);
  assert.equal(result.confirmedExpenseMinor, 400_000);
  assert.equal(result.total.spentMinor, 400_000);
  assert.equal(result.uncategorizedExpenseMinor, 50_000);
  assert.deepEqual(result.categories.map(x => [x.scope.categoryId, x.spentMinor, x.remainingMinor]),
    [['food', 150_000, 50_000], ['transport', 200_000, 100_000]]);
});

test('moving an operation to another category changes only the attribution', () => {
  const original = expense('buy', -100_000, 'food');
  const rules = [total(), category('food', 200_000), category('transport', 200_000)];
  const first = calc([original], rules);
  const moved = calc([{ ...original, categoryId: 'transport' }], rules);
  assert.deepEqual(first.categories.map(x => x.spentMinor), [100_000, 0]);
  assert.deepEqual(moved.categories.map(x => x.spentMinor), [0, 100_000]);
  assert.equal(moved.total.remainingMinor, first.total.remainingMinor);
  assert.equal(original.categoryId, 'food');
});

test('cancellation removes original confirmed expense even if reversal posts next month', () => {
  const operations = [
    expense('old', -80_000, 'food', '2026-01-31'),
    { id: 'undo', profileId, occurredOn: '2026-02-02', kind: 'reversal',
      status: 'confirmed', signedMinor: 80_000, categoryId: null, reversedTransactionId: 'old' },
  ];
  assert.equal(calc(operations).total.spentMinor, 0);
  assert.equal(calc(operations, [total()], '2026-02').total.spentMinor, 0);
});

test('corrected expense amount/date is counted only once in replacement month', () => {
  const operations = [
    expense('original', -70_000, 'food', '2026-01-31'),
    { id: 'reversal', profileId, occurredOn: '2026-02-01', kind: 'reversal',
      status: 'confirmed', signedMinor: 70_000, categoryId: null, reversedTransactionId: 'original' },
    expense('replacement', -99_000, 'transport', '2026-02-01'),
  ];
  assert.equal(calc(operations).confirmedExpenseMinor, 0);
  assert.equal(calc(operations, [total()], '2026-02').confirmedExpenseMinor, 99_000);
});

test('planned/voided outflows remain separate from confirmed actual spending', () => {
  const operations = [
    expense('actual', -100_000),
    expense('forecast', -300_000, 'food', '2026-01-20', { status: 'planned' }),
    expense('canceled', -800_000, 'food', '2026-01-20', { status: 'voided' }),
  ];
  const result = calc(operations, [total(), category('food', 1_000_000)]);
  assert.equal(result.total.spentMinor, 100_000);
  assert.equal(result.total.plannedMinor, 300_000);
  assert.equal(result.total.remainingMinor, 900_000);
  assert.equal(result.categories[0].plannedMinor, 300_000);
});

test('own transfers, reserves, adjustments and income never count as expenses', () => {
  const ignored = [
    { ...expense('transfer', -90_000), kind: 'transfer', signedMinor: 0 },
    { ...expense('reserve', -20_000), kind: 'reserve' },
    { ...expense('adjustment', -500), kind: 'adjustment' },
    { ...expense('income', 10_000), kind: 'income' },
    { ...expense('inbound', 12_000), kind: 'payment', sourceFactId: 'settlement:inbound' },
  ];
  assert.equal(calc(ignored).confirmedExpenseMinor, 0);
});

test('a negative linked payment is an expense exactly once and fact key is unique', () => {
  const loan = { ...expense('loan', -25_000), kind: 'payment', sourceFactId: 'loanPayment:fact-1' };
  assert.equal(calc([loan]).confirmedExpenseMinor, 25_000);
  assert.throws(() => calc([loan, { ...loan, id: 'duplicated' }]), /Duplicate payment fact/);
});

test('monthly repetition, one-off expiry, archive and historical reports', () => {
  const once = { ...category('food', 150_000), recurrence: 'once', fromMonth: '2026-02' };
  const monthly = total(300_000, { archivedFromMonth: '2026-04' });
  const costs = [expense('jan', -10_000), expense('feb', -20_000, 'food', '2026-02-10')];
  assert.equal(calc(costs, [once, monthly], '2026-01').categories.length, 0);
  assert.equal(calc(costs, [once, monthly], '2026-02').categories[0].remainingMinor, 130_000);
  assert.equal(calc(costs, [once, monthly], '2026-03').categories.length, 0);
  assert.equal(calc(costs, [once, monthly], '2026-03').total.limitMinor, 300_000);
  assert.equal(calc(costs, [once, monthly], '2026-04').total, null);
  assert.equal(calc(costs, [once, monthly], '2026-01').total.spentMinor, 10_000);
});

test('exclusive endsBeforeMonth and duplicate active rules are deterministic', () => {
  const first = total(100_000, { endsBeforeMonth: '2026-03' });
  const next = total(200_000, { id: 'next', fromMonth: '2026-03' });
  assert.equal(calc([], [first, next], '2026-02').total.limitMinor, 100_000);
  assert.equal(calc([], [first, next], '2026-03').total.limitMinor, 200_000);
  assert.throws(() => calc([], [first, { ...next, fromMonth: '2026-02' }], '2026-02'),
    /Overlapping active budget rules/);
});

test('zero limit and one-kopeck values have correct boundary behavior', () => {
  assert.equal(calc([], [total(0)]).total.exceeded, false);
  assert.equal(calc([], [total(0)]).total.percentUsed, null);
  const result = calc([expense('cent', -1)], [total(0)]).total;
  assert.deepEqual([result.spentMinor, result.remainingMinor, result.overrunMinor,
    result.exceeded, result.percentUsed], [1, -1, 1, true, null]);
  assert.equal(calc([expense('max', -MAX_MINOR)], [total(MAX_MINOR)]).total.remainingMinor, 0);
});

test('unsafe amounts and overflowing total aggregates are rejected', () => {
  assert.throws(() => calc([], [total(0.25)]), RangeError);
  assert.throws(() => calc([expense('x', -0.25)]), RangeError);
  assert.throws(() => calc([expense('x', -(MAX_MINOR + 1))]), RangeError);
  assert.throws(() => calc([], [total(MAX_MINOR + 1)]), RangeError);
  const operations = Array.from({ length: 9_008 }, (_, i) => expense(`e-${i}`, -MAX_MINOR));
  assert.throws(() => calc(operations), /overflow/i);
});

test('repeat calculation never mutates inputs or accumulates spending', () => {
  const ops = Object.freeze([Object.freeze(expense('frozen', -40_000))]);
  const rules = Object.freeze([Object.freeze(total())]);
  const first = calc(ops, rules);
  assert.deepEqual(first, calc(ops, rules));
  assert.equal(first.total.spentMinor, 40_000);
  assert.equal(ops[0].signedMinor, -40_000);
});

test('duplicate transactions, invalid reversals, cross-profile inputs and bad dates fail closed', () => {
  const original = expense('x', -100);
  const reverse = { id: 'reverse', profileId, occurredOn: '2026-02-01',
    kind: 'reversal', status: 'confirmed', signedMinor: 100, categoryId: null,
    reversedTransactionId: 'x' };
  assert.throws(() => calc([original, original]), /Duplicate transaction ID/);
  assert.throws(() => calc([reverse]), /Orphan/);
  assert.throws(() => calc([original, reverse, { ...reverse, id: 'again' }]), /Double reversal/);
  assert.throws(() => calc([original, { ...reverse, signedMinor: 99 }]), /mismatch/);
  assert.throws(() => calc([expense('cross', -100, 'food', '2026-01-01', { profileId: 'another' })]), /Cross-profile/);
  assert.throws(() => calc([expense('invalid', -100, 'food', '2026-02-30')]), /Nonexistent/);
  assert.throws(() => calc([], [total(100, { recurrence: 'weekly' })]), /Invalid recurrence/);
  assert.throws(() => calc([], [total(100, { endsBeforeMonth: '2026-01' })]), /Invalid rule end month/);
  assert.throws(() => calc([], [total(), { ...total(), id: 'duplicate' }]), /Overlapping/);
});
