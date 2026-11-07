import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateLoan, reconcileLoanSchedule, calendarDays, interestNumerator,
  INTEREST_DENOMINATOR, roundFraction,
} from '../src/domain/loans/index.ts';

const base = {
  principalCents: 1_000_000,
  startDate: '2026-01-01',
  firstDueDate: '2026-02-01',
  termMonths: 12,
  annualRateMicroPercent: 12_000_000,
  dayCount: 'ACT/365F',
  rounding: 'HALF_UP',
  scheduleType: 'annuity',
  maxExtensionMonths: 48,
};
const plan = (terms = base, events = []) => calculateLoan(terms, events, { mode: 'plan' });
const actual = (events, asOfDate = '2026-03-01', terms = base) =>
  calculateLoan(terms, events, { mode: 'actual', asOfDate });
const forecast = (events, asOfDate = '2026-01-20', terms = base) =>
  calculateLoan(terms, events, { mode: 'forecast', asOfDate });
const pay = (id, date, amountCents, paymentKind = 'regular', strategy) =>
  ({ id, date, type: 'payment', paymentKind, amountCents, ...(strategy && { strategy }) });

// Independent exact integer oracle, not a call to the calculation engine itself.
function simpleDailyInterest(cents, annualRateMicroPercent, days, divisor) {
  const numerator = BigInt(cents) * BigInt(annualRateMicroPercent) * BigInt(days);
  const denominator = 100_000_000n * BigInt(divisor);
  return Number((numerator * 2n + denominator) / (2n * denominator));
}

test('zero APR: equal installments with final cent correction, calendar month anchor', () => {
  const loan = plan({ ...base, principalCents: 100_001, annualRateMicroPercent: 0,
    startDate: '2026-01-01', firstDueDate: '2026-01-31', termMonths: 3,
    maxExtensionMonths: 0 });
  assert.deepEqual(loan.rows.map(r => [r.date, r.amountCents, r.interestCents, r.balanceCents]), [
    ['2026-01-31', 33334, 0, 66667],
    ['2026-02-28', 33334, 0, 33333],
    ['2026-03-31', 33333, 0, 0],
  ]);
  assert.equal(loan.complete, true);
  assert.equal(loan.paidOffDate, '2026-03-31');
  assert.equal(loan.bankParityVerified, false);
});

test('day-count conventions and exact long interest segments including leap year', () => {
  assert.equal(simpleDailyInterest(1_000_000, 12_000_000, 31, 365), 10192);
  const expected = [
    ['ACT/365F', 10192],
    ['ACT/360', 10333],
    ['ACT/ACT-ISDA', 10192],
    ['30E/360', 10000], // 01 Jan -> 01 Feb = 30/360, unlike actual 31 days.
  ];
  for (const [dayCount, interest] of expected) {
    const x = plan({ ...base, dayCount, paymentCents: 110_000 });
    assert.equal(x.rows[0].interestCents, interest, dayCount);
    assert.equal(x.rows[0].balanceCents, 1_000_000 - (110_000 - interest));
  }
  assert.equal(calendarDays('2028-02-28', '2028-03-01'), 2);
  const leap = plan({ ...base, startDate: '2028-02-01', firstDueDate: '2028-03-01',
    dayCount: 'ACT/ACT-ISDA', paymentCents: 110_000 });
  assert.equal(leap.rows[0].interestCents, simpleDailyInterest(1_000_000, 12_000_000, 29, 366));
  const acrossYear = interestNumerator(1_000_000, 12_000_000,
    '2027-12-31', '2028-01-02', 'ACT/ACT-ISDA');
  assert.equal(Number(roundFraction(acrossYear, INTEREST_DENOMINATOR, 'HALF_UP')), 657);
});

test('non-compounding interest: no factual payment means no principal reduction', () => {
  const result = actual([], '2026-03-01');
  assert.equal(result.principalBalanceCents, 1_000_000);
  assert.equal(result.rows.length, 2);
  assert.deepEqual(result.rows.map(r => r.amountCents), [0, 0]);
  assert.equal(result.unpaidInterestCents, simpleDailyInterest(1_000_000, 12_000_000, 59, 365));
  assert.equal(result.complete, false);
  assert.equal(result.paidOffDate, null);
});

test('partial payment and midperiod prepayment allocate interest before principal', () => {
  const first = pay('p1', '2026-01-16', 200_000, 'extra', 'shorten-term');
  const paid = actual([first], '2026-01-20');
  assert.equal(paid.history.length, 1);
  assert.equal(paid.history[0].interestPaidCents,
    simpleDailyInterest(1_000_000, 12_000_000, 15, 365));
  assert.equal(paid.history[0].principalPaidCents, 200_000 - paid.history[0].interestPaidCents);
  assert.equal(paid.principalBalanceCents, 1_000_000 - paid.history[0].principalPaidCents);
  assert.ok(paid.accruedInterestCents > 0);
  const tiny = actual([pay('tiny', '2026-02-01', 100)], '2026-02-01');
  assert.equal(tiny.principalBalanceCents, 1_000_000);
  assert.equal(tiny.unpaidInterestCents, 10192 - 100);
});

