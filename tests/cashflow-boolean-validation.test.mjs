import test from 'node:test';
import assert from 'node:assert/strict';
import { forecastCashflow } from '../src/domain/cashflow/index.ts';

const base = () => ({
  openingDate: '2026-11-08',
  asOfDate: '2026-11-10',
  horizonMonths: 1,
  openingBalanceCents: 2_000_000,
  openingReservedCents: 0,
  plans: [{ id: 'bill', kind: 'obligation', dueDate: '2026-11-12', amountCents: 2_500_000 }],
  actuals: [],
});

const scenarios = [
  { label: 'planned obligation cancelled', field: 'plan.cancelled', change: (x, v) => {
    x.plans[0].cancelled = v;
  } },
  { label: 'occurrence override cancelled', field: 'override.cancelled', change: (x, v) => {
    x.overrides = [{ planId: 'bill', occurrenceDate: '2026-11-12', cancelled: v }];
  } },
  { label: 'recorded actual voided', field: 'actual.voided', change: (x, v) => {
    x.actuals = [{ id: 'expense', kind: 'expense', date: '2026-11-09', amountCents: 100, voided: v }];
  } },
  { label: 'reserve movement voided', field: 'reserve.voided', change: (x, v) => {
    x.reserves = [{ id: 'earmark', date: '2026-11-11', kind: 'allocate', status: 'planned', amountCents: 3_000_000, voided: v }];
  } },
];

for (const { label, field, change } of scenarios) {
  test(`malformed ${label} cannot silently suppress amounts`, () => {
    for (const value of ['false', 'true', null, 0, 1, [], {}]) {
      const x = base();
      change(x, value);
      assert.throws(() => forecastCashflow(x), new RegExp(`${field.replace('.', '\.')}:? .*boolean`),
        `${field}=${JSON.stringify(value)} must fail closed`);
    }
  });
}

test('explicit boolean false behaves as absence, true applies the declared cancellation or void', () => {
  const x = base();
  const baseline = forecastCashflow(x);
  assert.deepEqual(baseline.firstCashGap, { date: '2026-11-12', shortfallCents: 500_000 });
  for (const { change } of scenarios) {
    const givenFalse = base();
    change(givenFalse, false);
    const givenTrue = base();
    change(givenTrue, true);
    const noCancellation = forecastCashflow(givenFalse);
    const cancellation = forecastCashflow(givenTrue);
    assert.notDeepEqual(noCancellation, cancellation);
    if (change === scenarios[0].change || change === scenarios[1].change) {
      assert.deepEqual(noCancellation.firstCashGap, baseline.firstCashGap);
      assert.equal(cancellation.firstCashGap, null);
    }
  }
});

test('valid false actual void flag preserves real debit, valid true cancels that debit', () => {
  const actual = { id: 'confirmed', kind: 'expense', date: '2026-11-09', amountCents: 1_000_000 };
  const a = forecastCashflow({ ...base(), plans: [], actuals: [{ ...actual, voided: false }] });
  const b = forecastCashflow({ ...base(), plans: [], actuals: [{ ...actual, voided: true }] });
  assert.equal(a.confirmedAsOfBalanceCents, 1_000_000);
  assert.equal(b.confirmedAsOfBalanceCents, 2_000_000);
});
