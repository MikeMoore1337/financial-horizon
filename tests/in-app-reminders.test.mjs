import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, getMonthEvents } from '../finance.js';
import { calculateReserve } from '../src/domain/reserves/index.ts';
import {
  DEFAULT_REMINDER_SETTINGS,
  buildInAppReminders,
  localCalendarDate,
} from '../src/domain/cashflow/in-app-reminders.ts';

const entry = (overrides = {}) => ({
  source: 'entry', id: 'internet', title: 'Интернет', kind: 'expense',
  date: '2027-01-01', plannedCents: 12000, paidCents: 0, ...overrides,
});
const options = (currentDate, payments = [entry()], extra = {}) => ({
  scopeKey: 'guest-state-v2', currentDate, settings: DEFAULT_REMINDER_SETTINGS,
  payments, ...extra,
});
const projected = (asOfDate, payments = [entry()], extra = {}) =>
  buildInAppReminders(options(asOfDate, payments, extra));

test('1, 3, 7-day triggers, due day and overdue at year boundary', () => {
  for (const [date, lead] of [
    ['2026-12-25', 7], ['2026-12-29', 3], ['2026-12-31', 1],
  ]) {
    const result = projected(date);
    assert.equal(result.alerts.length, 1);
    assert.equal(result.alerts[0].intervalDays, lead);
    assert.equal(result.alerts[0].trigger, 'advance');
    assert.equal(result.alerts[0].remainingCents, 12000);
  }
  assert.equal(projected('2026-12-30').alerts.length, 0);
  assert.equal(projected('2027-01-01').alerts[0].trigger, 'today');
  const late = projected('2027-01-02').alerts[0];
  assert.equal(late.trigger, 'overdue');
  assert.equal(late.intervalDays, null);
  assert.equal(late.id, projected('2027-01-03').alerts[0].id);
});

test('reminder intervals can be disabled individually or as a whole without hiding due items', () => {
  const disabled3 = projected('2026-12-29', [entry()], {
    settings: { enabled: true, daysBefore: [1, 7] },
  });
  assert.equal(disabled3.alerts.length, 0);
  assert.equal(disabled3.duePayments.length, 1);
  const disabled = projected('2027-01-01', [entry()], {
    settings: { enabled: false, daysBefore: [1, 3, 7] },
  });
  assert.equal(disabled.alerts.length, 0);
  assert.equal(disabled.duePayments[0].remainingCents, 12000);
  assert.equal(projected('2026-12-29', [entry()], {
    settings: { enabled: true, daysBefore: [] },
  }).alerts.length, 0);
  assert.equal(projected('2027-01-01', [entry()], {
    settings: { enabled: true, daysBefore: [] },
  }).alerts[0].trigger, 'today');
});

test('legacy financial ledger is the only source of paid amount: partial, multi-tranche, full and void', () => {
  const state = emptyState();
  state.entries.push({
    id: 'internet', title: 'Интернет', kind: 'expense', recurrence: 'monthly',
    category: 'Связь', amountCents: 10000, date: '2026-01-31',
  });
  state.settlements.push(
    { id: 'a', entryId: 'internet', occurrence: '2026-02', amountCents: 3000, date: '2026-02-01' },
    { id: 'b', entryId: 'internet', occurrence: '2026-02', amountCents: 4000, date: '2026-02-03' },
    { id: 'void', entryId: 'internet', occurrence: '2026-02', amountCents: 8000,
      date: '2026-02-04', voidedAt: '2026-02-04T15:00:00Z' },
  );
  const rows = () => getMonthEvents(state, '2026-02');
  const partial = projected('2026-02-25', rows());
  assert.equal(partial.alerts.length, 1);
  assert.equal(partial.alerts[0].partial, true);
  assert.equal(partial.alerts[0].remainingCents, 3000);
  assert.equal(partial.duePayments[0].dueDate, '2026-02-28');

  state.settlements.push({
    id: 'c', entryId: 'internet', occurrence: '2026-02', amountCents: 3000,
    date: '2026-02-25',
  });
  assert.equal(projected('2026-02-25', rows()).alerts.length, 0);
  assert.equal(projected('2026-02-25', rows()).duePayments.length, 0);
  state.settlements.at(-1).voidedAt = '2026-02-26T10:00:00Z';
  const restored = projected('2026-02-25', rows());
  assert.equal(restored.alerts.length, 1);
  assert.equal(restored.alerts[0].id, partial.alerts[0].id);
  assert.equal(restored.alerts[0].remainingCents, 3000);
  assert.equal(projected('2026-03-28', getMonthEvents(state, '2026-03')).alerts[0].remainingCents, 10000);
});

