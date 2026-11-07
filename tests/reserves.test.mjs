import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addReserveMonths,
  assessReserveContribution,
  calculateReserve,
} from '../src/domain/reserves/index.ts';

const definition = (overrides = {}) => ({
  id: 'reserve-tax',
  title: 'Годовой налог',
  openedOn: '2026-01-31',
  firstDueDate: '2027-01-31',
  periodMonths: 12,
  targetCents: 2_400_000,
  openingReservedCents: 0,
  contributionMode: 'auto',
  dueDay: 31,
  ...overrides,
});
const event = (kind, id, date, extra = {}) => ({ kind, id, reserveId: 'reserve-tax', date, ...extra });
const project = (events = [], date = '2026-01-31', overrides = {}) =>
  calculateReserve(definition(overrides), events, date);

for (const period of [1, 2, 3, 6, 12, 60]) {
  test(`periodicity ${period}: deterministic ${period}-month installments, no overflow`, () => {
    const due = addReserveMonths('2026-01-31', period, 31);
    const snapshot = project([], '2026-01-31', {
      periodMonths: period,
      firstDueDate: due,
      targetCents: 120_000 * period,
    });
    assert.equal(snapshot.schedule.length, period);
    assert.equal(snapshot.dueDate, due);
    assert.equal(snapshot.schedule.reduce((sum, x) => sum + x.amountCents, 0), 120_000 * period);
    assert.ok(snapshot.schedule.every((x) => x.amountCents === 120_000));
  });
}

test('annual obligation 24,000 rubles becomes 12 exact installments of 2,000 rubles', () => {
  const snapshot = project();
  assert.equal(snapshot.targetCents, 2_400_000);
  assert.equal(snapshot.schedule.length, 12);
  assert.deepEqual(snapshot.schedule[0], { date: '2026-02-28', amountCents: 200_000 });
  assert.deepEqual(snapshot.schedule.at(-1), { date: '2027-01-31', amountCents: 200_000 });
  assert.equal(snapshot.totalPaidCents, 0);
  assert.equal(snapshot.reservedCents, 0);
  assert.equal(snapshot.daysUntilDue, 365);
});

test('last installment corrects rounding with all calculations in kopecks', () => {
  const snapshot = project([], '2026-01-31', {
    periodMonths: 3,
    firstDueDate: '2026-04-30',
    targetCents: 100,
  });
  assert.deepEqual(snapshot.schedule.map((x) => x.amountCents), [33, 33, 34]);
  const tiny = project([], '2026-01-31', {
    periodMonths: 3,
    firstDueDate: '2026-04-30',
    targetCents: 1,
  });
  assert.deepEqual(tiny.schedule.map((x) => x.amountCents), [0, 0, 1]);
});

test('31st clamps to February then restores the 31st without drift', () => {
  assert.equal(addReserveMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addReserveMonths('2026-01-31', 2), '2026-03-31');
  assert.equal(addReserveMonths('2026-01-31', 13), '2027-02-28');
  assert.equal(addReserveMonths('2026-01-31', 25), '2028-02-29');
  assert.equal(addReserveMonths('2026-12-31', 2), '2027-02-28');
  assert.equal(addReserveMonths('2027-02-28', 12, 31), '2028-02-29');
});

test('leap-day anchor survives 29 February -> 28 February -> 29 February across cycles', () => {
  const base = definition({
    openedOn: '2024-02-28',
    firstDueDate: '2024-02-29',
    dueDay: 29,
    periodMonths: 12,
    targetCents: 1,
  });
  const years = [2024, 2025, 2026, 2027];
  const log = [];
  for (const year of years) {
    const due = `${year}-02-${year === 2024 ? '29' : '28'}`;
    log.push(event('payment', `pay-${year}`, due, { amountCents: 1, reservedUsedCents: 0 }));
    log.push(event('cycle_close', `close-${year}`, due));
  }
  const snap = calculateReserve(base, log, '2028-02-29');
  assert.equal(snap.cycleNumber, 5);
  assert.equal(snap.dueDate, '2028-02-29');
  assert.equal(snap.totalPaidCents, 4);
  assert.equal(snap.daysUntilDue, 0);
});

