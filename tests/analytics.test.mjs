import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAnalyticsReport, percentageChangeBps, compareReportMonths, compareReportPeriods,
  exportAnalyticsCsv,
} from '../src/domain/analytics/index.ts';

const tx = (id, date, kind, signedMinor, categoryId = null, extra = {}) =>
  ({ id, date, kind, signedMinor, categoryId, ...extra });
const report = (transactions = [], extras = {}) => buildAnalyticsReport({
  from: '2026-01-01', to: '2026-03-31', transactions, ...extras,
});
const income = tx('income', '2026-01-02', 'income', 300_000, 'salary');
const expense = tx('expense', '2026-01-03', 'expense', -125_000, 'food');

// Independent cash oracle: 300000 inflow - (125000 + 25000) outflow = 150000 net.
test('sums actual ledger entries, groups categories, and reconciles chart totals', () => {
  const x = report([income, expense, tx('rent', '2026-01-18', 'expense', -25_000, 'rent')], {
    categories: [{ id: 'food', name: 'Продукты', archived: true }, { id: 'rent', name: 'Жильё' }],
  });
  assert.deepEqual([x.totals.incomeMinor, x.totals.expenseMinor, x.totals.netMinor], [300000, 150000, 150000]);
  assert.equal(x.categories.reduce((sum, item) => sum + item.incomeMinor, 0), x.totals.incomeMinor);
  assert.equal(x.categories.reduce((sum, item) => sum + item.expenseMinor, 0), x.totals.expenseMinor);
  assert.equal(x.monthly.reduce((sum, item) => sum + item.netMinor, 0), x.totals.netMinor);
  assert.equal(x.categories.find(item => item.categoryId === 'food').archived, true);
  assert.deepEqual(x.topExpenses.map(item => item.categoryId), ['food', 'rent']);
  assert.deepEqual(x.charts.cashflow.map(item => item.netMinor), [150000, null, null]);
  assert.equal(x.charts.expenseShares.reduce((sum, row) => sum + row.shareBps, 0), 10000);
});

test('two-leg transfer, reservation and balance adjustment never enter incomes or expenses', () => {
  const x = report([income, expense,
    tx('transfer', '2026-01-03', 'transfer', 0, null),
    tx('reserved', '2026-01-04', 'reservation', 0),
    tx('adjust', '2026-01-06', 'adjustment', -6000),
  ]);
  assert.deepEqual([x.totals.incomeMinor, x.totals.expenseMinor, x.totals.netMinor], [300000, 125000, 175000]);
  assert.equal(x.categories.length, 2);
  assert.throws(() => report([tx('bad', '2026-01-02', 'transfer', 100)]), /Перевод/);
  assert.throws(() => report([tx('bad', '2026-01-02', 'reservation', -100)]), /Перевод/);
});

test('income and expense payment facts are counted once, separately from planned obligations', () => {
  const x = report([tx('payment1', '2026-01-02', 'payment', -12345, 'loan'),
    tx('payment2', '2026-01-05', 'payment', 60000, 'income')]);
  assert.equal(x.totals.incomeMinor, 60000);
  assert.equal(x.totals.expenseMinor, 12345);
  assert.throws(() => report([income, income]), /Двойной учёт/);
});

test('logical void excludes an entry without a reversal', () => {
  const x = report([income, tx('cancelled', '2026-01-14', 'expense', -8000, 'food',
    { voidedAt: '2026-01-15T12:00:00.000Z' })]);
  assert.equal(x.totals.expenseMinor, 0);
  assert.equal(x.totals.incomeMinor, 300000);
});

test('compensating reversal goes to its own month and original expense category', () => {
  const original = tx('exp', '2026-01-29', 'expense', -10000, 'food');
  const reversal = tx('rev', '2026-02-02', 'reversal', 10000, null, { reversedTransactionId: 'exp' });
  const x = report([reversal, original]);
  assert.deepEqual(x.monthly.map(item => item.expenseMinor), [10000, -10000, 0]);
  assert.equal(x.totals.expenseMinor, 0);
  assert.equal(x.categories[0].categoryId, 'food');
  assert.equal(x.monthly[1].netMinor, 10000);
  assert.equal(x.charts.expenseShares.length, 0);
});

test('reversed income, reversed transfer, and amended expense use immutable source classification', () => {
  const entries = [tx('rev1', '2026-03-01', 'reversal', -5000, null, { reversedTransactionId: 'inc1' }),
    tx('inc1', '2026-01-01', 'income', 5000, 'work'),
    tx('t1', '2026-01-02', 'transfer', 0),
    tx('rev-t', '2026-01-03', 'reversal', 0, null, { reversedTransactionId: 't1' }),
    tx('exp1', '2026-01-10', 'expense', -3000, 'other'),
    tx('rev-exp', '2026-02-01', 'reversal', 3000, null, { reversedTransactionId: 'exp1' }),
    tx('exp2', '2026-02-01', 'expense', -3000, 'food')];
  const x = report(entries);
  assert.equal(x.totals.incomeMinor, 0);
  assert.equal(x.totals.expenseMinor, 3000);
  assert.equal(x.categories.find(item => item.categoryId === 'food').expenseMinor, 3000);
  assert.equal(x.categories.find(item => item.categoryId === 'other').expenseMinor, 0);
});

