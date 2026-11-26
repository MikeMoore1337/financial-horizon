import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAnalyticsReport, compareAnalyticsToBudgets } from '../src/domain/analytics/index.ts';

const profile = '00000000-0000-4000-8000-000000000001';
const report = buildAnalyticsReport({
  from: '2026-01-01', to: '2026-03-31',
  transactions: [
    { id: 'jan-expense', kind: 'expense', signedMinor: -100_000, date: '2026-01-10', categoryId: 'food' },
    { id: 'feb-refund', kind: 'reversal', signedMinor: 100_000, date: '2026-02-02', reversedTransactionId: 'jan-expense' },
    { id: 'feb-replacement', kind: 'expense', signedMinor: -80_000, date: '2026-02-05', categoryId: 'food' },
  ],
  categories: [{ id: 'food', name: 'Продукты', archived: true }],
});
const usage = (month, limitMinor, spentMinor, scope = { kind: 'total' }, id = `${month}-budget`) => ({
  ruleId: id, scope, limitMinor, spentMinor, plannedMinor: 0,
  remainingMinor: limitMinor - spentMinor, overrunMinor: Math.max(0, spentMinor - limitMinor),
  percentUsed: limitMinor === 0 ? null : spentMinor / limitMinor * 100,
  exceeded: spentMinor > limitMinor,
});
const budget = (month, spentMinor, limitMinor, categorySpent = spentMinor) => ({
  profileId: profile, month, confirmedExpenseMinor: spentMinor, plannedExpenseMinor: 0,
  uncategorizedExpenseMinor: spentMinor - categorySpent,
  total: usage(month, limitMinor, spentMinor),
  categories: [usage(month, limitMinor, categorySpent, { kind: 'category', categoryId: 'food' }, `${month}-food`)],
});

test('distinct ledger cashflow and #35 budget consumption on cross-month reversal and replacement', () => {
  const data = [budget('2026-02', 80_000, 120_000), budget('2026-01', 0, 150_000, 0)];
  const original = structuredClone(data);
  const result = compareAnalyticsToBudgets(report, profile, data);
  assert.deepEqual(result.months.map(m => [m.month, m.ledgerCashflowExpenseMinor, m.budgetSpentMinor,
    m.limitMinor, m.budgetVarianceMinor, m.status]), [
    ['2026-01', 100_000, 0, 150_000, -150_000, 'complete'],
    ['2026-02', -20_000, 80_000, 120_000, -40_000, 'complete'],
    ['2026-03', null, null, null, null, 'absent'],
  ]);
  assert.equal(result.months[0].categoryBudgets[0].spentMinor, 0);
  assert.equal(result.months[1].categoryBudgets[0].spentMinor, 80_000);
  assert.equal(report.totals.expenseMinor, 80_000);
  assert.equal(result.months[0].budgetSpentMinor + result.months[1].budgetSpentMinor, 80_000);
  assert.deepEqual(data, original, 'never mutates authoritative #35 source');
  assert.deepEqual(compareAnalyticsToBudgets(report, profile, [...data].reverse()), result);
});

test('verified zero spending is different from an absent month or missing total limit', () => {
  const january = { ...budget('2026-01', 0, 150_000), total: null, categories: [] };
  const out = compareAnalyticsToBudgets(report, profile, [january]);
  assert.equal(out.months[0].budgetSpentMinor, 0);
  assert.equal(out.months[0].limitMinor, null);
  assert.equal(out.months[0].budgetVarianceMinor, null);
  assert.equal(out.months[1].status, 'absent');
  assert.equal(out.months[1].budgetSpentMinor, null);
});

test('incomplete calendar month never claims an entire #35 budget as partial facts', () => {
  const partial = buildAnalyticsReport({ from: '2026-01-17', to: '2026-02-18', transactions: [
    { id: 'first', kind: 'expense', signedMinor: -100, date: '2026-01-18' },
    { id: 'second', kind: 'expense', signedMinor: -200, date: '2026-02-02' },
  ] });
  const out = compareAnalyticsToBudgets(partial, profile, [budget('2026-01', 100, 500, 100), budget('2026-02', 200, 500, 200)]);
  assert.deepEqual(out.months.map(x => x.status), ['partial', 'partial']);
  assert.deepEqual(out.months.map(x => x.budgetSpentMinor), [null, null]);
  assert.deepEqual(out.months.map(x => x.ledgerCashflowExpenseMinor), [100, 200]);
});

test('rejects foreign profiles, duplicate months, missing dates and inconsistent budget facts', () => {
  const first = budget('2026-01', 1_000, 1_500);
  const reject = (value, pattern = /сводка бюджетов/) => assert.throws(
    () => compareAnalyticsToBudgets(report, profile, [value]), pattern,
  );
  reject({ ...first, profileId: 'foreign' });
  reject({ ...first, month: '2027-01' });
  reject({ ...first, month: '2026-13' });
  reject({ ...first, total: { ...first.total, spentMinor: 1_001 } });
  reject({ ...first, total: { ...first.total, remainingMinor: 0 } });
  reject({ ...first, total: { ...first.total, overrunMinor: 3 } });
  reject({ ...first, total: { ...first.total, exceeded: true } });
  reject({ ...first, confirmedExpenseMinor: -10 });
  reject({ ...first, confirmedExpenseMinor: 1.5 });
  reject({ ...first, uncategorizedExpenseMinor: 2000 });
  reject({ ...first, categories: [...first.categories, { ...first.categories[0], ruleId: 'duplicate' }] });
  assert.throws(() => compareAnalyticsToBudgets(report, profile, [first, first]), /повторный месяц/);
  assert.throws(() => compareAnalyticsToBudgets(report, profile, [first, budget('2026-01', 0, 100)]), /повторный месяц/);
});

test('archived category remains eligible, and zero total limit makes overrun explicit', () => {
  const january = budget('2026-01', 1_000, 0);
  const out = compareAnalyticsToBudgets(report, profile, [january]).months[0];
  assert.equal(out.overrunMinor, 1_000);
  assert.equal(out.remainingMinor, -1_000);
  assert.equal(out.budgetVarianceMinor, 1_000);
  assert.equal(out.categoryBudgets[0].categoryId, 'food');
});

test('early calendar years use ISO dates rather than Date.UTC year 0..99 coercion', () => {
  const early = buildAnalyticsReport({ from: '0099-02-01', to: '0099-02-28', transactions: [
    { id: 'early-expense', kind: 'expense', date: '0099-02-12', signedMinor: -1 },
  ] });
  const snapshot = budget('0099-02', 1, 500, 1);
  const output = compareAnalyticsToBudgets(early, profile, [snapshot]);
  assert.equal(output.months[0].status, 'complete');
  assert.equal(output.months[0].budgetSpentMinor, 1);
});
