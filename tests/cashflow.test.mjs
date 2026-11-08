import test from 'node:test';
import assert from 'node:assert/strict';
import {
  forecastCashflow, adaptCashflowSources, addMonthsAnchored, dayNumber,
} from '../src/domain/cashflow/index.ts';

const base = (overrides = {}) => ({
  openingDate: '2026-11-08',
  asOfDate: '2026-11-08',
  horizonMonths: 1,
  openingBalanceCents: 2_000_000,
  openingReservedCents: 0,
  plans: [],
  actuals: [],
  ...overrides,
});
const out = (id, dueDate, amountCents, kind = 'obligation', extra = {}) =>
  ({ id, dueDate, amountCents, kind, ...extra });
const income = (id, dueDate, amountCents, extra = {}) =>
  out(id, dueDate, amountCents, 'income', extra);
const actual = (id, date, amountCents, kind, planId, occurrenceDate) =>
  ({ id, date, amountCents, kind, ...(planId && { planId, occurrenceDate }) });
const on = (result, date) => {
  const row = result.days.find(r => r.date === date);
  assert.ok(row, `Missing ${date}`);
  return row;
};

test('mandatory oracle: 20 000 rub, 25 000 rub before salary -> 5 000 rub on exact due day', () => {
  const result = forecastCashflow(base({ plans: [
    out('rent', '2026-11-12', 2_500_000),
    income('salary', '2026-11-20', 5_000_000),
  ] }));
  assert.deepEqual(result.firstCashGap, { date: '2026-11-12', shortfallCents: 500_000 });
  assert.equal(on(result, '2026-11-11').expectedAvailableCents, 2_000_000);
  assert.equal(on(result, '2026-11-12').expectedAvailableCents, -500_000);
  assert.equal(on(result, '2026-11-20').expectedAvailableCents, 4_500_000);
  assert.equal(result.minimumExpectedAvailableCents, -500_000);
  assert.equal(result.confirmedAsOfBalanceCents, 2_000_000);
  assert.equal(result.totalEstimatedFutureIncomeCents, 5_000_000);
});

test('horizons use the explicit asOfDate and include calendar endpoint', () => {
  for (const [months, end] of [[1, '2026-12-08'], [3, '2027-02-08'],
    [6, '2027-05-08'], [12, '2027-11-08']]) {
    const result = forecastCashflow(base({ horizonMonths: months }));
    assert.equal(result.endDate, end);
    assert.equal(result.days.at(-1).date, end);
    assert.equal(result.days.length, dayNumber(end) - dayNumber('2026-11-08') + 1);
    assert.equal(result.minimumExpectedAvailableCents, 2_000_000);
  }
});

test('31st anchors independently across February (ordinary and leap years)', () => {
  assert.equal(addMonthsAnchored('2027-01-31', 1), '2027-02-28');
  assert.equal(addMonthsAnchored('2028-01-31', 1), '2028-02-29');
  assert.equal(addMonthsAnchored('2028-01-31', 2), '2028-03-31');
  assert.equal(addMonthsAnchored('2028-01-31', 13), '2029-02-28');
  const result = forecastCashflow(base({
    openingDate: '2028-01-01', asOfDate: '2028-01-10', horizonMonths: 3,
    plans: [out('monthly', '2028-01-31', 100, 'obligation', { everyMonths: 1 })],
  }));
  assert.deepEqual(result.days.filter(d => d.plannedExpenseCents > 0).map(d => d.date),
    ['2028-01-31', '2028-02-29', '2028-03-31']);
});

test('year rollover, interval recurrence and inclusive untilDate', () => {
  const result = forecastCashflow(base({
    asOfDate: '2026-12-15', horizonMonths: 6, openingDate: '2026-12-01',
    plans: [out('every2', '2026-12-31', 30_000, 'irregular',
      { everyMonths: 2, untilDate: '2027-04-30' })],
  }));
  assert.deepEqual(result.days.filter(d => d.plannedExpenseCents).map(d => d.date),
    ['2026-12-31', '2027-02-28', '2027-04-30']);
});