test('rejects invalid reversal relationships and double counting', () => {
  const original = tx('e', '2026-01-01', 'expense', -4000, 'x');
  const reversed = tx('r', '2026-02-01', 'reversal', 4000, null, { reversedTransactionId: 'e' });
  assert.throws(() => report([reversed]), /исходная операция/);
  assert.throws(() => report([original, reversed, { ...reversed, id: 'r2' }]), /двойная компенсация/);
  assert.throws(() => report([original, { ...reversed, signedMinor: 3999 }]), /не соответствует/);
  assert.throws(() => report([original, { ...reversed, categoryId: 'fake' }]), /не соответствует/);
  assert.throws(() => report([{ ...original, voidedAt: '2026-01-02' }, reversed]), /двойная компенсация/);
});

test('month boundaries and leap-day input validation are UTC-independent', () => {
  const x = buildAnalyticsReport({ from: '2028-02-28', to: '2028-03-01',
    transactions: [tx('a', '2028-02-28', 'income', 1), tx('b', '2028-02-29', 'expense', -2),
      tx('c', '2028-03-01', 'income', 3), tx('d', '2028-03-02', 'income', 100)] });
  assert.deepEqual(x.monthly.map(item => [item.month, item.incomeMinor, item.expenseMinor]),
    [['2028-02', 1, 2], ['2028-03', 3, 0]]);
  for (const invalid of ['2026-02-29', '2026-02-30', '2026-13-01', 'no', '0000-01-01']) {
    assert.throws(() => buildAnalyticsReport({ from: invalid, to: '2026-12-31', transactions: [] }));
  }
  assert.throws(() => buildAnalyticsReport({ from: '2026-05-01', to: '2026-04-30', transactions: [] }));
});

test('full-month plans are separate from category budgets and missing plans remain null', () => {
  const plans = [
    { id: 'overall', month: '2026-01', direction: 'expense', scope: 'total', amountMinor: 200_000 },
    { id: 'cat', month: '2026-01', direction: 'expense', scope: 'category', categoryId: 'food', amountMinor: 50_000 },
  ];
  const x = buildAnalyticsReport({ from: '2026-01-01', to: '2026-01-31', transactions: [expense], plans });
  assert.deepEqual([x.totals.plannedExpenseMinor, x.totals.expenseMinor, x.totals.expenseVarianceMinor],
    [200000, 125000, -75000]);
  assert.equal(x.categories.find(item => item.categoryId === 'food').plannedExpenseMinor, 50000);
  assert.equal(x.categories.find(item => item.categoryId === 'food').hasActual, true);
  assert.equal(x.monthly[0].plannedIncomeMinor, null);
  const planOnly = buildAnalyticsReport({ from: '2026-01-01', to: '2026-01-31', transactions: [], plans });
  assert.equal(planOnly.categories[0].hasActual, false);
  assert.ok(exportAnalyticsCsv(planOnly).includes(';"нет"'));
  const partlyCovered = report([expense], { plans });
  assert.equal(partlyCovered.totals.plannedExpenseMinor, null);
  assert.equal(partlyCovered.monthly[0].plannedExpenseMinor, 200000);
  const partialCalendar = buildAnalyticsReport({ from: '2026-01-15', to: '2026-01-31', transactions: [expense], plans });
  assert.equal(partialCalendar.monthly[0].plannedExpenseMinor, null);
  assert.equal(partialCalendar.categories[0].plannedExpenseMinor, null);
});

test('percentage changes are exact integer basis points; undefined from zero or no history', () => {
  assert.equal(percentageChangeBps(12500, 10000), 2500);
  assert.equal(percentageChangeBps(5000, 10000), -5000);
  assert.equal(percentageChangeBps(-150, -100), -5000);
  assert.equal(percentageChangeBps(1, 0), null);
  assert.equal(percentageChangeBps(0, 0), null);
  assert.equal(percentageChangeBps(3, 2), 5000);
  assert.equal(percentageChangeBps(2, 3), -3333);
  const x = report([income, tx('next', '2026-02-01', 'income', 600000)]);
  assert.equal(compareReportMonths(x, '2026-02', '2026-01').income.changeBps, 10000);
  assert.equal(compareReportMonths(x, '2026-03', '2026-02').hasComparableHistory, false);
  assert.equal(compareReportMonths(x, '2026-03', '2026-02').income.changeBps, null);
  assert.throws(() => compareReportMonths(x, '2026-04', '2026-01'));
  assert.equal(compareReportPeriods(report([]), report([income])).hasComparableHistory, false);
});

test('absent history explicitly differs from actual zero and from unconfigured plans', () => {
  const x = report([]);
  assert.equal(x.totals.hasActual, false);
  assert.deepEqual(x.monthly.map(item => item.hasActual), [false, false, false]);
  assert.deepEqual(x.charts.cashflow.map(item => item.expenseMinor), [null, null, null]);
  assert.equal(x.totals.expenseMinor, 0);
  assert.equal(x.totals.plannedExpenseMinor, null);
  assert.equal(x.hasDebtHistory, false);
  assert.equal(x.hasSavingsHistory, false);
});

