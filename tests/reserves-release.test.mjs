import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateReserve } from '../src/domain/reserves/index.ts';

const definition = Object.freeze({
  id: 'safe-release',
  title: 'Периодический платёж',
  openedOn: '2026-11-16',
  firstDueDate: '2026-12-16',
  periodMonths: 1,
  targetCents: 9000,
  openingReservedCents: 3000,
  contributionMode: 'auto',
  dueDay: 16,
});

test('releasing money changes the reserve only and can be voided immutably', () => {
  const release = { id: 'release-1', reserveId: definition.id, date: '2026-11-17',
    kind: 'release', amountCents: 1500 };
  const first = calculateReserve(definition, [release], '2026-11-20');
  assert.equal(first.reservedCents, 1500);
  assert.equal(first.fundingGapCents, 7500);
  assert.equal(first.totalPaidCents, 0);
  assert.equal(first.totalContributedCents, 0);
  const voidEvent = { id: 'release-void-1', reserveId: definition.id,
    date: '2026-11-18', kind: 'void', targetEventId: release.id };
  const restored = calculateReserve(definition, [release, voidEvent], '2026-11-20');
  assert.equal(restored.reservedCents, 3000);
  assert.equal(restored.totalPaidCents, 0);
  assert.equal(restored.fundingGapCents, 6000);
  assert.equal(restored.history.length, 2);
  assert.equal(restored.history[0].voided, true);
});

test('a release cannot spend unavailable saved cash or use malformed money', () => {
  for (const amount of [0, -1, 1.1, 1_000_000_000_001, true]) {
    assert.throws(() => calculateReserve(definition, [
      { id: 'bad', reserveId: definition.id, date: '2026-11-17',
        kind: 'release', amountCents: amount },
    ], '2026-11-20'));
  }
  assert.throws(() => calculateReserve(definition, [
    { id: 'overdrawn', reserveId: definition.id, date: '2026-11-17',
      kind: 'release', amountCents: 3001 },
  ], '2026-11-20'), /больше зарезервированных/);
});

test('release, repayment, and contribution remain separate accounting actions', () => {
  const events = [
    { id: 'add-1', reserveId: definition.id, date: '2026-11-17',
      kind: 'contribution', amountCents: 2000 },
    { id: 'free-1', reserveId: definition.id, date: '2026-11-18',
      kind: 'release', amountCents: 1000 },
    { id: 'pay-1', reserveId: definition.id, date: '2026-11-19',
      kind: 'payment', amountCents: 4000, reservedUsedCents: 2500 },
  ];
  const result = calculateReserve(definition, events, '2026-11-20');
  assert.equal(result.totalContributedCents, 2000);
  assert.equal(result.totalPaidCents, 4000);
  assert.equal(result.totalReservedUsedCents, 2500);
  assert.equal(result.reservedCents, 1500);
  assert.equal(result.remainingObligationCents, 5000);
  assert.equal(result.fundingGapCents, 3500);
});
