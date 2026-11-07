import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateLoan, reconcileLoanSchedule } from '../src/domain/loans/index.ts';

const terms = {
  principalCents: 100_000,
  startDate: '2026-01-01',
  firstDueDate: '2026-02-01',
  termMonths: 4,
  annualRateMicroPercent: 0,
  dayCount: 'ACT/365F',
  rounding: 'HALF_UP',
  scheduleType: 'annuity',
  maxExtensionMonths: 0,
};
const pay = (date, amountCents, id = 'pay') => ({
  id, date, type: 'payment', paymentKind: 'regular', amountCents,
});

test('full settlement on the scheduled due date is retained as the last factual row', () => {
  const result = calculateLoan(terms, [pay('2026-02-01', 100_000)], {
    mode: 'actual', asOfDate: '2026-02-02',
  });
  assert.equal(result.complete, true);
  assert.equal(result.paidOffDate, '2026-02-01');
  assert.deepEqual(result.rows.map(row => ({
    date: row.date, amountCents: row.amountCents,
    principalCents: row.principalCents, balanceCents: row.balanceCents,
  })), [
    { date: '2026-02-01', amountCents: 100_000,
      principalCents: 100_000, balanceCents: 0 },
  ]);
  const compared = reconcileLoanSchedule(result.rows, [{
    date: '2026-02-01', amountCents: 100_000, interestCents: 0,
    principalCents: 100_000, balanceCents: 0,
  }]);
  assert.equal(compared.exactMatch, true);
  assert.equal(compared.calculatedClosureDate, '2026-02-01');
});

test('full early settlement is never falsely dated as the next scheduled installment', () => {
  const result = calculateLoan(terms, [pay('2026-01-10', 100_000)], {
    mode: 'actual', asOfDate: '2026-01-15',
  });
  assert.equal(result.paidOffDate, '2026-01-10');
  assert.equal(result.rows.length, 0);
  assert.equal(result.actualOpenPeriod?.amountCents, 100_000);
});

test('stable, deterministic, seeded amortization conservation across 100 synthetic cases', () => {
  // This is a pure conservation oracle, independent of any bank-specific rules.
  let seed = 0x39aa2026;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  const started = process.hrtime.bigint();
  for (let i = 0; i < 100; i++) {
    const principal = 1 + (next() % 2_000_000);
    const months = 1 + (next() % 24);
    const rate = (next() % 31) * 1_000_000;
    const conventional = ['ACT/365F', 'ACT/360', 'ACT/ACT-ISDA', '30E/360'][next() % 4];
    const input = { ...terms, principalCents: principal, termMonths: months,
      annualRateMicroPercent: rate, dayCount: conventional, maxExtensionMonths: 0 };
    const result = calculateLoan(input, [], { mode: 'plan' });
    assert.equal(result.complete, true, 'case ' + i);
    assert.equal(result.rows.length, months, 'case ' + i);
    assert.equal(result.principalBalanceCents, 0, 'case ' + i);
    assert.equal(result.unpaidInterestCents, 0, 'case ' + i);
    assert.equal(result.remainingDebtCents, 0, 'case ' + i);
    assert.equal(result.paidOffDate, result.rows.at(-1)?.date, 'case ' + i);
    const principalPaid = result.rows.reduce((sum, row) => sum + row.principalCents, 0);
    assert.equal(principalPaid, principal, 'case ' + i);
    let lastBalance = principal;
    for (const row of result.rows) {
      assert.equal(row.amountCents, row.principalCents + row.interestPaidCents, 'case ' + i);
      assert.equal(row.balanceCents, lastBalance - row.principalCents, 'case ' + i);
      assert.ok(row.balanceCents >= 0 && row.interestCents >= 0, 'case ' + i);
      assert.ok(row.balanceCents <= lastBalance, 'case ' + i);
      lastBalance = row.balanceCents;
    }
    assert.deepEqual(calculateLoan(input, [], { mode: 'plan' }), result, 'replay ' + i);
  }
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(Number.isFinite(elapsed) && elapsed >= 0);
});

test('bank CSV without interest/principal never claims exact match', () => {
  const plan = calculateLoan(terms, [], { mode: 'plan' });
  const partial = plan.rows.map(row => ({
    date: row.date, amountCents: row.amountCents, balanceCents: row.balanceCents,
  }));
  const result = reconcileLoanSchedule(plan.rows, partial);
  assert.equal(result.matchingKnownFields, true);
  assert.equal(result.comparisonComplete, false);
  assert.equal(result.exactMatch, false);
  assert.equal(result.mismatchedRows, 0);
  assert.deepEqual(result.rows[0].missingFields, ['interestCents', 'principalCents']);
});

test('bank allocation gap remains visible instead of rejecting fee-bearing schedules', () => {
  const plan = calculateLoan(terms, [], { mode: 'plan' });
  const first = plan.rows[0];
  const bank = [{
    date: first.date, amountCents: first.amountCents + 50,
    interestCents: first.interestCents,
    principalCents: first.principalCents,
    balanceCents: first.balanceCents,
  }];
  const result = reconcileLoanSchedule([first], bank);
  assert.equal(result.rows[0].bankUnallocatedCents, 50);
  assert.equal(result.rows[0].amountDeltaCents, -50);
  assert.equal(result.exactMatch, false);
});
