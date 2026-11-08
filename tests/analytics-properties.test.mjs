import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAnalyticsReport, exportAnalyticsCsv } from '../src/domain/analytics/index.ts';

// Independent ledger posting oracle. Each generated record has an explicit,
// signed consolidated cash effect, not a second call to the reporting engine.
const dates = ['2025-12-31', '2026-01-01', '2026-01-31', '2026-02-01',
  '2026-02-28', '2026-03-01', '2026-03-31', '2026-04-01'];
const groups = ['housing', 'food', 'transport', null];
const months = ['2026-01', '2026-02', '2026-03'];
let seed = 0x41C0FFEE;
function random(n) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed % n;
}
function choose(xs) { return xs[random(xs.length)]; }
function accumulate(groupsMap, id, direction, signed) {
  const existing = groupsMap.get(id) ?? { income: 0n, expense: 0n };
  if (direction === 'income') existing.income += BigInt(signed);
  else if (direction === 'expense') existing.expense -= BigInt(signed);
  groupsMap.set(id, existing);
}
function signedDirection(original) {
  if (original.kind === 'income' || original.kind === 'payment' && original.signedMinor > 0) return 'income';
  if (original.kind === 'expense' || original.kind === 'payment' && original.signedMinor < 0) return 'expense';
  return null;
}
function oracle(transactions) {
  const monthTotals = new Map(months.map(m => [m, { income: 0n, expense: 0n }]));
  const catTotals = new Map();
  const originals = new Map(transactions.map(t => [t.id, t]));
  for (const t of transactions) {
    if (t.date < '2026-01-01' || t.date > '2026-03-31') continue;
    const source = t.kind === 'reversal' ? originals.get(t.reversedTransactionId) : t;
    const dir = signedDirection(source);
    if (!dir) continue;
    accumulate(monthTotals, t.date.slice(0, 7), dir, t.signedMinor);
    accumulate(catTotals, source.categoryId, dir, t.signedMinor);
  }
  return { monthTotals, catTotals };
}

test('1000 seeded synthetic journals agree with an independent BigInt cash oracle and are order-invariant', () => {
  for (let trial = 0; trial < 1000; trial++) {
    const records = [];
    const reversals = [];
    const count = 1 + random(25);
    for (let i = 0; i < count; i++) {
      const id = `record-${trial}-${i}`;
      const kind = choose(['income', 'expense', 'payment', 'transfer', 'adjustment']);
      const direction = kind === 'income' ? 1 : kind === 'expense' ? -1
        : kind === 'payment' ? (random(2) ? 1 : -1) : kind === 'adjustment' ? (random(2) ? 1 : -1) : 0;
      const signedMinor = (1 + random(1_000_000)) * direction;
      const dateIndex = random(dates.length - 1);
      const original = { id, date: dates[dateIndex], kind, signedMinor, categoryId: choose(groups) };
      records.push(original);
      if (random(4) === 0) {
        reversals.push({ id: `reverse-${trial}-${i}`, kind: 'reversal', signedMinor: -signedMinor,
          date: dates[dateIndex + random(dates.length - dateIndex)], categoryId: null,
          reversedTransactionId: id });
      }
    }
    const input = [...records, ...reversals];
    const parameters = { from: '2026-01-01', to: '2026-03-31' };
    const report = buildAnalyticsReport({ ...parameters, transactions: input });
    const opposite = buildAnalyticsReport({ ...parameters, transactions: input.toReversed() });
    assert.deepEqual(report, opposite, `trial ${trial}: permutation changed report`);
    const expected = oracle(input);
    for (const row of report.monthly) {
      const e = expected.monthTotals.get(row.month);
      assert.equal(BigInt(row.incomeMinor), e.income, `trial ${trial} income ${row.month}`);
      assert.equal(BigInt(row.expenseMinor), e.expense, `trial ${trial} expense ${row.month}`);
      assert.equal(BigInt(row.netMinor), e.income - e.expense, `trial ${trial} net ${row.month}`);
    }
    for (const row of report.categories) {
      const e = expected.catTotals.get(row.categoryId);
      assert.equal(BigInt(row.incomeMinor), e.income, `trial ${trial} income category`);
      assert.equal(BigInt(row.expenseMinor), e.expense, `trial ${trial} expense category`);
    }
    const sum = report.monthly.reduce((a, r) => a + BigInt(r.netMinor), 0n);
    assert.equal(BigInt(report.totals.netMinor), sum, `trial ${trial} total net`);
    const positives = report.charts.expenseShares;
    if (positives.length) assert.equal(positives.reduce((n, s) => n + s.shareBps, 0), 10_000);
    assert.equal(exportAnalyticsCsv(report), exportAnalyticsCsv(opposite));
  }
});
