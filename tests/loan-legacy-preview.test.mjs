import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateLoan, prepareLegacyLoanPreview } from '../src/domain/loans/index.ts';

const legacy = {
  id: 'legacy-loan-id',
  title: 'Synthetic legacy loan',
  openingCents: 1_000_000,
  paymentCents: 507_410,
  apr: 12.0000001,
  termMonths: 2,
  dueDay: 15,
  asOfDate: '2026-01-01',
  schedule: [
    { date: '2026-02-01', amountCents: 507_410, balanceCents: 502_782 },
  ],
};

const approved = {
  agreementConfirmed: true,
  openingBalanceDateConfirmed: true,
  firstDueDate: '2026-02-01',
  annualRateMicroPercent: 12_000_000,
  dayCount: 'ACT/365F',
  rounding: 'HALF_UP',
  scheduleType: 'annuity',
  installmentBasis: 'fixed-contractual',
};

test('legacy loan without explicit bank terms never claims precise model readiness', () => {
  const result = prepareLegacyLoanPreview(legacy);
  assert.equal(result.status, 'needs-confirmation');
  assert.equal(result.terms, null);
  assert.equal(result.missing.length, 8);
  assert.equal(result.bankParityVerified, false);
  assert.equal(result.storedDataChanged, false);
  assert.equal(result.historicalPaymentsImported, false);
  assert.ok(result.missing.includes('firstDueDate'));
  assert.ok(result.missing.includes('dayCount'));
  assert.ok(result.missing.includes('rounding'));
  assert.ok(result.missing.includes('openingBalanceDateConfirmed'));
});

test('partly approved bank rules remain in legacy-only mode', () => {
  const result = prepareLegacyLoanPreview(legacy, {
    ...approved,
    openingBalanceDateConfirmed: undefined,
    dayCount: undefined,
  });
  assert.equal(result.status, 'needs-confirmation');
  assert.equal(result.terms, null);
  assert.deepEqual(result.missing, ['openingBalanceDateConfirmed', 'dayCount']);
});

test('confirmed snapshot maps only explicit terms, not floating legacy APR or guessed due day', () => {
  const original = structuredClone(legacy);
  Object.freeze(legacy);
  const result = prepareLegacyLoanPreview(legacy, approved);
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.terms, {
    principalCents: 1_000_000,
    paymentCents: 507_410,
    startDate: '2026-01-01',
    firstDueDate: '2026-02-01',
    termMonths: 2,
    annualRateMicroPercent: 12_000_000,
    dayCount: 'ACT/365F',
    rounding: 'HALF_UP',
    scheduleType: 'annuity',
    maxExtensionMonths: 0,
  });
  assert.notEqual(legacy.dueDay, 1);
  assert.equal(result.bankParityVerified, false);
  assert.equal(result.storedDataChanged, false);
  assert.equal(result.historicalPaymentsImported, false);
  const calculated = calculateLoan(result.terms, [], { mode: 'plan' });
  assert.equal(calculated.complete, true);
  assert.equal(calculated.rows[0].amountCents, 507_410);
  assert.equal(calculated.rows[1].amountCents, 507_410);
  assert.deepEqual(legacy, original);
  assert.equal(legacy.schedule.length, 1);
});

test('explicit recalculation does not overwrite stored installment or change snapshot', () => {
  const unusual = { ...legacy, paymentCents: 500_000 };
  const original = structuredClone(unusual);
  const result = prepareLegacyLoanPreview(unusual, {
    ...approved, installmentBasis: 'recalculate',
  });
  assert.equal(result.status, 'ready');
  assert.equal(Object.hasOwn(result.terms, 'paymentCents'), false);
  const calculated = calculateLoan(result.terms, [], {mode:'plan'});
  assert.equal(calculated.scheduledPaymentCents, 507_410);
  assert.equal(unusual.paymentCents, 500_000);
  assert.deepEqual(unusual, original);
});

test('zero nominal rate is a valid explicitly confirmed banking rate', () => {
  const result = prepareLegacyLoanPreview(legacy, {
    ...approved, annualRateMicroPercent: 0,
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.terms.annualRateMicroPercent, 0);
});

test('differentiated schedules must not import fixed annuity installment implicitly', () => {
  assert.throws(() => prepareLegacyLoanPreview(legacy, {
    ...approved, scheduleType: 'differentiated',
  }), RangeError);
  const diff = prepareLegacyLoanPreview(legacy, {
    ...approved,
    scheduleType: 'differentiated',
    installmentBasis: 'recalculate',
  });
  assert.equal(diff.status, 'ready');
  assert.equal(Object.hasOwn(diff.terms, 'paymentCents'), false);
  const result = calculateLoan(diff.terms, [], {mode:'plan'});
  assert.equal(result.complete, true);
});

test('confirmed non-calendar dates, unsupported day counts and unsafe rates are rejected', () => {
  for (const changes of [
    { firstDueDate: '2026-02-29' },
    { firstDueDate: '2025-12-01' },
    { firstDueDate: '2027-02-05' },
    { dayCount: '30E/360-ISDA' },
    { rounding: 'BANKER_GUESS' },
    { scheduleType: 'balloon' },
    { installmentBasis: 'guess' },
    { annualRateMicroPercent: -1 },
    { annualRateMicroPercent: 100_000_001 },
    { annualRateMicroPercent: 2.7 },
  ]) {
    assert.throws(() => prepareLegacyLoanPreview(legacy, { ...approved, ...changes }),
      undefined, JSON.stringify(changes));
  }
});

test('malformed stored loan is rejected instead of silently reinterpreting data', () => {
  for (const invalid of [
    null,
    {},
    { ...legacy, openingCents: 0 },
    { ...legacy, openingCents: 5.5 },
    { ...legacy, paymentCents: -1 },
    { ...legacy, termMonths: 0 },
    { ...legacy, termMonths: 1201 },
    { ...legacy, dueDay: 32 },
    { ...legacy, asOfDate: '2026-13-01' },
  ]) {
    assert.throws(() => prepareLegacyLoanPreview(invalid, approved));
  }
  assert.throws(() => prepareLegacyLoanPreview(legacy, []), TypeError);
  assert.throws(() => prepareLegacyLoanPreview(legacy, null), TypeError);
});

test('factual legacy repayment IDs are never fabricated as verified ledger events', () => {
  const oldEvents = Object.freeze([
    Object.freeze({
      id: 'legacy-pay-not-uuid', loanId: 'legacy-loan-id',
      date: '2026-01-15', amountCents: 50_000,
      strategy: 'term', createdAt: '2026-01-15T12:00:00Z',
    }),
  ]);
  const result = prepareLegacyLoanPreview(legacy, approved);
  assert.equal(result.status, 'ready');
  assert.equal(result.historicalPaymentsImported, false);
  assert.equal('events' in result, false);
  assert.equal(oldEvents[0].id, 'legacy-pay-not-uuid');
  assert.equal(result.bankParityVerified, false);
});

test('inherited defaults cannot masquerade as confirmed banking terms', () => {
  const inherited = Object.create(approved);
  assert.equal(Object.keys(inherited).length, 0);
  const result = prepareLegacyLoanPreview(legacy, inherited);
  assert.equal(result.status, 'needs-confirmation');
  assert.equal(result.terms, null);
  assert.equal(result.missing.length, 8);

  const own = Object.assign({}, approved);
  assert.equal(prepareLegacyLoanPreview(legacy, own).status, 'ready');
});