test('partial payments reduce only the unpaid future occurrence', () => {
  const result = forecastCashflow(base({
    openingDate: '2026-11-01', asOfDate: '2026-11-08',
    plans: [out('bill', '2026-11-15', 50_000)],
    actuals: [actual('p1', '2026-11-03', 10_000, 'expense', 'bill', '2026-11-15'),
      actual('p2', '2026-11-07', 15_000, 'expense', 'bill', '2026-11-15')],
  }));
  assert.equal(result.confirmedAsOfBalanceCents, 1_975_000);
  assert.equal(on(result, '2026-11-15').projectedExpenseCents, 25_000);
  assert.equal(result.expectedClosingBalanceCents, 1_950_000);
  assert.equal(result.planVsActual.actualExpenseCents, 25_000);
});

test('prepaid fact already in opening balance reduces future installment without second bank debit', () => {
  const result = forecastCashflow(base({
    plans: [out('bill', '2026-11-15', 70_000)],
    actuals: [actual('before-snapshot', '2026-11-07', 20_000, 'expense', 'bill', '2026-11-15')],
  }));
  assert.equal(result.confirmedAsOfBalanceCents, 2_000_000);
  assert.equal(on(result, '2026-11-15').projectedExpenseCents, 50_000);
});

test('overdue and missed expense is catch-up exposure on asOfDate, not a fact or silent write-off', () => {
  const result = forecastCashflow(base({
    openingDate: '2026-11-01',
    plans: [out('late', '2026-11-03', 2_500_000)],
    actuals: [],
  }));
  assert.deepEqual(result.firstCashGap, { date: '2026-11-08', shortfallCents: 500_000 });
  assert.equal(result.totalOverdueExpenseCents, 2_500_000);
  assert.equal(result.confirmedAsOfBalanceCents, 2_000_000);
  assert.equal(on(result, '2026-11-08').expectedBalanceCents, -500_000);
  assert.equal(result.planVsActual.varianceCents, 2_500_000);
});

test('overdue expense is not charged again when linked payment was fully settled', () => {
  const result = forecastCashflow(base({
    openingDate: '2026-11-01', plans: [out('due', '2026-11-03', 50_000)],
    actuals: [actual('paid', '2026-11-04', 50_000, 'expense', 'due', '2026-11-03')],
  }));
  assert.equal(result.totalOverdueExpenseCents, 0);
  assert.equal(result.confirmedAsOfBalanceCents, 1_950_000);
  assert.equal(result.expectedClosingBalanceCents, 1_950_000);
});

test('partial missed installment is exposed only for its remaining amount', () => {
  const result = forecastCashflow(base({
    openingDate: '2026-11-01', plans: [out('late', '2026-11-04', 65_000)],
    actuals: [actual('partial', '2026-11-06', 15_000, 'expense', 'late', '2026-11-04')],
  }));
  assert.equal(result.totalOverdueExpenseCents, 50_000);
  assert.equal(result.confirmedAsOfBalanceCents, 1_985_000);
  assert.equal(on(result, '2026-11-08').expectedBalanceCents, 1_935_000);
});

test('missed income is not silently assumed to arrive later', () => {
  const result = forecastCashflow(base({
    openingDate: '2026-11-01', plans: [income('salary', '2026-11-03', 200_000)],
  }));
  assert.equal(result.totalUnrealizedIncomeCents, 200_000);
  assert.equal(result.expectedClosingBalanceCents, 2_000_000);
  assert.equal(result.planVsActual.varianceCents, -200_000);
});

test('unlinked incoming actual is booked; transfer has zero aggregate external effect', () => {
  const result = forecastCashflow(base({
    openingDate: '2026-11-01',
    actuals: [actual('wages', '2026-11-04', 150_000, 'income'),
      actual('between-own-accounts', '2026-11-05', 5_000_000, 'transfer')],
  }));
  assert.equal(result.confirmedAsOfBalanceCents, 2_150_000);
  assert.equal(result.planVsActual.actualIncomeCents, 150_000);
  assert.equal(result.planVsActual.actualExpenseCents, 0);
  assert.equal(on(result, '2026-11-05').actualIncomeCents, 0);
});

