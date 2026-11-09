import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileVerifiedReplay } from '../src/security/offline-ack-replay-candidate.js';

const valid = {
  scope: 'account:' + 'a'.repeat(32),
  generation: 4,
  mutationId: '00000000-0000-4000-8000-0000000000a1',
  fingerprint: 'a'.repeat(64),
  revision: 6,
};

test('offline replay rejects invalid account, command, revision and fingerprint before opening IndexedDB', async () => {
  let touched = false;
  const db = { transaction() { touched = true; throw Error('must not open'); } };
  for (const patch of [
    { scope: 'guest' }, { scope: 'account:' + 'b'.repeat(31) },
    { generation: -1 }, { generation: 1.1 }, { revision: -1 },
    { revision: Number.MAX_SAFE_INTEGER + 1 }, { mutationId: 'bad' },
    { fingerprint: 'not-a-digest' },
  ]) {
    await assert.rejects(reconcileVerifiedReplay(db, { ...valid, ...patch }), TypeError);
  }
  assert.equal(touched, false);
});

test('a synchronous logout abort prevents opening an IndexedDB transaction', async () => {
  let touched = false;
  const db = { transaction() { touched = true; } };
  const controller = new AbortController();
  controller.abort();
  assert.equal(await reconcileVerifiedReplay(db, valid, controller.signal), 'RECOVERY_HOLD');
  assert.equal(touched, false);
});
