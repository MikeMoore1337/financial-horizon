import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGoal, applyGoalEvent, calculateGoal, goalInstallments, goalJournal,
  goalLedgerLinks, goalForecastReservations, goalDueDates, monthDue,
} from '../src/domain/goals/index.ts';

const GOAL = {
  id: 'goal-1', eventId: 'goal-created', on: '2026-01-01', title: 'Финансовая подушка',
  category: 'emergency', targetCents: 12_000_000, targetDate: '2027-01-01', openingCents: 0,
};
const fresh = (changes = {}) => createGoal({ ...GOAL, ...changes });
const add = (goal, id, on, amountCents, extra = {}) => applyGoalEvent(goal, {
  id, type: 'contribution', on, amountCents, funding: 'virtual', ...extra,
});
const use = (goal, id, on, amountCents, extra = {}) => applyGoalEvent(goal, {
  id, type: 'use', on, amountCents, usage: 'virtual-release', ...extra,
});
const change = (goal, id, on, changes) => applyGoalEvent(goal, {
  id, type: 'update', on, changes,
});
const reverse = (goal, id, on, eventId, extra = {}) => applyGoalEvent(goal, {
  id, type: 'void', on, eventId, reason: 'Ошибка пользователя', ...extra,
});

test('120 000 RUB in 12 months: zero start needs precisely 10 000 RUB per month', () => {
  const goal = fresh();
  const snapshot = calculateGoal(goal, '2026-01-01');
  assert.equal(snapshot.targetCents, 12_000_000);
  assert.equal(snapshot.savedCents, 0);
  assert.equal(snapshot.remainingInstallments, 12);
  assert.equal(snapshot.monthlyCents, 1_000_000);
  assert.equal(snapshot.requiredMonthlyCents, 1_000_000);
  assert.equal(snapshot.projectedCompletionDate, '2027-01-01');
  assert.equal(snapshot.projectedOnTime, true);
  assert.equal(snapshot.progressBasisPoints, 0);
  assert.equal(goalInstallments(goal, '2026-01-01').length, 12);
  assert.deepEqual(goalJournal(goal).map((x) => x.event.type), ['create']);
});

test('early completion and lifecycle: complete, archive, restore, reopen', () => {
  const start = fresh();
  const funded = add(start, 'deposit', '2026-02-10', 12_000_000);
  assert.equal(calculateGoal(start, '2026-02-11').savedCents, 0); // immutable input
  const reached = calculateGoal(funded, '2026-02-10');
  assert.equal(reached.savedCents, 12_000_000);
  assert.equal(reached.progressBasisPoints, 10_000);
  assert.equal(reached.projectedCompletionDate, '2026-02-10');
  assert.equal(reached.reached, true);
  assert.equal(calculateGoal(funded, '2026-03-01').reachedOn, '2026-02-10');
  assert.equal(calculateGoal(funded, '2026-03-01').projectedCompletionDate, '2026-02-10');
  const complete = applyGoalEvent(funded, { id: 'done', type: 'complete', on: '2026-02-10' });
  assert.equal(calculateGoal(complete, '2026-02-10').status, 'completed');
  assert.throws(() => add(complete, 'late', '2026-02-11', 1), /Reopen/);
  const archived = applyGoalEvent(complete, { id: 'archive', type: 'archive', on: '2026-02-11' });
  assert.equal(calculateGoal(archived, '2026-02-12').status, 'archived');
  assert.equal(calculateGoal(archived, '2026-02-10').status, 'completed');
  const restored = applyGoalEvent(archived, { id: 'restore', type: 'restore', on: '2026-02-12' });
  assert.equal(calculateGoal(restored, '2026-02-12').status, 'active');
  const reopened = applyGoalEvent(complete, { id: 'reopen', type: 'reopen', on: '2026-02-12' });
  assert.equal(calculateGoal(reopened, '2026-02-12').status, 'active');
  assert.throws(() => applyGoalEvent(fresh(), { id: 'complete', type: 'complete', on: '2026-02-02' }), /only after/);
});