test('yearly 29 February and monthly 31st use the existing calendar-clamping contract', () => {
  const state = emptyState();
  state.entries.push({
    id: 'annual', kind: 'expense', recurrence: 'yearly', title: 'Взнос',
    date: '2024-02-29', amountCents: 100, category: 'Другое',
  });
  assert.equal(getMonthEvents(state, '2025-02')[0].date, '2025-02-28');
  assert.equal(getMonthEvents(state, '2028-02')[0].date, '2028-02-29');
  assert.equal(projected('2025-02-25', getMonthEvents(state, '2025-02')).alerts[0].intervalDays, 3);
  assert.equal(projected('2028-02-26', getMonthEvents(state, '2028-02')).alerts[0].intervalDays, 3);
  assert.equal(getMonthEvents(state, '2025-03').length, 0);
});

test('credit reminders depend on actual loan payments, never estimated bank balances', () => {
  const state = emptyState();
  state.loans.push({
    id: 'credit', title: 'Кредит', openingCents: 100000, paymentCents: 10000,
    apr: 0, termMonths: 10, dueDay: 15, asOfDate: '2026-11-01',
  });
  state.loanPayments.push({
    id: 'loan-part', loanId: 'credit', amountCents: 2000,
    date: '2026-11-09', strategy: 'term', createdAt: '2026-11-09T10:00:00Z',
  });
  const reminders = projected('2026-11-12', getMonthEvents(state, '2026-11'));
  assert.equal(reminders.alerts[0].source, 'loan');
  assert.equal(reminders.alerts[0].remainingCents, 8000);
  assert.equal(reminders.alerts[0].partial, true);
});

test('reserve warning uses #6 confirmed projection and never treats a future contribution as cash', () => {
  const definition = {
    id: 'annual-tax', title: 'Налог', openedOn: '2026-11-01',
    firstDueDate: '2026-11-20', dueDay: 20, periodMonths: 12,
    targetCents: 10000, openingReservedCents: 2000,
    contributionMode: 'fixed', fixedMonthlyCents: 1000,
  };
  const at = (events = []) => calculateReserve(definition, events, '2026-11-17');
  const project = (reserve) => projected('2026-11-17', [], { reserves: [reserve] });
  const first = project(at());
  assert.equal(first.alerts.length, 1);
  const gap = first.alerts[0];
  assert.equal(gap.kind, 'reserve-shortfall');
  assert.equal(gap.fundingGapCents, 8000);
  assert.equal(gap.reservedCents, 2000);
  assert.equal(gap.projectedShortfallCents, 7000);
  assert.equal(gap.remainingCents, 10000);

  const contribution = {
    id: 'fund', reserveId: definition.id, date: '2026-11-17',
    kind: 'contribution', amountCents: 6000,
  };
  const afterContribution = project(at([contribution]));
  assert.equal(afterContribution.alerts[0].fundingGapCents, 2000);
  assert.equal(afterContribution.alerts[0].projectedShortfallCents, 1000);
  assert.equal(afterContribution.alerts[0].id, gap.id);

  const payment = {
    id: 'pay', reserveId: definition.id, date: '2026-11-17',
    kind: 'payment', amountCents: 7000, reservedUsedCents: 7000,
  };
  const afterPayment = project(at([contribution, payment]));
  assert.equal(afterPayment.alerts[0].remainingCents, 3000);
  assert.equal(afterPayment.alerts[0].reservedCents, 1000);
  assert.equal(afterPayment.alerts[0].fundingGapCents, 2000);

  const finalPayment = {
    id: 'final', reserveId: definition.id, date: '2026-11-17',
    kind: 'payment', amountCents: 3000, reservedUsedCents: 1000,
  };
  assert.equal(project(at([contribution, payment, finalPayment])).alerts.length, 0);
  const voidFinal = {
    id: 'undo', reserveId: definition.id, date: '2026-11-17',
    kind: 'void', targetEventId: 'final',
  };
  assert.equal(project(at([contribution, payment, finalPayment, voidFinal])).alerts[0].fundingGapCents, 2000);
});

