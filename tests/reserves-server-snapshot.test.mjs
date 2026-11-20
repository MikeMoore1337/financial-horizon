import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeServerReserve, projectServerReserve } from '../src/domain/reserves/server-snapshot.ts';

const RES = '11111111-1111-4111-8111-111111111111';
const ACC = '22222222-2222-4222-8222-222222222222';
const OBL = '33333333-3333-4333-8333-333333333333';
const EV1 = '44444444-4444-4444-8444-444444444444';
const EV2 = '55555555-5555-4555-8555-555555555555';
const EV3 = '66666666-6666-4666-8666-666666666666';
const EV4 = '77777777-7777-4777-8777-777777777777';

function entity(events = [], changes = {}) {
  return {
    id: RES, entity_revision: events.length + 1, kind: 'reserve',
    data: {
      title: 'Синтетическая страховка',
      account_id: ACC, obligation_id: OBL,
      opened_on: '2026-11-16', first_due_on: '2027-11-16',
      target_on: '2027-11-16', period_months: 12, due_day: 16,
      contribution_mode: 'auto', fixed_monthly_minor: null,
      opening_reserved_minor: 3000, opening_target_minor: 9000,
      target_minor: 9000, cycle_number: 1, allocated_minor: 3000,
      allocations_by_account: [{ account_id: ACC, allocated_minor: 3000 }],
      event_log: events, ...changes,
    },
  };
}

function event(id, revision, kind, occurred_on, more = {}) {
  return { id, reserve_id: RES, revision, cycle_number: 1,
    kind, occurred_on, amount_minor: null, target_minor: null,
    reserved_used_minor: null, slot_on: null, target_event_id: null,
    allocation_id: null, transaction_id: null, note: null, ...more };
}

test('server snapshot converts into one pure, read-only yearly reserve projection', () => {
  const data = entity();
  const parsed = decodeServerReserve(data);
  assert.equal(parsed.definition.targetCents, 9000);
  assert.equal(parsed.events.length, 0);
  const progress = projectServerReserve(data, '2026-11-16');
  assert.equal(progress.reservedCents, 3000);
  assert.equal(progress.fundingGapCents, 6000);
  assert.equal(progress.dueDate, '2027-11-16');
});

test('contribution, release, target change, and payment cannot double-book cash', () => {
  const events = [
    event(EV1, 3, 'contribution', '2026-11-17', { amount_minor: 2000 }),
    event(EV2, 4, 'release', '2026-11-18', { amount_minor: 1500 }),
    event(EV3, 5, 'target_change', '2026-12-01', { target_minor: 12000 }),
    event(EV4, 6, 'payment', '2027-01-12',
      { amount_minor: 4000, reserved_used_minor: 2500 }),
  ];
  const data = entity(events, {
    target_minor: 12000, allocated_minor: 1000,
    allocations_by_account: [{ account_id: ACC, allocated_minor: 1000 }],
  });
  const projection = projectServerReserve(data, '2027-01-15');
  assert.equal(projection.targetCents, 12000);
  assert.equal(projection.totalContributedCents, 2000);
  assert.equal(projection.totalPaidCents, 4000);
  assert.equal(projection.totalReservedUsedCents, 2500);
  assert.equal(projection.reservedCents, 1000);
  assert.equal(projection.fundingGapCents, 7000);
  const past = projectServerReserve(data, '2026-11-16');
  assert.equal(past.reservedCents, 3000);
  assert.equal(past.totalPaidCents, 0);
});

test('cycle closure and rollover keep the anchor from the original due date', () => {
  const events = [
    event(EV1, 3, 'payment', '2027-11-16',
      { amount_minor: 9000, reserved_used_minor: 6000 }),
    event(EV2, 4, 'cycle_close', '2027-11-16'),
  ];
  const data = entity(events, {
    opening_reserved_minor: 6000, allocated_minor: 0,
    allocations_by_account: [], cycle_number: 2,
    target_on: '2028-11-16',
  });
  const result = projectServerReserve(data, '2027-12-01');
  assert.equal(result.cycleNumber, 2);
  assert.equal(result.dueDate, '2028-11-16');
  assert.equal(result.reservedCents, 0);
  assert.equal(result.totalPaidCents, 9000);
});

test('read-only bridge rejects incomplete, mismatched or forged server-state payloads', () => {
  assert.equal(decodeServerReserve(entity([], { period_months: null })), null);
  const cases = [
    entity([], { allocated_minor: 3100 }),
    entity([], { opening_target_minor: 0 }),
    entity([], { target_on: '2027-12-16' }),
    entity([], { fixed_monthly_minor: 1000 }),
    entity([], { allocations_by_account: [{ account_id: OBL, allocated_minor: 3000 }] }),
    entity([], { event_log: [event(EV1, 3, 'contribution', '2026-11-17',
      { amount_minor: 1.4 })] }),
    entity([], { event_log: [event(EV1, 3, 'unknown', '2026-11-17')] }),
    entity([], { event_log: [event(EV1, 3, 'skip', '2026-02-30',
      { slot_on: '2026-02-30' })] }),
    entity([], { event_log: [
      event(EV1, 3, 'contribution', '2026-11-17', { amount_minor: 1000 }),
      event(EV2, 3, 'release', '2026-11-18', { amount_minor: 500 }),
    ] }),
  ];
  for (const invalid of cases) {
    assert.throws(() => projectServerReserve(invalid, '2027-12-01'));
  }
});