test('partial contribution and missed monthly installment increase required payment', () => {
  const skipped = applyGoalEvent(fresh({ monthlyCents: 1_000_000 }), {
    id: 'skip-1', type: 'skip', on: '2026-02-02', dueOn: '2026-02-01', reason: 'Нет поступлений',
  });
  const partial = add(skipped, 'partial', '2026-03-01', 500_000);
  const snapshot = calculateGoal(partial, '2026-03-02');
  assert.equal(snapshot.savedCents, 500_000);
  assert.equal(snapshot.remainingInstallments, 10);
  assert.equal(snapshot.requiredMonthlyCents, 1_150_000);
  assert.equal(snapshot.monthlyDeficitCents, 150_000);
  assert.equal(snapshot.monthlyCents, 1_000_000);
  assert.equal(snapshot.projectedCompletionDate, '2027-03-01');
  assert.equal(snapshot.projectedOnTime, false);
  const rows = goalInstallments(partial, '2026-03-02');
  assert.equal(rows[0].status, 'skipped');
  assert.equal(rows[1].status, 'partial');
  assert.equal(rows[1].actualCents, 500_000);
  assert.equal(rows[2].status, 'upcoming');
});

test('change target, deadline, monthly plan and description without mutating source', () => {
  const initial = fresh();
  const increased = change(initial, 'raise', '2026-01-05', {
    title: 'Отпуск', category: 'travel', targetCents: 18_000_000,
  });
  assert.equal(calculateGoal(increased, '2026-01-06').monthlyCents, 1_500_000);
  const extended = change(increased, 'extend', '2026-01-05', { targetDate: '2027-07-01' });
  assert.equal(calculateGoal(extended, '2026-01-06').monthlyCents, 1_000_000);
  assert.equal(calculateGoal(initial, '2026-01-06').targetCents, 12_000_000);
  const fixed = change(extended, 'fixed', '2026-01-06', {
    monthlyCents: 2_000_000, plannedFunding: 'account-transfer',
  });
  assert.equal(calculateGoal(fixed, '2026-01-06').monthlyCents, 2_000_000);
  assert.equal(goalForecastReservations(fixed, '2026-01-06')[0].funding, 'account-transfer');
});

test('partial use is a virtual release, never an expense or a second bank debit', () => {
  const saved = add(fresh(), 'add', '2026-02-01', 3_000_000);
  const spent = use(saved, 'release', '2026-02-03', 1_100_000);
  const snapshot = calculateGoal(spent, '2026-02-03');
  assert.equal(snapshot.savedCents, 1_900_000);
  assert.equal(snapshot.remainingCents, 10_100_000);
  assert.equal(goalLedgerLinks([spent]).length, 0);
  assert.ok(goalJournal(spent).every((row) => row.ledgerMutationCents === 0));
  assert.throws(() => use(spent, 'too-much', '2026-02-04', 2_000_000), /negative/);
});

test('void of wrong contribution and of wrong use restores balances at reversal date only', () => {
  const first = add(fresh(), 'deposit', '2026-02-01', 4_000_000);
  const second = use(first, 'use', '2026-02-02', 1_000_000);
  const reversedUse = reverse(second, 'void-use', '2026-02-03', 'use');
  const reversedDeposit = reverse(reversedUse, 'void-deposit', '2026-02-04', 'deposit');
  assert.equal(calculateGoal(reversedDeposit, '2026-02-01').savedCents, 4_000_000);
  assert.equal(calculateGoal(reversedDeposit, '2026-02-02').savedCents, 3_000_000);
  assert.equal(calculateGoal(reversedDeposit, '2026-02-03').savedCents, 4_000_000);
  assert.equal(calculateGoal(reversedDeposit, '2026-02-04').savedCents, 0);
  assert.equal(goalJournal(reversedDeposit).find((x) => x.event.id === 'deposit').voidedOn, '2026-02-04');
  assert.throws(() => reverse(reversedDeposit, 'again', '2026-02-05', 'deposit'), /already reversed/);
  assert.throws(() => reverse(second, 'invalid', '2026-02-03', 'deposit'), /negative/);
});

