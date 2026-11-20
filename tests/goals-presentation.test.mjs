import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGoal, applyGoalEvent, buildGoalsScreenModel,
} from '../src/domain/goals/index.ts';

function goal(id, title, targetDate = '2027-01-01', extra = {}) {
  return createGoal({
    id, eventId: id + '-created', on: '2026-01-01', title, category: 'emergency',
    targetCents: 12_000_000, targetDate, ...extra,
  });
}
function event(goalRecord, id, type, on, fields = {}) {
  return applyGoalEvent(goalRecord, { id, type, on, ...fields });
}

test('approved goals list: 120,000 RUB over 12 months is shown as 10,000/month, no expense', () => {
  const view = buildGoalsScreenModel([goal('g1', 'Подушка')], '2026-01-01');
  assert.equal(view.cards.length, 1);
  assert.equal(view.selected.card.title, 'Подушка');
  assert.equal(view.selected.card.monthlyCents, 1_000_000);
  assert.equal(view.selected.card.nextInstallmentOn, '2026-02-01');
  assert.equal(view.selected.card.projectedCompletionDate, '2027-01-01');
  assert.equal(view.cards[0].earmarkedNotCash, true);
  assert.equal(view.accountMutations, 0);
  assert.equal(view.earmarkedCents, 0);
  assert.equal(view.selected.installments.length, 12);
});

test('multiple goals sort consistently; archived not included in active count', () => {
  const archived = event(goal('ga', 'Архивная'), 'archive', 'archive', '2026-03-01');
  const active = goal('gb', 'Отпуск', '2026-06-01', { category: 'travel' });
  const completed = event(
    event(goal('gc', 'Готовая'), 'full', 'contribution', '2026-02-01',
      { amountCents: 12_000_000, funding: 'virtual' }),
    'complete', 'complete', '2026-02-02',
  );
  const view = buildGoalsScreenModel([archived, completed, active], '2026-04-01', 'gc');
  assert.deepEqual(view.cards.map((x) => x.id), ['gb', 'gc', 'ga']);
  assert.deepEqual([view.activeCount, view.completedCount, view.archivedCount], [1, 1, 1]);
  assert.equal(view.selected.card.id, 'gc');
  assert.equal(view.selected.card.deadline, 'reached');
  assert.equal(view.selected.card.nextInstallmentOn, null);
  assert.equal(view.earmarkedCents, 12_000_000);
});

test('screen selection recovers when a previously selected goal is absent', () => {
  const a = goal('a', 'A');
  const b = goal('b', 'B', '2026-06-01');
  assert.equal(buildGoalsScreenModel([a, b], '2026-02-01', 'deleted').selected.card.id, 'b');
  const empty = buildGoalsScreenModel([], '2026-02-01', 'deleted');
  assert.deepEqual([empty.cards, empty.selected, empty.earmarkedCents], [[], null, 0]);
});

test('as-of journal hides future events and their future cancellations', () => {
  const g = goal('g', 'План');
  const funded = event(g, 'fund', 'contribution', '2026-02-01',
    { amountCents: 3_000_000, funding: 'virtual' });
  const reversed = event(funded, 'undo', 'void', '2026-04-01',
    { eventId: 'fund', reason: 'Ошибка' });
  const march = buildGoalsScreenModel([reversed], '2026-03-01');
  assert.equal(march.earmarkedCents, 3_000_000);
  assert.equal(march.selected.history.length, 2);
  assert.equal(march.selected.history[0].reversed, false);
  const april = buildGoalsScreenModel([reversed], '2026-04-01');
  assert.equal(april.earmarkedCents, 0);
  assert.equal(april.selected.history.length, 3);
  assert.equal(april.selected.history.find((x) => x.eventId === 'fund').reversed, true);
  assert.ok(april.selected.history.every((x) => x.ledgerMutationCents === 0));
});

test('active goal with an inadequate fixed contribution is marked late', () => {
  const g = goal('g', 'Цель', '2026-05-01', { monthlyCents: 10_000 });
  const view = buildGoalsScreenModel([g], '2026-02-02');
  assert.equal(view.cards[0].deadline, 'late');
  assert.equal(view.cards[0].monthlyCents, 10_000);
  assert.equal(view.cards[0].nextInstallmentOn, '2026-03-01');
});

test('no duplicate goals or already posted transfer can enter one view', () => {
  const g = goal('g', 'A');
  assert.throws(() => buildGoalsScreenModel([g, g], '2026-02-01'), /Duplicate/);
  const fundedA = event(g, 'tx-a', 'contribution', '2026-02-01',
    { amountCents: 1000, funding: 'account-transfer', ledgerMovementId: 'posted-1' });
  const fundedB = event(goal('other', 'B'), 'tx-b', 'contribution', '2026-02-01',
    { amountCents: 1000, funding: 'account-transfer', ledgerMovementId: 'posted-1' });
  assert.throws(() => buildGoalsScreenModel([fundedA, fundedB], '2026-02-02'), /multiple goals/);
});

test('does not mutate source records; rejects non-kopeck or invalid effective date', () => {
  const g = goal('g', 'A');
  const serialized = JSON.stringify(g);
  buildGoalsScreenModel([g], '2026-02-01');
  assert.equal(JSON.stringify(g), serialized);
  assert.throws(() => buildGoalsScreenModel([g], '2026-02-30'));
  assert.throws(() => buildGoalsScreenModel(null, '2026-02-01'));
  assert.throws(() => buildGoalsScreenModel([], '2026-02-30'));
});

test('screen list rejects unbounded goal counts before processing', () => {
  const goals = Array.from({ length: 501 }, (_, i) => goal('g' + i, 'Goal ' + i));
  assert.throws(() => buildGoalsScreenModel(goals, '2026-01-01'), /excessive/);
});


test('next installment skips fully prepaid future periods without re-evaluating history', () => {
  const g = event(goal('g1','Подушка'), 'prepay', 'contribution', '2026-01-10', {
    amountCents: 1_000_000, funding: 'virtual', forDueOn: '2026-02-01',
  });
  const view = buildGoalsScreenModel([g], '2026-01-15');
  assert.equal(view.cards[0].nextInstallmentOn, '2026-03-01');
  assert.equal(view.selected.installments[0].status, 'paid');
});
