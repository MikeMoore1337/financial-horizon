import test from 'node:test';
import assert from 'node:assert/strict';
import { previewReservePaymentImpact } from '../src/domain/reserves/payment-impact.ts';
import { calculateReserve } from '../src/domain/reserves/index.ts';

const payment = (changes = {}) => ({
  accountBalanceCents: 10_000,
  allocatedOnAccountCents: 3_000,
  reservedForObligationCents: 2_000,
  paymentCents: 2_500,
  reservedUsedCents: 2_000,
  ...changes,
});

test('partial reserve-funded payment debits the account exactly once', () => {
  const data = Object.freeze(payment());
  const prior = structuredClone(data);
  const actual = previewReservePaymentImpact(data);
  assert.deepEqual(actual, {
    accountBalanceBeforeCents: 10_000,
    accountBalanceAfterCents: 7_500,
    allocatedBeforeCents: 3_000,
    allocatedAfterCents: 1_000,
    unreservedBeforeCents: 7_000,
    unreservedAfterCents: 6_500,
    unreservedDecreaseCents: 500,
    ledgerDebitCents: 2_500,
    expenseCents: 2_500,
    canPayFromUnreservedAndAllocation: true,
    unreservedShortfallCents: 0,
  });
  // Subtracting allocated funds from the real balance is a double debit.
  assert.equal(actual.accountBalanceAfterCents, data.accountBalanceCents - data.paymentCents);
  assert.notEqual(actual.accountBalanceAfterCents,
    data.accountBalanceCents - data.paymentCents - data.reservedUsedCents);
  assert.deepEqual(data, prior, 'pure preview must not mutate inputs');
});

test('payment entirely from reserved funds reduces balance, not available cash', () => {
  const result = previewReservePaymentImpact(payment({
    allocatedOnAccountCents: 2_000,
    reservedForObligationCents: 2_000,
    paymentCents: 2_000,
    reservedUsedCents: 2_000,
  }));
  assert.equal(result.accountBalanceAfterCents, 8_000);
  assert.equal(result.allocatedAfterCents, 0);
  assert.equal(result.unreservedBeforeCents, result.unreservedAfterCents);
  assert.equal(result.expenseCents, 2_000);
});

test('unreserved payment spends exactly once, including with other obligations on same account', () => {
  const result = previewReservePaymentImpact(payment({
    allocatedOnAccountCents: 3_000,
    reservedForObligationCents: 0,
    reservedUsedCents: 0,
  }));
  assert.equal(result.allocatedAfterCents, 3_000);
  assert.equal(result.unreservedBeforeCents - result.unreservedAfterCents, 2_500);
  assert.equal(result.ledgerDebitCents, 2_500);
});

test('insufficient unreserved funds report deficit without authorizing overdraft', () => {
  const result = previewReservePaymentImpact(payment({
    accountBalanceCents: 900,
    allocatedOnAccountCents: 700,
    reservedForObligationCents: 600,
    paymentCents: 800,
    reservedUsedCents: 400,
  }));
  assert.equal(result.unreservedBeforeCents, 200);
  assert.equal(result.unreservedAfterCents, -200);
  assert.equal(result.unreservedShortfallCents, 200);
  assert.equal(result.canPayFromUnreservedAndAllocation, false);
  assert.equal(result.accountBalanceAfterCents, 100);
});

test('negative starting account balance remains signed and is not masked as an expense', () => {
  const result = previewReservePaymentImpact(payment({
    accountBalanceCents: -100,
    allocatedOnAccountCents: 0,
    reservedForObligationCents: 0,
    paymentCents: 50,
    reservedUsedCents: 0,
  }));
  assert.equal(result.accountBalanceAfterCents, -150);
  assert.equal(result.unreservedShortfallCents, 150);
  assert.equal(result.expenseCents, 50);
  assert.equal(result.canPayFromUnreservedAndAllocation, false);
});

test('payment event in reserve projection matches one independent account debit preview', () => {
  const definition = Object.freeze({
    id: 'tax', title: 'Налог', openedOn: '2026-01-01',
    firstDueDate: '2026-12-31', periodMonths: 12,
    targetCents: 500_000, openingReservedCents: 300_000,
    contributionMode: 'auto', dueDay: 31,
  });
  const events = Object.freeze([
    Object.freeze({ kind: 'payment', reserveId: 'tax', id: 'pay', date: '2026-06-01',
      amountCents: 200_000, reservedUsedCents: 150_000 }),
  ]);
  const reserve = calculateReserve(definition, events, '2026-06-01');
  const preview = previewReservePaymentImpact({
    accountBalanceCents: 1_000_000, allocatedOnAccountCents: 500_000,
    reservedForObligationCents: 300_000, paymentCents: 200_000, reservedUsedCents: 150_000,
  });
  assert.equal(reserve.reservedCents, 150_000);
  assert.equal(reserve.totalPaidCents, 200_000);
  assert.equal(preview.accountBalanceAfterCents, 800_000);
  assert.equal(preview.allocatedAfterCents, 350_000);
  assert.equal(preview.unreservedBeforeCents - preview.unreservedAfterCents, 50_000);
  assert.equal(preview.expenseCents, reserve.totalPaidCents);
});

test('reject invalid payment usage, amounts, scope of allocations and unsafe integers', () => {
  for (const bad of [
    payment({ allocatedOnAccountCents: 1_000 }),
    payment({ reservedUsedCents: 2_001 }),
    payment({ reservedUsedCents: 2_501 }),
    payment({ reservedUsedCents: -1 }),
    payment({ paymentCents: 0 }),
    payment({ paymentCents: 1.5 }),
    payment({ allocatedOnAccountCents: -1 }),
    payment({ reservedForObligationCents: -1 }),
    payment({ accountBalanceCents: Number.NaN }),
    payment({ accountBalanceCents: Number.POSITIVE_INFINITY }),
    payment({ paymentCents: Number.MAX_SAFE_INTEGER + 1 }),
    payment({ accountBalanceCents: -Number.MAX_SAFE_INTEGER, paymentCents: 1 }),
  ]) {
    assert.throws(() => previewReservePaymentImpact(bad));
  }
});

test('5,000 deterministic account/payment invariants prevent double-accounting', () => {
  let seed = 0xa9e9d14f;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let i = 0; i < 5_000; i++) {
    const allocated = next() % 3_000_000;
    const reserved = next() % (allocated + 1);
    const amount = 1 + next() % 2_000_000;
    const used = next() % (Math.min(reserved, amount) + 1);
    const balance = (next() % 10_000_000) - 2_000_000;
    const input = payment({
      accountBalanceCents: balance,
      allocatedOnAccountCents: allocated,
      reservedForObligationCents: reserved,
      paymentCents: amount,
      reservedUsedCents: used,
    });
    const p = previewReservePaymentImpact(input);
    assert.equal(p.accountBalanceAfterCents, balance - amount);
    assert.equal(p.allocatedAfterCents, allocated - used);
    assert.equal(p.unreservedAfterCents, p.unreservedBeforeCents - (amount - used));
    assert.equal(p.unreservedDecreaseCents, amount - used);
    assert.equal(p.ledgerDebitCents, amount);
    assert.equal(p.expenseCents, amount);
    assert.equal(p.unreservedShortfallCents, Math.max(0, amount - used - (balance - allocated)));
    assert.equal(p.canPayFromUnreservedAndAllocation, p.unreservedShortfallCents === 0);
  }
});