test('linked #33 transfers and expenses remain references, not automatic ledger postings', () => {
  const linked = add(fresh(), 'tr', '2026-02-01', 1_500_000, {
    funding: 'account-transfer', ledgerMovementId: 'ledger-transfer-1', idempotencyKey: 'request-1',
  });
  const purchase = use(linked, 'purchase', '2026-02-05', 500_000, {
    usage: 'expense', ledgerMovementId: 'ledger-expense-1',
  });
  assert.deepEqual(goalLedgerLinks([purchase]).map((x) => [x.kind, x.alreadyPosted]), [
    ['contribution', true], ['use', true],
  ]);
  assert.equal(calculateGoal(purchase, '2026-02-05').savedCents, 1_000_000);
  assert.throws(() => reverse(purchase, 'bad-reverse', '2026-02-06', 'purchase'), /ledger reversal/);
  const corrected = reverse(purchase, 'undo-purchase', '2026-02-06', 'purchase', {
    ledgerReversalId: 'ledger-reversal-1',
  });
  assert.equal(calculateGoal(corrected, '2026-02-06').savedCents, 1_500_000);
  assert.equal(goalLedgerLinks([corrected]).length, 3);
  assert.throws(() => add(corrected, 'duplicate-ledger', '2026-02-07', 1_000, {
    funding: 'account-transfer', ledgerMovementId: 'ledger-transfer-1',
  }), /linked twice/);
  assert.throws(() => add(fresh(), 'missing-ledger', '2026-02-01', 10_000, {
    funding: 'account-transfer',
  }), /ledger movement/);
  assert.throws(() => add(fresh(), 'fake-virtual', '2026-02-01', 10_000, {
    ledgerMovementId: 'anything',
  }), /Virtual allocation/);
  assert.throws(() => goalLedgerLinks([linked, add(fresh({ id: 'g2', eventId: 'c2' }), 'tx',
    '2026-02-01', 500, { funding: 'account-transfer', ledgerMovementId: 'ledger-transfer-1' })]),
  /multiple goals/);
});

test('idempotent retries, tampering and duplicate ids do not double count savings', () => {
  const initial = fresh();
  const event = { id: 'event-1', type: 'contribution', on: '2026-02-01', amountCents: 100_001,
    funding: 'virtual', idempotencyKey: 'request-xyz' };
  const once = applyGoalEvent(initial, event);
  assert.equal(applyGoalEvent(once, event), once);
  assert.equal(applyGoalEvent(once, { ...event, id: 'retry' }), once);
  assert.equal(calculateGoal(once, '2026-02-01').savedCents, 100_001);
  assert.throws(() => applyGoalEvent(once, { ...event, id: 'retry', amountCents: 100_000 }), /Idempotency/);
  assert.throws(() => applyGoalEvent(once, { ...event, amountCents: 10 }), /event ID/);
  assert.equal(once.events.length, 2);
  assert.equal(initial.events.length, 1);
});

test('calendar clamps 29/30/31 without drift, including leap February and year rollover', () => {
  assert.equal(monthDue('2027-01-31', 1), '2027-02-28');
  assert.equal(monthDue('2027-01-31', 2), '2027-03-31');
  assert.equal(monthDue('2028-01-31', 1), '2028-02-29');
  assert.equal(monthDue('2026-12-31', 2), '2027-02-28');
  assert.deepEqual(goalDueDates('2028-01-31', '2028-03-31'), ['2028-02-29', '2028-03-31']);
  assert.throws(() => monthDue('2026-02-30', 1), /Invalid calendar/);
  assert.throws(() => fresh({ on: '2026-02-30' }), /Invalid calendar/);
  assert.throws(() => fresh({ targetDate: '2025-12-01' }), /deadline precedes start/i);
});

test('future skip changes forecast, but no money is deducted before a real action', () => {
  let goal = fresh();
  goal = applyGoalEvent(goal, { id: 'future-skip', type: 'skip', on: '2026-01-15', dueOn: '2026-03-01' });
  const snapshot = calculateGoal(goal, '2026-01-15');
  assert.equal(snapshot.savedCents, 0);
  assert.equal(snapshot.remainingInstallments, 11);
  assert.equal(snapshot.requiredMonthlyCents, 1_090_910);
  assert.equal(snapshot.projectedCompletionDate, '2027-01-01');
  assert.equal(goalForecastReservations(goal, '2026-01-15').length, 11);
  assert.equal(goalForecastReservations(goal, '2026-01-15').reduce((sum, row) => sum + row.plannedCents, 0), 12_000_000);
  assert.ok(goalForecastReservations(goal, '2026-01-15').every((x) => x.cashFlowCents === 0 && !x.confirmed));
  const released = reverse(goal, 'void-skip', '2026-01-16', 'future-skip');
  assert.equal(calculateGoal(released, '2026-01-16').remainingInstallments, 12);
});