test('debt and savings history are separate sorted verified snapshots with explicit gaps', () => {
  const x = report([], {
    debtSnapshots: [{ date: '2026-03-31', balanceMinor: 80000 }, { date: '2026-01-31', balanceMinor: 100000 }],
    savingsSnapshots: [{ date: '2025-12-31', balanceMinor: 5000 }, { date: '2026-03-01', balanceMinor: 7000 }],
  });
  assert.deepEqual(x.charts.debt.map(point => point.date), ['2026-01-31', '2026-03-31']);
  assert.deepEqual(x.savings, [{ date: '2026-03-01', balanceMinor: 7000 }]);
  assert.equal(x.hasDebtHistory, true);
  assert.throws(() => report([], { debtSnapshots: [
    { date: '2026-01-01', balanceMinor: 1 }, { date: '2026-01-01', balanceMinor: 1 }] }), /Дублированный/);
  assert.throws(() => report([], { savingsSnapshots: [{ date: '2026-01-01', balanceMinor: -1 }] }), /целая сумма/);
});

test('category shares sum exactly to 10000 basis points, ignoring refunds in pie only', () => {
  const x = report([tx('a', '2026-01-01', 'expense', -1, 'a'),
    tx('b', '2026-01-01', 'expense', -1, 'b'),
    tx('c', '2026-01-01', 'expense', -1, 'c'),
    tx('d', '2026-01-01', 'expense', -4, 'd'),
    tx('rev', '2026-02-01', 'reversal', 4, null, { reversedTransactionId: 'd' })]);
  assert.equal(x.totals.expenseMinor, 3);
  assert.deepEqual(x.charts.expenseShares.map(item => item.shareBps), [3334, 3333, 3333]);
  assert.equal(x.charts.expenseShares.reduce((sum, item) => sum + item.shareBps, 0), 10000);
});

test('CSV export is local, aggregate-only, quotes delimiters and neutralizes formula injection', () => {
  const attacks = ['=2+2', '\t+HYPERLINK(1)', '   -cmd', '\u200b@SUM(1)', '";\n=1+1'];
  const x = report(attacks.map((name, i) => tx(`expense${i}`, '2026-01-01', 'expense', -100, `cat${i}`)), {
    categories: attacks.map((name, i) => ({ id: `cat${i}`, name })),
  });
  const csv = exportAnalyticsCsv(x);
  assert.ok(csv.startsWith('\uFEFF"Дата";'));
  assert.ok(csv.includes('"\'=2+2"'));
  assert.ok(csv.includes('"\'\t+HYPERLINK(1)"'));
  assert.ok(csv.includes('"\'   -cmd"'));
  assert.ok(csv.includes('"\'\u200b@SUM(1)"'));
  assert.ok(csv.includes('""";\n=1+1"')); // Quoted embedded quote and linebreak.
  assert.doesNotMatch(csv, /actorUserId|profileId|clientMutationId|accountId/);
  assert.ok(csv.endsWith('\r\n'));
  assert.deepEqual(csv, exportAnalyticsCsv(x));
});

test('large history remains deterministic irrespective of input order', () => {
  const big = Array.from({ length: 50_000 }, (_, i) =>
    tx(`tx${i}`, `2026-${String(i % 3 + 1).padStart(2, '0')}-01`, i % 2 ? 'expense' : 'income', i % 2 ? -10 : 20, 'c'));
  const first = report(big);
  const second = report(big.toReversed());
  assert.deepEqual(first, second);
  assert.deepEqual([first.totals.incomeMinor, first.totals.expenseMinor, first.totals.netMinor],
    [500000, 250000, 250000]);
});

test('strict validation rejects floats, unsafe sums, duplicates, invalid plans and broken types', () => {
  assert.throws(() => report([tx('float', '2026-01-01', 'income', 1.1)]), RangeError);
  assert.throws(() => report([tx('unsafe', '2026-01-01', 'income', Number.MAX_SAFE_INTEGER)]), RangeError);
  assert.throws(() => report(Array.from({ length: 10_000 }, (_, i) =>
    tx(`big${i}`, '2026-01-01', 'income', 1_000_000_000_000))), /Переполнение/);
  const plan = { id: 'p', month: '2026-01', direction: 'expense', scope: 'total', amountMinor: 100 };
  assert.throws(() => report([], { plans: [plan, { ...plan, id: 'p2' }] }), /Повторяющийся план/);
  assert.throws(() => report([], { plans: [{ ...plan, amountMinor: -1 }] }), RangeError);
  assert.throws(() => report([], { categories: [{ id: 'a', name: 'A' }, { id: 'a', name: 'B' }] }), RangeError);
  assert.throws(() => buildAnalyticsReport({ from: '2026-01-01', to: '2026-01-01', transactions: null }), TypeError);
});
