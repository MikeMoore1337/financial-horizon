import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareReadOnlyLoanComparison } from '../src/domain/loans/read-only-comparison.ts';

const legacy = {
  id: 'synthetic-legacy',
  title: 'Fictional reference loan',
  openingCents: 1_000_000,
  paymentCents: 507_410,
  apr: 12.00000001,
  termMonths: 2,
  dueDay: 31, // Deliberately not used as the bank-confirmed anchor.
  asOfDate: '2026-01-01',
  schedule: [{ date: '2026-02-01', amountCents: 507_410, balanceCents: 502_782 }],
  loanPayments: [{ id: 'old-payment', amountCents: 100, date: '2026-01-10' }],
};
const approved = {
  agreementConfirmed: true,
  openingBalanceDateConfirmed: true,
  firstDueDate: '2026-02-01',
  dueDayAnchor: 1,
  annualRateMicroPercent: 12_000_000,
  dayCount: 'ACT/365F',
  rounding: 'HALF_UP',
  scheduleType: 'annuity',
  installmentBasis: 'fixed-contractual',
};
const bank = [
  { date: '2026-02-01', amountCents: 507_410, interestCents: 10_192,
    principalCents: 497_218, balanceCents: 502_782 },
  { date: '2026-03-01', amountCents: 507_410, interestCents: 4_628,
    principalCents: 502_782, balanceCents: 0 },
];

test('unconfirmed contract remains blocked and does not inspect the bank rows', () => {
  const result = prepareReadOnlyLoanComparison(legacy, {}, [{ date: 'not-a-date' }]);
  assert.equal(result.status, 'needs-confirmation');
  assert.equal(result.plan, null);
  assert.equal(result.bankComparison, null);
  assert.equal(result.missing.length, 9);
  assert.equal(result.bankParityVerified, false);
  assert.equal(result.storedDataChanged, false);
});

test('a confirmed plan without a bank schedule is not described as a bank match', () => {
  for (const rows of [null, []]) {
    const result = prepareReadOnlyLoanComparison(legacy, approved, rows);
    assert.equal(result.status, 'no-bank-schedule');
    assert.equal(result.plan.rows.length, 2);
    assert.equal(result.plan.bankParityVerified, false);
    assert.equal(result.bankComparison, null);
    assert.equal(result.historicalPaymentsImported, false);
  }
});

test('an independent full bank reference matches only numerically and keeps original data', () => {
  const loan = structuredClone(legacy);
  const rows = structuredClone(bank);
  const original = structuredClone(loan);
  const originalBank = structuredClone(rows);
  const result = prepareReadOnlyLoanComparison(loan, approved, rows);
  assert.equal(result.status, 'numerical-match');
  assert.equal(result.bankComparison.exactMatch, true);
  assert.equal(result.bankComparison.mismatchedRows, 0);
  assert.equal(result.plan.rows[0].date, bank[0].date);
  assert.equal(result.plan.rows[0].amountCents, 507_410);
  assert.equal(result.bankParityVerified, false);
  assert.equal(result.historicalPaymentsImported, false);
  assert.equal(result.storedDataChanged, false);
  assert.deepEqual(loan, original);
  assert.deepEqual(rows, originalBank);
  assert.equal(loan.loanPayments.length, 1);
});

test('missing optional bank columns permit known-field equality but not an exact match', () => {
  const partial = bank.map(({ date, amountCents, balanceCents }) =>
    ({ date, amountCents, balanceCents }));
  const result = prepareReadOnlyLoanComparison(legacy, approved, partial);
  assert.equal(result.status, 'incomplete-bank-evidence');
  assert.equal(result.bankComparison.matchingKnownFields, true);
  assert.equal(result.bankComparison.comparisonComplete, false);
  assert.equal(result.bankComparison.exactMatch, false);
  assert.deepEqual(result.bankComparison.rows[0].missingFields,
    ['interestCents', 'principalCents']);
});