test('reserves never alter bank balance; releases offset the accessible impact of payment', () => {
  const result = forecastCashflow(base({
    openingReservedCents: 100_000,
    plans: [out('pay', '2026-11-12', 200_000)],
    reserves: [{ id: 'use-reserve', date: '2026-11-12', kind: 'release',
      amountCents: 100_000, status: 'planned' }],
  }));
  assert.equal(result.confirmedAsOfBalanceCents, 2_000_000);
  assert.equal(on(result, '2026-11-08').expectedAvailableCents, 1_900_000);
  assert.equal(on(result, '2026-11-12').expectedBalanceCents, 1_800_000);
  assert.equal(on(result, '2026-11-12').expectedReservedCents, 0);
  assert.equal(on(result, '2026-11-12').expectedAvailableCents, 1_800_000);
});

test('reserving cash changes available, not bank, including actual booking and future allocation', () => {
  const result = forecastCashflow(base({
    openingDate: '2026-11-01',
    reserves: [{ id: 'fact', date: '2026-11-04', kind: 'allocate', amountCents: 20_000, status: 'actual' },
      { id: 'future', date: '2026-11-11', kind: 'allocate', amountCents: 30_000, status: 'planned' }],
  }));
  assert.equal(result.confirmedAsOfReservedCents, 20_000);
  assert.equal(on(result, '2026-11-11').expectedBalanceCents, 2_000_000);
  assert.equal(on(result, '2026-11-11').expectedAvailableCents, 1_950_000);
});

test('actual reserve release and actual booked expense are independent, not double debit', () => {
  const result = forecastCashflow(base({
    openingDate: '2026-11-01', openingReservedCents: 100_000,
    plans: [out('paid', '2026-11-05', 100_000)],
    actuals: [actual('receipt', '2026-11-05', 100_000, 'expense', 'paid', '2026-11-05')],
    reserves: [{ id: 'release', date: '2026-11-05', kind: 'release', amountCents: 100_000, status: 'actual' }],
  }));
  assert.equal(result.confirmedAsOfBalanceCents, 1_900_000);
  assert.equal(result.confirmedAsOfReservedCents, 0);
  assert.equal(result.expectedClosingAvailableCents, 1_900_000);
  assert.equal(result.totalOverdueExpenseCents, 0);
});

test('cancellation of an individual occurrence retains later recurring payments', () => {
  const result = forecastCashflow(base({
    horizonMonths: 3,
    plans: [out('regular', '2026-11-12', 30_000, 'obligation', { everyMonths: 1 })],
    overrides: [{ planId: 'regular', occurrenceDate: '2026-12-12', cancelled: true }],
  }));
  assert.deepEqual(result.days.filter(d => d.projectedExpenseCents > 0).map(d => d.date),
    ['2026-11-12', '2027-01-12']);
});

test('rescheduling one occurrence moves original identity once, including 31st', () => {
  const result = forecastCashflow(base({
    asOfDate: '2028-01-15', openingDate: '2028-01-01', horizonMonths: 3,
    plans: [out('rent', '2028-01-31', 50_000, 'obligation', { everyMonths: 1 })],
    overrides: [{ planId: 'rent', occurrenceDate: '2028-02-29', date: '2028-03-02', amountCents: 40_000 }],
  }));
  assert.equal(on(result, '2028-02-29').projectedExpenseCents, 0);
  assert.equal(on(result, '2028-03-02').projectedExpenseCents, 40_000);
  assert.equal(on(result, '2028-03-31').projectedExpenseCents, 50_000);
});

test('early loan payoff is a fact; adapter cancels obsolete future loan installments', () => {
  const result = forecastCashflow(base({
    openingDate: '2026-11-01',
    plans: [out('loan', '2026-11-15', 100_000, 'loan', { everyMonths: 1 })],
    actuals: [actual('payoff', '2026-11-05', 250_000, 'expense')],
    overrides: [{ planId: 'loan', occurrenceDate: '2026-11-15', cancelled: true },
      { planId: 'loan', occurrenceDate: '2026-12-15', cancelled: true }],
  }));
  assert.equal(result.confirmedAsOfBalanceCents, 1_750_000);
  assert.equal(result.expectedClosingBalanceCents, 1_750_000);
  assert.equal(on(result, '2026-11-15').projectedExpenseCents, 0);
});

