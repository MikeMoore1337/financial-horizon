import test from 'node:test';
import assert from 'node:assert/strict';
import { checkV1AckDeltaShape as guard } from '../src/security/finance-v1-ack-delta-shape-guard.js';

// All fixtures are synthetic, in-memory only. The guard is not imported by the PWA.
const mutationId = '00000000-0000-4000-8000-0000000000a1';
const entityId = '00000000-0000-4000-8000-0000000000b1';
const event = (revision, value) => ({
  revision, ordinal: 0, kind: 'upsert', entity_id: entityId,
  entity_revision: 1, payload: { details: { values: [value] } },
});
const fixture = () => ({
  startCursor: 3, mutationId,
  pages: [
    { schema_version: 1, from_revision: 3, to_revision: 5,
      next_since_revision: 4, has_more: true, changes: [event(4, 1)] },
    { schema_version: 1, from_revision: 4, to_revision: 5,
      next_since_revision: 5, has_more: false, changes: [event(5, 2)] },
  ],
  ack: { schema_version: 1, client_mutation_id: mutationId, revision: 4,
    replayed: true, changes: [event(4, 1)] },
});

test('ordinary JSON ACK matches an intact two-page delta', () => {
  assert.equal(guard(JSON.stringify(fixture())), 'MATCHED_STRUCTURALLY');
});

test('P2: altered payload cannot override Array.every through a forged prototype', () => {
  const input = fixture();
  const values = input.ack.changes[0].payload.details.values;
  values[0] = 999;
  Object.setPrototypeOf(values, { every: () => true });
  assert.equal(guard(input), 'RECOVERY_HOLD');
});

test('P2: getters on ACK/page/event envelopes fail closed, not throw', () => {
  for (const mutate of [
    x => Object.defineProperty(x.ack, 'revision', {
      enumerable: true, get() { throw new Error('untrusted getter'); },
    }),
    x => Object.defineProperty(x.pages[0], 'has_more', {
      enumerable: true, get() { throw new Error('untrusted getter'); },
    }),
    x => Object.defineProperty(x.pages[0].changes[0], 'revision', {
      enumerable: true, get() { throw new Error('untrusted getter'); },
    }),
  ]) {
    const input = fixture();
    mutate(input);
    assert.equal(guard(input), 'RECOVERY_HOLD');
  }
});

test('P2: shadowed iterator, holes and inherited events are rejected', () => {
  const input = fixture();
  Object.defineProperty(input.pages[0].changes, Symbol.iterator, {
    value: function* () { yield event(4, 1); },
  });
  assert.equal(guard(input), 'RECOVERY_HOLD');
  const sparse = fixture();
  sparse.ack.changes = new Array(1);
  assert.equal(guard(sparse), 'RECOVERY_HOLD');
  const inherited = fixture();
  inherited.ack.changes = Object.assign(Object.create([]), { 0: event(4, 1), length: 1 });
  assert.equal(guard(inherited), 'RECOVERY_HOLD');
});

test('P2: shared-reference DAG and cycle cannot cause exponential traversal', () => {
  const branching = fixture();
  let nested = { amount_minor: 1 };
  for (let depth = 0; depth < 12; depth++) {
    const parent = {};
    for (let child = 0; child < 8; child++) parent['c' + child] = nested;
    nested = parent;
  }
  branching.pages[1].changes[0].payload = nested;
  assert.equal(guard(branching), 'RECOVERY_HOLD');
  const cyclic = fixture();
  cyclic.pages[1].changes[0].payload.circular = cyclic.pages[1].changes[0].payload;
  assert.equal(guard(cyclic), 'RECOVERY_HOLD');
});

test('valid events in unacknowledged pages must still be ordinary JSON', () => {
  const input = fixture();
  input.pages[1].changes[0].payload = { attack: Number.POSITIVE_INFINITY };
  assert.equal(guard(input), 'RECOVERY_HOLD');
});

test('P2 Proxy: caller object, nested Proxy and mutation traps are never touched', () => {
  let traps = 0;
  const attack = new Proxy({ amount_minor: 999 }, {
    get() { traps++; return 100; },
    getPrototypeOf() { traps++; return Object.prototype; },
    ownKeys() { traps++; return ['amount_minor']; },
    getOwnPropertyDescriptor() { traps++; return { value: 100, enumerable: true, configurable: true }; },
  });
  const input = fixture();
  input.ack.changes[0].payload = attack;
  assert.equal(guard(input), 'RECOVERY_HOLD');
  assert.equal(traps, 0);
  const proxiedEnvelope = new Proxy(fixture(), {
    get() { traps++; throw new Error('must not read input'); },
    getPrototypeOf() { traps++; throw new Error('must not inspect input'); },
  });
  assert.equal(guard(proxiedEnvelope), 'RECOVERY_HOLD');
  assert.equal(traps, 0);
  const differing = fixture();
  differing.ack.changes[0].payload.details.values[0] = 999;
  assert.equal(guard(JSON.stringify(differing)), 'RECOVERY_HOLD');
});
