import test from 'node:test';
import assert from 'node:assert/strict';
import { persistContiguousDeltaCandidate } from '../src/security/contiguous-delta-candidate.js';

const scope = 'account:' + 'a'.repeat(32);
const epoch = 'c'.repeat(32);
const mutationId = '00000000-0000-4000-8000-0000000000a1';
const fingerprint = 'a'.repeat(64);
const base = {
  scope, epoch, generation: 3, expectedCursor: 5,
  revisions: [{ revision: 6, commands: [{ mutationId, fingerprint }] }],
  financeState: { scope, epoch, generation: 3, revision: 6, rows: [] },
};

test('rejects malformed or noncontiguous delta evidence before native IDB access', async () => {
  let opened = false;
  const db = { transaction() { opened = true; throw Error('must not open'); } };
  const signal = new AbortController().signal;
  for (const altered of [
    { scope: 'guest' }, { epoch: 'bad' }, { generation: 0 },
    { expectedCursor: -1 }, { expectedCursor: Number.MAX_SAFE_INTEGER },
    { revisions: [] }, { revisions: [{ revision: 7, commands: [] }] },
    { revisions: [{ revision: 6, commands: [{ mutationId, fingerprint: 'bad' }] }] },
    { revisions: [{ revision: 6, commands: [
      { mutationId, fingerprint }, { mutationId, fingerprint },
    ] }] },
    { financeState: { ...base.financeState, revision: 5 } },
    { financeState: { ...base.financeState, scope: 'account:' + 'b'.repeat(32) } },
  ]) {
    await assert.rejects(persistContiguousDeltaCandidate(db, { ...base, ...altered }, signal),
      TypeError);
  }
  await assert.rejects(persistContiguousDeltaCandidate(db, base), TypeError);
  assert.equal(opened, false);
});

test('logout signal prevents starting an atomic delta write', async () => {
  let opened = false;
  const db = { transaction() { opened = true; } };
  const controller = new AbortController();
  controller.abort();
  assert.equal(await persistContiguousDeltaCandidate(db, base, controller.signal),
    'RECOVERY_HOLD');
  assert.equal(opened, false);
});

test('multiple server events may belong to one revision but revision gaps are rejected', async () => {
  const db = { transaction() { throw Error('would reach IDB'); } };
  const signal = new AbortController().signal;
  await assert.rejects(persistContiguousDeltaCandidate(db, {
    ...base, revisions: [
      { revision: 6, commands: [] },
      { revision: 8, commands: [] },
    ], financeState: { ...base.financeState, revision: 7 },
  }, signal), TypeError);
});
