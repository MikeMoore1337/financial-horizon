import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGoal, applyGoalEvent, encodeGoalsSnapshot, decodeGoalsSnapshot,
  decodeOptionalGoalsSnapshot, GOALS_SNAPSHOT_SCHEMA, GOALS_SNAPSHOT_VERSION,
} from '../src/domain/goals/index.ts';

const SCOPE = 'guest:synthetic-local';
const fixture = (id = 'g') => createGoal({
  id, eventId: 'created-' + id, on: '2026-01-01', title: 'Резервный фонд',
  category: 'emergency', targetCents: 12_000_000, targetDate: '2027-01-01',
});
const make = (goals = [fixture()], props = {}) => ({
  schema: GOALS_SNAPSHOT_SCHEMA, version: GOALS_SNAPSHOT_VERSION,
  scopeKey: SCOPE, revision: 0, goals, ...props,
});

function change(goal, id, amount) {
  return applyGoalEvent(goal, {
    id, on: '2026-02-01', type: 'contribution', amountCents: amount,
    funding: 'virtual',
  });
}

test('canonical snapshot round-trip preserves cents, journal and revision', () => {
  const input = make([change(fixture(), 'f1', 1_234_567)], { revision: 42 });
  const before = JSON.stringify(input);
  const encoded = encodeGoalsSnapshot(input);
  const decoded = decodeGoalsSnapshot(encoded, SCOPE);
  assert.deepEqual(decoded, input);
  assert.equal(decoded.goals[0].events[1].amountCents, 1_234_567);
  decoded.goals[0].events[1].amountCents = 2;
  assert.equal(JSON.stringify(input), before);
});

test('guest and authenticated namespaces cannot be crossed by an imported snapshot', () => {
  const data = encodeGoalsSnapshot(make());
  assert.throws(() => decodeGoalsSnapshot(data, 'profile:other'), /another scope/);
  assert.throws(() => encodeGoalsSnapshot(make([], { scopeKey: 'guest\0illegal' })), /opaque/);
});

test('old backup without a goals field is non-destructive absence, not an empty overwrite', () => {
  assert.equal(decodeOptionalGoalsSnapshot(undefined, SCOPE), null);
  assert.throws(() => decodeOptionalGoalsSnapshot(null, SCOPE));
});

test('invalid schema, unknown fields and unsupported version fail closed', () => {
  for (const value of [
    make([], { version: 2 }), make([], { schema: 'some-other-record' }),
    { ...make(), leakedData: true }, make([], { revision: -1 }),
    make([], { revision: Number.MAX_SAFE_INTEGER + 1 }),
  ]) {
    assert.throws(() => decodeGoalsSnapshot(JSON.stringify(value), SCOPE));
  }
  assert.throws(() => decodeGoalsSnapshot('{invalid', SCOPE), /Invalid goals JSON/);
});

test('duplicate goal IDs and reused ledger facts are rejected across goals', () => {
  const repeated = [fixture('g'), fixture('g')];
  assert.throws(() => encodeGoalsSnapshot(make(repeated)), /Duplicate/);
  const a = applyGoalEvent(fixture('g1'), {
    id:'fund-a',type:'contribution',on:'2026-02-01',amountCents:1000,
    funding:'account-transfer',ledgerMovementId:'posted-synthetic',
  });
  const b = applyGoalEvent(fixture('g2'), {
    id:'fund-b',type:'contribution',on:'2026-02-01',amountCents:1000,
    funding:'account-transfer',ledgerMovementId:'posted-synthetic',
  });
  assert.throws(() => encodeGoalsSnapshot(make([a,b])), /multiple goals/);
});

test('tampered fractional or negative kopecks cannot be restored', () => {
  for (const invalid of [-1, 1.2, Number.MAX_SAFE_INTEGER]) {
    const envelope = make([fixture()]);
    envelope.goals[0].events[0].openingCents = invalid;
    assert.throws(() => decodeGoalsSnapshot(JSON.stringify(envelope), SCOPE));
  }
});

test('oversized payload, unknown record fields and excessive goal count are rejected', () => {
  assert.throws(() => decodeGoalsSnapshot('x'.repeat(4*1024*1024+1), SCOPE));
  assert.throws(() => encodeGoalsSnapshot(make([{
    ...fixture(), extra: 1,
  }])), /field/);
  const records = Array.from({ length: 501 }, (_, i) => fixture('g'+i));
  assert.throws(() => encodeGoalsSnapshot(make(records)), /size/);
});