test('voided payment and voided reservation are ignored without negative phantom entries', () => {
  const result = forecastCashflow(base({
    openingDate: '2026-11-01', plans: [out('bill', '2026-11-05', 40_000)],
    actuals: [{ ...actual('void', '2026-11-04', 40_000, 'expense', 'bill', '2026-11-05'), voided: true }],
    reserves: [{ id: 'void-reserve', date: '2026-11-04', kind: 'allocate',
      amountCents: 30_000, status: 'actual', voided: true }],
  }));
  assert.equal(result.confirmedAsOfBalanceCents, 2_000_000);
  assert.equal(result.confirmedAsOfReservedCents, 0);
  assert.equal(result.totalOverdueExpenseCents, 40_000);
});

test('existing realized fact is retained when its plan is cancelled', () => {
  const result = forecastCashflow(base({
    openingDate: '2026-11-01', plans: [{ ...out('bill', '2026-11-05', 40_000), cancelled: true }],
    actuals: [actual('paid', '2026-11-04', 40_000, 'expense', 'bill', '2026-11-05')],
  }));
  assert.equal(result.confirmedAsOfBalanceCents, 1_960_000);
  assert.equal(result.totalOverdueExpenseCents, 0);
});

test('estimated future income is explicit and has a separate summary, not called confirmed', () => {
  const result = forecastCashflow(base({ plans: [income('approx', '2026-11-10', 300_000),
    income('certified', '2026-11-15', 50_000, { confidence: 'confirmed' })] }));
  assert.equal(result.totalEstimatedFutureIncomeCents, 300_000);
  assert.equal(result.confirmedAsOfBalanceCents, 2_000_000);
  assert.equal(result.expectedClosingBalanceCents, 2_350_000);
});

test('invariant: input is unchanged and input ordering cannot alter result', () => {
  const plans = Object.freeze([
    Object.freeze(out('b', '2026-12-01', 60_000)),
    Object.freeze(income('a', '2026-11-15', 90_000)),
  ]);
  const actuals = Object.freeze([
    Object.freeze(actual('x', '2026-11-06', 25_000, 'expense')),
    Object.freeze(actual('y', '2026-11-07', 30_000, 'income')),
  ]);
  const input = Object.freeze(base({ openingDate: '2026-11-01', plans, actuals }));
  const result = forecastCashflow(input);
  assert.deepEqual(result, forecastCashflow(base({ ...input, plans: [...plans].reverse(), actuals: [...actuals].reverse() })));
  assert.equal(input.openingBalanceCents, 2_000_000);
});

test('pure source adapter sums multiple accounts and reserves, validating identity', () => {
  const sources = {
    openingDate: '2026-11-08', asOfDate: '2026-11-08', horizonMonths: 1,
    accounts: [{ id: 'card', currency: 'RUB', openingBalanceCents: 1_500_000 },
      { id: 'cash', currency: 'RUB', openingBalanceCents: 500_000 }],
    reserves: [{ id: 'tax', accountId: 'card', openingReservedCents: 300_000 }],
    plans: [], actuals: [], reserveMovements: [],
  };
  const input = adaptCashflowSources(sources);
  const result = forecastCashflow(input);
  assert.equal(result.confirmedAsOfBalanceCents, 2_000_000);
  assert.equal(result.expectedClosingAvailableCents, 1_700_000);
  assert.throws(() => adaptCashflowSources({ ...sources, reserves: [
    { id: 'unknown', accountId: 'other', openingReservedCents: 1 }] }), /unknown account/);
});

test('validation fails closed on unsafe cents, invalid calendar, future facts and duplicates', () => {
  const invalid = [
    [base({ openingBalanceCents: 1.1 }), /safe integer/],
    [base({ openingReservedCents: -1 }), /nonnegative/],
    [base({ plans: [out('bad', '2026-02-29', 1)] }), /Invalid ISO/],
    [base({ horizonMonths: 2 }), /horizonMonths/],
    [base({ asOfDate: '2026-11-07' }), /asOfDate/],
    [base({ actuals: [actual('future', '2026-11-09', 1, 'expense')] }), /Future actual/],
    [base({ plans: [out('id', '2026-11-12', 1), out('id', '2026-11-13', 1)] }), /Duplicate plan/],
    [base({ actuals: [actual('dup', '2026-11-02', 1, 'expense'),
      actual('dup', '2026-11-03', 1, 'income')] }), /Duplicate actual/],
    [base({ openingBalanceCents: Number.MAX_SAFE_INTEGER,
      plans: [income('overflow', '2026-11-10', 1)] }), /exceeds/],
    [base({ reserves: [{ id: 'bad', date: '2026-11-12', kind: 'release',
      amountCents: 100, status: 'planned' }] }), /reserves negative/],
  ];
  for (const [input, error] of invalid) assert.throws(() => forecastCashflow(input), error);
});