test('replay strategy shortens term or lowers payment without changing historical ledger', () => {
  const extra = pay('extra', '2026-02-15', 300_000, 'extra', 'shorten-term');
  const shorter = forecast([extra], '2026-02-15');
  const lower = forecast([{ ...extra, strategy: 'reduce-payment' }], '2026-02-15');
  const baseline = plan();
  assert.equal(shorter.complete, true);
  assert.equal(lower.complete, true);
  assert.ok(shorter.rows.length < lower.rows.length);
  assert.equal(lower.rows.at(-1).date, baseline.rows.at(-1).date);
  assert.ok(lower.scheduledPaymentCents < shorter.scheduledPaymentCents);
  assert.deepEqual(shorter.history.map(h => h.principalPaidCents), lower.history.map(h => h.principalPaidCents));
});

test('rate effective midperiod splits exact day fractions; void reverses event', () => {
  const change = { id: 'rate-1', type: 'rate-change', date: '2026-01-16', annualRateMicroPercent: 24_000_000 };
  const changed = plan({ ...base, paymentCents: 110_000, rateChangePolicy: 'keep-payment' }, [change]);
  const expected = Number(roundFraction(
    interestNumerator(1_000_000, 12_000_000, '2026-01-01', '2026-01-16', 'ACT/365F') +
    interestNumerator(1_000_000, 24_000_000, '2026-01-16', '2026-02-01', 'ACT/365F'),
    INTEREST_DENOMINATOR, 'HALF_UP'));
  assert.equal(changed.rows[0].interestCents, expected);
  const voided = plan({ ...base, paymentCents: 110_000 }, [{ ...change, voidedAt: '2026-03-01T12:00Z' }]);
  assert.equal(voided.rows[0].interestCents, 10192);
  assert.ok(changed.rows[0].interestCents > voided.rows[0].interestCents);
});

test('due-date change begins next calendar month and can be reverted', () => {
  const change = { id: 'day', type: 'due-date-change', date: '2026-02-10', dayOfMonth: 31 };
  const changed = plan({ ...base, paymentCents: 110_000 }, [change]);
  assert.deepEqual(changed.rows.slice(0, 4).map(r => r.date),
    ['2026-02-01', '2026-03-31', '2026-04-30', '2026-05-31']);
  const voided = plan({ ...base, paymentCents: 110_000 }, [{ ...change, voidedAt: '2026-02-15' }]);
  assert.equal(voided.rows[1].date, '2026-03-01');
});

test('differentiated schedule has fixed principal part, shrinking interest', () => {
  const x = plan({ ...base, scheduleType: 'differentiated', termMonths: 4,
    maxExtensionMonths: 0 });
  assert.equal(x.rows.length, 4);
  assert.deepEqual(x.rows.map(r => r.principalCents), [250_000, 250_000, 250_000, 250_000]);
  assert.ok(x.rows[0].interestCents > x.rows[1].interestCents);
  assert.equal(x.rows[3].balanceCents, 0);
});

test('factual and forecast distinguish skipped due dates and voided payment', () => {
  const payment = pay('regular', '2026-02-01', 110_000);
  const paymentVoid = { ...payment, voidedAt: '2026-02-03T00:00Z' };
  assert.equal(actual([payment], '2026-02-02').rows[0].amountCents, 110_000);
  assert.equal(actual([paymentVoid], '2026-02-02').rows[0].amountCents, 0);
  const forecasted = forecast([paymentVoid], '2026-02-03');
  assert.equal(forecasted.rows[0].kind, 'actual');
  assert.equal(forecasted.rows[0].amountCents, 0);
  assert.equal(forecasted.rows[1].kind, 'forecast');
  assert.ok(forecasted.rows[1].amountCents > 0);
  assert.equal(forecasted.rows[0].balanceCents, 1_000_000);
});

test('overpayment closes exactly, stops schedule; future factual payment is rejected', () => {
  const loan = { ...base, annualRateMicroPercent: 0, termMonths: 4, maxExtensionMonths: 4 };
  const paid = pay('close', '2026-01-10', 1_000_000, 'extra');
  const x = actual([paid], '2026-01-15', loan);
  assert.equal(x.complete, true);
  assert.equal(x.paidOffDate, '2026-01-10');
  assert.equal(x.principalBalanceCents, 0);
  assert.equal(x.rows.length, 0);
  assert.throws(() => actual([{ ...paid, amountCents: 1_000_001 }], '2026-01-15', loan), /exceeds/);
  assert.throws(() => actual([paid, pay('late', '2026-01-12', 1)], '2026-01-15', loan), /exceeds/);
});

test('cent rounding mode is deterministic and differs exactly at half-cent ties', () => {
  assert.equal(roundFraction(5n, 2n, 'HALF_UP'), 3n);
  assert.equal(roundFraction(5n, 2n, 'HALF_EVEN'), 2n);
  assert.equal(roundFraction(7n, 2n, 'HALF_EVEN'), 4n);
  assert.equal(roundFraction(-5n, 2n, 'HALF_UP'), -3n);
  const original = plan(base);
  for (let i = 0; i < 3; i++) assert.deepEqual(plan({ ...base }, []), original);
});