test('explicit dueDay preserves end-of-month when first date is already clamped', () => {
  const snap = calculateReserve(definition({
    openedOn: '2027-01-31',
    firstDueDate: '2027-02-28',
    periodMonths: 1,
    dueDay: 31,
  }), [], '2027-01-31');
  assert.deepEqual(snap.schedule.map((x) => x.date), ['2027-02-28']);
});

test('early contribution only moves earmarking, recalculates future schedule', () => {
  const actions = [event('contribution', 'topup', '2026-02-01', { amountCents: 600_000 })];
  const snap = project(actions, '2026-02-01');
  assert.equal(snap.reservedCents, 600_000);
  assert.equal(snap.fundingGapCents, 1_800_000);
  assert.equal(snap.schedule.length, 12);
  assert.equal(snap.schedule[0].amountCents, 150_000);
  assert.equal(snap.totalPaidCents, 0);
  assert.equal(snap.totalContributedCents, 600_000);
});

test('missed monthly slot is audited and remaining automatic installments recalculate', () => {
  const snap = project([
    event('skip', 'miss-feb', '2026-02-28', { slotDate: '2026-02-28' }),
  ], '2026-02-28');
  assert.equal(snap.skippedContributions, 1);
  assert.equal(snap.schedule.length, 11);
  assert.equal(snap.schedule[0].amountCents, 218_181);
  assert.equal(snap.schedule.at(-1).amountCents, 218_190);
  assert.equal(snap.fundingGapCents, 2_400_000);
});

test('fixed contribution reports a genuine projected shortfall, not a fake expense', () => {
  const snap = project([], '2026-01-31', {
    contributionMode: 'fixed',
    fixedMonthlyCents: 150_000,
  });
  assert.equal(snap.schedule.length, 12);
  assert.equal(snap.projectedShortfallCents, 600_000);
  assert.equal(snap.totalPaidCents, 0);
});

test('fixed contributions cap at remaining gap and never force overfunding', () => {
  const snap = project([], '2026-01-31', {
    targetCents: 100,
    contributionMode: 'fixed',
    fixedMonthlyCents: 60,
  });
  assert.deepEqual(snap.schedule.map((x) => x.amountCents).slice(0, 3), [60, 40, 0]);
  assert.equal(snap.projectedShortfallCents, 0);
});

test('changing target increases future planned contributions without changing confirmed payments', () => {
  const actions = [
    event('target_change', 'new-target', '2026-02-28', { targetCents: 3_000_000 }),
  ];
  const snap = project(actions, '2026-02-28');
  assert.equal(snap.targetCents, 3_000_000);
  assert.equal(snap.fundingGapCents, 3_000_000);
  assert.equal(snap.totalPaidCents, 0);
  assert.equal(snap.schedule.reduce((sum, x) => sum + x.amountCents, 0), 3_000_000);
});

test('partial payment debits reserve once and records the actual paid amount once', () => {
  const actions = [
    event('contribution', 'fund', '2026-02-01', { amountCents: 600_000 }),
    event('payment', 'paid-once', '2026-02-02', { amountCents: 800_000, reservedUsedCents: 600_000 }),
  ];
  const snap = project(actions, '2026-02-02');
  assert.equal(snap.reservedCents, 0);
  assert.equal(snap.totalContributedCents, 600_000);
  assert.equal(snap.totalPaidCents, 800_000);
  assert.equal(snap.totalReservedUsedCents, 600_000);
  assert.equal(snap.remainingObligationCents, 1_600_000);
  assert.equal(snap.fundingGapCents, 1_600_000);
  assert.equal(snap.cyclePaid, false);
});

test('payment may use bank funds not yet reserved, but never claims reserve already paid it', () => {
  const snap = project([
    event('payment', 'from-bank', '2026-02-01', { amountCents: 500_000, reservedUsedCents: 0 }),
  ], '2026-02-01');
  assert.equal(snap.totalPaidCents, 500_000);
  assert.equal(snap.reservedCents, 0);
  assert.equal(snap.remainingObligationCents, 1_900_000);
});