test('validation rejects orphan settlements, wrong kind, overpayment and duplicate overrides', () => {
  const bill = out('bill', '2026-11-12', 40_000);
  assert.throws(() => forecastCashflow(base({ plans: [bill],
    actuals: [actual('wrong', '2026-11-08', 1, 'income', 'bill', '2026-11-12')] })), /incompatible/);
  assert.throws(() => forecastCashflow(base({ plans: [bill],
    actuals: [actual('ghost', '2026-11-08', 1, 'expense', 'bill', '2026-12-12')] })), /incompatible/);
  assert.throws(() => forecastCashflow(base({ plans: [bill],
    actuals: [actual('too-much', '2026-11-08', 40_001, 'expense', 'bill', '2026-11-12')] })), /exceeds/);
  assert.throws(() => forecastCashflow(base({ plans: [bill], overrides: [
    { planId: 'bill', occurrenceDate: '2026-11-12', cancelled: true },
    { planId: 'bill', occurrenceDate: '2026-11-12', cancelled: true },
  ] })), /Duplicate occurrence/);
});

test('validation refuses impossible monthly cadence and malicious future reserve fact', () => {
  assert.throws(() => forecastCashflow(base({ plans: [out('bad', '2026-11-12', 1,
    'obligation', { everyMonths: 0 })] })), /everyMonths/);
  assert.throws(() => forecastCashflow(base({ reserves: [{ id: 'not-yet', date: '2026-11-10',
    status: 'actual', kind: 'allocate', amountCents: 100 }] })), /Future reserve/);
});

test('same-day planned reserve release can support overdue payment without changing confirmed cash', () => {
  const result = forecastCashflow(base({
    openingReservedCents: 100_000,
    plans: [out('due-today', '2026-11-08', 100_000)],
    reserves: [{ id: 'release-today', date: '2026-11-08', kind: 'release',
      amountCents: 100_000, status: 'planned' }],
  }));
  assert.equal(result.confirmedAsOfBalanceCents, 2_000_000);
  assert.equal(result.confirmedAsOfReservedCents, 100_000);
  assert.equal(on(result, '2026-11-08').expectedReservedCents, 0);
  assert.equal(on(result, '2026-11-08').expectedAvailableCents, 1_900_000);
});

test('calendar occurrence metadata preserves kind, original due date and settlement state', () => {
  const result = forecastCashflow(base({
    openingDate: '2026-11-01', plans: [out('loan', '2026-11-12', 90_000, 'loan')],
    actuals: [actual('partial', '2026-11-05', 40_000, 'expense', 'loan', '2026-11-12')],
    overrides: [{ planId: 'loan', occurrenceDate: '2026-11-12', date: '2026-11-15' }],
  }));
  assert.deepEqual(result.occurrences, [{
    planId: 'loan', occurrenceDate: '2026-11-12', date: '2026-11-15', kind: 'loan',
    amountCents: 90_000, settledCents: 40_000, remainingCents: 50_000,
    confidence: 'estimated', overdue: false,
  }]);
});

test('settlements outside projection horizon still cannot overpay a planned occurrence', () => {
  const input = base({
    plans: [out('distant', '2027-12-01', 100)],
    actuals: [actual('early', '2026-11-08', 101, 'expense', 'distant', '2027-12-01')],
  });
  assert.throws(() => forecastCashflow(input), /exceeds/);
});

test('source adapter rejects implicit zero balances and mixed currencies', () => {
  const sample = {
    openingDate: '2026-11-08', asOfDate: '2026-11-08', horizonMonths: 1,
    accounts: [], reserves: [], plans: [], actuals: [],
  };
  assert.throws(() => adaptCashflowSources(sample), /Explicit confirmed account/);
  assert.throws(() => adaptCashflowSources({ ...sample, accounts: [
    { id: 'foreign', currency: 'EUR', openingBalanceCents: 1 },
  ] }), /Only RUB/);
});