test('fixed zero plan reports no false achievement; overdue and large exact sums', () => {
  const idle = fresh({ monthlyCents: 0 });
  const noForecast = calculateGoal(idle, '2026-01-01');
  assert.equal(noForecast.projectedCompletionDate, null);
  assert.equal(noForecast.projectedOnTime, null);
  assert.equal(calculateGoal(idle, '2027-02-01').requiredMonthlyCents, null);
  const odd = fresh({ targetCents: 100_001, targetDate: '2026-04-01' });
  const calculated = calculateGoal(odd, '2026-01-01');
  assert.equal(calculated.requiredMonthlyCents, 33_334);
  assert.equal(calculated.progressBasisPoints, 0);
  assert.equal(calculateGoal(fresh({ targetCents: 1_000_000_000_000, openingCents: 999_999_999_999 }),
    '2026-01-01').remainingCents, 1);
  assert.throws(() => fresh({ targetCents: 1.5 }), /integer number of kopecks/);
  assert.throws(() => fresh({ targetCents: Number.MAX_SAFE_INTEGER }), /integer number of kopecks/);
  assert.throws(() => fresh({ openingCents: -1 }), /integer number of kopecks/);
});

test('backdated operations are verified against earlier lifecycle states', () => {
  const first = add(fresh(), 'seed', '2026-02-01', 12_000_000);
  const completed = applyGoalEvent(first, { id: 'close', type: 'complete', on: '2026-02-02' });
  assert.throws(() => use(completed, 'backdated', '2026-02-01', 1), /only after reaching/);
  assert.throws(() => change(completed, 'late-change', '2026-02-03', { targetCents: 100_000 }), /Reopen/);
  const notCompleted = use(first, 'late-expense', '2026-02-02', 1_000_000);
  assert.equal(calculateGoal(notCompleted, '2026-02-02').status, 'active');
});

test('explicit initial allocation is not income, spending, or bank transfer', () => {
  const seeded = fresh({ openingCents: 3_000_000 });
  assert.equal(calculateGoal(seeded, '2026-01-01').savedCents, 3_000_000);
  assert.equal(calculateGoal(seeded, '2026-01-01').monthlyCents, 750_000);
  assert.equal(goalLedgerLinks([seeded]).length, 0);
  assert.equal(goalJournal(seeded)[0].ledgerMutationCents, 0);
});

test('last auto installment is capped to exact final kopeck (no silent over-allocation)', () => {
  const goal = fresh({ targetCents: 100_001, targetDate: '2026-04-01' });
  const proposal = goalForecastReservations(goal, '2026-01-01');
  assert.deepEqual(proposal.map((x) => x.plannedCents), [33_334, 33_334, 33_333]);
  assert.equal(proposal.reduce((sum, x) => sum + x.plannedCents, 0), 100_001);
  const fixed = fresh({ targetCents: 10_001, targetDate: '2026-04-01', monthlyCents: 5_000 });
  assert.deepEqual(goalForecastReservations(fixed, '2026-01-01').map((x) => x.plannedCents),
    [5_000, 5_000, 1]);
  assert.equal(goalForecastReservations(fixed, '2026-01-01')[2].cashFlowCents, 0);
});

