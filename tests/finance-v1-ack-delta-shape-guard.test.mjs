import test from 'node:test';
import assert from 'node:assert/strict';
import { checkV1AckDeltaShape } from '../src/security/finance-v1-ack-delta-shape-guard.js';

const mutationId = '00000000-0000-4000-8000-0000000000a1';
const entityId = '00000000-0000-4000-8000-0000000000b1';
const event = (revision, ordinal, payload = { entity: { data: { amount_minor: 42 } } }) => ({
  revision, ordinal, kind: 'upsert', entity_id: entityId,
  entity_revision: 2, payload,
});
const e60 = event(6, 0);
const e61 = event(6, 1, { entity: { data: { amount_minor: 52 } } });
const e70 = event(7, 0);
const e80 = event(8, 0);
const base = () => ({
  startCursor: 5, mutationId,
  pages: [
    { schema_version: 1, from_revision: 5, to_revision: 8,
      next_since_revision: 6, has_more: true, changes: [e60, e61] },
    { schema_version: 1, from_revision: 6, to_revision: 8,
      next_since_revision: 8, has_more: false, changes: [e70, e80] },
  ],
  ack: { schema_version: 1, client_mutation_id: mutationId,
    revision: 6, replayed: true, changes: [structuredClone(e60), structuredClone(e61)] },
});
const clone = value => structuredClone(value);
const check = value => checkV1AckDeltaShape(value);

test('lost HTTP reply: exact replay ACK matches complete paged revision including two ordinals', () => {
  assert.equal(check(base()), 'MATCHED_STRUCTURALLY');
  const value = base();
  value.ack.changes[0].payload = { entity: { data: { amount_minor: 42 } } };
  assert.equal(check(value), 'MATCHED_STRUCTURALLY'); // key order is not evidence
});

test('fail closed on partial pages, false terminal cursor and pinned-head drift', () => {
  const alters = [
    b => b.pages.pop(),
    b => { b.pages[0].next_since_revision = 8; },
    b => { b.pages[0].has_more = false; },
    b => { b.pages[1].to_revision = 9; },
    b => { b.pages[1].from_revision = 7; },
    b => { b.pages[1].changes = [e80]; },
    b => { b.pages[1].next_since_revision = 9; },
    b => { b.pages[1].changes = []; },
    b => { b.pages[0].to_revision = 6; },
    b => { b.pages[0].changes = []; },
  ];
  for (const mutate of alters) {
    const b = clone(base()); mutate(b);
    assert.equal(check(b), 'RECOVERY_HOLD');
  }
});

test('fail closed on missing, duplicate, reordered or altered ordinal events', () => {
  const alters = [
    b => { b.pages[0].changes.unshift(event(5, 0)); }, // stale since_revision event
    b => { b.pages[0].changes[1].ordinal = 2; },
    b => { b.pages[0].changes[1].revision = 7; },
    b => { b.pages[0].changes[0].entity_revision = 0; },
    b => { b.pages[0].changes[0].payload.entity.data.amount_minor = 41; },
    b => { b.ack.changes.pop(); },
    b => { b.ack.changes[0].kind = 'tombstone'; },
    b => { b.ack.changes[0].payload.entity.data.amount_minor = 100; },
    b => { b.ack.changes.reverse(); },
    b => { b.pages[0].changes[0].extra = true; },
    b => { b.ack.changes[1].entity_id = 'not-a-uuid'; },
  ];
  for (const mutate of alters) {
    const b = clone(base()); mutate(b);
    assert.equal(check(b), 'RECOVERY_HOLD');
  }
});

test('rejects stale/rebound ACK, untrusted schema and non-JSON payload', () => {
  const alters = [
    b => { b.ack.client_mutation_id = '00000000-0000-4000-8000-0000000000ff'; },
    b => { b.ack.revision = 5; },
    b => { b.ack.revision = 7; },
    b => { b.ack.replayed = 'true'; },
    b => { b.pages[0].schema_version = 2; },
    b => { b.ack.schema_version = 2; },
    b => { b.ack.extra = 1; },
    b => { b.pages[0].changes[0].payload.entity.data.amount_minor = Infinity; },
    b => { b.startCursor = Number.MAX_SAFE_INTEGER; },
  ];
  for (const mutate of alters) {
    const b = clone(base()); mutate(b);
    assert.equal(check(b), 'RECOVERY_HOLD');
  }
  assert.equal(check({ ...base(), mutationId: 'guest' }), 'RECOVERY_HOLD');
  assert.equal(check(), 'RECOVERY_HOLD');
  assert.equal(check(null), 'RECOVERY_HOLD');
  assert.equal(check({ ...base(), mutationId: { toString: () => mutationId } }),
    'RECOVERY_HOLD');
  const malformed = clone(base());
  const nonJson = () => 'not-json';
  malformed.pages[0].changes[0].payload = { injected: nonJson };
  malformed.ack.changes[0].payload = { injected: nonJson };
  assert.equal(check(malformed), 'RECOVERY_HOLD');
});

test('a structural match never creates an applied proof or modifies an outbox', () => {
  const b = base();
  const original = clone(b);
  assert.equal(check(b), 'MATCHED_STRUCTURALLY');
  assert.deepEqual(b, original);
});