test('a one-kopeck amount mismatch is exposed without silently adjusting the plan', () => {
  const altered = bank.map((row, index) =>
    index === 1 ? { ...row, amountCents: row.amountCents + 1 } : row);
  const result = prepareReadOnlyLoanComparison(legacy, approved, altered);
  assert.equal(result.status, 'differences');
  assert.equal(result.bankComparison.mismatchedRows, 1);
  assert.equal(result.bankComparison.rows[1].amountDeltaCents, -1);
  assert.equal(result.plan.rows[1].amountCents, 507_410);
});

test('omitted or duplicated bank periods do not produce a false match', () => {
  const missing = prepareReadOnlyLoanComparison(legacy, approved, bank.slice(0, 1));
  assert.equal(missing.status, 'differences');
  assert.equal(missing.bankComparison.exactMatch, false);
  assert.ok(missing.bankComparison.mismatchedRows > 0);
  assert.throws(() => prepareReadOnlyLoanComparison(legacy, approved, [bank[0], bank[0]]));
});

test('confirmed day-count and anchor prevail over an untrusted floating APR and old dueDay', () => {
  const approvedAlt = { ...approved, annualRateMicroPercent: 0, installmentBasis: 'recalculate',
    firstDueDate: '2026-02-28', dueDayAnchor: 31 };
  const sample = { ...legacy, asOfDate: '2026-02-01', openingCents: 90_000,
    paymentCents: 30_000, termMonths: 3, dueDay: 15 };
  const result = prepareReadOnlyLoanComparison(sample, approvedAlt);
  assert.equal(result.status, 'no-bank-schedule');
  assert.deepEqual(result.plan.rows.map(row => row.date),
    ['2026-02-28', '2026-03-31', '2026-04-30']);
  assert.equal(result.plan.rows[2].balanceCents, 0);
});

test('unresolved closure date is not promoted to proof of a fully settled bank loan', () => {
  const unknown = [
    { date: '2026-02-01', amountCents: 507_410, interestCents: 10_192,
      principalCents: 497_218, balanceCents: 502_782 },
    { date: '2026-03-01', amountCents: 507_410, interestCents: 4_628,
      principalCents: 502_782, balanceCents: 99 },
  ];
  const result = prepareReadOnlyLoanComparison(legacy, approved, unknown);
  assert.equal(result.status, 'differences');
  assert.equal(result.bankComparison.exactMatch, false);
  assert.equal(result.bankParityVerified, false);
});

test('bank fees remain unallocated differences, never part of mortgage principal', () => {
  const withFee = bank.map((row, index) => index === 0
    ? { ...row, amountCents: row.amountCents + 50 } : row);
  const result = prepareReadOnlyLoanComparison(legacy, approved, withFee);
  assert.equal(result.status, 'differences');
  assert.equal(result.bankComparison.rows[0].bankUnallocatedCents, 50);
  assert.equal(result.bankComparison.rows[0].amountDeltaCents, -50);
  assert.equal(result.plan.rows[0].principalCents, 497_218);
  assert.equal(result.plan.rows[0].balanceCents, 502_782);
});

test('identical full rows for an unclosed loan are insufficient closure evidence', () => {
  const tooSmall = { ...legacy, paymentCents: 300_000 };
  const first = prepareReadOnlyLoanComparison(tooSmall, approved);
  assert.equal(first.status, 'no-bank-schedule');
  assert.equal(first.plan.complete, false);
  const synthetic = first.plan.rows.map(row => ({
    date: row.date,
    amountCents: row.amountCents,
    interestCents: row.interestCents,
    principalCents: row.principalCents,
    balanceCents: row.balanceCents,
  }));
  const compared = prepareReadOnlyLoanComparison(tooSmall, approved, synthetic);
  assert.equal(compared.bankComparison.matchingKnownFields, true);
  assert.equal(compared.bankComparison.comparisonComplete, true);
  assert.equal(compared.bankComparison.exactMatch, false);
  assert.equal(compared.status, 'incomplete-bank-evidence');
  assert.equal(compared.bankParityVerified, false);
});