test('full payment, close cycle and carry unused earmarked balance forward', () => {
  const snap = project([
    event('contribution', 'fund', '2026-02-01', { amountCents: 3_000_000 }),
    event('payment', 'tax', '2027-01-31', { amountCents: 2_400_000, reservedUsedCents: 2_400_000 }),
    event('cycle_close', 'close', '2027-01-31'),
  ], '2027-01-31');
  assert.equal(snap.cycleNumber, 2);
  assert.equal(snap.dueDate, '2028-01-31');
  assert.equal(snap.reservedCents, 600_000);
  assert.equal(snap.paidThisCycleCents, 0);
  assert.equal(snap.totalPaidCents, 2_400_000);
  assert.equal(snap.fundingGapCents, 1_800_000);
  assert.equal(snap.schedule.length, 12);
  assert.equal(snap.schedule[0].amountCents, 150_000);
});

test('early full settlement permits early cycle close; partial settlement does not', () => {
  const full = [
    event('payment', 'full', '2026-03-01', { amountCents: 2_400_000, reservedUsedCents: 0 }),
    event('cycle_close', 'close', '2026-03-01'),
  ];
  assert.equal(project(full, '2026-03-01').cycleNumber, 2);
  assert.throws(() => project([
    event('payment', 'partial', '2026-03-01', { amountCents: 100, reservedUsedCents: 0 }),
    event('cycle_close', 'close', '2026-03-01'),
  ], '2026-03-01'), /только после полной оплаты/);
});

test('after due date, missing reserve becomes immediate funding requirement', () => {
  const snap = project([], '2027-02-01');
  assert.equal(snap.overdue, true);
  assert.equal(snap.schedule.length, 0);
  assert.equal(snap.immediateFundingRequiredCents, 2_400_000);
  assert.equal(snap.projectedShortfallCents, 2_400_000);
  assert.equal(snap.daysUntilDue, -1);
});

test('funding preview detects insufficient non-reserved account money without modifying it', () => {
  const account = Object.freeze({ balanceCents: 500_000, unreservedAvailableCents: 250_000 });
  assert.deepEqual(assessReserveContribution(300_000, account.unreservedAvailableCents), {
    canFund: false,
    shortfallCents: 50_000,
  });
  assert.deepEqual(assessReserveContribution(200_000, account.unreservedAvailableCents), {
    canFund: true,
    shortfallCents: 0,
  });
  assert.equal(account.balanceCents, 500_000);
});

test('voiding a top-up restores the plan and leaves a traceable immutable history', () => {
  const events = Object.freeze([
    Object.freeze(event('contribution', 'topup', '2026-02-01', { amountCents: 1_200_000 })),
    Object.freeze(event('void', 'undo', '2026-02-02', { targetEventId: 'topup' })),
  ]);
  const original = JSON.parse(JSON.stringify(events));
  const snap = project(events, '2026-02-02');
  assert.equal(snap.reservedCents, 0);
  assert.equal(snap.totalContributedCents, 0);
  assert.equal(snap.history.length, 2);
  assert.equal(snap.history[0].voided, true);
  assert.equal(snap.history[0].cycleNumber, null);
  assert.equal(snap.history[1].voided, false);
  assert.deepEqual(events, original);
});

test('voiding a payment recovers reserved money and prevents duplicate accounting', () => {
  const actions = [
    event('contribution', 'fund', '2026-02-01', { amountCents: 1_000_000 }),
    event('payment', 'mistake', '2026-02-02', { amountCents: 300_000, reservedUsedCents: 300_000 }),
    event('void', 'undo', '2026-02-03', { targetEventId: 'mistake' }),
  ];
  const snap = project(actions, '2026-02-03');
  assert.equal(snap.reservedCents, 1_000_000);
  assert.equal(snap.paidThisCycleCents, 0);
  assert.equal(snap.totalPaidCents, 0);
  assert.equal(snap.totalReservedUsedCents, 0);
  assert.equal(snap.history[1].voided, true);
});

