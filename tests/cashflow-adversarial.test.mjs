import test from 'node:test';
import assert from 'node:assert/strict';
import { forecastCashflow, addMonthsAnchored } from '../src/domain/cashflow/index.ts';

function seeded(seed) {
  let state = seed >>> 0;
  return () => ((state = (Math.imul(1664525, state) + 1013904223) >>> 0) / 2 ** 32);
}

test('12,000 independent linked-payment, reserve, transfer and gap-date scenarios', () => {
  const random = seeded(0x36c0ffee);
  const horizonOptions = [1, 3, 6, 12];
  for (let run = 0; run < 12_000; run++) {
    const cash = Math.floor(random() * 1_000_000);
    const locked = Math.floor(random() * 1_000_000);
    const due = Math.floor(random() * 1_000_000);
    const alreadyPaid = Math.floor(random() * (due + 1));
    const salary = Math.floor(random() * 1_000_000);
    const release = Math.floor(random() * (locked + 1));
    const incomeActual = Math.floor(random() * 500_000);
    const adjustmentMagnitude = Math.floor(random() * 200_000);
    const adjustmentSigned = random() < 0.5 ? adjustmentMagnitude : -adjustmentMagnitude;
    const horizonMonths = horizonOptions[run % horizonOptions.length];
    const input = {
      openingDate: '2026-11-01',
      asOfDate: '2026-11-08',
      horizonMonths,
      openingBalanceCents: cash,
      openingReservedCents: locked,
      plans: [
        { id: 'rent', dueDate: '2026-11-12', amountCents: due, kind: 'obligation' },
        { id: 'salary', dueDate: '2026-11-20', amountCents: salary, kind: 'income' },
      ],
      actuals: [
        { id: 'partial', date: '2026-11-05', kind: 'expense', amountCents: alreadyPaid,
          planId: 'rent', occurrenceDate: '2026-11-12' },
        { id: 'bonus', date: '2026-11-06', kind: 'income', amountCents: incomeActual },
        { id: 'adjustment', date: '2026-11-07',
          kind: adjustmentSigned >= 0 ? 'adjustment-credit' : 'adjustment-debit',
          amountCents: Math.abs(adjustmentSigned) },
        { id: 'internal-transfer', date: '2026-11-02', kind: 'transfer', amountCents: 3_000_000 },
      ],
      reserves: [
        { id: 'released', kind: 'release', date: '2026-11-12',
          amountCents: release, status: 'planned' },
      ],
    };
    const result = forecastCashflow(input);
    // Independent algebraic oracles: the early partial debit and the remaining
    // forecast debit sum to the original invoice once, not twice.
    const bankAfterFacts = cash - alreadyPaid + incomeActual + adjustmentSigned;
    const bankAtEnd = bankAfterFacts - (due - alreadyPaid) + salary;
    const reservedAtEnd = locked - release;
    const availableBeforeDue = bankAfterFacts - locked;
    const availableOnDue = availableBeforeDue - (due - alreadyPaid) + release;
    const availableAtEnd = bankAtEnd - reservedAtEnd;
    const expectedMinimum = Math.min(availableBeforeDue, availableOnDue, availableAtEnd);
    const firstGapDate = availableBeforeDue < 0 ? '2026-11-08'
      : availableOnDue < 0 ? '2026-11-12'
        : availableAtEnd < 0 ? '2026-11-20' : null;
    const tag = `case ${run}`;

    assert.equal(result.confirmedAsOfBalanceCents, bankAfterFacts, `${tag}: factual bank`);
    assert.equal(result.confirmedAsOfReservedCents, locked, `${tag}: factual reserves`);
    assert.equal(result.confirmedAdjustmentCents, adjustmentSigned, `${tag}: balance correction`);
    assert.equal(result.expectedClosingBalanceCents, bankAtEnd, `${tag}: closing bank`);
    assert.equal(result.expectedClosingReservedCents, reservedAtEnd, `${tag}: closing reserves`);
    assert.equal(result.expectedClosingAvailableCents, availableAtEnd, `${tag}: closing available`);
    assert.equal(result.planVsActual.varianceCents, incomeActual - alreadyPaid, `${tag}: variance`);
    assert.equal(result.occurrences.length, 2, `${tag}: plan occurrences`);
    assert.equal(result.days.at(-1).date, addMonthsAnchored(input.asOfDate, horizonMonths));
    assert.equal(result.minimumExpectedAvailableCents, expectedMinimum, `${tag}: minimum`);
    assert.equal(result.firstCashGap?.date ?? null, firstGapDate, `${tag}: first deficit`);
  }
});
