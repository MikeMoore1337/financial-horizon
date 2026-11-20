import test from 'node:test';
import assert from 'node:assert/strict';
import { forecastCashflow } from '../src/domain/cashflow/index.ts';

function seeded(seed) {
  let state = seed >>> 0;
  return () => ((state = (Math.imul(1664525, state) + 1013904223) >>> 0) / 2 ** 32);
}

test('2 000 deterministic scenarios conserve bank cash and earmarked availability', () => {
  const rand = seeded(0x36CA5F10);
  for (let run = 0; run < 2000; run++) {
    const opening = Math.floor(rand() * 1_000_000);
    const reserved = Math.floor(rand() * opening);
    const expense = Math.floor(rand() * 100_000);
    const inflow = Math.floor(rand() * 100_000);
    const release = Math.floor(rand() * reserved);
    const transfer = Math.floor(rand() * 200_000);
    const date = run % 2 ? '2028-02-29' : '2027-03-31';
    const factDate = run % 2 ? '2028-02-28' : '2027-03-30';
    const input = {
      openingDate: factDate, asOfDate: factDate, horizonMonths: 1,
      openingBalanceCents: opening, openingReservedCents: reserved,
      plans: [{ id: 'pay', kind: 'obligation', dueDate: date, amountCents: expense },
        { id: 'salary', kind: 'income', dueDate: date, amountCents: inflow }],
      actuals: [{ id: 'transfer', date: factDate, kind: 'transfer', amountCents: transfer }],
      reserves: [{ id: 'use', kind: 'release', date, amountCents: release, status: 'planned' }],
    };
    const x = forecastCashflow(input);
    const expectedBank = opening - expense + inflow;
    const expectedReserved = reserved - release;
    assert.equal(x.confirmedAsOfBalanceCents, opening);
    assert.equal(x.expectedClosingBalanceCents, expectedBank);
    assert.equal(x.expectedClosingReservedCents, expectedReserved);
    assert.equal(x.expectedClosingAvailableCents, expectedBank - expectedReserved);
    assert.equal(x.planVsActual.actualNetCents, 0);
    assert.equal(x.days.at(-1).expectedAvailableCents, x.expectedClosingAvailableCents);
  }
});