test('voiding a skipped installment removes its status and keeps all dates valid', () => {
  const actions = [
    event('skip', 'skip', '2026-02-28', { slotDate: '2026-02-28' }),
    event('void', 'restore', '2026-03-01', { targetEventId: 'skip' }),
  ];
  assert.equal(project(actions, '2026-03-01').skippedContributions, 0);
});

test('dependent closure cannot survive reversal of a payment, even when void refers backward', () => {
  const actions = [
    event('payment', 'pay', '2026-02-01', { amountCents: 2_400_000, reservedUsedCents: 0 }),
    event('cycle_close', 'close', '2026-02-01'),
    event('void', 'undo', '2026-02-02', { targetEventId: 'pay' }),
  ];
  assert.throws(() => project(actions, '2026-02-02'), /только после полной оплаты/);
});

test('reserve and input history remain separate from real account balance: no double spend', () => {
  const accountBalance = 4_000_000;
  const actions = [
    event('contribution', 'earmark', '2026-02-01', { amountCents: 700_000 }),
    event('payment', 'posted-transaction', '2026-02-02', { amountCents: 700_000, reservedUsedCents: 700_000 }),
  ];
  const snap = project(actions, '2026-02-02');
  // The domain records one actual payment; its account debit belongs exclusively to #33.
  assert.equal(accountBalance - snap.totalPaidCents, 3_300_000);
  assert.equal(accountBalance - snap.totalPaidCents - snap.totalContributedCents, 2_600_000,
    'subtracting contributions again would be the forbidden double debit');
  assert.equal(snap.reservedCents, 0);
  assert.equal(snap.totalPaidCents, 700_000);
});

test('reject malformed money, unsupported period and invalid date instead of rounding', () => {
  for (const bad of [-1, 1.2, NaN, Infinity, '100', 1_000_000_000_001]) {
    assert.throws(() => project([], '2026-01-31', { targetCents: bad }));
  }
  for (const bad of [0, 61, 1.5, '12']) {
    assert.throws(() => project([], '2026-01-31', { periodMonths: bad }));
  }
  for (const bad of ['2026-02-29', '2026-13-01', '0000-01-01', '2026-04-31', '2026-1-1']) {
    assert.throws(() => project([], bad));
  }
  assert.throws(() => project([], '2026-01-30'));
  assert.throws(() => addReserveMonths('9999-12-31', 1));
});

test('reject payment exceeding reserve, target or invalid reserve usage', () => {
  assert.throws(() => project([
    event('payment', 'bad', '2026-02-01', { amountCents: 10, reservedUsedCents: 11 }),
  ], '2026-02-01'), /больше суммы оплаты/);
  assert.throws(() => project([
    event('payment', 'bad', '2026-02-01', { amountCents: 10, reservedUsedCents: 1 }),
  ], '2026-02-01'), /больше зарезервированных/);
  assert.throws(() => project([
    event('payment', 'bad', '2026-02-01', { amountCents: 2_400_001, reservedUsedCents: 0 }),
  ], '2026-02-01'), /превышает остаток/);
});

test('reject duplicate event IDs, void twice, void of void, non-existent target and future events', () => {
  const topup = event('contribution', 'same', '2026-02-01', { amountCents: 10 });
  assert.throws(() => project([topup, topup], '2026-02-01'), /Повторяющийся/);
  assert.throws(() => project([event('void', 'undo', '2026-02-01', { targetEventId: 'unknown' })], '2026-02-01'));
  const voided = [topup, event('void', 'undo', '2026-02-02', { targetEventId: 'same' })];
  assert.throws(() => project([...voided, event('void', 'again', '2026-02-03', { targetEventId: 'same' })], '2026-02-03'));
  assert.throws(() => project([...voided, event('void', 'again', '2026-02-03', { targetEventId: 'undo' })], '2026-02-03'));
  assert.throws(() => project([topup], '2026-01-31'), /будущее/);
  assert.throws(() => project([
    event('contribution', 'late', '2026-03-01', { amountCents: 10 }),
    event('contribution', 'early', '2026-02-01', { amountCents: 10 }),
  ], '2026-03-01'), /упорядочены/);
});