test('next reserve cycle has a distinct identity and cannot inherit previous alerts', () => {
  const def = {
    id: 'every-two', title: 'Платёж за услуги', openedOn: '2026-11-01',
    firstDueDate: '2026-11-20', periodMonths: 2, dueDay: 20,
    targetCents: 10000, openingReservedCents: 0, contributionMode: 'auto',
  };
  const pay = { id: 'pay1', reserveId: def.id, date: '2026-11-20',
    kind: 'payment', amountCents: 10000, reservedUsedCents: 0 };
  const close = { id: 'close1', reserveId: def.id, date: '2026-11-20', kind: 'cycle_close' };
  const before = calculateReserve(def, [], '2026-11-17');
  const next = calculateReserve(def, [pay, close], '2027-01-17');
  assert.equal(next.dueDate, '2027-01-20');
  assert.equal(next.cycleNumber, 2);
  const beforeId = projected('2026-11-17', [], { reserves: [before] }).alerts[0].id;
  const nextId = projected('2027-01-17', [], { reserves: [next] }).alerts[0].id;
  assert.notEqual(beforeId, nextId);
});

test('IANA calendar days distinguish timezones and DST, independent of UTC date', () => {
  const instant = new Date('2026-11-20T02:30:00Z');
  assert.equal(localCalendarDate(instant, 'America/Los_Angeles'), '2026-11-19');
  assert.equal(localCalendarDate(instant, 'Europe/Helsinki'), '2026-11-20');
  assert.equal(localCalendarDate(new Date('2026-03-29T00:30:00Z'), 'Europe/Helsinki'), '2026-03-29');
  assert.equal(localCalendarDate(new Date('2026-12-31T12:00:00Z'), 'Pacific/Kiritimati'), '2027-01-01');
  assert.throws(() => localCalendarDate(new Date('invalid')));
  assert.throws(() => localCalendarDate(instant, 'Mars/Olympus_Mons'), RangeError);
});

test('read-only projection is deterministic in two tabs and scoped by the verified actor', () => {
  const data = [entry()];
  const first = projected('2026-12-29', data);
  const second = projected('2026-12-29', structuredClone(data));
  assert.deepEqual(first, second);
  const other = projected('2026-12-29', data, { scopeKey: 'other-user' });
  assert.notEqual(first.alerts[0].id, other.alerts[0].id);
  assert.deepEqual(data, [entry()]);
  assert.equal(projected('2026-12-29', []).alerts.length, 0);
});

test('duplicate snapshots collapse deterministically but conflicting duplicates fail closed', () => {
  const duplicate = [entry(), entry()];
  assert.equal(projected('2026-12-29', duplicate).alerts.length, 1);
  assert.equal(projected('2026-12-29', duplicate).duePayments.length, 1);
  assert.throws(() => projected('2026-12-29',
    [entry(), entry({ paidCents: 1000 })]), /Противоречивые/);
  assert.equal(projected('2026-12-29',
    [entry({ kind: 'income' })]).alerts.length, 0);
  assert.equal(projected('2026-12-29', [entry({ paidCents: 12000 })]).alerts.length, 0);
  assert.equal(projected('2026-12-29', [entry({ paidCents: 15000 })]).alerts.length, 0);
});

test('old advance events are not replayed after an absence; current alerts have a bounded count', () => {
  const old = entry({ id: 'first', date: '2026-11-01' });
  const current = entry({ id: 'second', date: '2027-01-01' });
  const result = projected('2026-12-29', [old, current], { maxAlerts: 1 });
  assert.equal(result.alerts.length, 1);
  assert.equal(result.totalAlerts, 2);
  assert.equal(result.hiddenAlerts, 1);
  assert.equal(result.alerts[0].recordId, 'first'); // overdue remains, not a replayed advance
  assert.equal(result.alerts[0].trigger, 'overdue');
});

test('rejects corrupt dates, amounts, settings and reserve snapshots without side effects', () => {
  assert.throws(() => projected('2026-02-30'), /Invalid ISO calendar/);
  assert.throws(() => projected('2026-12-29', [entry({ date: '2027-02-29' })]), /Invalid ISO calendar/);
  assert.throws(() => projected('2026-12-29', [entry({ plannedCents: NaN })]), /сумма/);
  assert.throws(() => projected('2026-12-29', [entry({ paidCents: -1 })]), /сумма/);
  assert.throws(() => projected('2026-12-29', [entry()], {
    settings: { enabled: true, daysBefore: [2] },
  }), /интервалы/);
  assert.throws(() => projected('2026-12-29', [entry()], { scopeKey: '' }), /Область/);
  const invalidReserve = {
    id: 'broken', title: 'Налог', dueDate: '2027-01-01', cycleNumber: 1,
    targetCents: 2000, remainingObligationCents: 2000, reservedCents: 1000,
    fundingGapCents: 0, projectedShortfallCents: 0, cyclePaid: false,
  };
  assert.throws(() => projected('2026-12-29', [], { reserves: [invalidReserve] }), /Противоречивое/);
});