test('future prepayment is factual only after its event date and never bank spending', () => {
  const goal = add(fresh(), 'early', '2026-01-20', 2_000_000, { forDueOn: '2026-03-01' });
  assert.equal(calculateGoal(goal, '2026-01-19').savedCents, 0);
  assert.equal(calculateGoal(goal, '2026-01-20').savedCents, 2_000_000);
  assert.equal(goalInstallments(goal, '2026-01-20')[1].actualCents, 2_000_000);
  assert.equal(goalLedgerLinks([goal]).length, 0);
  assert.equal(goalForecastReservations(goal, '2026-01-20')
    .reduce((sum, row) => sum + row.plannedCents, 0), 10_000_000);
  assert.throws(() => add(goal, 'invalid-due', '2026-01-21', 100, { forDueOn: '2026-02-30' }),
    /Invalid calendar/);
  assert.throws(() => add(goal, 'not-anchor', '2026-01-21', 100, { forDueOn: '2026-02-02' }),
    /not a monthly due/);
});

test('calendar horizon, invalid movement, invalid duplicate skip are safely rejected', () => {
  assert.equal(goalDueDates('2200-12-01', '2200-12-31').length, 0);
  assert.equal(calculateGoal(fresh({ on: '2200-12-01', targetDate: '2200-12-31',
    monthlyCents: 100_000 }), '2200-12-01').projectionHorizonLimited, true);
  assert.equal(goalDueDates('2026-01-01', '2126-01-01').length, 1_200);
  assert.throws(() => goalDueDates('2026-01-01', '2126-02-01'), /1200 months/);
  assert.throws(() => add(fresh(), 'negative', '2026-02-01', -5), /integer number/);
  assert.throws(() => add(fresh(), 'fraction', '2026-02-01', 0.25), /integer number/);
  assert.throws(() => add(fresh(), 'zero', '2026-02-01', 0), /integer number/);
  const skipped = applyGoalEvent(fresh(), {
    id: 'skip-first', type: 'skip', on: '2026-01-02', dueOn: '2026-03-01',
  });
  assert.throws(() => applyGoalEvent(skipped, {
    id: 'skip-duplicate', type: 'skip', on: '2026-01-03', dueOn: '2026-03-01',
  }), /already marked/);
  assert.throws(() => applyGoalEvent(skipped, {
    id: 'skip-invalid', type: 'skip', on: '2026-01-03', dueOn: '2026-03-02',
  }), /not a monthly due/);
});

test('old history cannot be corrupted by returned journal or edited input object', () => {
  const created = fresh();
  const changes = { targetCents: 20_000_000 };
  const changed = change(created, 'update', '2026-02-01', changes);
  changes.targetCents = 30_000_000;
  assert.equal(calculateGoal(changed, '2026-02-01').targetCents, 20_000_000);
  const journal = goalJournal(changed);
  journal[1].event.changes.targetCents = 40_000_000;
  assert.equal(calculateGoal(changed, '2026-02-01').targetCents, 20_000_000);
  assert.equal(calculateGoal(created, '2026-02-01').targetCents, 12_000_000);
  const retry = { type: 'update', changes: { targetCents: 20_000_000 }, on: '2026-02-01', id: 'update' };
  assert.equal(applyGoalEvent(changed, retry), changed); // property order cannot break idempotency
});


test('factual reached date is preserved until increased goal or withdrawal resets it', () => {
  const reached = add(fresh(), 'early', '2026-02-01', 12_000_000);
  assert.equal(calculateGoal(reached, '2026-05-01').reachedOn, '2026-02-01');
  assert.equal(calculateGoal(reached, '2026-05-01').projectedOnTime, true);
  const larger = change(reached, 'larger', '2026-03-01', { targetCents: 14_000_000 });
  assert.equal(calculateGoal(larger, '2026-03-01').reachedOn, null);
  const topped = add(larger, 'top-up', '2026-04-01', 2_000_000);
  assert.equal(calculateGoal(topped, '2026-05-01').reachedOn, '2026-04-01');
  const withdraw = use(topped, 'use-savings', '2026-05-01', 1_000_000);
  assert.equal(calculateGoal(withdraw, '2026-05-01').reachedOn, null);
  assert.equal(calculateGoal(fresh({ openingCents: 12_000_000 }), '2026-06-01').reachedOn,
    '2026-01-01');
});