test('CSV-compatible synthetic fixture compares dates, interest, principal, balance, closure', () => {
  const term = { ...base, annualRateMicroPercent: 0, termMonths: 2, maxExtensionMonths: 0 };
  const computed = plan(term).rows;
  const fixture = [
    { date: '2026-02-01', amountCents: 500_000, interestCents: 0,
      principalCents: 500_000, balanceCents: 500_000 },
    { date: '2026-03-01', amountCents: 500_000, interestCents: 0,
      principalCents: 500_000, balanceCents: 0 },
  ];
  const perfect = reconcileLoanSchedule(computed, fixture);
  assert.equal(perfect.exactMatch, true);
  assert.equal(perfect.closureDateDifferenceDays, 0);
  const shifted = fixture.map((v, i) => i === 1 ? { ...v, date: '2026-03-02',
    interestCents: null, principalCents: null } : v);
  const difference = reconcileLoanSchedule(computed, shifted);
  assert.equal(difference.exactMatch, false);
  assert.equal(difference.mismatchedRows, 1);
  assert.equal(difference.rows[1].dateDifferenceDays, -1);
  assert.equal(difference.rows[1].interestDeltaCents, null);
  assert.equal(difference.closureDateDifferenceDays, -1);
  assert.throws(() => reconcileLoanSchedule(computed, [{ ...fixture[0], interestCents: 1 }]));
});

test('strict validation: dates, values, duplicates, schedules, and illegal operations', () => {
  for (const changes of [
    { firstDueDate: '2026-02-30' },
    { startDate: '2026-02-02' },
    { termMonths: 0 }, { annualRateMicroPercent: 0.00001 },
    { annualRateMicroPercent: -1 }, { principalCents: 0 },
    { principalCents: 0.5 }, { scheduleType: 'unknown' },
    { dayCount: 'ACT/365' }, { rounding: 'TRUNC' },
  ]) assert.throws(() => plan({ ...base, ...changes }), RangeError);
  assert.throws(() => actual([pay('x', '2026-01-02', 0)]), RangeError);
  assert.throws(() => actual([pay('x', '2025-12-31', 100)]), RangeError);
  assert.throws(() => actual([pay('x', '2026-01-02', 100), pay('x', '2026-01-03', 100)]), RangeError);
  assert.throws(() => actual([pay('x', '2026-01-02', 100, 'regular', 'reduce-payment')]), RangeError);
  assert.throws(() => actual([], '2025-12-31'), RangeError);
  assert.throws(() => plan({ ...base, termMonths: 1200 }), RangeError);
});

test('forecast keeps mid-cycle actual payment separate from future synthetic installment', () => {
  const historical = pay('actual', '2026-02-15', 70_000);
  const x = forecast([historical], '2026-02-16');
  assert.equal(x.rows[0].kind, 'actual');
  assert.equal(x.rows[0].amountCents, 0);
  assert.equal(x.actualOpenPeriod.amountCents, 70_000);
  assert.equal(x.actualOpenPeriod.interestPaidCents,
    x.history.find(h => h.id === 'actual').interestPaidCents);
  assert.equal(x.rows[1].kind, 'forecast');
  assert.equal(x.rows[1].amountCents, x.rows[1].plannedPaymentCents);
});

test('interest is not capitalized after missed installment; arrears repaid first', () => {
  const missed = actual([], '2026-02-01');
  const withPartial = actual([pay('late', '2026-02-15', 12_000)], '2026-02-16');
  const late = withPartial.history.find(h => h.id === 'late');
  assert.equal(missed.principalBalanceCents, 1_000_000);
  assert.equal(late.interestPaidCents, 12_000);
  assert.equal(late.principalPaidCents, 0);
  assert.equal(withPartial.principalBalanceCents, 1_000_000);
  assert.ok(withPartial.unpaidInterestCents > 0);
  assert.equal(withPartial.actualOpenPeriod.amountCents, 12_000);
});

test('reconciliation tolerates non-amortizing calculated schedule but reports mismatch', () => {
  const unpaid = actual([], '2026-02-01').rows;
  const bank = [{date: '2026-02-01', amountCents: 0, balanceCents: 1_000_000}];
  const comparison = reconcileLoanSchedule(unpaid, bank);
  assert.equal(comparison.exactMatch, true); // Bank CSV omitted interest column.
  assert.equal(comparison.calculatedClosureDate, null);
});

test('full 1200-month schedule is supported without extension', () => {
  const long = plan({ ...base, termMonths: 1200,
    annualRateMicroPercent: 0, startDate: '2026-01-01',
    firstDueDate: '2026-02-01', maxExtensionMonths: undefined });
  assert.equal(long.rows.length, 1200);
  assert.equal(long.rows.at(-1).balanceCents, 0);
});
