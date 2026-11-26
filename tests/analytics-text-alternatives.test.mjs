import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAnalyticsReport, buildAnalyticsTextAlternatives, formatKopecks } from '../src/domain/analytics/index.ts';

function make(transactions, extra = {}) {
  return buildAnalyticsReport({
    from: '2026-01-01', to: '2026-02-28', transactions, ...extra,
  });
}

test('text alternatives accurately reuse chart values without re-aggregating postings', () => {
  const report = make([
    { id: 'salary', kind: 'income', date: '2026-01-02', signedMinor: 150_001 },
    { id: 'rent', kind: 'expense', date: '2026-01-03', signedMinor: -65_050, categoryId: 'rent' },
    { id: 'grocery', kind: 'expense', date: '2026-01-04', signedMinor: -34_951, categoryId: 'food' },
    { id: 'rev-rent', kind: 'reversal', date: '2026-02-01', signedMinor: 65_050,
      reversedTransactionId: 'rent' },
  ], { categories: [{ id: 'rent', name: 'Аренда', archived: true },
    { id: 'food', name: 'Продукты' }] });
  const text = buildAnalyticsTextAlternatives(report);
  assert.match(text.summary, /доходы 1 500,01 ₽, расходы 349,51 ₽, финансовый результат 1 150,50 ₽/);
  assert.deepEqual(text.cashflow.rows, [
    { month: '2026-01', income: '1 500,01 ₽', expense: '1 000,01 ₽', result: '500,00 ₽', status: 'Есть подтверждённые операции' },
    { month: '2026-02', income: '0,00 ₽', expense: '-650,50 ₽', result: '650,50 ₽', status: 'Есть подтверждённые операции' },
  ]);
  assert.equal(text.expenseShares.rows.length, 1);
  assert.deepEqual(text.expenseShares.rows[0], { category: 'Продукты', amount: '349,51 ₽', share: '100,00 %' });
  assert.equal(text.debt.emptyMessage, 'Нет подтверждённой истории задолженности за период.');
  assert.equal(text.savings.rows.length, 0);
  assert.equal(text.planFact.includes('недоступно'), true);
});

test('unknown and actual zero are distinct in accessible month rows', () => {
  const none = buildAnalyticsTextAlternatives(make([]));
  assert.match(none.summary, /нет подтверждённых доходов и расходов/);
  assert.deepEqual(none.cashflow.rows.map(row => row.income), ['Нет данных', 'Нет данных']);
  const reversed = make([
    { id: 'a', date: '2026-01-10', kind: 'expense', signedMinor: -50 },
    { id: 'b', date: '2026-01-12', kind: 'reversal', reversedTransactionId: 'a', signedMinor: 50 },
  ]);
  const text = buildAnalyticsTextAlternatives(reversed);
  assert.deepEqual(text.cashflow.rows.map(row => row.expense), ['0,00 ₽', 'Нет данных']);
  assert.equal(text.cashflow.emptyMessage, null);
  assert.equal(text.expenseShares.emptyMessage, 'Нет положительных итоговых расходов для диаграммы.');
});

test('confirmed debt and goal snapshots have exact dated textual alternatives', () => {
  const x = buildAnalyticsTextAlternatives(make([], {
    debtSnapshots: [{ date: '2026-01-31', balanceMinor: 105_000 },
      { date: '2026-02-28', balanceMinor: 88_060 }],
    savingsSnapshots: [{ date: '2026-02-01', balanceMinor: 15_011 }],
  }));
  assert.deepEqual(x.debt.rows, [
    { date: '2026-01-31', balance: '1 050,00 ₽' },
    { date: '2026-02-28', balance: '880,60 ₽' },
  ]);
  assert.deepEqual(x.savings.rows, [{ date: '2026-02-01', balance: '150,11 ₽' }]);
  assert.equal(x.savings.emptyMessage, null);
});

test('kopeck formatting is deterministic, exact, including negatives and safe integer extremes', () => {
  assert.equal(formatKopecks(0), '0,00 ₽');
  assert.equal(formatKopecks(-1), '-0,01 ₽');
  assert.equal(formatKopecks(100_000_001), '1 000 000,01 ₽');
  assert.equal(formatKopecks(Number.MAX_SAFE_INTEGER), '90 071 992 547 409,91 ₽');
  assert.equal(formatKopecks(null), 'Нет данных');
  for (const invalid of [NaN, Infinity, 1.4, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => formatKopecks(invalid), RangeError);
  }
});

test('user-provided category labels are kept as plain text, never interpreted as HTML', () => {
  const label = '<img src=x onerror=alert(1)>';
  const report = make([{ id: 'x', date: '2026-01-01', kind: 'expense', signedMinor: -100, categoryId: 'x' }],
    { categories: [{ id: 'x', name: label }] });
  const text = buildAnalyticsTextAlternatives(report);
  assert.equal(text.expenseShares.rows[0].category, label);
  assert.equal(text.expenseShares.rows[0].amount, '1,00 ₽');
  assert.equal(typeof text.expenseShares.rows[0].category, 'string');
  // HTML escaping is the consuming UI's responsibility (React text nodes), not this read-only model.
});