test('unrecognized event fields cannot corrupt a JSON-serializable financial journal', () => {
  const goal = fresh();
  assert.throws(() => applyGoalEvent(goal, {
    id: 'unknown-field', type: 'contribution', on: '2026-02-01',
    amountCents: 100, funding: 'virtual', externalState: { secret: 'not allowed' },
  }), /Unexpected field/);
  assert.throws(() => applyGoalEvent(goal, {
    id: 'unknown-bigint', type: 'update', on: '2026-02-01',
    changes: { targetCents: 12_000_000, unsafe: 123n },
  }), /unknown goal update/i);
  assert.equal(JSON.parse(JSON.stringify(goal)).events.length, 1);
});


test('historical plan is not rewritten by a later change of monthly contribution', () => {
  const initial = fresh({ monthlyCents: 1_000_000 });
  const paid = add(initial, 'feb', '2026-02-01', 1_000_000);
  const revised = change(paid, 'raise-plan', '2026-03-01', { monthlyCents: 2_000_000 });
  const rows = goalInstallments(revised, '2026-03-02');
  assert.equal(rows[0].plannedCents, 1_000_000);
  assert.equal(rows[0].status, 'paid');
  assert.equal(rows[1].plannedCents, 1_000_000);
  assert.equal(rows[2].plannedCents, 2_000_000);
});

test('fully prepaid future installment is not reserved twice', () => {
  const goal = add(fresh(), 'prepaid-march', '2026-01-20', 2_000_000,
    { forDueOn: '2026-03-01' });
  const snapshot = calculateGoal(goal, '2026-01-21');
  assert.equal(snapshot.savedCents, 2_000_000);
  assert.equal(snapshot.requiredMonthlyCents, 909_091);
  assert.equal(snapshot.projectedCompletionDate, '2027-01-01');
  const rows = goalInstallments(goal, '2026-01-21');
  assert.equal(rows[1].status, 'paid');
  const reservations = goalForecastReservations(goal, '2026-01-21');
  assert.equal(reservations.some((row) => row.dueOn === '2026-03-01'), false);
  assert.equal(reservations.reduce((sum, row) => sum + row.plannedCents, 0), 10_000_000);
});

test('partially prepaid future installment receives only its missing amount', () => {
  const goal = add(fresh(), 'prepaid-march', '2026-01-20', 900_000,
    { forDueOn: '2026-03-01' });
  const snapshot = calculateGoal(goal, '2026-01-21');
  assert.equal(snapshot.requiredMonthlyCents, 1_000_000);
  assert.equal(snapshot.projectedCompletionDate, '2027-01-01');
  const rows = goalInstallments(goal, '2026-01-21');
  assert.equal(rows[1].status, 'partial');
  assert.equal(rows[1].actualCents, 900_000);
  const reservations = goalForecastReservations(goal, '2026-01-21');
  assert.equal(reservations.find((row) => row.dueOn === '2026-03-01').plannedCents, 100_000);
  assert.equal(reservations.reduce((sum, row) => sum + row.plannedCents, 0), 11_100_000);
});

test('auto-plan history survives later target changes', () => {
  const paid = add(fresh(), 'feb', '2026-02-01', 1_000_000);
  const revised = change(paid, 'larger-goal', '2026-03-01', { targetCents: 24_000_000 });
  const [february, march, april] = goalInstallments(revised, '2026-03-02');
  assert.equal(february.plannedCents, 1_000_000);
  assert.equal(february.status, 'paid');
  assert.equal(march.plannedCents, 1_000_000);
  assert.ok(april.plannedCents > march.plannedCents);
});

test('voiding an early allocated contribution restores future installment forecast', () => {
  const prepaid = add(fresh(), 'ahead', '2026-01-15', 2_000_000,
    { forDueOn: '2026-03-01' });
  const corrected = reverse(prepaid, 'correction', '2026-01-16', 'ahead');
  const snapshot = calculateGoal(corrected, '2026-01-17');
  assert.equal(snapshot.savedCents, 0);
  assert.equal(snapshot.monthlyCents, 1_000_000);
  assert.equal(goalInstallments(corrected, '2026-01-17')[1].status, 'upcoming');
  assert.equal(goalForecastReservations(corrected, '2026-01-17').length, 12);
  assert.equal(goalForecastReservations(corrected, '2026-01-17')
    .reduce((sum, row) => sum + row.plannedCents, 0), 12_000_000);
});
