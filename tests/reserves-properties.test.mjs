import test from 'node:test';
import assert from 'node:assert/strict';
import { addReserveMonths, calculateReserve } from '../src/domain/reserves/index.ts';

test('3,000 deterministic randomized reserve schedules preserve all cent invariants', () => {
  let seed = 0x6c6f636b;
  const next = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0));
  for (let i = 0; i < 3000; i += 1) {
    const periodMonths = 1 + (next() % 60);
    const dueDay = 28 + (next() % 4);
    const targetCents = 1 + (next() % 20_000_000);
    const openingReservedCents = next() % (targetCents + 1);
    const contributionCents = 1 + (next() % targetCents);
    const amountCents = 1 + (next() % targetCents);
    const reservedUsedCents = Math.min(openingReservedCents + contributionCents, amountCents);
    const fixed = next() % 2 === 0;
    const def = Object.freeze({
      id: 'reserve-random',
      title: 'Синтетический резерв',
      openedOn: '2026-01-31',
      firstDueDate: addReserveMonths('2026-01-31', periodMonths, dueDay),
      periodMonths,
      dueDay,
      targetCents,
      openingReservedCents,
      contributionMode: fixed ? 'fixed' : 'auto',
      ...(fixed ? { fixedMonthlyCents: 1 + (next() % 300_000) } : {}),
    });
    const events = Object.freeze([
      Object.freeze({
        id: 'contribution-1',
        reserveId: def.id,
        kind: 'contribution',
        date: '2026-02-01',
        amountCents: contributionCents,
      }),
      Object.freeze({
        id: 'payment-1',
        reserveId: def.id,
        kind: 'payment',
        date: '2026-02-02',
        amountCents,
        reservedUsedCents,
      }),
    ]);
    const calculated = calculateReserve(def, events, '2026-02-02');
    const expectedReserve = openingReservedCents + contributionCents - reservedUsedCents;
    const expectedRemaining = targetCents - amountCents;
    const expectedGap = Math.max(0, expectedRemaining - expectedReserve);
    const planned = calculated.schedule.reduce((sum, installment) => {
      assert.ok(Number.isSafeInteger(installment.amountCents));
      assert.ok(installment.amountCents >= 0);
      assert.ok(installment.date > '2026-02-02');
      assert.ok(installment.date <= def.firstDueDate);
      return sum + installment.amountCents;
    }, 0);
    assert.equal(calculated.reservedCents, expectedReserve);
    assert.equal(calculated.remainingObligationCents, expectedRemaining);
    assert.equal(calculated.paidThisCycleCents, amountCents);
    assert.equal(calculated.totalPaidCents, amountCents);
    assert.equal(calculated.totalContributedCents, contributionCents);
    assert.equal(calculated.totalReservedUsedCents, reservedUsedCents);
    assert.equal(calculated.fundingGapCents, expectedGap);
    assert.equal(planned + calculated.projectedShortfallCents, expectedGap);
    assert.deepEqual(
      calculated.nextContribution,
      calculated.schedule.find((installment) => installment.amountCents > 0) ?? null,
    );
    if (!fixed) assert.equal(calculated.projectedShortfallCents, 0);
    assert.ok(calculated.daysUntilDue >= 0);
    assert.equal(calculated.history.length, 2);
    assert.equal(calculated.history.some((item) => item.voided), false);
  }
});
