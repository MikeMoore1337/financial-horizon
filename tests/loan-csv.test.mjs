import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSchedule } from '../schedule.js';
import { annuityMonthly, loanLedger } from '../finance.js';
import { calculateLoan, reconcileLoanSchedule } from '../src/domain/loans/index.ts';

const terms = {
  principalCents: 1_000_000,
  startDate: '2026-01-01',
  firstDueDate: '2026-02-01',
  termMonths: 2,
  annualRateMicroPercent: 12_000_000,
  dayCount: 'ACT/365F',
  rounding: 'HALF_UP',
  scheduleType: 'annuity',
  maxExtensionMonths: 0,
};

// Independent hand-calculated fixed-rate ACT/365F installment reference.
// Interest 1: round(1,000,000 * 12% * 31 / 365) = 10,192 kopecks.
// Interest 2: round(502,782 * 12% * 28 / 365) = 4,628 kopecks.
const reference = [
  { date: '2026-02-01', amountCents: 507_410, interestCents: 10_192,
    principalCents: 497_218, balanceCents: 502_782 },
  { date: '2026-03-01', amountCents: 507_410, interestCents: 4_628,
    principalCents: 502_782, balanceCents: 0 },
];

test('daily ACT/365F two-payment loan matches independent synthetic reference to cent', () => {
  const result = calculateLoan(terms, [], { mode: 'plan' });
  assert.deepEqual(result.rows.map(({date, amountCents, interestCents, principalCents, balanceCents}) =>
    ({date, amountCents, interestCents, principalCents, balanceCents})), reference);
  assert.equal(result.scheduledPaymentCents, 507_410);
  assert.equal(result.bankParityVerified, false);
});

test('Russian bank CSV importer preserves amounts and reconciliation reports perfect match', () => {
  const csv = '\ufeffДата;Платёж;Проценты;Основной долг;Остаток\n' +
    '01.02.2026;"5 074,10";"101,92";"4 972,18";"5 027,82"\n' +
    '01.03.2026;"5 074,10";"46,28";"5 027,82";"0,00"\n';
  const imported = parseSchedule(csv);
  assert.deepEqual(imported, reference);
  const calculated = calculateLoan(terms, [], { mode: 'plan' });
  const result = reconcileLoanSchedule(calculated.rows, imported);
  assert.equal(result.exactMatch, true);
  assert.equal(result.comparisonComplete, true);
  assert.equal(result.matchingKnownFields, true);
  assert.equal(result.mismatchedRows, 0);
  assert.equal(result.closureDateDifferenceDays, 0);
});

test('CSV with absent optional columns does not invent interest or principal deltas', () => {
  const csv = 'Date;Payment;Balance\n2026-02-01;5074,10;5027,82\n2026-03-01;5074,10;0\n';
  const imported = parseSchedule(csv);
  const result = reconcileLoanSchedule(calculateLoan(terms, [], { mode: 'plan' }).rows, imported);
  assert.equal(result.matchingKnownFields, true);
  assert.equal(result.comparisonComplete, false);
  assert.equal(result.exactMatch, false);
  assert.deepEqual(result.rows[0].missingFields, ['interestCents', 'principalCents']);
  assert.ok(result.rows.every(r => r.interestDeltaCents === null && r.principalDeltaCents === null));
});

test('historical monthly APR/12 loan model remains usable and unchanged', () => {
  assert.equal(annuityMonthly(100_000, 0, 4), 25_000);
  assert.equal(loanLedger({id: 'legacy', asOfDate: '2026-01-01',
    openingCents: 100_000, paymentCents: 25_000, apr: 0, termMonths: 4}, []).outstandingCents,
    100_000);
  const newModel = calculateLoan({ ...terms, annualRateMicroPercent: 0, termMonths: 4,
    maxExtensionMonths: 0 }, [], {mode:'plan'});
  assert.equal(newModel.complete, true);
});