test('invalid skip dates, duplicate skips and target lower than paid are rejected', () => {
  assert.throws(() => project([
    event('skip', 'bad', '2026-02-15', { slotDate: '2026-02-28' }),
  ], '2026-02-15'), /будущий/);
  assert.throws(() => project([
    event('skip', 'bad', '2026-02-27', { slotDate: '2026-02-27' }),
  ], '2026-02-27'), /не соответствует/);
  assert.throws(() => project([
    event('skip', 'first', '2026-02-28', { slotDate: '2026-02-28' }),
    event('skip', 'second', '2026-02-28', { slotDate: '2026-02-28' }),
  ], '2026-02-28'), /уже отмечен/);
  assert.throws(() => project([
    event('payment', 'paid', '2026-02-01', { amountCents: 100_000, reservedUsedCents: 0 }),
    event('target_change', 'low', '2026-02-02', { targetCents: 99_999 }),
  ], '2026-02-02'), /ниже уже оплаченной/);
});

test('opening earmarked money reduces target funding, not expenses or total assets', () => {
  const snap = project([], '2026-01-31', { openingReservedCents: 700_000 });
  assert.equal(snap.reservedCents, 700_000);
  assert.equal(snap.fundingGapCents, 1_700_000);
  assert.equal(snap.totalContributedCents, 0);
  assert.equal(snap.totalPaidCents, 0);
});

test('legacy v1/v2 payloads are not changed by an independent domain import', () => {
  const oldRecord = Object.freeze({
    version: 1,
    entries: Object.freeze([{ id: 'old', amountCents: 123 }]),
    loans: Object.freeze([]),
  });
  const snap = project();
  assert.equal(snap.totalPaidCents, 0);
  assert.deepEqual(oldRecord, { version: 1, entries: [{ id: 'old', amountCents: 123 }], loans: [] });
});

test('event from another reserve is rejected instead of leaking money between reserves', () => {
  const alien = event('contribution', 'alien', '2026-02-01', { amountCents: 100 });
  alien.reserveId = 'another-reserve';
  assert.throws(() => project([alien], '2026-02-01'), /другому резерву/);
});

test('an old cycle contribution cannot be marked missed after that cycle is closed', () => {
  const actions = [
    event('payment', 'paid', '2027-01-31', { amountCents: 2_400_000, reservedUsedCents: 0 }),
    event('cycle_close', 'close', '2027-01-31'),
    event('skip', 'old-miss', '2027-02-01', { slotDate: '2026-02-28' }),
  ];
  assert.throws(() => project(actions, '2027-02-01'), /текущему циклу/);
});

test('voiding a target change restores the original target and recalculates cents', () => {
  const changes = [
    event('target_change', 'increase', '2026-02-01', { targetCents: 3_000_000 }),
    event('void', 'undo-increase', '2026-02-02', { targetEventId: 'increase' }),
  ];
  const snap = project(changes, '2026-02-02');
  assert.equal(snap.targetCents, 2_400_000);
  assert.equal(snap.history[0].voided, true);
  assert.equal(snap.fundingGapCents, 2_400_000);
});

test('canceling an unreferenced cycle close returns to paid previous cycle', () => {
  const events = [
    event('payment', 'paid', '2027-01-31', { amountCents: 2_400_000, reservedUsedCents: 0 }),
    event('cycle_close', 'close', '2027-01-31'),
    event('void', 'undo-close', '2027-02-01', { targetEventId: 'close' }),
  ];
  const snap = project(events, '2027-02-01');
  assert.equal(snap.cycleNumber, 1);
  assert.equal(snap.dueDate, '2027-01-31');
  assert.equal(snap.cyclePaid, true);
  assert.equal(snap.overdue, false);
});

test('cannot fund from negative, fractional, infinite or unbounded available account amounts', () => {
  for (const bad of [-1, 0.001, Infinity, NaN, 1_000_000_000_001]) {
    assert.throws(() => assessReserveContribution(100, bad));
  }
});
